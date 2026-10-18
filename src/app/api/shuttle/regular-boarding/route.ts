import { NextResponse } from "next/server";
import { setRegularBoarding, type BoardingStatus } from "@/lib/shuttle/regularRun";
// 기사님 화면이 하나로 합쳐져(그날 특강+정규 한 목록), 어느 쪽 링크로 열어도 정규 행을 체크할 수 있어야 한다.
// 판정 함수 자체는 기존 것(isRegularRunToken / resolveRunToken)을 그대로 쓴다.
import { isAnyDriverRunToken } from "@/lib/shuttle/driverToken";
import { readDriverBoarding } from "@/lib/shuttle/driverStatusRead";

export const dynamic = "force-dynamic";

// 정규 셔틀 탑승/미탑승 체크(기사님 화면). 로그인 없이 토큰으로 접근하므로, 유효한 정규 토큰인지 먼저 확인한다.
// 날짜는 화면이 표시 중인 날짜(date)에 맞춰 저장한다. 없으면 서버 '오늘(KST)'로 폴백.
function todayKST(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
// 클라가 보낸 date(YYYY-MM-DD)는 신뢰하지 않고 서버에서 형식+달력 유효성을 검증한다.
// 토큰이 관리자 인증을 대신하므로, 유효한 날짜면 어떤 날이든 허용한다.
function validDate(s: unknown): string | null {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00+09:00`);
  const ok = !Number.isNaN(d.getTime()) &&
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(d) === s;
  return ok ? s : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  if (!(await isAnyDriverRunToken(url.searchParams.get("token") ?? ""))) return NextResponse.json({ error: "유효하지 않은 링크입니다." }, { status: 403 });
  const date = validDate(url.searchParams.get("date"));
  if (!date) return NextResponse.json({ error: "날짜를 확인해주세요." }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...await readDriverBoarding(date, "REGULAR") }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "저장 상태를 조회하지 못했습니다." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { token?: string; rowId?: string; status?: BoardingStatus | null; studentName?: string | null; date?: string | null }
      | null;
    const token = typeof body?.token === "string" ? body.token : "";
    const rowId = typeof body?.rowId === "string" ? body.rowId : "";
    if (!token || !rowId) return NextResponse.json({ error: "요청 형식이 올바르지 않습니다." }, { status: 400 });
    if (!(await isAnyDriverRunToken(token))) return NextResponse.json({ error: "유효하지 않은 링크입니다." }, { status: 403 });
    // 허용값 확장: BOARDED/NOSHOW/SELF(자차) + null(대기). 그 외는 null로 수렴.
    const status =
      body?.status === "BOARDED" || body?.status === "NOSHOW" || body?.status === "SELF" ? body.status : null;
    // 화면이 표시하는 날짜(date)에 저장한다. 유효하면 그 날, 없으면 오늘(KST)로 폴백.
    const date = validDate(body?.date) ?? todayKST();
    await setRegularBoarding({ date, rowId, status, studentName: body?.studentName ?? null });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "저장하지 못했습니다." }, { status: 500 });
  }
}
