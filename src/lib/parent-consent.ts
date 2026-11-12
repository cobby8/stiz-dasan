// 학부모 필수 동의(이용약관·개인정보 수집·이용·만 14세 이상) 버전 — 신규 가입과 기존 계정 활성화가 같은 값을 기록한다.
// 약관 본문을 크게 바꾸면 여기 날짜를 올린다(기록된 버전으로 «어느 약관에 동의했는지»를 가린다).
export const PARENT_TERMS_VERSION = "2026-07-23";
export const PARENT_PRIVACY_VERSION = "2026-07-23";

export type ParentConsents = { terms: boolean; privacy: boolean; age: boolean };

/** 세 가지 모두 동의했는가 — 화면이 아니라 서버가 최종 판정한다 */
export function hasAllParentConsents(consents: Partial<ParentConsents> | null | undefined): boolean {
  return Boolean(consents?.terms && consents?.privacy && consents?.age);
}

export const PARENT_CONSENT_REQUIRED_MESSAGE = "필수 약관과 만 14세 이상 확인에 모두 동의해 주세요.";
