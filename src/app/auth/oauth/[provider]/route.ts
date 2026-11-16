import { NextRequest, NextResponse } from "next/server";
import { getEnabledParentOAuthProviders } from "@/lib/auth-providers";
import { resolveLinkActor } from "@/lib/account/link-actor";
import { loginMethodsPath, type LinkActor, type StaffLinkErrorCode } from "@/lib/account/login-methods-rules";
import { isAllowedLinkHandoffOrigin } from "@/lib/account-link-handoff/rules";
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
// link = 이미 로그인한 계정에 간편로그인을 붙인다(마이페이지 「간편로그인 연결」, 2026-10-26).
// 2026-11-17: 학부모뿐 아니라 직원(원장·부원장·선생님·기사님) 계정도 연결할 수 있다(원장 지시).
type OAuthIntent = "login" | "parent-signup" | "link";

function parseIntent(value: string | null): OAuthIntent {
  if (value === "login" || value === "link") return value;
  return "parent-signup";
}

/**
 * 연결(link) 실패를 연결 화면으로 돌려보낸다. 어느 화면인지는 판정된 actor 로만 정한다.
 * - 직원: 문장 대신 «코드»(e)만 싣는다 — 주소로 가짜 안내문을 띄우지 못하게(2026-11-17 보안 검수 반영)
 * - 학부모·로그인 없음: 기존 그대로 error=<문장>(학부모 화면이 그렇게 읽는다)
 * status 303 = 폼 POST 뒤 GET 으로 보낸다(기본 307 은 POST 를 그대로 다시 보낸다).
 */
function linkErrorRedirect(
  request: NextRequest,
  actor: LinkActor | null,
  message: string,
  staffCode: StaffLinkErrorCode,
  status: 303 | 307 = 307,
) {
  const url = new URL(loginMethodsPath(actor), request.url);
  if (actor === "staff") url.searchParams.set("e", staffCode);
  else url.searchParams.set("error", message);
  return NextResponse.redirect(url, status);
}

/**
 * 안내와 함께 돌려보낸다. 연결(link)일 때 돌아갈 화면은 주소 파라미터가 아니라 «지금 로그인한 계정»으로
 * 서버가 정한다 — 직원이면 직원 연결 화면, 그 밖은 학부모 연결 화면(열린 리다이렉트·역할 혼동 방지).
 * knownActor: 이미 판정을 마친 곳에서는 넘겨서 같은 조회를 다시 하지 않는다.
 * staffCode: 직원 화면에 실을 코드(직원이 아니면 쓰이지 않는다).
 */
async function loginError(
  request: NextRequest,
  message: string,
  knownActor?: LinkActor | null,
  staffCode: StaffLinkErrorCode = "failed",
) {
  const intent = parseIntent(request.nextUrl.searchParams.get("intent"));
  if (intent === "link") {
    const actor = knownActor !== undefined ? knownActor : await resolveLinkActor();
    return linkErrorRedirect(request, actor, message, staffCode);
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
    return loginError(request, parentOAuthNotReadyMessage(provider), undefined, "closed");
  }

  const supabase = await createClient();

  if (intent === "link") {
    // 연결은 「비밀번호 등으로 이미 로그인한 본인」만. 휴대폰 문자만으로 기존 계정(자녀 정보)에
    // 붙이는 길은 만들지 않는다(원장 결정 2026-10-26) — 지금은 문자만으로 계정에 들어가는 길이 없다.
    // 학부모 확인이 먼저, 아니면 직원 확인(2026-11-17). 둘 다 아니면 시작하지 않는다.
    const actor = await resolveLinkActor();
    if (!actor) return loginError(request, "로그인한 뒤 연결해 주세요.", null);
    // 직원은 주소(GET)만으로 연결을 시작하지 않는다(2026-11-17 보안 검수 반영) — 관리자로 로그인한 브라우저에서
    // 남이 보낸 링크를 눌러도 연결 절차가 시작되지 않게. 직원 화면의 «연결하기»는 아래 POST(출처 확인)로 온다.
    if (actor === "staff") return loginError(request, "", actor, "start");
    const callbackUrl = new URL("/auth/callback", publicSiteOrigin(request.nextUrl.origin));
    callbackUrl.searchParams.set("provider", provider);
    callbackUrl.searchParams.set("intent", "link");
    const { data, error } = await supabase.auth.linkIdentity({
      provider: toSupabaseProvider(provider),
      options: { redirectTo: callbackUrl.toString(), skipBrowserRedirect: true },
    });
    if (error || !data.url) {
      return loginError(request, `${PARENT_OAUTH_LABELS[provider]} 연결을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.`, actor, "start");
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

/**
 * 연결 시작(폼 POST) — 직원 연결 화면의 «연결하기»가 여기로 온다(2026-11-17 보안 검수 반영).
 * GET 과 다른 점: 다른 사이트가 몰래 시작시키지 못하게 «출처»를 먼저 확인한다. 연결(intent=link) 전용이다.
 * 직원 전용은 아니다 — 본인 확인을 통과한 사람이면 누구든 받는다(GET 보다 안전한 길이라 막을 이유가 없다).
 *
 * 순서: 연결 요청인지 → 출처 확인 → 제공자 확인(이름·켜짐) → 본인 확인 → linkIdentity → 제공자 화면으로 303.
 * 돌려보낼 때는 전부 303(폼 POST 뒤 GET — 새로고침해도 다시 보내지 않는다).
 */
export async function POST(request: NextRequest, context: RouteContext) {
  // 1. 연결 요청만 받는다(주소 또는 폼 본문의 intent). 로그인·가입은 POST 로 시작하지 않는다.
  let intentValue = request.nextUrl.searchParams.get("intent");
  if (intentValue === null) {
    const form = await request.formData().catch(() => null);
    const field = form?.get("intent");
    intentValue = typeof field === "string" ? field : null;
  }
  if (intentValue !== "link") return new NextResponse(null, { status: 405, headers: { Allow: "GET" } });

  // 2. 출처 확인 — 앱 연결 시작(/auth/link-handoff/start)과 같은 판정 함수 하나를 쓴다.
  //    거절해도 돌아갈 화면은 로그인한 계정으로 정한다(읽기만 한다 — 연결은 시작하지 않는다).
  if (!isAllowedLinkHandoffOrigin(request.headers.get("origin"), request.nextUrl.origin, request.headers.get("sec-fetch-site"))) {
    return linkErrorRedirect(
      request,
      await resolveLinkActor(),
      "이 화면에서 바로 시작할 수 없습니다. 연결 화면에서 다시 눌러 주세요.",
      "origin",
      303,
    );
  }

  // 3. 제공자 확인(GET 과 같은 판정)
  const { provider: rawProvider } = await context.params;
  const provider = parseParentOAuthProvider(rawProvider);
  if (!provider) {
    return linkErrorRedirect(request, await resolveLinkActor(), "지원하지 않는 간편가입 방식입니다.", "failed", 303);
  }
  if (!(await getEnabledParentOAuthProviders()).includes(provider)) {
    return linkErrorRedirect(request, await resolveLinkActor(), parentOAuthNotReadyMessage(provider), "closed", 303);
  }

  // 4. 본인 확인 — 학부모 → 직원 순(GET 과 같은 함수). 둘 다 아니면 시작하지 않는다.
  const linkActor = await resolveLinkActor();
  if (!linkActor) return linkErrorRedirect(request, null, "로그인한 뒤 연결해 주세요.", "failed", 303);

  // 5. 로그인한 그 계정에 붙인다(새 로그인을 하지 않는다)
  const supabase = await createClient();
  const callbackUrl = new URL("/auth/callback", publicSiteOrigin(request.nextUrl.origin));
  callbackUrl.searchParams.set("provider", provider);
  callbackUrl.searchParams.set("intent", "link");
  const { data, error } = await supabase.auth.linkIdentity({
    provider: toSupabaseProvider(provider),
    options: { redirectTo: callbackUrl.toString(), skipBrowserRedirect: true },
  });
  if (error || !data.url) {
    return linkErrorRedirect(
      request,
      linkActor,
      `${PARENT_OAUTH_LABELS[provider]} 연결을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.`,
      "start",
      303,
    );
  }
  return NextResponse.redirect(data.url, 303);
}
