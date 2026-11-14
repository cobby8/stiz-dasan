import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  PARENT_OAUTH_LABELS,
  parseParentOAuthProvider,
  safeInternalRedirect,
  type ParentOAuthProvider,
} from "@/lib/parent-oauth";
import { createClient } from "@/lib/supabase/server";
import { linkEnrollmentAccount } from "@/lib/enrollment-account-handoff";
import { socialLinkNoticeBody } from "@/lib/account/social-link";
import { notifyAccountSecurityEvent } from "@/lib/account/social-link-notify";
import { cookies } from "next/headers";
import {
  LINK_HANDOFF_GATE_COOKIE,
  LINK_HANDOFF_GATE_COOKIE_PATH,
  LINK_HANDOFF_VIA,
  linkHandoffDonePath,
  maskAccountLabel,
  type LinkDoneErrorCode,
} from "@/lib/account-link-handoff/rules";
import { linkHandoffAccountLabel } from "@/lib/account-link-handoff/store";

type OAuthIntent = "login" | "parent-signup";

function signupRedirect(request: NextRequest, error?: string) {
  const url = new URL("/signup/parent", request.url);
  url.searchParams.set("social", "1");
  const next = safeInternalRedirect(request.nextUrl.searchParams.get("next"));
  url.searchParams.set("next", next);
  const handoff = request.nextUrl.searchParams.get("handoff")
    || request.nextUrl.searchParams.get("enrollmentHandoff");
  if (handoff) url.searchParams.set("enrollmentHandoff", handoff);
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url);
}

function authFailureRedirect(request: NextRequest, error: string) {
  const intent: OAuthIntent =
    request.nextUrl.searchParams.get("intent") === "login" ? "login" : "parent-signup";
  if (intent !== "login") return signupRedirect(request, error);

  const url = new URL("/login", request.url);
  const next = safeInternalRedirect(request.nextUrl.searchParams.get("next"));
  url.searchParams.set("error", error);
  if (next !== "/mypage") url.searchParams.set("redirect", next);
  const handoff = request.nextUrl.searchParams.get("handoff")
    || request.nextUrl.searchParams.get("enrollmentHandoff");
  if (handoff) url.searchParams.set("enrollmentHandoff", handoff);
  return NextResponse.redirect(url);
}

/** 마이페이지 「간편로그인 연결」로 돌아간다. 성공이면 linked, 실패면 error 를 붙인다. */
function loginMethodsPageRedirect(request: NextRequest, result: { linked?: string; error?: string }) {
  const url = new URL("/mypage/login-methods", request.url);
  if (result.linked) url.searchParams.set("linked", result.linked);
  if (result.error) url.searchParams.set("error", result.error);
  return NextResponse.redirect(url);
}

/**
 * 앱에서 넘어온 연결(2026-11-15 A안)의 마무리 — 결과와 상관없이 이 바깥 브라우저의 로그인을 지우고
 * (scope local = 이 브라우저 세션만. 앱 쪽 로그인은 그대로) 완료 화면으로 보낸다. 표시 쿠키도 지운다.
 * 마이페이지로 보내지 않는 이유: 이 브라우저는 앱이 아니라서, 로그인이 남아 있으면 휴대폰 브라우저에 계정이 열린 채 남는다.
 * 완료 화면에는 문장 대신 코드(e)만, 성공이면 가린 아이디(acct)만 싣는다.
 */
async function appLinkDoneRedirect(
  request: NextRequest,
  result: { linked?: ParentOAuthProvider; authUserId?: string; code?: LinkDoneErrorCode },
) {
  let account: string | undefined;
  if (result.linked && result.authUserId) {
    const row = await linkHandoffAccountLabel(result.authUserId).catch(() => null);
    account = row ? maskAccountLabel(row) : undefined;
  }
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
  const cookieStore = await cookies();
  cookieStore.set(LINK_HANDOFF_GATE_COOKIE, "", { path: LINK_HANDOFF_GATE_COOKIE_PATH, maxAge: 0 });
  return NextResponse.redirect(new URL(linkHandoffDonePath({ linked: result.linked, account, code: result.code }), request.url));
}

/**
 * 간편로그인 연결(intent=link)을 마무리한다. 연결은 로그인한 그 계정에 붙으므로 계정을 새로 찾지 않는다.
 * 앱에서 시작한 연결 = 주소 via=app «그리고» 시작 단계가 구운 표시 쿠키가 있을 때만(검수 반영).
 * 쿠키가 없으면 via=app 이 붙어 있어도 기존 웹 흐름 그대로 마이페이지 연결 화면으로 간다.
 */
async function finishLink(request: NextRequest, code: string | null, provider: ParentOAuthProvider | null) {
  const viaAppParam = request.nextUrl.searchParams.get("via") === LINK_HANDOFF_VIA;
  // 실패 경로(세션이 생기지 않음)는 표시 쿠키까지 있어야 앱 마무리 — 남이 via=app 링크로 로그아웃시키는 것을 막는다.
  const viaApp = viaAppParam && request.cookies.get(LINK_HANDOFF_GATE_COOKIE)?.value === "1";
  // 결과 화면 고르기 — 앱에서 왔으면 완료 화면(+이 브라우저 로그아웃), 아니면 기존처럼 마이페이지 연결 화면
  const fail = (doneCode: LinkDoneErrorCode, message: string) =>
    viaApp ? appLinkDoneRedirect(request, { code: doneCode }) : loginMethodsPageRedirect(request, { error: message });
  if (!provider) return fail("failed", "연결 정보가 올바르지 않습니다. 다시 시도해 주세요.");
  const label = PARENT_OAUTH_LABELS[provider];
  // Supabase 는 연결을 거절하면 code 대신 오류를 붙여 돌려보낸다.
  const errorCode = request.nextUrl.searchParams.get("error_code") || "";
  if (!code) {
    if (errorCode === "identity_already_exists") {
      return fail("already", `이 ${label} 계정은 이미 다른 계정에 연결되어 있습니다. 학원에 문의해 주세요.`);
    }
    return fail("cancelled", `${label} 연결이 취소되었거나 완료되지 않았습니다.`);
  }
  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) return fail("expired", `${label} 연결 시간이 만료되었습니다. 다시 시도해 주세요.`);
  await notifyAccountSecurityEvent({ authUserId: data.user?.id, eventType: "SOCIAL_LOGIN_LINKED", body: socialLinkNoticeBody(label) });
  // 성공 경로는 via=app 만으로 앱 마무리(보안 재검수 반영) — 코드 교환 성공 자체가 이 브라우저에서 start 가 시작한
  // 흐름이라는 증거다(via=app redirectTo 는 start 만 만들고, 교환에는 이 브라우저의 PKCE 열쇠가 있어야 한다).
  // 표시 쿠키(10분)가 만료된 뒤 연결을 마쳐도 이 브라우저에 로그인이 남지 않게 한다.
  return viaAppParam
    ? appLinkDoneRedirect(request, { linked: provider, authUserId: data.user?.id })
    : loginMethodsPageRedirect(request, { linked: provider });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const provider = parseParentOAuthProvider(request.nextUrl.searchParams.get("provider") || "");
  if (request.nextUrl.searchParams.get("intent") === "link") return finishLink(request, code, provider);
  const next = safeInternalRedirect(request.nextUrl.searchParams.get("next"));
  const enrollmentHandoff = request.nextUrl.searchParams.get("handoff")
    || request.nextUrl.searchParams.get("enrollmentHandoff");

  if (!code || !provider) {
    return authFailureRedirect(request, "간편가입 인증 정보가 올바르지 않습니다. 다시 시도해 주세요.");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return authFailureRedirect(request, "간편가입 인증 시간이 만료되었거나 취소되었습니다.");
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return authFailureRedirect(request, "간편가입 정보를 확인하지 못했습니다.");

  // Authorization is based on the application DB, never OAuth user metadata.
  // A social session alone is intentionally insufficient for parent access.
  const users = await prisma.$queryRawUnsafe<
    Array<{ id: string; role: string; username: string | null; phoneVerifiedAt: Date | null }>
  >(
    `SELECT id, role::text AS role, username, "phoneVerifiedAt"
       FROM "User"
      WHERE "authUserId" = $1 OR ("authUserId" IS NULL AND id = $1)
      ORDER BY CASE WHEN "authUserId" = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    user.id,
  );
  const appUser = users[0];

  if (appUser?.role === "PARENT" && (appUser.phoneVerifiedAt || appUser.username === null)) {
    if (enrollmentHandoff) {
      try {
        await linkEnrollmentAccount({
          token: enrollmentHandoff,
          parentUserId: appUser.id,
        });
      } catch (linkError) {
        await supabase.auth.signOut();
        return authFailureRedirect(
          request,
          linkError instanceof Error
            ? linkError.message
            : "수강신청서를 계정에 연결하지 못했습니다.",
        );
      }
    }
    const url = new URL("/auth/continue", request.url);
    url.searchParams.set("redirect", enrollmentHandoff ? "/mypage" : next);
    return NextResponse.redirect(url);
  }

  const url = new URL("/signup/parent", request.url);
  url.searchParams.set("social", "1");
  url.searchParams.set("provider", provider);
  url.searchParams.set("next", next);
  if (enrollmentHandoff) url.searchParams.set("enrollmentHandoff", enrollmentHandoff);
  return NextResponse.redirect(url);
}
