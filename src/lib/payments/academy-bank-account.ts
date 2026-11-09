import "server-only";

// ── 학원 입금 계좌(서버 전용) ──────────────────────────────────────────────
// 왜 서버 전용인가: 손님 브라우저 번들에 계좌가 통째로 실리지 않게, 로그인한 학부모 화면에만 값으로 넘긴다.
// 원장 확인(2026-11-09): 수강료·대관 모두 같은 계좌 «하나은행 55491019425407 (예금주 권혜미)».
// 대관 화면은 src/lib/rental/gym-rental-notify.ts 의 같은 값(다른 세션 담당 파일)을 쓴다 — 바꿀 때 두 곳을 같이.
/** 기본 입금 계좌 — 환경변수 ACADEMY_BANK_ACCOUNT 가 있으면 그 값을 쓴다. */
export const DEFAULT_ACADEMY_BANK_ACCOUNT = "하나은행 55491019425407 (예금주 권혜미)";

export function resolveAcademyBankAccount(envValue: string | null | undefined): string {
  const value = String(envValue ?? "").trim();
  return value || DEFAULT_ACADEMY_BANK_ACCOUNT;
}

export function academyBankAccount(): string {
  return resolveAcademyBankAccount(process.env.ACADEMY_BANK_ACCOUNT);
}
