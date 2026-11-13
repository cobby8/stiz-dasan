import { prisma } from "@/lib/prisma";
import {
  getAccessibleClassIds,
  getStaffClassAccessContext,
  getSubstituteClassIds,
  requireStaffClassAccess,
  requireStaffSeasonalSessionAccess,
  requireStaffSessionAccess,
} from "@/lib/staff-class-access";
import { notMergedStudent } from "@/lib/studentVisibility";
import { kstDow } from "@/lib/datetime/kst";
import { makeupOnClassDateSql } from "@/lib/makeup/makeup-attendance";
import { absenceReportOf } from "@/lib/regular/attendance-absence-reason";
import { TRIAL_ROSTER_STATUSES, trialRosterKey } from "@/lib/staff-session-rules";

export type StaffTodayClass = {
  id: string;
  name: string;
  startTime: string;
  endTime: string;
  location: string | null;
  studentCount: number;
  sessionId: string | null;
  sessionStatus: string | null;
  plannedContent: string | null;
  startedAt: string | null;
  kind: "REGULAR" | "SEASONAL";
  scheduleKey: string;
  sessionDateId: string | null;
  /** f4 대타: 담당 반이 아니라 이 날짜 대타로만 보이는 반이면 true(화면에 «대타» 표시·수업 공지 숨김). */
  substitute: boolean;
};

export type StaffSessionDetail = {
  id: string;
  classId: string;
  className: string;
  startTime: string;
  endTime: string;
  location: string | null;
  studentCount: number;
  status: string;
  plannedContent: string | null;
  content: string | null;
  notes: string | null;
  photos: string[];
  startedAt: string | null;
  endedAt: string | null;
  // 방학특강 회차 식별자(정규 수업이면 null). 진행 화면에서 시작 취소 후 이동 경로 분기에 사용.
  sessionDateId: string | null;
};

export type StaffSessionStudent = {
  // React 렌더 key 겸 화면 표시용 고유 식별자.
  //  - 정규: studentId  /  - 방학특강: enrollmentDateId(그 좌석)
  id: string;
  // 출결 저장 서버액션에 넘길 키.
  //  - 정규: studentId  /  - 방학특강: enrollmentDateId(좌석 = 정본)
  // ★ 방학특강은 미전환(Student 없음) 신청자도 로스터에 뜨므로 학생ID가 아닌 좌석ID로 저장한다.
  attendanceKey: string;
  // 전환된 Student.id (방학특강 미전환자는 null). 사진 태깅·정규 Attendance 병행에 사용.
  studentId: string | null;
  name: string;
  // 표시정보(방학특강 명단용). 정규는 현재 미사용(null).
  grade: string | null;
  phone: string | null;
  status: "PRESENT" | "LATE" | "ABSENT" | null;
  attendanceNote: string | null;
  arrivedAt: string | null;
  // 학부모가 미리 넣은 결석 신고. 선생님이 모르고 출석을 찍으면 신고가 헛것이 된다.
  // 정규 수업에만 있다(방학특강은 좌석 기준 별도 흐름이라 null).
  // source: SHEET=출석부에서 «질병·부상»으로 표시한 것 / PARENT=학부모 사전 신고(attendance-absence-reason.ts).
  absenceReport: { reason: string; status: string; source: "SHEET" | "PARENT" } | null;
  // 다른 반 아이가 이 수업에 보강 온 경우 true(정규 수업만). 출석 처리하면 보강 예약이 «참석»·보강권 «사용»이 된다.
  makeup: boolean;
  // 그날 이 수업으로 잡힌 체험수업 아이(정규 수업만). id·attendanceKey = «trial:<체험신청 id>».
  // 출결은 체험 장부(TrialLead.staffAttendanceStatus)에만 남고 정규 출석 표·청구·보강권과 섞이지 않는다.
  // 선생님에게는 이름·학년만 보인다(학부모 연락처 등은 내려보내지 않는다).
  trial: boolean;
};

type TodayClassRow = Omit<StaffTodayClass, "startedAt" | "kind" | "scheduleKey" | "sessionDateId"> & {
  startedAt: Date | string | null;
  kind?: "REGULAR" | "SEASONAL";
  scheduleKey?: string;
  sessionDateId?: string | null;
};
type SessionDetailRow = Omit<StaffSessionDetail, "startedAt" | "endedAt"> & {
  startedAt: Date | string | null;
  endedAt: Date | string | null;
  photosJSON: string | null;
};

const DAY_KEYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function getKoreaDateKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function toIso(value: Date | string | null) {
  return value ? new Date(value).toISOString() : null;
}

// dateKey(YYYY-MM-DD)를 인자로 받아 그 날짜의 담당 수업을 반환한다.
// 기본값은 오늘(getKoreaDateKey)이라 기존 홈 호출부(인자 없음)는 동작이 그대로 유지된다.
export async function getTodayStaffClasses(dateKey: string = getKoreaDateKey()): Promise<StaffTodayClass[]> {
  const access = await getStaffClassAccessContext();
  // f4 대타: 그 날짜(dateKey)에 대타로 지정된 반도 함께 띄운다. 다른 날짜엔 안 뜬다.
  const [assignedIds, substituteIds] = await Promise.all([
    getAccessibleClassIds(access),
    getSubstituteClassIds(access, dateKey),
  ]);
  const classIds = Array.from(new Set([...assignedIds, ...substituteIds]));

  // 요일은 공용 KST 모듈에서만(서버 시간대·기준 시각에 기대지 않는다)
  const koreaDay = kstDow(dateKey);
  const regularRows = classIds.length === 0 ? [] : await prisma.$queryRawUnsafe<TodayClassRow[]>(
    `SELECT c.id, c.name, c."startTime", c."endTime", c.location,
            COUNT(DISTINCT e.id)::int AS "studentCount",
            s.id AS "sessionId", s.status AS "sessionStatus",
            s."plannedContent", s."startedAt"
     FROM "Class" c
     LEFT JOIN "Enrollment" e ON e."classId" = c.id AND e.status = 'ACTIVE' AND (e."startsOn" IS NULL OR e."startsOn" <= $2::date OR EXISTS (
       SELECT 1 FROM "Attendance" historical JOIN "Session" prior ON prior.id=historical."sessionId"
       WHERE historical."studentId"=e."studentId" AND prior."classId"=c.id AND prior.date::date=$2::date
     ))
     LEFT JOIN "Session" s ON s."classId" = c.id AND s.date = $2::date
       AND s."specialProgramSessionDateId" IS NULL
     WHERE c.id = ANY($1::text[]) AND c."dayOfWeek" = $3
     GROUP BY c.id, s.id
     ORDER BY c."startTime", c.name`,
    classIds,
    dateKey,
    DAY_KEYS[koreaDay],
  );

  const seasonalRows = await prisma.$queryRawUnsafe<TodayClassRow[]>(
    `WITH occurrence AS (
       SELECT c.id,
              c.name,
              sd."startsAt",
              sd."endsAt",
              COALESCE(MIN(sd.location), MIN(o.location), c.location) AS location,
              (ARRAY_AGG(sd.id ORDER BY CASE WHEN existing_s.id IS NULL THEN 1 ELSE 0 END, sd.id))[1] AS "sessionDateId",
              -- 학생 수 = 그날 실제 좌석(SCHEDULED) 수. 전환 여부·요일이 아니라 좌석이 정본이다
              -- (미전환 신청자도 좌석이 있으면 포함, 취소 좌석은 제외 → 출석부와 숫자가 일치한다).
              COUNT(DISTINCT ed.id)::int AS "studentCount"
         FROM "SpecialProgramSessionDate" sd
         JOIN "SpecialProgramOffering" o ON o.id = sd."offeringId"
         JOIN "Class" c ON c.id = o."linkedClassId"
         LEFT JOIN "Session" existing_s ON existing_s."specialProgramSessionDateId" = sd.id
         LEFT JOIN "SpecialProgramApplicationItem" i
           ON i."offeringId" = o.id AND i.status = 'APPROVED'
         LEFT JOIN "SpecialProgramEnrollmentDate" ed
           ON ed."applicationItemId" = i.id AND ed."sessionDateId" = sd.id AND ed.status = 'SCHEDULED'
        WHERE (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $1::date
          -- 버그#3: 취소(CANCELLED)된 offering 회차는 명단에서 제외한다.
          -- 반+시간으로 GROUP BY 하므로, 한 반의 offering이 전부 취소면 그 반은 사라지고
          -- OPEN offering이 하나라도 남아 있으면 그 반은 유지된다(주n회 혼재 정상 처리).
          AND o.status <> 'CANCELLED'
          AND (
            $2::boolean = true
            OR EXISTS (
              SELECT 1
                FROM "SpecialProgramSessionDate" access_sd
                JOIN "SpecialProgramOffering" access_o ON access_o.id = access_sd."offeringId"
                LEFT JOIN "Session" access_s ON access_s."specialProgramSessionDateId" = access_sd.id
               WHERE access_sd."startsAt" = sd."startsAt"
                 AND access_sd."endsAt" = sd."endsAt"
                 AND access_o."linkedClassId" = o."linkedClassId"
                 AND access_o."seasonId" = o."seasonId"
                 -- 버그#3: 접근권한 판정도 취소된 offering은 제외(취소반으로 권한이 잡히지 않도록)
                 AND access_o.status <> 'CANCELLED'
                 AND (access_s."coachId" = $3 OR (access_s.id IS NULL AND access_o."instructorId" = $3))
            )
          )
        GROUP BY c.id, c.name, c.location, sd."startsAt", sd."endsAt"
     )
     SELECT occurrence.id,
            occurrence.name,
            to_char(occurrence."startsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS "startTime",
            to_char(occurrence."endsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI') AS "endTime",
            occurrence.location,
            occurrence."studentCount",
            s.id AS "sessionId", s.status AS "sessionStatus",
            s."plannedContent", s."startedAt",
            'SEASONAL' AS kind,
            ('seasonal:' || occurrence."sessionDateId") AS "scheduleKey",
            occurrence."sessionDateId"
       FROM occurrence
       LEFT JOIN "Session" s ON s."specialProgramSessionDateId" = occurrence."sessionDateId"
      ORDER BY occurrence."startsAt", occurrence.name`,
    dateKey,
    access.canAccessAllClasses,
    access.coachId,
  );

  const assignedSet = new Set(assignedIds);
  const normalizedRegular = regularRows.map((row) => ({
    ...row,
    substitute: !assignedSet.has(row.id),
    kind: "REGULAR" as const,
    scheduleKey: `regular:${row.id}`,
    sessionDateId: null,
    startedAt: toIso(row.startedAt),
  }));
  const normalizedSeasonal = seasonalRows.map((row) => ({
    ...row,
    substitute: false,
    kind: "SEASONAL" as const,
    scheduleKey: row.scheduleKey ?? `seasonal:${row.sessionDateId}`,
    sessionDateId: row.sessionDateId ?? null,
    startedAt: toIso(row.startedAt),
  }));
  return [...normalizedRegular, ...normalizedSeasonal].sort((a, b) =>
    a.startTime.localeCompare(b.startTime) || a.name.localeCompare(b.name),
  );
}

export async function getStaffSessionDetail(sessionId: string): Promise<StaffSessionDetail | null> {
  const rows = await prisma.$queryRawUnsafe<Array<SessionDetailRow & { sessionDateId: string | null }>>(
    `SELECT s.id, s."classId", COALESCE(c.name, anchor_o.title) AS "className",
            COALESCE(to_char(sd."startsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI'), c."startTime") AS "startTime",
            COALESCE(to_char(sd."endsAt" AT TIME ZONE 'Asia/Seoul', 'HH24:MI'), c."endTime") AS "endTime",
            COALESCE(sd.location, anchor_o.location, c.location) AS location,
            s.status, s."plannedContent", s.content, s.notes, s."photosJSON",
            s."startedAt", s."endedAt",
            s."specialProgramSessionDateId" AS "sessionDateId",
            CASE WHEN sd.id IS NOT NULL
              THEN COUNT(DISTINCT ed.id)
              ELSE COUNT(DISTINCT e.id)
            END::int AS "studentCount"
     FROM "Session" s
     JOIN "Class" c ON c.id = s."classId"
     LEFT JOIN "SpecialProgramSessionDate" sd ON sd.id = s."specialProgramSessionDateId"
     LEFT JOIN "SpecialProgramOffering" anchor_o ON anchor_o.id = sd."offeringId"
     LEFT JOIN "SpecialProgramSessionDate" matched_sd
       ON matched_sd."startsAt" = sd."startsAt" AND matched_sd."endsAt" = sd."endsAt"
     LEFT JOIN "SpecialProgramOffering" o
       ON o.id = matched_sd."offeringId"
      AND (
        o.id = anchor_o.id
        OR (
          anchor_o."linkedClassId" IS NOT NULL
          AND o."linkedClassId" = anchor_o."linkedClassId"
          AND o."seasonId" = anchor_o."seasonId"
        )
      )
     LEFT JOIN "SpecialProgramApplicationItem" i ON i."offeringId" = o.id
       AND i.status = 'APPROVED'
     -- 학생 수 = 그날 실제 좌석(SCHEDULED) 수(전환·요일 아님, 좌석이 정본 → 출석부와 일치).
     LEFT JOIN "SpecialProgramEnrollmentDate" ed
       ON ed."applicationItemId" = i.id AND ed."sessionDateId" = matched_sd.id AND ed.status = 'SCHEDULED'
     LEFT JOIN "Enrollment" e ON e."classId" = c.id AND e.status = 'ACTIVE' AND (e."startsOn" IS NULL OR e."startsOn" <= s.date::date OR EXISTS (
       SELECT 1 FROM "Attendance" historical WHERE historical."sessionId"=s.id AND historical."studentId"=e."studentId"
     ))
     WHERE s.id = $1
     GROUP BY s.id, c.id, sd.id, anchor_o.id
     LIMIT 1`,
    sessionId,
  );
  const row = rows[0];
  if (!row) return null;

  if (row.sessionDateId) await requireStaffSeasonalSessionAccess(row.sessionDateId);
  // 정규 수업은 수업 시작·출석 저장과 같은 판정(requireStaffSessionAccess) — 그 기록 날짜의 대타 지정까지 함께 본다(f4).
  else await requireStaffSessionAccess(sessionId);
  let photos: string[] = [];
  try {
    const parsed = JSON.parse(row.photosJSON || "[]");
    photos = Array.isArray(parsed)
      ? parsed.map((item) => (typeof item === "string" ? item : item?.url)).filter(Boolean)
      : [];
  } catch {
    photos = [];
  }

  return {
    ...row,
    photos,
    startedAt: toIso(row.startedAt),
    endedAt: toIso(row.endedAt),
  };
}

export async function getStaffSessionStudents(
  sessionId: string,
  classId: string,
): Promise<StaffSessionStudent[]> {
  const sessionKinds = await prisma.$queryRawUnsafe<Array<{ sessionDateId: string | null; date: string | null; classId: string | null }>>(
    `SELECT "specialProgramSessionDateId" AS "sessionDateId", to_char(date,'YYYY-MM-DD') AS date, "classId" FROM "Session" WHERE id = $1 LIMIT 1`,
    sessionId,
  );
  let sessionDateId = sessionKinds[0]?.sessionDateId ?? null;
  // 폴백: 세션에 특강 회차(sessionDateId)가 안 붙어 있어도, 이 반이 '그날 방학특강 회차가 있는 연결반'이면
  // 그 회차를 앵커로 삼아 방학특강(좌석 기준) 명단을 쓴다. (같은 반에 정규식 세션이 섞여 있어 김윤만 뜨던 문제 해결)
  if (!sessionDateId && sessionKinds[0]?.date) {
    const anchor = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT sd.id
         FROM "SpecialProgramOffering" o
         JOIN "SpecialProgramSessionDate" sd ON sd."offeringId" = o.id
        WHERE o."linkedClassId" = $1
          AND (sd."startsAt" AT TIME ZONE 'Asia/Seoul')::date = $2::date
        LIMIT 1`,
      sessionKinds[0].classId ?? classId, sessionKinds[0].date,
    );
    if (anchor[0]?.id) sessionDateId = anchor[0].id;
  }
  if (sessionDateId) {
    await requireStaffSeasonalSessionAccess(sessionDateId);
    // ★ 좌석(SpecialProgramEnrollmentDate) 기준 로스터 — 전환 여부와 무관하게 APPROVED 신청항목 전원.
    //   왜 좌석 기준인가: 방학특강 출결의 정본은 좌석의 attendanceStatus다(셔틀 결석제외·보강·관리자 배지가 읽음).
    //   미전환 신청자는 Student가 없어 예전 convertedStudentId 조인으로는 명단이 거의 비었다.
    //   좌석은 승인(APPROVED) 시점에 신청 요일과 겹치는 회차마다 생성되므로, 좌석 존재 자체가
    //   "이 회차 명단"을 뜻한다(요일 필터를 SQL에서 다시 걸 필요 없음).
    //   형제 반/court 는 sibling sessionDate 조인으로 합산되고, 각 좌석이 별개 행(=별개 출결 대상)이다.
    const rows = await prisma.$queryRawUnsafe<
      Array<{
        enrollmentDateId: string;
        studentId: string | null;
        name: string;
        grade: string | null;
        phone: string | null;
        status: StaffSessionStudent["status"];
        attendanceNote: string | null;
        arrivedAt: Date | string | null;
      }>
    >(
      `SELECT e.id AS "enrollmentDateId",
              app."convertedStudentId" AS "studentId",
              COALESCE(st.name, app."childName") AS name,
              app."childGrade" AS grade,
              COALESCE(app."childPhone", app."parentPhone") AS phone,
              e."attendanceStatus" AS status,
              e."attendanceNote" AS "attendanceNote",
              e."arrivedAt" AS "arrivedAt"
       FROM "SpecialProgramSessionDate" anchor_sd
       JOIN "SpecialProgramOffering" anchor_o ON anchor_o.id = anchor_sd."offeringId"
       JOIN "SpecialProgramSessionDate" sd
         ON sd."startsAt" = anchor_sd."startsAt" AND sd."endsAt" = anchor_sd."endsAt"
       JOIN "SpecialProgramOffering" o
         ON o.id = sd."offeringId"
        AND (
          o.id = anchor_o.id
          OR (
            anchor_o."linkedClassId" IS NOT NULL
            AND o."linkedClassId" = anchor_o."linkedClassId"
            AND o."seasonId" = anchor_o."seasonId"
          )
        )
       JOIN "SpecialProgramApplicationItem" i ON i."offeringId" = o.id AND i.status = 'APPROVED'
       JOIN "SpecialProgramApplication" app ON app.id = i."applicationId"
       -- 좌석: 이 신청항목의 이 회차 좌석. SCHEDULED 만(취소=CANCELLED·보강이동=MOVED 제외).
       JOIN "SpecialProgramEnrollmentDate" e
         ON e."applicationItemId" = i.id AND e."sessionDateId" = sd.id AND e.status = 'SCHEDULED'
       -- 전환된 학생 이름 우선(병합 학생은 제외되어 childName 폴백)
       LEFT JOIN "Student" st ON st.id = app."convertedStudentId" AND ${notMergedStudent("st")}
       WHERE anchor_sd.id = $1
       ORDER BY COALESCE(st.name, app."childName")`,
      sessionDateId,
    );
    return rows.map((row) => ({
      id: row.enrollmentDateId,
      attendanceKey: row.enrollmentDateId,
      studentId: row.studentId ?? null,
      name: row.name,
      grade: row.grade ?? null,
      phone: row.phone ?? null,
      status: row.status,
      attendanceNote: row.attendanceNote,
      arrivedAt: toIso(row.arrivedAt),
      // 방학특강은 좌석(SpecialProgramAbsence) 기준의 별도 결석 흐름을 쓴다.
      absenceReport: null,
      makeup: false,
      trial: false,
    }));
  }

  // f4: 그 수업 기록 날짜에 대타 지정이 있으면 명단도 연다(출석 저장과 같은 날짜 기준).
  await requireStaffClassAccess(classId, undefined, { substituteDate: sessionKinds[0]?.date ?? undefined });
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      name: string;
      status: StaffSessionStudent["status"];
      attendanceNote: string | null;
      arrivedAt: Date | string | null;
      absenceReason: string | null;
      absenceStatus: string | null;
      absenceNote: string | null;
      absenceReportedBy: string | null;
    }>
  >(
    // 사전 결석 신고를 함께 읽는다. 이게 없으면 선생님이 신고 사실을 모른 채
    // 출석을 찍고, 학부모가 미리 알린 의미가 사라진다.
    `SELECT st.id, st.name, a.status, a.note AS "attendanceNote", a."arrivedAt",
            ra.reason AS "absenceReason", ra.status AS "absenceStatus",
            ra.note AS "absenceNote", ra."reportedByUserId" AS "absenceReportedBy"
     FROM "Enrollment" e
     JOIN "Student" st ON st.id = e."studentId" AND ${notMergedStudent("st")}
     LEFT JOIN "Attendance" a ON a."sessionId" = $1 AND a."studentId" = st.id
     LEFT JOIN "RegularAbsence" ra
            ON ra."studentId" = st.id AND ra."classId" = $2 AND ra.date = $3::date
           AND ra.status IN ('REPORTED','CONFIRMED')
     WHERE e."classId" = $2 AND e.status = 'ACTIVE'
       AND (e."startsOn" IS NULL OR e."startsOn" <= $3::timestamp::date OR (
         a.id IS NOT NULL AND EXISTS (SELECT 1 FROM "Session" prior WHERE prior.id=$1 AND prior."classId"=$2 AND prior.date::date=$3::timestamp::date)
       ))
     ORDER BY st.name`,
    sessionId,
    classId,
    sessionKinds[0]?.date ?? null,
  );
  // 정규는 studentId 가 곧 로스터 키다(기존과 동일). attendanceKey=studentId.
  const regular: StaffSessionStudent[] = rows.map((row) => ({
    id: row.id,
    attendanceKey: row.id,
    studentId: row.id,
    name: row.name,
    grade: null,
    phone: null,
    status: row.status,
    attendanceNote: row.attendanceNote,
    arrivedAt: toIso(row.arrivedAt),
    absenceReport: row.absenceReason
      ? absenceReportOf({ reason: row.absenceReason, status: row.absenceStatus ?? "REPORTED", note: row.absenceNote, reportedByUserId: row.absenceReportedBy })
      : null,
    makeup: false,
    trial: false,
  }));

  // 보강 온 아이 — 이 반·이 날(KST)에 보강 예약(예약됨·참석)된 다른 반 학생을 명단 뒤에 «보강»으로 붙인다.
  // 조건은 출결 저장(saveStaffAttendance)과 같은 makeupOnClassDateSql 을 쓴다(한쪽만 바뀌면 «보이는데 저장 거부»가 된다).
  const sessionYmd = sessionKinds[0]?.date ?? null;
  if (!sessionYmd) return regular;
  const makeupRows = await prisma.$queryRawUnsafe<
    Array<{ id: string; name: string; status: StaffSessionStudent["status"]; attendanceNote: string | null; arrivedAt: Date | string | null }>
  >(
    `SELECT DISTINCT ON (st.id) st.id, st.name, a.status, a.note AS "attendanceNote", a."arrivedAt"
       FROM "MakeupSession" ms
       JOIN "Student" st ON st.id = ms."studentId" AND ${notMergedStudent("st")}
       LEFT JOIN "Attendance" a ON a."sessionId" = $1 AND a."studentId" = st.id
      WHERE ${makeupOnClassDateSql("ms", "$2", "$3")}
      ORDER BY st.id`,
    sessionId,
    classId,
    sessionYmd,
  );
  const regularIds = new Set(regular.map((row) => row.id));
  const makeup: StaffSessionStudent[] = makeupRows
    .filter((row) => !regularIds.has(row.id)) // 자기 반 보강(이미 정규 명단에 있음)은 두 번 띄우지 않는다
    .sort((a, b) => a.name.localeCompare(b.name, "ko"))
    .map((row) => ({
      id: row.id,
      attendanceKey: row.id,
      studentId: row.id,
      name: row.name,
      grade: null,
      phone: null,
      status: row.status,
      attendanceNote: row.attendanceNote,
      arrivedAt: toIso(row.arrivedAt),
      absenceReport: null,
      makeup: true,
      trial: false,
    }));

  // 체험수업 아이(f1) — 이 반·이 날(KST)로 체험 일정이 잡힌 신청을 명단 맨 뒤에 «체험»으로 붙인다.
  // 이미 원생으로 전환돼 정규·보강 명단에 있는 아이는 두 번 띄우지 않는다.
  const shownIds = new Set([...regularIds, ...makeup.map((row) => row.id)]);
  const trial = (await getTrialRosterRows(classId, sessionYmd))
    .filter((row) => !row.convertedStudentId || !shownIds.has(row.convertedStudentId))
    .map((row): StaffSessionStudent => ({
      id: trialRosterKey(row.id),
      attendanceKey: trialRosterKey(row.id),
      // 체험 아이는 원생이 아니다 — 사진 태깅·보강권·청구 대상에서 빠지도록 studentId 는 비운다.
      studentId: null,
      name: row.childName,
      grade: row.childGrade ?? null,
      // 학부모 연락처는 선생님 출석부에 내려보내지 않는다.
      phone: null,
      status: row.staffAttendanceStatus,
      attendanceNote: null,
      arrivedAt: null,
      absenceReport: null,
      makeup: false,
      trial: true,
    }));
  return [...regular, ...makeup, ...trial];
}

/**
 * «이 반·이 날 체험 아이» 조건 — 명단 조회와 출결 저장(saveStaffAttendance)이 같은 조건을 쓴다
 * (한쪽만 바뀌면 «보이는데 저장 거부»가 된다).
 * scheduledDate 는 timestamptz 라 KST 변환을 한 번만 건다.
 */
export function trialOnClassDateSql(alias: string, classParam: string, dateParam: string) {
  return `${alias}."scheduledClassId" = ${classParam}
     AND ${alias}."scheduledDate" IS NOT NULL
     AND (${alias}."scheduledDate" AT TIME ZONE 'Asia/Seoul')::date = ${dateParam}::date
     AND ${alias}.status IN (${TRIAL_ROSTER_STATUSES.map((status) => `'${status}'`).join(", ")})`;
}

type TrialRosterRow = {
  id: string;
  childName: string;
  childGrade: string | null;
  convertedStudentId: string | null;
  staffAttendanceStatus: StaffSessionStudent["status"];
};

/**
 * 체험 아이 명단. 조회가 실패해도(예: 체험 출결 칸 마이그레이션 전) 정규 출석부는 열려야 하므로 빈 목록으로 넘긴다.
 * 선생님에게 필요한 값(이름·학년·출결)만 고른다 — 연락처·메모·체험비는 SELECT 하지 않는다.
 */
async function getTrialRosterRows(classId: string, sessionYmd: string): Promise<TrialRosterRow[]> {
  try {
    return await prisma.$queryRawUnsafe<TrialRosterRow[]>(
      `SELECT tl.id, tl."childName", tl."childGrade", tl."convertedStudentId", tl."staffAttendanceStatus"
         FROM "TrialLead" tl
        WHERE ${trialOnClassDateSql("tl", "$1", "$2")}
        ORDER BY tl."childName"`,
      classId,
      sessionYmd,
    );
  } catch (error) {
    console.error("[getStaffSessionStudents] 체험 아이 명단 조회 실패(정규 명단은 그대로)", error);
    return [];
  }
}
