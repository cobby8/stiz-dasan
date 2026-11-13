import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth-guard";
import { readYoutubeConfig } from "@/lib/youtube/config";
import { deleteYoutubeConnection, getYoutubeConnection } from "@/lib/youtube/connection";
import { openYoutubeToken } from "@/lib/youtube/tokenCrypto";
import { revokeGoogleToken } from "@/lib/youtube/api";

export const dynamic = "force-dynamic";

/**
 * «연결 해제»(원장만) — 구글 쪽 토큰을 무효화하고 우리 쪽 연결 행을 지운다.
 * 이미 유튜브에 올라간 영상은 지우지 않는다(학부모 재생은 계속된다). 새 업로드만 멈춘다.
 */
export async function POST() {
  try {
    await requireOwner();
  } catch {
    return NextResponse.json({ error: "원장만 유튜브 연결을 바꿀 수 있습니다." }, { status: 403 });
  }
  const connection = await getYoutubeConnection();
  const config = readYoutubeConfig();
  if (connection && config.ready) {
    try {
      await revokeGoogleToken(openYoutubeToken(connection.refreshTokenEncrypted, config.encryptionKey));
    } catch {
      // 토큰을 못 풀어도(키 변경) 우리 쪽 삭제는 진행한다
    }
  }
  await deleteYoutubeConnection();
  return NextResponse.json({ ok: true });
}
