import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { addDaysKst, isKstYmd, todayKst } from "@/lib/datetime/kst";
import { getStaffShuttleDashboard } from "@/lib/shuttle/service";
import { authorizeAssign, DriverAssignError } from "@/lib/shuttle/driverAssign";
import { getRegularDriverDay } from "@/lib/shuttle/regularDriverRoute";
import { readDriverBoarding } from "@/lib/shuttle/driverStatusRead";
import { buildUnifiedRun } from "@/lib/shuttle/unifiedDriverRunLogic";
import UnifiedDriverClient from "@/components/shuttle/UnifiedDriverClient";
import StaffShuttleDashboardClient from "./StaffShuttleDashboardClient";
import { staffShuttleAccess, stripRiderPrivate } from "@/lib/shuttle/teacherShuttleView";
import StaffVehicleLocation from "./StaffVehicleLocation";
import NoRunNotice from "./NoRunNotice";
import { DRIVER_START_HREF, SHUTTLE_NOTICE_NO_RUN } from "@/lib/staff-session-rules";

export const dynamic = "force-dynamic";

export default async function StaffShuttlePage({ searchParams }: {
  searchParams: Promise<{ date?: string; focus?: string; view?: string; mode?: string; notice?: string }>;
}) {
  const staff = await requireStaff();
  // 2026-11-16 원장 지시: 일반 선생님도 들어온다(보기 + 선생님 운행). 관리자·기사님은 예전과 같은 확인을 거친다.
  const { canOpen, teacherOnly } = staffShuttleAccess(staff.roles);
  if (!canOpen) redirect("/staff");
  if (!teacherOnly) {
    try {
      await authorizeAssign(staff);
    } catch (error) {
      if (error instanceof DriverAssignError && error.status === 403) {
        return <p role="alert" className="mx-auto max-w-lg p-4 text-sm font-medium">셔틀 운행을 볼 수 있는 권한이 없습니다.</p>;
      }
      throw error;
    }
  }

  const params = await searchParams;
  // 별도 확정 노선(편집 화면)은 관리자·기사님만 — 일반 선생님에게는 열지 않는다
  if (params.view === "routes" && !teacherOnly) {
    const dashboard = await getStaffShuttleDashboard(staff);
    return (
      <>
        <div className="mx-auto max-w-lg px-4 pt-3">
          <Link href="/staff/shuttle" className="academy-button-secondary">정규 운행표</Link>
        </div>
        <StaffShuttleDashboardClient dashboard={dashboard} canManageShuttle={staff.roles.admin} />
      </>
    );
  }

  const today = todayKst();
  const date = params.date && isKstYmd(params.date) ? params.date : today;
  const focusDirection = params.focus === "BOARD" ? "PICKUP" : params.focus === "ALIGHT" ? "DROPOFF" : null;
  // 그날 섹션 + 휴무 안내(기사님 운행 화면과 같은 함수 — 휴원·휴무 줄 잠금도 같이 붙어 온다)
  const [{ classes, holiday }, boarding] = await Promise.all([
    getRegularDriverDay(date),
    readDriverBoarding(date, "REGULAR").catch(() => null),
  ]);
  const initialBoarding = Object.fromEntries(Object.entries(boarding?.boarding ?? {}).map(([id, status]) => ["R:" + id, status]));

  // 2026-11-16 원장 지시: 기사님이 아닌 사람(선생님 화면으로 보는 원장·부원장)은 탑승 여부·현재 위치만 «본다».
  // 직접 운행하는 날에는 «선생님 운행»을 눌러 운행 모드(?mode=drive)로 들어가야 탑승 체크를 할 수 있다.
  // 기사님(기사 역할이 있는 사람)은 지금처럼 바로 운행표다.
  const isDriver = staff.roles.driver;
  // 일반 선생님의 «선생님 운행»은 오늘 날짜에서만(다른 날짜는 늘 보기) — 서버 탑승 기록도 같은 규칙으로 막는다
  const driveMode = isDriver || (params.mode === "drive" && (!teacherOnly || date === today));
  const canTeacherDrive = !teacherOnly || date === today;
  const dateQuery = date === today ? "" : `date=${date}`;

  return (
    <>
      {/* «운행 시작»을 눌렀는데 오늘 운행 링크가 아직 없어 되돌아온 경우의 한 줄 안내(2026-11-18 원장 결정 G).
          늘 놓아 둔다 — 주소 표시(?notice=no-run)로 온 칸은 한 칸 뒤(이 명단)로 접히고, 돌아온 명단이 탭 안 표시를 읽어 안내를 보인다 */}
      <NoRunNotice fromQuery={params.notice === SHUTTLE_NOTICE_NO_RUN} />
      {driveMode ? (
        <div className="mx-auto max-w-lg space-y-2 px-4 pt-3">
          {/* 이 운행표(계정용)에는 위치 전송이 없다. 위치를 보내려면 운행 화면에서 «운행 시작»을 누른다(2026-11-13 b7).
              기사님 첫 화면(/staff/driver)을 거쳐 간다 — 안드로이드 앱은 위치 공유가 켜지는 운행 링크 화면으로, 브라우저는 /staff/run 으로(2026-11-16).
              ?start=1 = «운행 시작을 눌러 왔다» 표시. 표시 없이 그 화면에 오면(로그인 직후 등) 이 명단으로 돌아온다(2026-11-18 원장 결정 F). */}
          {/* 위치 전송은 기사님 운행 화면의 기능이라 일반 선생님에게는 두지 않는다(탑승 체크만) */}
          {!teacherOnly && (
            <Link href={DRIVER_START_HREF} className="academy-button-primary min-h-12! w-full text-base!">
              운행 시작 (위치 전송)
            </Link>
          )}
          {/* 신규 셔틀 검토·새 학생 배정·별도 확정 노선은 기사님에게만 — 선생님 화면에서는 뺀다(2026-11-16 원장 지시. 원장·부원장은 관리자 화면에서 한다) */}
          {isDriver && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 py-1">
              <Link href="/staff/shuttle/intake" className="academy-button-text">신규 셔틀 검토</Link>
              <Link href="/staff/shuttle/assign" className="academy-button-text">새 학생 배정</Link>
              <Link href="?view=routes" className="academy-button-text">별도 확정 노선</Link>
            </div>
          )}
          {!isDriver && (
            <div className="flex items-center justify-between gap-2 rounded-xl bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
              <span>선생님 운행 중 — 탑승을 직접 체크합니다.</span>
              {/* replace: 보기 ↔ 운행은 같은 화면의 모드 전환이라 기록에 쌓지 않는다 — 쌓으면 «보기로 돌아가기» 뒤 뒤로를 누를 때 다시 운행 모드가 된다(2026-11-17) */}
              <Link href={`/staff/shuttle${dateQuery ? `?${dateQuery}` : ""}`} replace className="academy-button-text academy-button-sm shrink-0">보기로 돌아가기</Link>
            </div>
          )}
        </div>
      ) : (
        <div className="mx-auto max-w-lg space-y-2 px-4 pt-3">
          {/* 보기 전용: «운행 시작» 자리에 «선생님 운행» — 선생님이 직접 운행하는 날에만 누른다 */}
          {/* replace: 모드 전환은 기록에 쌓지 않는다 — 뒤로 한 번에 셔틀 화면에 오기 전 화면으로 간다(2026-11-17) */}
          {canTeacherDrive ? (
            <Link href={`/staff/shuttle?mode=drive${dateQuery ? `&${dateQuery}` : ""}`} replace className="academy-button-primary min-h-12! w-full text-base!">
              선생님 운행
            </Link>
          ) : (
            <p role="note" className="rounded-xl bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-muted)]">«선생님 운행»은 오늘 날짜에서만 할 수 있어요.</p>
          )}
          <StaffVehicleLocation />
          <p className="text-xs text-[var(--color-academy-muted)]">탑승 여부는 기사님이 체크한 대로 보입니다(30초마다 새로 읽어요). 직접 운행할 때만 «선생님 운행»을 눌러 주세요.</p>
        </div>
      )}
      <UnifiedDriverClient
        // 보기 ↔ 운행 모드를 오가면 화면 상태(체크 값)를 새로 읽은 값으로 다시 만든다
        key={`${date}:${driveMode ? "drive" : "view"}`}
        date={date}
        // 일반 선생님의 «보기»에는 연락처·건강 특이사항을 내려보내지 않는다(탑승 여부만). 직접 운행할 때는 연락이 필요해 그대로 준다
        rows={teacherOnly && !driveMode ? stripRiderPrivate(buildUnifiedRun({ regular: classes })) : buildUnifiedRun({ regular: classes })}
        initialBoarding={initialBoarding}
        initialBoardingReliable={boarding !== null}
        prevDate={addDaysKst(date, -1)}
        nextDate={addDaysKst(date, 1)}
        today={today}
        driverLabel="정규 셔틀 기사님"
        focusDirection={focusDirection}
        holiday={holiday}
        readOnly={!driveMode}
      />
    </>
  );
}
