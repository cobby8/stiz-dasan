// 부상 결석 복귀 정산 실행부 — 공식 일정·오늘 날짜·저장 스위치를 묶는다(관리자 서버 액션과 학부모 API 가 같이 쓴다).
// "use server" 파일이 아니라서 여기 export 는 화면에서 직접 부를 수 없다.
import { loadWorkbenchCalendar } from "@/lib/billing/workbench-calendar";
import { todayKst } from "@/lib/datetime/kst";
import { getMonthlyClassDates } from "@/lib/enrollment/monthlyClassDates";
import type { SettlementContext } from "@/lib/regular/illness-period-settlement";

/** 청구 준비 저장 스위치 — 이월 확정·확정 취소는 돈이 움직이는 일이라 이 스위치가 켜져 있어야 한다 */
export const settlementWritesEnabled = () => process.env.STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true";

/**
 * 정산 계산 재료 — 청구 준비와 «같은» 공식 일정(loadWorkbenchCalendar)으로 수업일을 센다.
 * 다른 일정으로 세면 이월의 수업 횟수가 청구 준비가 다시 세는 값과 달라져 그 이월이 무효로 잡힌다.
 * 일정을 못 읽으면 던진다(추측한 일정으로 금액을 만들지 않는다).
 * @param fresh 확정 직전에는 true(캐시를 쓰지 않고 다시 읽는다 — 청구 준비의 저장·발행과 같다)
 */
export async function settlementContext(actorUserId: string, fresh = false): Promise<SettlementContext> {
  const calendar = await loadWorkbenchCalendar(fresh);
  return {
    todayYmd: todayKst(),
    actorUserId,
    calendar,
    classDatesForMonth: (yearMonth, dayOfWeek) => getMonthlyClassDates(calendar.events, yearMonth, dayOfWeek),
  };
}
