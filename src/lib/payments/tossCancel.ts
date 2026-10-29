// 토스 결제 취소 알림 판정 — 외부 의존 없는 순수 함수(테스트가 직접 부른다).
//
// 웹훅 본문은 믿지 않고, 토스에 다시 조회한 결제(verified)와 우리 거래(tx)를 대조한 결과만 쓴다.
// 전액 취소만 장부에 자동 반영한다. 부분 취소는 어떤 항목을 얼마나 돌려줬는지 사람이 정해야 해서
// "확인 필요"로만 남긴다(원장이 재무 화면에서 처리).

export type TossCancelDecision =
    | { kind: "FULL_CANCEL" }
    | { kind: "PARTIAL_CANCEL"; canceledAmount: number }
    | { kind: "NOT_CANCEL" };

export function classifyTossCancel(
    verified: { status?: unknown; orderId?: unknown; paymentKey?: unknown; totalAmount?: unknown; balanceAmount?: unknown } | null,
    tx: { orderId: string; amount: number | string },
    webhookPaymentKey: string | null,
): TossCancelDecision {
    if (!verified) return { kind: "NOT_CANCEL" };
    if (verified.orderId !== tx.orderId || typeof verified.paymentKey !== "string" || !verified.paymentKey) return { kind: "NOT_CANCEL" };
    if (webhookPaymentKey && verified.paymentKey !== webhookPaymentKey) return { kind: "NOT_CANCEL" };
    if (Number(verified.totalAmount) !== Number(tx.amount)) return { kind: "NOT_CANCEL" };

    // 잔액(balanceAmount)이 없으면 전액 취소로 단정하지 않고 사람 확인으로 돌린다.
    const balance = verified.balanceAmount == null ? NaN : Number(verified.balanceAmount);
    if (verified.status === "CANCELED" && balance === 0) return { kind: "FULL_CANCEL" };
    if (verified.status === "PARTIAL_CANCELED" || verified.status === "CANCELED") {
        const total = Number(tx.amount);
        return { kind: "PARTIAL_CANCEL", canceledAmount: Number.isFinite(balance) ? total - balance : 0 };
    }
    return { kind: "NOT_CANCEL" };
}
