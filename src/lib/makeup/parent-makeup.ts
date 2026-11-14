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
import { addDaysKst, isKstYmd, kstAt, kstDow, kstHm, kstLabel, todayKst, toKstYmd } from "@/lib/datetime/kst";
import { assertMakeupSessionAllowed, assertRegularMakeupAllowed, CompensationConflict, lockCompensation, type CompensationTransaction } from "@/lib/billing/absence-compensation-guard";
// 학부모 응답의 남은 자리는 숫자 대신 3단계(재원생 수 비공개 · 2026-11-13 f9)
import { seatLevel, type SeatLevel } from "@/lib/seats/seatLevel";
// 예약·취소·날짜 바꾸기 마감 = 보강 수업 시작 1시간 전(당일도 그 전이면 된다) — 결석·셔틀과 함께 쓰는 공용 규칙
// (2026-11-15 마감 1시간 전 통일 — 원장 결정. 그 전에는 «전날까지»였다)
import { isMakeupChangeOpen, makeupClosedMessage, PARENT_CHANGE_CUTOFF_TEXT } from "@/lib/parent/changeDeadline";

/** 예약 마감이 지난 날짜를 골랐을 때의 글(예약·날짜 바꾸기 공용) */
const MAKEUP_BOOK_CLOSED_MESSAGE = `보강은 수업 시작 ${PARENT_CHANGE_CUTOFF_TEXT} 전까지 예약할 수 있습니다. 다른 날짜를 골라 주세요.`;

// «지금»을 KST 글자(날짜·시각)로 — 마감 판정에 넣는다(서버는 UTC 로 돈다. 달력 값은 kst.ts 에서만)
function kstNow(): { ymd: string; hm: string } {
  const nowMs = Date.now();
  return { ymd: todayKst(nowMs), hm: kstHm(nowMs) };
}

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
  /**
   * 예약된 경우 그 내용.
   * changeOpen: 지금 예약을 취소하거나 날짜를 바꿀 수 있나(보강 수업 시작 1시간 전까지 — 그 뒤·지난 날은 false).
   *   서버도 같은 함수로 다시 막는다 — 이 값은 화면 표시용일 뿐이다.
   */
  booking: { sessionId: string; classId: string; className: string; dateYmd: string; dateLabel: string; changeOpen: boolean } | null;
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
    bookedClassId: string | null; bookedYmd: string | null; bookedStartTime?: string | null;
  }>>(
    // bookedYmd: 보강 날짜의 KST 달력 날짜(timestamptz 라 변환은 «한 번») — 관리자가 UTC 자정으로 잡은 보강도 같은 날짜가 된다
    `SELECT mc.id, mc."studentId", s.name AS "studentName", s.grade AS "studentGrade",
            mc."sourceType", mc."absenceDate", mc."expiresAt", mc.status,
            mc."makeupSessionId",
            ms."makeupDate" AS "bookedDate", bc.name AS "bookedClassName",
            ms."makeupClassId" AS "bookedClassId", bc."startTime" AS "bookedStartTime",
            to_char(ms."makeupDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "bookedYmd"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id = mc."studentId"
       LEFT JOIN "MakeupSession" ms ON ms.id = mc."makeupSessionId"
       LEFT JOIN "Class" bc ON bc.id = ms."makeupClassId"
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
      ORDER BY mc."expiresAt" ASC`,
    parentUserId,
  );

  const now = new Date();
  const kstClock = kstNow();
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
      ? (() => {
          // 날짜 글자는 SQL 이 준 KST 날짜를 쓴다(옛 응답·테스트처럼 없으면 같은 뜻의 공용 변환으로)
          const dateYmd = r.bookedYmd ?? toKstYmd(r.bookedDate);
          return {
            sessionId: r.makeupSessionId, classId: r.bookedClassId ?? "", className: r.bookedClassName ?? "",
            dateYmd, dateLabel: kstLabel(r.bookedDate), changeOpen: isMakeupChangeOpen(dateYmd, r.bookedStartTime ?? null, kstClock.ymd, kstClock.hm),
          };
        })()
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
 *   ④ 오늘부터 사용 기한까지 그 요일 날짜 중, «그 날짜에» 자리가 남은 날만(정원 +2 − 수강 인원 − 그날 보강 예약)
 *      오늘 수업은 시작 1시간 전까지만 후보다(2026-11-15 마감 1시간 전 통일 — 그 전에는 «내일부터»였다)
 *
 * 0건이면 emptyReason 으로 이유를 알려 준다(화면이 나눠 보인다).
 *
 * forReschedule(2026-11-15 날짜 바꾸기): «예약 중(RESERVED)» 보강권의 후보를 준다.
 *   지금 예약한 반·날짜는 후보에서 뺀다(같은 곳으로 «바꾸는» 것은 바꾸기가 아니다). 나머지 조건은 새 예약과 같다.
 */
export async function getMakeupOptionsForCredit(
  parentUserId: string,
  creditId: string,
  opts: { forReschedule?: boolean } = {},
): Promise<{ ok: true; options: MakeupOption[]; expiresYmd: string; emptyReason: MakeupEmptyReason | null } | { ok: false; message: string }> {
  // ★ 부모 소유 확인이 여기서 끝난다. 이후 쿼리는 이 결과만 신뢰한다.
  const own = await prisma.$queryRawUnsafe<Array<{
    id: string; studentId: string; studentGrade: string | null; birthYmd: string | null; originClassId: string | null;
    status: MakeupCreditStatus; expiresAt: Date; bookedClassId?: string | null; bookedYmd?: string | null;
  }>>(
    // birthDate 는 시간대 없는 timestamp(UTC 로 저장) — KST 달력 날짜로 읽으려면 변환을 «두 번» 건다
    // (아이 기록 조회 childRecordQuery 의 birthYmd 와 같은 식)
    // bookedYmd(날짜 바꾸기용 — 지금 예약한 날짜): makeupDate 는 timestamptz 라 변환은 «한 번»
    `SELECT mc.id, mc."studentId", s.grade AS "studentGrade",
            to_char(((s."birthDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul'), 'YYYY-MM-DD') AS "birthYmd",
            mc."originClassId", mc.status, mc."expiresAt",
            ms."makeupClassId" AS "bookedClassId",
            to_char(ms."makeupDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "bookedYmd"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id = mc."studentId"
       LEFT JOIN "MakeupSession" ms ON ms.id = mc."makeupSessionId"
      WHERE mc.id = $1 AND ${await childAccessSql("s", "$2")}
      LIMIT 1`,
    creditId, parentUserId,
  );
  const credit = own[0];
  if (!credit) return { ok: false, message: "보강권을 찾을 수 없습니다." };
  if (opts.forReschedule) {
    // 날짜 바꾸기: 예약 중인 보강권만
    if (credit.status !== "RESERVED") return { ok: false, message: "날짜를 바꿀 수 있는 예약이 없습니다." };
  } else if (credit.status !== "AVAILABLE") return { ok: false, message: "이미 예약했거나 사용할 수 없는 보강권입니다." };
  if (new Date(credit.expiresAt).getTime() < Date.now()) {
    return { ok: false, message: "사용 기간이 지난 보강권입니다." };
  }

  const expiresAt = new Date(credit.expiresAt);
  const expiresYmd = toKstYmd(expiresAt);
  const empty = (emptyReason: MakeupEmptyReason) => ({ ok: true as const, options: [] as MakeupOption[], expiresYmd, emptyReason });

  // ① 학생 학년 — 생년월일로 계산(3월 학년도), 임시 생일·빈 값이면 학년 글자. 끝내 모르면 임의 배정하지 않는다
  //   «지금»(KST 날짜·시각)은 한 번만 읽어 학년 계산과 아래 마감 판정이 같은 시계를 쓴다
  const clock = kstNow();
  const today = clock.ymd;
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

  // ④-1 만료 전에 열리는 날짜(오늘부터 — 오늘 수업은 시작 1시간 전이 지났으면 뺀다. clock·today 는 위 ①에서 만들었다)
  const withDates = matched
    .map((c) => ({
      c,
      dateYmds: upcomingDateYmds(c.dayOfWeek, today, expiresAt)
        .filter((ymd) => isMakeupChangeOpen(ymd, c.startTime, clock.ymd, clock.hm)),
    }))
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
    // 날짜 바꾸기: 지금 예약한 반·날짜는 후보에서 뺀다
    const open = remainingSeatsByDate(c, dateYmds, bookedByClass.get(c.classId) ?? new Map())
      .filter((d) => d.remaining > 0)
      .filter((d) => !(opts.forReschedule && c.classId === credit.bookedClassId && d.ymd === credit.bookedYmd));
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
 * 오늘부터 만료 시각까지, 그 요일에 해당하는 KST 날짜들(최대 8개).
 * 2026-11-15 마감 1시간 전 통일: 오늘도 포함한다(예전에는 내일부터) — 오늘 수업의 마감 여부는 호출부가 반의 시작 시각으로 거른다.
 * 2026-11-14: `T00:00:00+09:00` 을 손으로 조립하던 것을 공용 모듈(addDaysKst·kstAt·kstDow)로 옮겼다(결과 동일).
 */
function upcomingDateYmds(dayOfWeek: string, todayYmd: string, expiresAt: Date): string[] {
  const dow = DOW_INDEX[dayOfWeek];
  if (dow === undefined) return [];
  const out: string[] = [];
  for (let i = 0; i <= 70 && out.length < 8; i++) {
    const ymd = addDaysKst(todayYmd, i);
    // 그 날 KST 자정이 만료 시각을 넘으면 끝(만료일 당일 자정까지는 예약 가능 — 기존과 같은 경계)
    if (kstAt(ymd) > expiresAt.getTime()) break;
    if (kstDow(ymd) === dow) out.push(ymd);
  }
  return out;
}

/**
 * 트랜잭션 안에서(작업대 잠금 뒤) «그 반·그 날짜»에 남은 자리를 다시 센다 — 예약·날짜 바꾸기 공용.
 * 기준은 그대로 정원 +2(remainingSeatsByDate). 반이 없으면 0.
 */
async function seatsLeftInTx(tx: CompensationTransaction, classId: string, dateYmd: string): Promise<number> {
  const seat = await tx.$queryRawUnsafe<Array<{ capacity: number; enrolled: number; booked: number }>>(
    `SELECT c.capacity,
            (SELECT COUNT(*) FROM "Enrollment" e
              WHERE e."classId" = c.id AND e.status = 'ACTIVE')::int AS enrolled,
            (SELECT COUNT(*) FROM "MakeupSession" m
              WHERE m."makeupClassId" = c.id AND ${activeMakeupSql("m")}
                AND to_char(m."makeupDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = $2)::int AS booked
       FROM "Class" c WHERE c.id = $1 LIMIT 1`,
    classId, dateYmd,
  );
  return seat[0]
    ? remainingSeatsByDate(seat[0], [dateYmd], { [dateYmd]: Number(seat[0].booked) })[0].remaining
    : 0;
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

  // 지난 날짜는 후보를 계산하기 전에 바로 거절한다(KST 날짜 글자끼리 비교)
  if (input.dateYmd < todayKst()) return { ok: false, message: MAKEUP_BOOK_CLOSED_MESSAGE };

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
  // 마감(2026-11-15 마감 1시간 전 통일): 그 반 수업 시작 1시간 전까지 — 오늘 수업도 그 전이면 예약된다
  const clock = kstNow();
  if (!isMakeupChangeOpen(input.dateYmd, target.startTime, clock.ymd, clock.hm)) {
    return { ok: false, message: MAKEUP_BOOK_CLOSED_MESSAGE };
  }
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
      const left = await seatsLeftInTx(tx, input.classId, input.dateYmd);
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
 * 보강 수업 시작 1시간 전이 지났거나 이미 지난 보강은 취소할 수 없다(무단 불참 처리를 우회하는 길이 되면 안 된다).
 *
 * 2026-11-15 마감 통일: 예전에는 저장된 «시각»이 지났는지로 판정해, 관리자가 잡은 보강(UTC 자정 = KST 09:00 저장)은
 *   당일 오전 9시까지 취소됐고 학부모가 잡은 보강(KST 자정 저장)은 당일 0시부터 막혔다. 카카오 대화는 당일 전부 거절했다.
 *   이제 «보강 날짜의 KST 달력 날짜 + 보강 가는 반의 시작 시각»으로 본다 — 웹·카카오가 같은 함수(isMakeupChangeOpen)다.
 * 2026-11-15 마감 1시간 전 통일(원장 결정): «전날까지»가 아니라 «수업 시작 1시간 전까지» — 당일도 그 전이면 취소된다.
 */
export async function cancelMakeupBooking(
  parentUserId: string,
  creditId: string,
): Promise<{ ok: boolean; message: string }> {
  const own = await prisma.$queryRawUnsafe<Array<{
    id: string; makeupSessionId: string | null; makeupYmd: string | null; makeupStartTime: string | null;
  }>>(
    // makeupYmd: timestamptz → KST 달력 날짜(변환은 «한 번») · makeupStartTime: 보강 가는 반의 시작 시각
    `SELECT mc.id, mc."makeupSessionId", bc."startTime" AS "makeupStartTime",
            to_char(ms."makeupDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "makeupYmd"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id = mc."studentId"
       LEFT JOIN "MakeupSession" ms ON ms.id = mc."makeupSessionId"
       LEFT JOIN "Class" bc ON bc.id = ms."makeupClassId"
      WHERE mc.id = $1 AND ${await childAccessSql("s", "$2")} AND mc.status = 'RESERVED' LIMIT 1`,
    creditId, parentUserId,
  );
  const row = own[0];
  if (!row) return { ok: false, message: "취소할 예약이 없습니다." };

  // 마감 뒤면 공통 마감 글, 날짜가 지났으면 «이미 지난 보강…» — 사실과 다른 말을 하지 않는다
  const clock = kstNow();
  if (row.makeupYmd && !isMakeupChangeOpen(row.makeupYmd, row.makeupStartTime, clock.ymd, clock.hm)) {
    return { ok: false, message: makeupClosedMessage(row.makeupYmd, clock.ymd) };
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

/**
 * 보강 «날짜 바꾸기» (2026-11-15 마감 통일·날짜 바꾸기) — 예약을 새 반·날짜로 갈아 끼운다.
 *
 * 예전에는 «예약 취소 → 다시 예약»이었다. 그 사이 보강권이 잠깐 «사용 가능»이 되어 다른 기기에서 다른 예약이 끼어들거나,
 * 취소만 되고 새 예약이 실패하는 반쪽 상태가 생길 수 있었다.
 * 여기서는 보강권을 RESERVED 그대로 둔 채 한 트랜잭션에서 «옛 예약 취소 + 새 예약 생성 + 보강권 연결 교체»를 한다.
 * 어느 단계든 실패하면 전부 되돌아가 옛 예약이 그대로 남는다.
 *
 * 규칙: 마감(보강 수업 시작 1시간 전)은 옛 날짜·새 날짜 양쪽 · 새 날짜는 보강권 사용 기한 안 · 학년·정원(정원 +2)은 새 예약과 같은 검사 ·
 *       정원은 작업대 잠금 뒤 다시 센다 · 소유 검사는 기존과 같은 childAccessSql.
 */
export async function rescheduleMakeup(
  parentUserId: string,
  input: { creditId: string; classId: string; dateYmd: string },
): Promise<{ ok: boolean; message: string }> {
  if (!isKstYmd(input.dateYmd)) return { ok: false, message: "날짜가 올바르지 않습니다." };

  // ★ 부모 소유 확인 + 지금 예약(반·KST 날짜)
  const own = await prisma.$queryRawUnsafe<Array<{
    id: string; studentId: string; originClassId: string | null; absenceDate: Date; expiresAt: Date;
    makeupSessionId: string | null; bookedClassId: string | null; makeupYmd: string | null; makeupStartTime: string | null;
  }>>(
    `SELECT mc.id, mc."studentId", mc."originClassId", mc."absenceDate", mc."expiresAt", mc."makeupSessionId",
            ms."makeupClassId" AS "bookedClassId", bc."startTime" AS "makeupStartTime",
            to_char(ms."makeupDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') AS "makeupYmd"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id = mc."studentId"
       JOIN "MakeupSession" ms ON ms.id = mc."makeupSessionId"
       LEFT JOIN "Class" bc ON bc.id = ms."makeupClassId"
      WHERE mc.id = $1 AND ${notMergedStudent("s")} AND ${await childAccessSql("s", "$2")} AND mc.status = 'RESERVED' LIMIT 1`,
    input.creditId, parentUserId,
  );
  const credit = own[0];
  if (!credit || !credit.makeupSessionId) return { ok: false, message: "날짜를 바꿀 수 있는 예약이 없습니다." };
  const oldSessionId = credit.makeupSessionId;

  // 마감 — 옛 날짜(옛 보강 수업 시작 1시간 전이 지났으면 못 바꾼다)
  const clock = kstNow();
  if (!isMakeupChangeOpen(credit.makeupYmd, credit.makeupStartTime, clock.ymd, clock.hm)) {
    return { ok: false, message: makeupClosedMessage(credit.makeupYmd, clock.ymd) };
  }
  // 새 날짜가 지난 날이면 후보를 계산하기 전에 거절(마감 시각은 아래에서 그 반의 시작 시각으로 본다)
  if (input.dateYmd < clock.ymd) return { ok: false, message: MAKEUP_BOOK_CLOSED_MESSAGE };
  if (input.classId === credit.bookedClassId && input.dateYmd === credit.makeupYmd) {
    return { ok: false, message: "지금 예약한 수업·날짜와 같습니다. 다른 날짜를 골라 주세요." };
  }
  // 사용 기한 — 새 예약과 같은 경계(그 날 KST 자정이 만료 시각을 넘으면 거절)
  const bookAt = new Date(kstAt(input.dateYmd));
  if (bookAt.getTime() > new Date(credit.expiresAt).getTime()) {
    return { ok: false, message: "보강권 사용 기간이 지난 날짜입니다." };
  }

  // 반 검증 — 학년·정원을 서버에서 다시 확인한다(클라이언트 값 신뢰 금지). 예약 중인 보강권용 후보.
  const opts = await getMakeupOptionsForCredit(parentUserId, input.creditId, { forReschedule: true });
  if (!opts.ok) return { ok: false, message: opts.message };
  const target = opts.options.find((o) => o.classId === input.classId);
  if (!target) return { ok: false, message: "이 학생이 갈 수 있는 수업이 아닙니다." };
  // 마감 — 새 날짜(그 반 수업 시작 1시간 전까지)
  if (!isMakeupChangeOpen(input.dateYmd, target.startTime, clock.ymd, clock.hm)) {
    return { ok: false, message: MAKEUP_BOOK_CLOSED_MESSAGE };
  }
  if (!target.dates.some((d) => d.ymd === input.dateYmd)) {
    return { ok: false, message: "그 수업이 열리지 않거나 이미 마감된 날짜입니다." };
  }

  try {
    await prisma.$transaction(async (tx) => {
      await lockCompensation(tx);
      // 이월(CARRY)로 정산된 결석의 보강은 손대지 않는다 — 예약·취소와 같은 가드
      await assertMakeupSessionAllowed(tx, oldSessionId);
      if (credit.originClassId) await assertRegularMakeupAllowed(tx, {
        studentId: credit.studentId, classId: credit.originClassId, dateYmd: toKstYmd(credit.absenceDate),
      });
      // ① 보강권 행 잠금 — 여전히 «이 예약»에 묶인 RESERVED 이고 내 자녀 것인지(그 사이 취소·변경됐으면 중단)
      const locked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM "MakeupCredit" WHERE id=$1 AND status='RESERVED'
          AND "makeupSessionId" IS NOT DISTINCT FROM $2
          AND EXISTS (SELECT 1 FROM "Student" s WHERE s.id="MakeupCredit"."studentId" AND ${await childAccessSql("s", "$3")} AND s."mergedIntoStudentId" IS NULL)
          FOR UPDATE`, input.creditId, oldSessionId, parentUserId,
      );
      if (!locked.length) throw new Error("MAKEUP_NOT_RESERVED");
      // ② 새 날짜 정원 — 잠금 뒤에 다시 센다(동시 예약 초과 방지, 기준은 정원 +2 그대로)
      if ((await seatsLeftInTx(tx, input.classId, input.dateYmd)) <= 0) throw new Error("MAKEUP_CLASS_FULL");
      // ③ 옛 예약 취소 — 아직 «예약(BOOKED)»인 것만(이미 출석·불참 처리됐으면 0행 → 중단)
      const closed = await tx.$executeRawUnsafe(
        `UPDATE "MakeupSession" SET status='CANCELLED', "updatedAt"=now() WHERE id=$1 AND status='BOOKED'`,
        oldSessionId,
      );
      if (Number(closed) === 0) throw new Error("MAKEUP_NOT_RESERVED");
      // ④ 새 예약 생성
      const created = await tx.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO "MakeupSession"
           (id,"studentId","originalClassId","originalDate","makeupClassId","makeupDate",status,"createdAt","updatedAt")
         VALUES (gen_random_uuid()::text,$1,$2,$3::timestamptz,$4,$5::timestamptz,'BOOKED',now(),now())
         RETURNING id`,
        credit.studentId, credit.originClassId ?? input.classId,
        new Date(credit.absenceDate).toISOString(), input.classId, bookAt.toISOString(),
      );
      // ⑤ 보강권은 RESERVED 그대로 — 연결만 새 예약으로 바꾼다(«사용 가능»으로 돌아가는 틈이 없다)
      const relinked = await tx.$executeRawUnsafe(
        `UPDATE "MakeupCredit" SET "makeupSessionId"=$2, "updatedAt"=now() WHERE id=$1 AND status='RESERVED'`,
        input.creditId, created[0].id,
      );
      if (Number(relinked) === 0) throw new Error("MAKEUP_NOT_RESERVED");
    });
    return { ok: true, message: `보강을 ${target.className} ${kstLabel(input.dateYmd)}(으)로 바꿨습니다.` };
  } catch (error) {
    // 실패한 거래는 통째로 되돌아간다 — 옛 예약이 그대로 남는다
    if (error instanceof CompensationConflict) return { ok: false, message: error.message };
    if (error instanceof Error && error.message === "MAKEUP_NOT_RESERVED") return { ok: false, message: "예약 상태가 변경됐습니다. 다시 확인해 주세요." };
    if (error instanceof Error && error.message === "MAKEUP_CLASS_FULL") return { ok: false, message: "방금 그 날짜가 마감됐습니다. 다른 날짜나 수업을 골라 주세요." };
    console.error("[rescheduleMakeup] 날짜 바꾸기 실패 — 거래 취소", error);
    return { ok: false, message: "날짜를 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요." };
  }
}
