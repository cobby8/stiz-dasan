import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-guard";
import { isServiceMonth, koreaServiceMonth } from "@/lib/regular/serviceMonth";
import { assignDriverCell, DriverAssignError, getDriverAssignBoard } from "@/lib/shuttle/driverAssign";
import { RosterInputError } from "@/lib/shuttle/regularRosterEdit";

export const dynamic = "force-dynamic";

// 기사님 「새 학생 배정」 API.
//   GET  ?month=YYYY-MM  → 셔틀 신청이 승인됐는데 아직 운행표에 없는 칸 + 칸별 지금 순서·추천(조회 전용)
//   POST { month, studentId, weekday, direction, choice, routeVersion, includeNextMonth } → 한 칸 넣기
// 로그인 없음 = 401, 기사·관리자 역할 없음 = 403(현재 DB 역할로 확인). 오류 응답에 내부 오류 원문을 담지 않는다.

const NO_STORE = { "Cache-Control": "no-store" };

function fail(e: unknown, tag: string) {
  if (e instanceof DriverAssignError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status, headers: NO_STORE });
  if (e instanceof RosterInputError) {
    // 명단 규칙의 안내문(한국어)이다. 「이미 명단에 있습니다」는 같은 칸 중복이라 409 로 맞춘다.
    const dup = /이미 명단에 있습니다/.test(e.message);
    return NextResponse.json({ error: dup ? "이미 운행표에 있어요." : e.message, code: dup ? "ALREADY_ASSIGNED" : "ROSTER_INPUT" }, { status: dup ? 409 : 400, headers: NO_STORE });
  }
  console.error(`[staff shuttle assign ${tag}]`, e);
  return NextResponse.json({ error: "처리하지 못했어요. 잠시 뒤 다시 해 주세요." }, { status: 500, headers: NO_STORE });
}

async function staffOr401() {
  try { return await requireStaff(); } catch { return null; }
}

export async function GET(request: Request) {
  const staff = await staffOr401();
  if (!staff) return NextResponse.json({ error: "직원 로그인이 필요합니다." }, { status: 401, headers: NO_STORE });
  try {
    const raw = new URL(request.url).searchParams.get("month");
    const month = raw && isServiceMonth(raw) ? raw : koreaServiceMonth();
    return NextResponse.json(await getDriverAssignBoard(staff, month), { headers: NO_STORE });
  } catch (e) { return fail(e, "GET"); }
}

export async function POST(request: Request) {
  const staff = await staffOr401();
  if (!staff) return NextResponse.json({ error: "직원 로그인이 필요합니다." }, { status: 401, headers: NO_STORE });
  try {
    const body = await request.json().catch(() => null);
    return NextResponse.json({ ok: true, ...(await assignDriverCell(staff, body)) }, { headers: NO_STORE });
  } catch (e) { return fail(e, "POST"); }
}
