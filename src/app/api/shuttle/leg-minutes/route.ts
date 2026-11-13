import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { isAnyDriverRunToken } from "@/lib/shuttle/driverToken";
import { driverLinkBlocked } from "@/lib/shuttle/driverLinkAccess";
import { pairLegMinutesWithTmap } from "@/lib/shuttle/tmap";

export const dynamic = "force-dynamic";

// 정류장 순서를 옮겼을 때 시각 다시 계산용 — 지점 쌍마다 실도로 이동 분(T맵).
// 누가 부르나: 관리자 운행표 편집(로그인 관리자) · 기사님 화면 순서 편집(기사님 운행 링크 토큰).
// 실패한 쌍은 null — 화면이 직선 추정으로 채운다(오류로 막지 않는다).
// 지점 좌표만 오가고 학생 정보는 오가지 않는다.
const MAX_PAIRS = 24; // 한 묶음 정류장 10곳 남짓의 전·후 순서 + 학원 구간이면 충분하다(T맵 호출 수 상한).

type LL = { lat: number; lng: number };
function pt(v: unknown): LL | null {
  const o = v as { lat?: unknown; lng?: unknown } | null;
  const lat = Number(o?.lat), lng = Number(o?.lng);
  // 대한민국 범위 밖 좌표는 받지 않는다(오타·악용 방지).
  return Number.isFinite(lat) && Number.isFinite(lng) && lat > 33 && lat < 39 && lng > 124 && lng < 132 ? { lat, lng } : null;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as { token?: unknown; pairs?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token : "";
  let allowed = false;
  // 기사님 링크 열쇠로 들어온 경우도 운행 링크 스위치(driverLinkBlocked)를 따른다 — 꺼졌으면 셔틀 권한 로그인만 통과.
  if (token) allowed = (await isAnyDriverRunToken(token)) && !(await driverLinkBlocked());
  if (!allowed) {
    try { await requireAdmin(); allowed = true; } catch { allowed = false; }
  }
  if (!allowed) return NextResponse.json({ error: "권한이 필요합니다." }, { status: 401 });

  const raw = Array.isArray(body?.pairs) ? body!.pairs as unknown[] : null;
  if (!raw || raw.length === 0 || raw.length > MAX_PAIRS) {
    return NextResponse.json({ error: "구간 목록을 확인해 주세요." }, { status: 400 });
  }
  const pairs: { a: LL; b: LL }[] = [];
  for (const item of raw) {
    const o = item as { a?: unknown; b?: unknown } | null;
    const a = pt(o?.a), b = pt(o?.b);
    if (!a || !b) return NextResponse.json({ error: "좌표가 올바르지 않습니다." }, { status: 400 });
    pairs.push({ a, b });
  }
  const minutes = await pairLegMinutesWithTmap(pairs);
  return NextResponse.json({ minutes }, { headers: { "Cache-Control": "no-store" } });
}
