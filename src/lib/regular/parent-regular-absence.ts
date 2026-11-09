import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { isMakeupCreditIssuableYmd } from "@/lib/makeup/credit-service";
import {
  issueCreditForReportedAbsence,
  regularAbsenceSourceKey,
  settleCreditOnAbsenceCancel,
} from "@/lib/makeup/absence-report-credit";
import { kstAt } from "@/lib/datetime/kst";
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
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
  // 이 결석의 보강권 상태(AVAILABLE·RESERVED·USED·NO_SHOW, 없으면 null) — 신고 취소 확인 문구·막기에 쓴다
  makeupCredit: string | null;
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
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
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
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")} AND ra.status <> 'CANCELLED'`,
    parentUserId,
  );
  const absByKey = new Map<string, { reason: string; status: string }>();
  for (const a of absRows) {
    absByKey.set(`${a.studentId}|${a.classId}|${a.date}`, { reason: a.reason, status: a.status });
  }

  // 다가오는 결석의 보강권(오늘 KST 자정 이후 결석분만). 키는 보강권 sourceKey 그대로(REGULAR:{반}:{날짜}).
  // 조회 실패는 «보강권 정보 없음»으로 — 신고 화면 자체는 떠야 한다.
  const creditByKey = new Map<string, string>();
  try {
    const creditRows = await prisma.$queryRawUnsafe<Array<{ studentId: string; sourceKey: string; status: string }>>(
      `SELECT mc."studentId" AS "studentId", mc."sourceKey" AS "sourceKey", mc.status
         FROM "MakeupCredit" mc
         JOIN "Student" s ON s.id = mc."studentId"
        WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
          AND mc."sourceType" = 'REGULAR'
          AND mc.status IN ('AVAILABLE','RESERVED','USED','NO_SHOW')
          AND mc."absenceDate" >= $2::timestamptz`,
      parentUserId, new Date(kstAt(today)).toISOString(),
    );
    for (const c of creditRows) creditByKey.set(`${c.studentId}|${c.sourceKey}`, c.status);
  } catch (error) {
    console.error("[parent-regular-absence] 보강권 조회 실패(화면은 계속):", error instanceof Error ? error.name : "");
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
        makeupCredit: status ? creditByKey.get(`${r.studentId}|${regularAbsenceSourceKey(r.classId, ymd)}`) ?? null : null,
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
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
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

  // 결석 신고 저장 + 보강권 발급을 한 트랜잭션으로(2026-11-10 원장 결정 k4 — 신고 즉시 보강권).
  // 둘 중 하나만 남는 반쪽 상태(신고는 됐는데 보강권 없음 / 그 반대)를 만들지 않는다.
  const outcome = await prisma.$transaction(async (tx) => {
    // 잠금 순서 통일(교착 방지): 작업대 잠금 → 결석 행. 관리자 취소(cancelRegularAbsenceByAdmin)와 같은 순서
    await lockCompensation(tx);
    // INSERT ... ON CONFLICT — 학생·반·날짜당 1건. 관리자 확정(CONFIRMED)건은 학부모가 못 덮게.
    // (가드2: WHERE status<>'CONFIRMED')
    const saved = await tx.$queryRawUnsafe<{ id: string; eventVersion: string }[]>(
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
    let noOp = false;
    if (!saved[0]) {
      const current = await tx.$queryRawUnsafe<{ status: string; reason: string }[]>(
        `SELECT status, reason FROM "RegularAbsence"
          WHERE "studentId"=$1 AND "classId"=$2 AND date=$3::date LIMIT 1`,
        studentId, classId, date,
      );
      if (!(current[0]?.status === "REPORTED" && current[0].reason === reason)) throw new Error("ABSENCE_NOT_CANCELABLE");
      noOp = true; // 같은 신고를 다시 보냄 — 보강권 발급은 멱등이라 아래에서 한 번 더 확인만 한다(이 기능 이전 신고분도 채워진다)
    }
    // 보강권 — 출결 기반 발급과 같은 키(REGULAR:{반}:{날짜})라 나중에 출결이 결석으로 저장돼도 한 장
    const credit = isMakeupCreditIssuableYmd(date)
      ? await issueCreditForReportedAbsence(tx, { studentId, classId, absenceYmd: date })
      : { issued: false };
    return { saved: saved[0] ?? null, noOp, makeupCreditIssued: credit.issued };
  });
  if (outcome.noOp || !outcome.saved) {
    return { ok: true, reason, notification: null, noOp: true, makeupCreditIssued: outcome.makeupCreditIssued };
  }
  const saved = [outcome.saved];

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

  return { ok: true, reason, notification, makeupCreditIssued: outcome.makeupCreditIssued };
}

// ── 3) 사전 결석 신고 취소 ────────────────────────────────────────────────
// id 또는 (studentId,classId,date) 로 지목. 본인(부모 자녀)의 REPORTED 건만 취소 가능.
// 관리자 확정(CONFIRMED)이면 0행 → 차단. 취소 행은 감사·알림 재조정을 위해 보존한다.
// 보강권(2026-11-10 k4): 같은 트랜잭션에서 그 결석의 보강권을 되돌린다(settleCreditOnAbsenceCancel).
//   미사용 → 회수 / 보강 예약됨 → confirmMakeupCancel 이 true 일 때만 예약 취소 + 회수(아니면 확인 요청 오류)
//   / 이미 보강을 들음·예약일 지남 → 신고 취소 자체를 막는다(오류 → 트랜잭션 전체 되돌림).
export async function cancelRegularAbsence(
  parentUserId: string,
  input: { id?: string; studentId?: string; classId?: string; date?: string; confirmMakeupCancel?: boolean },
) {
  const id = input?.id?.trim();
  const studentId = input?.studentId?.trim();
  const classId = input?.classId?.trim();
  const date = input?.date?.trim();
  const confirmMakeupCancel = input?.confirmMakeupCancel === true;

  // 취소 상태와 알림 근거를 같은 행에 남겨 나중에도 전달 실패를 재조정할 수 있게 한다.
  const returning = `RETURNING s.name AS "studentName", c.name AS "className", ra.id, c.id AS "classId", ra."studentId" AS "studentId",
                              to_char(ra.date,'YYYY-MM-DD') AS "date",
                              to_char(ra."updatedAt",'YYYYMMDDHH24MISSUS') AS "eventVersion"`;
  type CanceledRow = { id: string; studentName: string; className: string; classId: string; studentId: string; date: string; eventVersion: string };
  if (!id && (!studentId || !classId || !isYmd(date || ""))) throw new Error("ABSENCE_NOT_FOUND");
  // 권한 조건(그 부모의 자녀만)은 기존 그대로 — 트랜잭션 밖에서 SQL 조각만 미리 만든다
  const access = await childAccessSql("s", "$1");

  const { canceled, creditAction } = await prisma.$transaction(async (tx) => {
    // 잠금 순서 통일(교착 방지): 작업대 잠금 → 결석 행. 관리자 취소(cancelRegularAbsenceByAdmin)와 같은 순서
    await lockCompensation(tx);
    let canceled: CanceledRow[];
    if (id) {
      // id 로 지목: 그 결석이 이 부모 자녀의 것이고 REPORTED 인 경우만 취소(IDOR 방어).
      canceled = await tx.$queryRawUnsafe<CanceledRow[]>(
        `UPDATE "RegularAbsence" ra
            SET status = 'CANCELLED', "updatedAt" = NOW()
           FROM "Student" s, "Class" c
          WHERE ra."studentId" = s.id
            AND c.id = ra."classId"
            AND ${access}
            AND ra.id = $2
            AND ra.status = 'REPORTED'
          ${returning}`,
        parentUserId, id,
      );
    } else {
      canceled = await tx.$queryRawUnsafe<CanceledRow[]>(
        `UPDATE "RegularAbsence" ra
            SET status = 'CANCELLED', "updatedAt" = NOW()
           FROM "Student" s, "Class" c
          WHERE ra."studentId" = s.id
            AND c.id = ra."classId"
            AND ${access}
            AND ra."studentId" = $2
            AND ra."classId" = $3
            AND ra.date = $4::date
            AND ra.status = 'REPORTED'
          ${returning}`,
        parentUserId, studentId, classId, date,
      );
    }
    if (canceled.length === 0) throw new Error("ABSENCE_NOT_CANCELABLE");

    // 보강권 되돌리기 — 막아야 하면 오류를 던져 위 취소까지 함께 되돌린다
    const settled = await settleCreditOnAbsenceCancel(tx, {
      actor: "PARENT",
      studentId: canceled[0].studentId,
      classId: canceled[0].classId,
      absenceYmd: canceled[0].date,
      confirmBookingCancel: confirmMakeupCancel,
    });
    return { canceled, creditAction: settled.action };
  });

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

  return {
    ok: true,
    notification,
    // 화면 문구용: 보강권 회수 / 보강 예약까지 함께 취소됐는지
    makeupCreditRevoked: creditAction === "REVOKE" || creditAction === "CANCEL_BOOKING_AND_REVOKE",
    makeupBookingCanceled: creditAction === "CANCEL_BOOKING_AND_REVOKE",
  };
}
