import { NextRequest, NextResponse } from "next/server";
import { summarizeOperationsSyncQueue } from "@/lib/operationsSyncWorker";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = Number(request.nextUrl.searchParams.get("limit") || 20);
  const summary = await summarizeOperationsSyncQueue(limit);
  return NextResponse.json({ success: true, ...summary });
}
