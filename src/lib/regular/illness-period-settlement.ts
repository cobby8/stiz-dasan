// 부상·질병 «기간 결석» 복귀 정산 — DB 연결부: 미리보기 · 이월 확정 · 확정 취소 · 학부모 미리보기 (3단계, 2026-11-15 원장 결정)
//
// 계산은 순수 모듈(illnessPeriodSettlementPlan.ts) 한 곳에서 한다. 이 파일은 재료를 읽어 넘기고, 확정 때 그 결과대로 적는다.
// 원장 미리보기 · 학부모 «복귀했어요» 미리보기 · 확정이 «같은 읽기 함수 + 같은 계산 함수»를 지난다(식이 둘로 갈리지 않게).
//
// 확정이 하는 일(하루짜리 이월 승인이 하는 일을 기간의 날짜 수만큼 한 거래에서):
//   낸 돈이 있는 달의 빠진 날마다 → 결석 확정(REPORTED→CONFIRMED) · 이월 1행(BillingCarryCredit, 쓸 수 있는 달 = 복귀일이 속한 달)
//     · 정산 기록(BillingAbsenceResolution) · 검토 승인 · 미사용 보강권 회수
//   낸 돈이 없는 달의 빠진 날마다 → 이월 없이 정산 기록만(이중 보상 방지) + 기간 행에 «다닌 만큼만 청구» 안내(unpaidGuides)
//   기간 상태 APPROVED → SETTLED (발행 보류가 풀린다. 청구 발행은 원장이 청구 준비에서 직접 — 자동 발행하지 않는다)
//
// 잠금 순서(기존 정산과 같게 — 교착 금지): 작업대 전역 잠금 → 기간 행 → 학생 행 → 결석 행 → 근거 행(FOR SHARE).
// 격리 수준은 DB 기본(READ COMMITTED) — 잠근 «뒤에» 다시 읽는 납부 상태·결석이 실제 최신이어야 한다(2단계 교훈:
// Serializable 은 첫 문장 시점 사진으로 읽어, 잠금을 기다리는 동안 커밋된 환불·결석 취소가 보이지 않는다).
// 이중 적립은 DB 가 막는다(BillingCarryCredit.absenceId UNIQUE · BillingAbsenceResolution PK) + 상태 전이는 조건부 UPDATE.
//
// DB 는 인자(db)로만 받는다 — 테스트가 실제 PostgreSQL 로 실행한다. 이 파일은 prisma 를 import 하지 않는다.
import { lockCompensation } from "@/lib/billing/absence-compensation-guard";
import type { MonthEvidence } from "@/lib/billing/carryEvidence";
import { billingMonthOfDate, type WorkbenchCalendarSnapshot } from "@/lib/billing/workbench";
import {
  CARRY_NO_EVIDENCE_MESSAGE, CARRY_UNPAID_MESSAGE, insertCarryCreditInTx, readClassMonthEvidenceInTx, type ResolvedCarryEvidence,
} from "@/lib/billing/workbench-absence";
import { addDaysKst, isKstYmd } from "@/lib/datetime/kst";
import { notMergedStudent } from "@/lib/studentVisibility";
import { endAbsencePeriodInTx, periodCarryColumnsReady, type PeriodContext } from "@/lib/regular/absence-period-service";
import { illnessReviewReady, type IllnessTx } from "@/lib/regular/illness-carry-tx";
import { ILLNESS_REASON } from "@/lib/regular/illnessCarryRules";
import { readIllnessPeriodBillingHold } from "@/lib/regular/illness-period-admin";
import { IllnessPeriodError, illnessPeriodAbsenceSql, parsePeriodApprovalRecord, parseSettlementSummary, parseUnpaidGuides } from "@/lib/regular/illnessPeriodRules";
import { parentReturnDateMax } from "@/lib/regular/parentAbsencePeriodRules";
import {
  parentSettlementView, planIllnessPeriodSettlement, settlementFingerprint,
  type ParentSettlementView, type PeriodAbsenceInput, type SettlementPlan,
} from "@/lib/regular/illnessPeriodSettlementPlan";

export type SettlementDb = IllnessTx & {
  $transaction<T>(work: (tx: IllnessTx) => Promise<T>, options?: { isolationLevel?: "Serializable" | "RepeatableRead"; timeout?: number }): Promise<T>;
};

/**
 * 오늘·수업일 계산 재료. calendar 는 청구 준비와 «같은» 공식 일정 사본이다 —
 * 이월의 수업 횟수(분모)가 청구 준비가 다시 세는 값과 달라지면 그 이월이 무효로 잡힌다.
 * classDatesForMonth 는 그 calendar 로 만든 함수여야 한다(호출부가 같은 일정으로 만든다).
 */
export type SettlementContext = PeriodContext & { calendar?: WorkbenchCalendarSnapshot };

// 격리 수준을 지정하지 않는다(DB 기본 READ COMMITTED). ⚠️ Serializable/RepeatableRead 를 걸지 말 것(테스트가 고정)
export const SETTLE_TX_OPTIONS = { timeout: 60_000 };
export const READ_TX_OPTIONS = { timeout: 30_000 };

export type PeriodRow = {
  id: string; studentId: string; reason: string; status: string; carryState: string;
  startDate: string; returnDate: string | null; coveredUntil: string | null; parentReported: boolean;
  carrySettlement: unknown;
};

// date 칼럼은 달력 값이라 시간대 변환이 없다
export const PERIOD_SELECT = `SELECT p.id, p."studentId" AS "studentId", p.reason, p.status, p."carryState" AS "carryState",
       to_char(p."startDate", 'YYYY-MM-DD') AS "startDate", to_char(p."returnDate", 'YYYY-MM-DD') AS "returnDate",
       to_char(p."coveredUntil", 'YYYY-MM-DD') AS "coveredUntil",
       (p."reportedByUserId" IS NOT NULL) AS "parentReported", p."carrySettlement" AS "carrySettlement"
  FROM "RegularAbsencePeriod" p`;

export function cleanId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.length > 200) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
  return id;
}
export function cleanIds(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200))].sort()
    : [];
}
export async function tableExists(tx: IllnessTx, name: string): Promise<boolean> {
  const rows = await tx.$queryRawUnsafe<Array<{ found: string | null }>>(`SELECT to_regclass($1)::text AS found`, `public."${name}"`);
  return Boolean(rows[0]?.found);
}
const isWorkbenchError = (error: unknown): error is Error => error instanceof Error && error.name === "WorkbenchError";

/** 여러 상태 글자(쉼표로 이은 것)에서 정산이 보는 «가장 진행된» 하나를 고른다 */
function pick(statuses: string | null, order: readonly string[]): string | null {
  const have = new Set((statuses ?? "").split(",").filter(Boolean));
  return order.find((status) => have.has(status)) ?? null;
}

type AbsenceRow = PeriodAbsenceInput & { dayOfWeek: string; month: string };

/**
 * 결석일이 속한 «수강월»을 연간 일정으로 정한다 — 청구(Payment.year/month)·이월 근거의 달이다.
 * 달력 월과 다를 수 있다(예: 12월 1주차가 11/30 에 시작하면 11/30 결석은 12월 수강월). 그래서 달력 월 → 다음 달 → 이전 달 순으로
 * «그 달 그 요일 수업일에 이 날이 있는가»를 본다. 어느 달에도 없으면(휴무일 등) 달력 월로 두고, 계산이 «수업일 아님»으로 뺀다.
 */
function billingMonthResolver(ctx: SettlementContext): (date: string, dayOfWeek: string) => string {
  const memo = new Map<string, string[]>();
  const datesOf = (month: string, dayOfWeek: string) => {
    const key = `${month}|${dayOfWeek}`;
    let dates = memo.get(key);
    if (!dates) { dates = ctx.classDatesForMonth(month, dayOfWeek); memo.set(key, dates); }
    return dates;
  };
  // 달력 월 → 다음 달 → 이전 달 순으로 찾는 규칙은 하루짜리 이월과 같은 함수 한 곳(workbench.billingMonthOfDate)
  return (date, dayOfWeek) => billingMonthOfDate(date, (month) => datesOf(month, dayOfWeek));
}

/** 그 기간에 묶인 살아 있는 질병·부상 결석과, 날짜마다의 출결·보강·정산 상태. lock=true 면 결석 행을 잠근다(확정) */
async function readPeriodAbsences(tx: IllnessTx, period: PeriodRow, lock: boolean, ctx: SettlementContext): Promise<AbsenceRow[]> {
  const billingMonth = billingMonthResolver(ctx);
  const sessionsReady = await tableExists(tx, "MakeupSession");
  const resolutionReady = await tableExists(tx, "BillingAbsenceResolution");
  const pauseReady = await tableExists(tx, "EnrollmentChangeSettlementLine");
  if (lock) {
    // 확정: 결석 행 → 그 결석들의 보강권 행 순서로 먼저 잠근다. 아래 조회가 읽는 보강권 상태(예약·사용)가 판정 뒤에 바뀌지 않게
    // (READ COMMITTED 라 잠근 뒤의 조회는 최신 상태를 본다). 보강 예약·사용 쪽도 같은 전역 잠금 뒤에서 이 행들을 건드린다.
    await tx.$queryRawUnsafe(
      `SELECT ra.id FROM "RegularAbsencePeriod" p JOIN "RegularAbsence" ra ON ${illnessPeriodAbsenceSql("p", "ra")}
        WHERE p.id = $1 ORDER BY ra.date, ra.id FOR UPDATE OF ra`, period.id);
    await tx.$queryRawUnsafe(
      `SELECT mc.id FROM "RegularAbsencePeriod" p
         JOIN "RegularAbsence" ra ON ${illnessPeriodAbsenceSql("p", "ra")}
         JOIN "MakeupCredit" mc ON mc."studentId" = ra."studentId"
          AND mc."sourceKey" = 'REGULAR:' || ra."classId" || ':' || to_char(ra.date, 'YYYY-MM-DD')
        WHERE p.id = $1 ORDER BY mc.id FOR UPDATE OF mc`, period.id);
  }
  const rows = await tx.$queryRawUnsafe<Array<{
    id: string; classId: string; className: string | null; dayOfWeek: string | null; date: string; status: string;
    attendance: string | null; credits: string | null; bookings: string | null; resolved: string | null;
  }>>(
    // 출결: Session.date 는 KST 달력 자정을 담은 값 — 청구 준비(readWorkbench)와 같은 비교(se.date::date)
    // 보강 예약: originalDate 는 시각 값이라 KST 로 한 번 바꿔 날짜를 견준다(기존 makeupInUseSql 과 같은 식)
    `SELECT ra.id, ra."classId" AS "classId", c.name AS "className", c."dayOfWeek" AS "dayOfWeek",
            to_char(ra.date, 'YYYY-MM-DD') AS date, ra.status,
            (SELECT string_agg(DISTINCT t.status, ',') FROM "Attendance" t JOIN "Session" se ON se.id = t."sessionId"
              WHERE t."studentId" = ra."studentId" AND se."classId" = ra."classId" AND se.date::date = ra.date::date) AS attendance,
            (SELECT string_agg(DISTINCT mc.status, ',') FROM "MakeupCredit" mc
              WHERE mc."studentId" = ra."studentId"
                AND mc."sourceKey" = 'REGULAR:' || ra."classId" || ':' || to_char(ra.date, 'YYYY-MM-DD')) AS credits,
            ${sessionsReady
              ? `(SELECT string_agg(DISTINCT ms.status, ',') FROM "MakeupSession" ms
                   WHERE ms."studentId" = ra."studentId" AND ms."originalClassId" = ra."classId"
                     AND to_char(ms."originalDate" AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD') = to_char(ra.date, 'YYYY-MM-DD')
                     AND ms.status <> 'CANCELLED')`
              : "NULL::text"} AS bookings,
            ${resolutionReady ? `(SELECT settled.resolution FROM "BillingAbsenceResolution" settled WHERE settled."absenceId" = ra.id)` : "NULL::text"} AS resolved
       FROM "RegularAbsencePeriod" p
       JOIN "RegularAbsence" ra ON ${illnessPeriodAbsenceSql("p", "ra")}
       LEFT JOIN "Class" c ON c.id = ra."classId"
      WHERE p.id = $1
      ORDER BY ra.date, ra.id${lock ? " FOR UPDATE OF ra" : ""}`,
    period.id,
  );
  // 휴원 정산이 이미 처리한 날(또는 휴원 기간 중인 날) — 하루짜리 이월과 같은 조건(취소된 휴원 신청 제외, missedDates 포함 검사)
  const paused = new Set<string>();
  if (pauseReady && rows.length > 0) {
    const settled = await tx.$queryRawUnsafe<Array<{ absenceId: string }>>(
      `SELECT DISTINCT ra.id AS "absenceId"
         FROM "RegularAbsence" ra
         JOIN "EnrollmentChangeRequest" r ON r."studentId" = ra."studentId" AND r."fromClassId" = ra."classId" AND r.status <> 'CANCELED'
         JOIN "EnrollmentChangeSettlement" s ON s."requestId" = r.id AND s."studentId" = ra."studentId"
         JOIN "EnrollmentChangeSettlementLine" l ON l."settlementId" = s.id AND l."missedDates" @> to_jsonb(to_char(ra.date, 'YYYY-MM-DD'))
        WHERE ra.id = ANY($1::text[])`,
      rows.map((row) => row.id),
    );
    for (const row of settled) paused.add(row.absenceId);
  }
  return rows.map((row) => ({
    absenceId: row.id, classId: row.classId, className: row.className?.trim() || "반 정보 없음", dayOfWeek: row.dayOfWeek ?? "",
    date: row.date, status: row.status, month: billingMonth(row.date, row.dayOfWeek ?? ""),
    attendance: pick(row.attendance, ["PRESENT", "LATE", "ABSENT"]) as PeriodAbsenceInput["attendance"],
    creditStatus: pick(row.credits, ["USED", "NO_SHOW", "RESERVED", "AVAILABLE", "EXPIRED", "REVOKED"]),
    bookingStatus: pick(row.bookings, ["ATTENDED", "NO_SHOW", "BOOKED"]),
    alreadyResolved: row.resolved === "CARRY" || row.resolved === "MAKEUP" ? row.resolved : null,
    pauseSettled: paused.has(row.id),
  }));
}

type PlanRead = {
  plan: SettlementPlan; fingerprint: string; absences: AbsenceRow[];
  /** 낸 돈이 있는 달의 근거(키 `${classId}|${month}`) — 확정이 그대로 적립에 쓴다 */
  resolved: Map<string, ResolvedCarryEvidence>;
};

/**
 * 재료를 읽어 정산 표를 만든다 — 미리보기(lock=false)와 확정(lock=true)이 같은 함수다(퇴원 정산도 이 함수를 쓴다).
 * 반·달마다 근거를 «하루짜리 이월과 같은 함수»(readClassMonthEvidenceInTx)로 읽는다:
 *   근거 있음 → 이월 대상 / «청구 없음·아직 안 냄» → 낸 돈이 없는 달 / 그 밖의 사유 → 근거를 정할 수 없음(확정 차단)
 */
export async function readSettlementPlan(
  tx: IllnessTx, period: PeriodRow, returnDate: string | null, omitAbsenceIds: readonly string[], ctx: SettlementContext, lock: boolean,
): Promise<PlanRead> {
  const absences = await readPeriodAbsences(tx, period, lock, ctx);
  // 복귀일 이후 결석은 표에 오르지 않으므로 근거도 읽지 않는다
  const counted = absences.filter((absence) => !returnDate || absence.date < returnDate);
  // 근거는 반·«수강월»마다 한 번 읽는다
  const keys = [...new Set(counted.map((absence) => `${absence.classId}|${absence.month}`))].sort();
  const pauseReady = await tableExists(tx, "EnrollmentChangeSettlementLine");
  const evidence = new Map<string, MonthEvidence>();
  const resolved = new Map<string, ResolvedCarryEvidence>();
  const startsOnByClass = new Map<string, string | null>();
  for (const key of keys) {
    const [classId, month] = key.split("|");
    try {
      const found = await readClassMonthEvidenceInTx(tx, { studentId: period.studentId, classId, originMonth: month, calendar: ctx.calendar }, lock, pauseReady);
      if (found.source === "MONTHLY_REGISTER") {
        // 확정 월 장부만으로는 «낸 돈»인지 알 수 없다 — 그 반·그 달의 납부완료 수강료 청구가 확인될 때만 이월 근거로 삼는다(납부된 것만 규칙)
        const [registerYear, registerMonth] = month.split("-").map(Number);
        const paidForRegister = await tx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT p.id FROM "Payment" p WHERE p."studentId" = $1 AND p."classId" = $2 AND p.year = $3 AND p.month = $4
              AND p.type = 'MONTHLY' AND p.status = 'PAID' LIMIT 1`,
          period.studentId, classId, registerYear, registerMonth,
        );
        if (paidForRegister.length === 0) {
          evidence.set(key, { kind: "BLOCKED", reason: "확정 월 장부만 있고 그 달 납부된 수강료 청구를 확인할 수 없어요. 직접 확인해 주세요." });
          continue;
        }
      }
      resolved.set(key, found);
      evidence.set(key, {
        kind: found.source === "PAID_PAYMENT" ? "PAID_PAYMENT" : "WORKBENCH_ISSUED",
        tuition: found.numerator, scheduledDates: found.dates, paymentId: found.sourcePaymentId,
        periodStart: found.periodStart, periodEnd: found.periodEnd,
        warnings: [...found.warnings, ...(found.source === "MONTHLY_REGISTER" ? ["확정 월 장부 금액이 근거예요(그 달 납부 청구 확인됨)."] : [])],
      });
    } catch (error) {
      if (!isWorkbenchError(error)) throw error;
      if (error.message !== CARRY_NO_EVIDENCE_MESSAGE && error.message !== CARRY_UNPAID_MESSAGE) {
        evidence.set(key, { kind: "BLOCKED", reason: error.message });
        continue;
      }
      // 낸 돈이 없는 달(청구 전 · 발행됐지만 미납 · 보류로 돌린 청구) — 수업일은 연간 일정, 월중 등록이면 개시일 이후만
      if (!startsOnByClass.has(classId)) {
        const enrollment = await tx.$queryRawUnsafe<Array<{ startsOn: string | null }>>(
          `SELECT to_char(e."startsOn", 'YYYY-MM-DD') AS "startsOn" FROM "Enrollment" e WHERE e."studentId" = $1 AND e."classId" = $2`,
          period.studentId, classId,
        );
        startsOnByClass.set(classId, enrollment[0]?.startsOn ?? null);
      }
      const dayOfWeek = counted.find((absence) => absence.classId === classId)?.dayOfWeek ?? "";
      const startsOn = startsOnByClass.get(classId) ?? null;
      let monthDates = [...ctx.classDatesForMonth(month, dayOfWeek)].sort();
      if (startsOn && startsOn.slice(0, 7) === month) monthDates = monthDates.filter((date) => date >= startsOn);
      evidence.set(key, { kind: "UNPAID", scheduledDates: monthDates });
    }
  }
  const plan = planIllnessPeriodSettlement({
    period: { id: period.id, startDate: period.startDate, returnDate }, absences, evidence, todayYmd: ctx.todayYmd, omitAbsenceIds,
  });
  // 낸 돈이 없는 달에 «미납 청구가 그대로 살아 있으면» 확정을 막는다(코드 리뷰 필수) — 그대로 확정하면 그 청구가 전액으로 남아
  // 학부모에게 전액이 청구된다. 먼저 «발행 보류로 돌리기»로 그 청구를 거둬야 다닌 만큼만 다시 발행할 수 있다. 문제 목록에 넣어 지문에도 반영된다.
  let holdable: Set<string> | null = null;
  for (const guide of plan.unpaidGuides) {
    const [year, monthNumber] = guide.month.split("-").map(Number);
    const open = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT p.id FROM "Payment" p
        WHERE p."studentId" = $1 AND p."classId" = $2 AND p.year = $3 AND p.month = $4
          AND COALESCE(p.type, 'MONTHLY') = 'MONTHLY' AND p.status IN ('PENDING', 'OVERDUE') ORDER BY p.id`,
      period.studentId, guide.classId, year, monthNumber,
    );
    if (open.length > 0) {
      // 그 청구가 «발행 보류로 돌리기»로 돌릴 수 있는 것인가 — 보류 칸과 같은 판정 함수로 본다(랠리즈 사본·결제 진행 중·현장 결제 중 등은 못 돌린다).
      // 못 돌리는 청구가 섞여 있으면 그 버튼만으로는 풀리지 않으므로 갈 곳을 함께 알려 준다
      holdable ??= new Set(((await readIllnessPeriodBillingHold(tx, period.id))?.bills ?? []).filter((bill) => !bill.skip).map((bill) => bill.paymentId));
      const stuck = open.some((bill) => !holdable!.has(String(bill.id)));
      plan.problems.push({ code: "OPEN_BILL", text: `${Number(guide.month.slice(5, 7))}월 ${guide.className} 미납 청구가 그대로 있습니다. 먼저 ‹발행 보류로 돌리기›를 해 주세요.${stuck ? " 보류로 돌릴 수 없는 청구는 수납 관리에서 취소한 뒤 다시 열어 주세요." : ""}` });
    }
  }
  return { plan, fingerprint: settlementFingerprint({ id: period.id, returnDate }, plan), absences, resolved };
}

/** 지금 이 기간에 쓸 복귀일 — 원장이 넣은 날(진행 중인 학원 등록 기간) 또는 기간에 저장된 날. 규칙 위반은 한국어 사유로 던진다 */
function resolveReturnDate(period: PeriodRow, requested: string | null): { returnDate: string | null; endNow: boolean } {
  if (!requested) return { returnDate: period.returnDate, endNow: false };
  if (!isKstYmd(requested)) throw new IllnessPeriodError("복귀일을 확인해 주세요.", 400);
  if (requested === period.returnDate && period.status !== "ACTIVE") return { returnDate: requested, endNow: false };
  if (requested <= period.startDate) throw new IllnessPeriodError("복귀일은 시작일 다음 날 이후여야 합니다.", 400);
  // 학부모가 알린 기간은 날짜마다 학부모 결석 행이다 — 여기서 기간째로 복귀 처리하지 않는다
  if (period.parentReported) {
    if (requested === period.returnDate) return { returnDate: requested, endNow: false };
    throw new IllnessPeriodError("학부모가 알린 기간은 여기서 복귀일을 바꿀 수 없습니다. 학부모 «복귀했어요» 또는 결석 관리에서 날짜별로 정리해 주세요.");
  }
  if (period.status !== "ACTIVE") throw new IllnessPeriodError("이미 복귀 처리된 기간입니다. 저장된 복귀일로 정산합니다.");
  return { returnDate: requested, endNow: true };
}

/** 넣을 결석이 하나도 없는 기간 — 확정할 것이 없다. 발행 보류를 푸는 길(승인 취소)을 그대로 알려 준다 */
export const SETTLE_NOTHING_MESSAGE = "정산에 넣을 결석이 없어요. ‹승인 취소›로 발행 보류를 풀어 주세요.";

export type SettlementPreview = {
  periodId: string; studentId: string;
  periodStatus: string; carryState: string; parentReported: boolean;
  startDate: string;
  /** 이 미리보기가 쓴 복귀일(없으면 «지금까지 예상» — 오늘까지만 센 값) */
  returnDate: string | null;
  /** 기간에 저장된 복귀일 */
  storedReturnDate: string | null;
  /** 진행 중인 학원 등록 기간 — 확정하려면 복귀일을 먼저 받아야 한다 */
  canSetReturnDate: boolean;
  plan: SettlementPlan;
  fingerprint: string;
  /** 이월을 쓸 수 있게 되는 달(복귀일이 속한 달) */
  availableMonth: string | null;
  /** 지금 [이월 확정]을 누를 수 없는 이유들(없으면 누를 수 있다) */
  blockers: string[];
};

/**
 * 정산 미리보기 — 읽기만 한다(잠금 없음). 달별 표 + 합계 + 낸 돈이 없는 달 안내 + 지문.
 * returnDate 를 주면 «그날 복귀했다면»으로 계산한다(진행 중인 기간의 정산하기 화면). 금액을 가릴지는 호출부(역할)가 정한다.
 */
export async function previewIllnessPeriodSettlement(
  db: SettlementDb, input: { periodId: string; omitAbsenceIds?: string[]; returnDate?: string | null }, ctx: SettlementContext,
): Promise<SettlementPreview> {
  const periodId = cleanId(input?.periodId);
  const omit = cleanIds(input?.omitAbsenceIds);
  return db.$transaction(async (tx) => {
    if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 정산 저장 구조를 확인해 주세요.", 503);
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} WHERE p.id = $1`, periodId);
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period || period.reason !== ILLNESS_REASON) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
    const { returnDate, endNow } = resolveReturnDate(period, input?.returnDate ? String(input.returnDate).trim() : null);
    const read = await readSettlementPlan(tx, period, returnDate, omit, ctx, false);
    // 복귀 처리로 새로 만들어질 결석(복귀일 전날까지)이 아직 없으면 미리보기가 확정과 달라진다 — 먼저 복귀 처리하게 한다
    if (endNow && returnDate && period.coveredUntil && addDaysKst(returnDate, -1) > period.coveredUntil) {
      read.plan.problems.push({ code: "RANGE", text: "복귀일 전날까지의 결석이 아직 만들어지지 않았습니다. 학생 상세에서 먼저 복귀 처리한 뒤 정산해 주세요." });
    }
    const blockers = [
      ...(period.carryState === "APPROVED" ? [] : [period.carryState === "SETTLED" ? "이미 이월을 확정한 기간입니다." : "부상 결석으로 승인된 기간만 정산할 수 있습니다."]),
      ...(period.status === "CANCELLED" ? ["등록 취소된 기간 결석입니다."] : []),
      ...(returnDate ? [] : ["복귀일을 먼저 정해 주세요."]),
      ...read.plan.problems.map((problem) => problem.text),
      // 복귀일까지 정해졌는데 넣을 결석이 하나도 없다(전부 제외·취소) — 확정 버튼 대신 할 일을 알려 준다
      ...(returnDate && read.plan.problems.length === 0 && read.plan.rows.every((row) => row.absenceIds.length === 0) ? [SETTLE_NOTHING_MESSAGE] : []),
    ];
    return {
      periodId, studentId: period.studentId, periodStatus: period.status, carryState: period.carryState, parentReported: period.parentReported === true,
      startDate: period.startDate, returnDate, storedReturnDate: period.returnDate,
      canSetReturnDate: period.status === "ACTIVE" && period.parentReported !== true,
      plan: read.plan,
      // RANGE 문제를 뒤에 붙였으면 지문도 다시 만든다(문제 목록이 지문에 들어 있다)
      fingerprint: settlementFingerprint({ id: period.id, returnDate }, read.plan),
      availableMonth: returnDate ? returnDate.slice(0, 7) : null, blockers,
    };
  }, READ_TX_OPTIONS);
}

export type SettleResult = {
  periodId: string; studentId: string; startDate: string; returnDate: string;
  carryTotal: number; availableMonth: string;
  /** 이월로 적립한 결석 수 / 낸 돈이 없는 달이라 정산 기록만 남긴 결석 수 */
  credited: number; unpaidResolved: number;
  /** 낸 돈이 없는 달 수(청구 준비에서 다닌 만큼만 발행) */
  unpaidMonths: number;
};

/**
 * [이월 확정] — 원장만(호출부가 확인). 미리보기에서 본 표(지문)와 잠근 뒤 다시 계산한 표가 같을 때만 실행한다.
 *
 * @param input.returnDate 진행 중인 학원 등록 기간이면 복귀일을 함께 받아 같은 거래에서 기존 복귀 처리(endAbsencePeriodInTx)를 먼저 한다
 * @param enabled 청구 준비 저장 스위치(STIZ_BILLING_WORKBENCH_WRITES_ENABLED) — 돈이 움직이는 일이라 꺼져 있으면 거절
 */
export async function settleIllnessPeriod(
  db: SettlementDb,
  input: { periodId: string; omitAbsenceIds?: string[]; expectedFingerprint: string; returnDate?: string | null },
  actorId: string, enabled: boolean, ctx: SettlementContext,
): Promise<SettleResult> {
  if (!enabled) throw new IllnessPeriodError("이월 확정은 청구 준비 저장이 켜진 뒤에 할 수 있습니다.", 503);
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);
  const omit = cleanIds(input?.omitAbsenceIds);
  const expected = typeof input?.expectedFingerprint === "string" ? input.expectedFingerprint : "";
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new IllnessPeriodError("정산 내용을 다시 불러온 뒤 확정해 주세요.", 400);

  return db.$transaction(async (tx) => {
    // ① 전역 잠금 → 기간 행
    await lockCompensation(tx);
    if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 정산 저장 구조를 확인해 주세요.", 503);
    if (!(await tableExists(tx, "BillingCarryCredit")) || !(await tableExists(tx, "BillingAbsenceResolution"))) {
      throw new IllnessPeriodError("이월 정산 저장 구조를 확인해 주세요.", 503);
    }
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, periodId);
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period || period.reason !== ILLNESS_REASON) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
    if (period.carryState === "SETTLED") throw new IllnessPeriodError("이미 이월을 확정한 기간입니다.");
    if (period.carryState !== "APPROVED") throw new IllnessPeriodError("부상 결석으로 승인된 기간만 정산할 수 있습니다.");
    if (period.status === "CANCELLED") throw new IllnessPeriodError("등록 취소된 기간 결석입니다.");

    // ② 학생 행(병합된 학생이면 멈춘다 — 이월은 학생 단위 지갑이다)
    const students = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT s.id FROM "Student" s WHERE s.id = $1 AND ${notMergedStudent("s")} FOR UPDATE`, period.studentId,
    );
    if (students.length !== 1) throw new IllnessPeriodError("통합되거나 변경된 학생입니다. 현재 학생으로 다시 확인해 주세요.");

    // ③ 진행 중인 기간이면 복귀 처리를 먼저(기존 함수 — 복귀일 이후 결석 취소·기간 ENDED)
    const { returnDate, endNow } = resolveReturnDate(period, input?.returnDate ? String(input.returnDate).trim() : null);
    if (!returnDate) throw new IllnessPeriodError("복귀일을 먼저 정해 주세요.");
    if (endNow) {
      try {
        await endAbsencePeriodInTx(tx, { periodId, returnDate }, { ...ctx, actorUserId: actorId });
      } catch (error) {
        // 기존 복귀 처리의 한국어 사유(날짜 규칙 등)는 그대로 보인다
        if (error instanceof IllnessPeriodError) throw error;
        throw new IllnessPeriodError(error instanceof Error && error.message ? error.message : "복귀 처리를 하지 못했습니다.");
      }
    }

    // ④ 결석 행을 잠그고 다시 계산 — 원장이 본 표와 같을 때만
    const read = await readSettlementPlan(tx, period, returnDate, omit, ctx, true);
    if (read.plan.problems.length > 0) throw new IllnessPeriodError(read.plan.problems[0].text);
    if (read.fingerprint !== expected) throw new IllnessPeriodError("정산 내용이 바뀌었습니다. 표를 다시 확인한 뒤 확정해 주세요.");

    const availableMonth = returnDate.slice(0, 7);
    const reviewReady = await illnessReviewReady(tx);
    const creditIds: string[] = [];
    const carryAbsenceIds: string[] = [];
    const unpaidAbsenceIds: string[] = [];
    const confirmedAbsenceIds: string[] = [];
    for (const row of read.plan.rows) {
      if (row.absenceIds.length === 0) continue;
      const paid = row.evidence === "WORKBENCH_ISSUED" || row.evidence === "PAID_PAYMENT";
      const evidence = read.resolved.get(`${row.classId}|${row.month}`) ?? null;
      if (paid && !evidence) throw new IllnessPeriodError("그 달 수강료 근거를 다시 읽지 못했습니다. 표를 다시 확인해 주세요.");
      for (let index = 0; index < row.absenceIds.length; index += 1) {
        const absenceId = row.absenceIds[index];
        const date = row.dates[index];
        // 학부모가 알린 결석(REPORTED)은 이때 확정한다 — 이월·정산 기록은 확정된 결석에만 유효하다(청구 준비의 유효성 검사)
        const confirmed = Number(await tx.$executeRawUnsafe(
          `UPDATE "RegularAbsence" SET status = 'CONFIRMED', "resolvedByUserId" = $2, "updatedAt" = now() WHERE id = $1 AND status = 'REPORTED'`,
          absenceId, actorId,
        ));
        if (confirmed > 0) confirmedAbsenceIds.push(absenceId);
        if (paid && evidence) {
          // 이월 1행 — INSERT 는 하루짜리 이월과 같은 함수 한 곳(분수 = 그 달 수강료 / 그 달 수업 횟수)
          const credit = await insertCarryCreditInTx(tx, {
            absence: { id: absenceId, studentId: period.studentId, classId: row.classId, date, reason: ILLNESS_REASON },
            originMonth: row.month, eligibility: ILLNESS_REASON, actorId, calendar: ctx.calendar, evidence, availableMonth, periodId,
          });
          creditIds.push(credit.id);
          carryAbsenceIds.push(absenceId);
        } else {
          unpaidAbsenceIds.push(absenceId);
        }
        // 정산 기록 — 이 결석으로 보강권이 다시 나가거나 하루씩 이월되는 길을 막는다(PK = 결석 id)
        await tx.$executeRawUnsafe(
          `INSERT INTO "BillingAbsenceResolution" ("absenceId","studentId",resolution,reason,"evidenceConfirmed",eligibility,"actorUserId")
           VALUES ($1,$2,'CARRY',$3,true,$4,$5)`,
          absenceId, period.studentId,
          paid ? "부상 결석 기간 정산 — 이월" : "부상 결석 기간 정산 — 낸 돈이 없는 달(다닌 만큼만 청구)",
          ILLNESS_REASON, actorId,
        );
      }
    }
    const handled = [...carryAbsenceIds, ...unpaidAbsenceIds];
    if (handled.length === 0) throw new IllnessPeriodError(SETTLE_NOTHING_MESSAGE);

    // 검토를 «승인»으로(없던 줄은 만든다), 미사용 보강권은 회수 — 하루짜리 이월 승인과 같은 처리
    if (reviewReady) {
      await tx.$executeRawUnsafe(
        `INSERT INTO "RegularAbsenceCarryReview" ("absenceId", status, source, "decidedAt", "decidedBy", "decidedByUserId")
         SELECT target.id, 'APPROVED', 'STAFF', now(), 'ADMIN', $2::text FROM unnest($1::text[]) AS target(id)
         ON CONFLICT ("absenceId") DO UPDATE
            SET status = 'APPROVED', "decidedAt" = now(), "decidedBy" = 'ADMIN',
                "decidedByUserId" = EXCLUDED."decidedByUserId", "convertReason" = NULL, "updatedAt" = now()`,
        handled, actorId,
      );
    }
    const revoked = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE "MakeupCredit" mc
          SET status = 'REVOKED', "makeupSessionId" = NULL, "updatedAt" = NOW()
         FROM "RegularAbsence" ra
        WHERE ra.id = ANY($1::text[]) AND mc."studentId" = ra."studentId"
          AND mc."sourceKey" = 'REGULAR:' || ra."classId" || ':' || to_char(ra.date, 'YYYY-MM-DD')
          AND mc.status IN ('AVAILABLE', 'EXPIRED')
       RETURNING mc.id`,
      handled,
    );

    // ⑤ 기간 상태 — «지금 APPROVED 일 때만». 표 사본은 «병합» 저장(승인 때 남긴 approval·보류로 돌린 held 를 지우지 않는다)
    const settlement = {
      fingerprint: read.fingerprint, returnDate, availableMonth, carryTotal: read.plan.carryTotal,
      rows: read.plan.rows, omitAbsenceIds: omit, creditIds, carryAbsenceIds, unpaidAbsenceIds, confirmedAbsenceIds,
      revokedCreditIds: revoked.map((row) => row.id), todayYmd: ctx.todayYmd, calendarFingerprint: ctx.calendar?.fingerprint ?? null,
    };
    const unpaidGuides = read.plan.unpaidGuides;
    const changed = Number(await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod"
          SET "carryState" = 'SETTLED', "carrySettledAt" = now(), "carrySettledByUserId" = $2,
              "carrySettlement" = COALESCE("carrySettlement", '{}'::jsonb) || $3::jsonb, "updatedAt" = now()
        WHERE id = $1 AND "carryState" = 'APPROVED'`,
      periodId, actorId, JSON.stringify({ settlement, unpaidGuides }),
    ));
    if (changed !== 1) throw new IllnessPeriodError("기간 상태가 바뀌어 확정하지 않았습니다. 다시 확인해 주세요.");
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'ILLNESS_PERIOD_SETTLED', 'ADMIN', $1, $2::jsonb)`,
      actorId, JSON.stringify({ periodId, studentId: period.studentId, ...settlement, unpaidGuides }),
    );
    return {
      periodId, studentId: period.studentId, startDate: period.startDate, returnDate, carryTotal: read.plan.carryTotal, availableMonth,
      credited: carryAbsenceIds.length, unpaidResolved: unpaidAbsenceIds.length, unpaidMonths: unpaidGuides.length,
    };
  }, SETTLE_TX_OPTIONS);
}

export type CancelSettlementResult = { periodId: string; studentId: string; creditsRemoved: number; resolutionsRemoved: number; reopened: number };

/**
 * [확정 취소] — 원장만. 이 기간의 이월이 «한 번도 쓰이지 않았을 때만» 확정 직전(APPROVED)으로 되돌린다.
 * 이월·정산 기록을 지우기 전에 사본을 감사 기록에 남긴다. 한 번이라도 청구에서 차감됐으면 거절한다(직접 조정).
 * 복귀 처리(기간 ENDED)와 검토 «승인»은 그대로 둔다 — 승인된 기간의 모양이다. 발행 보류가 다시 걸린다.
 */
export async function cancelIllnessPeriodSettlement(
  db: SettlementDb, input: { periodId: string }, actorId: string, enabled: boolean,
): Promise<CancelSettlementResult> {
  if (!enabled) throw new IllnessPeriodError("확정 취소는 청구 준비 저장이 켜진 뒤에 할 수 있습니다.", 503);
  if (!actorId) throw new IllnessPeriodError("관리자 확인이 필요합니다.", 403);
  const periodId = cleanId(input?.periodId);

  return db.$transaction(async (tx) => {
    await lockCompensation(tx);
    if (!(await periodCarryColumnsReady(tx))) throw new IllnessPeriodError("기간 결석 정산 저장 구조를 확인해 주세요.", 503);
    const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} WHERE p.id = $1 FOR UPDATE OF p`, periodId);
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period || period.reason !== ILLNESS_REASON) throw new IllnessPeriodError("기간 결석을 찾을 수 없습니다.", 404);
    if (period.carryState !== "SETTLED") throw new IllnessPeriodError("이월을 확정한 기간만 확정 취소할 수 있습니다.");

    const stored = (typeof period.carrySettlement === "string" ? JSON.parse(period.carrySettlement) : period.carrySettlement) as
      { settlement?: { carryAbsenceIds?: unknown; unpaidAbsenceIds?: unknown; confirmedAbsenceIds?: unknown; revokedCreditIds?: unknown } } | null;
    const record = stored?.settlement ?? {};
    const settledAbsenceIds = [...cleanIds(record.carryAbsenceIds), ...cleanIds(record.unpaidAbsenceIds)];

    // 이 기간이 적립한 이월(basis.periodId) — 잠근 뒤 «쓰였는지»를 본다(이월 사용은 같은 전역 잠금 안에서만 생긴다)
    const credits = await tx.$queryRawUnsafe<Array<Record<string, unknown> & { id: string }>>(
      `SELECT c.id, c."absenceId" AS "absenceId", c.numerator::text AS numerator, c.denominator::text AS denominator,
              c."availableMonth" AS "availableMonth", c.basis
         FROM "BillingCarryCredit" c
        WHERE c."studentId" = $1 AND c.basis->>'periodId' = $2
        ORDER BY c.id FOR UPDATE OF c`,
      period.studentId, periodId,
    );
    const creditIds = credits.map((credit) => credit.id);
    if (creditIds.length > 0) {
      const used = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT u.id FROM "BillingCarryUsage" u WHERE u."studentId" = $1 AND u."sourceCreditIds" && $2::text[] LIMIT 1`,
        period.studentId, creditIds,
      );
      if (used.length > 0) throw new IllnessPeriodError("이미 청구에서 차감된 이월이 있어 확정 취소할 수 없습니다. 수납 관리에서 직접 조정해 주세요.");
    }

    // 이 정산의 «낸 돈이 없는 달» 안내로 그 달 청구를 이미 발행했으면(다닌 만큼만 줄인 청구) 취소하지 않는다 —
    // 안내를 지우면 그 청구가 왜 줄었는지 근거가 사라지고, 결석은 다시 «보상 전»이 돼 이중으로 보상될 수 있다
    const guides = parseUnpaidGuides(period.carrySettlement);
    for (const guide of guides) {
      const [guideYear, guideMonth] = guide.month.split("-").map(Number);
      const issued = await tx.$queryRawUnsafe<Array<{ found: number }>>(
        `SELECT 1 AS found FROM "BillingWorkbenchDraft" d
          WHERE d."studentId" = $1 AND d."classId" = $2 AND d.month = $3
            -- 0원 발행이거나, 발행했고 그 청구가 살아 있다(취소·환불된 청구의 초안은 «발행됨»이 아니다)
            AND (d.status = 'ZERO' OR (d.status = 'ISSUED' AND NOT EXISTS (
                  SELECT 1 FROM "Payment" dp WHERE dp.id = d."paymentId" AND dp.status IN ('CANCELED', 'CANCELLED', 'REFUNDED'))))
         UNION ALL
         SELECT 1 FROM "Payment" pay
          WHERE pay."studentId" = $1 AND pay."classId" = $2 AND pay.year = $4 AND pay.month = $5
            AND COALESCE(pay.type, 'MONTHLY') = 'MONTHLY' AND pay.status NOT IN ('CANCELED', 'CANCELLED', 'REFUNDED')
          LIMIT 1`,
        period.studentId, guide.classId, guide.month, guideYear, guideMonth,
      );
      if (issued.length > 0) throw new IllnessPeriodError(`${guideMonth}월 청구를 이미 발행했어요. 확정 취소 대신 수납 관리에서 직접 조정해 주세요.`);
    }

    const resolutions = settledAbsenceIds.length > 0
      ? await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
          `SELECT r."absenceId" AS "absenceId", r.resolution, r.reason, r."actorUserId" AS "actorUserId"
             FROM "BillingAbsenceResolution" r JOIN "RegularAbsence" ra ON ra.id = r."absenceId"
            WHERE ra."periodId" = $1 AND r."absenceId" = ANY($2::text[]) FOR UPDATE OF r`,
          periodId, settledAbsenceIds,
        )
      : [];

    // 지우기 전에 사본을 남긴다
    await tx.$executeRawUnsafe(
      `INSERT INTO "OperationsAuditLog" (id, action, "actorType", "actorUserId", "detailsJson")
       VALUES (gen_random_uuid()::text, 'ILLNESS_PERIOD_SETTLEMENT_CANCELED', 'ADMIN', $1, $2::jsonb)`,
      actorId, JSON.stringify({ periodId, studentId: period.studentId, credits, resolutions, settlement: stored?.settlement ?? null }),
    );

    const creditsRemoved = creditIds.length > 0
      ? Number(await tx.$executeRawUnsafe(`DELETE FROM "BillingCarryCredit" WHERE id = ANY($1::text[]) AND "studentId" = $2`, creditIds, period.studentId))
      : 0;
    const resolutionsRemoved = settledAbsenceIds.length > 0
      ? Number(await tx.$executeRawUnsafe(
          `DELETE FROM "BillingAbsenceResolution" r USING "RegularAbsence" ra
            WHERE ra.id = r."absenceId" AND ra."periodId" = $1 AND r."absenceId" = ANY($2::text[])`,
          periodId, settledAbsenceIds,
        ))
      : 0;
    // 확정 때 «확정»으로 바꾼 학부모 결석은 다시 «신고» 상태로(학부모 «복귀했어요»·날짜별 취소가 다시 되게)
    const confirmedIds = cleanIds(record.confirmedAbsenceIds);
    const reopened = confirmedIds.length > 0
      ? Number(await tx.$executeRawUnsafe(
          `UPDATE "RegularAbsence" SET status = 'REPORTED', "updatedAt" = now()
            WHERE id = ANY($1::text[]) AND "periodId" = $2 AND status = 'CONFIRMED' AND "reportedByUserId" IS NOT NULL`,
          confirmedIds, periodId,
        ))
      : 0;

    // 확정 때 거둔 보강권은 «승인이 거둔 보강권» 목록에 합친다 — 승인 상태에서는 거둬 둔 것이 맞고, 승인 취소 때 함께 돌려준다
    const approval = parsePeriodApprovalRecord(period.carrySettlement);
    const mergedApproval = {
      revokedCreditIds: [...new Set([...approval.revokedCreditIds, ...cleanIds(record.revokedCreditIds)])],
      createdReviewAbsenceIds: approval.createdReviewAbsenceIds,
    };
    const changed = Number(await tx.$executeRawUnsafe(
      `UPDATE "RegularAbsencePeriod"
          SET "carryState" = 'APPROVED', "carrySettledAt" = NULL, "carrySettledByUserId" = NULL,
              "carrySettlement" = (COALESCE("carrySettlement", '{}'::jsonb) - 'settlement' - 'unpaidGuides') || $2::jsonb, "updatedAt" = now()
        WHERE id = $1 AND "carryState" = 'SETTLED'`,
      periodId, JSON.stringify({ approval: mergedApproval }),
    ));
    if (changed !== 1) throw new IllnessPeriodError("기간 상태가 바뀌어 취소하지 않았습니다. 다시 확인해 주세요.");
    return { periodId, studentId: period.studentId, creditsRemoved, resolutionsRemoved, reopened };
  }, SETTLE_TX_OPTIONS);
}

/** 확정된 기간의 표 사본(화면용) — 확정 뒤에는 다시 계산하지 않고 그때의 표를 그대로 보인다 */
export async function readSettledIllnessPeriod(tx: IllnessTx, periodIdInput: string): Promise<{
  periodId: string; studentId: string; carryTotal: number; returnDate: string | null; availableMonth: string | null;
  rows: SettlementPlan["rows"]; unpaidGuides: SettlementPlan["unpaidGuides"];
  /** 이 기간의 이월이 청구에서 한 번이라도 차감됐는가(차감됐으면 확정 취소 불가) */
  used: boolean;
} | null> {
  const periodId = typeof periodIdInput === "string" ? periodIdInput.trim() : "";
  if (!periodId || periodId.length > 200) return null;
  if (!(await periodCarryColumnsReady(tx))) return null;
  const periods = await tx.$queryRawUnsafe<PeriodRow[]>(`${PERIOD_SELECT} WHERE p.id = $1`, periodId);
  const period = periods.find((row) => row.id === periodId) ?? null;
  if (!period || period.reason !== ILLNESS_REASON || period.carryState !== "SETTLED") return null;
  const summary = parseSettlementSummary(period.carrySettlement);
  if (!summary) return null;
  const stored = (typeof period.carrySettlement === "string" ? JSON.parse(period.carrySettlement) : period.carrySettlement) as
    { settlement?: { rows?: unknown }; unpaidGuides?: unknown };
  const used = await tx.$queryRawUnsafe<Array<{ found: number }>>(
    `SELECT 1 AS found FROM "BillingCarryUsage" u
      WHERE u."studentId" = $1
        AND u."sourceCreditIds" && ARRAY(SELECT c.id FROM "BillingCarryCredit" c WHERE c."studentId" = $1 AND c.basis->>'periodId' = $2)
      LIMIT 1`,
    period.studentId, periodId,
  );
  return {
    periodId, studentId: period.studentId, carryTotal: summary.carryTotal, returnDate: summary.returnDate, availableMonth: summary.availableMonth,
    rows: Array.isArray(stored?.settlement?.rows) ? stored.settlement.rows as SettlementPlan["rows"] : [],
    unpaidGuides: Array.isArray(stored?.unpaidGuides) ? stored.unpaidGuides as SettlementPlan["unpaidGuides"] : [],
    used: used.length > 0,
  };
}

// ── 학부모 «복귀했어요» 미리보기(설계 H) ─────────────────────────────────────────────────

export type ParentSettlementPreview = {
  periodId: string; studentId: string; studentName: string;
  /**
   * NOT_APPROVED = 아직 부상 결석으로 인정 전(금액 안내 없음) · ESTIMATE = 예정 금액 · SETTLED = 학원이 확정함
   * REFUND_REVIEW = 퇴원 정산 · 환불 검토 중 · REFUND_DONE = 환불 처리 완료(둘 다 settledTotal = 확정된 정산표 합계)
   */
  state: "NOT_APPROVED" | "ESTIMATE" | "SETTLED" | "REFUND_REVIEW" | "REFUND_DONE";
  returnDate: string | null;
  /** ESTIMATE 일 때의 예정 금액(원장 미리보기와 같은 계산) */
  view: ParentSettlementView | null;
  /** SETTLED 일 때 확정된 이월 합계 */
  settledTotal: number | null;
};

/**
 * 학부모가 «복귀했어요»(복귀일 선택)를 누르면 보는 예정 금액 — 원장 미리보기와 «같은 읽기·같은 계산»을 지난다.
 * 내 아이의 기간만(accessSql = childAccessSql("s","$1") — 호출부가 만든다. 남의 아이·없는 기간은 null).
 * 화면이 보낸 금액은 받지 않는다 — 금액은 여기서만 만든다. 원장이 뺀 날(omit)은 학부모 미리보기에 없다(예정 금액).
 */
export async function previewParentIllnessSettlement(
  db: SettlementDb, input: { parentUserId: string; periodId: string; returnDate?: string | null }, ctx: SettlementContext, accessSql: string,
): Promise<ParentSettlementPreview | null> {
  const periodId = typeof input?.periodId === "string" ? input.periodId.trim() : "";
  if (!periodId || periodId.length > 200 || !input?.parentUserId) return null;
  return db.$transaction(async (tx) => {
    if (!(await periodCarryColumnsReady(tx))) return null;
    const periods = await tx.$queryRawUnsafe<Array<PeriodRow & { studentName: string }>>(
      `${PERIOD_SELECT.replace(`FROM "RegularAbsencePeriod" p`, `, s.name AS "studentName" FROM "RegularAbsencePeriod" p JOIN "Student" s ON s.id = p."studentId"`)}
        WHERE ${accessSql} AND ${notMergedStudent("s")} AND p.id = $2 AND p.reason = '${ILLNESS_REASON}' AND p.status <> 'CANCELLED'`,
      input.parentUserId, periodId,
    );
    const period = periods.find((row) => row.id === periodId) ?? null;
    if (!period) return null;
    const base = { periodId, studentId: period.studentId, studentName: period.studentName };
    if (period.carryState === "SETTLED") {
      const summary = parseSettlementSummary(period.carrySettlement);
      return { ...base, state: "SETTLED" as const, returnDate: summary?.returnDate ?? period.returnDate, view: null, settledTotal: summary?.carryTotal ?? null };
    }
    // 퇴원 정산(4단계): 환불 검토로 넘긴 뒤에는 다시 계산하지 않고 그때의 합계만 보인다(본인 아이만 — 위 accessSql)
    if (period.carryState === "REFUND_REVIEW" || period.carryState === "REFUND_DONE") {
      const summary = parseSettlementSummary(period.carrySettlement);
      return { ...base, state: period.carryState, returnDate: period.returnDate, view: null, settledTotal: summary?.carryTotal ?? null };
    }
    if (period.carryState !== "APPROVED") return { ...base, state: "NOT_APPROVED" as const, returnDate: period.returnDate, view: null, settledTotal: null };
    // 복귀일: 학부모가 고른 날(오늘 이후는 호출부가 확인) 또는 기간에 저장된 날. 시작일 다음 날 이후 · 저장된 복귀일보다 늦을 수 없다
    const requested = input.returnDate ? String(input.returnDate).trim() : null;
    if (requested && (!isKstYmd(requested) || requested <= period.startDate || (period.returnDate && requested > period.returnDate))) {
      throw new IllnessPeriodError("복귀일을 다시 골라 주세요.", 400);
    }
    // «복귀했어요» 실행과 같은 상한(오늘 + 4주 · 저장된 복귀일 · 결석을 만들어 둔 끝 다음 날) — 미리보기만 먼 날짜를 받지 않게
    if (requested && requested > parentReturnDateMax({ todayYmd: ctx.todayYmd, storedReturnYmd: period.returnDate, coveredUntilYmd: period.coveredUntil })) {
      throw new IllnessPeriodError("복귀일을 다시 골라 주세요.", 400);
    }
    const returnDate = requested ?? period.returnDate;
    const read = await readSettlementPlan(tx, period, returnDate, [], ctx, false);
    return { ...base, state: "ESTIMATE" as const, returnDate, view: parentSettlementView(read.plan), settledTotal: null };
  }, READ_TX_OPTIONS);
}
