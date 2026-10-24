import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { getRegularShuttleStops } from "@/lib/shuttle/regularImport";
import { diffRegularShuttleMonths } from "@/lib/regular/regularShuttleDiff";

export const dynamic = "force-dynamic";

// 정규 셔틀 운행리스트 조회(원장 전용).
export async function GET(request: Request) {
  try {
    await requireAdmin();
    const url = new URL(request.url);
    const month = url.searchParams.get("month") ?? undefined;
    const compareTo = url.searchParams.get("compareTo") ?? undefined;
    const data = await getRegularShuttleStops(month);
    const comparison = compareTo
      ? diffRegularShuttleMonths((await getRegularShuttleStops(compareTo)).stops, data.stops)
      : [];
    return NextResponse.json({ ...data, comparison, compareTo: compareTo ?? null }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[regular GET]", e);
    return NextResponse.json({ error: "불러오지 못했습니다." }, { status: 401 });
  }
}
