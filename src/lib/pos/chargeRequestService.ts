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
import { markPaymentPaid, recordPaymentAudit, refundPaidPaymentInTx, revalidatePaymentCaches } from "@/lib/payment-ledger";
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
    taxExemptAmountsOf,
    randomShortCode,
    describeChargePayments,
    isOrderCompleted,
    posMethodLabel,
    posMethodOf,
    CANCEL_PICKUP_TIMEOUT_SEC,
    cancelEligibility,
    chargePaymentIdsOf,
    decideChargeCancel,
} from "./charge-request.mjs";

// 순수 JS(.mjs) 함수는 TS 가 인자 타입을 좁게 추론한다 → 이 파일에서만 느슨하게 받는다.
const decide = decideChargeMatch as unknown as (input: unknown) => {
    action: string;
    reason: string;
    /** 대표 결제(가장 먼저 승인된 것) */
    payment: ApprovedPayment | null;
    /** 이 요청에 쓰인 승인 결제 전부(분할이면 여러 건, 승인 순) */
    payments: ApprovedPayment[];
    /** 마지막 승인 시각(납부일·만료 판단) */
    paidAtIso: string | null;
    /** 분할 결제 중간이라 남은 결제를 기다리는 중 */
    waiting?: boolean;
};
const methodOf = posMethodOf as (sourceTypes: string[]) => string;
const describePayments = describeChargePayments as (payments: ApprovedPayment[]) => string;
const posLabelOf = (method: string) => (posMethodLabel as (m: string) => string | null)(method) ?? method;
const completedOf = isOrderCompleted as (order: unknown, eventType?: string) => boolean;
const eligibility = chargeEligibility as unknown as (payment: unknown) => { ok: boolean; reason: string };
const paymentIdsOf = chargePaymentIdsOf as (input: { tossPaymentId?: string | null; note?: string | null; auditPaymentIds?: string[] | null }) => string[];
const cancelVerdictOf = decideChargeCancel as (input: { paymentIds: string[]; order: unknown }) => {
    action: "FULL" | "PARTIAL" | "NONE";
    cancelled: string[];
    other: { id: string; state: string }[];
};
const cancelCheck = cancelEligibility as unknown as (input: unknown) => { ok: boolean; reason: string };
const itemNameOf = buildChargeItemName as (input: { year: number | null; month: number | null; type: string; maskedName: string }) => string;

/** POS 가 취소 완료를 보고한 뒤 토스 확인을 기다리는 «정상» 시간(분). 넘으면 관리자 창에 늦어진다는 안내 */
const CANCEL_CONFIRM_LATE_MIN = 3;

// ───────────────────────────── 타입 ─────────────────────────────

/** 승인 결제 1건(payment-notice.mjs 의 extractChargePayments 결과 중 쓰는 칸 — 결제 방식 무관) */
export type ApprovedPayment = { tossPaymentId: string; tossOrderId: string; amount: number; approvedAtIso: string | null; sourceType?: string };

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
    /** PAID 로 바뀐 지 2분 이내(DB 시계) — 원장부 납부 기록이 아직 진행 중일 수 있는 틈 */
    justPaid?: boolean;
    note: string | null;
    createdVia: string;
    paymentType: string;
    year: number | null;
    month: number | null;
    paymentStatus: string;
    studentName: string;
    /** 결제 취소(사이트 → POS) 칸 — VIEW_SQL 이 같이 읽는다 */
    tossOrderId: string | null;
    tossPaymentId: string | null;
    cancelState: string | null;
    cancelReportMessage?: string | null;
    refundedKst?: string | null;
    /** 취소 요청 뒤 CANCEL_PICKUP_TIMEOUT_SEC 가 지나도 플러그인이 안 가져감 */
    cancelPickupLate?: boolean;
    /** 플러그인이 취소 결과를 보고했나 */
    cancelReported?: boolean;
    /** POS 취소 완료 보고 뒤 CANCEL_CONFIRM_LATE_MIN 분이 지나도 토스 확인(DONE)이 없음 */
    cancelConfirmLate?: boolean;
    paidProvider?: string | null;
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
        -- 납부 «기록» 시각(paidRecordedAt, 없으면 승인 시각 paidAt) 기준 — 취소 알림 note 등으로 updatedAt 이 바뀌어도 영향 없게
        (r.status = 'PAID' AND COALESCE(r."paidRecordedAt", r."paidAt") > now() - interval '2 minutes') AS "justPaid",
        r.note, r."createdVia",
        r."tossOrderId", r."tossPaymentId", r."cancelState", r."cancelReportMessage",
        to_char(r."refundedAt" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS "refundedKst",
        (r."cancelState" = 'REQUESTED' AND r."cancelRequestedAt" < now() - interval '${CANCEL_PICKUP_TIMEOUT_SEC} seconds') AS "cancelPickupLate",
        (r."cancelReportedAt" IS NOT NULL) AS "cancelReported",
        (r."cancelState" = 'SENT' AND r."cancelReportedAt" < now() - interval '${CANCEL_CONFIRM_LATE_MIN} minutes') AS "cancelConfirmLate",
        p.type AS "paymentType", p.year, p.month, p.status AS "paymentStatus", p."paidProvider",
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
 * 분할 결제(2026-11-08): 유일 칸(tossPaymentId)에는 대표 결제(가장 먼저 승인) 1건만 넣고, 나머지 결제 ID 는
 * note($6)·감사 기록(PaymentAuditLog)에 남긴다. 나머지 결제의 이중 매칭은 «같은 토스 주문이 다른 요청에 이미 PAID»
 * 조건(NOT EXISTS)으로 막는다 — 한 주문의 결제는 전부 그 주문 몫이라 주문 단위로 막으면 결제 단위로도 막힌다.
 * $4 = 마지막 승인 시각(만료 판단·납부일).
 */
const CLAIM_PAY_SQL = `UPDATE "PosChargeRequest" r
      SET status = 'PAID', "tossOrderId" = $2, "tossPaymentId" = $3,
          "paidAt" = COALESCE($4::timestamptz, now()), "paidRecordedAt" = now(), note = COALESCE($6::text, r.note), "updatedAt" = now()
    WHERE r.id = $1 AND r.amount = $5::int
      AND r.status IN ('PENDING', 'SENT', 'EXPIRED')
      AND COALESCE($4::timestamptz, now()) <= r."expiresAt"
      AND NOT EXISTS (SELECT 1 FROM "PosChargeRequest" o
                       WHERE o.id <> r.id AND o."tossOrderId" = $2 AND o.status = 'PAID')
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
    // 자동 납부는 «요청 PAID 선점 → 원장부(청구서) 납부 기록» 순서다. 그 짧은 틈에 관리자 창이 PAID 를 읽으면
    // 목록을 다시 읽어도 청구서가 아직 미납이라 «미납»으로 남았다(2026-11-08 원장 화면). 청구서가 아직 미납이면
    // 관리자 화면엔 «결제 기다리는 중»(SENT, 만료 아님)으로 보여 계속 읽게 하고, 청구서까지 납부된 뒤 PAID 로 보인다.
    // 단, PAID 로 바뀐 지 2분 이내일 때만 — 서버가 그 틈에 멈춘 드문 경우 창이 끝없이 기다리지 않게.
    const ledgerPending = row.status === "PAID" && Boolean(row.justPaid) && ["PENDING", "OVERDUE"].includes(String(row.paymentStatus));
    return {
        id: row.id,
        shortCode: row.shortCode,
        paymentId: row.paymentId,
        status: ledgerPending ? "SENT" : row.status,
        amount: Number(row.amount),
        taxFreeAmount: Number(row.taxFreeAmount),
        expiresAt: row.expiresAtUtc,
        expiresKstHm: row.expiresKstHm,
        paidKst: row.paidKst,
        isExpired: ledgerPending ? false : Boolean(row.isExpired),
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
async function notifyOnce(requestId: string, column: "slackNotifiedAt" | "cancelNotifiedAt" | "refundNotifiedAt", text: string) {
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

/**
 * 롱폴링 대기 중 약 1초마다 부르는 «가벼운» 확인 — 플러그인이 모르는(known 에 없는) 대기 요청이 있는지만.
 * 만료 정리(UPDATE)나 이름·청구서 JOIN 없이 (status, expiresAt) 인덱스만 본다. 있으면 그때 목록을 다시 읽는다.
 */
export async function hasUnknownPendingChargeRequest(knownIds: string[]): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ found: boolean }[]>(
        `SELECT EXISTS (
            SELECT 1 FROM "PosChargeRequest"
             WHERE status = 'PENDING' AND "expiresAt" > now() AND NOT (id = ANY($1::text[]))
         ) AS found`,
        knownIds,
    );
    return Boolean(rows[0]?.found);
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

type MatchRow = ViewRow & {
    expiresAtTs: string;
    paymentAmount: number;
    /** 결제 취소 진행 상태(NULL = 없음) */
    cancelState: string | null;
    /** DB 시계로 지금 만료됐나(분할 결제 대기 판단) */
    isExpiredNow: boolean;
};

const MATCH_SELECT = `SELECT r.id, r."shortCode", r."paymentId", r.status, r.amount, r."taxFreeAmount",
        r."tossPaymentId", r."tossOrderId", r.note, r."cancelState",
        to_char(r."expiresAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "expiresAtTs",
        (r."expiresAt" <= now()) AS "isExpiredNow",
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
 * (자동 납부됐거나, 같은 결제로 이미 자동 납부된 재전송, 분할 결제의 남은 결제를 기다리는 중). 나머지는 전부 기존 흐름 그대로.
 *
 * approved = 이 주문의 **방식 무관** 승인 결제(payment-notice.mjs 의 extractChargePayments).
 * eventType = 웹훅 종류(order.order.completed 면 주문이 끝난 것 — 분할 결제 합계가 모자라면 그때 보류).
 *
 * retryLater = true 면 웹훅 처리부가 이 알림을 «처리 완료»로 표시하지 않는다 → 10분 스윕이 다시 부른다.
 *   (분할 결제 대기 중 · 납부 기록 복구를 아직 못 함) — 대기 상태가 DB(웹훅 note)에 남고, 주문이 버려져도
 *   요청 유효 시간이 지나면 스윕이 보류(HOLD)+알림으로 끝낸다(2026-11-08 검수).
 */
export async function matchChargeRequestsForOrder(input: {
    order: unknown;
    orderId: string;
    approved: ApprovedPayment[];
    eventType?: string;
    redact: (message: string) => string;
}): Promise<{ handledTossPaymentIds: string[]; note: string; retryLater: boolean }> {
    const { order, orderId, approved, redact } = input;
    const handled: string[] = [];
    const notes: string[] = [];
    let retryLater = false;
    const idsOf = (list: ApprovedPayment[]) => list.map((p) => p.tossPaymentId);
    const done = () => ({ handledTossPaymentIds: handled, note: notes.join(" · "), retryLater });

    // ① 자동 납부된 요청의 결제가 취소됐나(사이트 «결제 취소»로 시작했든 POS 에서 직접 취소했든 같은 길).
    //    그 요청의 결제가 «전부» 취소면 청구서를 환불(REFUNDED)로, 일부만이면 청구서는 그대로 두고 사람 확인(PARTIAL).
    //    근거는 이 함수에 들어온 주문(토스 재조회 값)뿐이다 — 플러그인 보고로는 환불하지 않는다.
    const paidRows = await loadMatchRows(`WHERE r."tossOrderId" = $1 AND r.status = 'PAID'`, orderId);
    for (const row of paidRows) {
        const settled = await settleCancelForRow(row, order, orderId);
        if (settled) {
            notes.push(settled.note);
            // 납부 기록이 아직 진행 중일 수 있는 틈에 취소가 왔다 → 스윕이 다시 와서 환불·알림을 마무리한다
            if (settled.retry) retryLater = true;
        }
    }

    // ② 메모 번호 → 요청. 번호가 0개·2개 이상이면 자동 처리하지 않는다(기존 흐름).
    const codes = extractChargeCodes(order) as string[];
    if (codes.length !== 1) {
        if (codes.length > 1) notes.push(`메모에 번호가 ${codes.length}개라 자동 처리 안 함`);
        return done();
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
        return done();
    }

    // 결제마다 토스가 알려 준 면세 금액(taxExemptAmount)을 붙여 판정한다(합계가 요청 면세액과 다르면 보류).
    const exempt = taxExemptAmountsOf(order) as Record<string, number | null>;
    const verdict = decide({
        request: {
            status: request.status,
            amount: request.amount,
            taxFreeAmount: Number(request.taxFreeAmount),
            tossPaymentId: request.tossPaymentId,
            expiresAt: request.expiresAtTs,
            isExpiredNow: Boolean(request.isExpiredNow),
        },
        site: { status: request.paymentStatus, amount: request.paymentAmount, type: request.paymentType },
        approved: approved.map((p) => ({ ...p, taxExemptAmount: exempt[p.tossPaymentId] ?? null })),
        others: nonApprovedPayments(order),
        orderCompleted: completedOf(order, input.eventType ?? ""),
    });

    if (verdict.action === MATCH_ACTION.ALREADY_DONE && verdict.payment) {
        const mine = verdict.payments.length > 0 ? verdict.payments : [verdict.payment];
        handled.push(...idsOf(mine));
        // 요청은 PAID 인데 청구서가 아직 미납 = «선점 → 원장부 기록» 사이에 함수가 멈췄던 것(웹훅 4초 응답 뒤 등).
        // 같은 결제·같은 금액이면 원장부 기록을 다시 시도한다(멱등 — 임대 SQL 이 한 곳만 통과시킨다). 취소가 걸린 요청은 건드리지 않는다.
        if (["PENDING", "OVERDUE"].includes(String(request.paymentStatus)) && !request.cancelState) {
            const repaired = await repairLedgerPaid({ request, orderId, payments: mine, paidAtIso: verdict.paidAtIso, redact });
            notes.push(`${code} ${repaired.note}`);
            if (repaired.retry) retryLater = true;
            return done();
        }
        notes.push(`${code} 이미 자동 반영됨`);
        return done();
    }
    if (verdict.action === MATCH_ACTION.SKIP) {
        // 분할 결제 중간: 아직 판단 전이라 그 결제들의 슬랙 확인 알림도 미룬다(주문 완료 웹훅에서 납부 또는 보류 → 그때 알림).
        // 대기 판정은 웹훅을 «처리 완료»로 두지 않는다 → 스윕이 다시 보고, 유효 시간이 지나면 보류+알림으로 끝난다.
        if (verdict.waiting) {
            handled.push(...idsOf(verdict.payments));
            retryLater = true;
        }
        notes.push(`${code} ${verdict.reason}`);
        return done();
    }

    const hold = async (reason: string) => {
        const paymentRef = verdict.payments.length > 1
            ? ` (토스 결제 ${idsOf(verdict.payments).join(", ")})`
            : verdict.payment ? ` (토스 결제 ${verdict.payment.tossPaymentId})` : "";
        const heldRows = await prisma.$queryRawUnsafe<{ id: string }[]>(HOLD_SQL, request.id, orderId, `${reason}${paymentRef}`.slice(0, 1000));
        if (heldRows.length > 0) {
            await notifyOnce(
                request.id,
                "slackNotifiedAt",
                `⏸️ 현장 결제 자동 반영 보류 — ${describe(request)}\n사유: ${reason}\n카드·간편결제는 이어서 오는 결제 확인 알림에서, 현금·계좌이체 등은 관리자 수납 화면에서 처리해 주세요.`,
            );
        } else if (verdict.payment) {
            // 보류 0행 = 그 사이 상태가 바뀜. 동시에 온 다른 웹훅(주문·결제 알림)이 «이 결제로» 이미 자동 납부했으면
            // 처리 끝으로 본다 — 안 그러면 납부된 결제에 슬랙 확인 DM 이 한 통 더 간다.
            const now = await prisma.$queryRawUnsafe<{ status: string; tossPaymentId: string | null }[]>(
                `SELECT status, "tossPaymentId" FROM "PosChargeRequest" WHERE id = $1`,
                request.id,
            );
            if (now[0]?.status === "PAID" && now[0].tossPaymentId === verdict.payment.tossPaymentId) {
                handled.push(...idsOf(verdict.payments.length > 0 ? verdict.payments : [verdict.payment]));
                notes.push(`${code} 다른 알림이 이미 자동 반영함`);
                return done();
            }
        }
        notes.push(`${code} 보류: ${reason}`);
        return done();
    };

    if (verdict.action === MATCH_ACTION.HOLD || !verdict.payment) return hold(verdict.reason);

    // ③ 자동 납부 — 한 문장 선점이 1행일 때만 원장부에 쓴다.
    //    대표 결제 = 가장 먼저 승인된 결제(유일 칸), 납부일 = 마지막 승인 시각, 분할이면 나머지 결제 ID 를 note 에.
    const payment = verdict.payment;
    const payments = verdict.payments.length > 0 ? verdict.payments : [payment];
    const method = methodOf(payments.map((p) => String(p.sourceType ?? "")));
    const splitNote = payments.length > 1 ? describePayments(payments).slice(0, 1000) : null;
    let claimed: { id: string; paymentId: string; shortCode: string }[] = [];
    try {
        claimed = await prisma.$queryRawUnsafe(CLAIM_PAY_SQL, request.id, orderId, payment.tossPaymentId, verdict.paidAtIso, request.amount, splitNote);
    } catch (error) {
        if (uniqueViolation(error)) {
            // 이 토스 결제가 이미 다른 요청에 붙었다 → 자동 처리하지 않고 기존 흐름
            notes.push(`${code} 같은 토스 결제가 다른 요청에 이미 반영됨`);
            return done();
        }
        throw error;
    }
    if (claimed.length === 0) return hold("확정하는 순간 청구서·요청 상태가 바뀌었습니다(또는 같은 주문이 다른 요청에 이미 반영됨).");

    try {
        // 원장부 기록 — 정상 경로와 복구 경로(repairLedgerPaid)가 같은 도우미(writeLedgerPaid, 파일 맨 아래)를 쓴다.
        await writeLedgerPaid({ claimed: claimed[0], orderId, method, payment, paidAtIso: verdict.paidAtIso });
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
            return done();
        }
    }

    await recordChargePaymentsAudit({ claimed: claimed[0], orderId, method, payments, redact });

    handled.push(...idsOf(payments));
    // 납부 기록 «사이»에 취소 웹훅이 먼저 와서 요청을 DONE 으로 만들었으면, 방금 쓴 납부를 곧바로 환불로 되돌린다(검수 P-1).
    if (await refundIfCancelledDuringLedger(claimed[0], request)) {
        notes.push(`${code} 납부 기록 중 POS 취소 확인 → 환불`);
        return done();
    }
    const split = payments.length > 1 ? ` · 분할 ${payments.length}건` : "";
    await notifyOnce(
        request.id,
        "slackNotifiedAt",
        `✅ 자동 납부 반영 — 현장 결제 ${describe(request)} (${posLabelOf(method)}${split})\n사이트 청구서를 납부완료로 바꿨습니다.`,
    );
    notes.push(`${code} 자동 납부 반영`);
    return done();
}

// ───────────────────────────── 원장부 기록 도우미 (정상 경로·복구 경로 공용) ─────────────────────────────

type ClaimedRow = { id?: string; paymentId: string; shortCode: string };

/**
 * 원장부(청구서)에 납부를 쓴다 — 이 파일에서 markPaymentPaid 를 부르는 유일한 곳.
 * 부르는 쪽은 둘뿐이다: ① CLAIM_PAY_SQL 선점 1행 뒤(정상) ② REPAIR_LEASE_SQL 임대 1행 뒤(멈춘 기록 복구).
 */
async function writeLedgerPaid(input: { claimed: ClaimedRow; orderId: string; method: string; payment: ApprovedPayment; paidAtIso: string | null }) {
    await markPaymentPaid({
        paymentId: input.claimed.paymentId,
        actorType: "WEBHOOK",
        actorId: `pos-charge:${input.claimed.shortCode}`,
        // 실제 결제 방식(2026-11-08): CARD·CASH·EASY_PAY(QR·토스페이)·BANK_TRANSFER·ETC, 분할이면 «CARD+CASH».
        // 단건 카드는 예전과 같은 «CARD» 그대로다. 화면은 posMethodLabel 이 «현장 · 카드+현금» 으로 보여 준다.
        method: input.method,
        provider: "TOSS_POS",
        providerOrderId: input.orderId,
        paymentKey: input.payment.tossPaymentId,
        paidAt: input.paidAtIso,
    });
}

/** 감사 기록 — 이 납부에 쓰인 토스 결제 전부(분할이면 여러 건)와 방식. 실패해도 납부는 이미 끝났으니 막지 않는다. */
async function recordChargePaymentsAudit(input: {
    claimed: ClaimedRow;
    orderId: string;
    method: string;
    payments: ApprovedPayment[];
    redact: (message: string) => string;
}) {
    const splitNote = input.payments.length > 1 ? describePayments(input.payments).slice(0, 1000) : null;
    try {
        await recordPaymentAudit({
            paymentId: input.claimed.paymentId,
            actorType: "WEBHOOK",
            actorId: `pos-charge:${input.claimed.shortCode}`,
            action: "POS_CHARGE_PAYMENTS",
            message: splitNote ?? `현장 결제 1건(${input.method})`,
            metadata: {
                shortCode: input.claimed.shortCode,
                tossOrderId: input.orderId,
                method: input.method,
                payments: input.payments.map((p) => ({ tossPaymentId: p.tossPaymentId, sourceType: p.sourceType ?? null, amount: p.amount })),
            },
        });
    } catch (error) {
        console.error("[pos-charge] 감사 기록 실패(납부는 반영됨):", input.redact((error as Error).message), { paymentId: input.claimed.paymentId });
    }
}

/**
 * 멈춘 납부 기록 복구용 «임대» — 요청은 PAID(같은 토스 주문)인데 청구서가 아직 미납일 때 한 곳만 통과시킨다.
 * - PAID 로 바뀐 지 30초가 지나야(원래 처리가 아직 진행 중일 수 있는 틈은 건드리지 않는다)
 * - updatedAt 30초 임대(두 웹훅·스윕이 동시에 복구하지 않게 — 통과한 쪽이 updatedAt 을 지금으로 바꾼다)
 * - 취소가 걸린 요청은 제외, 청구서 금액·종류도 선점 때와 같은 조건
 */
const REPAIR_LEASE_SQL = `UPDATE "PosChargeRequest" r
      SET "updatedAt" = now()
    WHERE r.id = $1 AND r.status = 'PAID' AND r."cancelState" IS NULL AND r."tossOrderId" = $2
      AND COALESCE(r."paidRecordedAt", r."paidAt") < now() - interval '30 seconds'
      AND r."updatedAt" < now() - interval '30 seconds'
      AND EXISTS (SELECT 1 FROM "Payment" p
                   WHERE p.id = r."paymentId" AND p.status IN ('PENDING', 'OVERDUE')
                     AND p.amount = r.amount AND p.type IN ('MONTHLY', 'SHUTTLE'))
    RETURNING r.id, r."paymentId", r."shortCode"`;

/**
 * ALREADY_DONE 인데 청구서가 미납 → 원장부 기록을 다시 시도한다(멱등).
 * retry = true 면 웹훅을 처리 완료로 두지 않아 스윕이 다시 온다(아직 30초 안 · 기록 실패).
 */
async function repairLedgerPaid(input: {
    request: MatchRow;
    orderId: string;
    payments: ApprovedPayment[];
    paidAtIso: string | null;
    redact: (message: string) => string;
}): Promise<{ note: string; retry: boolean }> {
    const { request, orderId, payments, redact } = input;
    const leased = await prisma.$queryRawUnsafe<ClaimedRow[]>(REPAIR_LEASE_SQL, request.id, orderId);
    if (leased.length === 0) {
        // 못 빌림 = 아직 30초 안(원래 처리 중일 수 있음)·다른 곳이 복구 중·그 사이 청구서가 바뀜.
        // 시간 문제면 다시 오고, 아니면(청구 금액이 바뀌는 등) 사람에게 알린다.
        const why = await prisma.$queryRawUnsafe<{ tooSoon: boolean; paymentStatus: string | null }[]>(
            `SELECT (COALESCE(r."paidRecordedAt", r."paidAt") >= now() - interval '30 seconds'
                     OR r."updatedAt" >= now() - interval '30 seconds') AS "tooSoon",
                    p.status AS "paymentStatus"
               FROM "PosChargeRequest" r JOIN "Payment" p ON p.id = r."paymentId"
              WHERE r.id = $1`,
            request.id,
        );
        if (why[0]?.paymentStatus === "PAID") return { note: "다른 곳이 납부 기록을 마침", retry: false };
        if (why[0]?.tooSoon) return { note: "납부 기록 진행 중(잠시 뒤 스윕이 다시 확인)", retry: true };
        await notifyOnce(
            request.id,
            "slackNotifiedAt",
            `⚠️ 현장 결제 납부 기록 확인 필요 — ${describe(request)}\n결제는 확인됐지만 청구서가 미납 그대로이고 자동 복구 조건(금액·종류)이 맞지 않습니다. 관리자 수납 화면에서 확인해 주세요.`,
        );
        return { note: "납부 기록 복구 조건 불일치 → 원장 알림", retry: false };
    }
    const method = methodOf(payments.map((p) => String(p.sourceType ?? "")));
    try {
        await writeLedgerPaid({ claimed: leased[0], orderId, method, payment: payments[0], paidAtIso: input.paidAtIso });
    } catch (error) {
        console.error("[pos-charge] 납부 기록 복구 실패(스윕이 다시 시도):", redact((error as Error).message), { requestId: request.id });
        return { note: "납부 기록 복구 실패(스윕이 다시 시도)", retry: true };
    }
    await recordChargePaymentsAudit({ claimed: leased[0], orderId, method, payments, redact });
    if (await refundIfCancelledDuringLedger(leased[0], request)) return { note: "납부 기록 복구 중 POS 취소 확인 → 환불", retry: false };
    const split = payments.length > 1 ? ` · 분할 ${payments.length}건` : "";
    await notifyOnce(
        request.id,
        "slackNotifiedAt",
        `✅ 자동 납부 반영 — 현장 결제 ${describe(request)} (${posLabelOf(method)}${split})\n사이트 청구서를 납부완료로 바꿨습니다.`,
    );
    return { note: "멈췄던 납부 기록 복구", retry: false };
}

// ───────────────────────────── 결제 취소 확정(토스 웹훅 재조회로만) ─────────────────────────────

/** 이 요청으로 납부된 토스 결제 ID 전부(감사 기록 → note → 대표 결제) */
async function chargePaymentIdsFor(row: Pick<MatchRow, "paymentId" | "tossOrderId" | "tossPaymentId" | "note">): Promise<string[]> {
    let auditPaymentIds: string[] | null = null;
    try {
        const rows = await prisma.$queryRawUnsafe<{ ids: string[] | null }[]>(
            `SELECT CASE WHEN jsonb_typeof(metadata->'payments') = 'array'
                         THEN ARRAY(SELECT e->>'tossPaymentId' FROM jsonb_array_elements(metadata->'payments') e)
                    END AS ids
               FROM "PaymentAuditLog"
              WHERE "paymentId" = $1 AND action = 'POS_CHARGE_PAYMENTS' AND metadata->>'tossOrderId' = $2
              ORDER BY "createdAt" DESC
              LIMIT 1`,
            row.paymentId,
            row.tossOrderId,
        );
        auditPaymentIds = rows[0]?.ids ?? null;
    } catch (error) {
        console.error("[pos-charge] 결제 목록(감사 기록) 조회 실패 — note 로 대신:", String((error as Error).message).slice(0, 200));
    }
    return paymentIdsOf({ tossPaymentId: row.tossPaymentId, note: row.note, auditPaymentIds });
}

/** 환불 확정 표시 — 한 문장 조건부 UPDATE(동시에 두 웹훅이 와도 한 곳만) */
const MARK_REFUND_SQL = `UPDATE "PosChargeRequest"
      SET "cancelState" = 'DONE', "refundedAt" = COALESCE("refundedAt", now()), "updatedAt" = now()
    WHERE id = $1 AND status = 'PAID' AND "cancelState" IS DISTINCT FROM 'DONE'
    RETURNING id`;

/**
 * 자동 납부된 요청 1건 ↔ 토스 재조회 주문 → 취소 판정·반영. 할 일이 없으면 null.
 *   전부 취소 → (한 트랜잭션) 요청 DONE + 청구서 환불(원장부 refundPaidPaymentInTx) → 목록 갱신 → 슬랙 «환불 처리»
 *   일부 취소 → 요청 PARTIAL + note, 청구서는 그대로 → 슬랙 «확인 필요»
 * 여러 번 불려도 안전하다(조건부 UPDATE · 알림 표시 칸 선점).
 */
async function settleCancelForRow(row: MatchRow, order: unknown, orderId: string): Promise<{ note: string; retry: boolean } | null> {
    const ids = await chargePaymentIdsFor(row);
    const verdict = cancelVerdictOf({ paymentIds: ids, order });
    if (verdict.action === "NONE") return null;

    if (verdict.action === "PARTIAL") {
        const what = verdict.other.map((o) => `${o.id}:${o.state}`).join(", ");
        const text = `POS 결제 일부만 취소됨(취소 ${verdict.cancelled.length}/${ids.length}건${what ? ` · 그 밖 ${what}` : ""}) — 청구서는 그대로, 확인 필요`;
        await prisma.$executeRawUnsafe(
            `UPDATE "PosChargeRequest"
                SET "cancelState" = 'PARTIAL', note = left(COALESCE(note || ' / ', '') || $2, 1000), "updatedAt" = now()
              WHERE id = $1 AND status = 'PAID' AND "cancelState" IS DISTINCT FROM 'PARTIAL' AND "cancelState" IS DISTINCT FROM 'DONE'`,
            row.id,
            text.slice(0, 500),
        );
        await notifyOnce(
            row.id,
            "cancelNotifiedAt",
            `⚠️ POS 결제 일부만 취소됨 — 현장 결제 ${describe(row)}\n취소 ${verdict.cancelled.length}건 / 전체 ${ids.length}건. 사이트 청구서는 납부완료 그대로입니다. 남은 결제를 POS 에서 취소하거나 수납 화면에서 확인해 주세요.`,
        );
        return { note: `${row.shortCode} POS 일부 취소 → 확인 필요`, retry: false };
    }

    // 전부 취소 → 환불. 요청 표시와 청구서 환불을 한 트랜잭션으로(한쪽만 남지 않게).
    // 요청이 이미 DONE 이어도(재전송·앞선 처리) 청구가 PAID 면 다시 환불을 시도한다 — 조건부 UPDATE 라 몇 번이든 안전하고,
    // «요청 PAID → 청구서 기록» 틈에 취소가 먼저 와서 나중에 청구서가 PAID 로 써진 경우도 여기서 바로잡힌다(검수 P-1).
    const result = await prisma.$transaction(async (db) => {
        const marked = await db.$queryRawUnsafe<{ id: string }[]>(MARK_REFUND_SQL, row.id);
        const refunded = await refundPaidPaymentInTx(db, refundInput(row, orderId, verdict.cancelled));
        return { marked: marked.length > 0, refunded };
    });
    if (result.refunded) {
        revalidatePaymentCaches();
        await notifyOnce(row.id, "refundNotifiedAt", `↩️ POS 결제 취소 확인 — 현장 결제 ${describe(row)}\n사이트 청구서를 환불로 바꿨습니다.`);
        return { note: `${row.shortCode} POS 취소 → 환불 처리`, retry: false };
    }
    // 환불할 게 없었다 = 청구가 PAID 가 아니다. 지금 상태를 DB 에서 다시 읽고 실제 상태대로 알린다.
    const cur = await prisma.$queryRawUnsafe<{ paymentStatus: string | null; ledgerMayRun: boolean }[]>(
        `SELECT p.status AS "paymentStatus",
                (COALESCE(r."paidRecordedAt", r."paidAt") > now() - interval '2 minutes') AS "ledgerMayRun"
           FROM "PosChargeRequest" r JOIN "Payment" p ON p.id = r."paymentId"
          WHERE r.id = $1`,
        row.id,
    );
    const status = String(cur[0]?.paymentStatus ?? row.paymentStatus ?? "");
    if (["PENDING", "OVERDUE"].includes(status) && cur[0]?.ledgerMayRun) {
        // 납부 기록이 아직 진행 중일 수 있다 → 알림을 미루고 다시 본다(기록이 끝나면 그쪽이 환불하거나, 다음 스윕이 환불한다)
        return { note: `${row.shortCode} POS 취소 확인 · 납부 기록 진행 중이라 다시 확인`, retry: true };
    }
    const tail = ["PENDING", "OVERDUE"].includes(status)
        ? "\n납부 기록 전에 결제가 취소돼 사이트 청구는 미납 그대로입니다(돈은 POS 에서 돌려줌)."
        : status === "REFUNDED"
            ? "\n사이트 청구는 이미 환불 상태입니다."
            : `\n사이트 청구 상태가 ${status || "알 수 없음"}이라 그대로 두었습니다. 수납 화면에서 확인해 주세요.`;
    // 알림은 표시 칸으로 한 번만 — 앞선 처리가 알림 직전에 멈췄으면 여기서 이어서 보낸다.
    await notifyOnce(row.id, "refundNotifiedAt", `↩️ POS 결제 취소 확인 — 현장 결제 ${describe(row)}${tail}`);
    return { note: `${row.shortCode} ${result.marked ? "POS 취소 확인" : "이미 취소 확정됨"}(청구 ${status || "?"})`, retry: false };
}

/** 환불 감사 기록 입력(취소 확정·납부 직후 재확인 공용) */
function refundInput(row: Pick<MatchRow, "paymentId" | "shortCode">, orderId: string | null, cancelledPaymentIds: string[] | null) {
    return {
        paymentId: row.paymentId,
        actorType: "WEBHOOK" as const,
        actorId: `pos-charge:${row.shortCode}`,
        message: `현장 결제 ${row.shortCode} POS 결제 취소 확인 → 환불`,
        metadata: { provider: "TOSS_POS", shortCode: row.shortCode, tossOrderId: orderId, cancelledPaymentIds },
    };
}

/**
 * 원장부 납부 기록 «직후» 취소 상태 재확인(검수 P-1). 기록하는 사이에 취소 웹훅이 먼저 와서 요청을 DONE 으로 만들고
 * (그때는 청구가 아직 미납이라 환불할 게 없었다) 그 뒤 markPaymentPaid 가 청구를 PAID 로 써 버리면 돈이 어긋난다.
 * 요청이 DONE 이면 같은 원장부 함수로 바로 환불한다. 환불했으면 true(호출한 쪽은 «납부 반영» 알림을 보내지 않는다).
 */
async function refundIfCancelledDuringLedger(claimed: ClaimedRow, request: MatchRow): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ cancelState: string | null; tossOrderId: string | null }[]>(
        `SELECT "cancelState", "tossOrderId" FROM "PosChargeRequest" WHERE id = $1`,
        request.id,
    );
    if (rows[0]?.cancelState !== "DONE") return false;
    const refunded = await prisma.$transaction((db) =>
        refundPaidPaymentInTx(db, refundInput({ paymentId: claimed.paymentId, shortCode: claimed.shortCode }, rows[0].tossOrderId, null)),
    );
    if (refunded) revalidatePaymentCaches();
    await notifyOnce(
        request.id,
        "refundNotifiedAt",
        `↩️ POS 결제 취소 확인 — 현장 결제 ${describe(request)}\n${refunded ? "사이트 청구서를 환불로 바꿨습니다." : "사이트 청구는 환불 상태입니다."}`,
    );
    return true;
}

// ───────────────────────────── 관리자 «결제 취소» ─────────────────────────────

/** 관리자 화면 «결제 취소» 창 */
export type AdminChargeCancelView = {
    requestId: string;
    shortCode: string;
    amount: number;
    paidKst: string | null;
    studentName: string;
    itemLabel: string;
    paymentStatus: string;
    /** NULL = 취소 없음 · REQUESTED · SENT · FAILED · PARTIAL · DONE */
    cancelState: string | null;
    cancelReportMessage: string | null;
    refundedKst: string | null;
    /** 요청 뒤 90초가 지나도 POS 가 안 가져감 → «POS 에서 직접 취소» 안내 */
    pickupLate: boolean;
    /** POS 가 취소를 끝냈다고 보고함(토스 확인 대기) */
    reported: boolean;
    /** 보고 뒤 3분이 지나도 토스 확인이 안 옴 → «잠시 후 수납 화면에서 확인» 안내 */
    confirmLate: boolean;
    /** 지금 «결제 취소»를 누를 수 있나 + 못 하면 이유 */
    canRequest: boolean;
    blockReason: string;
};

function toCancelView(row: ViewRow): AdminChargeCancelView {
    const check = cancelCheck({
        request: { status: row.status, cancelState: row.cancelState ?? null },
        site: { status: row.paymentStatus, paidProvider: row.paidProvider ?? null },
    });
    const noOrder = !row.tossOrderId;
    return {
        requestId: row.id,
        shortCode: row.shortCode,
        amount: Number(row.amount),
        paidKst: row.paidKst,
        studentName: row.studentName,
        itemLabel: itemNameOf({ year: row.year, month: row.month, type: row.paymentType, maskedName: "" }),
        paymentStatus: row.paymentStatus,
        cancelState: row.cancelState ?? null,
        cancelReportMessage: row.cancelReportMessage ?? null,
        refundedKst: row.refundedKst ?? null,
        pickupLate: Boolean(row.cancelPickupLate),
        reported: Boolean(row.cancelReported),
        confirmLate: Boolean(row.cancelConfirmLate),
        canRequest: check.ok && !noOrder,
        blockReason: check.ok && noOrder ? "토스 주문 번호가 없어 POS 로 취소를 보낼 수 없습니다." : check.reason,
    };
}

/** 이 청구서를 납부시킨 현장 결제 요청(가장 최근 PAID). 청구서 id 로만 찾는다(요청 id 를 밖에서 받지 않음 — IDOR 방지). */
async function paidRequestRowFor(paymentId: string): Promise<ViewRow | null> {
    const id = String(paymentId ?? "").trim();
    if (!id || id.length > 100) return null;
    const rows = await loadView(
        `WHERE r."paymentId" = $1 AND r.status = 'PAID'
         ORDER BY r."paidAt" DESC NULLS LAST, r."createdAt" DESC
         LIMIT 1`,
        id,
    );
    return rows[0] ?? null;
}

/** 관리자 «결제 취소» 창: 지금 상태 */
export async function getChargeCancelForPayment(paymentId: string): Promise<AdminChargeCancelView | null> {
    const row = await paidRequestRowFor(paymentId);
    return row ? toCancelView(row) : null;
}

/**
 * 관리자 «결제 취소» — 요청에 «취소할 일»(REQUESTED)을 남긴다. 돈은 여기서 안 움직인다.
 * 실제 환불은 POS 가 취소한 뒤 토스 웹훅이 오면 settleCancelForRow 가 한다.
 * 조건은 UPDATE 한 문장 안에서 다시 확인한다(청구서 납부완료·토스 POS·같은 청구서).
 */
export async function requestChargeCancelByAdmin(input: { paymentId: string; adminUserId: string }): Promise<AdminChargeCancelView> {
    const row = await paidRequestRowFor(input.paymentId);
    if (!row) throw new ChargeRequestError("NOT_FOUND", "현장 결제로 납부된 기록을 찾지 못했습니다.");
    const view = toCancelView(row);
    if (!view.canRequest) throw new ChargeRequestError("NOT_ELIGIBLE", view.blockReason || "결제 취소를 보낼 수 없습니다.");
    const updated = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosChargeRequest" r
            SET "cancelState" = 'REQUESTED', "cancelRequestedAt" = now(), "cancelRequestedBy" = $2,
                "cancelClaimedAt" = NULL, "cancelClaimedByTokenId" = NULL,
                "cancelReportedAt" = NULL, "cancelReportMessage" = NULL, "updatedAt" = now()
          WHERE r.id = $1 AND r."paymentId" = $3 AND r.status = 'PAID' AND r."tossOrderId" IS NOT NULL
            AND (r."cancelState" IS NULL OR r."cancelState" IN ('FAILED', 'PARTIAL'))
            AND EXISTS (SELECT 1 FROM "Payment" p
                         WHERE p.id = r."paymentId" AND p.status = 'PAID' AND p."paidProvider" = 'TOSS_POS')
          RETURNING r.id`,
        row.id,
        input.adminUserId,
        row.paymentId,
    );
    if (updated.length === 0) throw new ChargeRequestError("CHANGED", "그 사이 상태가 바뀌었습니다. 창을 닫고 다시 열어 주세요.");
    await recordPaymentAudit({
        paymentId: row.paymentId,
        actorType: "ADMIN",
        actorId: input.adminUserId,
        action: "POS_CHARGE_CANCEL_REQUESTED",
        message: `현장 결제 ${row.shortCode} POS 결제 취소 요청 (${formatChargeWon(row.amount)})`,
        metadata: { requestId: row.id, shortCode: row.shortCode, previousCancelState: row.cancelState ?? null },
    }).catch((e) => console.error("[pos-charge] 감사기록 실패:", String((e as Error).message).slice(0, 200)));
    const after = await paidRequestRowFor(row.paymentId);
    return toCancelView(after ?? row);
}

// ───────────────────────────── 플러그인: 취소할 일 ─────────────────────────────

/** 롱폴링 응답의 «취소할 일» 1건(이름 가림 · 결제 ID 는 선점 응답에서만 준다) */
export type PluginCancelJobView = {
    id: string;
    shortCode: string;
    amount: number;
    studentName: string;
    itemName: string;
    cancelState: string;
};

/** 플러그인이 «취소할 일»을 선점했을 때 받는 값 — 취소할 토스 주문·결제 ID 는 서버 DB 값만 */
export type PluginCancelClaimView = PluginCancelJobView & { tossOrderId: string; tossPaymentIds: string[] };

function toCancelJobView(row: ViewRow): PluginCancelJobView {
    const masked = maskStudentName(row.studentName);
    return {
        id: row.id,
        shortCode: row.shortCode,
        amount: Number(row.amount),
        studentName: masked,
        itemName: itemNameOf({ year: row.year, month: row.month, type: row.paymentType, maskedName: masked }),
        cancelState: String(row.cancelState ?? ""),
    };
}

/**
 * 취소할 일 목록 — 새 요청(REQUESTED) + 가져간 뒤 보고 없이 2분이 지난 것(플러그인이 중간에 꺼짐 → 다시 맡긴다).
 * 다시 맡겨도 안전하다: 플러그인은 결제마다 상태를 먼저 확인해 이미 취소된 건은 건너뛴다.
 */
export async function listCancelJobsForPlugin(): Promise<PluginCancelJobView[]> {
    const rows = await loadView(
        `WHERE r.status = 'PAID' AND r."tossOrderId" IS NOT NULL
           AND (r."cancelState" = 'REQUESTED'
                OR (r."cancelState" = 'SENT' AND r."cancelReportedAt" IS NULL AND r."cancelClaimedAt" < now() - interval '2 minutes'))
         ORDER BY r."cancelRequestedAt" ASC NULLS LAST
         LIMIT 20`,
    );
    return rows.map(toCancelJobView);
}

/**
 * 롱폴링 대기 중 «모르는 새 취소 요청»이 있나(가벼운 EXISTS). 요청 뒤 CANCEL_PICKUP_TIMEOUT_SEC 안의 것만 깨운다 —
 * 오래된 것까지 깨우면 그 일을 못 하는 기기가 1초마다 다시 묻게 된다(요청 한도). 오래된 것은 평소 응답에 실린다.
 */
export async function hasUnknownCancelJob(knownIds: string[]): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ found: boolean }[]>(
        `SELECT EXISTS (
            SELECT 1 FROM "PosChargeRequest"
             WHERE "cancelState" = 'REQUESTED' AND "cancelRequestedAt" > now() - interval '${CANCEL_PICKUP_TIMEOUT_SEC} seconds'
               AND NOT (id = ANY($1::text[]))
         ) AS found`,
        knownIds,
    );
    return Boolean(rows[0]?.found);
}

/** 취소할 일 선점(REQUESTED → SENT). 같은 토큰의 재시도·2분 넘게 보고 없는 것은 다시 가져갈 수 있다. */
export async function claimCancelForPlugin(requestId: string, tokenId: string): Promise<PluginCancelClaimView> {
    const id = String(requestId ?? "").trim();
    if (!/^[0-9a-f-]{10,64}$/i.test(id)) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const claimed = await prisma.$queryRawUnsafe<{ id: string }[]>(
        `UPDATE "PosChargeRequest" r
            SET "cancelState" = 'SENT', "cancelClaimedAt" = now(), "cancelClaimedByTokenId" = $2, "updatedAt" = now()
          WHERE r.id = $1 AND r.status = 'PAID' AND r."tossOrderId" IS NOT NULL
            AND (r."cancelState" = 'REQUESTED'
                 OR (r."cancelState" = 'SENT' AND r."cancelReportedAt" IS NULL
                     AND (r."cancelClaimedByTokenId" = $2 OR r."cancelClaimedAt" < now() - interval '2 minutes')))
          RETURNING r.id`,
        id,
        tokenId,
    );
    if (claimed.length === 0) throw new ChargeRequestError("NOT_CLAIMABLE", "이미 다른 POS 가 가져갔거나, 취소할 일이 없는 요청입니다.");
    const rows = await loadView(`WHERE r.id = $1`, id);
    const row = rows[0];
    if (!row || !row.tossOrderId) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const tossPaymentIds = await chargePaymentIdsFor({ paymentId: row.paymentId, tossOrderId: row.tossOrderId, tossPaymentId: row.tossPaymentId, note: row.note });
    return { ...toCancelJobView(row), tossOrderId: row.tossOrderId, tossPaymentIds };
}

export const PLUGIN_CANCEL_RESULTS = ["DONE", "FAILED"] as const;
export type PluginCancelResult = (typeof PLUGIN_CANCEL_RESULTS)[number];

/** 플러그인 취소 결과 글자 → 저장 값(done·failed, 대소문자 무관). 모르는 값이면 null(400). */
export function normalizePluginCancelResult(value: unknown): PluginCancelResult | null {
    const raw = String(value ?? "").trim().toUpperCase();
    return (PLUGIN_CANCEL_RESULTS as readonly string[]).includes(raw) ? (raw as PluginCancelResult) : null;
}

/**
 * 플러그인 취소 결과 보고 — **기록만**(환불 확정은 토스 웹훅으로만). 선점한 토큰만 보고할 수 있다.
 * FAILED 면 상태를 FAILED 로(사이트 창이 «POS 에서 직접 취소해 주세요» 안내 · 다시 요청 가능). 이미 DONE 이면 그대로.
 */
export async function reportCancelFromPlugin(input: {
    requestId: string;
    tokenId: string;
    result: PluginCancelResult;
    message?: string | null;
}): Promise<{ cancelState: string; refunded: boolean }> {
    const id = String(input.requestId ?? "").trim();
    if (!/^[0-9a-f-]{10,64}$/i.test(id)) throw new ChargeRequestError("NOT_FOUND", "요청을 찾지 못했습니다.");
    const message = input.message ? String(input.message).slice(0, 300) : null;
    const rows = await prisma.$queryRawUnsafe<{ cancelState: string | null }[]>(
        `UPDATE "PosChargeRequest"
            SET "cancelReportedAt" = now(), "cancelReportMessage" = $3,
                "cancelState" = CASE WHEN $2::text = 'FAILED' AND "cancelState" IN ('REQUESTED', 'SENT') THEN 'FAILED' ELSE "cancelState" END,
                "updatedAt" = now()
          WHERE id = $1 AND "cancelClaimedByTokenId" = $4 AND "cancelState" IS NOT NULL
          RETURNING "cancelState"`,
        id,
        input.result,
        message,
        input.tokenId,
    );
    if (!rows[0]) throw new ChargeRequestError("NOT_CLAIMABLE", "이 POS 가 가져간 취소 요청이 아닙니다.");
    const state = String(rows[0].cancelState ?? "");
    return { cancelState: state, refunded: state === "DONE" };
}
