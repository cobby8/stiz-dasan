// 기사님 운행표(정규)의 «그날 잠글 줄» 재료 모으기(서버 전용) — 계산은 regularRunDayRules(순수)에 맡긴다.
//
// 모으는 것:
//   1) 명단에 오른 학생들의 정규 반(수강 중·휴원 중) — 학부모 «아이 기록» loadChildClasses 와 같은 칸·같은 기준
//      (방학특강 반 제외 · ACTIVE·PAUSED · 승인됐지만 반영 전 휴원·퇴원 1건 · 휴원 중 복귀 예정일 · 개시일)
//   2) 연간일정(구글 캘린더 ICS + DB 일정) — 학부모 셔틀 «휴무»와 같은 loadAnnualPlanEvents·getMonthlyClassDates
// ⚠️ 기사님 화면은 로그인 없는 토큰 화면이다 — 여기서 읽은 수강 정보는 «잠금 뱃지 글자»로만 내보내고 반 이름·날짜는 싣지 않는다.
// ⚠️ PgBouncer → $queryRawUnsafe 만. 날짜 칸(@db.Date)은 변환 없이 to_char.
import { prisma } from "@/lib/prisma";
import { commencementYmd } from "@/lib/enrollment/commencement";
import { getMonthlyClassDates, loadAnnualPlanEvents } from "@/lib/enrollment/monthlyClassDates";
import type { ShuttleClassRef } from "./childShuttleRules";
import {
  RIDER_BLOCK_LABEL,
  monthRunHolidays,
  regularRunHoliday,
  riderBlockOf,
  rosterRowBlock,
  type MonthlyClassDates,
  type PlanEvent,
  type RunHoliday,
} from "./regularRunDayRules";

type Reader = { $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T> };

/** 학생 id 여럿의 정규 반을 한 번에 — loadChildClasses 와 같은 SQL 기준(화면 칸만 뺐다). */
export async function loadRosterClassesByStudent(db: Reader, studentIds: readonly string[]): Promise<Map<string, ShuttleClassRef[]>> {
  const ids = [...new Set(studentIds.filter((id) => typeof id === "string" && id !== ""))];
  const out = new Map<string, ShuttleClassRef[]>();
  if (ids.length === 0) return out;
  for (const id of ids) out.set(id, []); // 반이 하나도 없으면 빈 배열 = 퇴원(정규 반 없음)
  const rows = await db.$queryRawUnsafe<any[]>(
    `SELECT e."studentId", e.status AS "enrollmentStatus", e."startsOn",
            c.id AS "classId", c.name AS "className", c."dayOfWeek", c."startTime",
            sc.kind AS "scheduledKind", to_char(sc."effectiveFrom",'YYYY-MM-DD') AS "scheduledFrom",
            to_char(sc."resumeOn",'YYYY-MM-DD') AS "scheduledResumeOn",
            to_char(pz."resumeOn",'YYYY-MM-DD') AS "pausedResumeOn"
       FROM "Enrollment" e
       JOIN "Class" c ON c.id = e."classId" AND c."dayOfWeek" <> 'Seasonal'
       -- 승인됐지만 아직 반영 전인 신청 중 가장 이른 1건(loadChildClasses 와 같은 기준)
       LEFT JOIN LATERAL (
         SELECT x.kind, x."effectiveFrom", x."resumeOn" FROM "EnrollmentChangeRequest" x
          WHERE x."enrollmentId" = e.id AND x.status = 'APPROVED' AND x."appliedAt" IS NULL
          ORDER BY x."effectiveFrom" LIMIT 1
       ) sc ON true
       -- 휴원 중이면 마지막으로 반영된 휴원 신청의 복귀 예정일
       LEFT JOIN LATERAL (
         SELECT x."resumeOn" FROM "EnrollmentChangeRequest" x
          WHERE e.status = 'PAUSED' AND x."enrollmentId" = e.id AND x.kind = 'PAUSE' AND x.status = 'APPLIED'
          ORDER BY x."appliedAt" DESC NULLS LAST LIMIT 1
       ) pz ON true
      WHERE e."studentId" = ANY($1::text[]) AND e.status IN ('ACTIVE','PAUSED')`,
    ids,
  );
  for (const row of rows) {
    const list = out.get(String(row.studentId));
    if (!list) continue;
    list.push({
      classId: String(row.classId),
      className: String(row.className ?? "수강 반"),
      dayOfWeek: String(row.dayOfWeek ?? ""),
      startTime: String(row.startTime ?? ""),
      status: String(row.enrollmentStatus),
      startsOn: commencementYmd(row.startsOn),
      scheduled: row.scheduledKind
        ? { kind: String(row.scheduledKind), effectiveFrom: String(row.scheduledFrom ?? ""), resumeOn: (row.scheduledResumeOn ?? null) as string | null }
        : null,
      pausedResumeOn: row.pausedResumeOn ?? null,
    });
  }
  return out;
}

/** 연간일정 — 못 읽으면 null(휴무 판정 없이 기존대로). 학부모 셔틀과 같은 함수. */
export async function loadRegularRunPlan(): Promise<{ events: PlanEvent[]; monthlyDates: MonthlyClassDates } | null> {
  const events = await loadAnnualPlanEvents().catch(() => null);
  if (!events) return null;
  return { events, monthlyDates: (ym: string, dow: string) => getMonthlyClassDates(events, ym, dow) };
}

type RosterRowLike = { id?: string; weekday: number; classTime: string | null; studentId?: string | null };

/**
 * 그날 명단 행들의 잠금 판정 — 휴무(그날 전체)와 행별 뱃지 글자.
 * 어느 재료든 못 읽으면 그 판정만 건너뛴다(기사님 화면이 같이 죽으면 안 된다).
 */
export async function getRegularRunDayBlocks(
  rows: readonly RosterRowLike[],
  ymd: string,
): Promise<{ holiday: RunHoliday | null; labelByRowId: Map<string, string> }> {
  const studentIds = rows.map((r) => r.studentId ?? "").filter(Boolean);
  const [classesByStudent, plan] = await Promise.all([
    loadRosterClassesByStudent(prisma, studentIds).catch((e) => {
      console.error("[regularRunDay] 수강 상태 조회 실패 — 휴원 잠금 없이 표시", e);
      return null;
    }),
    loadRegularRunPlan(),
  ]);
  const holiday = plan ? regularRunHoliday(ymd, plan.monthlyDates, plan.events) : null;
  const labelByRowId = new Map<string, string>();
  for (const r of rows) {
    if (!r.id) continue;
    // 학생 id 가 없거나 수강 조회가 실패하면 수강 판정은 «모름»(undefined) — 휴무만 본다.
    const classes = classesByStudent && r.studentId ? classesByStudent.get(r.studentId) : undefined;
    const kind = riderBlockOf(r, classes, ymd, holiday);
    if (kind) labelByRowId.set(r.id, RIDER_BLOCK_LABEL[kind]);
  }
  return { holiday, labelByRowId };
}

/**
 * 관리자 운행표(«월+요일» 기본형)용 표시 — 날짜가 아니라 달을 보므로:
 *   - 학생 뱃지: 기준일(refYmd) 수강 상태(휴원·퇴원·첫 수업 전). 휴무는 줄에 붙이지 않는다.
 *   - 휴무: 그 달 휴무일 목록(요일 탭마다 «이 달 휴무» 한 줄).
 * 관리자 화면엔 탑승 버튼이 없어 잠그지 않고 뱃지만 보인다. 실패하면 빈 표시(화면은 뜬다).
 */
export async function getRegularRosterMonthMarks(
  rows: readonly RosterRowLike[],
  month: string,
  refYmd: string,
): Promise<{ labelByRowId: Record<string, string>; holidays: (RunHoliday & { weekday: number })[] }> {
  const studentIds = rows.map((r) => r.studentId ?? "").filter(Boolean);
  const [classesByStudent, plan] = await Promise.all([
    loadRosterClassesByStudent(prisma, studentIds).catch((e) => {
      console.error("[regularRunDay] 수강 상태 조회 실패 — 휴원 뱃지 없이 표시", e);
      return null;
    }),
    loadRegularRunPlan(),
  ]);
  const labelByRowId: Record<string, string> = {};
  for (const r of rows) {
    if (!r.id || !classesByStudent || !r.studentId) continue;
    const kind = rosterRowBlock(r, classesByStudent.get(r.studentId), refYmd);
    if (kind) labelByRowId[r.id] = RIDER_BLOCK_LABEL[kind];
  }
  return { labelByRowId, holidays: plan ? monthRunHolidays(month, plan.monthlyDates, plan.events) : [] };
}
