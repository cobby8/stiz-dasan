import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { requireOwner } from "@/lib/auth-guard";
import { buildYoutubeAuthUrl, readYoutubeConfig, siteOrigin, YOUTUBE_STATE_COOKIE } from "@/lib/youtube/config";

export const dynamic = "force-dynamic";

/**
 * «유튜브 연결» 시작(원장만) — 구글 동의 화면으로 보낸다.
 * state(1회용 무작위 값)를 httpOnly 쿠키에 넣고 구글 주소에도 실어 보낸다.
 * 콜백에서 둘이 같아야만 연결한다(다른 사이트가 연결 요청을 꾸며내는 CSRF 차단).
 */
export async function GET() {
  const origin = siteOrigin(process.env);
  try {
    await requireOwner();
  } catch {
    return NextResponse.redirect(`${origin}/admin/youtube?error=owner_only`, 303);
  }
  const config = readYoutubeConfig();
  if (!config.ready) return NextResponse.redirect(`${origin}/admin/youtube?error=config`, 303);

  const state = randomBytes(32).toString("base64url");
  const response = NextResponse.redirect(buildYoutubeAuthUrl({ clientId: config.clientId, redirectUri: config.redirectUri, state }), 303);
  response.cookies.set(YOUTUBE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    // 구글에서 돌아오는 «최상위 이동»에는 Lax 쿠키가 실린다
    sameSite: "lax",
    path: "/api/admin/youtube",
    maxAge: 10 * 60,
  });
  return response;
}
