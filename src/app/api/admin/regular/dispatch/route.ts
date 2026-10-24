import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { computeRegularDispatch } from "@/lib/regular/shuttle-dispatch";
import type { DispatchDirection } from "@/lib/seasonal/shuttle-optimize";
import { isServiceMonth } from "@/lib/regular/serviceMonth";

export const dynamic = "force-dynamic";

// 정규 셔틀 노선 자동 제안 — 요일(dayOfWeek)·방향 기준. requireAdmin 을 여기서 강제한다.
// RouteSection 은 apiBase 로 이 경로를 호출하며, body.date 자리에 요일 문자열("Mon" 등)을 넣어 보낸다.
export async function POST(request: Request) {
  try {
    await requireAdmin();
    const body = await request.json().catch(() => ({})) as { direction?: string; date?: string | null; serviceMonth?: string | null };
    if (!(["PICKUP", "DROPOFF"].includes(body.direction ?? ""))
      || !(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].includes(body.date ?? ""))
      || (body.serviceMonth != null && !isServiceMonth(body.serviceMonth))) {
      return NextResponse.json({ error: "요일·방향·적용 월 형식이 올바르지 않습니다." }, { status: 400 });
    }
    const direction: DispatchDirection = body.direction === "DROPOFF" ? "DROPOFF" : "PICKUP";
    // RouteSection 의 date prop = 요일 문자열. computeRegularDispatch 는 dayOfWeek 로 받는다.
    const suggestion = await computeRegularDispatch({ direction, dayOfWeek: body.date ?? undefined, serviceMonth: body.serviceMonth ?? undefined });
    return NextResponse.json(suggestion, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("[regular dispatch POST]", e);
    return NextResponse.json({ error: "노선 제안을 만들지 못했습니다." }, { status: 500 });
  }
}
