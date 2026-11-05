import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";
import { getStaffShuttleDashboard } from "@/lib/shuttle/service";
import StaffShuttleDashboardClient from "./StaffShuttleDashboardClient";

export const dynamic = "force-dynamic";

export default async function StaffShuttlePage() {
  const staff = await requireStaff();
  // 관리자 또는 기사님(승인된 추가 역할 포함). 선생님만인 사람은 들어오지 못한다.
  const canUseShuttle = shuttleScope(staff.roles) !== "NONE";

  if (!canUseShuttle) redirect("/staff");

  const dashboard = await getStaffShuttleDashboard(staff);
  const canManageShuttle = staff.roles.admin;

  return (
    <>
      {/* 학원 공용 운행표(정규·방학특강 시각순) — 문자 링크 없이 로그인만으로 연다(다중 역할 5단계). */}
      <div className="mx-auto max-w-lg px-4 pt-3">
        <Link
          href="/staff/run"
          className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-[var(--brand-accent)] px-4 text-sm font-bold text-white"
        >
          <span className="material-symbols-outlined text-lg" aria-hidden="true">directions_bus</span>
          오늘 운행표 열기
        </Link>
        <Link href="/staff/shuttle/intake" className="mt-2 flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--color-academy-line)] px-4 text-sm font-bold">
          <span className="material-symbols-outlined text-lg" aria-hidden="true">person_add</span>
          새 학생 셔틀 검토
        </Link>
        {/* 셔틀 신청이 승인됐는데 아직 운행표에 없는 칸을 기사님이 바로 넣는 화면 */}
        <Link href="/staff/shuttle/assign" className="mt-2 flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--color-academy-line)] px-4 text-sm font-bold">
          <span className="material-symbols-outlined text-lg" aria-hidden="true">playlist_add</span>
          새 학생 배정
        </Link>
      </div>
      <StaffShuttleDashboardClient dashboard={dashboard} canManageShuttle={canManageShuttle} />
    </>
  );
}
