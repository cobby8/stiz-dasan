/**
 * 체험비 결제 장부 — DB 를 인자로 받는 연결부(prisma import 없음 → 테스트가 가짜 DB 로 실제 실행한다).
 *
 * 표: TrialFeePayment(주문 1건 = 행 1개) + TrialLead 의 요약 칸(trialFeePaymentStatus·trialFeePaidAt).
 * 이중 확정 방지는 세 겹이다.
 *   ① 승인 전: 신청 행을 FOR UPDATE 로 잠그고 «이미 결제됨»이면 토스 승인을 부르지 않는다(claimTrialFeeConfirmInTx)
 *   ② 반영 시: 결제 행 상태를 조건부 UPDATE(…WHERE status IN (…) RETURNING) — 같은 결제가 두 번 와도 한 번만 바뀐다
 *   ③ DB: 신청당 DONE 결제 1건만(부분 유일 인덱스, 마이그레이션 20261110150000)
 *   그래도 다른 결제가 먼저 확정돼 있으면(계좌 입금 확인 뒤 무통장 입금 등) 이번 결제를 NEEDS_REFUND 로 남겨 원장이 환불한다.
 */

import { markTrialFeePaidOnlineInTx, markTrialFeeRefundedInTx, type TrialFeeAuditActor } from "@/lib/trial-fee-confirmation";
import {
    TRIAL_ORDER_REUSE_MINUTES,
    decideTrialFeeConfirm,
    type TrialConfirmDecision,
} from "@/lib/trial-fee/trialFeeRules";

export type TrialFeeDb = {
    $queryRawUnsafe<T>(query: string, ...values: unknown[]): Promise<T>;
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

export type TrialFeeLeadRow = {
    id: string;
    childName: string;
    parentName: string | null;
    parentPhone: string | null;
    status: string;
    trialDate: Date | string | null;
    preferredDay: string | null;
    preferredPeriod: string | null;
    preferredSlotKey: string | null;
    scheduledDate: Date | string | null;
    scheduledClassId: string | null;
    trialFeeConfirmed: boolean | null;
    trialFeePaymentStatus: string | null;
    trialFeePaidAt: Date | string | null;
};

export type TrialFeePaymentRow = {
    id: string;
    /** 신청을 지우면 NULL(돈 기록은 남긴다 — FK ON DELETE SET NULL) */
    trialLeadId: string | null;
    orderId: string;
    paymentKey: string | null;
    amount: number;
    taxFreeAmount: number;
    status: string;
    method: string | null;
    receiptUrl: string | null;
    rawResponse: unknown;
    confirmStartedAt: Date | string | null;
    createdAt?: Date | string | null;
};

/** 신청 행에서 결제 화면·판정에 필요한 칸만(토큰 해시는 SELECT 하지 않는다) */
const LEAD_COLUMNS = `id, "childName", "parentName", "parentPhone", status, "trialDate", "preferredDay", "preferredPeriod",
    "preferredSlotKey", "scheduledDate", "scheduledClassId", "trialFeeConfirmed", "trialFeePaymentStatus", "trialFeePaidAt"`;

/** 결제 링크 토큰(해시)으로 신청을 찾는다. 해시가 맞는 행만 — 신청 id 로는 찾지 않는다(IDOR 차단). */
export async function findTrialLeadByTokenHash(db: TrialFeeDb, tokenHash: string): Promise<TrialFeeLeadRow | null> {
    const rows = await db.$queryRawUnsafe<TrialFeeLeadRow[]>(
        `SELECT ${LEAD_COLUMNS} FROM "TrialLead" WHERE "paymentTokenHash" = $1 LIMIT 1`,
        tokenHash,
    );
    return rows[0] ?? null;
}

/** 이 신청의 가장 최근 결제 행(화면에 «입금 대기 계좌»를 다시 보여 줄 때) */
export async function latestTrialFeePayment(db: TrialFeeDb, trialLeadId: string): Promise<TrialFeePaymentRow | null> {
    const rows = await db.$queryRawUnsafe<TrialFeePaymentRow[]>(
        `SELECT * FROM "TrialFeePayment" WHERE "trialLeadId" = $1 ORDER BY "createdAt" DESC LIMIT 1`,
        trialLeadId,
    );
    return rows[0] ?? null;
}

/** 주문번호 + 신청(토큰으로 찾은 것) 둘 다 맞는 결제 행 — 남의 주문번호를 넣어도 못 찾는다 */
export async function findTrialFeePaymentForLead(db: TrialFeeDb, orderId: string, trialLeadId: string): Promise<TrialFeePaymentRow | null> {
    const rows = await db.$queryRawUnsafe<TrialFeePaymentRow[]>(
        `SELECT * FROM "TrialFeePayment" WHERE "orderId" = $1 AND "trialLeadId" = $2 LIMIT 1`,
        orderId,
        trialLeadId,
    );
    return rows[0] ?? null;
}

export type ReserveResult =
    | { kind: "ORDER"; row: TrialFeePaymentRow; reused: boolean }
    | { kind: "ALREADY_PAID" }
    | { kind: "OPEN_DEPOSIT"; row: TrialFeePaymentRow };

/**
 * 결제 시작 — 신청을 잠그고(동시 두 탭) 다시 확인한 뒤 주문을 만든다(30분 안 같은 금액 READY 주문은 다시 쓴다).
 * 기한 안의 무통장입금 계좌가 있으면 새 주문 대신 그 계좌를 돌려준다(계좌 두 개 = 이중 입금 방지).
 * openDepositExpired: 부르는 쪽이 저장된 계좌 기한을 보고 판정해 넘긴다(시각 계산은 여기서 하지 않는다).
 */
export async function reserveTrialFeeOrderInTx(
    tx: TrialFeeDb,
    input: {
        trialLeadId: string;
        amount: number;
        taxFreeAmount: number;
        newOrderId: string;
        isDepositExpired: (row: TrialFeePaymentRow) => boolean;
    },
): Promise<ReserveResult> {
    const leads = await tx.$queryRawUnsafe<Array<{ trialFeeConfirmed: boolean | null; trialFeePaymentStatus: string | null }>>(
        `SELECT "trialFeeConfirmed", "trialFeePaymentStatus" FROM "TrialLead" WHERE id = $1 FOR UPDATE`,
        input.trialLeadId,
    );
    const lead = leads[0];
    if (!lead || lead.trialFeeConfirmed || lead.trialFeePaymentStatus === "PAID") return { kind: "ALREADY_PAID" };

    const waiting = await tx.$queryRawUnsafe<TrialFeePaymentRow[]>(
        `SELECT * FROM "TrialFeePayment" WHERE "trialLeadId" = $1 AND status = 'WAITING_FOR_DEPOSIT' ORDER BY "createdAt" DESC LIMIT 1`,
        input.trialLeadId,
    );
    if (waiting[0]) {
        if (!input.isDepositExpired(waiting[0])) return { kind: "OPEN_DEPOSIT", row: waiting[0] };
        // 기한이 지난 계좌는 닫고(입금 불가) 새 주문을 연다
        await releaseTrialVirtualAccountInTx(tx, { paymentRowId: waiting[0].id, trialLeadId: input.trialLeadId, status: "EXPIRED" });
    }

    const reusable = await tx.$queryRawUnsafe<TrialFeePaymentRow[]>(
        `SELECT * FROM "TrialFeePayment"
         WHERE "trialLeadId" = $1 AND amount = $2 AND status = 'READY' AND "confirmStartedAt" IS NULL
           AND "createdAt" > NOW() - INTERVAL '${TRIAL_ORDER_REUSE_MINUTES} minutes'
         ORDER BY "createdAt" DESC LIMIT 1`,
        input.trialLeadId,
        input.amount,
    );
    if (reusable[0]) return { kind: "ORDER", row: reusable[0], reused: true };

    const inserted = await tx.$queryRawUnsafe<TrialFeePaymentRow[]>(
        `INSERT INTO "TrialFeePayment" (
            id, "trialLeadId", "orderId", amount, "taxFreeAmount", status, "createdAt", "updatedAt"
        ) VALUES (gen_random_uuid()::text, $1, $2, $3, $4, 'READY', NOW(), NOW())
        RETURNING *`,
        input.trialLeadId,
        input.newOrderId,
        input.amount,
        input.taxFreeAmount,
    );
    return { kind: "ORDER", row: inserted[0], reused: false };
}

/**
 * 토스 승인 «직전» — 신청·주문을 잠그고 다시 판정한 뒤 «승인 진행 중» 시각을 찍는다.
 * PROCEED 가 아니면 토스 승인을 부르지 않는다(결제창 인증은 토스에서 자동 소멸 — 돈이 나가지 않는다).
 */
export async function claimTrialFeeConfirmInTx(
    tx: TrialFeeDb,
    input: { paymentRowId: string; trialLeadId: string; paymentKey: string; amount: number; nowMs: number },
): Promise<TrialConfirmDecision> {
    const leads = await tx.$queryRawUnsafe<Array<{ trialFeeConfirmed: boolean | null; trialFeePaymentStatus: string | null }>>(
        `SELECT "trialFeeConfirmed", "trialFeePaymentStatus" FROM "TrialLead" WHERE id = $1 FOR UPDATE`,
        input.trialLeadId,
    );
    const rows = await tx.$queryRawUnsafe<TrialFeePaymentRow[]>(
        `SELECT * FROM "TrialFeePayment" WHERE id = $1 AND "trialLeadId" = $2 FOR UPDATE`,
        input.paymentRowId,
        input.trialLeadId,
    );
    const row = rows[0];
    if (!row || !leads[0]) return { kind: "REJECT", reason: "ORDER_CLOSED" };
    // 같은 신청의 다른 주문이 진행 중인가 — 입금 대기 계좌, 또는 10분 안에 승인을 시작한 주문(동시 두 결제 방지)
    const others = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "TrialFeePayment"
         WHERE "trialLeadId" = $1 AND id <> $2
           AND (status = 'WAITING_FOR_DEPOSIT'
                OR (status = 'READY' AND "confirmStartedAt" > NOW() - INTERVAL '10 minutes'))
         LIMIT 1`,
        input.trialLeadId,
        input.paymentRowId,
    );
    const startedMs = row.confirmStartedAt ? new Date(row.confirmStartedAt).getTime() : null;
    const decision = decideTrialFeeConfirm({
        stored: { amount: Number(row.amount), status: row.status, paymentKey: row.paymentKey, confirmStartedAtMs: startedMs },
        request: { paymentKey: input.paymentKey, amount: input.amount },
        leadAlreadyPaid: Boolean(leads[0].trialFeeConfirmed) || leads[0].trialFeePaymentStatus === "PAID",
        otherOrderInProgress: others.length > 0,
        nowMs: input.nowMs,
    });
    if (decision.kind === "PROCEED") {
        await tx.$executeRawUnsafe(
            `UPDATE "TrialFeePayment" SET "confirmStartedAt" = NOW(), "paymentKey" = $2, "updatedAt" = NOW() WHERE id = $1`,
            row.id,
            input.paymentKey,
        );
    }
    return decision;
}

export type FinalizeResult =
    | { kind: "PAID" } // 이번에 확정됨(체험 안내 대상)
    | { kind: "ALREADY" } // 같은 결제가 이미 반영됨(새로고침·웹훅 중복)
    | { kind: "DUPLICATE" } // 신청이 다른 결제로 이미 확정됨 → 이번 결제 NEEDS_REFUND(원장 환불)
    | { kind: "CANCELED_ORDER" } // 우리가 취소로 닫은 주문인데 토스는 결제 완료 — 자동 반영하지 않고 원장 확인
    | { kind: "NOT_FOUND" };

/** 토스로 «결제 완료»가 확인된 주문을 장부에 반영한다(트랜잭션 안). 확인은 부르는 쪽이 토스 응답·재조회로 끝낸 뒤. */
export async function finalizeTrialFeePaidInTx(
    tx: TrialFeeDb,
    input: {
        paymentRowId: string;
        trialLeadId: string;
        paymentKey: string;
        method: string | null;
        receiptUrl: string | null;
        approvedAt: string | null;
        rawResponse: unknown;
    },
): Promise<FinalizeResult> {
    // 신청을 먼저 잠근다(다른 결제의 확정·관리자 입금 확인과 순서를 정한다)
    const leads = await tx.$queryRawUnsafe<Array<{ trialFeeConfirmed: boolean | null }>>(
        `SELECT "trialFeeConfirmed" FROM "TrialLead" WHERE id = $1 FOR UPDATE`,
        input.trialLeadId,
    );
    if (!leads[0]) return { kind: "NOT_FOUND" };
    const rows = await tx.$queryRawUnsafe<TrialFeePaymentRow[]>(
        `SELECT * FROM "TrialFeePayment" WHERE id = $1 AND "trialLeadId" = $2 FOR UPDATE`,
        input.paymentRowId,
        input.trialLeadId,
    );
    const row = rows[0];
    if (!row) return { kind: "NOT_FOUND" };
    if (row.status === "DONE" || row.status === "NEEDS_REFUND") return { kind: "ALREADY" };
    if (row.status === "CANCELED") return { kind: "CANCELED_ORDER" };

    const otherDone = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "TrialFeePayment" WHERE "trialLeadId" = $1 AND status = 'DONE' AND id <> $2 LIMIT 1`,
        input.trialLeadId,
        input.paymentRowId,
    );
    const alreadyConfirmed = Boolean(leads[0].trialFeeConfirmed) || otherDone.length > 0;
    const nextStatus = alreadyConfirmed ? "NEEDS_REFUND" : "DONE";
    const updated = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "TrialFeePayment"
         SET status = $2, "paymentKey" = $3, method = COALESCE($4, method), "receiptUrl" = COALESCE($5, "receiptUrl"),
             "approvedAt" = COALESCE($6::timestamptz, NOW()), "rawResponse" = $7::jsonb,
             "failureCode" = NULL, "failureMessage" = NULL, "updatedAt" = NOW()
         WHERE id = $1 AND status IN ('READY', 'WAITING_FOR_DEPOSIT', 'FAILED', 'EXPIRED')
         RETURNING id`,
        row.id,
        nextStatus,
        input.paymentKey,
        input.method,
        input.receiptUrl,
        input.approvedAt,
        JSON.stringify(input.rawResponse ?? null),
    );
    if (updated.length === 0) return { kind: "ALREADY" };
    if (alreadyConfirmed) {
        // 계좌 입금 확인 뒤 들어온 결제처럼 신청 요약이 «온라인 결제 완료»가 아니면 «이중 결제(환불 필요)»로 표시해
        // 관리자 목록에 환불 버튼이 보이게 한다(온라인 결제 완료 신청은 요약을 그대로 둔다 — 환불 버튼은 이미 보인다)
        await tx.$executeRawUnsafe(
            `UPDATE "TrialLead" SET "trialFeePaymentStatus" = 'NEEDS_REFUND', "updatedAt" = NOW()
             WHERE id = $1 AND "trialFeePaymentStatus" IS DISTINCT FROM 'PAID'`,
            input.trialLeadId,
        );
        return { kind: "DUPLICATE" };
    }

    const methodLabel = input.method ? `(${input.method})` : "";
    const marked = await markTrialFeePaidOnlineInTx(tx, input.trialLeadId, `체험비 온라인 결제 완료${methodLabel}`);
    // 위에서 잠근 신청이 미확정이었으니 여기서 바뀌어야 한다 — 아니면 장부가 어긋난 것이라 전부 되돌린다
    if (!marked.changed) throw new Error("TRIAL_FEE_LEDGER_CONFLICT");
    return { kind: "PAID" };
}

/** 무통장입금 계좌 발급(승인 응답 WAITING_FOR_DEPOSIT) — 결제 행·신청 요약만 «입금 대기»로. 신청은 아직 미확정. */
export async function recordTrialVirtualAccountIssuedInTx(
    tx: TrialFeeDb,
    input: { paymentRowId: string; trialLeadId: string; paymentKey: string; method: string | null; rawResponse: unknown },
): Promise<boolean> {
    const updated = await tx.$executeRawUnsafe(
        `UPDATE "TrialFeePayment"
         SET status = 'WAITING_FOR_DEPOSIT', "paymentKey" = $2, method = COALESCE($3, method), "rawResponse" = $4::jsonb,
             "failureCode" = NULL, "failureMessage" = NULL, "updatedAt" = NOW()
         WHERE id = $1 AND status IN ('READY', 'FAILED')`,
        input.paymentRowId,
        input.paymentKey,
        input.method,
        JSON.stringify(input.rawResponse ?? null),
    );
    if (updated !== 1) return false;
    await tx.$executeRawUnsafe(
        `UPDATE "TrialLead" SET "trialFeePaymentStatus" = 'WAITING_FOR_DEPOSIT', "updatedAt" = NOW()
         WHERE id = $1 AND COALESCE("trialFeeConfirmed", false) = false`,
        input.trialLeadId,
    );
    return true;
}

/** 입금 전 계좌 닫힘(기한 지남·취소) — 결제 행을 닫고 신청 요약의 «입금 대기»를 지운다 */
export async function releaseTrialVirtualAccountInTx(
    tx: TrialFeeDb,
    input: { paymentRowId: string; trialLeadId: string; status: "EXPIRED" | "CANCELED" },
): Promise<boolean> {
    const updated = await tx.$executeRawUnsafe(
        `UPDATE "TrialFeePayment" SET status = $2, "updatedAt" = NOW() WHERE id = $1 AND status = 'WAITING_FOR_DEPOSIT'`,
        input.paymentRowId,
        input.status,
    );
    if (updated !== 1) return false;
    await tx.$executeRawUnsafe(
        `UPDATE "TrialLead" SET "trialFeePaymentStatus" = NULL, "updatedAt" = NOW()
         WHERE id = $1 AND "trialFeePaymentStatus" = 'WAITING_FOR_DEPOSIT'`,
        input.trialLeadId,
    );
    return true;
}

/**
 * 토스에서 «전액 취소»가 확인된 결제를 반영한다(관리자 환불·상점관리자 취소 웹훅 공용, 멱등).
 * 확정 결제(DONE)였으면 신청을 «환불 완료»로, 이중 결제(NEEDS_REFUND)였으면 결제 행만 닫는다.
 */
export async function applyTrialFeeFullCancelInTx(
    tx: TrialFeeDb,
    input: { paymentRowId: string; trialLeadId: string; rawResponse: unknown; actor: TrialFeeAuditActor },
): Promise<{ changed: boolean; leadRefunded: boolean }> {
    const rows = await tx.$queryRawUnsafe<Array<{ status: string }>>(
        `SELECT status FROM "TrialFeePayment" WHERE id = $1 AND "trialLeadId" = $2 FOR UPDATE`,
        input.paymentRowId,
        input.trialLeadId,
    );
    const before = rows[0]?.status;
    if (before !== "DONE" && before !== "NEEDS_REFUND") return { changed: false, leadRefunded: false };
    await tx.$executeRawUnsafe(
        `UPDATE "TrialFeePayment" SET status = 'CANCELED', "canceledAt" = NOW(), "rawResponse" = $2::jsonb, "updatedAt" = NOW()
         WHERE id = $1 AND status IN ('DONE', 'NEEDS_REFUND')`,
        input.paymentRowId,
        JSON.stringify(input.rawResponse ?? null),
    );
    if (before !== "DONE") {
        // 이중 결제를 돌려줬다 — «환불 필요» 표시만 지운다(확정은 다른 결제 그대로)
        await tx.$executeRawUnsafe(
            `UPDATE "TrialLead" SET "trialFeePaymentStatus" = NULL, "updatedAt" = NOW()
             WHERE id = $1 AND "trialFeePaymentStatus" = 'NEEDS_REFUND'`,
            input.trialLeadId,
        );
        return { changed: true, leadRefunded: false };
    }
    const refunded = await markTrialFeeRefundedInTx(tx, input.trialLeadId, input.actor);
    return { changed: true, leadRefunded: refunded.changed };
}

/** 승인 실패(재시도 불가) 기록 — 다음 결제 시도가 새 주문을 만들 수 있게 READY 를 닫는다 */
export async function markTrialFeeFailed(
    db: TrialFeeDb,
    input: { paymentRowId: string; code: string; message: string; retryable: boolean },
): Promise<void> {
    await db.$executeRawUnsafe(
        `UPDATE "TrialFeePayment"
         SET status = CASE WHEN $4::boolean THEN status ELSE 'FAILED' END,
             "confirmStartedAt" = CASE WHEN $4::boolean THEN "confirmStartedAt" ELSE NULL END,
             "failureCode" = $2, "failureMessage" = $3, "updatedAt" = NOW()
         WHERE id = $1 AND status = 'READY'`,
        input.paymentRowId,
        input.code.slice(0, 100),
        input.message.slice(0, 300),
        input.retryable,
    );
}
