// 직원 초대 가입 — Supabase 계정 만들기(createUser)·비밀번호 바꾸기 실패를 «확실한 거절»과 «결과 모름»으로 나눈다.
//
// 왜 (2026-11-12 운영 사고): Supabase 가 «Password is known to be weak…»(약한 비밀번호, 422)로 거절했는데
// 코드가 모든 실패를 «결과 모름»으로 보고 초대를 RECOVERY_REQUIRED 로 잠갔다. 그 뒤 같은 링크에서
// 다시 하려 해도 «가입 처리 상태를 확인 중입니다»로 막혔다 — 실제로는 계정이 만들어지지 않았는데도.
//
// 판정 기준: Supabase 가 «응답을 돌려주며 4xx 로 거절»했다면 계정은 만들어지지 않았다(확실한 거절).
// 네트워크 끊김(status 0/없음)·시간 초과(408)·서버 오류(5xx)는 서버에서 만들어졌는지 알 수 없다(결과 모름).
// ⚠️ 의존성 0 인 순수 모듈 — tests/staff-invite-auth-failure.test.mjs 가 실제로 실행해 검증한다.

/** Supabase AuthError 에서 판정에 쓰는 칸만 (status·code·name·message) */
export type AuthFailureLike = {
  status?: number | null;
  code?: string | null;
  name?: string | null;
  message?: string | null;
} | null | undefined;

export type AuthFailureKind =
  | "weak_password"   // 약한 비밀번호로 거절 — 다른 비밀번호로 바로 다시 하면 된다
  | "already_exists"  // 이미 같은 이메일 계정이 있음
  | "rejected"        // 그 밖의 4xx 검증 거절 — 만들어지지 않았다
  | "uncertain";      // 결과 모름 — 만들어졌을 수도 있어 관리자 확인(RECOVERY_REQUIRED) 필요

const ALREADY_CODES = new Set(["email_exists", "user_already_exists", "phone_exists"]);

export function classifyAuthFailure(error: AuthFailureLike): AuthFailureKind {
  if (!error) return "uncertain"; // 오류도 사용자도 없는 이상한 응답 — 단정하지 않는다
  const status = typeof error.status === "number" ? error.status : null;
  // 4xx 응답(408 시간 초과 제외)만 «서버가 보고 거절했다»로 믿는다
  const definite = status !== null && status >= 400 && status < 500 && status !== 408;
  if (!definite) return "uncertain";
  const message = String(error.message ?? "").toLowerCase();
  if (error.code === "weak_password" || error.name === "AuthWeakPasswordError" || /weak|easy to guess|pwned/.test(message)) {
    return "weak_password";
  }
  if ((error.code && ALREADY_CODES.has(error.code)) || message.includes("already")) return "already_exists";
  return "rejected";
}

/** 약한 비밀번호 안내 — 화면 최소 길이(직원 10자)에 맞춘 쉬운 문장 */
export function weakPasswordMessage(minLength: number): string {
  return `쉽게 추측할 수 있는 비밀번호예요. 다른 비밀번호를 써 주세요(숫자·영문 섞어 ${minLength}자 이상).`;
}

export const STAFF_PASSWORD_MIN = 10;
export const STAFF_WEAK_PASSWORD_MESSAGE = weakPasswordMessage(STAFF_PASSWORD_MIN);
export const STAFF_AUTH_REJECTED_MESSAGE = "이 비밀번호로는 계정을 만들지 못했어요. 다른 비밀번호로 다시 시도해 주세요. 계속되면 원장에게 문의해 주세요.";
export const STAFF_ALREADY_REGISTERED_MESSAGE = "이미 가입된 계정입니다. 로그인 페이지에서 로그인해주세요.";
/** 문자 인증 시간이 지나 다시 인증해야 할 때(화면은 needsVerification 표식으로 1단계로 돌아간다) */
export const STAFF_NEEDS_VERIFICATION_MESSAGE = "전화번호 인증이 필요하거나 이미 처리 중인 초대입니다.";

/**
 * 가입 처리 실패 뒤 초대를 어떤 상태로 돌릴지 정한다.
 * - RECOVERY_REQUIRED : 계정이 남았을 수 있음(만든 계정 삭제 실패 or 결과 모름) → 관리자 복구 화면에서 정리
 * - RETRY_KEEP_OTP    : 확실히 안 만들어졌고 비밀번호 탓 → PENDING + 문자 인증 유지, 같은 화면에서 바로 재시도
 * - RESET_PENDING     : 그 밖의 실패 → PENDING + 문자 인증부터 다시(기존 동작)
 */
export type InviteFailureOutcome = "RECOVERY_REQUIRED" | "RETRY_KEEP_OTP" | "RESET_PENDING";

export function decideInviteFailureOutcome(input: {
  createdAuthUserId: string | null; // 이번 시도에서 만든 Auth 계정(있으면)
  authDeleteFailed: boolean;        // 그 계정 삭제가 실패했는가
  authFailure: AuthFailureKind | null; // createUser/updateUser 실패 판정(그 단계에서 실패했을 때만)
}): InviteFailureOutcome {
  if (input.createdAuthUserId && input.authDeleteFailed) return "RECOVERY_REQUIRED";
  if (input.authFailure === "uncertain") return "RECOVERY_REQUIRED";
  if (input.authFailure === "weak_password" || input.authFailure === "rejected") return "RETRY_KEEP_OTP";
  return "RESET_PENDING";
}

/** createUser/updateUser 실패를 사용자 문장으로 (uncertain 은 관리자 확인 문장을 따로 쓴다) */
export function staffAuthFailureMessage(kind: AuthFailureKind): string {
  if (kind === "weak_password") return STAFF_WEAK_PASSWORD_MESSAGE;
  if (kind === "already_exists") return STAFF_ALREADY_REGISTERED_MESSAGE;
  return STAFF_AUTH_REJECTED_MESSAGE;
}

// ── 제출 전 사전 경고(화면) ─────────────────────────────────────────
// Supabase 는 유출된 비밀번호 목록으로 거절한다 — 그대로 따라 할 순 없으니, 거의 확실히 거절될 모양만 미리 막는다.
const COMMON_WORDS = ["password", "qwerty", "asdf", "zxcv", "iloveyou", "admin", "welcome", "letmein", "stiz", "basketball", "abc123"];

function isSequential(text: string): boolean {
  // 0123456789 / 9876543210 / abcdef… 처럼 한 칸씩 오르거나 내리는 문자열
  if (text.length < 4) return false;
  let up = true;
  let down = true;
  for (let i = 1; i < text.length; i += 1) {
    const diff = text.charCodeAt(i) - text.charCodeAt(i - 1);
    if (diff !== 1) up = false;
    if (diff !== -1) down = false;
  }
  return up || down;
}

/** 너무 흔한 비밀번호면 안내 문장, 괜찮으면 null. phone 을 주면 그 번호가 들어간 비밀번호도 막는다. */
export function commonPasswordWarning(password: string, options: { phone?: string | null; minLength?: number } = {}): string | null {
  const minLength = options.minLength ?? STAFF_PASSWORD_MIN;
  const lower = password.toLowerCase();
  if (!lower) return null;
  const message = weakPasswordMessage(minLength);
  if (/^(.)\1+$/.test(lower)) return message;           // aaaaaaaaaa, 1111111111
  if (/^\d+$/.test(lower)) return message;              // 숫자만 — 전화번호·생일·123456 류
  if (/^[a-z]+$/.test(lower) && isSequential(lower)) return message;
  // 같은 덩어리 반복(abcabcabc, 12121212)
  if (/^(.{1,4})\1{2,}$/.test(lower)) return message;
  if (COMMON_WORDS.some((word) => lower.replace(/[^a-z0-9]/g, "").startsWith(word) && lower.length - word.length <= 4)) return message;
  // 자기 전화번호 뒤 8자리가 들어간 비밀번호
  const phoneDigits = String(options.phone ?? "").replace(/\D/g, "");
  if (phoneDigits.length >= 8 && lower.includes(phoneDigits.slice(-8))) return message;
  return null;
}
