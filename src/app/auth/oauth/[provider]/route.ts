import { NextRequest, NextResponse } from "next/server";
import {
  isParentOAuthProviderReady,
  parentOAuthNotReadyMessage,
  parseParentOAuthProvider,
  publicSiteOrigin,
  safeInternalRedirect,
  toSupabaseProvider,
} from "@/lib/parent-oauth";
import { createClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ provider: string }> };
type OAuthIntent = "login" | "parent-signup";

function loginError(request: NextRequest, message: string) {
  const intent: OAuthIntent =
    request.nextUrl.searchParams.get("intent") === "login" ? "login" : "parent-signup";
  const url = new URL(intent === "login" ? "/login" : "/signup/parent", request.url);
  url.searchParams.set("error", message);
  const next = safeInternalRedirect(request.nextUrl.searchParams.get("next"));
  if (intent === "login" && next !== "/mypage") url.searchParams.set("redirect", next);
  if (intent === "parent-signup") {
    url.searchParams.set("social", "1");
    url.searchParams.set("next", next);
  }
  const handoff = request.nextUrl.searchParams.get("handoff")
    || request.nextUrl.searchParams.get("enrollmentHandoff");
  if (handoff) url.searchParams.set("enrollmentHandoff", handoff);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { provider: rawProvider } = await context.params;
  const provider = parseParentOAuthProvider(rawProvider);
  if (!provider) return loginError(request, "지원하지 않는 간편가입 방식입니다.");
  const intent: OAuthIntent =
    request.nextUrl.searchParams.get("intent") === "login" ? "login" : "parent-signup";

  if (!isParentOAuthProviderReady(provider)) {
    // 문구는 provider 별로 모듈이 만든다 — 여기 하드코딩하면 provider 를 늘릴 때 엉뚱한 이름이 나간다.
    return loginError(request, parentOAuthNotReadyMessage(provider));
  }

  const next = safeInternalRedirect(request.nextUrl.searchParams.get("next"));
  const enrollmentHandoff = request.nextUrl.searchParams.get("handoff")
    || request.nextUrl.searchParams.get("enrollmentHandoff");
  const callbackUrl = new URL("/auth/callback", publicSiteOrigin(request.nextUrl.origin));
  callbackUrl.searchParams.set("provider", provider);
  callbackUrl.searchParams.set("next", next);
  callbackUrl.searchParams.set("intent", intent);
  if (enrollmentHandoff) callbackUrl.searchParams.set("handoff", enrollmentHandoff);

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: toSupabaseProvider(provider),
    options: {
      redirectTo: callbackUrl.toString(),
      skipBrowserRedirect: true,
    },
  });

  if (error || !data.url) {
    return loginError(request, "간편가입을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  return NextResponse.redirect(data.url);
}
