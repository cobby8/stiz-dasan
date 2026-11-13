import { prisma } from "@/lib/prisma";
import { childAccessSql } from "@/lib/account/child-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { addMonthsYm, todayKst } from "@/lib/datetime/kst";
import { commencementYmd } from "@/lib/enrollment/commencement";
import { resumeFromSql } from "@/lib/enrollment/resumeWindow";
import { getMonthlyClassDates, loadAnnualPlanEvents } from "@/lib/enrollment/monthlyClassDates";
import { classDatesForCalendarMonth, shiftMonth } from "@/lib/mypage/parentSchedule";
import { getParentShuttleOverview } from "@/lib/shuttle/parent";
import {
  classCardActions,
  classShuttleLines,
  classStatusChip,
  nextClassDate,
  recentAttendanceCells,
  type AttendanceCell,
  type ClassCardAction,
  type ClassChip,
  type ClassShuttleLine,
} from "@/lib/parent/classCards";

// ── 학부모 «수업» 탭 반 카드 조회 (2026-11-10 원장 결정 설계 B) ─────────────────
//
// ★ 보안 가드(반드시 유지): 모든 조회 = childAccessSql(그 부모의 자녀만) + notMergedStudent(병합된 옛 학생 제외).
// 홈의 getMyPageData 는 «수강 중(ACTIVE)»만 읽는다 — 휴원 중(PAUSED) 반도 여기선 보여야 [복귀 신청]을 누를 수 있어
// 따로 읽는다(getMyPageData 기준은 홈에서 건드리지 않는다).
// 쓰기 없음. $queryRawUnsafe 만(PgBouncer).

/** 방학특강 반(dayOfWeek='Seasonal')은 별도 흐름이라 뺀다(수강 변경 화면과 같은 기준). */
const REGULAR_CLASS_FILTER = `c."dayOfWeek" <> 'Seasonal'`;

export type ParentClassCard = {
  studentId: string;
  enrollmentId: string;
  classId: string;
  className: string;
  programName: string | null;
  coachName: string | null;
  location: string | null;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  paused: boolean;
  /** 복귀가 승인된 휴원 반이면 복귀일 "YYYY-MM-DD"(2026-11-14 복귀 예정) — 그날 이후 수업이 «다음 수업», 버튼은 일반 반과 같다 */
  resumeFrom: string | null;
  chip: ClassChip;
  /** 다음 수업일 "YYYY-MM-DD"(없으면 null) */
  nextClass: string | null;
  /** 연간일정에서 수업일을 계산하지 못했다(확정 전) — «다음 수업» 자리에 안내 */
  planMissing: boolean;
  /** 첫 수업 전이면 개시일 */
  startsOn: string | null;
  attendance: AttendanceCell[];
  /** 이번 달(KST) 출석 «n/m회» — n = 출석+지각, m = 출석+지각+결석. 기록이 없으면 null(2026-11-14 w4) */
  monthAttendance: { ok: number; total: number } | null;
  shuttle: ClassShuttleLine[];
  actions: ClassCardAction[];
};

export type ParentClassesOverview = {
  today: string;
  children: { id: string; name: string; classes: ParentClassCard[] }[];
};

export async function getParentClassesOverview(parentUserId: string): Promise<ParentClassesOverview> {
  const today = todayKst();
  const access = await childAccessSql("s", "$1");

  // 이번 달 범위(KST 달력) — Session.date 는 시간대 없는 칸이라 두 번 변환한 값과 비교한다
  const monthFrom = `${today.slice(0, 7)}-01`;
  const monthTo = `${addMonthsYm(today.slice(0, 7), 1)}-01`;

  const [students, enrollments, attendance, shuttleItems, planEvents, monthCounts] = await Promise.all([
    // 자녀 목록(반이 없는 아이도 칩에 보인다)
    prisma.$queryRawUnsafe<{ id: string; name: string }[]>(
      `SELECT s.id, s.name FROM "Student" s
        WHERE ${access} AND ${notMergedStudent("s")}
        ORDER BY s."createdAt" ASC`,
      parentUserId,
    ),
    // 반 카드 재료: 다니는 중 + 휴원 중 정규 반, 반·프로그램·코치, 상태 칩 재료(승인 예정·검토 중·휴원 복귀 예정일)
    prisma.$queryRawUnsafe<any[]>(
      `SELECT s.id AS "studentId", e.id AS "enrollmentId", e.status AS "enrollmentStatus", e."startsOn",
              c.id AS "classId", c.name AS "className", c."dayOfWeek", c."startTime", c."endTime", c.location,
              p.name AS "programName", u.name AS "coachName",
              sc.kind AS "scheduledKind", to_char(sc."effectiveFrom",'YYYY-MM-DD') AS "scheduledFrom",
              to_char(sc."resumeOn",'YYYY-MM-DD') AS "scheduledResumeOn",
              pr.kind AS "pendingKind", to_char(pr."effectiveFrom",'YYYY-MM-DD') AS "pendingFrom",
              to_char(pz."resumeOn",'YYYY-MM-DD') AS "pausedResumeOn",
              -- 승인된 복귀일(공용 규칙 resumeWindow) — 휴원 신청의 «복귀 예정일»(pausedResumeOn)과 다른 값이다
              ${resumeFromSql("e")} AS "resumeFrom"
         FROM "Student" s
         JOIN "Enrollment" e ON e."studentId" = s.id AND e.status IN ('ACTIVE','PAUSED') AND ${notMergedStudent("s")}
         JOIN "Class" c ON c.id = e."classId" AND ${REGULAR_CLASS_FILTER}
         LEFT JOIN "Program" p ON p.id = c."programId"
         LEFT JOIN "User" u ON u.id = c."instructorId"
         -- 승인됐지만 아직 반영 전인 신청 중 가장 이른 1건(홈 반 상태 한 줄과 같은 기준)
         LEFT JOIN LATERAL (
           SELECT x.kind, x."effectiveFrom", x."resumeOn" FROM "EnrollmentChangeRequest" x
            WHERE x."enrollmentId" = e.id AND x.status = 'APPROVED' AND x."appliedAt" IS NULL
            ORDER BY x."effectiveFrom" LIMIT 1
         ) sc ON true
         -- 검토 중 신청(수강 등록당 1건 — DB 부분 유니크)
         LEFT JOIN LATERAL (
           SELECT x.kind, x."effectiveFrom" FROM "EnrollmentChangeRequest" x
            WHERE x."enrollmentId" = e.id AND x.status = 'PENDING'
            ORDER BY x."createdAt" DESC LIMIT 1
         ) pr ON true
         -- 휴원 중이면 마지막으로 반영된 휴원 신청의 복귀 예정일
         LEFT JOIN LATERAL (
           SELECT x."resumeOn" FROM "EnrollmentChangeRequest" x
            WHERE e.status = 'PAUSED' AND x."enrollmentId" = e.id AND x.kind = 'PAUSE' AND x.status = 'APPLIED'
            ORDER BY x."appliedAt" DESC NULLS LAST LIMIT 1
         ) pz ON true
        WHERE ${access} AND ${notMergedStudent("s")}
        ORDER BY s."createdAt", c."dayOfWeek", c."startTime"`,
      parentUserId,
    ),
    // 반별 최근 출결 4건(오늘까지). Session.date 는 시간대 없는 칸이라 날짜 변환은 화면 쪽(toKstYmd)에서 한다
    // — 일정 탭 달력(buildParentMonth)과 같은 방식.
    prisma.$queryRawUnsafe<{ studentId: string; classId: string; status: string; date: Date | string }[]>(
      `SELECT x."studentId", x."classId", x.status, x.date FROM (
         SELECT a."studentId", se."classId", a.status, se.date,
                row_number() OVER (PARTITION BY a."studentId", se."classId" ORDER BY se.date DESC) AS rn
           FROM "Attendance" a
           JOIN "Session" se ON se.id = a."sessionId"
           JOIN "Student" s ON s.id = a."studentId" AND ${notMergedStudent("s")}
          WHERE ${access}
            AND se.date <= (now() AT TIME ZONE 'UTC')
       ) x WHERE x.rn <= 4`,
      parentUserId,
    ),
    // 셔틀 배정(일정 탭과 같은 조회). 실패해도 카드는 열리게 빈 목록.
    getParentShuttleOverview(parentUserId).catch(() => []),
    loadAnnualPlanEvents().catch(() => []),
    // 반별 이번 달 출석 수(SQL 에서 센다). 실패해도 카드는 열리게 빈 목록(«이번 달 출석» 줄만 빠진다)
    prisma.$queryRawUnsafe<{ studentId: string; classId: string; ok: number; total: number }[]>(
      `SELECT a."studentId", se."classId",
              COUNT(*) FILTER (WHERE a.status IN ('PRESENT','LATE'))::int AS ok,
              COUNT(*) FILTER (WHERE a.status IN ('PRESENT','LATE','ABSENT'))::int AS total
         FROM "Attendance" a
         JOIN "Session" se ON se.id = a."sessionId"
         JOIN "Student" s ON s.id = a."studentId" AND ${notMergedStudent("s")}
        WHERE ${access}
          AND ((se.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul') >= $2::timestamp
          AND ((se.date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul') < $3::timestamp
        GROUP BY a."studentId", se."classId"`,
      parentUserId, monthFrom, monthTo,
    ).catch(() => []),
  ]);

  // 다음 수업일 = 이번 달·다음 달 수업일(공개 연간일정·청구와 같은 계산) 중 오늘 이후 첫날
  const thisMonth = today.slice(0, 7);
  // 복귀 예정 반은 복귀일이 다음 달보다 뒤일 수 있다(최대 3개월) — 복귀하는 달과 그 다음 달까지 본다
  const monthsFor = (resumeFrom: string | null) => {
    const months = [thisMonth, shiftMonth(thisMonth, 1)];
    const last = resumeFrom ? shiftMonth(resumeFrom.slice(0, 7), 1) : "";
    while (months[months.length - 1] < last && months.length < 6) months.push(shiftMonth(months[months.length - 1], 1));
    return months;
  };
  const datesFor = (dayOfWeek: string, startsOn: string | null, resumeFrom: string | null = null) =>
    monthsFor(resumeFrom).flatMap((month) =>
      classDatesForCalendarMonth(month, dayOfWeek, startsOn, (ym, dow) => getMonthlyClassDates(planEvents, ym, dow)),
    );

  const cards: ParentClassCard[] = enrollments.map((row) => {
    const paused = row.enrollmentStatus === "PAUSED";
    // 승인된 복귀일(휴원 중일 때만 값이 있다)
    const resumeFrom: string | null = paused ? row.resumeFrom ?? null : null;
    const startsOn = commencementYmd(row.startsOn);
    const scheduled = row.scheduledKind
      ? { kind: row.scheduledKind as string, effectiveFrom: row.scheduledFrom as string, resumeOn: (row.scheduledResumeOn ?? null) as string | null }
      : null;
    const dates = datesFor(row.dayOfWeek, startsOn, resumeFrom);
    // 승인된 휴원·퇴원 적용일부터는 수업이 없다
    const stopFrom = scheduled && (scheduled.kind === "PAUSE" || scheduled.kind === "WITHDRAW") ? scheduled.effectiveFrom : null;
    return {
      studentId: row.studentId,
      enrollmentId: row.enrollmentId,
      classId: row.classId,
      className: row.className,
      programName: row.programName ?? null,
      coachName: row.coachName ?? null,
      location: row.location ?? null,
      dayOfWeek: row.dayOfWeek,
      startTime: row.startTime,
      endTime: row.endTime,
      paused,
      resumeFrom,
      chip: classStatusChip({
        enrollmentStatus: row.enrollmentStatus,
        scheduled,
        pending: row.pendingKind ? { kind: row.pendingKind, effectiveFrom: row.pendingFrom } : null,
        pausedResumeOn: row.pausedResumeOn ?? null,
        today,
      }),
      nextClass: nextClassDate({ dates, today, paused, stopFrom, resumeFrom }),
      planMissing: (!paused || !!resumeFrom) && dates.length === 0,
      startsOn: startsOn && startsOn > today ? startsOn : null,
      attendance: recentAttendanceCells(
        attendance.filter((a) => a.studentId === row.studentId && a.classId === row.classId),
      ),
      monthAttendance: (() => {
        const m = monthCounts.find((x) => x.studentId === row.studentId && x.classId === row.classId);
        return m && Number(m.total) > 0 ? { ok: Number(m.ok), total: Number(m.total) } : null;
      })(),
      shuttle: classShuttleLines(shuttleItems, { studentId: row.studentId, classId: row.classId, className: row.className }, today),
      actions: classCardActions({ studentId: row.studentId, enrollmentId: row.enrollmentId, paused, resumeFrom }),
    };
  });

  return {
    today,
    children: students.map((s) => ({ id: s.id, name: s.name, classes: cards.filter((c) => c.studentId === s.id) })),
  };
}
