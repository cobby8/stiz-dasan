// 학부모 로그인 아이디 규칙 — 신규 가입(parent-signup-verification)과 기존 학부모 계정 활성화(parent-account-claim)가
// 같은 규칙·같은 로그인 메일 매핑을 쓴다(2026-11-13 f7 가입 방식 통일).
//
// 왜 한 곳에: 활성화만 «이메일 + 10자»를 받아, 같은 학원 학부모가 가입 경로에 따라 로그인 방법이 달랐다.
// 아이디는 Supabase Auth 에 «아이디@member.stiz.kr»(받을 수 없는 주소)로 만들고, 로그인 화면(actions/auth.ts)은
// 아이디를 User.username → User.email 로 찾아 그 메일로 로그인한다.
// ⚠️ import 가 없는 순수 모듈 — 테스트가 그대로 실행한다. 두 서버 모듈이 서로를 불러 순환이 생기지 않게 따로 뺐다.

/** 영문 소문자로 시작, 영문 소문자·숫자·밑줄 4~20자 (DB 에는 LOWER(username) 고유 색인이 있다) */
export const PARENT_USERNAME_PATTERN = /^[a-z][a-z0-9_]{3,19}$/;

/** 아이디 형식이 틀렸을 때 화면에 보이는 문장 */
export const PARENT_USERNAME_RULE_MESSAGE = "아이디는 영문 소문자로 시작하고 영문·숫자·밑줄 조합의 4~20자로 입력해 주세요.";

/** 이미 다른 계정이 쓰는 아이디일 때 문장(user-facing-error 허용 목록에도 같은 문장) */
export const PARENT_USERNAME_TAKEN_MESSAGE = "이미 사용 중인 로그인 아이디입니다.";

/** 비교·저장용 정규화 — 앞뒤 공백 제거 + 소문자 */
export function normalizeParentUsername(value: string) {
  return String(value ?? "").trim().toLowerCase();
}

/** 정규화한 아이디가 규칙에 맞는가 */
export function isValidParentUsername(value: string) {
  return PARENT_USERNAME_PATTERN.test(normalizeParentUsername(value));
}

/** 아이디 → Supabase Auth 로그인 메일(받을 수 없는 주소). 로그인 화면이 아이디를 이 주소로 바꿔 로그인한다. */
export function parentUsernameAuthEmail(username: string) {
  return `${normalizeParentUsername(username)}@member.stiz.kr`;
}
