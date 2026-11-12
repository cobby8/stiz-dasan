// 학부모 비밀번호 규칙 — 가입·계정 활성화·비밀번호 찾기·마이페이지 비밀번호 바꾸기가 같은 판정을 쓴다(2026-11-13).
//
// 왜 한 곳에: Supabase 가 «쉽게 추측할 수 있는 비밀번호»(유출 목록)로 거절하면, 학부모 쪽 세 곳이
// 각자 «계정을 만들지 못했습니다»처럼 이유 없는 문구를 보여 줘 무엇을 고쳐야 할지 몰랐다.
// 판정(약한 비밀번호 거절인가)과 입력 중 사전 경고는 직원 초대 화면(InviteAcceptForm)과 같은 규칙을 쓴다 —
// 규칙 본체는 @/lib/staff/inviteAuthFailure 에 그대로 두고 여기서는 학부모용 문구·길이만 얹는다.
// ⚠️ 의존성은 순수 모듈(inviteAuthFailure)뿐 — tests/parent-password-rules.test.mjs 가 실제로 실행한다.

import {
  classifyAuthFailure,
  commonPasswordWarning,
  type AuthFailureLike,
} from "@/lib/staff/inviteAuthFailure";

/** 아이디 가입·비밀번호 찾기 최소 길이 */
export const PARENT_PASSWORD_MIN = 8;
/** 기존 학부모 계정 활성화(이메일 로그인) 최소 길이 — 활성화는 예전부터 10자 */
export const PARENT_ACTIVATION_PASSWORD_MIN = 10;

/** Supabase 가 약한 비밀번호로 거절했을 때 화면에 보이는 문장(user-facing-error 허용 목록에도 같은 문장) */
export const PARENT_WEAK_PASSWORD_MESSAGE = "쉽게 추측할 수 있는 비밀번호라 쓸 수 없어요. 더 길거나 복잡한 비밀번호로 정해 주세요.";

/** Supabase 비밀번호 거절 중 «약한 비밀번호»인가 — 직원 초대와 같은 판정(classifyAuthFailure) */
export function isWeakPasswordRejection(error: AuthFailureLike): boolean {
  if (!error) return false;
  if (classifyAuthFailure(error) === "weak_password") return true;
  // 상태값 없이 문구만 오는 예전 응답도 알아본다(classifyAuthFailure 는 4xx 가 있어야 판정한다)
  const message = String(error.message ?? "").toLowerCase();
  return error.code === "weak_password" || error.name === "AuthWeakPasswordError" || /weak|easy to guess|pwned/.test(message);
}

/**
 * 사전 경고(입력칸을 벗어날 때·제출할 때 보인다) — 같은 숫자 반복·연속 숫자·qwer 류·전화번호가 든 비밀번호는 보내기 전에 막는다.
 * 최소 길이에 못 미치면 길이 안내가 먼저라 경고하지 않는다(null).
 */
export function parentPasswordWarning(
  password: string,
  options: { phone?: string | null; minLength?: number } = {},
): string | null {
  const minLength = options.minLength ?? PARENT_PASSWORD_MIN;
  if (password.length < minLength) return null;
  // 판정은 직원 초대와 같은 규칙, 문장은 서버 거절과 하나로(뒤에 길이 안내만 덧붙인다)
  return commonPasswordWarning(password, { phone: options.phone, minLength })
    ? parentWeakPasswordHint(minLength)
    : null;
}

/** 화면 경고 문장 — 서버 거절 문장(PARENT_WEAK_PASSWORD_MESSAGE) + «(숫자·영문 섞어 N자 이상)» */
export function parentWeakPasswordHint(minLength: number): string {
  return `${PARENT_WEAK_PASSWORD_MESSAGE} (숫자·영문 섞어 ${minLength}자 이상)`;
}

/**
 * 간편로그인 전용 계정에 문자 인증만으로 비밀번호를 새로 만들어도 되는가(보안 검수 HIGH, 2026-11-13).
 *
 * 문자 인증은 «지금 이 번호를 쥔 사람»만 증명한다. 그래서
 * - 그 번호가 계정에 «인증된 번호»로 묶여 있을 때만(phoneVerifiedAt 있음) — 학원이 넣은 번호·바뀐 번호로
 *   남의 간편로그인 계정에 비밀번호를 심는 길을 막는다.
 * - 선생님·기사님 추가 역할(UserRoleGrant ACTIVE)이 있는 계정은 제외 — 학생 개인정보가 열리는 계정은
 *   문자 하나로 새 로그인 수단을 만들지 않는다(학원 문의).
 * 비밀번호가 이미 있는 계정의 재설정은 예전 규칙 그대로다(이 판정은 간편로그인 전용 계정에만 쓴다).
 */
export function socialPasswordCreationAllowed(input: { phoneVerifiedAt: unknown; hasStaffGrant: boolean }): boolean {
  return Boolean(input.phoneVerifiedAt) && !input.hasStaffGrant;
}

export const SOCIAL_PASSWORD_CONTACT_MESSAGE = "이 계정은 여기서 비밀번호를 만들 수 없어요. 학원에 문의해 주세요.";

/**
 * 간편로그인만 쓰던 학부모가 문자 인증으로 비밀번호를 새로 만들 때, 무엇으로 로그인하게 되는지 정한다.
 *
 * 로그인 화면(actions/auth.ts login)은
 *   - «@» 가 든 값 → 그 값을 로그인 메일로 그대로 쓴다
 *   - 아이디 → User.username 으로 User.email 을 찾아 로그인 메일로 쓴다
 * 그래서 «아이디로 로그인» 은 User.email 이 로그인 계정(Supabase) 메일과 같을 때만 통한다.
 *
 * - 아이디 있음 + 앱 메일 = 로그인 메일 → 아이디
 * - 로그인 메일 있음                     → 그 메일(기존 이메일로 로그인)
 * - 로그인 메일 없음 + 아이디 있음 + 앱 메일이 «아이디@member.stiz.kr» → 로그인 메일을 그 주소로 붙이고 아이디
 * - 그 밖(아이디도 메일도 없음)           → null(학원 문의)
 */
export function planSocialPasswordLogin(input: {
  username: string | null | undefined;
  appEmail: string | null | undefined;
  authEmail: string | null | undefined;
}): { loginId: string; setAuthEmail: string | null } | null {
  const username = String(input.username ?? "").trim().toLowerCase();
  const appEmail = String(input.appEmail ?? "").trim().toLowerCase();
  const authEmail = String(input.authEmail ?? "").trim().toLowerCase();
  if (username && authEmail && appEmail === authEmail) return { loginId: username, setAuthEmail: null };
  if (authEmail) return { loginId: authEmail, setAuthEmail: null };
  const synthetic = username ? `${username}@member.stiz.kr` : "";
  if (synthetic && appEmail === synthetic) return { loginId: username, setAuthEmail: synthetic };
  return null;
}
