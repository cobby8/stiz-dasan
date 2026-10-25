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

  return <StaffShuttleDashboardClient dashboard={dashboard} canManageShuttle={canManageShuttle} />;
}
