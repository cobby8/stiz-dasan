"use server";

import { requireAdmin } from "@/lib/auth-guard";
import { prisma } from "@/lib/prisma";
import {
    ensurePaymentInfrastructure,
    refundPaidPaymentInTx,
    refundTossPaymentByAdmin,
    revalidatePaymentCaches,
} from "@/lib/payment-ledger";
import { txCoversPaymentSql } from "@/lib/payments/bundleLedger";
import {
    ChargeRequestError,
    getChargeCancelForPayment,
    requestChargeCancelByAdmin,
    type AdminChargeCancelView,
} from "@/lib/pos/chargeRequestService";
import {
    MAX_BULK_REFUND,
    planBulkRefund,
    summarizeBulkRefund,
    type BulkRefundBlock,
    type BulkRefundOutcome,
    type BulkRefundRow,
} from "@/lib/payments/bulkRefund";

/**
 * 관리자 수납 목록 «선택 항목 환불»(2026-11-09 원장 지시 «체크했을 때 이미 결제된 건은 선택 항목 환불로»).
 *
 * 새 결제 로직을 만들지 않고, ⚡ 메뉴 한 건 처리와 같은 길을 갈래별로 부른다:
 *   - 토스 온라인   → refundTossPaymentByAdmin(토스 취소 API → 재조회 → applyVerifiedTossFullCancel, 웹훅과 같은 반영)
 *   - 토스 POS     → requestChargeCancelByAdmin(⚡ «결제 취소»와 같은 함수 — POS 가 취소한 뒤 토스 확인으로 환불)
 *   - 현금·계좌이체 → refundPaidPaymentInTx(장부만 환불, 조건부 UPDATE status='PAID' + 감사 기록)
 * 판정(갈래·묶음 일부 선택 막기)은 순수 planBulkRefund 한 곳. 막을 것이 하나라도 있으면 아무것도 실행하지 않는다.
 * Server Action 은 브라우저에서 직접 부를 수 있으므로 첫 줄에서 원장 권한을 다시 확인한다.
 */

export type BulkRefundActionResult =
    | { ok: true; summary: string; outcomes: BulkRefundOutcome[] }
    | { ok: false; message: string; blocks?: BulkRefundBlock[] };

async function requireFinanceOwner() {
    const admin = await requireAdmin();
    // ⚡ 환불·결제 취소와 같은 재무 권한(원장 ADMIN)
    if (admin.appUserRole !== "ADMIN") throw new Error("수퍼관리자 권한이 필요합니다.");
    return admin;
}

/** 서버가 고른 청구를 DB 에서 다시 읽는다 — 상태·결제 길·묶음(토스 주문 / POS 결제) */
async function loadRows(paymentIds: string[]): Promise<BulkRefundRow[]> {
    const base = await prisma.$queryRawUnsafe<Array<{
        id: string; status: string; paidProvider: string | null; txId: string | null; txPaymentIds: string[] | null;
    }>>(
        // 토스 온라인: 이 청구를 품은(대표든 항목이든) 완료 토스 거래 중 이 청구를 실제로 납부시킨 주문(providerOrderId)
        `SELECT p.id, p.status, p."paidProvider", t.id AS "txId",
                CASE WHEN t.id IS NULL THEN NULL ELSE COALESCE(
                    (SELECT array_agg(it."paymentId" ORDER BY it.position) FROM "PaymentTransactionItem" it WHERE it."transactionId" = t.id),
                    ARRAY[t."paymentId"]) END AS "txPaymentIds"
           FROM "Payment" p
           LEFT JOIN LATERAL (
                SELECT t.id, t."paymentId" FROM "PaymentTransaction" t
                 WHERE ${txCoversPaymentSql("t", "p.id")}
                   AND t.provider = 'TOSS' AND t.status = 'DONE' AND t."orderId" = p."providerOrderId"
                 ORDER BY t."createdAt" DESC
                 LIMIT 1
           ) t ON true
          WHERE p.id = ANY($1::text[])`,
        paymentIds,
    );

    // 토스 POS: ⚡ «결제 취소» 창과 같은 조회로 묶음(같이 취소될 청구)을 안다. 같은 요청은 한 번만 읽는다.
    const posByPayment = new Map<string, AdminChargeCancelView | null>();
    for (const row of base) {
        if (row.status !== "PAID" || row.paidProvider !== "TOSS_POS" || posByPayment.has(row.id)) continue;
        const view = await getChargeCancelForPayment(row.id);
        posByPayment.set(row.id, view);
        if (view) {
            // 같은 묶음의 다른 청구는 다시 조회하지 않는다
            for (const item of view.items) if (!posByPayment.has(item.paymentId)) posByPayment.set(item.paymentId, view);
        }
    }

    const rows = base.map((row): BulkRefundRow => {
        const view = posByPayment.get(row.id) ?? null;
        return {
            paymentId: row.id,
            status: row.status,
            paidProvider: row.paidProvider,
            tossTxId: row.txId,
            tossTxPaymentIds: (row.txPaymentIds ?? []).filter((id): id is string => typeof id === "string"),
            posRequestId: view?.requestId ?? null,
            posPaymentIds: view ? view.items.map((item) => item.paymentId) : [],
        };
    });
    return rows;
}

/** 고른 청구 id(브라우저 값) → 문자열 배열. 모양이 이상하면 빈 배열(규칙이 «고른 청구가 없어요»로 막는다) */
function idsOf(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    // 건수 상한은 규칙(planBulkRefund)이 «한 번에 N건까지»로 막는다. 아주 큰 배열은 DB 를 부르기 전에 자른다.
    if (value.length > MAX_BULK_REFUND) return value.slice(0, MAX_BULK_REFUND + 1).map(String);
    if (value.some((v) => typeof v !== "string" || v.trim() === "")) return [];
    return value as string[];
}

export async function refundSelectedPayments(paymentIds: string[]): Promise<BulkRefundActionResult> {
    let admin: Awaited<ReturnType<typeof requireFinanceOwner>>;
    try {
        admin = await requireFinanceOwner();
    } catch (error) {
        return { ok: false, message: String((error as Error)?.message ?? "권한이 없습니다.") };
    }

    const ids = idsOf(paymentIds);
    try {
        await ensurePaymentInfrastructure();
        const rows = await loadRows(ids);
        const plan = planBulkRefund(ids, rows);
        if (!plan.ok) {
            // 아무것도 실행하지 않았다 — 첫 줄을 대표 문장으로
            return { ok: false, message: plan.blocks[0]?.message ?? "환불할 수 없어요.", blocks: plan.blocks };
        }

        const outcomes: BulkRefundOutcome[] = [];
        // 한 갈래씩 차례로(같은 결제를 동시에 두 번 부르지 않게). 한 갈래가 실패해도 나머지는 계속한다.
        for (const group of plan.groups) {
            try {
                if (group.kind === "MANUAL") {
                    const paymentId = group.paymentIds[0];
                    // 장부만 환불 — 조건부 UPDATE(status='PAID')라 그 사이 바뀌었으면 false
                    const changed = await prisma.$transaction((db) => refundPaidPaymentInTx(db, {
                        paymentId,
                        actorType: "ADMIN",
                        actorId: admin.appUserId,
                        message: "관리자 선택 항목 환불(장부)",
                        metadata: { bulk: true, batchSize: ids.length },
                    }));
                    outcomes.push(changed
                        ? { kind: group.kind, paymentIds: group.paymentIds, result: "DONE" }
                        : { kind: group.kind, paymentIds: group.paymentIds, result: "FAILED", message: "그 사이 상태가 바뀌었어요" });
                } else if (group.kind === "TOSS_ONLINE") {
                    const refunded = await refundTossPaymentByAdmin({
                        transactionId: group.key,
                        paymentIds: group.paymentIds,
                        adminUserId: admin.appUserId,
                    });
                    outcomes.push(refunded.ok
                        ? { kind: group.kind, paymentIds: group.paymentIds, result: "DONE" }
                        : { kind: group.kind, paymentIds: group.paymentIds, result: "FAILED", message: refunded.message });
                } else {
                    // 토스 POS — ⚡ «결제 취소»와 같은 함수(대표 청구 아무거나로 요청을 찾는다. 묶음 전체가 취소된다)
                    await requestChargeCancelByAdmin({ paymentId: group.paymentIds[0], adminUserId: admin.appUserId });
                    outcomes.push({ kind: group.kind, paymentIds: group.paymentIds, result: "REQUESTED" });
                }
            } catch (error) {
                const message = error instanceof ChargeRequestError
                    ? error.message
                    : "처리 중 오류가 났어요";
                if (!(error instanceof ChargeRequestError)) console.error("[bulk-refund]", String((error as Error)?.message ?? "").slice(0, 300));
                outcomes.push({ kind: group.kind, paymentIds: group.paymentIds, result: "FAILED", message });
            }
        }
        revalidatePaymentCaches();
        return { ok: true, summary: summarizeBulkRefund(outcomes), outcomes };
    } catch (error) {
        console.error("[bulk-refund] failed:", String((error as Error)?.message ?? "").slice(0, 300));
        return { ok: false, message: "선택 항목 환불을 처리하지 못했어요. 화면을 새로 고쳐 다시 확인해 주세요." };
    }
}
