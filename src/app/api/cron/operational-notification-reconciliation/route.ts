import { NextResponse } from "next/server";
import { reconcileOperationalNotifications } from "@/lib/operational-notification-reconciliation";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, ...await reconcileOperationalNotifications(20) });
}
