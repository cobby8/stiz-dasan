/**
 * 상태 → 색 지도 — 한 곳 (2026-11-09 원장 결정 · 색상 정리 3단계)
 *
 * 왜 한 곳인가: 같은 «대기중»이 화면마다 노랑·주황·갈색으로 달랐다(게슈탈트 «유사성» 위반).
 * 화면은 «이 상태가 어떤 뜻(tone)인가»만 여기서 받아 쓰고, 실제 색은 academy-theme.css 토큰이 정한다.
 *
 * 뜻 다섯 갈래(값은 academy-theme.css :root):
 *   success 정상 · warning 주의 · danger 위험 · info 정보(진행 중) · neutral 중립(끝났거나 해당 없음)
 *
 * ⚠️ Tailwind 가 클래스를 찾을 수 있게 색 클래스는 «글자 그대로» 적는다(문자열 조립 금지).
 * ⚠️ 색만으로 구분하지 않는다 — 배지에는 항상 글자(출석·미납…)가 함께 있어 흑백 인쇄에서도 읽힌다.
 */

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

export const STATUS_TONES: readonly StatusTone[] = ["success", "warning", "danger", "info", "neutral"];

/** 상태 배지(연한 바탕 + 진한 글자) — StatusBadge·화면별 배지가 같이 쓴다 */
export const TONE_BADGE_CLASS: Record<StatusTone, string> = {
  success: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]",
  warning: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
  danger: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]",
  info: "bg-[var(--color-academy-info-soft)] text-[var(--color-academy-info)]",
  neutral: "bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)]",
};

/** 글자만 색(금액 옆 «미납» 같은 한 단어 상태) */
export const TONE_TEXT_CLASS: Record<StatusTone, string> = {
  success: "text-[var(--color-academy-success)]",
  warning: "text-[var(--color-academy-warning)]",
  danger: "text-[var(--color-academy-danger)]",
  info: "text-[var(--color-academy-info)]",
  neutral: "text-[var(--color-academy-neutral)]",
};

/** 꽉 찬 상태색(눌린 출석 버튼·작은 막대) — 흰 글자 */
export const TONE_SOLID_CLASS: Record<StatusTone, string> = {
  success: "bg-[var(--color-academy-success)] text-[var(--color-academy-on-primary)]",
  warning: "bg-[var(--color-academy-warning)] text-[var(--color-academy-on-primary)]",
  danger: "bg-[var(--color-academy-danger)] text-[var(--color-academy-on-primary)]",
  info: "bg-[var(--color-academy-info)] text-[var(--color-academy-on-primary)]",
  neutral: "bg-[var(--color-academy-neutral)] text-[var(--color-academy-on-primary)]",
};

/** 상태색 테두리(안 눌린 상태 버튼·강조 카드 테두리) */
export const TONE_BORDER_CLASS: Record<StatusTone, string> = {
  success: "border-[var(--color-academy-success)]",
  warning: "border-[var(--color-academy-warning)]",
  danger: "border-[var(--color-academy-danger)]",
  info: "border-[var(--color-academy-info)]",
  neutral: "border-[var(--color-academy-line-input)]",
};

// ── 업무별 상태 → 뜻 ─────────────────────────────────────────────────────────

/** 출결: 출석 정상 · 지각 주의 · 결석 위험 · 보강 정보 · 휴무/사유 중립 */
export const ATTENDANCE_TONE: Record<string, StatusTone> = {
  PRESENT: "success",
  LATE: "warning",
  ABSENT: "danger",
  MAKEUP: "info",
  EXCUSED: "neutral",
  HOLIDAY: "neutral",
  CLOSED: "neutral",
};

/** 결제·청구: 납부 정상 · 미납 주의 · 연체 위험 · 입금 확인 중 정보 · 환불/취소 중립 */
export const PAYMENT_TONE: Record<string, StatusTone> = {
  PAID: "success",
  PENDING: "warning",
  UNPAID: "warning",
  ISSUED: "warning",
  SENT: "warning",
  OVERDUE: "danger",
  CONFIRMING: "info",
  REFUNDED: "neutral",
  CANCELED: "neutral",
  CANCELLED: "neutral",
};

/** 셔틀: 탑승 정상 · 체크 대기 주의 · 미탑승/결석 위험 · 오늘만 변경 정보 · 자차 중립 */
export const SHUTTLE_TONE: Record<string, StatusTone> = {
  BOARDED: "success",
  ALIGHTED: "success",
  PENDING: "warning",
  WAITING: "warning",
  NOSHOW: "danger",
  ABSENT: "danger",
  CHANGED: "info",
  SELF: "neutral",
};

/** 신청·요청: 승인 정상 · 대기 주의 · 반려 위험 · 진행 중(확인함·예약) 정보 · 취소 중립 */
export const REQUEST_TONE: Record<string, StatusTone> = {
  APPROVED: "success",
  COMPLETED: "success",
  ATTENDED: "success",
  PENDING: "warning",
  REQUESTED: "warning",
  REJECTED: "danger",
  CONFIRMED: "info",
  RESERVED: "info",
  SCHEDULED: "info",
  CANCELLED: "neutral",
  CANCELED: "neutral",
  USED: "neutral",
};

/** 지도에 없는 상태는 중립(회색)으로 — 모르는 상태를 «정상»처럼 보이게 하지 않는다 */
export function toneFor(map: Record<string, StatusTone>, status: string | null | undefined, fallback: StatusTone = "neutral"): StatusTone {
  return (status && map[status]) || fallback;
}

/** 상태 배지 클래스(연한 바탕 + 진한 글자) */
export function statusBadgeClass(tone: StatusTone): string {
  return TONE_BADGE_CLASS[tone];
}
