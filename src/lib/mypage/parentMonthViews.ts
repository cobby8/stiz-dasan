import { getMyPageData, getMyPageHistory } from "@/lib/queries";
import { getMonthlyClassDates, loadAnnualPlanEvents } from "@/lib/enrollment/monthlyClassDates";
import { buildParentMonth, classDatesForCalendarMonth, parseMonthParam, type ParentMonthView } from "@/lib/mypage/parentSchedule";
import { todayKst } from "@/lib/datetime/kst";

// 수업 탭 «한 달 달력» 데이터 (2026-11-10 원장 점검 — 달력을 다른 화면이 아니라 수업 탭 안에).
// 일정 탭(/mypage/history/page.tsx)과 같은 원본·같은 계산이다:
//   수업일 = getMyPageData 의 수강 반 요일 × 연간일정(getMonthlyClassDates)
//   출결   = getMyPageHistory 의 기록
// 차이는 하나 — 수업 탭은 화면 안에서 아이를 바로 바꾸므로 «자녀마다» 한 달 데이터를 미리 만든다(자녀는 보통 1~3명).
// ⚠️ appUserId 는 반드시 인증 게이트(requireVerifiedParent)가 확인한 값. 두 조회 모두 그 부모의 자녀만 돌려준다.

export type ChildMonthView = { view: ParentMonthView; planReady: boolean; hasEnrollments: boolean };

export async function getParentMonthViews(
  appUserId: string,
  monthParam: unknown,
): Promise<{ month: string; byChild: Record<string, ChildMonthView> }> {
  const todayYmd = todayKst();
  const month = parseMonthParam(monthParam, todayYmd);
  const [history, home, planEvents] = await Promise.all([
    getMyPageHistory(appUserId),
    getMyPageData(appUserId),
    loadAnnualPlanEvents().catch(() => []),
  ]);

  const byChild: Record<string, ChildMonthView> = {};
  for (const child of home?.children ?? []) {
    const classDates = (child.enrollments ?? []).flatMap((e) =>
      classDatesForCalendarMonth(month, e.dayOfWeek, e.startsOn, (ym, dow) => getMonthlyClassDates(planEvents, ym, dow)),
    );
    const attendance = history?.children.find((c) => c.id === child.id)?.attendance.records ?? [];
    byChild[child.id] = {
      view: buildParentMonth({ month, todayYmd, events: planEvents, classDates, attendance }),
      planReady: classDates.length > 0,
      hasEnrollments: (child.enrollments ?? []).length > 0,
    };
  }
  return { month, byChild };
}
