import { NextRequest, NextResponse } from "next/server";
import { getEnabledParentOAuthProviders } from "@/lib/auth-providers";
import { requireVerifiedParent } from "@/lib/auth-guard";
import {
  PARENT_OAUTH_LABELS,
  parentOAuthNotReadyMessage,
  parseParentOAuthProvider,
  publicSiteOrigin,
  safeInternalRedirect,
  toSupabaseProvider,
} from "@/lib/parent-oauth";
import { createClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ provider: string }> };
// link = 이미 로그인한 학부모 계정에 간편로그인을 붙인다(마이페이지 「간편로그인 연결」, 2026-10-26).
type OAuthIntent = "login" | "parent-signup" | "link";

const LOGIN_METHODS_PATH = "/mypage/login-methods";

function parseIntent(value: string | null): OAuthIntent {
  if (value === "login" || value === "link") return value;
  return "parent-signup";
}

function loginError(request: NextRequest, message: string) {
  const intent = parseIntent(request.nextUrl.searchParams.get("intent"));
  if (intent === "link") {
    const url = new URL(LOGIN_METHODS_PATH, request.url);
    url.searchParams.set("error", message);
    return NextResponse.redirect(url);
  }
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
  const intent = parseIntent(request.nextUrl.searchParams.get("intent"));

  // 버튼 표시와 같은 판정(Supabase 실제 설정)으로 한 번 더 막는다. 화면이 낡았거나 누가 주소를
  // 직접 쳐도, Supabase 의 JSON 오류 화면 대신 우리 로그인 화면에서 안내를 보게 된다.
  if (!(await getEnabledParentOAuthProviders()).includes(provider)) {
    // 문구는 provider 별로 모듈이 만든다 — 여기 하드코딩하면 provider 를 늘릴 때 엉뚱한 이름이 나간다.
    return loginError(request, parentOAuthNotReadyMessage(provider));
  }

  const supabase = await createClient();

  if (intent === "link") {
    // 연결은 「비밀번호 등으로 이미 로그인한 학부모 본인」만. 휴대폰 문자만으로 기존 계정(자녀 정보)에
    // 붙이는 길은 만들지 않는다(원장 결정 2026-10-26) — 지금은 문자만으로 계정에 들어가는 길이 없다.
    const parent = await requireVerifiedParent().catch(() => null);
    if (!parent) return loginError(request, "학부모 계정으로 로그인한 뒤 연결해 주세요.");
    const callbackUrl = new URL("/auth/callback", publicSiteOrigin(request.nextUrl.origin));
    callbackUrl.searchParams.set("provider", provider);
    callbackUrl.searchParams.set("intent", "link");
    const { data, error } = await supabase.auth.linkIdentity({
      provider: toSupabaseProvider(provider),
      options: { redirectTo: callbackUrl.toString(), skipBrowserRedirect: true },
    });
    if (error || !data.url) {
      return loginError(request, `${PARENT_OAUTH_LABELS[provider]} 연결을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.`);
    }
    return NextResponse.redirect(data.url);
  }

  const next = safeInternalRedirect(request.nextUrl.searchParams.get("next"));
  const enrollmentHandoff = request.nextUrl.searchParams.get("handoff")
    || request.nextUrl.searchParams.get("enrollmentHandoff");
  const callbackUrl = new URL("/auth/callback", publicSiteOrigin(request.nextUrl.origin));
  callbackUrl.searchParams.set("provider", provider);
  callbackUrl.searchParams.set("next", next);
  callbackUrl.searchParams.set("intent", intent);
  if (enrollmentHandoff) callbackUrl.searchParams.set("handoff", enrollmentHandoff);

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
