import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  makeupGradeFit, matchClassesByGrade, remainingSeatsByDate, summarize,
  type ClassCandidate, type MakeupCreditStatus, type MakeupEmptyReason,
} from "./credit-rules";
// 학생 학년 = 생년월일로 계산(아이 정보 화면과 같은 기준) → 안 되면 학년 글자
import { studentMakeupGrade } from "./student-grade";
import { activeMakeupSql } from "./capacity";
// 달력 값(오늘·요일·날짜 더하기·KST 자정)은 공용 모듈에서만 만든다 — 서버는 UTC 로 돈다
import { addDaysKst, isKstYmd, kstAt, kstDow, kstLabel, todayKst, toKstYmd } from "@/lib/datetime/kst";
import { assertMakeupSessionAllowed, assertRegularMakeupAllowed, CompensationConflict, lockCompensation } from "@/lib/billing/absence-compensation-guard";
// 학부모 응답의 남은 자리는 숫자 대신 3단계(재원생 수 비공개 · 2026-11-13 f9)
import { seatLevel, type SeatLevel } from "@/lib/seats/seatLevel";

// 학부모용 보강 — 보강권 조회 · 반 추천 · 예약 · 취소.
//
// ★ IDOR 방어(이 파일의 가장 중요한 규칙)
//   모든 쿼리는 "Student"."parentId" = 로그인 부모(appUserId) 를 조인 조건에 넣는다.
//   클라이언트가 보낸 creditId/studentId 를 그대로 믿지 않는다. 남의 자녀 보강권을
//   예약·취소하려 해도 조인에서 걸러져 0행이 되고 실패한다.
//
// 근거 — 2026-08-09 개정 이용약관 「수업의 보강」
//   · 학년이 맞는 다른 수업 / 정원 +2 까지
//     (2026-11-14 원장 결정: «학년이 맞는» = 반의 대상 학년 범위 ±1학년. 날짜별로 자리를 센다)
//     (2026-11-14 추가 결정: 학생 학년은 생년월일로 계산 · 학년이 포함되는 반 먼저 · 미취학은 위로 2개 학년 ·
//      성인은 성인반끼리 · 휴원 중에도 예약 가능 — 이 파일은 학생·수강 상태로 막지 않는다)
//   · 보강 예약은 보호자가 직접
//   · 미리 취소하면 보강권 유지, 무단 불참은 사용 처리

// 2026-11-14: 이 파일에 따로 있던 KST 날짜 헬퍼(kstYmd·dayLabel)를 공용 모듈(toKstYmd·kstLabel)로 옮겼다.
// 결과 글자는 같다("2026-08-12" / "8/12(수)").

/** Class.dayOfWeek("Mon"…) → kstDow 요일 번호(0=일 … 6=토) */
const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export type ParentCredit = {
  id: string;
  studentId: string;
  studentName: string;
  studentGrade: string | null;
  sourceLabel: string;      // "정규" | "방학특강"
  absenceLabel: string;     // "8/3(월)"
  expiresLabel: string;     // "10/3(금)"
  expiresYmd: string;
  status: string;
  /** 예약된 경우 그 내용 */
  booking: { sessionId: string; className: string; dateLabel: string } | null;
};

export type ParentMakeupOverview = {
  counts: { available: number; reserved: number; used: number; expired: number };
  credits: ParentCredit[];
};

/** 내 자녀들의 보강권 전체. 만료는 지금 시점으로 판정해 보여 준다. */
export async function getMakeupOverviewForParent(parentUserId: string): Promise<ParentMakeupOverview> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string; studentId: string; studentName: string; studentGrade: string | null;
    sourceType: string; absenceDate: Date; expiresAt: Date; status: MakeupCreditStatus;
    makeupSessionId: string | null; bookedDate: Date | null; bookedClassName: string | null;
  }>>(
    `SELECT mc.id, mc."studentId", s.name AS "studentName", s.grade AS "studentGrade",
            mc."sourceType", mc."absenceDate", mc."expiresAt", mc.status,
            mc."makeupSessionId",
            ms."makeupDate" AS "bookedDate", bc.name AS "bookedClassName"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id = mc."studentId"
       LEFT JOIN "MakeupSession" ms ON ms.id = mc."makeupSessionId"
       LEFT JOIN "Class" bc ON bc.id = ms."makeupClassId"
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      ORDER BY mc."expiresAt" ASC`,
    parentUserId,
  );

  const now = new Date();
  const credits: ParentCredit[] = rows.map((r) => ({
    id: r.id,
    studentId: r.studentId,
    studentName: r.studentName,
    studentGrade: r.studentGrade ?? null,
    sourceLabel: r.sourceType === "SEASONAL" ? "방학특강" : "정규",
    absenceLabel: kstLabel(r.absenceDate),
    expiresLabel: kstLabel(r.expiresAt),
    expiresYmd: toKstYmd(r.expiresAt),
    status: r.status,
    booking: r.makeupSessionId && r.bookedDate
      ? { sessionId: r.makeupSessionId, className: r.bookedClassName ?? "", dateLabel: kstLabel(r.bookedDate) }
      : null,
  }));

  const counts = summarize(
    rows.map((r) => ({ expiresAt: new Date(r.expiresAt), status: r.status })),
    now,
  );
  return { counts, credits };
}

export type MakeupOption = {
  classId: string;
  className: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  grades: string[];
  /** 대상 학년을 한 줄로("초4~중1") — 학년 구성이 비어 있는 반은 대상 학년 글자를 그대로 */
  gradeLabel: string;
  /** 남은 자리 3단계(고를 수 있는 날짜 중 가장 여유 있는 날 기준) — 숫자는 학부모 응답에 싣지 않는다(예약 시 서버가 숫자로 다시 검사 · f9) */
  seatLevel: SeatLevel;
  /** 만료 전에 실제로 갈 수 있고 자리가 남은 날짜들(마감된 날짜는 빠진다). 날짜마다 그날의 자리 단계 */
  dates: { ymd: string; label: string; seatLevel: SeatLevel }[];
};

/** 대상 학년 한 줄 표시: 학년 구성 목록의 처음~끝, 없으면 대상 학년 글자 */
function gradeLabelOf(grades: string[], gradeRangeText: string | null): string {
  if (grades.length > 1) return `${grades[0]}~${grades[grades.length - 1]}`;
  if (grades.length === 1) return grades[0];
  return gradeRangeText ?? "";
}

/**
 * 이 보강권으로 갈 수 있는 반 목록.
 *
 * 후보 조건(2026-11-14 결석 당일 취소·보강 연결):
 *   ① 학생 학년(생년월일 계산 → 안 되면 학년 글자)이 반의 대상 학년에 포함되거나 ±1학년 안
 *      (미취학은 위로 2개 학년, 성인은 성인반만 — credit-rules.makeupGradeFit). 학년을 끝내 모르면 0건(NO_GRADE)
 *   ② 반의 학년 정보 = 시간표 학년 구성(ScheduleSlot.gradesJSON) → 비어 있으면 대상 학년 글자
 *      (ScheduleSlot.gradeRange → 직접 만든 슬롯 CustomClassSlot.gradeRange). 끝내 없으면 그 반은 뺀다.
 *      프로그램 대상연령("초등저~고 (일부 중학생 가능)")은 자유 문장이라 절대 파싱하지 않는다.
 *   ③ 결석한 원래 반, 그 학생이 이미 다니는 반은 뺀다
 *   ④ 내일부터 사용 기한까지 그 요일 날짜 중, «그 날짜에» 자리가 남은 날만(정원 +2 − 수강 인원 − 그날 보강 예약)
 *
 * 0건이면 emptyReason 으로 이유를 알려 준다(화면이 나눠 보인다).
 */
export async function getMakeupOptionsForCredit(
  parentUserId: string,
  creditId: string,
): Promise<{ ok: true; options: MakeupOption[]; expiresYmd: string; emptyReason: MakeupEmptyReason | null } | { ok: false; message: string }> {
  // ★ 부모 소유 확인이 여기서 끝난다. 이후 쿼리는 이 결과만 신뢰한다.
  const own = await prisma.$queryRawUnsafe<Array<{
    id: string; studentId: string; studentGrade: string | null; birthYmd: string | null; originClassId: string | null;
    status: MakeupCreditStatus; expiresAt: Date;
  }>>(
    // birthDate 는 시간대 없는 timestamp(UTC 로 저장) — KST 달력 날짜로 읽으려면 변환을 «두 번» 건다
    // (아이 기록 조회 childRecordQuery 의 birthYmd 와 같은 식)
    `SELECT mc.id, mc."studentId", s.grade AS "studentGrade",
            to_char(((s."birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM-DD') AS "birthYmd",
            mc."originClassId", mc.status, mc."expiresAt"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id = mc."studentId"
      WHERE mc.id = $1 AND ${await childAccessSql("s", "$2")}
      LIMIT 1`,
    creditId, parentUserId,
  );
  const credit = own[0];
  if (!credit) return { ok: false, message: "보강권을 찾을 수 없습니다." };
  if (credit.status !== "AVAILABLE") return { ok: false, message: "이미 예약했거나 사용할 수 없는 보강권입니다." };
  if (new Date(credit.expiresAt).getTime() < Date.now()) {
    return { ok: false, message: "사용 기간이 지난 보강권입니다." };
  }

  const expiresAt = new Date(credit.expiresAt);
  const expiresYmd = toKstYmd(expiresAt);
  const empty = (emptyReason: MakeupEmptyReason) => ({ ok: true as const, options: [] as MakeupOption[], expiresYmd, emptyReason });

  // ① 학생 학년 — 생년월일로 계산(3월 학년도), 임시 생일·빈 값이면 학년 글자. 끝내 모르면 임의 배정하지 않는다
  const today = todayKst();
  const studentGrade = studentMakeupGrade(credit.birthYmd ?? null, credit.studentGrade, today);
  if (studentGrade == null) return empty("NO_GRADE");

  // 반 + 대상 학년(시간표 학년 구성 → 대상 학년 글자 → 직접 만든 슬롯) + 현재 인원.
  // LEFT JOIN: 시간표 슬롯과 이어지지 않은 반(직접 만든 슬롯 custom-…)도 학년 글자가 있으면 후보가 된다.
  // 방학특강용 반(dayOfWeek='Seasonal')과 지운 프로그램의 반은 정규 보강 대상이 아니다.
  const rows = await prisma.$queryRawUnsafe<Array<{
    classId: string; className: string; dayOfWeek: string; startTime: string; endTime: string;
    capacity: number; gradesJson: string | null; gradeRangeText: string | null; enrolled: number;
  }>>(
    `SELECT c.id AS "classId", c.name AS "className", c."dayOfWeek", c."startTime", c."endTime",
            c.capacity, ss."gradesJSON" AS "gradesJson",
            COALESCE(
              NULLIF(btrim(ss."gradeRange"), ''),
              (SELECT NULLIF(btrim(cs."gradeRange"), '') FROM "CustomClassSlot" cs
                WHERE (cs.id = c."slotKey" OR ('custom-' || cs.id) = c."slotKey") AND cs."isHidden" = false LIMIT 1)
            ) AS "gradeRangeText",
            (SELECT COUNT(*) FROM "Enrollment" e
              WHERE e."classId" = c.id AND e.status = 'ACTIVE')::int AS enrolled
       FROM "Class" c
       JOIN "Program" p ON p.id = c."programId"
       LEFT JOIN "ScheduleSlot" ss ON ss."slotKey" = c."slotKey"
      WHERE c."dayOfWeek" <> 'Seasonal' AND p."deletedAt" IS NULL`,
  );

  // ③ 그 학생이 수강 중인 반(같은 반에서 보강을 받는 것은 보강이 아니다)
  //   원장 지시(2026-11-14): «자기가 수강 중인 반은 보강 대상이 아니야» — 휴원 중(PAUSED)인 자기 반도 뺀다.
  //   퇴원한 반(WITHDRAWN)은 더 이상 자기 반이 아니므로 후보에 남는다.
  const enrolledRows = await prisma.$queryRawUnsafe<Array<{ classId: string }>>(
    `SELECT e."classId" AS "classId" FROM "Enrollment" e WHERE e."studentId" = $1 AND e.status IN ('ACTIVE', 'PAUSED')`,
    credit.studentId,
  );

  const candidates: ClassCandidate[] = rows.map((r) => {
    let grades: string[] = [];
    try { const p = JSON.parse(r.gradesJson ?? "[]"); if (Array.isArray(p)) grades = p.map(String); } catch { /* 형식 오류는 빈 배열 */ }
    return {
      classId: r.classId, className: r.className, dayOfWeek: r.dayOfWeek,
      startTime: r.startTime, grades, gradeRangeText: r.gradeRangeText ?? null, capacity: r.capacity,
      enrolled: r.enrolled, booked: 0, // 보강 예약 수는 아래에서 날짜별로 센다
    };
  });

  const matched = matchClassesByGrade(candidates, studentGrade, {
    excludeClassId: credit.originClassId,
    excludeClassIds: enrolledRows.map((r) => r.classId),
  });
  if (matched.length === 0) return empty("NO_MATCH");

  // ④-1 만료 전에 열리는 날짜(내일부터)
  const withDates = matched
    .map((c) => ({ c, dateYmds: upcomingDateYmds(c.dayOfWeek, today, expiresAt) }))
    .filter((item) => item.dateYmds.length > 0);
  if (withDates.length === 0) return empty("NO_DATE");

  // ④-2 이미 잡힌 보강 — 반·날짜별로 센다(취소된 것만 빼고 — 관리자 쪽 정원 검사와 같은 기준 activeMakeupSql).
  //   makeupDate 는 timestamptz 라 KST 변환을 «한 번»만 건다. 학부모 예약은 KST 자정, 관리자 예약은 UTC 자정으로
  //   저장돼 있어도 둘 다 같은 KST 달력 날짜로 묶인다.
  const bookedRows = await prisma.$queryRawUnsafe<Array<{ classId: string; ymd: string; booked: number }>>(
    `SELECT m."makeupClassId" AS "classId",
            to_char(m."makeupDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS ymd,
            COUNT(*)::int AS booked
       FROM "MakeupSession" m
      WHERE ${activeMakeupSql("m")} AND m."makeupDate" >= $1::timestamptz
      GROUP BY 1, 2`,
    new Date(kstAt(today)).toISOString(),
  );
  const bookedByClass = new Map<string, Map<string, number>>();
  for (const r of bookedRows) {
    if (!bookedByClass.has(r.classId)) bookedByClass.set(r.classId, new Map());
    bookedByClass.get(r.classId)!.set(r.ymd, Number(r.booked));
  }

  const endTimeByClass = new Map(rows.map((r) => [r.classId, r.endTime as string]));
  const built = withDates.map(({ c, dateYmds }) => {
    // 날짜마다 남은 자리를 세고, 마감된 날짜만 뺀다(다른 주의 예약 때문에 빈 날까지 막히지 않게)
    const open = remainingSeatsByDate(c, dateYmds, bookedByClass.get(c.classId) ?? new Map()).filter((d) => d.remaining > 0);
    const best = open.reduce((max, d) => Math.max(max, d.remaining), 0);
    const option: MakeupOption = {
      classId: c.classId,
      className: c.className,
      dayOfWeek: c.dayOfWeek,
      startTime: c.startTime,
      endTime: endTimeByClass.get(c.classId) ?? "",
      grades: c.grades,
      gradeLabel: gradeLabelOf(c.grades, c.gradeRangeText ?? null),
      seatLevel: seatLevel(best),
      dates: open.map((d) => ({ ymd: d.ymd, label: kstLabel(d.ymd), seatLevel: seatLevel(d.remaining) })),
    };
    // fit: 0 = 학생 학년이 대상에 포함되는 반 · 1 = 가까운 학년 반
    return { option, best, fit: makeupGradeFit(studentGrade, c) ?? 1 };
  }).filter((item) => item.option.dates.length > 0);
  if (built.length === 0) return empty("FULL");

  // 정렬: 학년이 포함되는 반 먼저 → 자리 여유가 많은 순 → 요일·시각 순. 여유 있는 반을 먼저 권해 쏠림을 막는다.
  built.sort((a, b) =>
    a.fit - b.fit ||
    b.best - a.best ||
    a.option.dayOfWeek.localeCompare(b.option.dayOfWeek) ||
    a.option.startTime.localeCompare(b.option.startTime));

  return { ok: true, options: built.map((item) => item.option), expiresYmd, emptyReason: null };
}

/**
 * 내일부터 만료 시각까지, 그 요일에 해당하는 KST 날짜들(최대 8개). 오늘은 제외 — 내일부터 예약 가능.
 * 2026-11-14: `T00:00:00+09:00` 을 손으로 조립하던 것을 공용 모듈(addDaysKst·kstAt·kstDow)로 옮겼다(결과 동일).
 */
function upcomingDateYmds(dayOfWeek: string, todayYmd: string, expiresAt: Date): string[] {
  const dow = DOW_INDEX[dayOfWeek];
  if (dow === undefined) return [];
  const out: string[] = [];
  for (let i = 1; i <= 70 && out.length < 8; i++) {
    const ymd = addDaysKst(todayYmd, i);
    // 그 날 KST 자정이 만료 시각을 넘으면 끝(만료일 당일 자정까지는 예약 가능 — 기존과 같은 경계)
    if (kstAt(ymd) > expiresAt.getTime()) break;
    if (kstDow(ymd) === dow) out.push(ymd);
  }
  return out;
}

/**
 * 보강 예약. 보강권을 RESERVED 로 잠그고 MakeupSession 을 만든다.
 *
 * 동시 예약 방지: 보강권 상태를 AVAILABLE → RESERVED 로 **조건부 UPDATE** 해서 선점한다.
 * 두 번 눌러도 두 번째는 0행이 되어 실패한다.
 */
export async function bookMakeup(
  parentUserId: string,
  input: { creditId: string; classId: string; dateYmd: string },
): Promise<{ ok: boolean; message: string }> {
  // 형식뿐 아니라 실제로 있는 날짜인지까지(2026-02-30 같은 값은 거절)
  if (!isKstYmd(input.dateYmd)) return { ok: false, message: "날짜가 올바르지 않습니다." };

  const own = await prisma.$queryRawUnsafe<Array<{
    id: string; studentId: string; originClassId: string | null; absenceDate: Date; expiresAt: Date;
  }>>(
    // 학년은 여기서 읽지 않는다 — 학년·정원 판정은 아래 getMakeupOptionsForCredit 한 곳에서만 한다
    `SELECT mc.id, mc."studentId", mc."originClassId", mc."absenceDate", mc."expiresAt"
       FROM "MakeupCredit" mc JOIN "Student" s ON s.id = mc."studentId"
      WHERE mc.id = $1 AND ${await childAccessSql("s", "$2")} AND mc.status = 'AVAILABLE' LIMIT 1`,
    input.creditId, parentUserId,
  );
  const credit = own[0];
  if (!credit) return { ok: false, message: "예약할 수 있는 보강권이 아닙니다." };

  // 보강 날짜 = 그 날 KST 자정(공용 모듈 kstAt — 예전 손 조립과 같은 시각)
  const bookAt = new Date(kstAt(input.dateYmd));
  if (bookAt.getTime() > new Date(credit.expiresAt).getTime()) {
    return { ok: false, message: "보강권 사용 기간이 지난 날짜입니다." };
  }

  // 반 검증 — 학년·정원을 서버에서 다시 확인한다(클라이언트 값 신뢰 금지).
  const opts = await getMakeupOptionsForCredit(parentUserId, input.creditId);
  if (!opts.ok) return { ok: false, message: opts.message };
  const target = opts.options.find((o) => o.classId === input.classId);
  if (!target) return { ok: false, message: "이 학생이 갈 수 있는 수업이 아닙니다." };
  if (!target.dates.some((d) => d.ymd === input.dateYmd)) {
    // 목록에는 «자리가 남은 날짜»만 있다 — 열리지 않는 날이거나 그 사이 마감된 날
    return { ok: false, message: "그 수업이 열리지 않거나 이미 마감된 날짜입니다." };
  }

  try {
    await prisma.$transaction(async tx => {
      await lockCompensation(tx);
      if (credit.originClassId) await assertRegularMakeupAllowed(tx, {
        studentId: credit.studentId, classId: credit.originClassId, dateYmd: toKstYmd(credit.absenceDate),
      });
      // 이월 전환과 같은 잠금을 잡고 예약·권 연결을 함께 저장한다.
      // 정원 재확인(2026-11-14) — 위의 후보 조회는 트랜잭션 밖이라, 두 학부모가 마지막 한 자리를 동시에 누르면
      // 둘 다 통과할 수 있었다. 여기는 lockCompensation(작업대 잠금) 뒤라 예약이 한 줄로 서므로,
      // 이 안에서 «그 반·그 날짜» 인원을 다시 세면 초과 예약이 생기지 않는다. 기준은 그대로 정원 +2.
      const seat = await tx.$queryRawUnsafe<Array<{ capacity: number; enrolled: number; booked: number }>>(
        `SELECT c.capacity,
                (SELECT COUNT(*) FROM "Enrollment" e
                  WHERE e."classId" = c.id AND e.status = 'ACTIVE')::int AS enrolled,
                (SELECT COUNT(*) FROM "MakeupSession" m
                  WHERE m."makeupClassId" = c.id AND ${activeMakeupSql("m")}
                    AND to_char(m."makeupDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = $2)::int AS booked
           FROM "Class" c WHERE c.id = $1 LIMIT 1`,
        input.classId, input.dateYmd,
      );
      const left = seat[0]
        ? remainingSeatsByDate(seat[0], [input.dateYmd], { [input.dateYmd]: Number(seat[0].booked) })[0].remaining
        : 0;
      if (left <= 0) throw new Error("MAKEUP_CLASS_FULL");
      const locked = await tx.$executeRawUnsafe(
        `UPDATE "MakeupCredit" SET status='RESERVED', "updatedAt"=now()
          WHERE id=$1 AND status='AVAILABLE'
            AND EXISTS (SELECT 1 FROM "Student" s WHERE s.id="MakeupCredit"."studentId" AND ${await childAccessSql("s", "$2")} AND s."mergedIntoStudentId" IS NULL)`, input.creditId, parentUserId,
      );
      if (Number(locked) === 0) throw new Error("MAKEUP_ALREADY_RESERVED");
      const created = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO "MakeupSession"
         (id,"studentId","originalClassId","originalDate","makeupClassId","makeupDate",status,"createdAt","updatedAt")
       VALUES (gen_random_uuid()::text,$1,$2,$3::timestamptz,$4,$5::timestamptz,'BOOKED',now(),now())
       RETURNING id`,
      credit.studentId, credit.originClassId ?? input.classId,
      new Date(credit.absenceDate).toISOString(), input.classId, bookAt.toISOString(),
    );
      await tx.$executeRawUnsafe(
      `UPDATE "MakeupCredit" SET "makeupSessionId"=$2, "updatedAt"=now() WHERE id=$1`,
      input.creditId, created[0].id,
      );
    });
    return { ok: true, message: `${target.className} ${kstLabel(input.dateYmd)} 보강이 예약되었습니다.` };
  } catch (error) {
    // 실패한 거래는 되돌린다. 별도 복구 UPDATE로 회수된 권을 되살리지 않는다.
    if (error instanceof CompensationConflict) return { ok: false, message: error.message };
    if (error instanceof Error && error.message === "MAKEUP_ALREADY_RESERVED") return { ok: false, message: "이미 예약 처리된 보강권입니다." };
    if (error instanceof Error && error.message === "MAKEUP_CLASS_FULL") return { ok: false, message: "방금 그 날짜가 마감됐습니다. 다른 날짜나 수업을 골라 주세요." };
    console.error("[bookMakeup] 예약 생성 실패 — 거래 취소", error);
    return { ok: false, message: "예약에 실패했습니다. 잠시 후 다시 시도해 주세요." };
  }
}

/**
 * 예약 취소 — 보강권이 그대로 돌아온다(약관 명시).
 * 이미 지난 보강은 취소할 수 없다(무단 불참 처리를 우회하는 길이 되면 안 된다).
 */
export async function cancelMakeupBooking(
  parentUserId: string,
  creditId: string,
): Promise<{ ok: boolean; message: string }> {
  const own = await prisma.$queryRawUnsafe<Array<{
    id: string; makeupSessionId: string | null; makeupDate: Date | null;
  }>>(
    `SELECT mc.id, mc."makeupSessionId", ms."makeupDate"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id = mc."studentId"
       LEFT JOIN "MakeupSession" ms ON ms.id = mc."makeupSessionId"
      WHERE mc.id = $1 AND ${await childAccessSql("s", "$2")} AND mc.status = 'RESERVED' LIMIT 1`,
    creditId, parentUserId,
  );
  const row = own[0];
  if (!row) return { ok: false, message: "취소할 예약이 없습니다." };

  if (row.makeupDate && new Date(row.makeupDate).getTime() < Date.now()) {
    return { ok: false, message: "이미 지난 보강은 취소할 수 없습니다. 학원으로 문의해 주세요." };
  }

  try {
    await prisma.$transaction(async tx => {
      await lockCompensation(tx);
      if (row.makeupSessionId) await assertMakeupSessionAllowed(tx, row.makeupSessionId);
      const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "MakeupCredit" WHERE id=$1 AND status='RESERVED'
          AND "makeupSessionId" IS NOT DISTINCT FROM $2
          AND EXISTS (SELECT 1 FROM "Student" s WHERE s.id="MakeupCredit"."studentId" AND ${await childAccessSql("s", "$3")} AND s."mergedIntoStudentId" IS NULL)
          FOR UPDATE`, creditId, row.makeupSessionId, parentUserId,
      );
      if (!locked.length) throw new Error("MAKEUP_NOT_RESERVED");
      if (row.makeupSessionId) await tx.$executeRawUnsafe(
      `UPDATE "MakeupSession" SET status='CANCELLED', "updatedAt"=now() WHERE id=$1`,
      row.makeupSessionId,
      );
      await tx.$executeRawUnsafe(
    `UPDATE "MakeupCredit" SET status='AVAILABLE', "makeupSessionId"=NULL, "updatedAt"=now() WHERE id=$1`,
    creditId,
      );
    });
  } catch (error) {
    if (error instanceof CompensationConflict) return { ok: false, message: error.message };
    return { ok: false, message: "예약 상태가 변경됐습니다. 다시 확인해 주세요." };
  }
  return { ok: true, message: "예약을 취소했습니다. 보강권은 그대로 유지됩니다." };
}
