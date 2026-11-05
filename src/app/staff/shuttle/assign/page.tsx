import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { shuttleScope } from "@/lib/account/roles";
import { isServiceMonth, koreaServiceMonth } from "@/lib/regular/serviceMonth";
import DriverAssignClient from "./DriverAssignClient";

export const dynamic = "force-dynamic";

// 기사님 「새 학생 배정」 — 셔틀 신청이 승인됐는데 아직 운행표에 없는 칸을 한 칸씩 넣는다.
// 화면 문지기는 검토 화면(/staff/shuttle/intake)과 같고, 실제 권한은 API 가 현재 DB 역할로 다시 확인한다.
export default async function StaffShuttleAssignPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const staff = await requireStaff();
  if (shuttleScope(staff.roles) === "NONE") redirect("/staff");
  const { month } = await searchParams;
  const initialMonth = month && isServiceMonth(month) ? month : koreaServiceMonth();
  return <DriverAssignClient month={initialMonth} />;
}
