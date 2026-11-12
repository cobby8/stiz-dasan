import { NextRequest, NextResponse } from "next/server";
import { processPushOutbox } from "@/lib/push-outbox";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";

async function handleGet(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await processPushOutbox(50);
  console.log(`[cron/push-outbox] processed=${result.processed} sent=${result.sent} partial=${result.partial} skipped=${result.skipped} retry=${result.retried} failed=${result.failed}`);
  return NextResponse.json({ success: result.failed === 0, ...result });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("push-outbox", handleGet);
