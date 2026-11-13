// 아이 한 명의 정규 셔틀(명단 기준) 조회 — 재료만 모으고 계산은 childShuttleRules(순수)에 맡긴다.
//
// ★ 권한: 이 함수는 인증하지 않는다. 호출부가 «로그인 보호자의 아이»로 확인한 studentId 만 넘긴다
//   (getChildRecord 의 첫 SQL · getParentShuttleOverview 의 childAccessWhere). 모든 SQL 은 studentId = $1 로 묶는다.
// 출처(기사님 화면 getRegularDriverClasses 와 같은 표):
//   명단 RegularShuttleStop(그 달 이하 최신 명단 달) · 결석 RegularAbsence(REPORTED·CONFIRMED) · «오늘만» ShuttleDayException
// 다른 학생 행·명단의 전화번호 칸·좌표·메모 칸은 SELECT 하지 않는다(테스트가 SQL 로 확인).
// ⚠️ PgBouncer → $queryRawUnsafe 만. 날짜 칸(@db.Date)은 변환 없이 to_char.
import { addDaysKst } from "@/lib/datetime/kst";
import { classDatesForCalendarMonth } from "@/lib/mypage/parentSchedule";
import {
  buildShuttleDays,
  weeklyShuttlePlan,
  type RosterStopRow,
  type ShuttleAbsence,
  type ShuttleClassRef,
  type ShuttleDayRow,
  type ShuttleException,
  type WeeklyShuttleRow,
} from "@/lib/shuttle/childShuttleRules";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

/** 연간일정 이벤트 → 그 달·요일 수업일(getMonthlyClassDates 를 호출부가 꽂는다 — 테스트에서 바꿔 끼우려고) */
export type MonthlyClassDates = (yearMonth: string, dayOfWeek: string) => string[];

export type ChildRegularShuttle = {
  /** 오늘이 속한 달에 쓰인 명단 달(없으면 null — 명단이 아예 없다) */
  rosterMonth: string | null;
  weekly: WeeklyShuttleRow[];
  days: ShuttleDayRow[];
};

/** 오늘부터 며칠을 보일지 — 홈·수업 탭 항목도 같은 창을 쓴다 */
export const SHUTTLE_WINDOW_DAYS = 7;

export async function loadChildRegularShuttle(
  db: Reader,
  input: { studentId: string; today: string; classes: readonly ShuttleClassRef[]; monthlyDates: MonthlyClassDates | null },
): Promise<ChildRegularShuttle> {
  const { studentId, today } = input;
  const end = addDaysKst(today, SHUTTLE_WINDOW_DAYS - 1);
  const months = [...new Set([today.slice(0, 7), end.slice(0, 7)])];

  const [rosterByMonth, absences, exceptions] = await Promise.all([
    // 달마다: 그 달 «이하»의 최신 명단 달(기사님 화면 pickServiceMonthFor · regularRosterEta 와 같은 기준)
    Promise.all(
      months.map(async (month) => {
        const rows = await db.$queryRawUnsafe<any[]>(
          `SELECT r.id, r.weekday, r.direction, r."stopName", r."arriveTime", r."classTime", r."sortOrder", r."serviceMonth"
             FROM "RegularShuttleStop" r
            WHERE r."studentId" = $1
              AND r.direction IN ('BOARD','ALIGHT')
              AND r."serviceMonth" = (SELECT max(m."serviceMonth") FROM "RegularShuttleStop" m WHERE m."serviceMonth" <= $2)
            ORDER BY r."sortOrder" ASC, r.id COLLATE "C" ASC`,
          studentId,
          month,
        );
        return [month, rows] as const;
      }),
    ),
    db.$queryRawUnsafe<any[]>(
      `SELECT to_char(ra.date, 'YYYY-MM-DD') AS ymd, ra."classId"
         FROM "RegularAbsence" ra
        WHERE ra."studentId" = $1 AND ra.status IN ('REPORTED','CONFIRMED')
          AND ra.date >= $2::date AND ra.date <= $3::date`,
      studentId, today, end,
    ),
    db.$queryRawUnsafe<any[]>(
      `SELECT to_char(x."serviceDate", 'YYYY-MM-DD') AS ymd, x.direction, x.kind, x.location
         FROM "ShuttleDayException" x
        WHERE x."studentId" = $1 AND x."canceledAt" IS NULL
          AND x."serviceDate" >= $2::date AND x."serviceDate" <= $3::date`,
      studentId, today, end,
    ),
  ]);

  const toRow = (r: any): RosterStopRow => ({
    id: String(r.id),
    weekday: Number(r.weekday),
    direction: String(r.direction),
    stopName: r.stopName ?? null,
    arriveTime: r.arriveTime ?? null,
    classTime: r.classTime ?? null,
    sortOrder: r.sortOrder === null || r.sortOrder === undefined ? null : Number(r.sortOrder),
  });
  const rowsByMonth = new Map(rosterByMonth.map(([m, rows]) => [m, rows.map(toRow)]));
  const usedMonth = rosterByMonth.find(([m]) => m === today.slice(0, 7))?.[1][0]?.serviceMonth ?? null;

  // 수업일 판정 — 수업 탭 «다음 수업»과 같은 계산(연간일정). 그 달 수업일을 못 구하면 null(모름 → 명단대로 운행)
  const monthly = input.monthlyDates;
  const isClassDay = (c: ShuttleClassRef, ymd: string): boolean | null => {
    if (!monthly) return null;
    const dates = classDatesForCalendarMonth(ymd.slice(0, 7), c.dayOfWeek, null, monthly);
    return dates.length === 0 ? null : dates.includes(ymd);
  };

  const weekly = weeklyShuttlePlan(rowsByMonth.get(today.slice(0, 7)) ?? [], input.classes);
  const days = buildShuttleDays({
    today,
    days: SHUTTLE_WINDOW_DAYS,
    rowsForDate: (ymd) => rowsByMonth.get(ymd.slice(0, 7)) ?? [],
    classes: input.classes,
    isClassDay,
    absences: absences.map((a): ShuttleAbsence => ({ ymd: String(a.ymd), classId: a.classId ?? null })),
    exceptions: exceptions.map((x): ShuttleException => ({ ymd: String(x.ymd), direction: String(x.direction), kind: String(x.kind), location: x.location ?? null })),
  });
  return { rosterMonth: usedMonth ? String(usedMonth) : null, weekly, days };
}

/**
 * 셔틀 명단(그 달 이하 최신 명단 달)에 이름이 올라 있는 학생 id — «정규 셔틀 신청 접수» 카드를 뺄 때 쓴다.
 * 운행 일정(7일)과 무관하게 «명단에 있는가»만 본다(휴원·방학·명절 주에도 카드가 다시 뜨지 않게).
 * ★ 호출부가 확인한 내 자녀 id 만 넘긴다. 학생 id 외의 칸은 고르지 않는다.
 */
export async function getRosterStudentIds(db: Reader, studentIds: readonly string[], month: string): Promise<Set<string>> {
  const ids = [...new Set(studentIds.filter((id) => typeof id === "string" && id !== ""))];
  if (ids.length === 0) return new Set();
  const rows = await db.$queryRawUnsafe<{ studentId: string }[]>(
    `SELECT DISTINCT r."studentId"
       FROM "RegularShuttleStop" r
      WHERE r."studentId" = ANY($1::text[])
        AND r.direction IN ('BOARD','ALIGHT')
        AND r."serviceMonth" = (SELECT max(m."serviceMonth") FROM "RegularShuttleStop" m WHERE m."serviceMonth" <= $2)`,
    ids,
    month,
  );
  return new Set(rows.map((r) => String(r.studentId)));
}
