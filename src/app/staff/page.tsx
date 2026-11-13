import StaffHomeClient from "./StaffHomeClient";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { getKoreaDateKey, getTodayStaffClasses } from "@/lib/staff-session-queries";
import { getStaffClassAccessContext } from "@/lib/staff-class-access";
import { DRIVER_ENTRY_PATH, canSeeStaffFees, needsCoachLink } from "@/lib/staff-session-rules";

export const dynamic = "force-dynamic";

export default async function StaffHomePage() {
  const staff = await requireStaff();
  // 선생님 화면이 없는 사람(기사님만)은 기사님 첫 화면으로(운행 화면 또는 아이폰 앱 안내). 「선생님 + 기사님」은 여기 머문다.
  if (!staff.roles.teacher) redirect(DRIVER_ENTRY_PATH);

  const [classes, access] = await Promise.all([getTodayStaffClasses(), getStaffClassAccessContext()]);
  const dateKey = getKoreaDateKey();
  // key=dateKey: 날짜가 바뀌어 새로 불러오면(b2) 화면 상태(수업 목록)도 새 날짜 것으로 처음부터 다시 만든다.
  // showFees: 청구 확인·미납 표시는 원장·부원장만(f3 보완 — 서버도 선생님에게는 금액을 주지 않는다).
  return <StaffHomeClient key={dateKey} dateKey={dateKey} classes={classes} coachLinkMissing={needsCoachLink(access)} showFees={canSeeStaffFees(access.staff.appUserRole)} />;
}
