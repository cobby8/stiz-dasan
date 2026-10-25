import { NextRequest, NextResponse } from "next/server";
import { requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";
import { getStaffShuttleDashboard, ShuttleServiceError, updatePassengerRideStatus } from "@/lib/shuttle/service";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// 로그인 안 했거나 직원이 아니면 401 — 서버 오류(500)로 섞이지 않게 문지기를 따로 둔다.
async function staffOrNull() {
  try {
    return await requireStaff();
  } catch (error) {
    // 로그인·직원 아님은 평범한 401. 그 밖(DB 조회 실패 등)은 장애라 기록을 남긴다.
    const message = error instanceof Error ? error.message : "";
    if (!message.includes("인증이 필요") && !message.includes("Staff permission")) {
      console.error("[staff shuttle auth]", error);
    }
    return null;
  }
}

function unauthorized() {
  return NextResponse.json({ error: "로그인이 필요합니다.", code: "UNAUTHORIZED" }, { status: 401 });
}

export async function GET() {
  const staff = await staffOrNull();
  if (!staff) return unauthorized();
  try {
    // 관리자 또는 기사님(주 역할이든 승인된 추가 역할이든). 「선생님 + 기사님」도 여기 들어온다.
    if (shuttleScope(staff.roles) === "NONE") {
      throw new ShuttleServiceError("셔틀 운행 정보를 조회할 권한이 없습니다.", 403, "SHUTTLE_DASHBOARD_FORBIDDEN");
    }
    const dashboard = await getStaffShuttleDashboard(staff);
    return NextResponse.json({ dashboard });
  } catch (error) {
    if (error instanceof ShuttleServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[staff shuttle get]", error);
    return NextResponse.json({ error: "셔틀 운행 정보를 불러오지 못했습니다.", code: "SHUTTLE_DASHBOARD_FAILED" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const staff = await staffOrNull();
  if (!staff) return unauthorized();
  try {
    const body = object(await request.json());
    const routeId = typeof body.routeId === "string" ? body.routeId : "";
    const passengerId = typeof body.passengerId === "string" ? body.passengerId : "";
    if (!routeId || !passengerId) {
      throw new ShuttleServiceError("노선과 학생 정보를 확인해 주세요.", 400, "RIDE_STATUS_TARGET_REQUIRED");
    }
    const passenger = await updatePassengerRideStatus(staff, routeId, passengerId, body.status);
    return NextResponse.json({ passenger });
  } catch (error) {
    if (error instanceof ShuttleServiceError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("[staff shuttle]", error);
    return NextResponse.json({ error: "셔틀 상태를 저장하지 못했습니다.", code: "SHUTTLE_RIDE_STATUS_FAILED" }, { status: 500 });
  }
}
