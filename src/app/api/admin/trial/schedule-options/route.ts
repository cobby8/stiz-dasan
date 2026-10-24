import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { listTrialScheduleOptionsForDate, TrialScheduleResolutionError } from "@/lib/trial-schedule-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  }
  try {
    const date = request.nextUrl.searchParams.get("date") || "";
    const options = await listTrialScheduleOptionsForDate(date);
    return NextResponse.json({ options }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TrialScheduleResolutionError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("[trial schedule options] failed:", error);
    return NextResponse.json({ error: "해당 날짜의 수업을 불러오지 못했습니다." }, { status: 500 });
  }
}
