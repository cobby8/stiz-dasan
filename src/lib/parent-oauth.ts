import type { Provider } from "@supabase/supabase-js";

// apple 은 애플 앱스토어 등록의 필수 요건이다 — 제3자 소셜 로그인을 제공하는 앱은
// Apple 로그인도 함께 제공해야 한다(App Store 심사지침 4.8). 다만 애플 개발자 계정과
// Service ID·Key 가 있어야 실제로 동작하므로, 준비되기 전에는 아래 ready 판정으로 꺼 둔다.
export const PARENT_OAUTH_PROVIDERS = ["google", "kakao", "naver", "apple"] as const;

export type ParentOAuthProvider = (typeof PARENT_OAUTH_PROVIDERS)[number];

/** 화면에 쓰는 이름. 안내 문구를 provider 마다 하드코딩하지 않기 위해 한 곳에 모은다. */
export const PARENT_OAUTH_LABELS: Record<ParentOAuthProvider, string> = {
  google: "Google",
  kakao: "카카오",
  naver: "네이버",
  apple: "Apple",
};

export function parseParentOAuthProvider(value: string): ParentOAuthProvider | null {
  return PARENT_OAUTH_PROVIDERS.includes(value as ParentOAuthProvider)
    ? (value as ParentOAuthProvider)
    : null;
}

export function toSupabaseProvider(provider: ParentOAuthProvider): Provider {
  // Google and Kakao are built in. Naver is registered in Supabase as a
  // project-specific custom OAuth provider.
  return (provider === "naver" ? "custom:naver" : provider) as Provider;
}

export function isParentOAuthProviderReady(provider: ParentOAuthProvider) {
  if (provider === "naver") return process.env.SUPABASE_NAVER_PROVIDER_ENABLED === "true";
  // NEXT_PUBLIC_ 인 이유: 로그인 화면이 클라이언트 컴포넌트라 버튼을 그릴 때도 같은 판정이
  // 필요하다. 변수 둘로 나누면 「버튼은 보이는데 누르면 거절」처럼 한쪽만 켜진 상태가 생긴다.
  // 켜졌다는 사실 자체는 비밀이 아니므로 공개 변수로 둬도 된다.
  if (provider === "apple") return process.env.NEXT_PUBLIC_APPLE_LOGIN_ENABLED === "true";
  return true;
}

/**
 * 아직 준비되지 않은 간편로그인을 눌렀을 때의 안내.
 * ⚠️ 이 문구를 호출하는 쪽에 하드코딩하지 말 것 — 네이버 문구가 박혀 있어서
 *    apple 을 추가하자 "네이버 간편가입을 준비 중입니다"가 뜰 뻔했다(2026-10-25).
 */
export function parentOAuthNotReadyMessage(provider: ParentOAuthProvider) {
  return `${PARENT_OAUTH_LABELS[provider]} 간편가입을 준비 중입니다. 일반 회원가입을 이용해 주세요.`;
}

export function safeInternalRedirect(value: string | null, fallback = "/mypage") {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return fallback;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return fallback;

  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/") || decoded.startsWith("//") || decoded.includes("\\")) {
      return fallback;
    }
    const parsed = new URL(value, "https://stiz.local");
    return parsed.origin === "https://stiz.local"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}

export function publicSiteOrigin(requestOrigin: string) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return requestOrigin;

  try {
    return new URL(configured).origin;
  } catch {
    return requestOrigin;
  }
}
