import { NextRequest, NextResponse } from "next/server";
import { withCronAlert } from "@/lib/cron/withCronAlert";
import { processYoutubeVideoQueue } from "@/lib/sessionVideo/youtubeJob";

export const dynamic = "force-dynamic";
// 영상 한 개(최대 50MB)를 저장소 → 유튜브로 흘려보내는 시간 + 여유. vercel.json functions 에도 같은 값.
export const maxDuration = 300;

/**
 * 수업 영상 유튜브 이동·저장소 정리(15분마다, vercel.json crons).
 * 할 일은 src/lib/sessionVideo/youtubeJob.ts 맨 위 설명 참고.
 */
async function handleGet(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (process.env.NODE_ENV !== "development"
    && (!secret || req.headers.get("authorization") !== `Bearer ${secret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const startedAt = Date.now();
  // 함수 제한(300초)보다 넉넉히 일찍 새 업로드 시작을 멈춘다
  const result = await processYoutubeVideoQueue({ deadlineMs: startedAt + 240_000 });
  return NextResponse.json({ success: result.failed === 0, ...result });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번
export const GET = withCronAlert("youtube-upload", handleGet);
