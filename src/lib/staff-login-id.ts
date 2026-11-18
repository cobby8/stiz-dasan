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

/** 학부모 아이디 로그인 메일 도메인(아이디@member.stiz.kr) — parent-username 과 같은 값 */
const MEMBER_LOGIN_EMAIL_DOMAIN = "member.stiz.kr";

/**
 * 로그인 칸 입력 → Supabase 로그인 메일 (2026-11-18 «가입·본인인증 통일» 5단계).
 * 새로 오는 선생님·기사님은 학부모와 같은 아이디·간편로그인 계정이라, 직원 로그인 칸(loginContext "staff")에서도
 * 학부모식 아이디를 «먼저» 찾고(usernameEmail), 없으면 지금처럼 휴대폰 번호 → «번호@staff.stiz.kr»로 바꾼다.
 * 그래서 두 방식(새 직원 아이디 · 기존 직원 휴대폰 번호)이 모두 들어온다.
 *  - 이메일(@ 포함): 그대로
 *  - 학부모식 아이디가 있음(부르는 쪽이 DB 에서 찾은 로그인 메일): 그 메일
 *  - 휴대폰 번호 모양: 번호@staff.stiz.kr
 *  - 그 밖: 직원 칸이면 입력 그대로(로그인 실패로 끝난다), 일반 칸이면 아이디@member.stiz.kr
 */
export function resolveLoginAuthEmail(input: { identifier: string; loginContext?: unknown; usernameEmail?: string | null }): string {
  const identifier = input.identifier.trim();
  if (identifier.includes("@")) return identifier;
  if (input.usernameEmail) return input.usernameEmail;
  const staffEmail = staffLoginEmail(identifier);
  if (staffEmail !== identifier) return staffEmail;
  return input.loginContext === "staff" ? identifier : `${identifier.toLowerCase()}@${MEMBER_LOGIN_EMAIL_DOMAIN}`;
}
