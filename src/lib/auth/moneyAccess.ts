// 부원장(VICE_ADMIN) 금액·통계 가림 규칙 — 2026-11-14 원장 결정.
//
// 왜: 학원에 상시 로그인해 둘 계정(admin@stiz.kr)을 부원장으로 두고, 카운터 업무(학생 검색 → 청구서 발행 →
//     ⚡현장 결제·입금/현장수납 승인)는 그대로 하되 «학원 돈 규모»(합계·납부 완료 금액·수납률·월 장부·통계)는
//     보지 못하게 한다. 화면만 가리면 개발자도구로 응답을 볼 수 있으므로 «서버 응답»에서 빼는 데 쓴다.
//
// 원장 결정(2026-11-14):
//   - 부원장이 보는 금액 = «아직 안 낸(미납) 청구 1건»의 금액뿐(학부모 안내·발행·현장 결제에 필요)
//   - 납부 완료·취소·환불된 청구 금액, 모든 합계·미납 합계·수납률 → 숨김(null)
//   - 열린 업무: ⚡현장 결제(POS, 결제 취소·환불 제외) · 청구서 발행(미납으로만) · 입금/현장수납 승인
//   - 닫힌 업무: 청구 준비·월 장부·POS 대사·학생 상세 «청구/수납» 탭·휴원 정산 환불·통계 전체
//   - 가격표(수업료·체험비·청구 템플릿)·대관료·방학특강 신청 금액은 그대로 보인다(안내 가격이라)

/** 학원 돈 전체(합계·납부 완료 금액·장부·통계)를 볼 수 있는 역할인가 — 원장(ADMIN)만. */
export function canSeeAllMoney(role: string | null | undefined): boolean {
    return role === "ADMIN";
}

/** 통계 메뉴·화면·대시보드 요약 카드를 볼 수 있는 역할인가 — 원장(ADMIN)만. */
export function canSeeStats(role: string | null | undefined): boolean {
    return role === "ADMIN";
}

/** 부원장에게도 금액을 보여 주는 청구 상태 — 아직 안 낸 청구(미납·연체)만. */
const UNPAID_VISIBLE_STATUSES = new Set(["PENDING", "OVERDUE"]);

/** 이 상태의 청구 금액을 이 역할에게 보여도 되는가. */
export function canSeePaymentAmount(role: string | null | undefined, status: string | null | undefined): boolean {
    if (canSeeAllMoney(role)) return true;
    return UNPAID_VISIBLE_STATUSES.has(String(status ?? ""));
}

/**
 * 청구 한 건의 금액을 역할에 맞게 가린다(못 보는 금액은 null).
 * 원장이면 원본 그대로 돌려준다. 금액 외에 같이 가릴 필드가 있으면 extraKeys 로 넘긴다.
 */
export function maskPaymentAmount<T extends { amount?: number | null; status?: string | null }>(
    payment: T,
    role: string | null | undefined,
    extraKeys: readonly (keyof T)[] = [],
): T {
    if (canSeePaymentAmount(role, payment.status ?? null)) return payment;
    const masked = { ...payment, amount: null } as T;
    for (const key of extraKeys) (masked as Record<keyof T, unknown>)[key] = null;
    return masked;
}
