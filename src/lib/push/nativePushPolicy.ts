/**
 * 스토어 앱 네이티브 푸시(e2, 2026-11-14) — DB·네트워크를 모르는 순수 규칙만 둔다.
 * 등록 API(/api/push/native)·발송 함수(pushNotification.ts)·테스트가 같은 규칙을 함께 쓴다.
 */

export type NativePushPlatform = "android" | "ios";

export const NATIVE_PUSH_PLATFORMS: readonly NativePushPlatform[] = ["android", "ios"];

/** DB CHECK(char_length(token) BETWEEN 20 AND 4096)와 같은 범위 — 바꾸면 마이그레이션도 같이 */
export const NATIVE_TOKEN_MIN = 20;
export const NATIVE_TOKEN_MAX = 4096;

/** 한 사람이 가질 수 있는 앱 토큰 수(기기 바꿈·재설치로 쌓이는 옛 토큰은 오래된 것부터 지운다) */
export const NATIVE_TOKENS_PER_USER = 10;

/** 로그아웃할 때 «이 기기 토큰»을 찾는 쿠키 이름(값 = 토큰 줄 id, 토큰 자체가 아니다) */
export const NATIVE_PUSH_DEVICE_COOKIE = "stiz_np";

/**
 * 발송 재시도(push-outbox 의 retrySubscriptionIds)에서 웹푸시 구독 id 와 앱 토큰 id 를 구분하는 머리글.
 * 웹푸시 id 는 그대로, 앱 토큰 id 는 "native:<id>" 로 담는다.
 */
export const NATIVE_RETRY_PREFIX = "native:";

/**
 * 등록 요청 본문 검사. 통과하면 { platform, token }, 아니면 null.
 * FCM 토큰은 영문·숫자·`:`·`_`·`-` 로만 된 긴 문자열이다 — 공백·제어문자·따옴표가 섞이면 거절한다.
 */
export function parseNativePushRegistration(body: unknown): { platform: NativePushPlatform; token: string } | null {
  if (!body || typeof body !== "object") return null;
  const { platform, token } = body as { platform?: unknown; token?: unknown };
  if (typeof platform !== "string" || !(NATIVE_PUSH_PLATFORMS as readonly string[]).includes(platform)) return null;
  if (typeof token !== "string") return null;
  if (token.length < NATIVE_TOKEN_MIN || token.length > NATIVE_TOKEN_MAX) return null;
  if (!/^[A-Za-z0-9:_\-.]+$/.test(token)) return null;
  return { platform: platform as NativePushPlatform, token };
}

/**
 * 알림을 눌렀을 때 앱이 열 주소 — 우리 사이트 «경로»만 보낸다(예: "/mypage/attendance").
 * 바깥 주소·"//evil"·역슬래시·제어문자는 버리고 기본 화면("/")으로 바꾼다.
 * 앱도 받은 주소를 자기 주소 정책(AppNavigationPolicy / NavigationPolicy)으로 한 번 더 거른다(이중 방어).
 */
export function safeNativePushPath(url: string | null | undefined, fallback = "/"): string {
  const raw = String(url ?? "").trim();
  if (!raw) return fallback;
  // 우리 사이트 전체 주소로 온 경우는 경로만 남긴다
  const site = /^https:\/\/www\.stiz-dasan\.kr(?=\/|$)/i;
  const path = site.test(raw) ? raw.replace(site, "") || "/" : raw;
  if (!path.startsWith("/") || path.startsWith("//")) return fallback;
  if (path.length > 1024 || /[\\\s\u0000-\u001f\u007f]/.test(path)) return fallback;
  return path;
}

/** 재시도 id 목록을 웹푸시 id 와 앱 토큰 id 로 나눈다. 목록이 없으면 둘 다 null(= 전부 대상) */
export function splitRetryIds(ids: string[] | undefined | null): { web: string[] | null; native: string[] | null } {
  if (!ids || ids.length === 0) return { web: null, native: null };
  const web: string[] = [];
  const native: string[] = [];
  for (const id of ids) {
    if (id.startsWith(NATIVE_RETRY_PREFIX)) native.push(id.slice(NATIVE_RETRY_PREFIX.length));
    else web.push(id);
  }
  return { web, native };
}
