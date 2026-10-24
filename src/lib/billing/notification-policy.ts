export type MonthlyInvoiceNotificationCandidate = {
  amount: number;
  notificationHeld: boolean;
};

/**
 * 관리자 발송 승인이 난 뒤 실제로 전송할 청구서만 남긴다.
 * 생성 승인과 발송 승인은 별개이며, 이 함수는 발송 단계의 마지막 안전망이다.
 */
export function isMonthlyInvoiceNotificationEligible(
  candidate: MonthlyInvoiceNotificationCandidate,
) {
  return candidate.amount > 0 && !candidate.notificationHeld;
}
