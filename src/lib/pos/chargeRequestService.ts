/**
 * 토스 POS «현장 결제» 요청 — 서버 실행부 (DB · 슬랙 · 원장부 연결)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * 돈을 지키는 규칙
 * ─────────────────────────────────────────────────────────────────────────
 * 1. 청구서를 «납부완료»로 바꾸는 곳은 matchChargeRequestsForOrder **하나뿐**이고,
 *    그 근거는 토스 웹훅(서명 검증) → 토스 Open API 재조회로 받은 주문뿐이다.
 *    플러그인이 보내는 보고(report)는 기록만 하고 절대 납부 처리하지 않는다.
 * 2. 금액은 항상 **서버 DB 값**(요청을 만들 때의 Payment.amount 스냅샷)만 쓴다.
 * 3. 선점·재확인은 **한 문장 조건부 UPDATE**(동시에 두 웹훅이 와도 한 곳만 성공).
 * 4. 납부 처리는 markPaymentPaid(원장부) 경유 — Payment 를 직접 UPDATE 하지 않는다.
 * 5. 자동 반영 조건이 하나라도 어긋나면 요청을 HELD 로 두고 기존 슬랙 확인 흐름에 넘긴다(원장 결정 D1).
 *
 * 판정 규칙은 ./charge-request.mjs(순수 모듈) 한 벌이다. 여기는 입출력만 한다.
 * 시각은 전부 DB(now()·timestamptz)에서 만든다 — 서버 시계(UTC)로 날짜를 만들지 않는다.
 */

import { randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { markPaymentPaid, recordPaymentAudit } from "@/lib/payment-ledger";
import { taxFreeAmountFor } from "@/lib/payments/taxFree";
import { postMessage } from "@/lib/slack/client";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
    CHARGE_EXPIRES_MINUTES,
    MATCH_ACTION,
    buildChargeItemName,
    buildChargeMemo,
    chargeEligibility,
    decideChargeMatch,
    extractChargeCodes,
    formatChargeWon,
    maskStudentName,
    nonApprovedPayments,
    paymentTypeLabel,
    randomShortCode,
} from "./charge-request.mjs";

// 순수 JS(.mjs) 함수는 TS 가 인자 타입을 좁게 추론한다 → 이 파일에서만 느슨하게 받는다.
const decide = decideChargeMatch as unknown as (input: unknown) => { action: string; reason: string; payment: ApprovedPayment | null };
const eligibility = chargeEligibility as unknown as (payment: unknown) => { ok: boolean; reason: string };
const itemNameOf = buildChargeItemName as (input: { year: number | null; month: number | null; type: string; maskedName: string }) => string;

// ───────────────────────────── 타입 ─────────────────────────────

/** 카드·승인 결제 1건(payment-notice.mjs 의 extractNoticePayments 결과 중 쓰는 칸) */
export type ApprovedPayment = { tossPaymentId: string; tossOrderId: string; amount: number; approvedAtIso: string | null };

/** 실패 사유 코드 — 관리자 화면·플러그인 API 가 같이 쓴다 */
export type ChargeErrorCode = "NOT_FOUND" | "NOT_ELIGIBLE" | "ALREADY_OPEN" | "NOT_CLAIMABLE" | "CHANGED" | "CODE_EXHAUSTED";

export class ChargeRequestError extends Error {
    constructor(public code: ChargeErrorCode, message: string) {
        super(message);
        this.name = "ChargeRequestError";
    }
}

type ViewRow = {
    id: string;
    shortCode: string;
    paymentId: string;
    status: string;
    amount: number;
    taxFreeAmount: number;
    expiresAtUtc: string;
    expiresKstHm: string;
    createdAtUtc: string;
    paidKst: string | null;
    isExpired: boolean;
    note: string | null;
    createdVia: string;
    paymentType: string;
    year: number | null;
    month: number | null;
    paymentStatus: string;
    studentName: string;
};

/** 관리자 화면용(실명 포함) */
export type AdminChargeRequestView = {
    id: string;
    shortCode: string;
    paymentId: string;
    status: string;
    amount: number;
    taxFreeAmount: number;
    expiresAt: string;
    expiresKstHm: string;
    paidKst: string | null;
    isExpired: boolean;
    note: string | null;
    studentName: string;
    itemLabel: string;
    memo: string;
};

/** 플러그인 API 응답용(이름 가림) — docs/toss-pos-plugin-plan.md «API 계약»과 같은 모양 */
export type PluginChargeRequestView = {
    id: string;
    shortCode: string;
    status: string;
    amount: number;
    taxFreeAmount: number;
    itemName: string;
    /** itemName 과 같은 값(플러그인 README 의 칸 이름) */
    itemTitle: string;
    memo: string;
    studentLabel: string;
    /** studentLabel 과 같은 값 — **가린 이름**(플러그인 README 의 칸 이름) */
    studentName: string;
    expiresAt: string;
    createdAt: string;
};

// ───────────────────────────── SQL ─────────────────────────────

/**
 * 요청 + 청구서 + 원생 이름. 시각은 timestamptz 라 AT TIME ZONE 을 **한 번만** 건다.
 * 원생은 청구서에 붙은 사람을 그대로 보여 준다(청구 조회 — 병합 필터 예외, studentVisibility.test.ts 에 등록).
 */
const VIEW_SQL = `SELECT r.id, r."shortCode", r."paymentId", r.status, r.amount, r."taxFreeAmount",
        to_char(r."expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAtUtc",
        to_char(r."expiresAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS "expiresKstHm",
        to_char(r."createdAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAtUtc",
        to_char(r."paidAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "paidKst",
        (r."expiresAt" <= now()) AS "isExpired",
        r.note, r."createdVia",
        p.type AS "paymentType", p.year, p.month, p.status AS "paymentStatus",
        st.name AS "studentName"
   FROM "PosChargeRequest" r
   JOIN "Payment" p ON p.id = r."paymentId"
   JOIN "Student" st ON st.id = p."studentId"`;

/** 열린 요청 중 시간이 지난 것을 EXPIRED 로(전체 또는 청구서 1건). */
const EXPIRE_SQL = `UPDATE "PosChargeRequest"
      SET status = 'EXPIRED', "updatedAt" = now()
    WHERE status IN ('PENDING', 'SENT') AND "expiresAt" <= now()
      AND ($1::text IS NULL OR "paymentId" = $1)
    RETURNING id`;

/**
 * 요청 만들기 — 청구서 상태·금액을 **INSERT 하는 그 문장에서** 다시 확인한다.
 * 금액은 Payment.amount(DB 값)를 그대로 복사한다. 같은 청구서에 열린 요청이 있으면 부분 유일 인덱스가 막는다.
 */
const INSERT_SQL = `INSERT INTO "PosChargeRequest" (
        "shortCode", "paymentId", amount, "taxFreeAmount", status, "expiresAt",
        "createdVia", "createdByUserId", "createdByName", "claimedAt", "claimedByTokenId"
      )
      SELECT $1, p.id, p.amount, $2::int, $3, now() + ($4::int * interval '1 minute'),
             $5, $6, $7, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, $8::text
        FROM "Payment" p
       WHERE p.id = $9 AND p.amount = $10::int
         AND p.status IN ('PENDING', 'OVERDUE') AND p.type IN ('MONTHLY', 'SHUTTLE')
      RETURNING id`;

/**
 * 플러그인 선점(PENDING → SENT). 같은 토큰이 다시 부르면(응답을 못 받고 재시도) 그대로 성공.
 * 청구서가 그 사이 바뀌었으면(납부·금액 수정) 0행.
 */
const CLAIM_SQL = `UPDATE "PosChargeRequest" r
      SET status = 'SENT', "claimedAt" = COALESCE(r."claimedAt", now()), "claimedByTokenId" = $2, "updatedAt" = now()
    WHERE r.id = $1 AND r."expiresAt" > now()
      AND (r.status = 'PENDING' OR (r.status = 'SENT' AND r."claimedByTokenId" = $2))
      AND EXISTS (SELECT 1 FROM "Payment" p
                   WHERE p.id = r."paymentId" AND p.status IN ('PENDING', 'OVERDUE') AND p.amount = r.amount)
    RETURNING r.id`;

/**
 * 자동 납부 선점 — 이 문장이 1행을 바꿨을 때만 원장부에 납부를 쓴다.
 * 결제 승인 시각이 만료 전이어야 하고(늦게 온 웹훅·스윕이 먼저 EXPIRED 로 바꾼 경우도 살린다),
 * 청구서가 아직 미납이고 금액이 요청과 같아야 한다. 같은 토스 결제가 다른 요청에 이미 붙었으면 유일 인덱스가 막는다.
 */
const CLAIM_PAY_SQL = `UPDATE "PosChargeRequest" r
      SET status = 'PAID', "tossOrderId" = $2, "tossPaymentId" = $3,
          "paidAt" = COALESCE($4::timestamptz, now()), "updatedAt" = now()
    WHERE r.id = $1 AND r.amount = $5::int
      AND r.status IN ('PENDING', 'SENT', 'EXPIRED')
      AND COALESCE($4::timestamptz, now()) <= r."expiresAt"
      AND EXISTS (SELECT 1 FROM "Payment" p
                   WHERE p.id = r."paymentId" AND p.status IN ('PENDING', 'OVERDUE')
                     AND p.amount = r.amount AND p.type IN ('MONTHLY', 'SHUTTLE'))
    RETURNING r.id, r."paymentId", r."shortCode"`;

/** 보류(HELD) — 열린/만료 요청만. 토스 결제 ID 는 note 에만 적는다(유일 인덱스는 «납부된 결제» 용). */
const HOLD_SQL = `UPDATE "PosChargeRequest"
      SET status = 'HELD', "heldAt" = now(), "tossOrderId" = COALESCE("tossOrderId", $2), note = $3, "updatedAt" = now()
    WHERE id = $1 AND status IN ('PENDING', 'SENT', 'EXPIRED')
    RETURNING id`;

// ───────────────────────────── 도우미 ─────────────────────────────

const readEnv = (name: string) => (typeof process.env[name] === "string" ? (process.env[name] as string).trim() : "");

/** 유일 제약 위반(23505)인가 + 어느 인덱스인가 */
function uniqueViolation(error: unknown): string | null {
    const message = String((error as Error)?.message ?? "");
    if (!/23505|unique constraint|duplicate key/i.test(message)) return null;
    const m = /"(PosChargeRequest_[A-Za-z_]+)"/.exec(message);
    return m ? m[1] : "unknown";
}

function toAdminView(row: ViewRow): AdminChargeRequestView {
    return {
        id: row.id,
        shortCode: row.shortCode,
        paymentId: row.paymentId,
        status: row.status,
        amount: Number(row.amount),
        taxFreeAmount: Number(row.taxFreeAmount),
        expiresAt: row.expiresAtUtc,
        expiresKstHm: row.expiresKstHm,
        paidKst: row.paidKst,
        isExpired: Boolean(row.isExpired),
        note: row.note,
        studentName: row.studentName,
        itemLabel: itemNameOf({ year: row.year, month: row.month, type: row.paymentType, maskedName: "" }),
        memo: buildChargeMemo(row.shortCode),
    };
}

function toPluginView(row: ViewRow): PluginChargeRequestView {
    const masked = maskStudentName(row.studentName);
    const itemName = itemNameOf({ year: row.year, month: row.month, type: row.paymentType, maskedName: masked });
    return {
        id: row.id,
        shortCode: row.shortCode,
        status: row.status,
        amount: Number(row.amount),
        // 면세 금액(필수) — 만들 때 taxFreeAmountFor(amount) 로 저장한 값. 플러그인은 amount 와 같을 때만 결제 화면을 연다.
        taxFreeAmount: Number(row.taxFreeAmount),
        itemName,
        itemTitle: itemName,
        memo: buildChargeMemo(row.shortCode),
        studentLabel: masked,
        studentName: masked,
        expiresAt: row.expiresAtUtc,
        createdAt: row.createdAtUtc,
    };
}

async function loadView(where: string, ...params: unknown[]): Promise<ViewRow[]> {
    const rows = await prisma.$queryRawUnsafe<ViewRow[]>(`${VIEW_SQL} ${where}`, ...params);
    return rows.map((r) => ({ ...r, amount: Number(r.amount), taxFreeAmount: Number(r.taxFreeAmount) }));
}

async function notifyOwner(text: string): Promise<boolean> {
    const owner = readEnv("SLACK_OWNER_USER_ID");
    if (!owner) {
        console.warn("[pos-charge] 원장 슬랙 ID(SLACK_OWNER_USER_ID)가 없어 알림을 보내지 못했습니다.");
        return false;
    }
    try {
        await postMessage({ channel: owner, text });
        return true;
    } catch (error) {
        console.error("[pos-charge] 슬랙 알림 실패:", String((error as Error).message).slice(0, 300));
        return false;
    }
}

/** 슬랙 알림을 요청당 한 번만 — 표시 칸을 먼저 선점한 쪽만 보낸다. */
async function notifyOnce(requestId: string, column: "slackNotifiedAt" | "cancelNotifiedAt", text: string) {
    const claimed = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosChargeRequest" SET "${column}" = now() WHERE id = $1 AND "${column}" IS NULL RETURNING id`,
        requestId,
    );
    if (claimed.length === 0) return;
    const sent = await notifyOwner(text);
    // 못 보냈으면 표시를 풀어 다음 웹훅·스윕이 다시 보낼 수 있게 한다.
    if (!sent) {
        await prisma.$executeRawUnsafe(`UPDATE "PosChargeRequest" SET "${column}" = NULL WHERE id = $1`, requestId);
    }
}

// ───────────────────────────── 만료 ─────────────────────────────

/** 시간 지난 열린 요청을 EXPIRED 로. 10분 스윕과 조회 직전에 부른다. */
export async function expireStaleChargeRequests(paymentId: string | null = null): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(EXPIRE_SQL, paymentId);
    return rows.length;
}

// ───────────────────────────── 만들기·취소·조회 ─────────────────────────────

type PaymentRow = { id: string; type: string; status: string; amount: number };

async function loadPayment(paymentId: string): Promise<PaymentRow | null> {
    const rows = await prisma.$queryRawUnsafe<PaymentRow[]>(
        `SELECT id, type, status, amount FROM "Payment" WHERE id = $1`,
        paymentId,
    );
    return rows[0] ? { ...rows[0], amount: Number(rows[0].amount) } : null;
}

async function openRequestFor(paymentId: string): Promise<ViewRow | null> {
    const rows = await loadView(`WHERE r."paymentId" = $1 AND r.status IN ('PENDING', 'SENT') LIMIT 1`, paymentId);
    return rows[0] ?? null;
}

/**
 * 요청 만들기. 이미 열린 요청이 있으면 새로 만들지 않고 그것을 돌려준다(existing: true).
 * claimTokenId 를 주면(플러그인 탭) 만들면서 바로 SENT 로 선점한다.
 */
async function createRow(input: {
    paymentId: string;
    via: "ADMIN" | "PLUGIN";
    actorUserId: string | null;
    actorName: string | null;
    claimTokenId: string | null;
}): Promise<{ row: ViewRow; existing: boolean }> {
    const paymentId = String(input.paymentId ?? "").trim();
    if (!paymentId || paymentId.length > 100) throw new ChargeRequestError("NOT_FOUND", "청구서를 찾지 못했습니다.");

    await expireStaleChargeRequests(paymentId);
    const payment = await loadPayment(paymentId);
    if (!payment) throw new ChargeRequestError("NOT_FOUND", "청구서를 찾지 못했습니다.");
    const check = eligibility(payment);
    if (!check.ok) throw new ChargeRequestError("NOT_ELIGIBLE", check.reason);

    const open = await openRequestFor(paymentId);
    if (open) return { row: open, existing: true };

    // 면세 금액 — 토스페이먼츠 경로와 같은 한 함수(원장 결정 D2: 수강료·셔틀비 전액 면세)
    const taxFree = taxFreeAmountFor(payment.amount);
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const code = randomShortCode(randomInt) as string;
        try {
            const inserted = await prisma.$queryRawUnsafe<{ id: string }[]>(
                INSERT_SQL,
                code,
                taxFree,
                input.claimTokenId ? "SENT" : "PENDING",
                CHARGE_EXPIRES_MINUTES,
                input.via,
                input.actorUserId,
                input.actorName,
                input.claimTokenId,
                paymentId,
                payment.amount,
            );
            if (inserted.length === 0) throw new ChargeRequestError("CHANGED", "청구서 상태나 금액이 방금 바뀌었습니다. 화면을 새로고침해 주세요.");
            const rows = await loadView(`WHERE r.id = $1`, inserted[0].id);
            if (!rows[0]) throw new ChargeRequestError("NOT_FOUND", "만든 요청을 다시 읽지 못했습니다.");
            await recordPaymentAudit({
                paymentId,
                actorType: input.via === "ADMIN" ? "ADMIN" : "SYSTEM",
                actorId: input.via === "ADMIN" ? input.actorUserId : `pos-token:${input.claimTokenId}`,
                action: "POS_CHARGE_REQUEST_CREATED",
                message: `현장 결제 요청 ${code} (${formatChargeWon(payment.amount)})`,
                metadata: { requestId: inserted[0].id, shortCode: code, amount: payment.amount, taxFreeAmount: taxFree, via: input.via },
            }).catch((e) => console.error("[pos-charge] 감사기록 실패:", String((e as Error).message).slice(0, 200)));
            return { row: rows[0], existing: false };
        } catch (error) {
            if (error instanceof ChargeRequestError) throw error;
            const index = uniqueViolation(error);
            if (index === "PosChargeRequest_open_shortCode_key") continue; // 번호가 겹쳤다 → 다시 뽑는다
            if (index === "PosChargeRequest_open_payment_key") {
                // 다른 사람이 동시에 같은 청구서로 만들었다 → 그 요청을 보여 준다
                const again = await openRequestFor(paymentId);
                if (again) return { row: again, existing: true };
            }
            throw error;
        }
    }
    throw new ChargeRequestError("CODE_EXHAUSTED", "번호를 만들지 못했습니다. 잠시 후 다시 눌러 주세요.");
}

/** 관리자 «현장 결제» 버튼 */
export async function createChargeRequestByAdmin(input: { paymentId: string; adminUserId: string; adminName: string }) {
    const { row, existing } = await createRow({
        paymentId: input.paymentId,
        via: "ADMIN",
        actorUserId: input.adminUserId,
        actorName: input.adminName,
        claimTokenId: null,
    });
    return { request: toAdminView(row), existing };
}

/** 관리자 화면: 이 청구서의 최근 요청(열린 것 우선, 없으면 가장 최근 것) */
export async function getChargeRequestForPayment(paymentId: string): Promise<AdminChargeRequestView | null> {
    await expireStaleChargeRequests(paymentId);
    const rows = await loadView(
        `WHERE r."paymentId" = $1
         ORDER BY (r.status IN ('PENDING', 'SENT')) DESC, r."createdAt" DESC
         LIMIT 1`,
        paymentId,
    );
    return rows[0] ? toAdminView(rows[0]) : null;
}

/** 관리자 취소 — 열린 요청만. 돈은 건드리지 않는다. */
export async function cancelChargeRequestByAdmin(input: { requestId: string; adminUserId: string }) {
    const rows = await prisma.$queryRawUnsafe<{ id: string; paymentId: string; shortCode: string }[]>(
        `UPDATE "PosChargeRequest"
            SET status = 'CANCELLED', "cancelledAt" = now(), "cancelledBy" = $2, "updatedAt" = now()
          WHERE id = $1 AND status IN ('PENDING', 'SENT')
          RETURNING id, "paymentId", "shortCode"`,
        input.requestId,
        input.adminUserId,
    );
    if (rows.length === 0) throw new ChargeRequestError("NOT_CLAIMABLE", "이미 끝났거나 취소된 요청입니다.");
    await recordPaymentAudit({
        paymentId: rows[0].paymentId,
        actorType: "ADMIN",
        actorId: input.adminUserId,
        action: "POS_CHARGE_REQUEST_CANCELLED",
        message: `현장 결제 요청 ${rows[0].shortCode} 취소`,
        metadata: { requestId: rows[0].id },
    }).catch((e) => console.error("[pos-charge] 감사기록 실패:", String((e as Error).message).slice(0, 200)));
}

// ───────────────────────────── 플러그인 API ─────────────────────────────

/** 열린(대기·가져감) 요청 목록 — 만료 전인 것만 */
export async function listOpenChargeRequestsForPlugin(): Promise<PluginChargeRequestView[]> {
    await expireStaleChargeRequests(null);
    const rows = await loadView(
        `WHERE r.status IN ('PENDING', 'SENT') AND r."expiresAt" > now()
         ORDER BY r."createdAt" ASC
         LIMIT 50`,
    );
    return rows.map(toPluginView);
}

/** 선점(PENDING → SENT). 응답 금액·면세·메모는 서버 DB 값. */
export async function claimChargeRequestForPlugin(requestId: string, tokenId: string): Promise<PluginChargeRequestView> {
    const id = String(requestId ?? "").trim();
    if (!/^[0-9a-f-]{10,64}$/i.test(id)) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const claimed = await prisma.$queryRawUnsafe<{ id: string }[]>(CLAIM_SQL, id, tokenId);
    const rows = await loadView(`WHERE r.id = $1`, id);
    if (!rows[0]) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    if (claimed.length === 0) {
        throw new ChargeRequestError("NOT_CLAIMABLE", "이미 다른 곳에서 가져갔거나, 만료·취소된 요청입니다.");
    }
    return toPluginView(rows[0]);
}

/** POS 탭에서 미납을 골랐을 때 — 요청을 만들면서 바로 선점(같은 청구서에 대기 요청이 있으면 그걸 선점). */
export async function createAndClaimForPlugin(paymentId: string, tokenId: string): Promise<PluginChargeRequestView> {
    const { row, existing } = await createRow({ paymentId, via: "PLUGIN", actorUserId: null, actorName: null, claimTokenId: tokenId });
    if (!existing) return toPluginView(row);
    return claimChargeRequestForPlugin(row.id, tokenId);
}

export const PLUGIN_REPORT_EVENTS = ["SENT", "PAID", "CANCELLED", "FAILED", "START_FAILED"] as const;
export type PluginReportEvent = (typeof PLUGIN_REPORT_EVENTS)[number];

/**
 * 플러그인이 보내는 event 글자 → 저장 값. 플러그인 README 는 소문자(paid·cancel·start_failed)를 쓴다.
 * 모르는 값이면 null(400).
 */
export function normalizePluginReportEvent(value: unknown): PluginReportEvent | null {
    const raw = String(value ?? "").trim().toUpperCase().replace(/-/g, "_");
    const alias: Record<string, PluginReportEvent> = { CANCEL: "CANCELLED", CANCELED: "CANCELLED" };
    const event = alias[raw] ?? raw;
    return (PLUGIN_REPORT_EVENTS as readonly string[]).includes(event) ? (event as PluginReportEvent) : null;
}

/**
 * 플러그인 보고 — **기록만** 한다. PAID 보고로 납부 처리하지 않는다(위조 가능).
 * CANCELLED 는 열린 요청을 취소 표시한다(돈은 안 움직임 — 그 뒤 결제가 오면 슬랙 확인 흐름).
 */
export async function reportChargeRequestFromPlugin(input: {
    requestId: string;
    tokenId: string;
    event: PluginReportEvent;
    message?: string | null;
}): Promise<{ status: string; paid: boolean; duplicate: boolean }> {
    const id = String(input.requestId ?? "").trim();
    if (!/^[0-9a-f-]{10,64}$/i.test(id)) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const message = input.message ? String(input.message).slice(0, 300) : null;
    // 같은 요청 + 같은 event 는 한 번만(워커·탭이 둘 다 보낼 수 있다): 받은 종류 목록에 없을 때만 바뀐다.
    const rows = await prisma.$queryRawUnsafe<{ status: string }[]>(
        `UPDATE "PosChargeRequest"
            SET "pluginReportedEvent" = $2::text, "pluginReportedAt" = now(), "pluginReportMessage" = $3,
                "pluginReportedEvents" = array_append("pluginReportedEvents", $2::text),
                status = CASE WHEN $2::text = 'CANCELLED' AND status IN ('PENDING', 'SENT') THEN 'CANCELLED' ELSE status END,
                "cancelledAt" = CASE WHEN $2::text = 'CANCELLED' AND status IN ('PENDING', 'SENT') THEN now() ELSE "cancelledAt" END,
                "cancelledBy" = CASE WHEN $2::text = 'CANCELLED' AND status IN ('PENDING', 'SENT') THEN $4 ELSE "cancelledBy" END,
                "updatedAt" = now()
          WHERE id = $1 AND NOT ($2::text = ANY("pluginReportedEvents"))
          RETURNING status`,
        id,
        input.event,
        message,
        `pos-token:${input.tokenId}`,
    );
    if (rows[0]) return { status: rows[0].status, paid: rows[0].status === "PAID", duplicate: false };
    // 0행 = 없는 요청이거나 이미 받은 보고. 지금 상태만 알려 준다(아무것도 바꾸지 않음).
    const current = await prisma.$queryRawUnsafe<{ status: string }[]>(`SELECT status FROM "PosChargeRequest" WHERE id = $1`, id);
    if (!current[0]) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    return { status: current[0].status, paid: current[0].status === "PAID", duplicate: true };
}

export type PluginUnpaidItem = {
    paymentId: string;
    studentLabel: string;
    /** studentLabel 과 같은 값 — **가린 이름**(플러그인 README 의 칸 이름) */
    studentName: string;
    className: string | null;
    title: string;
    amount: number;
    status: string;
    hasOpenRequest: boolean;
};

/**
 * POS 탭 미납 목록 — 이름은 가리고, 반·청구월·금액만. 전화번호·주소·보호자는 절대 싣지 않는다.
 * 검색어는 서버에서 실명과 비교하되 응답에는 가린 이름만 나간다. 최대 30건.
 */
export async function listUnpaidForPlugin(query: string): Promise<PluginUnpaidItem[]> {
    // LIKE 특수문자(% _ \)는 지워 «아무거나 맞음» 검색을 막는다.
    const q = String(query ?? "").replace(/[%_\\]/g, "").trim().slice(0, 20);
    const rows = await prisma.$queryRawUnsafe<{
        paymentId: string; studentName: string; className: string | null; type: string;
        year: number | null; month: number | null; amount: number; status: string; hasOpenRequest: boolean;
    }[]>(
        `SELECT p.id AS "paymentId", s.name AS "studentName", c.name AS "className", p.type, p.year, p.month,
                p.amount, p.status,
                EXISTS (SELECT 1 FROM "PosChargeRequest" r
                         WHERE r."paymentId" = p.id AND r.status IN ('PENDING', 'SENT') AND r."expiresAt" > now()) AS "hasOpenRequest"
           FROM "Payment" p
           JOIN "Student" s ON s.id = p."studentId" AND ${notMergedStudent("s")}
           LEFT JOIN "Class" c ON c.id = p."classId"
          WHERE p.status IN ('PENDING', 'OVERDUE') AND p.type IN ('MONTHLY', 'SHUTTLE') AND p.amount > 0
            AND ($1::text = '' OR s.name ILIKE '%' || $1::text || '%')
          ORDER BY p.year DESC NULLS LAST, p.month DESC NULLS LAST, s.name ASC
          LIMIT 30`,
        q,
    );
    return rows.map((r) => {
        const masked = maskStudentName(r.studentName);
        return {
            paymentId: r.paymentId,
            studentLabel: masked,
            studentName: masked,
            className: r.className,
            title: itemNameOf({ year: r.year, month: r.month, type: r.type, maskedName: "" }),
            amount: Number(r.amount),
            status: r.status,
            hasOpenRequest: Boolean(r.hasOpenRequest),
        };
    });
}

// ───────────────────────────── 웹훅 매칭 (돈이 움직이는 유일한 곳) ─────────────────────────────

type MatchRow = ViewRow & { tossPaymentId: string | null; tossOrderId: string | null; expiresAtTs: string; paymentAmount: number };

const MATCH_SELECT = `SELECT r.id, r."shortCode", r."paymentId", r.status, r.amount, r."taxFreeAmount",
        r."tossPaymentId", r."tossOrderId",
        to_char(r."expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAtTs",
        p.type AS "paymentType", p.year, p.month, p.status AS "paymentStatus", p.amount AS "paymentAmount",
        st.name AS "studentName"
   FROM "PosChargeRequest" r
   JOIN "Payment" p ON p.id = r."paymentId"
   JOIN "Student" st ON st.id = p."studentId"`;

async function loadMatchRows(where: string, ...params: unknown[]): Promise<MatchRow[]> {
    const rows = await prisma.$queryRawUnsafe<MatchRow[]>(`${MATCH_SELECT} ${where}`, ...params);
    return rows.map((r) => ({ ...r, amount: Number(r.amount), paymentAmount: Number(r.paymentAmount) }));
}

function describe(row: Pick<MatchRow, "shortCode" | "studentName" | "year" | "month" | "paymentType" | "amount">) {
    const when = row.year && row.month ? `${row.year}년 ${row.month}월 ` : "";
    return `${row.shortCode} · ${row.studentName} · ${when}${paymentTypeLabel(row.paymentType)} · ${formatChargeWon(row.amount)}`;
}

/**
 * 토스 재조회로 받은 주문 1건을 «현장 결제» 요청과 맞춘다.
 * 돌려주는 handledTossPaymentIds 의 결제는 기존 슬랙 확인 알림(PosPaymentNotice)을 만들지 않는다
 * (자동 납부됐거나, 같은 결제로 이미 자동 납부된 재전송). 나머지는 전부 기존 흐름 그대로.
 */
export async function matchChargeRequestsForOrder(input: {
    order: unknown;
    orderId: string;
    approved: ApprovedPayment[];
    redact: (message: string) => string;
}): Promise<{ handledTossPaymentIds: string[]; note: string }> {
    const { order, orderId, approved, redact } = input;
    const handled: string[] = [];
    const notes: string[] = [];

    // ① POS 에서 취소된 자동 납부 건 — 납부를 되돌리지 않고(환불은 사람이) 원장에게 알린다.
    const paidRows = await loadMatchRows(`WHERE r."tossOrderId" = $1 AND r.status = 'PAID'`, orderId);
    for (const row of paidRows) {
        const stillApproved = approved.some((p) => p.tossPaymentId === row.tossPaymentId);
        if (stillApproved) continue;
        await prisma.$executeRawUnsafe(
            `UPDATE "PosChargeRequest"
                SET note = left(COALESCE(note || ' / ', '') || 'POS 에서 결제가 취소됨 — 청구서·환불 확인 필요', 1000), "updatedAt" = now()
              WHERE id = $1 AND "cancelNotifiedAt" IS NULL`,
            row.id,
        );
        await notifyOnce(row.id, "cancelNotifiedAt", `⚠️ POS 에서 취소됨 — 현장 결제 ${describe(row)}\n사이트 청구서는 납부완료 그대로입니다. 청구서·환불을 확인해 주세요.`);
        notes.push(`${row.shortCode} POS 취소 알림`);
    }

    // ② 메모 번호 → 요청. 번호가 0개·2개 이상이면 자동 처리하지 않는다(기존 흐름).
    const codes = extractChargeCodes(order) as string[];
    if (codes.length !== 1) {
        if (codes.length > 1) notes.push(`메모에 번호가 ${codes.length}개라 자동 처리 안 함`);
        return { handledTossPaymentIds: handled, note: notes.join(" · ") };
    }
    const code = codes[0];
    // 열린 요청 우선, 없으면 사흘 안의 가장 최근 요청(만료·납부·보류 판정용)
    const rows = await loadMatchRows(
        `WHERE r."shortCode" = $1 AND r."createdAt" > now() - interval '3 days'
         ORDER BY (r.status IN ('PENDING', 'SENT')) DESC, r."createdAt" DESC
         LIMIT 1`,
        code,
    );
    const request = rows[0];
    if (!request) {
        notes.push(`${code} 요청 없음`);
        return { handledTossPaymentIds: handled, note: notes.join(" · ") };
    }

    const verdict = decide({
        request: { status: request.status, amount: request.amount, tossPaymentId: request.tossPaymentId, expiresAt: request.expiresAtTs },
        site: { status: request.paymentStatus, amount: request.paymentAmount, type: request.paymentType },
        approved,
        others: nonApprovedPayments(order),
    });

    if (verdict.action === MATCH_ACTION.ALREADY_DONE && verdict.payment) {
        handled.push(verdict.payment.tossPaymentId);
        notes.push(`${code} 이미 자동 반영됨`);
        return { handledTossPaymentIds: handled, note: notes.join(" · ") };
    }
    if (verdict.action === MATCH_ACTION.SKIP) {
        notes.push(`${code} ${verdict.reason}`);
        return { handledTossPaymentIds: handled, note: notes.join(" · ") };
    }

    const hold = async (reason: string) => {
        const paymentRef = verdict.payment ? ` (토스 결제 ${verdict.payment.tossPaymentId})` : "";
        const done = await prisma.$queryRawUnsafe<{ id: string }[]>(HOLD_SQL, request.id, orderId, `${reason}${paymentRef}`.slice(0, 1000));
        if (done.length > 0) {
            await notifyOnce(
                request.id,
                "slackNotifiedAt",
                `⏸️ 현장 결제 자동 반영 보류 — ${describe(request)}\n사유: ${reason}\n이어서 오는 결제 확인 알림에서 처리해 주세요.`,
            );
        }
        notes.push(`${code} 보류: ${reason}`);
        return { handledTossPaymentIds: handled, note: notes.join(" · ") };
    };

    if (verdict.action === MATCH_ACTION.HOLD || !verdict.payment) return hold(verdict.reason);

    // ③ 자동 납부 — 한 문장 선점이 1행일 때만 원장부에 쓴다.
    const payment = verdict.payment;
    let claimed: { id: string; paymentId: string; shortCode: string }[] = [];
    try {
        claimed = await prisma.$queryRawUnsafe(CLAIM_PAY_SQL, request.id, orderId, payment.tossPaymentId, payment.approvedAtIso, request.amount);
    } catch (error) {
        if (uniqueViolation(error)) {
            // 이 토스 결제가 이미 다른 요청에 붙었다 → 자동 처리하지 않고 기존 흐름
            notes.push(`${code} 같은 토스 결제가 다른 요청에 이미 반영됨`);
            return { handledTossPaymentIds: handled, note: notes.join(" · ") };
        }
        throw error;
    }
    if (claimed.length === 0) return hold("확정하는 순간 청구서·요청 상태가 바뀌었습니다.");

    try {
        await markPaymentPaid({
            paymentId: claimed[0].paymentId,
            actorType: "WEBHOOK",
            actorId: `pos-charge:${claimed[0].shortCode}`,
            // 기존 POS 납부 표기(슬랙 [사이트 납부 반영] 버튼)와 같게
            method: "CARD",
            provider: "TOSS_POS",
            providerOrderId: orderId,
            paymentKey: payment.tossPaymentId,
            paidAt: payment.approvedAtIso,
        });
    } catch (error) {
        const message = redact((error as Error).message);
        console.error("[pos-charge] 자동 납부 반영 실패:", message, { requestId: request.id });
        const now = await prisma.$queryRawUnsafe<{ status: string }[]>(`SELECT status FROM "Payment" WHERE id = $1`, claimed[0].paymentId);
        if (now[0]?.status !== "PAID") {
            // 납부가 안 됐다 → 보류로 돌리고 기존 슬랙 확인 흐름에 맡긴다(돈이 들어온 건 사실이므로 사람이 확인).
            await prisma.$executeRawUnsafe(
                `UPDATE "PosChargeRequest" SET status = 'HELD', "heldAt" = now(), note = $2, "updatedAt" = now()
                  WHERE id = $1 AND status = 'PAID'`,
                request.id,
                `자동 납부 반영 중 오류: ${message}`.slice(0, 1000),
            );
            await notifyOnce(request.id, "slackNotifiedAt", `⚠️ 현장 결제 자동 반영 실패 — ${describe(request)}\n이어서 오는 결제 확인 알림에서 처리해 주세요.`);
            notes.push(`${code} 자동 반영 실패 → 보류`);
            return { handledTossPaymentIds: handled, note: notes.join(" · ") };
        }
    }

    handled.push(payment.tossPaymentId);
    await notifyOnce(
        request.id,
        "slackNotifiedAt",
        `✅ 자동 납부 반영 — 현장 결제 ${describe(request)}\n사이트 청구서를 납부완료로 바꿨습니다. 랠리즈에도 처리해 주세요.`,
    );
    notes.push(`${code} 자동 납부 반영`);
    return { handledTossPaymentIds: handled, note: notes.join(" · ") };
}
