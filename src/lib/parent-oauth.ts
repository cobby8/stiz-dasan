import type { Provider } from "@supabase/supabase-js";

// apple 은 애플 앱스토어 등록의 필수 요건이다 — 제3자 소셜 로그인을 제공하는 앱은
// Apple 로그인도 함께 제공해야 한다(App Store 심사지침 4.8). Supabase 에서 Apple 제공자를
// 켜기 전에는 아래 enabledParentOAuthProviders 가 걸러내 버튼이 보이지 않는다.
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

/** Supabase `/auth/v1/settings` 응답 중 여기서 쓰는 부분. */
export type SupabaseAuthSettings = { external?: Record<string, unknown> } | null | undefined;

/**
 * 실제로 켜진 간편로그인만 고른다(화면 표시 순서는 PARENT_OAUTH_PROVIDERS 그대로).
 *
 * 왜 Supabase 설정을 직접 읽는가 — 2026-10-25 운영에서 구글·카카오가 Supabase 에서 꺼져
 * 있었는데 버튼은 늘 보였다. 학부모가 누르면 Supabase 의 JSON 오류 화면
 * (`Unsupported provider: provider is not enabled`)이 그대로 떴다. 환경변수 스위치를 따로 두면
 * 「Supabase 는 꺼졌는데 스위치는 켜짐」이 또 생긴다. 그래서 **켜졌는지의 원본을 하나로** 둔다.
 * 버튼 표시(/api/auth/providers)와 로그인 시작(/auth/oauth/[provider])이 모두 이 판정을 쓴다.
 */
export function enabledParentOAuthProviders(
  settings: SupabaseAuthSettings,
  env: Record<string, string | undefined> = process.env,
): ParentOAuthProvider[] {
  const external = settings?.external ?? {};
  return PARENT_OAUTH_PROVIDERS.filter((provider) => {
    // 네이버는 Supabase 커스텀 제공자라 settings 의 external 목록에 나오지 않는다 — 기존 플래그를 쓴다.
    if (provider === "naver") return env.SUPABASE_NAVER_PROVIDER_ENABLED === "true";
    // true 만 켜진 것으로 본다. 값이 없거나 이상하면 꺼진 것 — 눌러도 안 되는 버튼은 안 보이는 편이 낫다.
    return external[provider] === true;
  });
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
