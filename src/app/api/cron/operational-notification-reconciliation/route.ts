import { NextResponse } from "next/server";
import { reconcileOperationalNotifications } from "@/lib/operational-notification-reconciliation";
import { withCronAlert } from "@/lib/cron/withCronAlert";

async function handleGet(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, ...await reconcileOperationalNotifications(20) });
}

// 실패(예외·500 이상)하면 원장 슬랙으로 한 줄 알림 — 같은 작업은 1시간에 1번(d4)
export const GET = withCronAlert("operational-notification-reconciliation", handleGet);
