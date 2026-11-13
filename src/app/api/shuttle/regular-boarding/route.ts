import { NextResponse } from "next/server";
import { setRegularBoarding, type BoardingStatus } from "@/lib/shuttle/regularRun";
// 기사님 화면이 하나로 합쳐져(그날 특강+정규 한 목록), 어느 쪽 링크로 열어도 정규 행을 체크할 수 있어야 한다.
// 판정 함수 자체는 기존 것(isRegularRunToken / resolveRunToken)을 그대로 쓴다.
import { isAnyDriverRunToken } from "@/lib/shuttle/driverToken";
import { readDriverBoarding } from "@/lib/shuttle/driverStatusRead";
// 운행 링크 스위치(원장이 끄면 토큰만으로는 못 연다 — 셔틀 권한 있는 로그인 사용자만 통과)
import { driverLinkBlocked, driverLinkDisabledResponse } from "@/lib/shuttle/driverLinkAccess";
// 휴원·퇴원·첫 수업 전·휴무 줄 잠금 — 기사님 화면과 같은 함수(getRegularDriverClasses → 줄의 blockedLabel)로 판정한다.
import { getRegularDriverClasses } from "@/lib/shuttle/regularDriverRoute";
import { boardingRejectedForBlock } from "@/lib/shuttle/regularRunDayRules";

/**
 * 그날 운행표에서 이 줄의 잠금 뱃지(없으면 null). 운행표를 못 읽거나 줄을 못 찾으면 null —
 * 종전처럼 저장한다(이 확인 때문에 멀쩡한 체크가 막히면 기사님이 아이를 기록 못 한다).
 */
async function blockedLabelOf(date: string, rowId: string): Promise<string | null> {
  try {
    const classes = await getRegularDriverClasses(date);
    const row = classes.flatMap(({ board, alight }) => [...board, ...alight]).flatMap(({ rows }) => rows).find((r) => r.rowId === rowId);
    return row?.blockedLabel ?? null;
  } catch {
    return null;
  }
}

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
  if (await driverLinkBlocked()) return driverLinkDisabledResponse();
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
    if (await driverLinkBlocked()) return driverLinkDisabledResponse();
    // 허용값 확장: BOARDED/NOSHOW/SELF(자차) + null(대기). 그 외는 null로 수렴.
    const status =
      body?.status === "BOARDED" || body?.status === "NOSHOW" || body?.status === "SELF" ? body.status : null;
    // 화면이 표시하는 날짜(date)에 저장한다. 유효하면 그 날, 없으면 오늘(KST)로 폴백.
    const date = validDate(body?.date) ?? todayKST();
    // 잠긴 줄에는 «대기로 되돌리기»(null)만 받는다 — 되돌리기는 확인 없이 바로 통과시킨다(조회 비용도 아낀다).
    if (status !== null) {
      const blockedLabel = await blockedLabelOf(date, rowId);
      if (boardingRejectedForBlock(blockedLabel, status)) {
        return NextResponse.json({ error: `${blockedLabel} 학생은 체크하지 않습니다.` }, { status: 409 });
      }
    }
    await setRegularBoarding({ date, rowId, status, studentName: body?.studentName ?? null });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "저장하지 못했습니다." }, { status: 500 });
  }
}
