/**
 * 토스POS 결제 «자동 매칭» — 서버 실행부 (판정은 ./auto-match.mjs 순수 모듈 한 벌)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 언제 도나
 *  ① 웹훅(paymentNoticeService.processPosWebhookEvent): 알림 분류가 AUTO_CANDIDATE 가 아닌 결제를 DM 보내기 전에 시도
 *  ② 크론(/api/cron/pos-auto-match, 매시간): 7일 안의 열린 알림을 토스에 다시 물어 재시도(놓친 것·청구가 늦게 생긴 것)
 *
 * 돈을 지키는 규칙
 *  - 한 트랜잭션: advisory lock(toss-pos:<결제ID>) → 잠근 뒤 학생·청구를 «다시 읽고 다시 판정» → 쓰기.
 *  - 쓰기는 조건부 UPDATE(미납·금액 그대로)라 하나라도 0행이면 예외로 전부 되돌린다(부분 반영 없음).
 *  - 이미 이 토스 결제로 반영된 청구(providerPaymentKey·멱등키 감사기록)가 있으면 아무것도 안 한다
 *    (2026-11-08~12 수동 동기화분과 충돌 없음 — 그쪽도 providerPaymentKey·toss-pos:<결제ID>:<청구ID> 를 남겼다).
 *  - 원장이 원생을 고른 알림(STUDENT_CHOSEN)·이미 닫힌 알림은 건드리지 않는다.
 *  - 토스는 조회(GET)만 한다.
 */

import { prisma } from "@/lib/prisma";
import { revalidatePaymentCaches } from "@/lib/payment-ledger";
import { rallyzMirrorExclusionSql } from "@/lib/billing/parentSendGuard";
import { fetchTossOrderById } from "./tossplaceClient";
import { AUTO_DECIDER } from "./paymentNoticePay";
import { extractNoticePayments } from "./payment-notice.mjs";
import { kstStamp } from "./payment-notice.mjs";
import {
    AUTO_MATCH,
    SWEEP_MAX_PAID,
    SWEEP_MAX_TOTAL,
    autoMatchIdempotencyKey,
    buildAutoMatchResultLine,
    decideAutoMatch,
    resolveAutoMatchMonth,
} from "./auto-match.mjs";
import { parseMemoNames } from "./tossplace-match.mjs";

type Db = Pick<typeof prisma, "$queryRawUnsafe" | "$executeRawUnsafe">;

export type AutoMatchAllocation = { paymentId: string; studentId: string; studentName: string; className: string; amount: number };
export type AutoMatchMatch = { decision: "MATCH"; year: number; month: number; rule: string; allocations: AutoMatchAllocation[] };
export type AutoMatchResult =
    | { outcome: "PAID"; match: AutoMatchMatch; resultLine: string }
    | { outcome: "HELD"; reason: string }
    | { outcome: "SKIPPED"; reason: string };

const decide = decideAutoMatch as (input: any) => AutoMatchMatch | { decision: "HOLD"; reason: string };
const monthOf = resolveAutoMatchMonth as (memoRaw: string, kstDate: string) => { ok: boolean; year?: number; month?: number; reason?: string };

/** 자동 매칭이 시도할 수 있는 알림 상태 */
const OPEN_NOTICE_STATUSES = ["PENDING", "NOTIFIED", "FAILED"];

/** 잠금 안에서 «하지 말아야 할» 결과가 나오면 던져 트랜잭션을 되돌린다 */
class AutoMatchStop extends Error {
    constructor(
        public readonly outcome: "HELD" | "SKIPPED",
        reason: string,
    ) {
        super(reason);
    }
}

// ───────────────────────────── SQL ─────────────────────────────

/** 이미 이 토스 결제로 반영된 청구가 있나(사이트 납부 기록 또는 멱등키 감사기록) */
export const ALREADY_SYNCED_SQL = `SELECT 1 AS hit FROM "Payment" WHERE "providerPaymentKey" = $1
   UNION ALL
   SELECT 1 FROM "PaymentAuditLog" WHERE metadata->>'idempotencyKey' LIKE 'toss-pos:' || $1 || ':%'
   LIMIT 1`;

/** 이름 판정용 명단 — 미병합 전체 학생(지점 무관: 이름 유일성을 보수적으로 본다) */
export const AUTO_MATCH_ROSTER_SQL = `SELECT s.id, s.name, s."parentId", s.branch
     FROM "Student" s WHERE s."mergedIntoStudentId" IS NULL`;

/**
 * 적용월의 MONTHLY 미납 청구 전부 + «쓸 수 있나» 표시들. 행 잠금(FOR UPDATE OF p) — 판정과 쓰기 사이에 바뀌지 않게.
 * 막힌 청구도 함께 읽는다(빼면 남은 하나가 유일해 보이는 착시 — auto-match.mjs 6번 규칙).
 */
export const AUTO_MATCH_CHARGES_SQL = `SELECT p.id, p."studentId", p.amount, p.status, p.type, p.year, p.month,
            c.name AS "className",
            i.status AS "invoiceStatus", i.amount AS "invoiceAmount",
            EXISTS (SELECT 1 FROM "StaffPaymentConfirmationRequest" sr
                     WHERE sr."paymentId" = p.id AND sr.status = 'PENDING') AS "staffPending",
            EXISTS (SELECT 1 FROM "PosChargeRequest" r
                     WHERE r.status IN ('PENDING', 'SENT', 'HELD', 'PAID')
                       AND (r."paymentId" = p.id
                            OR EXISTS (SELECT 1 FROM "PosChargeRequestItem" ih
                                        WHERE ih."requestId" = r.id AND ih."paymentId" = p.id))) AS "chargeRequestOpen",
            NOT (${rallyzMirrorExclusionSql("p")}) AS "rallyzMirror",
            EXISTS (SELECT 1 FROM "PosPaymentNotice" o
                     WHERE o."sitePaymentId" = p.id AND o."siteMarkedPaid" = true) AS "otherNotice"
       FROM "Payment" p
       LEFT JOIN "Class" c ON c.id = p."classId"
       LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
      WHERE p.type = 'MONTHLY' AND p.year = $1::int AND p.month = $2::int
        AND p.status IN ('PENDING', 'OVERDUE')
      FOR UPDATE OF p`;

/** 청구 납부 처리 — 미납·금액 그대로·MONTHLY 인 것만. paidDate 는 무tz 칸이라 UTC 로 넣는다. */
const MARK_PAID_SQL = `UPDATE "Payment" p
      SET status = 'PAID',
          "paidDate" = COALESCE(p."paidDate", ($2::timestamptz AT TIME ZONE 'UTC'), NOW()),
          method = 'CARD', "paidProvider" = 'TOSS_POS',
          "providerOrderId" = $3, "providerPaymentKey" = $4, "updatedAt" = NOW()
    WHERE p.id = $1 AND p.status IN ('PENDING', 'OVERDUE') AND p.type = 'MONTHLY' AND p.amount = $5::int
    RETURNING p.id`;

const MARK_INVOICE_PAID_SQL = `UPDATE "PaymentInvoice"
      SET status = 'PAID', "paidAt" = COALESCE("paidAt", $2::timestamptz, NOW()), "updatedAt" = NOW()
    WHERE "paymentId" = $1 AND status IN ('ISSUED', 'SENT') AND amount = $3::int
    RETURNING id`;

const AUDIT_SQL = `INSERT INTO "PaymentAuditLog" (id, "paymentId", "invoiceId", "transactionId", "actorType", "actorId", action, message, metadata, "createdAt")
    VALUES (gen_random_uuid()::text, $1, $2, NULL, 'SYSTEM', $3, 'PAYMENT_MARK_PAID', $4, $5::jsonb, NOW())`;

/** 알림 닫기 — 열린 상태인 것만. 다른 알림이 같은 청구를 이미 반영했으면 유일 인덱스가 막는다(→ 전부 되돌림). */
const CLOSE_NOTICE_SQL = `UPDATE "PosPaymentNotice"
      SET status = 'CONFIRMED', "siteMarkedPaid" = true, kind = 'AUTO_CANDIDATE',
          "sitePaymentId" = $2, "resolvedStudentId" = $3, "targetYear" = $4::int, "targetMonth" = $5::int,
          "decidedBySlackUser" = $6, "decidedAt" = now(), error = NULL, "updatedAt" = now()
    WHERE id = $1 AND status IN ('PENDING', 'NOTIFIED', 'FAILED') AND "siteMarkedPaid" = false
    RETURNING id`;

// ───────────────────────────── 실행 ─────────────────────────────

/**
 * 결제 1건 자동 매칭. 여러 번·동시에 불려도 안전하다(잠금 + 이미 반영 확인 + 조건부 UPDATE).
 * @param order 토스 재조회 주문 원문(웹훅 본문 값은 믿지 않는다)
 * @param noticeId 이 결제의 PosPaymentNotice id(있으면 함께 닫는다)
 */
export async function autoMatchPosPayment(input: {
    order: unknown;
    tossPaymentId: string;
    noticeId: string | null;
}): Promise<AutoMatchResult> {
    const payment = (extractNoticePayments(input.order) as any[]).find((p) => p.tossPaymentId === input.tossPaymentId);
    if (!payment) return { outcome: "HELD", reason: "승인된 카드·간편결제가 아닙니다" };
    const memo = parseMemoNames(input.order) as { memoRaw: string };
    const month = monthOf(memo.memoRaw, payment.kstDate);
    if (!month.ok) return { outcome: "HELD", reason: month.reason ?? "적용월을 알 수 없습니다" };

    let match: AutoMatchMatch;
    try {
        match = await prisma.$transaction(
            async (db) => {
                await db.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, `toss-pos:${input.tossPaymentId}`);

                const synced = await db.$queryRawUnsafe<{ hit: number }[]>(ALREADY_SYNCED_SQL, input.tossPaymentId);
                if (synced.length > 0) throw new AutoMatchStop("SKIPPED", "이미 이 토스 결제로 반영된 청구가 있습니다");

                if (input.noticeId) {
                    const notices = await db.$queryRawUnsafe<{ status: string; siteMarkedPaid: boolean }[]>(
                        `SELECT status, "siteMarkedPaid" FROM "PosPaymentNotice" WHERE id = $1 FOR UPDATE`,
                        input.noticeId,
                    );
                    const n = notices[0];
                    if (!n || n.siteMarkedPaid || !OPEN_NOTICE_STATUSES.includes(n.status)) {
                        throw new AutoMatchStop("SKIPPED", "알림이 이미 처리 중이거나 닫혔습니다");
                    }
                }

                const students = await db.$queryRawUnsafe<any[]>(AUTO_MATCH_ROSTER_SQL);
                const charges = (await db.$queryRawUnsafe<any[]>(AUTO_MATCH_CHARGES_SQL, month.year, month.month)).map((c) => ({
                    ...c,
                    amount: Number(c.amount),
                    invoiceAmount: c.invoiceAmount == null ? null : Number(c.invoiceAmount),
                }));
                const decision = decide({
                    order: input.order,
                    tossPaymentId: input.tossPaymentId,
                    amount: payment.amount,
                    kstDate: payment.kstDate,
                    students,
                    charges,
                });
                if (decision.decision !== AUTO_MATCH.MATCH) throw new AutoMatchStop("HELD", (decision as { reason: string }).reason);
                const m = decision as AutoMatchMatch;

                await writeMatch(db, {
                    match: m,
                    tossPaymentId: input.tossPaymentId,
                    tossOrderId: payment.tossOrderId,
                    approvedAtIso: payment.approvedAtIso,
                    tossAmount: payment.amount,
                    memo: payment.memoRaw,
                    noticeId: input.noticeId,
                });
                return m;
            },
            { timeout: 15_000 },
        );
    } catch (error) {
        if (error instanceof AutoMatchStop) return { outcome: error.outcome, reason: error.message };
        throw error;
    }

    try {
        revalidatePaymentCaches();
    } catch (error) {
        console.error("[pos-auto-match] 캐시 무효화 실패(납부는 끝남):", (error as Error).message);
    }
    return { outcome: "PAID", match, resultLine: buildAutoMatchResultLine(match, kstStamp() as string) as string };
}

/** 트랜잭션 안의 쓰기. 하나라도 0행이면 던져서 전부 되돌린다. */
async function writeMatch(
    db: Db,
    input: {
        match: AutoMatchMatch;
        tossPaymentId: string;
        tossOrderId: string;
        approvedAtIso: string | null;
        tossAmount: number;
        memo: string;
        noticeId: string | null;
    },
) {
    const { match } = input;
    const total = match.allocations.reduce((s, a) => s + a.amount, 0);
    if (total !== input.tossAmount) throw new Error(`자동 매칭 중단: 배정 합계 ${total} ≠ 결제액 ${input.tossAmount}`);

    for (const [index, a] of match.allocations.entries()) {
        const paid = await db.$queryRawUnsafe<{ id: string }[]>(
            MARK_PAID_SQL,
            a.paymentId,
            input.approvedAtIso,
            input.tossOrderId,
            input.tossPaymentId,
            a.amount,
        );
        if (paid.length !== 1) throw new Error(`자동 매칭 중단: 청구 ${a.paymentId} 가 미납이 아니거나 금액이 바뀌었습니다(전부 되돌림)`);
        const invoice = await db.$queryRawUnsafe<{ id: string }[]>(MARK_INVOICE_PAID_SQL, a.paymentId, input.approvedAtIso, a.amount);
        if (invoice.length !== 1) throw new Error(`자동 매칭 중단: 청구 ${a.paymentId} 의 청구서가 발행 상태가 아닙니다(전부 되돌림)`);
        await db.$executeRawUnsafe(
            AUDIT_SQL,
            a.paymentId,
            invoice[0].id,
            `pos-auto-match:${input.tossPaymentId}`,
            "토스POS 결제를 사이트 미납 청구에 자동 매칭해 납부 처리",
            JSON.stringify({
                idempotencyKey: autoMatchIdempotencyKey(input.tossPaymentId, a.paymentId),
                source: "POS_AUTO_MATCH",
                rule: match.rule,
                method: "CARD",
                provider: "TOSS_POS",
                tossOrderId: input.tossOrderId,
                tossPaymentId: input.tossPaymentId,
                approvedAt: input.approvedAtIso,
                tossAmount: input.tossAmount,
                allocatedAmount: a.amount,
                className: a.className,
                year: match.year,
                month: match.month,
                noticeId: input.noticeId,
                memo: String(input.memo ?? "").slice(0, 100),
                bundle: { size: match.allocations.length, position: index + 1 },
            }),
        );
    }

    if (input.noticeId) {
        const studentIds = new Set(match.allocations.map((a) => a.studentId));
        const closed = await db.$queryRawUnsafe<{ id: string }[]>(
            CLOSE_NOTICE_SQL,
            input.noticeId,
            match.allocations[0].paymentId,
            studentIds.size === 1 ? match.allocations[0].studentId : null,
            match.year,
            match.month,
            AUTO_DECIDER,
        );
        if (closed.length !== 1) throw new Error("자동 매칭 중단: 알림을 닫지 못했습니다(전부 되돌림)");
    }
}

// ───────────────────────────── 크론 ─────────────────────────────

const readEnv = (name: string) => (typeof process.env[name] === "string" ? (process.env[name] as string).trim() : "");

/** 크론이 다시 볼 알림 — 7일 안, 열린 상태, 아직 이 결제로 반영된 청구가 없는 것(수동 동기화분 제외) */
export const AUTO_MATCH_SWEEP_SQL = `SELECT n.id, n."tossPaymentId", n."tossOrderId", n.amount::float8 AS amount
     FROM "PosPaymentNotice" n
    WHERE n.status IN ('PENDING', 'NOTIFIED', 'FAILED') AND n."siteMarkedPaid" = false
      AND n."createdAt" > now() - interval '7 days'
      AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."providerPaymentKey" = n."tossPaymentId")
    ORDER BY n."createdAt" ASC
    LIMIT 20`;

/**
 * 놓친 결제 다시 맞추기(매시간). 1회 상한 10건·200만원(AGENTS.md).
 * 보류는 DM 을 다시 보내지 않는다(원래 DM 의 버튼이 그대로 있다). 성공만 DM 에 결과 줄.
 * DM 보내기는 호출한 쪽이 넘긴 함수로 한다(paymentNoticeService 와 순환 import 를 피하려고).
 */
export async function runPosAutoMatchSweep(notify: {
    onPaid: (noticeId: string, resultLine: string) => Promise<void>;
    redact: (message: string) => string;
}): Promise<{ checked: number; paid: number; held: number; skipped: number; errors: number; capped: boolean }> {
    const stats = { checked: 0, paid: 0, held: 0, skipped: 0, errors: 0, capped: false };
    const accessKey = readEnv("TOSS_PLACE_ACCESS_KEY");
    const secretKey = readEnv("TOSS_PLACE_ACCESS_SECRET");
    const merchantId = readEnv("TOSS_PLACE_MERCHANT_ID");
    if (!accessKey || !secretKey || !/^\d+$/.test(merchantId)) return stats;

    const rows = await prisma.$queryRawUnsafe<{ id: string; tossPaymentId: string; tossOrderId: string; amount: number }[]>(AUTO_MATCH_SWEEP_SQL);
    let total = 0;
    for (const row of rows) {
        if (stats.paid >= SWEEP_MAX_PAID || total + Number(row.amount) > SWEEP_MAX_TOTAL) {
            stats.capped = true;
            continue;
        }
        stats.checked += 1;
        try {
            const { order } = await fetchTossOrderById({ merchantId, orderId: row.tossOrderId, accessKey, secretKey });
            const result = await autoMatchPosPayment({ order, tossPaymentId: row.tossPaymentId, noticeId: row.id });
            if (result.outcome === "PAID") {
                stats.paid += 1;
                total += Number(row.amount);
                try {
                    await notify.onPaid(row.id, result.resultLine);
                } catch (error) {
                    console.error("[pos-auto-match] 결과 DM 실패(납부는 끝남 — 스윕이 결과 DM 재시도):", notify.redact((error as Error).message), { noticeId: row.id });
                }
            } else if (result.outcome === "HELD") {
                stats.held += 1;
            } else {
                stats.skipped += 1;
            }
        } catch (error) {
            stats.errors += 1;
            console.error("[pos-auto-match] 처리 실패:", notify.redact((error as Error).message), { noticeId: row.id });
        }
    }
    return stats;
}
