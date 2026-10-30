// 이 표식은 로그인 권한이 아니다. 앱에서 설치한 세션의 보호 옵션만 갱신 때 유지한다.
export const NATIVE_SESSION_COOKIE = "__Host-stiz-native-session";

export function isNativeSession(cookies: ReadonlyArray<{ name: string; value: string }>): boolean {
  return cookies.some((cookie) => cookie.name === NATIVE_SESSION_COOKIE && cookie.value === "1");
}

export function nativeSessionCookieOptions<T extends object>(options: T, native: boolean): T {
  if (!native) return options;
  const protectedOptions = { ...options, httpOnly: true, secure: true, sameSite: "lax", path: "/" };
  // __Host 표식과 실제 세션 모두 현재 호스트에서만 사용한다.
  delete (protectedOptions as Record<string, unknown>).domain;
  return protectedOptions as T;
}
