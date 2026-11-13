/**
 * 비회원 결제 링크(/pay/<토큰>) — 발급·확인 DB 연결부. DB 는 인자로 받는다(테스트에서 가짜 DB 로 실행).
 * prisma 를 쓰는 바깥 함수는 guestPayLinkService.ts 에 있다.
 *
 * ■ 발급(issueGuestPayLink)
 *   - 미납(결제 가능) 청구서에만 발급한다. 납부 완료·취소·환불이면 null.
 *   - 토큰 원문은 돌려주기만 하고 DB 에는 해시만 남긴다 → 같은 링크를 «다시 꺼내 줄» 수 없어 부를 때마다 새로 만든다.
 *     이전 링크는 폐기하지 않는다 — 이미 보낸 알림톡·문자의 링크가 갑자기 죽지 않게(모두 같은 청구서 한 장만 연다).
 *
 * ■ 확인(resolveGuestPayToken)
 *   - 모양이 틀린 토큰은 DB 를 부르지 않는다. 없음·만료·폐기·취소·환불은 모두 같은 INVALID(존재 여부를 알리지 않는다).
 *   - 만료 비교는 SQL 의 NOW() 로 한다(서버 시계를 믿지 않는다).
 */
import { todayKst } from "@/lib/datetime/kst";
import {
    guestPayLinkExpiresAtMs,
    guestPayLinkLastYmd,
    guestPayPath,
    judgeGuestPayLink,
    type GuestPayLinkSource,
    type GuestPayLinkState,
} from "@/lib/payments/guestPayLinkRules";
import { createGuestPayToken, guestTokenHashOrNull } from "@/lib/payments/guestPayToken";

/** raw SQL 두 개만 쓰는 최소 DB 모양(prisma 또는 트랜잭션 클라이언트) */
export type GuestPayDb = {
    $queryRawUnsafe<T = unknown>(query: string, ...values: any[]): Promise<T>;
    $executeRawUnsafe(query: string, ...values: any[]): Promise<number>;
};

export type IssuedGuestPayLink = {
    token: string;
    /** BILLING_LINK_BASE 뒤에 붙는 상대 경로(pay/<토큰>) */
    path: string;
    /** 마지막 유효일(한국 날짜, 이날 하루 끝까지) */
    lastYmd: string;
};

type InvoiceStateRow = { invoiceStatus: string | null; paymentStatus: string | null; dueYmd: string | null };

/** 청구서 한 장에 새 링크를 발급한다. 결제할 수 없는 청구서(없음·납부·취소·환불)면 null */
export async function issueGuestPayLink(db: GuestPayDb, input: {
    invoiceId: string;
    source: GuestPayLinkSource;
    createdByUserId?: string | null;
    nowMs?: number;
}): Promise<IssuedGuestPayLink | null> {
    const invoiceId = String(input.invoiceId ?? "").trim();
    if (!invoiceId) return null;
    const rows = await db.$queryRawUnsafe<InvoiceStateRow[]>(
        `SELECT i.status AS "invoiceStatus", p.status AS "paymentStatus",
                -- dueDate(청구서)는 timestamptz 라 AT TIME ZONE 을 «한 번»만 건다(한국 달력 날짜)
                TO_CHAR(i."dueDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "dueYmd"
           FROM "PaymentInvoice" i
           JOIN "Payment" p ON p.id = i."paymentId"
          WHERE i.id = $1
            -- 학부모 미연결 청구서는 발급하지 않는다(받을 사람·결제자 기준이 없다 — 검수 권장 1)
            AND i."parentId" IS NOT NULL
          LIMIT 1`,
        invoiceId,
    );
    const row = rows[0];
    if (!row) return null;
    // 결제할 수 있는 청구서에만 — 납부·취소·환불된 청구서의 링크는 만들 이유가 없다
    if (judgeGuestPayLink({ revoked: false, expired: false, ...row }) !== "PAYABLE") return null;

    const nowMs = input.nowMs ?? Date.now();
    const issueYmd = todayKst(nowMs);
    const lastYmd = guestPayLinkLastYmd(row.dueYmd, issueYmd);
    const expiresAt = new Date(guestPayLinkExpiresAtMs(row.dueYmd, issueYmd));
    const { token, hash } = createGuestPayToken();
    await db.$executeRawUnsafe(
        `INSERT INTO "PaymentInvoiceAccessToken" ("id", "invoiceId", "tokenHash", "expiresAt", "source", "createdByUserId", "createdAt")
         VALUES (gen_random_uuid()::text, $1, $2, $3::timestamptz, $4, $5, NOW())`,
        invoiceId,
        hash,
        expiresAt.toISOString(),
        input.source,
        input.createdByUserId ?? null,
    );
    return { token, path: guestPayPath(token), lastYmd };
}

export type ResolvedGuestPayToken =
    | { state: "INVALID" }
    | { state: Exclude<GuestPayLinkState, "INVALID">; invoiceId: string; tokenId: string };

type TokenRow = {
    tokenId: string;
    invoiceId: string;
    revoked: boolean;
    expired: boolean;
    invoiceStatus: string | null;
    paymentStatus: string | null;
};

/**
 * 토큰 → 청구서. 통과(PAID·PAYABLE)하면 사용 기록(lastUsedAt·useCount)을 남긴다(실패해도 화면은 열린다).
 * @param touch false 면 사용 기록을 남기지 않는다(결제 승인 재시도처럼 같은 요청이 여러 번 오는 경우)
 */
export async function resolveGuestPayToken(db: GuestPayDb, token: unknown, opts: { touch?: boolean } = {}): Promise<ResolvedGuestPayToken> {
    const hash = guestTokenHashOrNull(token);
    if (!hash) return { state: "INVALID" };
    const rows = await db.$queryRawUnsafe<TokenRow[]>(
        `SELECT t.id AS "tokenId", t."invoiceId",
                (t."revokedAt" IS NOT NULL) AS revoked,
                (t."expiresAt" <= NOW()) AS expired,
                i.status AS "invoiceStatus", p.status AS "paymentStatus"
           FROM "PaymentInvoiceAccessToken" t
           JOIN "PaymentInvoice" i ON i.id = t."invoiceId"
           JOIN "Payment" p ON p.id = i."paymentId"
          WHERE t."tokenHash" = $1
          LIMIT 1`,
        hash,
    );
    const row = rows[0];
    if (!row) return { state: "INVALID" };
    const state = judgeGuestPayLink({
        revoked: row.revoked === true,
        expired: row.expired === true,
        invoiceStatus: row.invoiceStatus,
        paymentStatus: row.paymentStatus,
    });
    if (state === "INVALID") return { state };
    if (opts.touch !== false) {
        await db.$executeRawUnsafe(
            `UPDATE "PaymentInvoiceAccessToken"
                SET "lastUsedAt" = NOW(), "useCount" = "useCount" + 1
              WHERE id = $1`,
            row.tokenId,
        ).catch((error: unknown) => {
            console.warn("[guest-pay] 사용 기록 실패(화면은 계속):", error instanceof Error ? error.message.slice(0, 200) : error);
        });
    }
    return { state, invoiceId: row.invoiceId, tokenId: row.tokenId };
}

/** 이 청구서의 살아 있는 링크를 모두 닫는다(관리자 회수용). 닫은 개수 */
export async function revokeGuestPayLinks(db: GuestPayDb, invoiceId: string): Promise<number> {
    return db.$executeRawUnsafe(
        `UPDATE "PaymentInvoiceAccessToken" SET "revokedAt" = NOW()
          WHERE "invoiceId" = $1 AND "revokedAt" IS NULL`,
        invoiceId,
    );
}
