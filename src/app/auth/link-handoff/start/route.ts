import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { getEnabledParentOAuthProviders } from "@/lib/auth-providers";
import { nativeAuthEnabled } from "@/lib/native-auth/policy";
import { parseParentOAuthProvider, publicSiteOrigin, toSupabaseProvider } from "@/lib/parent-oauth";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import {
  LINK_HANDOFF_GATE_COOKIE,
  LINK_HANDOFF_GATE_COOKIE_MAX_AGE,
  LINK_HANDOFF_GATE_COOKIE_PATH,
  LINK_HANDOFF_PATH,
  LINK_HANDOFF_VIA,
  isAllowedLinkHandoffOrigin,
  isLinkHandoffEligible,
  isSupabaseSessionCookieName,
  supabaseSessionCookieNames,
  type LinkHandoffErrorCode,
} from "@/lib/account-link-handoff/rules";
import { isLinkHandoffToken } from "@/lib/account-link-handoff/token";
import { consumeLinkHandoff, linkHandoffAccountRows } from "@/lib/account-link-handoff/store";

/**
 * 앱 «연결하기» 시작(2026-11-15 A안) — 바깥 브라우저 확인 화면의 [계속](폼 POST)이 여기로 온다.
 *
 * 순서가 중요하다:
 *  1. 출처(Origin) 확인 — 다른 사이트가 몰래 보낸 폼이면 거절(Origin null 은 Sec-Fetch-Site same-origin 일 때만)
 *  2. 앱 로그인 스위치·토큰 모양 확인(표를 쓰기 전에)
 *  3. 표를 «딱 한 번» 쓴다(조건부 UPDATE) — 두 번 눌러도 한쪽만 성공
 *  4. 계정 재확인(학부모 하나·직원 역할 없음·휴대폰 인증·탈퇴 아님) + 제공자가 지금도 켜져 있는지
 *  5. 표 주인 계정으로 잠깐 로그인(서버가 만든 1회용 로그인 토큰 — 메일은 보내지 않는다)
 *  6. 로그인된 계정이 표 주인과 같은지 확인 → 아니면 즉시 로그아웃
 *  7. linkIdentity 로 제공자 화면 주소를 받는다(PKCE 열쇠 쿠키가 이 응답에 실린다)
 *  8. 받은 «즉시» 이 로그인 세션을 서버에서 끊고(관리자 signOut local) 세션 쿠키만 지운다.
 *     → 학부모가 제공자 화면에서 그냥 떠나도 이 브라우저에 쓸 수 있는 로그인이 남지 않는다.
 *     PKCE 열쇠 쿠키(…-code-verifier)는 남긴다 — 콜백의 exchangeCodeForSession 은 그 열쇠만 읽는다
 *     (auth-js _exchangeCodeForSession: storage 의 `${storageKey}-code-verifier` 만 읽어 /token?grant_type=pkce).
 *     ⚠️ supabase.auth.signOut() 을 쓰면 안 된다 — 그 함수는 열쇠 쿠키까지 지운다.
 *  9. «앱에서 시작한 연결» 표시 쿠키를 굽는다 — 콜백은 via=app + 이 쿠키가 있을 때만 앱 마무리를 한다.
 * 3 이후 예외는 전부 e=failed 로 돌려보낸다(500 화면 대신 안내).
 */

function backToConfirm(request: NextRequest, code: LinkHandoffErrorCode) {
  const url = new URL(LINK_HANDOFF_PATH, request.url);
  url.searchParams.set("e", code);
  // 303 = 폼 POST 뒤 GET 으로 보낸다(새로고침해도 다시 보내지 않게)
  return NextResponse.redirect(url, 303);
}

export async function POST(request: NextRequest) {
  // 1. 출처 확인
  if (!isAllowedLinkHandoffOrigin(request.headers.get("origin"), request.nextUrl.origin, request.headers.get("sec-fetch-site"))) {
    return backToConfirm(request, "origin");
  }

  // 2. 스위치·토큰 모양
  if (!nativeAuthEnabled()) return backToConfirm(request, "closed");
  const form = await request.formData().catch(() => null);
  const token = form?.get("t");
  if (!isLinkHandoffToken(token)) return backToConfirm(request, "expired");

  // 3. 1회 사용
  const claim = await consumeLinkHandoff(token).catch(() => null);
  if (!claim) return backToConfirm(request, "expired");

  try {
    return await startLink(request, claim);
  } catch (error) {
    console.error("[link-handoff start] failed:", error instanceof Error ? error.message : "UNKNOWN");
    // 예외로 빠져도 verifyOtp 가 구운 세션 쿠키가 응답에 남지 않게 지운다(보안 재검수 반영).
    await clearSessionCookies().catch(() => undefined);
    return backToConfirm(request, "failed");
  }
}

/** 이 브라우저의 Supabase 세션 쿠키만 지운다(PKCE 열쇠 쿠키는 남긴다). path "/" 로 지워야 실제 쿠키가 지워진다. */
async function clearSessionCookies() {
  const cookieStore = await cookies();
  const sessionCookies = new Set([
    ...supabaseSessionCookieNames(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""),
    ...cookieStore.getAll().map((cookie) => cookie.name).filter(isSupabaseSessionCookieName),
  ]);
  for (const name of sessionCookies) cookieStore.set(name, "", { path: "/", maxAge: 0 });
}

async function startLink(request: NextRequest, claim: { authUserId: string; provider: string }) {
  const provider = parseParentOAuthProvider(claim.provider);
  if (!provider) return backToConfirm(request, "failed");

  // 4. 계정 재확인(발급 뒤 직원 역할이 붙었거나 탈퇴 요청했을 수 있다) + 제공자 켜짐 재확인
  if (!isLinkHandoffEligible(await linkHandoffAccountRows(claim.authUserId))) return backToConfirm(request, "account");
  if (!(await getEnabledParentOAuthProviders()).includes(provider)) return backToConfirm(request, "closed");

  // 5. 표 주인 계정의 1회용 로그인 토큰(메일 발송 없음) — /api/auth/parent-link/verify 와 같은 방식
  const admin = createAdminClient();
  const owner = await admin.auth.admin.getUserById(claim.authUserId);
  const ownerEmail = owner.data.user?.email;
  if (owner.error || !ownerEmail) return backToConfirm(request, "failed");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email: ownerEmail });
  const tokenHash = link.data.properties?.hashed_token;
  if (!tokenHash) return backToConfirm(request, "failed");

  const supabase = await createClient();
  // type 은 기존 운영 경로(parent-link/verify)와 같은 "magiclink"(supabase-js 2.98 의 EmailOtpType 에 있음)
  const signedIn = await supabase.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  // 6. 다른 계정이 잡히면 즉시 로그아웃(이 브라우저만)
  if (signedIn.error || signedIn.data.user?.id !== claim.authUserId || !signedIn.data.session) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    return backToConfirm(request, "failed");
  }
  const accessToken = signedIn.data.session.access_token;

  // 7. 제공자 연결 주소
  const callbackUrl = new URL("/auth/callback", publicSiteOrigin(request.nextUrl.origin));
  callbackUrl.searchParams.set("provider", provider);
  callbackUrl.searchParams.set("intent", "link");
  callbackUrl.searchParams.set("via", LINK_HANDOFF_VIA);
  const { data, error } = await supabase.auth.linkIdentity({
    provider: toSupabaseProvider(provider),
    options: { redirectTo: callbackUrl.toString(), skipBrowserRedirect: true },
  });
  if (error || !data.url) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    return backToConfirm(request, "failed");
  }

  // 8. 이 세션을 서버에서 끊는다(이 세션만 — 앱 쪽 로그인 세션은 그대로). 실패하면 진행하지 않는다.
  const revoked = await admin.auth.admin.signOut(accessToken, "local");
  if (revoked.error) {
    await supabase.auth.signOut({ scope: "local" }).catch(() => undefined);
    return backToConfirm(request, "failed");
  }
  await clearSessionCookies();
  const cookieStore = await cookies();

  // 9. 앱 연결 표시 쿠키(콜백에서만 읽힌다)
  cookieStore.set(LINK_HANDOFF_GATE_COOKIE, "1", {
    path: LINK_HANDOFF_GATE_COOKIE_PATH,
    maxAge: LINK_HANDOFF_GATE_COOKIE_MAX_AGE,
    httpOnly: true,
    secure: request.nextUrl.protocol === "https:",
    sameSite: "lax",
  });
  return NextResponse.redirect(data.url, 303);
}
