import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/auth-guard";
import { retryLockedYoutubeVideos } from "@/lib/sessionVideo/youtubeJob";

export const dynamic = "force-dynamic";

/**
 * «다시 시도»(원장만) — 구글 심사 통과 뒤, 비공개로 잠긴(PRIVATE_LOCKED)·실패한(FAILED) 영상을 대기로 돌린다.
 * 다음 cron(15분 안)이 비공개 영상은 «일부공개로 변경»만, 실패 영상은 새로 올린다.
 */
export async function POST() {
  try {
    await requireOwner();
  } catch {
    return NextResponse.json({ error: "원장만 다시 시도할 수 있습니다." }, { status: 403 });
  }
  const count = await retryLockedYoutubeVideos();
  return NextResponse.json({ ok: true, count });
}
