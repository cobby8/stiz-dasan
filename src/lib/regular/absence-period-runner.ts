// 기간 결석 실행부 — prisma·연간 일정·캐시 무효화를 묶는다(서버 액션과 크론 라우트가 같이 쓴다).
// "use server" 파일이 아니라서 여기 export 는 화면에서 직접 부를 수 없다(크론용 연장을 액션으로 노출하지 않기 위해 분리).
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { todayKst } from "@/lib/datetime/kst";
import { getMonthlyClassDates, loadAnnualPlanEvents } from "@/lib/enrollment/monthlyClassDates";
import {
  extendAbsencePeriodInTx,
  listPeriodsToExtend,
  type PeriodContext,
} from "@/lib/regular/absence-period-service";

/** 여러 날짜 행을 한 번에 만들 수 있어 기본(5초)보다 넉넉히 */
export const ABSENCE_PERIOD_TX_OPTIONS = { timeout: 30_000 };

/** 연간 일정을 한 번 읽어 «수강월·요일 → 수업일» 함수로 만든다(공개 연간일정표·청구와 같은 getMonthlyClassDates). */
export async function absencePeriodContext(actorUserId: string): Promise<PeriodContext> {
  const events = await loadAnnualPlanEvents();
  return {
    todayYmd: todayKst(),
    actorUserId,
    classDatesForMonth: (yearMonth, dayOfWeek) => getMonthlyClassDates(events, yearMonth, dayOfWeek),
  };
}

/** 결석 행이 바뀌면 보이는 화면들 — 학생 상세·결석 관리·셔틀(정규 명단·배차) */
export function revalidateAbsenceViews(studentId: string) {
  revalidatePath(`/admin/students/${studentId}`);
  revalidatePath("/admin/absence");
  revalidatePath("/admin/shuttle", "layout");
}

/**
 * 진행 중 기간을 목표 끝(복귀 미정 = KST «다음 달 말일», 복귀일 있음 = 복귀일 전날)까지 늘린다.
 * 기간마다 트랜잭션을 따로 잡아 한 학생이 실패해도 나머지는 진행한다. 새로 생긴 행의 처리자는 그 기간을 등록한 관리자.
 */
export async function extendOpenAbsencePeriods() {
  const ctx = await absencePeriodContext("");
  const ids = await listPeriodsToExtend(prisma, ctx.todayYmd);
  const results: Array<{ periodId: string; created: number; error?: string }> = [];
  for (const id of ids) {
    try {
      const r = await prisma.$transaction((tx) => extendAbsencePeriodInTx(tx, id, ctx), ABSENCE_PERIOD_TX_OPTIONS);
      if (r.created > 0) revalidateAbsenceViews(r.studentId);
      results.push({ periodId: id, created: r.created });
    } catch (error) {
      console.error("[absence-period] 기간 결석 연장 실패:", id, error);
      results.push({ periodId: id, created: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { checked: ids.length, created: results.reduce((n, r) => n + r.created, 0), results };
}
