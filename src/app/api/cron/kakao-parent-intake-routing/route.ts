import { NextRequest, NextResponse } from "next/server";
import { routeSubmittedKakaoIntakes } from "@/lib/kakao-parent-intake-routing";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const result = await routeSubmittedKakaoIntakes(20);
  return NextResponse.json({ success: result.failed === 0, ...result });
}
