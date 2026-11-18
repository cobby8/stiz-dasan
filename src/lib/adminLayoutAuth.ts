export type AdminLayoutAuthFailure = "LOGIN_REQUIRED" | "FORBIDDEN";

/**
 * 관리자 레이아웃에서 인증·권한 오류만 분리합니다.
 * DB 연결 실패처럼 예상하지 못한 오류는 null로 남겨 오류 화면에서 복구하게 합니다.
 */
export function classifyAdminLayoutAuthFailure(error: unknown): AdminLayoutAuthFailure | null {
  if (!(error instanceof Error)) return null;
  if (error.message.includes("인증이 필요")) return "LOGIN_REQUIRED";
  if (error.message.includes("관리자 권한")) return "FORBIDDEN";
  return null;
}

/**
 * 관리자 권한이 없는 계정을 돌려보낼 주소(2026-11-18 원장 지시).
 * 예전에는 학부모·선생님 계정으로 관리자 주소를 열면 안내 없이 오류 화면(500)이 떴다.
 * 이제는 그 계정이 쓰는 화면(학부모 → /mypage, 선생님 → /staff 등)으로 보낸다.
 *
 * 돌려보낼 곳이 다시 관리자 화면이면 null — 거절 → 이동 → 거절이 끝없이 반복되므로 보내지 않고
 * 원래대로 오류 화면에서 멈춘다(두 권한 판정이 어긋난 드문 경우의 안전장치).
 * 사이트 안 주소(/로 시작, //·역슬래시 아님)만 받는다.
 */
export function forbiddenAdminDestination(destination: unknown): string | null {
  if (typeof destination !== "string" || !destination.startsWith("/")) return null;
  if (destination.startsWith("//") || destination.includes("\\")) return null;
  const path = destination.split(/[?#]/)[0];
  if (path === "/admin" || path.startsWith("/admin/")) return null;
  return destination;
}
