import { NextRequest, NextResponse } from "next/server";
import { dispatchDueUniformOrders } from "@/lib/uniform-order-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const result = await dispatchDueUniformOrders(5);
  return NextResponse.json({ success: result.review === 0, ...result });
}
