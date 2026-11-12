// 직원(관리자·선생님) 로그인 아이디 변환 — 순수 모듈(tests/staff-login-id.test.mjs 가 실행한다).
//
// 왜: 초대로 가입한 직원의 로그인 메일은 `휴대폰번호@staff.stiz.kr`(받을 수 없는 주소)다.
// 선생님은 이 주소를 모르고 «휴대폰 번호»만 안다 — 번호만 넣어도 로그인되게 여기서 바꿔 준다.
// 이메일(@ 포함)로 넣으면 지금처럼 그대로 쓴다.

export const STAFF_LOGIN_EMAIL_DOMAIN = "staff.stiz.kr";

/** 숫자(하이픈·공백 허용)만 입력했으면 `<숫자>@staff.stiz.kr`, 아니면 입력 그대로 */
export function staffLoginEmail(identifier: string): string {
  const value = identifier.trim();
  if (!/^[\d\s-]+$/.test(value)) return value;
  const digits = value.replace(/\D/g, "");
  // 휴대폰 번호 길이(10~11자리)만 바꾼다 — 엉뚱한 숫자를 메일로 만들지 않는다
  if (!/^\d{10,11}$/.test(digits)) return value;
  return `${digits}@${STAFF_LOGIN_EMAIL_DOMAIN}`;
}
