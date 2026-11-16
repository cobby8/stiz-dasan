// 수업 미처리 장치(2026-11-17) — «그날의 반별 사실»을 읽는 집합 조회.
//
// 여기서 읽는 것은 «사실»(DB 에 적힌 것)뿐이다. «지금 몇 시라서 미처리인가» 같은 판정은 rules.ts 가 한다.
// 그래서 사실은 잠깐 캐시해도 되고, 판정은 매번 새 시각으로 다시 한다.
//
// - DB 는 인자로 받는다(테스트가 가짜 db 로 그대로 실행한다). prisma·next import 금지.
// - 반마다 돌지 않는다 — 집합 조회 4번(정규·특강·휴강·담당).
// - 미확인 인원의 조건은 선생님 «수업 종료» 조건(staff-sessions.ts completeClassSession)과 같아야 한다.
//   한쪽만 바뀌면 «화면은 미확인 0인데 종료가 안 된다»가 생긴다 → 기존 SQL 조각을 끼워 쓰고
//   tests/class-nudge-board-query.test.mjs 가 두 쪽 글자를 비교한다.
import { isKstYmd, kstDow } from "@/lib/datetime/kst";
import { sessionKstDateSql } from "@/lib/feed/rules";
import { makeupOnClassDateSql } from "@/lib/makeup/makeup-attendance";
import { CLASS_DAY_KEYS, SUBSTITUTE_TEACHER_SQL } from "@/lib/staff/classSubstitute";
import { notMergedStudent } from "@/lib/studentVisibility";
import type { ClassDayKind } from "./rules";

export type ClassNudgeDb = {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
};

export type RegularClassDayFact = {
  kind: "REGULAR";
  classId: string;
  name: string;
  /** Class.startTime — "HH:MM"(KST) 글자 그대로. 절대 시각은 rules.lessonWindowMs 가 만든다 */
  startTime: string | null;
  endTime: string | null;
  capacity: number | null;
  sessionId: string | null;
  sessionStatus: string | null;
  /** 정규 수강생 + 보강 온 아이 */
  rosterCount: number;
  unmarkedCount: number;
};

export type SeasonalClassDayFact = {
  kind: "SEASONAL";
  classId: string;
  name: string;
  /** 형제 회차 중 대표(기록이 있는 것 우선) — 출결 화면 lessonKey 와 같다 */
  sessionDateId: string;
  startMs: number | null;
  endMs: number | null;
  startTime: string | null;
  endTime: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  /** 그날 실제 좌석 수 */
  rosterCount: number;
  unmarkedCount: number;
  coachName: string | null;
  coachUserId: string | null;
};

export type ClassDayCancelRow = {
  id: string;
  date: string;
  classId: string;
  kind: ClassDayKind;
  /** 정규는 '', 특강은 회차 시작 "HH:MM" */
  startTime: string;
  reason: string | null;
};

export type ClassDayAssigneeRole = "COACH" | "INSTRUCTOR" | "SUBSTITUTE";
export type ClassDayAssignee = {
  classId: string;
  /** 앱 계정. 비어 있으면 이름은 보이지만 앱 알림을 받지 못한다(코치 계정 미연결) */
  userId: string | null;
  name: string;
  role: ClassDayAssigneeRole;
};

export type ClassDayDbFacts = {
  regular: RegularClassDayFact[];
  seasonal: SeasonalClassDayFact[];
  cancels: ClassDayCancelRow[];
  assignees: ClassDayAssignee[];
};

/** COUNT·bigint 결과를 화면·캐시가 다룰 수 있는 number 로(BigInt 는 JSON 으로 못 바꾼다) */
function toInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function toMs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * «그 수업일에 출결을 찍어야 하는 정규 수강생» 조건(SQL 조각).
 * 선생님 «수업 종료»가 쓰는 조건과 같은 글자다 — tests/class-nudge-board-query.test.mjs 가 staff-sessions.ts 원문과 비교한다.
 * @param e Enrollment 별칭 · @param dateParam 수업일 자리표시자(예: "$1")
 */
export function activeEnrollmentOnDateSql(e: string, dateParam: string): string {
  return `${e}.status = 'ACTIVE'
           AND (${e}."startsOn" IS NULL OR ${e}."startsOn" <= ${dateParam}::date)`;
}

type RegularRow = {
  classId: string; name: string; startTime: string | null; endTime: string | null; capacity: unknown;
  sessionId: string | null; sessionStatus: string | null;
  enrolledCount: unknown; enrolledUnmarked: unknown; makeupCount: unknown; makeupUnmarked: unknown;
  hasSeasonalToday: unknown;
};

/**
 * 정규 반의 그날 사실(쿼리 1번). $1 = 날짜, $2 = 요일 글자(Mon…).
 * - 수업 기록은 같은 반·같은 날에 둘이 있던 옛 사고를 대비해 하나만 고른다(키 있는 것 → 먼저 만든 것).
 * - Session.date 는 시간대 없는 칼럼이라 «두 번» 변환한 조각(sessionKstDateSql)으로 비교한다 — 지난 날짜도 같은 조회로 읽기 위해.
 * - 보강 온 아이는 그 반 수강생이기도 하면 한 번만 센다(화면 숫자가 명단과 맞게).
 * - 체험 아이는 종료 조건에 없어 세지 않는다.
 * - 그날 특강 회차가 연결된 반은 버린다 — 그날은 특강 회차가 출석부를 대신한다.
 */
export async function loadRegularClassDayFacts(db: ClassNudgeDb, dateYmd: string): Promise<RegularClassDayFact[]> {
  if (!isKstYmd(dateYmd)) return [];
  // 요일은 달력 숫자로만 구한다(서버 시간대와 무관)
  const dayKey = CLASS_DAY_KEYS[kstDow(dateYmd)];
  const rows = await db.$queryRawUnsafe<RegularRow[]>(
    `SELECT c.id AS "classId", c.name, c."startTime", c."endTime", c.capacity,
            s.id AS "sessionId", s.status AS "sessionStatus",
            COALESCE(en.cnt, 0)::int      AS "enrolledCount",
            COALESCE(en.unmarked, 0)::int AS "enrolledUnmarked",
            COALESCE(mk.cnt, 0)::int      AS "makeupCount",
            COALESCE(mk.unmarked, 0)::int AS "makeupUnmarked",
            EXISTS (
              SELECT 1 FROM "SpecialProgramSessionDate" xsd
                JOIN "SpecialProgramOffering" xo ON xo.id = xsd."offeringId" AND xo.status <> 'CANCELLED'
               WHERE xo."linkedClassId" = c.id
                 AND (xsd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $1::date
            ) AS "hasSeasonalToday"
       FROM "Class" c
       LEFT JOIN LATERAL (
         SELECT se.id, se.status
           FROM "Session" se
          WHERE se."classId" = c.id
            AND se."specialProgramSessionDateId" IS NULL
            AND ${sessionKstDateSql("se")} = $1::date
          ORDER BY (se."sessionKey" IS NULL), se."createdAt", se.id
          LIMIT 1
       ) s ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS cnt,
                COUNT(*) FILTER (WHERE s.id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM "Attendance" a WHERE a."sessionId" = s.id AND a."studentId" = e."studentId"
                )) AS unmarked
           FROM "Enrollment" e
          WHERE e."classId" = c.id AND ${activeEnrollmentOnDateSql("e", "$1")}
       ) en ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT ms."studentId") AS cnt,
                COUNT(DISTINCT ms."studentId") FILTER (WHERE s.id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM "Attendance" a WHERE a."sessionId" = s.id AND a."studentId" = ms."studentId"
                )) AS unmarked
           FROM "MakeupSession" ms
           JOIN "Student" st ON st.id = ms."studentId" AND ${notMergedStudent("st")}
          WHERE ${makeupOnClassDateSql("ms", "c.id", "$1")}
            AND NOT EXISTS (
              SELECT 1 FROM "Enrollment" e2
               WHERE e2."classId" = c.id AND e2."studentId" = ms."studentId" AND ${activeEnrollmentOnDateSql("e2", "$1")}
            )
       ) mk ON true
      WHERE c."dayOfWeek" = $2
      ORDER BY c."startTime", c.name`,
    dateYmd,
    dayKey,
  );
  return rows
    .filter((row) => row.hasSeasonalToday !== true)
    .map((row) => ({
      kind: "REGULAR" as const,
      classId: String(row.classId),
      name: String(row.name ?? ""),
      startTime: row.startTime ?? null,
      endTime: row.endTime ?? null,
      capacity: row.capacity === null || row.capacity === undefined ? null : toInt(row.capacity),
      sessionId: row.sessionId ?? null,
      sessionStatus: row.sessionStatus ?? null,
      rosterCount: toInt(row.enrolledCount) + toInt(row.makeupCount),
      unmarkedCount: toInt(row.enrolledUnmarked) + toInt(row.makeupUnmarked),
    }));
}

type SeasonalRow = {
  classId: string; name: string; sessionDateId: string;
  seatCount: unknown; seatUnmarked: unknown; seatUnrecorded: unknown;
  startMs: unknown; endMs: unknown; startTime: string | null; endTime: string | null;
  sessionId: string | null; sessionStatus: string | null;
  coachName: string | null; coachUserId: string | null;
};

/**
 * 특강 회차의 그날 사실(쿼리 1번). $1 = 날짜.
 * 선생님 홈의 회차 묶음(같은 반·같은 시각의 형제 회차를 한 줄로)과 같은 묶음이다.
 * - startsAt 은 timestamptz 라 시간대 변환을 «한 번»만 건다.
 * - 보관(ARCHIVED)된 시즌·취소된 상품은 뺀다(관리자 목록과 같은 기준).
 * - 담당 = 수업 기록의 코치 → 없으면 상품의 담당 강사(권한 판정과 같은 순서).
 *
 * 미확인 좌석은 두 가지로 센다(설계와 달라진 점):
 *   seatUnmarked   = 좌석 출결 칸이 비어 있다 — 선생님 «수업 종료» 조건과 같은 셈
 *   seatUnrecorded = 좌석 출결 칸도 비었고 그 아이의 출결 기록(Attendance)도 없다
 * 관리자 출결 화면의 특강 저장은 Attendance 만 쓰고 좌석 칸은 채우지 않는다(admin.ts saveAttendance 특강 갈래).
 * 그래서 좌석 칸만 보면 관리자가 다 넣어 둔 특강이 «미확인»으로 떠 선생님을 헛되이 독촉한다.
 * → 진행 중인 수업은 종료 조건과 같은 seatUnmarked, 그 밖(기록 없음·예정·완료)은 seatUnrecorded 를 쓴다.
 */
export async function loadSeasonalClassDayFacts(db: ClassNudgeDb, dateYmd: string): Promise<SeasonalClassDayFact[]> {
  if (!isKstYmd(dateYmd)) return [];
  const rows = await db.$queryRawUnsafe<SeasonalRow[]>(
    `WITH occ AS (
       SELECT c.id AS "classId", c.name, sd."startsAt", sd."endsAt",
              (ARRAY_AGG(sd.id ORDER BY CASE WHEN es.id IS NULL THEN 1 ELSE 0 END, sd.id))[1] AS "sessionDateId",
              COUNT(DISTINCT ed.id)::int AS "seatCount",
              COUNT(DISTINCT ed.id) FILTER (WHERE ed."attendanceStatus" IS NULL)::int AS "seatUnmarked",
              COUNT(DISTINCT ed.id) FILTER (
                WHERE ed."attendanceStatus" IS NULL
                  AND NOT EXISTS (
                    SELECT 1
                      FROM "Attendance" a
                      JOIN "Session" xs ON xs.id = a."sessionId"
                      JOIN "SpecialProgramSessionDate" xsd ON xsd.id = xs."specialProgramSessionDateId"
                      JOIN "SpecialProgramOffering" xo ON xo.id = xsd."offeringId"
                     WHERE a."studentId" = ed."studentId"
                       AND xsd."startsAt" = sd."startsAt" AND xsd."endsAt" = sd."endsAt"
                       AND xo."linkedClassId" = c.id
                  )
              )::int AS "seatUnrecorded",
              MIN(o."instructorId") AS "instructorId", MIN(o."instructorName") AS "instructorName"
         FROM "SpecialProgramSessionDate" sd
         JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId" AND o.status <> 'CANCELLED'
         JOIN "SpecialProgramSeason" season ON season.id = o."seasonId" AND season.status <> 'ARCHIVED'
         JOIN "Class" c ON c.id = o."linkedClassId"
         LEFT JOIN "Session" es ON es."specialProgramSessionDateId" = sd.id
         LEFT JOIN "SpecialProgramApplicationItem" i ON i."offeringId" = o.id AND i.status = 'APPROVED'
         LEFT JOIN "SpecialProgramEnrollmentDate" ed
                ON ed."applicationItemId" = i.id AND ed."sessionDateId" = sd.id AND ed.status = 'SCHEDULED'
        WHERE (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $1::date
        GROUP BY c.id, c.name, sd."startsAt", sd."endsAt"
     )
     SELECT occ."classId", occ.name, occ."sessionDateId", occ."seatCount", occ."seatUnmarked", occ."seatUnrecorded",
            (EXTRACT(EPOCH FROM occ."startsAt") * 1000)::bigint AS "startMs",
            (EXTRACT(EPOCH FROM occ."endsAt")   * 1000)::bigint AS "endMs",
            to_char(occ."startsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS "startTime",
            to_char(occ."endsAt"   AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS "endTime",
            s.id AS "sessionId", s.status AS "sessionStatus",
            COALESCE(k.name, occ."instructorName") AS "coachName", k."userId" AS "coachUserId"
       FROM occ
       LEFT JOIN "Session" s ON s."specialProgramSessionDateId" = occ."sessionDateId"
       LEFT JOIN "Coach" k ON k.id = COALESCE(s."coachId", occ."instructorId")
      ORDER BY occ."startsAt", occ.name`,
    dateYmd,
  );
  return rows.map((row) => {
    const startMs = toMs(row.startMs);
    let endMs = toMs(row.endMs);
    // 끝이 시작보다 이르면 끝 판정만 보류(정규와 같은 방어)
    if (startMs !== null && endMs !== null && endMs <= startMs) endMs = null;
    const inProgress = row.sessionStatus === "IN_PROGRESS";
    return {
      kind: "SEASONAL" as const,
      classId: String(row.classId),
      name: String(row.name ?? ""),
      sessionDateId: String(row.sessionDateId),
      startMs,
      endMs,
      startTime: row.startTime ?? null,
      endTime: row.endTime ?? null,
      sessionId: row.sessionId ?? null,
      sessionStatus: row.sessionStatus ?? null,
      rosterCount: toInt(row.seatCount),
      unmarkedCount: toInt(inProgress ? row.seatUnmarked : row.seatUnrecorded),
      coachName: row.coachName ?? null,
      coachUserId: row.coachUserId ?? null,
    };
  });
}

/** 표가 아직 없을 때의 오류인가(42P01) — calendar/feedServer.ts isMissingFeedTable 과 같은 판정 */
export function isMissingCancelTable(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string }; message?: string } | null;
  const pg = e?.meta?.code ?? e?.code;
  return pg === "42P01" || /relation "?(public\.)?"?ClassDayCancel"? does not exist/i.test(e?.message ?? "");
}

/**
 * 그날의 휴강 표시(쿼리 1번). 표가 아직 없으면(운영 적용 전) «휴강 없음».
 * 정규·특강 조회에 JOIN 으로 묶지 않고 따로 읽는 이유가 이것이다 — 묶으면 표가 없을 때 현황 전체가 죽는다.
 * 그 밖의 오류는 삼키지 않고 던진다.
 */
export async function loadClassDayCancels(db: ClassNudgeDb, dateYmd: string): Promise<ClassDayCancelRow[]> {
  if (!isKstYmd(dateYmd)) return [];
  try {
    const rows = await db.$queryRawUnsafe<ClassDayCancelRow[]>(
      `SELECT id, date, "classId", kind, "startTime", reason
         FROM "ClassDayCancel"
        WHERE date = $1`,
      dateYmd,
    );
    return rows.map((row) => ({
      id: String(row.id),
      date: String(row.date),
      classId: String(row.classId),
      kind: row.kind === "SEASONAL" ? "SEASONAL" : "REGULAR",
      startTime: String(row.startTime ?? ""),
      reason: row.reason ?? null,
    }));
  } catch (error) {
    if (isMissingCancelTable(error)) return [];
    throw error;
  }
}

/**
 * 정규 반의 담당 사람 목록(쿼리 1번). $1 = 반 id 배열, $2 = 날짜.
 * 기준은 «그 반 출석부를 실제로 열 수 있는 사람»(권한 판정 getAccessibleClassIds 와 같은 갈래 + 그날 대타)이다 —
 * 화면에 이름이 보이는 사람과 2단계 알림을 받을 사람이 같은 한 번의 조회에서 나와야 알림이 헛돌지 않는다.
 * 특강 줄의 담당은 특강 조회에 이미 실려 있어 여기서 읽지 않는다.
 */
export async function loadClassDayAssignees(
  db: ClassNudgeDb,
  dateYmd: string,
  classIds: readonly string[],
): Promise<ClassDayAssignee[]> {
  const ids = [...new Set(classIds.filter(Boolean))];
  if (ids.length === 0 || !isKstYmd(dateYmd)) return [];
  const rows = await db.$queryRawUnsafe<Array<{ classId: string; userId: string | null; name: string | null; role: string }>>(
    `SELECT c.id AS "classId", k."userId" AS "userId", k.name AS name, 'COACH' AS role
       FROM "Class" c
       JOIN "Coach" k ON k.id IN (
            SELECT ss."coachId" FROM "ScheduleSlot" ss WHERE ss."slotKey" = c."slotKey"
            UNION SELECT cso."coachId" FROM "ClassSlotOverride" cso WHERE cso."slotKey" = c."slotKey"
            UNION SELECT ccs."coachId" FROM "CustomClassSlot" ccs WHERE ccs.id = c."slotKey")
      WHERE c.id = ANY($1::text[]) AND c."slotKey" IS NOT NULL
     UNION
     SELECT c.id, u.id, u.name, 'INSTRUCTOR'
       FROM "Class" c
       JOIN "User" u ON u.id = c."instructorId"
      WHERE c.id = ANY($1::text[]) AND c."slotKey" IS NULL
     UNION
     SELECT cs."classId", u.id, u.name, 'SUBSTITUTE'
       FROM "ClassSubstitute" cs
       JOIN "User" u ON u.id = cs."substituteUserId" AND ${SUBSTITUTE_TEACHER_SQL}
      WHERE cs."classId" = ANY($1::text[]) AND cs.date = $2`,
    ids,
    dateYmd,
  );
  return rows.map((row) => ({
    classId: String(row.classId),
    userId: row.userId ?? null,
    name: String(row.name ?? "").trim() || "이름 없음",
    role: row.role === "SUBSTITUTE" ? "SUBSTITUTE" : row.role === "INSTRUCTOR" ? "INSTRUCTOR" : "COACH",
  }));
}

/**
 * 그날의 DB 사실 전부. 조회 4번을 **차례로** 보낸다 —
 * 서버 DB 연결 한도가 작고 대시보드 첫 화면이 이미 여러 조회를 동시에 돌리므로 한꺼번에 쏘지 않는다.
 */
export async function loadClassDayDbFacts(db: ClassNudgeDb, dateYmd: string): Promise<ClassDayDbFacts> {
  const regular = await loadRegularClassDayFacts(db, dateYmd);
  const seasonal = await loadSeasonalClassDayFacts(db, dateYmd);
  const cancels = await loadClassDayCancels(db, dateYmd);
  const assignees = await loadClassDayAssignees(db, dateYmd, regular.map((row) => row.classId));
  return { regular, seasonal, cancels, assignees };
}
