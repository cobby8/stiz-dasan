import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { isMakeupCreditIssuableYmd } from "@/lib/makeup/credit-service";
import {
  issueCreditForReportedAbsence,
  regularAbsenceSourceKey,
  settleCreditOnAbsenceCancel,
} from "@/lib/makeup/absence-report-credit";
import { kstAt, kstHm, todayKst } from "@/lib/datetime/kst";
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { createHash } from "node:crypto";
import { notMergedStudent } from "@/lib/studentVisibility";
import { BeforeResumeError, parentUsableEnrollmentSql, resumeFromSql, usableOn } from "@/lib/enrollment/resumeWindow";
import {
  REASON_LABEL,
  DAY_KO,
  isValidReason,
  isYmd,
  isReportableAt,
  isAbsenceChangeOpen,
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
//      «쓸 수 있는» Enrollment 인지 SQL 로 재검증. 클라이언트가 보낸 값 자체를 신뢰하지 않는다.
//      (2026-11-14 복귀 예정) 쓸 수 있는 수강 = ACTIVE 또는 «복귀 승인된 휴원 반»(resumeWindow 한 곳의 규칙).
//      복귀 예정 반은 복귀일 이후 날짜만 받는다 — 목록·신고·취소 모두 서버가 다시 본다.
//   2) 확정건 보호 — 관리자가 확정(CONFIRMED)한 건은 학부모가 덮어쓰거나 취소하지 못한다
//      (INSERT ... ON CONFLICT DO UPDATE WHERE status<>'CONFIRMED', UPDATE WHERE status='REPORTED').
//   3) 마감 전 + 요일 일치 — 지난 날짜, 그 반 요일과 맞지 않는 날짜는 신고 불가.
//      (2026-11-14 결석 당일 취소·보강 연결) 오늘 수업도 «시작 1시간 전»까지 신고·취소·사유 변경을 받는다.
//      마감 판정은 regularAbsenceRules.isAbsenceChangeOpen 하나 — 신고·취소 양쪽에서 서버가 강제한다.

// 향후 몇 주치 수업일을 보여줄지(기본 4주).
const DEFAULT_WEEKS = 4;
// 신고를 받는 범위도 목록과 같다(2026-11-14 검수) — 화면에서 고를 수 없는 먼 날짜를 API 로 직접 보내
// 건마다 보강권을 받아 가는 길을 막는다. 카카오 결석(ABSENCE_WEEKS)도 4주라 같은 범위다.
export const ABSENCE_REPORT_WEEKS = DEFAULT_WEEKS;

// «지금»을 KST 글자(날짜·시각)로 — 달력 값은 공용 모듈(kst.ts)에서만 만든다(서버는 UTC 로 돈다).
function kstNow(): { ymd: string; hm: string } {
  const nowMs = Date.now();
  return { ymd: todayKst(nowMs), hm: kstHm(nowMs) };
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
  // 지금 신고·취소·사유 변경을 받을 수 있나(수업 시작 1시간 전까지). false 면 화면이 «학원으로 연락» 글을 보인다.
  // 서버도 같은 함수로 다시 막는다 — 이 값은 화면 표시용일 뿐이다.
  changeOpen: boolean;
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
    // 복귀 승인된 휴원 반이면 복귀일("YYYY-MM-DD") — 그날 이후 수업만 dates 에 들어 있다. 다니는 반은 null
    resumeFrom: string | null;
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
  const now = kstNow();
  const today = now.ymd;

  // 부모 자녀가 «쓸 수 있는» 수강 반(IDOR: Student.parentId = 로그인 부모).
  // 2026-11-14 복귀 예정: 다니는 반(ACTIVE) + 복귀가 승인된 휴원 반. 복귀 예정 반은 아래에서 복귀일 이후 날짜만 남긴다.
  const enrollRows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT s.id AS "studentId", s.name AS "studentName",
            c.id AS "classId", c.name AS "className",
            c."dayOfWeek" AS "dayOfWeek", c."startTime" AS "startTime",
            e.status AS "enrollmentStatus", ${resumeFromSql("e")} AS "resumeFrom"
       FROM "Student" s
       JOIN "Enrollment" e ON e."studentId" = s.id AND ${parentUsableEnrollmentSql("e")}
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

    // 오늘 수업도 목록에 넣는다(2026-11-14) — 마감 여부는 줄마다 changeOpen 으로 알려 준다
    // 복귀 예정 반은 복귀일 전 날짜를 내보내지 않는다(그날은 아직 휴원이다)
    const resumeFrom: string | null = r.resumeFrom ?? null;
    const dates = computeUpcomingDates(today, r.dayOfWeek, weeks, true)
      .filter((ymd) => usableOn(r.enrollmentStatus, resumeFrom, ymd))
      .map((ymd) => {
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
        changeOpen: isAbsenceChangeOpen(ymd, r.startTime, now.ymd, now.hm),
        makeupCredit: status ? creditByKey.get(`${r.studentId}|${regularAbsenceSourceKey(r.classId, ymd)}`) ?? null : null,
      } as UpcomingClassDate;
    });

    child.classes.push({
      classId: r.classId,
      className: r.className,
      dayOfWeek: r.dayOfWeek,
      startTime: r.startTime,
      resumeFrom: r.enrollmentStatus === "PAUSED" ? resumeFrom : null,
      dates,
    });
  }

  return Array.from(childMap.values());
}

// 소유권 재검증: studentId 가 부모 자녀이고 classId 가 그 학생이 «쓸 수 있는» 수강인지
// (ACTIVE 또는 복귀 승인된 휴원 반 — 2026-11-14 복귀 예정. 복귀 승인이 없거나 대기 중이면 null 그대로).
// 통과하면 그 반의 dayOfWeek·startTime 과 수강 상태·복귀일을 돌려준다(요일·마감·복귀일 검증에 사용). 아니면 null.
async function verifyOwnershipAndClass(
  parentUserId: string,
  studentId: string,
  classId: string,
): Promise<{ dayOfWeek: string; startTime: string | null; studentName: string; className: string; status: string; resumeFrom: string | null } | null> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    // 이름은 알림 문구에만 쓴다(원장이 누구 결석인지 바로 알아야 한다).
    `SELECT c."dayOfWeek" AS "dayOfWeek", c."startTime" AS "startTime", s.name AS "studentName", c.name AS "className",
            e.status AS "enrollmentStatus", ${resumeFromSql("e")} AS "resumeFrom"
       FROM "Enrollment" e
       JOIN "Student" s ON s.id = e."studentId"
       JOIN "Class" c ON c.id = e."classId"
      WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
        AND e."studentId" = $2
        AND e."classId" = $3
        AND ${parentUsableEnrollmentSql("e")}
      LIMIT 1`,
    parentUserId, studentId, classId,
  );
  return rows[0]
    ? {
        dayOfWeek: rows[0].dayOfWeek,
        startTime: rows[0].startTime ?? rows[0].starttime ?? null,
        studentName: rows[0].studentName ?? rows[0].studentname ?? "",
        className: rows[0].className ?? rows[0].classname ?? "",
        status: rows[0].enrollmentStatus ?? rows[0].enrollmentstatus ?? "",
        resumeFrom: rows[0].resumeFrom ?? rows[0].resumefrom ?? null,
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

  // 복귀 예정 반(2026-11-14): 복귀일 전 날짜는 아직 휴원이라 받지 않는다 — 화면 목록을 믿지 않고 서버가 다시 본다.
  if (!usableOn(owned.status, owned.resumeFrom, date)) {
    if (owned.resumeFrom) throw new BeforeResumeError(owned.resumeFrom);
    throw new Error("NOT_OWNER");
  }

  // 가드3: 그 반 요일과 일치 + 마감 전(수업 시작 1시간 전까지 — 오늘 수업 포함).
  // 새 신고와 사유 변경(재신고)이 모두 이 길을 지나므로 여기 한 곳에서 막으면 둘 다 막힌다.
  const now = kstNow();
  if (!isReportableAt(date, owned.dayOfWeek, owned.startTime, now.ymd, now.hm)) {
    // 오늘 수업인데 1시간 전이 지난 경우는 «학원으로 연락» 안내가 따로 나가게 코드를 나눈다
    throw new Error(date === now.ymd && ymdToDayIndex(date) != null ? "ABSENCE_CHANGE_CLOSED" : "NOT_REPORTABLE_DATE");
  }

  // 앞날 상한: 목록이 보여 주는 수업일(오늘 포함 4주치) 밖의 날짜는 받지 않는다 — 다니는 반·복귀 예정 반 모두 같은 규칙.
  if (!computeUpcomingDates(now.ymd, owned.dayOfWeek, ABSENCE_REPORT_WEEKS, true).includes(date)) {
    throw new Error("ABSENCE_TOO_FAR");
  }

  // 결석 신고 저장 + 보강권 발급을 한 트랜잭션으로(2026-11-10 원장 결정 k4 — 신고 즉시 보강권).
  // 둘 중 하나만 남는 반쪽 상태(신고는 됐는데 보강권 없음 / 그 반대)를 만들지 않는다.
  const outcome = await prisma.$transaction(async (tx) => {
    // 잠금 순서 통일(교착 방지): 작업대 잠금 → 결석 행. 관리자 취소(cancelRegularAbsenceByAdmin)와 같은 순서
    await lockCompensation(tx);
    // INSERT ... ON CONFLICT — 학생·반·날짜당 1건. 관리자 확정(CONFIRMED)건은 학부모가 못 덮게.
    // (가드2) 덮어쓰는 경우는 둘뿐: 취소됐던 신고를 다시 신고 / 신고 상태(REPORTED)에서 «사유 변경».
    //   2026-11-14: 예전 조건은 «사유가 다르면» 만 봐서 확정건도 사유가 다르면 REPORTED 로 되돌아갔다 —
    //   화면에 «사유 변경»이 생기면서 그 구멍이 실제 길이 되므로 REPORTED 조건을 붙였다.
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
           OR ("RegularAbsence".status = 'REPORTED' AND "RegularAbsence".reason IS DISTINCT FROM EXCLUDED.reason)
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
                              to_char(ra.date,'YYYY-MM-DD') AS "date", c."startTime" AS "startTime",
                              to_char(ra."updatedAt",'YYYYMMDDHH24MISSUS') AS "eventVersion",
                              (SELECT ${resumeFromSql("e")} FROM "Enrollment" e
                                WHERE e."studentId" = ra."studentId" AND e."classId" = ra."classId" LIMIT 1) AS "resumeFrom"`;
  type CanceledRow = { id: string; studentName: string; className: string; classId: string; studentId: string; date: string; startTime: string | null; eventVersion: string; resumeFrom: string | null };
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

    // 복귀 예정 반(2026-11-14): 복귀일 전 날짜의 신고는 학부모가 건드리지 못한다(신고와 같은 기준).
    // resumeFrom 은 «복귀 승인된 휴원 반»일 때만 값이 있다 — 다니는 반은 NULL 이라 예전과 같다. 던지면 위 UPDATE 도 되돌려진다.
    if (canceled[0].resumeFrom && canceled[0].date < canceled[0].resumeFrom) {
      throw new BeforeResumeError(canceled[0].resumeFrom);
    }

    // 마감 강제(2026-11-14): 수업 시작 1시간 전이 지났으면 취소를 받지 않는다 — 신고와 같은 함수.
    // 트랜잭션 안에서 던지므로 위 UPDATE 도 함께 되돌려진다(화면에서 버튼을 숨기는 것만으로 끝내지 않는다).
    const now = kstNow();
    if (!isAbsenceChangeOpen(canceled[0].date, canceled[0].startTime, now.ymd, now.hm)) {
      throw new Error("ABSENCE_CHANGE_CLOSED");
    }

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

// ── 4) 결석 신고 «날짜 바꾸기» (2026-11-15 마감 통일·날짜 바꾸기) ─────────────────────────
// 예전에는 «취소한 뒤 다시 신고»였다 — 두 번 누르는 사이에 한쪽만 되는 반쪽 상태가 생길 수 있었다.
// 이제 한 트랜잭션에서 «옛 신고 취소 + 새 날짜 신고»를 함께 한다. 어느 단계든 실패하면 전부 되돌아가
// 옛 신고(와 그 보강권)가 그대로 남는다.
//
// 규칙
//   · 같은 반의 다른 수업일로만(목록에 보이는 4주 범위 안, 그 반 요일, 복귀 예정 반은 복귀일 이후).
//   · 마감(수업 1시간 전)은 옛 날짜·새 날짜 양쪽에 적용한다.
//   · 확정(CONFIRMED)된 신고는 옮길 수 없다(취소와 같은 조건 — REPORTED 만).
//   · 그 결석의 보강권으로 이미 보강이 예약돼 있으면 옮기지 않는다 → «보강 예약을 먼저 취소하거나 바꿔 주세요».
//     (보강을 이미 들었으면 취소와 같은 MAKEUP_ALREADY_USED)
//   · 새 날짜에 이미 신고(또는 확정)가 있으면 옮기지 않는다.
//   · 사유는 옛 신고의 것을 그대로 가져간다.
//   · 보강권: 옛 결석분은 회수, 새 결석분은 발급 — 기존 함수(settleCreditOnAbsenceCancel·issueCreditForReportedAbsence) 그대로.
export async function moveRegularAbsence(
  parentUserId: string,
  input: { studentId?: string; classId?: string; date?: string; toDate?: string },
) {
  const studentId = input?.studentId?.trim();
  const classId = input?.classId?.trim();
  const date = input?.date?.trim() ?? "";
  const toDate = input?.toDate?.trim() ?? "";

  if (!studentId || !classId) throw new Error("STUDENT_OR_CLASS_MISSING");
  if (!isYmd(date) || !isYmd(toDate)) throw new Error("INVALID_DATE");
  if (date === toDate) throw new Error("ABSENCE_MOVE_SAME_DATE");

  // 가드1: 소유권 + 반 소속(취소·신고와 같은 검사)
  const owned = await verifyOwnershipAndClass(parentUserId, studentId, classId);
  if (!owned) throw new Error("NOT_OWNER");

  // 복귀 예정 반: 옛 날짜·새 날짜 모두 복귀일 이후여야 한다
  for (const ymd of [date, toDate]) {
    if (!usableOn(owned.status, owned.resumeFrom, ymd)) {
      if (owned.resumeFrom) throw new BeforeResumeError(owned.resumeFrom);
      throw new Error("NOT_OWNER");
    }
  }

  // 가드3(새 날짜): 그 반 요일 + 마감 전 + 목록 범위(4주) 안 — 새 신고와 같은 기준
  const now = kstNow();
  if (!isReportableAt(toDate, owned.dayOfWeek, owned.startTime, now.ymd, now.hm)) {
    throw new Error(toDate === now.ymd && ymdToDayIndex(toDate) != null ? "ABSENCE_CHANGE_CLOSED" : "NOT_REPORTABLE_DATE");
  }
  if (!computeUpcomingDates(now.ymd, owned.dayOfWeek, ABSENCE_REPORT_WEEKS, true).includes(toDate)) {
    throw new Error("ABSENCE_TOO_FAR");
  }
  // 마감(옛 날짜): 이미 마감된 신고는 옮기지 못한다 — 트랜잭션을 열기 전에 먼저 본다(안에서도 다시 본다)
  if (!isAbsenceChangeOpen(date, owned.startTime, now.ymd, now.hm)) throw new Error("ABSENCE_CHANGE_CLOSED");

  const access = await childAccessSql("s", "$1");
  type MovedRow = { id: string; reason: string; eventVersion: string };

  const outcome = await prisma.$transaction(async (tx) => {
    // 잠금 순서는 신고·취소와 같다(작업대 잠금 → 결석 행)
    await lockCompensation(tx);

    // ① 옛 신고 취소 — 이 부모 자녀의 REPORTED 건만(확정건·남의 자녀는 0행)
    const canceled = await tx.$queryRawUnsafe<MovedRow[]>(
      `UPDATE "RegularAbsence" ra
          SET status = 'CANCELLED', "updatedAt" = NOW()
         FROM "Student" s
        WHERE ra."studentId" = s.id
          AND ${access} AND ${notMergedStudent("s")}
          AND ra."studentId" = $2
          AND ra."classId" = $3
          AND ra.date = $4::date
          AND ra.status = 'REPORTED'
        RETURNING ra.id, ra.reason AS reason, to_char(ra."updatedAt",'YYYYMMDDHH24MISSUS') AS "eventVersion"`,
      parentUserId, studentId, classId, date,
    );
    if (canceled.length === 0) throw new Error("ABSENCE_NOT_CANCELABLE");

    // ② 마감 다시 확인(옛 날짜) — 던지면 위 취소도 되돌려진다
    const inTx = kstNow();
    if (!isAbsenceChangeOpen(date, owned.startTime, inTx.ymd, inTx.hm)) throw new Error("ABSENCE_CHANGE_CLOSED");

    // ③ 새 날짜에 이미 신고·확정이 있으면 옮기지 않는다(취소된 옛 줄은 아래에서 되살린다)
    const target = await tx.$queryRawUnsafe<{ status: string; reason: string }[]>(
      `SELECT status, reason FROM "RegularAbsence"
        WHERE "studentId"=$1 AND "classId"=$2 AND date=$3::date LIMIT 1`,
      studentId, classId, toDate,
    );
    if (target[0] && target[0].status !== "CANCELLED") throw new Error("ABSENCE_MOVE_TARGET_TAKEN");

    // ④ 옛 결석의 보강권 되돌리기 — 보강이 예약돼 있으면(확인 없이) 막힌다 → «보강 예약을 먼저» 안내로 바꿔 던진다
    try {
      await settleCreditOnAbsenceCancel(tx, {
        actor: "PARENT", studentId, classId, absenceYmd: date, confirmBookingCancel: false,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "MAKEUP_BOOKING_CONFIRM_REQUIRED" || code === "MAKEUP_BOOKING_PAST") throw new Error("ABSENCE_MOVE_MAKEUP_BOOKED");
      throw error;
    }

    // ⑤ 새 날짜 신고 — 사유는 옛 신고 그대로. 덮어쓰는 것은 «취소됐던 줄» 뿐이다(③에서 확인)
    const reason = canceled[0].reason;
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
       RETURNING id, to_char("updatedAt", 'YYYYMMDDHH24MISSUS') AS "eventVersion"`,
      studentId, classId, toDate, reason, parentUserId,
    );
    if (!saved[0]) throw new Error("ABSENCE_MOVE_TARGET_TAKEN");

    // ⑥ 새 결석의 보강권(멱등 — 같은 키면 한 장)
    const credit = isMakeupCreditIssuableYmd(toDate)
      ? await issueCreditForReportedAbsence(tx, { studentId, classId, absenceYmd: toDate })
      : { issued: false };
    return { canceled: canceled[0], saved: saved[0], reason, makeupCreditIssued: credit.issued };
  });

  // 알림 — 기존 알림 두 통을 그대로 쓴다(취소 + 새 신고). 날짜마다 담당 기사님이 다를 수 있어 한 통으로 합치지 않는다.
  // 키는 결석 행 id + 그 행의 변경 시각이라, 같은 옮기기를 다시 눌러도(두 번째는 위에서 거절된다) 중복 발송되지 않는다.
  await notifyAdminsOfAbsenceChange({
    kind: "CANCELED",
    studentName: owned.studentName,
    className: owned.className,
    classId,
    studentId,
    date,
    recordId: outcome.canceled.id,
    eventVersion: outcome.canceled.eventVersion,
  });
  const notification = await notifyAdminsOfAbsenceChange({
    kind: "REPORTED",
    studentName: owned.studentName,
    className: owned.className,
    classId,
    studentId,
    date: toDate,
    reason: outcome.reason,
    recordId: outcome.saved.id,
    eventVersion: `${outcome.saved.eventVersion}-${createHash("sha256").update(String(outcome.reason)).digest("hex")}`,
  });

  return { ok: true, moved: true, from: date, to: toDate, reason: outcome.reason, notification, makeupCreditIssued: outcome.makeupCreditIssued };
}
