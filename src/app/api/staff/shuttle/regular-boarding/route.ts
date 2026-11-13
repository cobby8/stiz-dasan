import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-guard";
import { isKstYmd } from "@/lib/datetime/kst";
import { authorizeAssign, DriverAssignError } from "@/lib/shuttle/driverAssign";
import { readDriverBoarding } from "@/lib/shuttle/driverStatusRead";
import { getRegularDriverClasses } from "@/lib/shuttle/regularDriverRoute";
import { setRegularBoarding } from "@/lib/shuttle/regularRun";
import { boardingRejectedForBlock } from "@/lib/shuttle/regularRunDayRules";

export const dynamic = "force-dynamic";

function json(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

async function checkStaff() {
  const staff = await requireStaff().catch(() => null);
  if (!staff) return json({ error: "직원 로그인이 필요합니다." }, 401);
  try {
    // 주 역할 캐시와 별개로 현재 기사 또는 관리자 권한을 확인한다.
    await authorizeAssign(staff);
    return null;
  } catch (error) {
    if (error instanceof DriverAssignError && error.status === 403) {
      return json({ error: "셔틀 운행을 처리할 권한이 없습니다." }, 403);
    }
    return json({ error: "셔틀 권한을 확인하지 못했습니다. 다시 시도해 주세요." }, 503);
  }
}

export async function GET(request: NextRequest) {
  const authError = await checkStaff();
  if (authError) return authError;

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
  const authError = await checkStaff();
  if (authError) return authError;

  const body = await request.json().catch(() => null) as { date?: unknown; rowId?: unknown; status?: unknown } | null;
  const { date, rowId, status } = body ?? {};
  if (typeof date !== "string" || !isKstYmd(date) || typeof rowId !== "string" || !rowId.trim() || rowId.length > 128) {
    return json({ error: "운행 날짜와 명단을 확인해 주세요." }, 400);
  }
  if (status !== null && status !== "BOARDED" && status !== "NOSHOW" && status !== "SELF") {
    return json({ error: "승하차 상태를 확인해 주세요." }, 400);
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
    const result = await setRegularBoarding({ date, rowId: rider.rowId, status, studentName: rider.name });
    if (result.ok) return json({ ok: true });
  } catch {
    // 기록 조회는 GET에서 별도로 하므로 저장 실패를 성공으로 돌려주지 않는다.
  }
  return json({ error: "저장하지 못했습니다." }, 500);
}
