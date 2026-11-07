// 토스페이먼츠 면세 금액 — 결제 요청·승인 확인이 같이 쓰는 한 곳(외부 의존 없는 순수 모듈).
//
// ■ 왜 필요한가
//   토스 계약(2026-10-29)의 기본값은 «복합과세» 상점이다. 복합과세 상점은 결제를 요청할 때마다
//   면세 금액(taxFreeAmount)을 넘겨야 하고, 빠지면 오류 없이 결제되지만 부가세가 잡힌 거래로 남는다.
//   근거: https://docs.tosspayments.com/guides/v2/learn/tax (복합 과세 상점 = taxFreeAmount 설정 필요)
//         https://docs.tosspayments.com/sdk/v2/js/payment (payment.requestPayment() 파라미터 taxFreeAmount)
//
// ■ 왜 전액인가
//   학원은 면세 교육서비스 사업자이고, 셔틀비도 면세로 처리한다(원장 결정 2026-10-29).
//   유니폼·용품처럼 과세 품목이 청구서에 들어오게 되면 이 함수만 «면세 항목 합계»로 바꾼다.

/** 결제 금액 중 면세로 보낼 금액. 지금은 전액 면세. */
export function taxFreeAmountFor(amount: number): number {
    return amount;
}

/**
 * 토스 승인/조회 응답이 면세로 처리됐는지 확인한다.
 * 면세가 아니면 경고 문장을, 맞으면 null 을 돌려준다.
 * ⚠️ 결제를 실패시키는 용도가 아니다 — 돈은 이미 나갔으니 장부 반영은 그대로 하고 로그만 남긴다.
 */
export function describeTaxFreeMismatch(payment: {
    totalAmount?: unknown;
    taxFreeAmount?: unknown;
    suppliedAmount?: unknown;
    vat?: unknown;
}): string | null {
    const total = Number(payment.totalAmount);
    const taxFree = Number(payment.taxFreeAmount);
    const supplied = Number(payment.suppliedAmount ?? 0);
    const vat = Number(payment.vat ?? 0);
    if (!Number.isFinite(total)) return null; // 금액을 못 읽으면 판단하지 않는다(다른 검증이 막는다)

    const expected = taxFreeAmountFor(total);
    if (taxFree === expected && supplied === 0 && vat === 0) return null;
    return `토스 결제가 면세로 처리되지 않았습니다: totalAmount=${total}, taxFreeAmount=${payment.taxFreeAmount ?? "없음"}(기대 ${expected}), suppliedAmount=${payment.suppliedAmount ?? "없음"}, vat=${payment.vat ?? "없음"}`;
}
