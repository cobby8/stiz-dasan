/**
 * 가입 화면 «본인인증 리디렉션 복귀» 상태 저장·되살리기 (2026-11-18 4단계 A) — 순수 함수(브라우저 저장소는 부르는 쪽이 다룬다).
 *
 * 왜: 모바일 본인인증은 인증창에서 «리디렉션»으로 가입 화면에 돌아온다. 그때 화면이 처음부터 다시 그려져
 *     고른 역할(학부모/선생님/기사님)·단계가 사라지고, 아이디 가입은 첫 단계(역할 고르기)로 돌아가 인증 결과를 받을 버튼이 없었다.
 *     인증창을 열기 직전에 sessionStorage 에 적어 두었다가, 돌아왔을 때(주소에 identityVerificationId) 되살린다.
 * 실행 테스트: tests/anonymous-identity.test.mjs
 */

export const SIGNUP_IDENTITY_STATE_KEY = "stiz:parent-signup-identity-state:v1";
/** 인증창에서 이보다 오래 머문 뒤 돌아온 상태는 버린다(포트원 결과도 10분 안만 받는다) */
export const SIGNUP_IDENTITY_STATE_MAX_AGE_MS = 20 * 60 * 1000;

const STAFF_ROLES = ["INSTRUCTOR", "DRIVER"] as const;
export type SignupStaffRole = (typeof STAFF_ROLES)[number];

export type SignupIdentityState = {
  wantsParent: boolean;
  staffRoles: SignupStaffRole[];
  /** 가입 뒤 갈 곳(주소의 next) — 우리 사이트 안 경로만 */
  next: string;
  /** 수강신청서 넘기기 표(주소의 enrollmentHandoff) */
  enrollmentHandoff: string;
};

/** 우리 사이트 안 경로만 받는다(// 로 시작하는 다른 사이트 주소·스킴 주소 차단) */
function safePath(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text.startsWith("/") || text.startsWith("//") || text.startsWith("/\\") || text.length > 500) return "";
  return text;
}

export function serializeSignupIdentityState(state: SignupIdentityState, now: number): string {
  return JSON.stringify({
    wantsParent: Boolean(state.wantsParent),
    staffRoles: state.staffRoles.filter((role) => STAFF_ROLES.includes(role)),
    next: safePath(state.next),
    enrollmentHandoff: String(state.enrollmentHandoff || "").slice(0, 200),
    savedAt: now,
  });
}

/** 저장된 값을 되살린다. 모양이 이상하거나 오래됐으면 null(= 되살리지 않는다) */
export function parseSignupIdentityState(raw: string | null | undefined, now: number): SignupIdentityState | null {
  if (!raw) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const value = data as Record<string, unknown>;
  const savedAt = Number(value.savedAt);
  if (!Number.isFinite(savedAt) || savedAt > now + 60_000 || now - savedAt > SIGNUP_IDENTITY_STATE_MAX_AGE_MS) return null;
  const staffRoles = Array.isArray(value.staffRoles)
    ? Array.from(new Set(value.staffRoles.filter((role): role is SignupStaffRole => STAFF_ROLES.includes(role as SignupStaffRole))))
    : [];
  const wantsParent = value.wantsParent !== false;
  // 역할을 하나도 안 고른 상태는 만들 수 없다 — 그런 값이 오면 학부모로 되살린다
  return {
    wantsParent: wantsParent || staffRoles.length === 0,
    staffRoles,
    next: safePath(value.next),
    enrollmentHandoff: typeof value.enrollmentHandoff === "string" ? value.enrollmentHandoff.slice(0, 200) : "",
  };
}
