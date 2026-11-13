import { NextRequest, NextResponse } from "next/server";
import { processPushOutbox } from "@/lib/push-outbox";
import { withCronAlert } from "@/lib/cron/withCronAlert";
import { sweepAbsenceParentNotices } from "@/lib/regular/absence-parent-notice-sweep";

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
  const result = await processPushOutbox(50);
  console.log(`[cron/push-outbox] processed=${result.processed} sent=${result.sent} partial=${result.partial} skipped=${result.skipped} retry=${result.retried} failed=${result.failed} absence=${absence ? `${absence.delivered}/${absence.candidates}` : "error"}`);
  return NextResponse.json({ success: result.failed === 0, ...result, absence });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("push-outbox", handleGet);
