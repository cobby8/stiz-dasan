import { prisma } from "@/lib/prisma";
import { notMergedStudent } from "@/lib/studentVisibility";
import { recommendClasses, summarize, type ClassCandidate, type MakeupCreditStatus } from "./credit-rules";
import { assertMakeupSessionAllowed, assertRegularMakeupAllowed, CompensationConflict, lockCompensation } from "@/lib/billing/absence-compensation-guard";

// 학부모용 보강 — 보강권 조회 · 반 추천 · 예약 · 취소.
//
// ★ IDOR 방어(이 파일의 가장 중요한 규칙)
//   모든 쿼리는 "Student"."parentId" = 로그인 부모(appUserId) 를 조인 조건에 넣는다.
//   클라이언트가 보낸 creditId/studentId 를 그대로 믿지 않는다. 남의 자녀 보강권을
//   예약·취소하려 해도 조인에서 걸러져 0행이 되고 실패한다.
//
// 근거 — 2026-08-09 개정 이용약관 「수업의 보강」
//   · 학년이 맞는 다른 수업 / 정원 +2 까지
//   · 보강 예약은 보호자가 직접
//   · 미리 취소하면 보강권 유지, 무단 불참은 사용 처리

const KST = "Asia/Seoul";

function kstYmd(d: Date | string): string {
  const v = typeof d === "string" ? new Date(d) : d;
  return new Intl.DateTimeFormat("en-CA", { timeZone: KST }).format(v);
}

/** "8/12(수)" */
function dayLabel(d: Date | string): string {
  const v = typeof d === "string" ? new Date(d) : d;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "numeric", day: "numeric", weekday: "short" })
      .formatToParts(v).map((x) => [x.type, x.value]),
  );
  return `${Number(p.month)}/${Number(p.day)}(${(p.weekday || "").replace("요일", "")})`;
}

const DOW_TO_ISO: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

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
      WHERE s."parentId" = $1 AND ${notMergedStudent("s")}
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
    absenceLabel: dayLabel(r.absenceDate),
    expiresLabel: dayLabel(r.expiresAt),
    expiresYmd: kstYmd(r.expiresAt),
    status: r.status,
    booking: r.makeupSessionId && r.bookedDate
      ? { sessionId: r.makeupSessionId, className: r.bookedClassName ?? "", dateLabel: dayLabel(r.bookedDate) }
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
  remaining: number;
  /** 만료 전에 실제로 갈 수 있는 날짜들 */
  dates: { ymd: string; label: string }[];
};

/**
 * 이 보강권으로 갈 수 있는 반 목록.
 *
 * 학년 판정은 시간표의 수업별 학년 구성(ScheduleSlot.gradesJSON)을 쓴다.
 * 프로그램 대상연령("초등저~고 (일부 중학생 가능)")은 자유 문장이라 절대 파싱하지 않는다.
 */
export async function getMakeupOptionsForCredit(
  parentUserId: string,
  creditId: string,
): Promise<{ ok: true; options: MakeupOption[]; expiresYmd: string } | { ok: false; message: string }> {
  // ★ 부모 소유 확인이 여기서 끝난다. 이후 쿼리는 이 결과만 신뢰한다.
  const own = await prisma.$queryRawUnsafe<Array<{
    id: string; studentId: string; studentGrade: string | null; originClassId: string | null;
    status: MakeupCreditStatus; expiresAt: Date;
  }>>(
    `SELECT mc.id, mc."studentId", s.grade AS "studentGrade", mc."originClassId",
            mc.status, mc."expiresAt"
       FROM "MakeupCredit" mc
       JOIN "Student" s ON s.id = mc."studentId"
      WHERE mc.id = $1 AND s."parentId" = $2
      LIMIT 1`,
    creditId, parentUserId,
  );
  const credit = own[0];
  if (!credit) return { ok: false, message: "보강권을 찾을 수 없습니다." };
  if (credit.status !== "AVAILABLE") return { ok: false, message: "이미 예약했거나 사용할 수 없는 보강권입니다." };
  if (new Date(credit.expiresAt).getTime() < Date.now()) {
    return { ok: false, message: "사용 기간이 지난 보강권입니다." };
  }

  // 반 + 시간표 학년구성 + 현재 인원 + 이미 잡힌 보강 수
  const rows = await prisma.$queryRawUnsafe<Array<{
    classId: string; className: string; dayOfWeek: string; startTime: string; endTime: string;
    capacity: number; gradesJson: string | null; enrolled: number; booked: number;
  }>>(
    `SELECT c.id AS "classId", c.name AS "className", c."dayOfWeek", c."startTime", c."endTime",
            c.capacity, ss."gradesJSON" AS "gradesJson",
            (SELECT COUNT(*) FROM "Enrollment" e
              WHERE e."classId" = c.id AND e.status = 'ACTIVE')::int AS enrolled,
            (SELECT COUNT(*) FROM "MakeupSession" m
              WHERE m."makeupClassId" = c.id AND m.status = 'BOOKED')::int AS booked
       FROM "Class" c
       JOIN "ScheduleSlot" ss ON ss."slotKey" = c."slotKey"`,
  );

  const candidates: ClassCandidate[] = rows.map((r) => {
    let grades: string[] = [];
    try { const p = JSON.parse(r.gradesJson ?? "[]"); if (Array.isArray(p)) grades = p.map(String); } catch { /* 형식 오류는 빈 배열 */ }
    return {
      classId: r.classId, className: r.className, dayOfWeek: r.dayOfWeek,
      startTime: r.startTime, grades, capacity: r.capacity,
      enrolled: r.enrolled, booked: r.booked,
    };
  });

  const picked = recommendClasses(candidates, credit.studentGrade, { excludeClassId: credit.originClassId });
  const endTimeByClass = new Map(rows.map((r) => [r.classId, r.endTime as string]));

  const expiresAt = new Date(credit.expiresAt);
  const options: MakeupOption[] = picked.map((c) => ({
    classId: c.classId,
    className: c.className,
    dayOfWeek: c.dayOfWeek,
    startTime: c.startTime,
    endTime: endTimeByClass.get(c.classId) ?? "",
    grades: c.grades,
    remaining: c.remaining,
    dates: upcomingDates(c.dayOfWeek, expiresAt),
  })).filter((o) => o.dates.length > 0); // 만료 전에 갈 수 있는 날이 없으면 뺀다

  return { ok: true, options, expiresYmd: kstYmd(expiresAt) };
}

/** 내일부터 만료일까지, 그 요일에 해당하는 날짜들(최대 8개). */
function upcomingDates(dayOfWeek: string, expiresAt: Date): { ymd: string; label: string }[] {
  const iso = DOW_TO_ISO[dayOfWeek];
  if (!iso) return [];
  const out: { ymd: string; label: string }[] = [];
  // KST 자정을 기준점으로 잡고 하루씩 더한다(오늘은 제외 — 내일부터 예약 가능).
  const start = new Date(`${kstYmd(new Date())}T00:00:00+09:00`);
  for (let i = 1; i <= 70 && out.length < 8; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    if (d.getTime() > expiresAt.getTime()) break;
    const label = new Intl.DateTimeFormat("en-US", { timeZone: KST, weekday: "short" }).format(d);
    if (DOW_TO_ISO[label] === iso) out.push({ ymd: kstYmd(d), label: dayLabel(d) });
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.dateYmd)) return { ok: false, message: "날짜가 올바르지 않습니다." };

  const own = await prisma.$queryRawUnsafe<Array<{
    id: string; studentId: string; originClassId: string | null; absenceDate: Date; expiresAt: Date; studentGrade: string | null;
  }>>(
    `SELECT mc.id, mc."studentId", mc."originClassId", mc."absenceDate", mc."expiresAt", s.grade AS "studentGrade"
       FROM "MakeupCredit" mc JOIN "Student" s ON s.id = mc."studentId"
      WHERE mc.id = $1 AND s."parentId" = $2 AND mc.status = 'AVAILABLE' LIMIT 1`,
    input.creditId, parentUserId,
  );
  const credit = own[0];
  if (!credit) return { ok: false, message: "예약할 수 있는 보강권이 아닙니다." };

  const bookAt = new Date(`${input.dateYmd}T00:00:00+09:00`);
  if (bookAt.getTime() > new Date(credit.expiresAt).getTime()) {
    return { ok: false, message: "보강권 사용 기간이 지난 날짜입니다." };
  }

  // 반 검증 — 학년·정원을 서버에서 다시 확인한다(클라이언트 값 신뢰 금지).
  const opts = await getMakeupOptionsForCredit(parentUserId, input.creditId);
  if (!opts.ok) return { ok: false, message: opts.message };
  const target = opts.options.find((o) => o.classId === input.classId);
  if (!target) return { ok: false, message: "이 학생이 갈 수 있는 수업이 아닙니다." };
  if (!target.dates.some((d) => d.ymd === input.dateYmd)) {
    return { ok: false, message: "그 수업이 열리지 않는 날짜입니다." };
  }

  try {
    await prisma.$transaction(async tx => {
      await lockCompensation(tx);
      if (credit.originClassId) await assertRegularMakeupAllowed(tx, {
        studentId: credit.studentId, classId: credit.originClassId, dateYmd: kstYmd(credit.absenceDate),
      });
      // 이월 전환과 같은 잠금을 잡고 예약·권 연결을 함께 저장한다.
      const locked = await tx.$executeRawUnsafe(
        `UPDATE "MakeupCredit" SET status='RESERVED', "updatedAt"=now()
          WHERE id=$1 AND status='AVAILABLE'
            AND EXISTS (SELECT 1 FROM "Student" s WHERE s.id="MakeupCredit"."studentId" AND s."parentId"=$2 AND s."mergedIntoStudentId" IS NULL)`, input.creditId, parentUserId,
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
    return { ok: true, message: `${target.className} ${dayLabel(bookAt)} 보강이 예약되었습니다.` };
  } catch (error) {
    // 실패한 거래는 되돌린다. 별도 복구 UPDATE로 회수된 권을 되살리지 않는다.
    if (error instanceof CompensationConflict) return { ok: false, message: error.message };
    if (error instanceof Error && error.message === "MAKEUP_ALREADY_RESERVED") return { ok: false, message: "이미 예약 처리된 보강권입니다." };
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
      WHERE mc.id = $1 AND s."parentId" = $2 AND mc.status = 'RESERVED' LIMIT 1`,
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
          AND EXISTS (SELECT 1 FROM "Student" s WHERE s.id="MakeupCredit"."studentId" AND s."parentId"=$3 AND s."mergedIntoStudentId" IS NULL)
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
