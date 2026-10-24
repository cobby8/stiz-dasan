import { prisma } from "@/lib/prisma";
import { createHash } from "node:crypto";
import { notMergedStudent } from "@/lib/studentVisibility";
import {
  REASON_LABEL,
  DAY_KO,
  isValidReason,
  isYmd,
  isReportableDate,
  computeUpcomingDates,
  ymdToDayIndex,
} from "@/lib/regular/regularAbsenceRules";

// ── 정규 수업 "학부모 사전 결석 신고"(#3 Step B) ──────────────────────────
// 학부모가 자녀의 "아직 오지 않은" 정규 수업일을 사유와 함께 미리 결석 신고/취소한다.
//
// 방학특강(parent-absence.ts)은 좌석(SpecialProgramEnrollmentDate)·전화번호 기준이지만,
// 정규는 "Student.parentId(=로그인 부모 계정)" 기준이고, 실제 좌석 레코드가 없어
// Class 요일/시각으로 "향후 N주 수업일 목록"을 계산해 신고를 받는다.
//
// ★ 3대 보안 가드(반드시 유지):
//   1) IDOR 방어 — studentId 가 그 부모(appUserId)의 자녀인지, classId 가 그 학생의
//      ACTIVE Enrollment 인지 SQL 로 재검증. 클라이언트가 보낸 값 자체를 신뢰하지 않는다.
//   2) 확정건 보호 — 관리자가 확정(CONFIRMED)한 건은 학부모가 덮어쓰거나 취소하지 못한다
//      (INSERT ... ON CONFLICT DO UPDATE WHERE status<>'CONFIRMED', UPDATE WHERE status='REPORTED').
//   3) 미래 + 요일 일치 — 지난 날짜, 그 반 요일과 맞지 않는 날짜는 신고 불가.

// 향후 몇 주치 수업일을 보여줄지(기본 4주).
const DEFAULT_WEEKS = 4;

// KST 기준 오늘 날짜(YYYY-MM-DD). 마이페이지 다른 곳과 동일하게 Asia/Seoul 고정.
function kstTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

// "8/5(화)" 라벨 만들기(표시용).
function dateLabel(ymd: string): string {
  const idx = ymdToDayIndex(ymd);
  const mm = Number(ymd.slice(5, 7));
  const dd = Number(ymd.slice(8, 10));
  const ko = idx == null ? "" : DAY_KO[idx];
  return `${mm}/${dd}(${ko})`;
}

export type UpcomingClassDate = {
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  date: string; // YYYY-MM-DD
  dateLabel: string;
  startTime: string;
  // 이 날짜에 기존 결석 신고가 있으면 그 상태/사유(없으면 null)
  reason: string | null;
  reasonLabel: string | null;
  status: string | null; // REPORTED | CONFIRMED | (CANCELLED 는 조회에서 제외)
  reported: boolean;
  locked: boolean; // 관리자 확정(CONFIRMED)이면 학부모가 못 건드림
};

export type UpcomingChild = {
  studentId: string;
  studentName: string;
  classes: {
    classId: string;
    className: string;
    dayOfWeek: string;
    startTime: string;
    dates: UpcomingClassDate[];
  }[];
};

// ── 1) 다가오는 정규 수업일 목록 ─────────────────────────────────────────
// 부모(appUserId)의 자녀별 ACTIVE Enrollment → 반 요일/시각으로 향후 N주 수업일 생성 +
// 각 날짜에 기존 RegularAbsence(있으면 상태) 조인.
export async function getUpcomingRegularClassDates(
  parentUserId: string,
  weeks: number = DEFAULT_WEEKS,
): Promise<UpcomingChild[]> {
  const today = kstTodayYmd();

  // 부모 자녀의 ACTIVE 수강 반(IDOR: Student.parentId = 로그인 부모).
  const enrollRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT s.id AS "studentId", s.name AS "studentName",
            c.id AS "classId", c.name AS "className",
            c."dayOfWeek" AS "dayOfWeek", c."startTime" AS "startTime"
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND e.status = 'ACTIVE'
       JOIN "Class" c ON c.id = e."classId"
      WHERE s."parentId" = $1 AND ${notMergedStudent("s")}
      ORDER BY s.name ASC, c."startTime" ASC`,
    parentUserId,
  );
  if (enrollRows.length === 0) return [];

  // 이 부모 자녀들의 기존 결석 신고(CANCELLED 제외)를 한 번에 조회해 키로 매핑.
  const absRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT ra."studentId" AS "studentId", ra."classId" AS "classId",
            to_char(ra.date, 'YYYY-MM-DD') AS "date", ra.reason AS reason, ra.status AS status
       FROM "RegularAbsence" ra
       JOIN "Student" s ON s.id = ra."studentId"
      WHERE s."parentId" = $1 AND ${notMergedStudent("s")} AND ra.status <> 'CANCELLED'`,
    parentUserId,
  );
  const absByKey = new Map<string, { reason: string; status: string }>();
  for (const a of absRows) {
    absByKey.set(`${a.studentId}|${a.classId}|${a.date}`, { reason: a.reason, status: a.status });
  }

  // 자녀별 → 반별 → 다가오는 날짜 목록으로 조립.
  const childMap = new Map<string, UpcomingChild>();
  for (const r of enrollRows) {
    if (!childMap.has(r.studentId)) {
      childMap.set(r.studentId, { studentId: r.studentId, studentName: r.studentName, classes: [] });
    }
    const child = childMap.get(r.studentId)!;

    const dates = computeUpcomingDates(today, r.dayOfWeek, weeks).map((ymd) => {
      const found = absByKey.get(`${r.studentId}|${r.classId}|${ymd}`);
      const status = found?.status ?? null;
      const reason = found?.reason ?? null;
      return {
        studentId: r.studentId,
        studentName: r.studentName,
        classId: r.classId,
        className: r.className,
        date: ymd,
        dateLabel: dateLabel(ymd),
        startTime: r.startTime,
        reason,
        reasonLabel: reason ? REASON_LABEL[reason] || reason : null,
        status,
        reported: status === "REPORTED" || status === "CONFIRMED",
        locked: status === "CONFIRMED",
      } as UpcomingClassDate;
    });

    child.classes.push({
      classId: r.classId,
      className: r.className,
      dayOfWeek: r.dayOfWeek,
      startTime: r.startTime,
      dates,
    });
  }

  return Array.from(childMap.values());
}

// 소유권 재검증: studentId 가 부모 자녀이고 classId 가 그 학생 ACTIVE 수강인지.
// 통과하면 그 반의 dayOfWeek 를 돌려준다(요일 검증에 사용). 아니면 null.
async function verifyOwnershipAndClass(
  parentUserId: string,
  studentId: string,
  classId: string,
): Promise<{ dayOfWeek: string; studentName: string; className: string } | null> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    // 이름은 알림 문구에만 쓴다(원장이 누구 결석인지 바로 알아야 한다).
    `SELECT c."dayOfWeek" AS "dayOfWeek", s.name AS "studentName", c.name AS "className"
       FROM "Enrollment" e
       JOIN "Student" s ON s.id = e."studentId"
       JOIN "Class" c ON c.id = e."classId"
      WHERE s."parentId" = $1 AND ${notMergedStudent("s")}
        AND e."studentId" = $2
        AND e."classId" = $3
        AND e.status = 'ACTIVE'
      LIMIT 1`,
    parentUserId, studentId, classId,
  );
  return rows[0]
    ? {
        dayOfWeek: rows[0].dayOfWeek,
        studentName: rows[0].studentName ?? rows[0].studentname ?? "",
        className: rows[0].className ?? rows[0].classname ?? "",
      }
    : null;
}

/**
 * 결석 신고·취소를 원장에게 알린다.
 *
 * 지금까지는 신고가 들어와도 아무 알림이 없어 원장이 /admin/absence 를 직접 열어봐야
 * 알 수 있었다. 셔틀 명단은 자동으로 반영되지만 사람은 모르고 지나간다.
 *
 * 알림 실패가 신고 자체를 되돌리면 안 된다 — 학부모는 이미 신고를 마쳤다.
 * 그래서 호출부에서 await 하되 오류는 여기서 삼킨다.
 */
export async function notifyAdminsOfAbsenceChange(input: {
  kind: "REPORTED" | "CANCELED";
  studentName: string;
  className: string;
  classId: string;
  studentId: string;
  date: string;
  reason?: string;
  recordId: string;
  eventVersion: string;
}) {
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    const reasonLabel = input.reason ? REASON_LABEL[input.reason as keyof typeof REASON_LABEL] : null;
    const title = input.kind === "REPORTED" ? "결석 사전 신고" : "결석 신고 취소";
    const message =
      input.kind === "REPORTED"
        ? `${input.studentName} 학생이 ${input.date} ${input.className} 수업에 결석 예정입니다.${reasonLabel ? ` (${reasonLabel})` : ""}`
        : `${input.studentName} 학생의 ${input.date} ${input.className} 결석 신고가 취소되었습니다.`;
    return await notifyOperationalStaff({
      stableEventKey: `regular-absence:${input.recordId}:${input.kind}:${input.eventVersion}`,
      eventType: `REGULAR_ABSENCE_${input.kind}`,
      studentId: input.studentId,
      type: "ABSENCE",
      title,
      message,
      linkUrl: "/admin/absence",
      staffLinkUrl: "/staff",
      classId: input.classId,
      includeCoach: true,
      includeDriver: true,
      driverContext: { studentId: input.studentId, serviceDate: input.date },
    });
  } catch (error) {
    console.error("[parent-regular-absence] 원장 알림 실패:", error);
  }
}

// ── 2) 사전 결석 신고 ─────────────────────────────────────────────────────
export async function reportRegularAbsence(
  parentUserId: string,
  input: { studentId: string; classId: string; date: string; reason: string },
) {
  const studentId = input?.studentId?.trim();
  const classId = input?.classId?.trim();
  const date = input?.date?.trim();
  const reason = input?.reason;

  if (!studentId || !classId) throw new Error("STUDENT_OR_CLASS_MISSING");
  if (!isYmd(date)) throw new Error("INVALID_DATE");
  if (!isValidReason(reason)) throw new Error("INVALID_REASON");

  // 가드1: 소유권 + 반 소속 재검증(클라 값 불신뢰).
  const owned = await verifyOwnershipAndClass(parentUserId, studentId, classId);
  if (!owned) throw new Error("NOT_OWNER");

  // 가드3: 미래 + 그 반 요일과 일치하는 날짜만.
  const today = kstTodayYmd();
  if (!isReportableDate(date, owned.dayOfWeek, today)) throw new Error("NOT_REPORTABLE_DATE");

  // INSERT ... ON CONFLICT — 학생·반·날짜당 1건. 관리자 확정(CONFIRMED)건은 학부모가 못 덮게.
  // (가드2: WHERE status<>'CONFIRMED')
  const saved = await prisma.$queryRawUnsafe<{ id: string; eventVersion: string }[]>(
    `INSERT INTO "RegularAbsence"
        ("studentId","classId","date","reason","status","reportedByUserId")
     VALUES ($1,$2,$3::date,$4,'REPORTED',$5)
     ON CONFLICT ("studentId","classId","date") DO UPDATE
        SET reason = EXCLUDED.reason,
            status = 'REPORTED',
            "reportedByUserId" = EXCLUDED."reportedByUserId",
            "updatedAt" = now()
      WHERE "RegularAbsence".status = 'CANCELLED'
         OR "RegularAbsence".reason IS DISTINCT FROM EXCLUDED.reason
     RETURNING id, to_char("updatedAt", 'YYYYMMDDHH24MISSUS') AS "eventVersion"`,
    studentId, classId, date, reason, parentUserId,
  );
  if (!saved[0]) {
    const current = await prisma.$queryRawUnsafe<{ status: string; reason: string }[]>(
      `SELECT status, reason FROM "RegularAbsence"
        WHERE "studentId"=$1 AND "classId"=$2 AND date=$3::date LIMIT 1`,
      studentId, classId, date,
    );
    if (current[0]?.status === "REPORTED" && current[0].reason === reason) {
      return { ok: true, reason, notification: null, noOp: true };
    }
    throw new Error("ABSENCE_NOT_CANCELABLE");
  }

  const notification = await notifyAdminsOfAbsenceChange({
    kind: "REPORTED",
    studentName: owned.studentName,
    className: owned.className,
    classId,
    studentId,
    date,
    reason,
    recordId: saved[0].id,
    eventVersion: `${saved[0].eventVersion}-${createHash("sha256").update(reason).digest("hex")}`,
  });

  return { ok: true, reason, notification };
}

// ── 3) 사전 결석 신고 취소 ────────────────────────────────────────────────
// id 또는 (studentId,classId,date) 로 지목. 본인(부모 자녀)의 REPORTED 건만 취소 가능.
// 관리자 확정(CONFIRMED)이면 0행 → 차단. 취소 행은 감사·알림 재조정을 위해 보존한다.
export async function cancelRegularAbsence(
  parentUserId: string,
  input: { id?: string; studentId?: string; classId?: string; date?: string },
) {
  const id = input?.id?.trim();
  const studentId = input?.studentId?.trim();
  const classId = input?.classId?.trim();
  const date = input?.date?.trim();

  // 취소 상태와 알림 근거를 같은 행에 남겨 나중에도 전달 실패를 재조정할 수 있게 한다.
  const returning = `RETURNING s.name AS "studentName", c.name AS "className", ra.id, c.id AS "classId", ra."studentId" AS "studentId",
                              to_char(ra.date,'YYYY-MM-DD') AS "date",
                              to_char(ra."updatedAt",'YYYYMMDDHH24MISSUS') AS "eventVersion"`;
  type CanceledRow = { id: string; studentName: string; className: string; classId: string; studentId: string; date: string; eventVersion: string };
  let canceled: CanceledRow[];
  if (id) {
    // id 로 지목: 그 결석이 이 부모 자녀의 것이고 REPORTED 인 경우만 삭제(IDOR 방어).
    canceled = await prisma.$queryRawUnsafe<CanceledRow[]>(
      `UPDATE "RegularAbsence" ra
          SET status = 'CANCELLED', "updatedAt" = NOW()
         FROM "Student" s, "Class" c
        WHERE ra."studentId" = s.id
          AND c.id = ra."classId"
          AND s."parentId" = $1
          AND ra.id = $2
          AND ra.status = 'REPORTED'
        ${returning}`,
      parentUserId, id,
    );
  } else {
    if (!studentId || !classId || !isYmd(date || "")) throw new Error("ABSENCE_NOT_FOUND");
    canceled = await prisma.$queryRawUnsafe<CanceledRow[]>(
      `UPDATE "RegularAbsence" ra
          SET status = 'CANCELLED', "updatedAt" = NOW()
         FROM "Student" s, "Class" c
        WHERE ra."studentId" = s.id
          AND c.id = ra."classId"
          AND s."parentId" = $1
          AND ra."studentId" = $2
          AND ra."classId" = $3
          AND ra.date = $4::date
          AND ra.status = 'REPORTED'
        ${returning}`,
      parentUserId, studentId, classId, date,
    );
  }

  if (canceled.length === 0) throw new Error("ABSENCE_NOT_CANCELABLE");

  const notification = await notifyAdminsOfAbsenceChange({
    kind: "CANCELED",
    studentName: canceled[0].studentName,
    className: canceled[0].className,
    classId: canceled[0].classId,
    studentId: canceled[0].studentId,
    date: canceled[0].date,
    recordId: canceled[0].id,
    eventVersion: canceled[0].eventVersion,
  });

  return { ok: true, notification };
}
