import { NextRequest, NextResponse } from "next/server";
import { processPushOutbox } from "@/lib/push-outbox";
import { withCronAlert } from "@/lib/cron/withCronAlert";
import { sweepAbsenceParentNotices } from "@/lib/regular/absence-parent-notice-sweep";
import { sweepShuttleBoardingNotices } from "@/lib/shuttle/boardingNoticeSweep";

export const dynamic = "force-dynamic";

async function handleGet(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // f2: 선생님 출석부 «결석» → 몇 분 뒤에도 결석이면 학부모 알림(앱 알림함 + 웹푸시).
  // 결석 알림이 실패해도 원래 일(밀린 푸시 보내기)은 계속한다 — 결석 알림은 다음 분에 다시 고른다.
  let absence: Awaited<ReturnType<typeof sweepAbsenceParentNotices>> | null = null;
  try {
    absence = await sweepAbsenceParentNotices(50);
  } catch (error) {
    console.error("[cron/push-outbox] 결석 알림 훑기 실패", error);
  }
  // 셔틀 «탔어요·내렸어요»: 기사님이 탑승을 찍고 1분 뒤에도 그대로면 대표 보호자에게 알림(앱 알림함 + 푸시).
  // 실패해도 원래 일은 계속한다 — 다음 분에 다시 고른다(30분이 넘은 체크는 보내지 않는다).
  let shuttle: Awaited<ReturnType<typeof sweepShuttleBoardingNotices>> | null = null;
  try {
    shuttle = await sweepShuttleBoardingNotices(50);
  } catch (error) {
    console.error("[cron/push-outbox] 셔틀 탑승 알림 훑기 실패", error);
  }
  const result = await processPushOutbox(50);
  console.log(`[cron/push-outbox] processed=${result.processed} sent=${result.sent} partial=${result.partial} skipped=${result.skipped} retry=${result.retried} failed=${result.failed} absence=${absence ? `${absence.delivered}/${absence.candidates}` : "error"} shuttle=${shuttle ? `${shuttle.delivered}/${shuttle.candidates}` : "error"}`);
  return NextResponse.json({ success: result.failed === 0, ...result, absence, shuttle });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("push-outbox", handleGet);
