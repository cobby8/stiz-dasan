// 토스 결제 «부분 취소» 판정 — 외부 의존 없는 순수 함수(테스트가 직접 부른다).
//
// 쓰는 곳: 휴원 수강료 환불(payment-ledger.ts partialRefundTossPaymentByAdmin).
// 흐름은 전액 환불(refundTossPaymentByAdmin)과 같다: 토스 재조회 → 감사 기록 → 취소 API(cancelAmount) → 다시 조회해 확인.
// 장부(우리 기록)는 «다시 조회한 결제의 cancels[] 에 우리 표식이 붙은 취소가 정확한 금액으로 있을 때»만 완료로 바꾼다.
// 응답만 믿지 않는다 — 성공 응답이 끊겨도, 실패 응답인데 실제로 취소됐어도 재조회 결과가 정답이다.

export type TossCancelEntry = {
    cancelAmount?: unknown;
    cancelReason?: unknown;
    taxFreeAmount?: unknown;
    cancelStatus?: unknown;
    transactionKey?: unknown;
};

export type VerifiedTossForPartial = {
    status?: unknown;
    orderId?: unknown;
    paymentKey?: unknown;
    totalAmount?: unknown;
    balanceAmount?: unknown;
    taxFreeAmount?: unknown;
    method?: unknown;
    cancels?: unknown;
};

/** 취소 사유에 넣는 표식 — 같은 처리 줄의 재시도가 이미 된 취소를 알아보게(토스 취소 사유 200자 안) */
export function partialCancelMarker(lineId: string): string {
    return `${PARTIAL_CANCEL_MARKER_PREFIX}${lineId}`;
}

function cancelsOf(verified: VerifiedTossForPartial | null | undefined): TossCancelEntry[] {
    return Array.isArray(verified?.cancels) ? (verified!.cancels as TossCancelEntry[]) : [];
}

/** 이 표식으로 이미 된 취소(있으면 금액) — 재시도·응답 끊김에서 두 번 취소하지 않게 */
export function findMarkedCancel(verified: VerifiedTossForPartial | null | undefined, marker: string): { amount: number } | null {
    for (const entry of cancelsOf(verified)) {
        if (typeof entry.cancelReason !== "string" || !entry.cancelReason.includes(marker)) continue;
        // 취소 상태가 적혀 있으면 DONE 만 인정(없으면 cancels 에 들어 있는 것 자체가 완료)
        if (entry.cancelStatus != null && entry.cancelStatus !== "DONE") continue;
        return { amount: Number(entry.cancelAmount) };
    }
    return null;
}

/** 모든 휴원 환불 표식(STIZ-PR:) 접두사 */
export const PARTIAL_CANCEL_MARKER_PREFIX = "STIZ-PR:";

/**
 * «이 줄을 만든 뒤 생긴, 우리 표식이 없는 같은 금액의 취소»가 있나 — 원장이 토스 상점관리자에서 직접 취소했을 수 있다.
 * 있으면 다시 시도하지 않고 사람이 확인한다(두 번 환불 방지). 취소 시각을 못 읽으면 있는 것으로 본다(안전한 쪽).
 */
export function hasUnmarkedSameAmountCancel(verified: VerifiedTossForPartial | null | undefined, amount: number, notBefore: string | null | undefined): boolean {
    const since = notBefore ? Date.parse(notBefore) : NaN;
    for (const entry of cancelsOf(verified)) {
        if (typeof entry.cancelReason === "string" && entry.cancelReason.includes(PARTIAL_CANCEL_MARKER_PREFIX)) continue;
        if (Number(entry.cancelAmount) !== amount) continue;
        const at = Date.parse(String((entry as { canceledAt?: unknown }).canceledAt ?? ""));
        if (!Number.isFinite(at) || !Number.isFinite(since) || at >= since) return true;
    }
    return false;
}

/** 우리 휴원 환불 표식이 붙은 취소 금액 합(웹훅 «부분 취소 확인 필요» 경보를 거를 때) */
export function markedCancelTotal(verified: VerifiedTossForPartial | null | undefined): number {
    return cancelsOf(verified).reduce((sum, entry) => (
        typeof entry.cancelReason === "string" && entry.cancelReason.includes(PARTIAL_CANCEL_MARKER_PREFIX)
            && (entry.cancelStatus == null || entry.cancelStatus === "DONE")
            ? sum + (Number(entry.cancelAmount) || 0)
            : sum
    ), 0);
}

/**
 * 부분 취소에 함께 보낼 면세 금액. 학원 결제는 전액 면세로 받는다(taxFree.ts) — 남은 면세 금액 안에서 취소액만큼.
 * 복합과세 상점은 부분 취소에도 taxFreeAmount 를 넘겨야 면세 몫이 맞게 줄어든다.
 */
export function partialCancelTaxFree(verified: VerifiedTossForPartial, cancelAmount: number): number {
    const taxFree = Number(verified.taxFreeAmount ?? 0);
    if (!Number.isFinite(taxFree) || taxFree <= 0) return 0;
    // 원 결제가 전액 면세(면세 금액 = 결제 총액)면 취소액 전부가 면세 — cancels 를 빼는 계산을 하지 않는다(학원 결제의 기본).
    if (taxFree === Number(verified.totalAmount)) return cancelAmount;
    // 그 밖(복합 과세): 결제의 taxFreeAmount 가 «처음 면세 총액»인지 «취소 뒤 남은 면세»인지 토스 문서로 확인하지 못했다(미확인).
    // 처음 총액이라고 보고 앞선 취소의 면세 몫을 뺀다 — 지금 학원 결제는 전액 면세라 이 갈래를 타지 않는다.
    const canceledTaxFree = cancelsOf(verified).reduce((sum, entry) => sum + (Number(entry.taxFreeAmount) || 0), 0);
    return Math.max(0, Math.min(cancelAmount, taxFree - canceledTaxFree));
}

/**
 * 부분 취소를 보내도 되는가(막을 이유 문장, 통과면 null).
 * 우리 거래와 같은 주문·금액 · 완료(또는 이미 일부 취소) 상태 · 무통장입금 아님 · 남은 금액 ≥ 취소액 · 취소액은 양의 정수.
 */
export function partialCancelBlock(
    verified: VerifiedTossForPartial | null,
    tx: { orderId: string; amount: number | string; method?: string | null },
    cancelAmount: number,
): string | null {
    if (!Number.isSafeInteger(cancelAmount) || cancelAmount <= 0) return "환불 금액이 올바르지 않아요.";
    if (!verified) return "토스에서 결제를 확인하지 못했어요.";
    if (verified.orderId !== tx.orderId || typeof verified.paymentKey !== "string" || !verified.paymentKey) {
        return "토스 결제 정보가 장부와 달라 취소하지 않았어요.";
    }
    if (Number(verified.totalAmount) !== Number(tx.amount)) return "토스 결제 금액이 장부와 달라 취소하지 않았어요.";
    if (verified.status !== "DONE" && verified.status !== "PARTIAL_CANCELED") return "토스에서 완료 상태가 아닌 결제라 취소하지 않았어요.";
    if (verified.method === "가상계좌" || tx.method === "가상계좌") return "무통장입금으로 낸 결제는 환불 계좌가 필요해요. 토스 상점관리자에서 환불해 주세요.";
    const balance = verified.balanceAmount == null ? NaN : Number(verified.balanceAmount);
    if (!Number.isFinite(balance)) return "토스 결제의 남은 금액을 확인하지 못했어요.";
    if (balance < cancelAmount) return `토스 결제에 남은 금액(${balance.toLocaleString("ko-KR")}원)이 환불 금액보다 적어요.`;
    return null;
}
