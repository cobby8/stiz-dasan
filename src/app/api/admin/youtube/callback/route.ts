import { NextRequest, NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth-guard";
import { grantedUploadScope, readYoutubeConfig, siteOrigin, YOUTUBE_STATE_COOKIE, youtubeStateMatches } from "@/lib/youtube/config";
import { exchangeYoutubeCode, fetchMyChannel, revokeGoogleToken } from "@/lib/youtube/api";
import { saveYoutubeConnection } from "@/lib/youtube/connection";

export const dynamic = "force-dynamic";

/**
 * 구글 동의 후 돌아오는 주소(구글 콘솔 «승인된 리디렉션 URI» 에 이 주소를 넣는다).
 * 원장 로그인 + state 쿠키 일치 → code 를 refresh token 으로 바꿔 «암호화해서» 저장 → 채널 이름 확인.
 * 결과는 /admin/youtube 로 돌려보내 화면에 표시한다(토큰·코드는 주소에 남기지 않는다).
 */
export async function GET(req: NextRequest) {
  const origin = siteOrigin(process.env);
  const back = (query: string) => {
    const response = NextResponse.redirect(`${origin}/admin/youtube?${query}`, 303);
    // state 는 1회용 — 성공·실패와 관계없이 지운다
    response.cookies.set(YOUTUBE_STATE_COOKIE, "", { path: "/api/admin/youtube", maxAge: 0 });
    return response;
  };

  let owner: Awaited<ReturnType<typeof requireOwner>>;
  try {
    owner = await requireOwner();
  } catch {
    return back("error=owner_only");
  }
  const config = readYoutubeConfig();
  if (!config.ready) return back("error=config");

  const params = req.nextUrl.searchParams;
  if (!youtubeStateMatches(params.get("state"), req.cookies.get(YOUTUBE_STATE_COOKIE)?.value)) return back("error=state");
  if (params.get("error")) return back("error=denied");
  const code = params.get("code");
  if (!code || code.length > 2048) return back("error=code");

  try {
    const tokens = await exchangeYoutubeCode({ code, clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri });
    if (!tokens.refreshToken) return back("error=no_refresh");
    if (!grantedUploadScope(tokens.scope)) {
      // 업로드 권한 체크를 빼고 동의한 경우 — 받은 토큰은 바로 무효화한다
      await revokeGoogleToken(tokens.refreshToken);
      return back("error=scope");
    }
    const channel = await fetchMyChannel(tokens.accessToken);
    if (!channel) {
      await revokeGoogleToken(tokens.refreshToken);
      return back("error=no_channel");
    }
    await saveYoutubeConnection({
      channelId: channel.id,
      channelTitle: channel.title,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope,
      connectedByUserId: owner.appUserId,
      encryptionKey: config.encryptionKey,
    });
    return back("connected=1");
  } catch {
    return back("error=exchange");
  }
}
