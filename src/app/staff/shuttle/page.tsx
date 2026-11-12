import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";
import { addDaysKst, isKstYmd, todayKst } from "@/lib/datetime/kst";
import { getStaffShuttleDashboard } from "@/lib/shuttle/service";
import { authorizeAssign, DriverAssignError } from "@/lib/shuttle/driverAssign";
import { getRegularDriverClasses } from "@/lib/shuttle/regularDriverRoute";
import { readDriverBoarding } from "@/lib/shuttle/driverStatusRead";
import { buildUnifiedRun } from "@/lib/shuttle/unifiedDriverRunLogic";
import UnifiedDriverClient from "@/components/shuttle/UnifiedDriverClient";
import StaffShuttleDashboardClient from "./StaffShuttleDashboardClient";

export const dynamic = "force-dynamic";

export default async function StaffShuttlePage({ searchParams }: {
  searchParams: Promise<{ date?: string; focus?: string; view?: string }>;
}) {
  const staff = await requireStaff();
  if (shuttleScope(staff.roles) === "NONE") redirect("/staff");
  try {
    await authorizeAssign(staff);
  } catch (error) {
    if (error instanceof DriverAssignError && error.status === 403) {
      return <p role="alert" className="mx-auto max-w-lg p-4 text-sm font-bold">셔틀 운행을 볼 수 있는 권한이 없습니다.</p>;
    }
    throw error;
  }

  const params = await searchParams;
  if (params.view === "routes") {
    const dashboard = await getStaffShuttleDashboard(staff);
    return (
      <>
        <div className="mx-auto max-w-lg px-4 pt-3">
          <Link href="/staff/shuttle" className="academy-button-secondary inline-flex min-h-11 items-center">정규 운행표</Link>
        </div>
        <StaffShuttleDashboardClient dashboard={dashboard} canManageShuttle={staff.roles.admin} />
      </>
    );
  }

  const today = todayKst();
  const date = params.date && isKstYmd(params.date) ? params.date : today;
  const focusDirection = params.focus === "BOARD" ? "PICKUP" : params.focus === "ALIGHT" ? "DROPOFF" : null;
  const [classes, boarding] = await Promise.all([
    getRegularDriverClasses(date),
    readDriverBoarding(date, "REGULAR").catch(() => null),
  ]);
  const initialBoarding = Object.fromEntries(Object.entries(boarding?.boarding ?? {}).map(([id, status]) => ["R:" + id, status]));

  return (
    <>
      {/* 이 운행표(계정용)에는 위치 전송이 없다. 학부모에게 위치를 보내려면 운행 화면(/staff/run)에서 «운행 시작»을 누른다(2026-11-13 b7). */}
      <div className="mx-auto max-w-lg px-4 pt-3">
        <Link href="/staff/run" className="academy-button-primary flex min-h-12 w-full items-center justify-center gap-2 rounded-xl px-4 text-base font-black">
          <span className="material-symbols-outlined" aria-hidden="true">near_me</span>
          운행 시작 (위치 전송)
        </Link>
      </div>
      <div className="mx-auto flex max-w-lg flex-wrap gap-x-4 gap-y-1 px-4 py-2">
        <Link href="/staff/shuttle/intake" className="academy-button-text inline-flex min-h-11 items-center">신규 셔틀 검토</Link>
        <Link href="/staff/shuttle/assign" className="academy-button-text inline-flex min-h-11 items-center">새 학생 배정</Link>
        <Link href="?view=routes" className="academy-button-text inline-flex min-h-11 items-center">별도 확정 노선</Link>
      </div>
      <UnifiedDriverClient
        key={date}
        date={date}
        rows={buildUnifiedRun({ regular: classes })}
        initialBoarding={initialBoarding}
        initialBoardingReliable={boarding !== null}
        prevDate={addDaysKst(date, -1)}
        nextDate={addDaysKst(date, 1)}
        today={today}
        driverLabel="정규 셔틀 기사님"
        focusDirection={focusDirection}
      />
    </>
  );
}
