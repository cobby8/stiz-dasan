import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-guard";
import { isKstYmd, todayKst } from "@/lib/datetime/kst";
import { authorizeAssign, DriverAssignError } from "@/lib/shuttle/driverAssign";
import { readDriverBoarding } from "@/lib/shuttle/driverStatusRead";
import { getRegularDriverClasses } from "@/lib/shuttle/regularDriverRoute";
import { setRegularBoarding } from "@/lib/shuttle/regularRun";
import { boardingRejectedForBlock } from "@/lib/shuttle/regularRunDayRules";
import { staffShuttleAccess } from "@/lib/shuttle/teacherShuttleView";

export const dynamic = "force-dynamic";

function json(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

/**
 * 누가 부르는지 확인한다. 통과하면 { teacherOnly } — 일반 선생님(관리자·기사 역할 없음)으로 들어왔는지.
 * 요청마다 값을 돌려준다(모듈 변수에 담지 않는다 — 동시에 온 요청끼리 섞이지 않게).
 */
async function checkStaff(): Promise<{ error: NextResponse } | { error: null; teacherOnly: boolean }> {
  const staff = await requireStaff().catch(() => null);
  if (!staff) return { error: json({ error: "직원 로그인이 필요합니다." }, 401) };
  // 2026-11-16 원장 지시: 일반 선생님도 «선생님 운행»으로 탑승을 체크한다(직접 운행하는 날).
  // 역할은 requireStaff 가 요청마다 DB 에서 다시 읽은 값이다(staff.roles). 관리자·기사님은 아래 기존 확인 그대로.
  if (staffShuttleAccess(staff.roles).teacherOnly) return { error: null, teacherOnly: true };
  try {
    // 주 역할 캐시와 별개로 현재 기사 또는 관리자 권한을 확인한다.
    await authorizeAssign(staff);
    return { error: null, teacherOnly: false };
  } catch (error) {
    if (error instanceof DriverAssignError && error.status === 403) {
      return { error: json({ error: "셔틀 운행을 처리할 권한이 없습니다." }, 403) };
    }
    return { error: json({ error: "셔틀 권한을 확인하지 못했습니다. 다시 시도해 주세요." }, 503) };
  }
}

export async function GET(request: NextRequest) {
  const gate = await checkStaff();
  if (gate.error) return gate.error;

  const date = request.nextUrl.searchParams.get("date");
  if (typeof date !== "string" || !isKstYmd(date)) {
    return json({ error: "운행 날짜를 확인해 주세요." }, 400);
  }
  try {
    return json({ ok: true, ...await readDriverBoarding(date, "REGULAR") });
  } catch {
    return json({ error: "저장 상태를 조회하지 못했습니다." }, 503);
  }
}

export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin || request.headers.get("sec-fetch-site") === "cross-site") {
    return json({ error: "사이트에서 다시 요청해 주세요." }, 403);
  }
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    return json({ error: "요청 형식을 확인해 주세요." }, 415);
  }
  const gate = await checkStaff();
  if (gate.error) return gate.error;

  const body = await request.json().catch(() => null) as { date?: unknown; rowId?: unknown; status?: unknown } | null;
  const { date, rowId, status } = body ?? {};
  if (typeof date !== "string" || !isKstYmd(date) || typeof rowId !== "string" || !rowId.trim() || rowId.length > 128) {
    return json({ error: "운행 날짜와 명단을 확인해 주세요." }, 400);
  }
  if (status !== null && status !== "BOARDED" && status !== "NOSHOW" && status !== "SELF") {
    return json({ error: "승하차 상태를 확인해 주세요." }, 400);
  }
  // 일반 선생님의 «선생님 운행»은 오늘(KST) 운행표만 체크한다 — 지난 기록을 고치거나 다른 날을 미리 찍지 못하게(보안 검수 2026-11-16).
  if (gate.teacherOnly && date !== todayKst()) {
    return json({ error: "선생님 운행은 오늘 날짜만 체크할 수 있습니다." }, 409);
  }

  try {
    const classes = await getRegularDriverClasses(date);
    const rider = classes
      .flatMap(({ board, alight }) => [...board, ...alight])
      .flatMap(({ rows }) => rows)
      .find((row) => row.rowId === rowId);
    if (!rider) {
      return json({ error: "해당 날짜 운행표에서 학생을 찾지 못했습니다. 운행표를 다시 열어 주세요." }, 404);
    }
    // 휴원·퇴원·첫 수업 전·휴무 줄은 체크를 받지 않는다(«대기로 되돌리기»=null 만 허용) — 화면 잠금과 같은 판정.
    if (boardingRejectedForBlock(rider.blockedLabel, status)) {
      return json({ error: `${rider.blockedLabel} 학생은 체크하지 않습니다.` }, 409);
    }
    const result = await setRegularBoarding({ date, rowId: rider.rowId, status, studentName: rider.name, via: gate.teacherOnly ? "teacher" : "driver" });
    if (result.ok) return json({ ok: true });
  } catch {
    // 기록 조회는 GET에서 별도로 하므로 저장 실패를 성공으로 돌려주지 않는다.
  }
  return json({ error: "저장하지 못했습니다." }, 500);
}
