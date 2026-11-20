import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-guard";
import { isKstYmd, todayKst } from "@/lib/datetime/kst";
import { authorizeAssign, DriverAssignError } from "@/lib/shuttle/driverAssign";
import { readDriverBoarding } from "@/lib/shuttle/driverStatusRead";
import { staffShuttleAccess } from "@/lib/shuttle/teacherShuttleView";
import { setTrialBoarding } from "@/lib/shuttle/trialShuttle";

export const dynamic = "force-dynamic";

// 체험 셔틀 탑승/미탑승 체크(로그인한 기사님·관리자·«선생님 운행», 2026-11-19).
// 정규 탑승 체크(/api/staff/shuttle/regular-boarding)와 같은 문지기·같은 규칙이다:
//   - 관리자·기사님: 현재 DB 역할로 확인(authorizeAssign)
//   - 일반 선생님: «선생님 운행»으로 오늘(KST) 운행표만 체크
// 저장 키는 하루 탑승 id(TrialShuttleRide.id), ShuttleBoarding 의 direction 은 'TRIAL'.

function json(body: object, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

/** 누가 부르는지 확인한다. 통과하면 { teacherOnly } — 요청마다 값을 돌려준다(모듈 변수에 담지 않는다). */
async function checkStaff(): Promise<{ error: NextResponse } | { error: null; teacherOnly: boolean }> {
  const staff = await requireStaff().catch(() => null);
  if (!staff) return { error: json({ error: "직원 로그인이 필요합니다." }, 401) };
  if (staffShuttleAccess(staff.roles).teacherOnly) return { error: null, teacherOnly: true };
  try {
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
  if (typeof date !== "string" || !isKstYmd(date)) return json({ error: "운행 날짜를 확인해 주세요." }, 400);
  try {
    return json({ ok: true, ...await readDriverBoarding(date, "TRIAL") });
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

  const body = await request.json().catch(() => null) as { date?: unknown; rideId?: unknown; status?: unknown } | null;
  const { date, rideId, status } = body ?? {};
  if (typeof date !== "string" || !isKstYmd(date) || typeof rideId !== "string" || !rideId.trim() || rideId.length > 128) {
    return json({ error: "운행 날짜와 명단을 확인해 주세요." }, 400);
  }
  if (status !== null && status !== "BOARDED" && status !== "NOSHOW" && status !== "SELF") {
    return json({ error: "승하차 상태를 확인해 주세요." }, 400);
  }
  // 일반 선생님의 «선생님 운행»은 오늘(KST) 운행표만 체크한다 — 정규 체크와 같은 규칙.
  if (gate.teacherOnly && date !== todayKst()) {
    return json({ error: "선생님 운행은 오늘 날짜만 체크할 수 있습니다." }, 409);
  }
  try {
    const result = await setTrialBoarding({ date, rideId: rideId.trim(), status, via: gate.teacherOnly ? "teacher" : "driver" });
    if (!result.ok) return json({ error: "배정이 바뀌었어요. 운행표를 다시 열어 주세요." }, 409);
    return json({ ok: true });
  } catch {
    return json({ error: "저장하지 못했습니다." }, 500);
  }
}
