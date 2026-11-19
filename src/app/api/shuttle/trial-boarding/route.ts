import { NextResponse } from "next/server";
import { isAnyDriverRunToken } from "@/lib/shuttle/driverToken";
import { readDriverBoarding } from "@/lib/shuttle/driverStatusRead";
// 운행 링크 스위치(원장이 끄면 토큰만으로는 못 연다 — 셔틀 권한 있는 로그인 사용자만 통과)
import { driverLinkBlocked, driverLinkDisabledResponse } from "@/lib/shuttle/driverLinkAccess";
import { setTrialBoarding } from "@/lib/shuttle/trialShuttle";
import { isKstYmd, todayKst } from "@/lib/datetime/kst";

export const dynamic = "force-dynamic";

// 체험 셔틀 탑승/미탑승 체크(기사님 운행 링크 화면, 2026-11-19).
// 정규 탑승 체크(/api/shuttle/regular-boarding)와 같은 문지기(운행 토큰 + 운행 링크 스위치)·같은 응답 모양이다.
// 저장 키는 하루 탑승 id(TrialShuttleRide.id), ShuttleBoarding 의 direction 은 'TRIAL'.
// 그날 운행표에 실제로 나오는 체험 줄만 받는다(풀린 배정·다른 날짜 줄은 404).

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!(await isAnyDriverRunToken(url.searchParams.get("token") ?? ""))) return NextResponse.json({ error: "유효하지 않은 링크입니다." }, { status: 403 });
  if (await driverLinkBlocked()) return driverLinkDisabledResponse();
  const date = url.searchParams.get("date");
  if (typeof date !== "string" || !isKstYmd(date)) return NextResponse.json({ error: "날짜를 확인해주세요." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...await readDriverBoarding(date, "TRIAL") }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "저장 상태를 조회하지 못했습니다." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { token?: unknown; rideId?: unknown; status?: unknown; date?: unknown }
      | null;
    const token = typeof body?.token === "string" ? body.token : "";
    const rideId = typeof body?.rideId === "string" ? body.rideId.trim() : "";
    if (!token || !rideId || rideId.length > 128) return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
    if (!(await isAnyDriverRunToken(token))) return NextResponse.json({ error: "유효하지 않은 링크입니다." }, { status: 403 });
    if (await driverLinkBlocked()) return driverLinkDisabledResponse();
    // 허용값: BOARDED/NOSHOW/SELF(자차) + null(대기). 그 외는 null 로 수렴(정규 체크와 같다).
    const status = body?.status === "BOARDED" || body?.status === "NOSHOW" || body?.status === "SELF" ? body.status : null;
    // 화면이 표시하는 날짜에 저장한다. 없으면 오늘(KST).
    const date = typeof body?.date === "string" && isKstYmd(body.date) ? body.date : todayKst();
    const result = await setTrialBoarding({ date, rideId, status });
    if (!result.ok) return NextResponse.json({ error: "배정이 바뀌었어요. 운행표를 다시 열어 주세요." }, { status: 409 });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "저장하지 못했습니다." }, { status: 500 });
  }
}
