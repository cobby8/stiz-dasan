import { NextRequest, NextResponse } from "next/server";
import { summarizeOperationsSyncQueue } from "@/lib/operationsSyncWorker";
import { withCronAlert } from "@/lib/cron/withCronAlert";

export const dynamic = "force-dynamic";

async function handleGet(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = Number(request.nextUrl.searchParams.get("limit") || 20);
  const summary = await summarizeOperationsSyncQueue(limit);
  return NextResponse.json({ success: true, ...summary });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("operations-sync", handleGet);
