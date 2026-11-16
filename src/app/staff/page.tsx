import StaffHomeClient from "./StaffHomeClient";
import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth-guard";
import { getKoreaDateKey, getTodayStaffClasses } from "@/lib/staff-session-queries";
import { getStaffClassAccessContext } from "@/lib/staff-class-access";
import { DRIVER_ENTRY_PATH, canSeeStaffFees, needsCoachLink, resolveStaffViewDate, staffPreviewDates } from "@/lib/staff-session-rules";
// 휴무 판정은 기사님 운행표·학부모 셔틀과 같은 함수(연간일정 수업일 기준) — 화면마다 휴무가 어긋나지 않게
import { loadRegularRunPlan } from "@/lib/shuttle/regularRunDay";
import { regularRunHoliday } from "@/lib/shuttle/regularRunDayRules";

export const dynamic = "force-dynamic";

export default async function StaffHomePage({ searchParams }: { searchParams: Promise<{ date?: string | string[] }> }) {
  const staff = await requireStaff();
  // 선생님 화면이 없는 사람(기사님만)은 기사님 첫 화면으로(운행 화면 또는 아이폰 앱 안내). 「선생님 + 기사님」은 여기 머문다.
  if (!staff.roles.teacher) redirect(DRIVER_ENTRY_PATH);

  // 2026-11-16 날짜 이동: ?date=YYYY-MM-DD 로 다가올 날짜(오늘+14일까지)의 수업을 미리 본다.
  // 형식이 틀리거나 범위 밖(지난 날·너무 먼 날)이면 오늘 — 밤새 열어 둔 «내일» 화면도 다음 날엔 자연히 오늘 화면이 된다.
  const todayKey = getKoreaDateKey();
  const dateKey = resolveStaffViewDate((await searchParams).date, todayKey);

  const [classes, access, plan] = await Promise.all([
    getTodayStaffClasses(dateKey),
    getStaffClassAccessContext(),
    // 연간일정을 못 읽거나 3초 안에 안 오면 null — 휴무 표시 없이 그대로 보인다(부가 정보가 첫 화면을 죽이거나 붙잡으면 안 된다)
    Promise.race([
      loadRegularRunPlan().catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]),
  ]);
  // 날짜 칸(오늘~14일 뒤) 중 휴무인 날 → 사유. 모르는 날(일정 확정 전)은 표시하지 않는다.
  const holidays: Record<string, string> = {};
  if (plan) {
    for (const ymd of staffPreviewDates(todayKey)) {
      const holiday = regularRunHoliday(ymd, plan.monthlyDates, plan.events);
      if (holiday) holidays[ymd] = holiday.title;
    }
  }
  // key=오늘:보는 날짜 — 자정을 넘겨 «내일» 화면이 «오늘» 화면이 될 때도 새로 만든다. 날짜가 바뀌어 새로 불러오면(b2·날짜 이동) 화면 상태(수업 목록)도 새 날짜 것으로 처음부터 다시 만든다.
  // showFees: 청구 확인·미납 표시는 원장·부원장만(f3 보완 — 서버도 선생님에게는 금액을 주지 않는다).
  return <StaffHomeClient key={`${todayKey}:${dateKey}`} dateKey={dateKey} todayKey={todayKey} holidays={holidays} classes={classes} coachLinkMissing={needsCoachLink(access)} showFees={canSeeStaffFees(access.staff.appUserRole)} />;
}
