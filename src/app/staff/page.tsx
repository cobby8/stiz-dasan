import StaffHomeClient from "./StaffHomeClient";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { getKoreaDateKey, getTodayStaffClasses } from "@/lib/staff-session-queries";

export const dynamic = "force-dynamic";

export default async function StaffHomePage() {
  const staff = await requireStaff();
  // 선생님 화면이 없는 사람(기사님만)은 셔틀 화면으로. 「선생님 + 기사님」은 여기 머문다.
  if (!staff.roles.teacher) redirect("/staff/shuttle");

  const classes = await getTodayStaffClasses();
  return <StaffHomeClient dateKey={getKoreaDateKey()} classes={classes} />;
}
