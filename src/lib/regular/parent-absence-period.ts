// 학부모 «여러 날 결석»(기간 결석) — 알리기·미리보기·복귀/취소·목록 (2026-11-15 원장 결정: 한도 4주·모든 사유)
//
// 원칙
//   · 날짜마다 «하루 알리기»와 같은 결과다. 저장은 같은 함수(saveReportedAbsenceInTx)를 날짜마다 부른다 —
//     질병·부상은 «이월 검토 중», 그 밖은 보강권 1장. 규칙을 둘로 만들지 않는다.
//   · 기간 행은 기존 표 RegularAbsencePeriod 를 쓴다(reportedByUserId 로 학부모 기간 표시). 결석 행은 학부모 행(REPORTED) 그대로라
//     셔틀·기사·출석부 화면은 하루 신고와 같은 경로로 반영된다(휴원이 아니므로 반 자리·셔틀 명단 자리는 유지).
//   · 전부 한 트랜잭션 — 어느 날짜에서든 실패하면 기간·결석·보강권이 통째로 되돌아간다.
//   · 원장·코치·기사 알림은 «기간당 1회»로 묶는다(날짜마다 보내지 않는다). 사유 글(건강 정보)은 싣지 않는다.
//   · 관리자 기간 결석(CONFIRMED·보강권 없음·자동 연장)은 건드리지 않는다.
import { childAccessSql } from "@/lib/account/child-access";
import { prisma } from "@/lib/prisma";
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import { addDaysKst, kstHm, todayKst } from "@/lib/datetime/kst";
import { settleCreditOnAbsenceCancel } from "@/lib/makeup/absence-report-credit";
import { notMergedStudent } from "@/lib/studentVisibility";
import { periodsOverlap } from "@/lib/regular/absence-period-plan";
import { absencePeriodContext, ABSENCE_PERIOD_TX_OPTIONS } from "@/lib/regular/absence-period-runner";
import { parentPeriodColumnsReady } from "@/lib/regular/absence-period-service";
import { closeIllnessReviewInTx, illnessReviewReady } from "@/lib/regular/illness-carry-tx";
import { ILLNESS_REASON, collapseReviewsByPeriod, isValidReasonText, normalizeReasonText } from "@/lib/regular/illnessCarryRules";
import {
  ILLNESS_INBOX_HREF, getParentIllnessReviews, getUpcomingRegularClassDates, listParentUsableClasses, saveReportedAbsenceInTx,
} from "@/lib/regular/parent-regular-absence";
import {
  PARENT_PERIOD_DAILY_LIMIT,
  PARENT_PERIOD_REMIND_DAYS_BEFORE,
  parentPeriodNote,
  periodDatesLabel,
  periodRangeLabel,
  periodSkippedNote,
  planParentPeriod,
  resolveParentPeriodRange,
  resolveParentPeriodReturn,
  type ParentPeriodItem,
  type ParentPeriodPlan,
  type ParentPeriodRange,
} from "@/lib/regular/parentAbsencePeriodRules";
import { REASON_LABEL, isAbsenceChangeOpen, isValidReason } from "@/lib/regular/regularAbsenceRules";

const kstNow = () => { const ms = Date.now(); return { ymd: todayKst(ms), hm: kstHm(ms) }; };

/** 기간 표와 학부모 기간 칸이 모두 있는가(마이그레이션 20261115100000 적용 여부). 없으면 화면이 «여러 날»을 숨긴다 */
export async function parentAbsencePeriodAvailable(): Promise<boolean> {
  try {
    const table = await prisma.$queryRawUnsafe<Array<{ found: string | null }>>(
      `SELECT to_regclass('public."RegularAbsencePeriod"')::text AS found`,
    );
    return Boolean(table[0]?.found) && await parentPeriodColumnsReady(prisma);
  } catch {
    return false;
  }
}

type PreparedPeriod = {
  studentId: string;
  studentName: string;
  range: ParentPeriodRange;
  plan: ParentPeriodPlan;
};

/**
 * 미리보기·알리기 공통 준비: 내 아이인지 확인 → 쓸 수 있는 반 → 기간 검사 → 그 사이 수업일 계산.
 * 화면이 보낸 값은 믿지 않는다 — 알릴 때도 이 함수를 다시 돌린다.
 */
async function prepareParentPeriod(parentUserId: string, input: { studentId?: string; startDate?: string; endDate?: string | null }): Promise<PreparedPeriod> {
  const studentId = String(input?.studentId ?? "").trim();
  if (!studentId) throw new Error("STUDENT_OR_CLASS_MISSING");
  // 내 아이의 «쓸 수 있는» 반만(다니는 반 + 복귀 승인된 휴원 반) — 하루 알리기와 같은 조회·같은 권한 조건
  const classes = (await listParentUsableClasses(parentUserId)).filter((row) => row.studentId === studentId);
  if (classes.length === 0) throw new Error("NOT_OWNER");

  const now = kstNow();
  const resolved = resolveParentPeriodRange({ startYmd: input?.startDate, endYmd: input?.endDate ?? "", todayYmd: now.ymd });
  if (!resolved.ok) throw new Error(resolved.code);
  const range = resolved.range;

  // 그 기간에 이미 살아 있는 결석(신고·확정) — 다시 알리지 않는다
  const existingRows = await prisma.$queryRawUnsafe<Array<{ classId: string; date: string }>>(
    `SELECT ra."classId" AS "classId", to_char(ra.date, 'YYYY-MM-DD') AS date
       FROM "RegularAbsence" ra
      WHERE ra."studentId" = $1 AND ra.date BETWEEN $2::date AND $3::date AND ra.status <> 'CANCELLED'`,
    studentId, range.startYmd, range.endYmd,
  );
  const ctx = await absencePeriodContext(parentUserId);
  const plan = planParentPeriod({
    classes: classes.map((row) => ({
      classId: row.classId, className: row.className, dayOfWeek: row.dayOfWeek, startTime: row.startTime,
      resumeFrom: row.enrollmentStatus === "PAUSED" ? row.resumeFrom : null,
    })),
    range,
    classDatesForMonth: ctx.classDatesForMonth,
    existing: new Set(existingRows.map((row) => `${row.classId}|${row.date}`)),
    now,
  });
  return { studentId, studentName: classes[0].studentName, range, plan };
}

export type ParentPeriodPreview = {
  startDate: string;
  endDate: string;
  openEnded: boolean;
  count: number;
  /** «11/17(월) · 11/19(수) · 11/24(월) 3회» */
  datesLabel: string;
  /** 자동으로 뺀 날 안내 한 줄(없으면 null) */
  skippedNote: string | null;
};

function toPreview(prepared: PreparedPeriod): ParentPeriodPreview {
  return {
    startDate: prepared.range.startYmd,
    endDate: prepared.range.endYmd,
    openEnded: prepared.range.openEnded,
    count: prepared.plan.items.length,
    datesLabel: periodDatesLabel(prepared.plan.items),
    skippedNote: periodSkippedNote(prepared.plan),
  };
}

// ── 1) 미리보기 ──
export async function previewParentAbsencePeriod(
  parentUserId: string, input: { studentId?: string; startDate?: string; endDate?: string | null },
): Promise<ParentPeriodPreview> {
  if (!(await parentAbsencePeriodAvailable())) throw new Error("PERIOD_NOT_READY");
  return toPreview(await prepareParentPeriod(parentUserId, input));
}

/** 원장·코치·기사 알림 — 기간당 1회. 실패해도 알리기·취소 자체는 되돌리지 않는다 */
async function notifyStaffOfPeriod(input: {
  kind: "REPORTED" | "CANCELED";
  periodId: string;
  studentId: string;
  studentName: string;
  reason: string | null;
  items: Array<Pick<ParentPeriodItem, "classId" | "date" | "label">>;
  version: string;
}) {
  if (input.items.length === 0) return null;
  try {
    const { notifyOperationalStaff } = await import("@/lib/operational-staff-notification");
    const first = input.items[0].date;
    const last = input.items[input.items.length - 1].date;
    const dates = `${periodRangeLabel(first, last)} ${input.items.length}회`;
    // 사유는 «분류»만(질병/부상 등) — 학부모가 적은 사유 글은 싣지 않는다(건강 정보)
    const reasonLabel = input.reason ? REASON_LABEL[input.reason as keyof typeof REASON_LABEL] : null;
    return await notifyOperationalStaff({
      stableEventKey: `regular-absence-period:${input.periodId}:${input.kind}:${input.version}`,
      eventType: `REGULAR_ABSENCE_${input.kind}`,
      studentId: input.studentId,
      type: "ABSENCE",
      title: input.kind === "REPORTED" ? "결석 사전 신고(여러 날)" : "결석 신고 취소(여러 날)",
      message: input.kind === "REPORTED"
        ? `${input.studentName} 학생이 ${dates} 결석 예정입니다.${reasonLabel ? ` (${reasonLabel})` : ""}`
        : `${input.studentName} 학생의 ${dates} 결석 신고가 취소되었습니다.`,
      linkUrl: input.kind === "REPORTED" && input.reason === ILLNESS_REASON ? ILLNESS_INBOX_HREF : "/admin/absence",
      staffLinkUrl: "/staff",
      classIds: Array.from(new Set(input.items.map((item) => item.classId))),
      includeCoach: true,
      includeDriver: true,
      // 기사님은 기간의 첫 결석일 담당 기준으로 한 번만 알린다(날짜마다 보내지 않는다 — 명단에는 날짜마다 자동으로 «결석»이 뜬다)
      driverContext: { studentId: input.studentId, serviceDate: first },
    });
  } catch (error) {
    console.error("[parent-absence-period] 운영 알림 실패:", error instanceof Error ? error.name : "");
    return null;
  }
}

// ── 2) 알리기 ──
export async function createParentAbsencePeriod(
  parentUserId: string,
  input: { studentId?: string; startDate?: string; endDate?: string | null; reason?: string; reasonText?: string | null },
) {
  if (!(await parentAbsencePeriodAvailable())) throw new Error("PERIOD_NOT_READY");
  const reason = input?.reason;
  if (!isValidReason(reason)) throw new Error("INVALID_REASON");
  const reasonText = normalizeReasonText(input?.reasonText);
  // 질병·부상: 사유 글 필수(하루 알리기와 같은 규칙)
  if (reason === ILLNESS_REASON && !isValidReasonText(reasonText)) throw new Error("ILLNESS_REASON_TEXT_REQUIRED");

  const prepared = await prepareParentPeriod(parentUserId, input);
  const { studentId, range, plan } = prepared;
  if (plan.items.length === 0) throw new Error("PERIOD_NO_DATES");

  const outcome = await prisma.$transaction(async (tx) => {
    // 잠금 순서는 하루 신고·관리자 기간 결석과 같다(작업대 잠금 → 기간·결석 행)
    await lockCompensation(tx);

    // 같은 아이의 살아 있는 기간(학부모·관리자 모두)과 날짜가 겹치면 받지 않는다 — 기간 = [시작일, 끝일 다음 날)
    const mine = { startDate: range.startYmd, returnDate: addDaysKst(range.endYmd, 1) };
    // 살아 있는 결석이 하나도 없는 학부모 기간(전부 취소됨)은 겹침으로 보지 않는다. 겹친 상대가 학원이 등록한 기간이면 문구가 다르다
    const others = (await tx.$queryRawUnsafe<Array<{ startDate: string; returnDate: string | null; parentReported: boolean; live: number }>>(
      `SELECT to_char(p."startDate",'YYYY-MM-DD') AS "startDate", to_char(p."returnDate",'YYYY-MM-DD') AS "returnDate",
              (p."reportedByUserId" IS NOT NULL) AS "parentReported",
              (SELECT COUNT(*)::int FROM "RegularAbsence" ra WHERE ra."periodId" = p.id AND ra.status <> 'CANCELLED') AS live
         FROM "RegularAbsencePeriod" p WHERE p."studentId" = $1 AND p.status IN ('ACTIVE','ENDED')`,
      studentId,
    )).filter((other) => !(other.parentReported && Number(other.live) === 0));
    const clash = others.find((other) => periodsOverlap(mine, other));
    if (clash) throw new Error(clash.parentReported ? "PERIOD_OVERLAP" : "PERIOD_OVERLAP_ADMIN");

    // 만들기·취소 반복 제한(보안 검수 2026-11-15): 아이당 하루(KST)에 학부모 기간 5개까지 — 취소한 것도 센다.
    // createdAt 은 timestamptz 라 변환은 한 번, 오늘도 DB 시계의 KST 날짜.
    const today = await tx.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM "RegularAbsencePeriod"
        WHERE "studentId" = $1 AND "reportedByUserId" IS NOT NULL
          AND ("createdAt" AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
      studentId,
    );
    if (Number(today[0]?.n ?? 0) >= PARENT_PERIOD_DAILY_LIMIT) throw new Error("PERIOD_DAILY_LIMIT");

    const created = await tx.$queryRawUnsafe<Array<{ id: string; version: string }>>(
      `INSERT INTO "RegularAbsencePeriod"
         ("studentId", reason, "startDate", "returnDate", status, "coveredUntil", "classIds", "createdByUserId", "reportedByUserId", "openEnded")
       VALUES ($1, $2, $3::date, $4::date, 'ACTIVE', $5::date, ARRAY[]::text[], $6, $6, $7)
       RETURNING id, to_char("createdAt", 'YYYYMMDDHH24MISSUS') AS version`,
      studentId, reason, range.startYmd, mine.returnDate, range.endYmd, parentUserId, range.openEnded,
    );
    const periodId = created[0].id;
    const note = parentPeriodNote(range.startYmd, range.endYmd);

    const saved: Array<ParentPeriodItem & { absenceId: string }> = [];
    let makeupCredits = 0;
    let carryPending = false;
    for (const item of plan.items) {
      let result: Awaited<ReturnType<typeof saveReportedAbsenceInTx>>;
      try {
        // 날짜마다 «하루 알리기»와 같은 저장 — 보강권/이월 검토 분기도 그 함수가 한다
        result = await saveReportedAbsenceInTx(tx, {
          studentId, classId: item.classId, date: item.date, reason, reasonText, source: "PARENT", parentUserId,
        });
      } catch (error) {
        // 계산과 저장 사이에 학원이 그 날을 확정했다 — 그 날만 건너뛴다(나머지 날짜는 계속)
        if (error instanceof Error && error.message === "ABSENCE_NOT_CANCELABLE") continue;
        throw error;
      }
      if (!result.saved || !result.absenceId) continue;
      // 이 기간의 결석으로 묶는다. note 머리말은 알림 재조정이 날짜마다 다시 알리지 않게 거르는 표시
      await tx.$executeRawUnsafe(
        `UPDATE "RegularAbsence" SET "periodId" = $2, note = $3 WHERE id = $1`, result.absenceId, periodId, note,
      );
      saved.push({ ...item, absenceId: result.absenceId });
      if (result.makeupCreditIssued) makeupCredits += 1;
      if (result.carryReview === "PENDING") carryPending = true;
    }
    if (saved.length === 0) throw new Error("PERIOD_NO_DATES");
    return { periodId, version: created[0].version, saved, makeupCredits, carryPending };
  }, ABSENCE_PERIOD_TX_OPTIONS);

  const notification = await notifyStaffOfPeriod({
    kind: "REPORTED", periodId: outcome.periodId, studentId, studentName: prepared.studentName, reason,
    items: outcome.saved, version: outcome.version,
  });

  return {
    ok: true,
    periodId: outcome.periodId,
    notification,
    count: outcome.saved.length,
    datesLabel: periodDatesLabel(outcome.saved),
    makeupCredits: outcome.makeupCredits,
    /** 질병·부상 — 화면이 이어서 증빙 사진을 올린다(기간의 첫 결석에 붙이면 기간 전체에 쓰인다) */
    carryPending: outcome.carryPending,
    evidenceAbsenceId: outcome.carryPending ? outcome.saved[0].absenceId : null,
  };
}

// ── 3) 복귀했어요 / 알림 취소 ──
/**
 * 복귀일(다시 나오는 날)부터의 결석을 취소한다. «알림 취소»는 복귀일 = 오늘로 부른다(아직 안 지난 날짜만 취소).
 * 날짜마다 «하루 취소»와 같은 정리(보강권 되돌리기·이월 검토 닫기)를 한다.
 *   · 지난 날짜·마감(수업 1시간 전) 지난 오늘 수업·학원이 확정한 날은 그대로 둔다
 *   · 그 결석의 보강이 이미 예약·사용됐으면 그 날만 건너뛴다(개수로 알린다) — 하루 취소 화면에서 확인하고 취소
 */
export async function closeParentAbsencePeriod(parentUserId: string, input: { periodId?: string; returnDate?: string }) {
  if (!(await parentAbsencePeriodAvailable())) throw new Error("PERIOD_NOT_READY");
  const periodId = String(input?.periodId ?? "").trim();
  if (!periodId) throw new Error("PERIOD_NOT_FOUND");
  const access = await childAccessSql("s", "$1");

  const outcome = await prisma.$transaction(async (tx) => {
    await lockCompensation(tx);
    // 내 아이의 «학부모가 알린» 기간만(관리자 기간·남의 아이는 0행)
    const periods = await tx.$queryRawUnsafe<Array<{ id: string; studentId: string; studentName: string; startDate: string; returnDate: string; status: string }>>(
      `SELECT p.id, p."studentId" AS "studentId", s.name AS "studentName",
              to_char(p."startDate",'YYYY-MM-DD') AS "startDate", to_char(p."returnDate",'YYYY-MM-DD') AS "returnDate", p.status
         FROM "RegularAbsencePeriod" p
         JOIN "Student" s ON s.id = p."studentId"
        WHERE ${access} AND ${notMergedStudent("s")}
          AND p.id = $2 AND p."reportedByUserId" IS NOT NULL
        FOR UPDATE OF p`,
      parentUserId, periodId,
    );
    const period = periods[0];
    if (!period) throw new Error("PERIOD_NOT_FOUND");
    if (period.status !== "ACTIVE") throw new Error("PERIOD_ALREADY_CLOSED");

    const now = kstNow();
    const endYmd = addDaysKst(period.returnDate, -1);
    const resolved = resolveParentPeriodReturn({ startYmd: period.startDate, endYmd, returnYmd: input?.returnDate, todayYmd: now.ymd });
    if (!resolved.ok) throw new Error(resolved.code);

    // 이 기간의 아직 «신고» 상태인 결석 중 복귀일 이후 것(학원이 확정한 날은 학부모가 못 바꾼다 — 하루 취소와 같은 조건)
    const rows = await tx.$queryRawUnsafe<Array<{ id: string; classId: string; date: string; startTime: string | null }>>(
      `SELECT ra.id, ra."classId" AS "classId", to_char(ra.date,'YYYY-MM-DD') AS date, c."startTime" AS "startTime"
         FROM "RegularAbsence" ra
         JOIN "Class" c ON c.id = ra."classId"
        WHERE ra."periodId" = $1 AND ra."studentId" = $2 AND ra.date >= $3::date AND ra.status = 'REPORTED'
        ORDER BY ra.date, ra."classId"
        FOR UPDATE OF ra`,
      periodId, period.studentId, resolved.fromYmd,
    );
    const reviewReady = await illnessReviewReady(tx);
    const canceled: Array<{ classId: string; date: string; label: string }> = [];
    let closedByDeadline = 0;
    let makeupKept = 0;
    for (const row of rows) {
      // 마감(수업 1시간 전)이 지난 오늘 수업은 취소하지 않는다
      if (!isAbsenceChangeOpen(row.date, row.startTime, now.ymd, now.hm)) { closedByDeadline += 1; continue; }
      try {
        // 보강권 되돌리기 — 보강이 예약·사용됐으면 오류 코드를 던진다(쓰기 전에 던지므로 이 날만 건너뛰면 된다)
        await settleCreditOnAbsenceCancel(tx, {
          actor: "PARENT", studentId: period.studentId, classId: row.classId, absenceYmd: row.date, confirmBookingCancel: false,
        });
      } catch (error) {
        const code = error instanceof Error ? error.message : "";
        if (code === "MAKEUP_BOOKING_CONFIRM_REQUIRED" || code === "MAKEUP_ALREADY_USED" || code === "MAKEUP_BOOKING_PAST") { makeupKept += 1; continue; }
        throw error;
      }
      const n = await tx.$executeRawUnsafe(
        `UPDATE "RegularAbsence" SET status = 'CANCELLED', "updatedAt" = NOW() WHERE id = $1 AND status = 'REPORTED'`, row.id,
      );
      if (Number(n) === 0) continue;
      if (reviewReady) await closeIllnessReviewInTx(tx, row.id, { canceled: true });
      canceled.push({ classId: row.classId, date: row.date, label: row.date });
    }

    // 지난 결석이 남으면 «복귀 처리»(ENDED·복귀일 저장), 시작 전에 접었으면 «취소»(CANCELLED)
    const updated = await tx.$queryRawUnsafe<Array<{ version: string }>>(
      resolved.outcome === "ENDED"
        ? `UPDATE "RegularAbsencePeriod"
              SET status = 'ENDED', "returnDate" = $2::date, "endedByUserId" = $3,
                  "coveredUntil" = LEAST("coveredUntil", $2::date - 1), "updatedAt" = now()
            WHERE id = $1 RETURNING to_char("updatedAt", 'YYYYMMDDHH24MISSUS') AS version`
        : `UPDATE "RegularAbsencePeriod"
              SET status = 'CANCELLED', "endedByUserId" = $3, "updatedAt" = now()
            WHERE id = $1 AND $2::date IS NOT NULL RETURNING to_char("updatedAt", 'YYYYMMDDHH24MISSUS') AS version`,
      periodId, resolved.fromYmd, parentUserId,
    );
    return { period, canceled, closedByDeadline, makeupKept, outcome: resolved.outcome, version: updated[0]?.version ?? "" };
  }, ABSENCE_PERIOD_TX_OPTIONS);

  const notification = await notifyStaffOfPeriod({
    kind: "CANCELED", periodId, studentId: outcome.period.studentId, studentName: outcome.period.studentName, reason: null,
    items: outcome.canceled, version: outcome.version,
  });
  return {
    ok: true,
    notification,
    outcome: outcome.outcome,
    canceledCount: outcome.canceled.length,
    /** 마감이 지나 그대로 둔 오늘 수업 수 */
    closedByDeadline: outcome.closedByDeadline,
    /** 보강이 예약·사용돼 그대로 둔 날 수 */
    makeupKept: outcome.makeupKept,
  };
}

// ── 끝일 «아직 몰라요» 기간: 끝나기 전에 «연장/복귀» 앱 알림 1회 ──
/**
 * 매일 cron(/api/cron/absence-periods)이 부른다. 끝나기 3일 전부터 마지막 날 사이인 «아직 몰라요» 기간을 찾아
 * «보냈다» 표시(reminderSentAt)를 먼저 찍고(UPDATE … WHERE reminderSentAt IS NULL — 두 번 돌아도 한 번만) 대상을 돌려준다.
 * 알림 발송은 호출부가 한다(앱 안 알림 함수만 — 문자·알림톡 없음). 날짜 판정은 DB 시계의 KST 날짜.
 */
export async function claimOpenEndedPeriodReminders(): Promise<Array<{ periodId: string; studentId: string; studentName: string; endDate: string }>> {
  if (!(await parentAbsencePeriodAvailable())) return [];
  const rows = await prisma.$queryRawUnsafe<Array<{ periodId: string; studentId: string; studentName: string; returnDate: string }>>(
    `UPDATE "RegularAbsencePeriod" p
        SET "reminderSentAt" = now(), "updatedAt" = now()
       FROM "Student" s
      WHERE s.id = p."studentId" AND ${notMergedStudent("s")}
        AND p."reportedByUserId" IS NOT NULL AND p."openEnded" = true AND p.status = 'ACTIVE' AND p."reminderSentAt" IS NULL
        -- 마지막으로 쉬는 날 = 복귀일 전날. 오늘 ≤ 마지막 날 ≤ 오늘+3일 (PARENT_PERIOD_REMIND_DAYS_BEFORE)
        AND p."returnDate" - 1 >= (now() AT TIME ZONE 'Asia/Seoul')::date
        AND p."returnDate" - 1 <= (now() AT TIME ZONE 'Asia/Seoul')::date + ${PARENT_PERIOD_REMIND_DAYS_BEFORE}
      RETURNING p.id AS "periodId", p."studentId" AS "studentId", s.name AS "studentName", to_char(p."returnDate",'YYYY-MM-DD') AS "returnDate"`,
  );
  return rows.map((row) => ({ periodId: row.periodId, studentId: row.studentId, studentName: row.studentName, endDate: addDaysKst(row.returnDate, -1) }));
}

// ── 결석 알리기 화면이 쓰는 데이터 한 묶음(페이지·API 가 같은 함수를 쓴다) ──
export async function loadParentAbsenceScreen(parentUserId: string) {
  // 이월 검토(날짜별)는 수업일 줄의 상태 글자에도 쓰여 먼저 읽는다. 화면의 «질병·부상 결석» 칸에는 기간을 한 줄로 묶어 보낸다
  const reviewRows = await getParentIllnessReviews(parentUserId);
  const [children, periods, periodAvailable] = await Promise.all([
    getUpcomingRegularClassDates(parentUserId, undefined, reviewRows),
    listParentAbsencePeriods(parentUserId),
    parentAbsencePeriodAvailable(),
  ]);
  return { children, reviews: collapseReviewsByPeriod(reviewRows), periods, periodAvailable };
}

// ── 4) 내가 알린 기간(진행 중) ──
export type ParentAbsencePeriodRow = {
  id: string;
  studentId: string;
  studentName: string;
  reasonLabel: string;
  startDate: string;
  /** 마지막으로 쉬는 날 */
  endDate: string;
  openEnded: boolean;
  /** «11/17(월)~11/28(금)» */
  rangeLabel: string;
  /** 살아 있는 결석 수(취소된 날 제외) */
  count: number;
};

/** 내 아이들의 진행 중인 «여러 날 결석»(끝일이 오늘 이후). 표·칸이 없거나 조회가 실패하면 빈 목록 — 결석 화면은 떠야 한다 */
export async function listParentAbsencePeriods(parentUserId: string): Promise<ParentAbsencePeriodRow[]> {
  try {
    if (!(await parentAbsencePeriodAvailable())) return [];
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: string; studentId: string; studentName: string; reason: string; startDate: string; returnDate: string; openEnded: boolean; count: number;
    }>>(
      `SELECT p.id, p."studentId" AS "studentId", s.name AS "studentName", p.reason,
              to_char(p."startDate",'YYYY-MM-DD') AS "startDate", to_char(p."returnDate",'YYYY-MM-DD') AS "returnDate",
              p."openEnded" AS "openEnded",
              (SELECT COUNT(*)::int FROM "RegularAbsence" ra WHERE ra."periodId" = p.id AND ra.status <> 'CANCELLED') AS count
         FROM "RegularAbsencePeriod" p
         JOIN "Student" s ON s.id = p."studentId"
        WHERE ${await childAccessSql("s", "$1")} AND ${notMergedStudent("s")}
          AND p."reportedByUserId" IS NOT NULL AND p.status = 'ACTIVE'
          -- 복귀일(끝일 다음 날)이 오늘보다 뒤 = 아직 끝나지 않은 기간. 오늘은 DB 시계의 KST 날짜
          AND p."returnDate" > (now() AT TIME ZONE 'Asia/Seoul')::date
        ORDER BY p."startDate", s.name
        LIMIT 20`,
      parentUserId,
    );
    return rows.map((row) => {
      const endDate = addDaysKst(row.returnDate, -1);
      return {
        id: row.id,
        studentId: row.studentId,
        studentName: row.studentName,
        reasonLabel: REASON_LABEL[row.reason as keyof typeof REASON_LABEL] ?? row.reason,
        startDate: row.startDate,
        endDate,
        openEnded: row.openEnded === true,
        rangeLabel: periodRangeLabel(row.startDate, endDate),
        count: Number(row.count) || 0,
      };
    });
  } catch (error) {
    console.error("[parent-absence-period] 기간 목록 조회 실패(화면은 계속):", error instanceof Error ? error.name : "");
    return [];
  }
}
