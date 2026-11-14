// 부상·질병 «기간 결석» 복귀 정산 계산 — 순수 모듈(DB·시계·외부 호출 없음. node 테스트가 바로 실행한다).
//
// 원장 결정(2026-11-15): 금액은 복귀가 확정됐을 때 «한 번» 계산한다.
//   · 한 번 수업 값 = 그 달 그 반에 «실제로 낸» 수강료 ÷ 그 달 수업 횟수(연간일정 휴무 제외)
//   · 낸 돈이 있는 달 → 빠진 수업만큼 이월(다음 수강료에서 차감)
//   · 낸 돈이 없는 달 → 이월이 아니라 «다닌 횟수만큼만 청구»(전부 빠진 달은 청구 없음)
// 비유: 영수증이 있는 달은 «거스름돈을 다음 달로 넘기고», 아직 계산 전인 달은 «먹은 만큼만 계산서를 다시 뽑는다».
//
// 식은 이 파일 한 곳이다 — 원장 미리보기 · 학부모 «복귀했어요» 미리보기 · 확정이 모두 planIllnessPeriodSettlement 를 쓴다.
// 반올림: 결석 한 건 = 분수(수강료/수업 횟수) 하나. 소계는 달마다 한 번, 합계는 분수를 모두 더한 뒤 한 번만 반올림한다
// (기존 하루짜리 이월과 같은 함수 roundCarryTotal — 청구 준비의 이월 잔액과 같은 숫자가 나온다).
//
// 날짜는 전부 «YYYY-MM-DD»(KST 달력 날짜) 글자로 받아 글자끼리만 비교한다. 여기서 시간대 계산을 하지 않는다.
import { createHash } from "node:crypto";
import { roundCarryTotal } from "@/lib/billing/workbench";
import type { MonthEvidence } from "@/lib/billing/carryEvidence";
import { unpaidGuideShape, type UnpaidShape } from "@/lib/regular/illnessPeriodRules";

export type { MonthEvidence } from "@/lib/billing/carryEvidence";

/** 기간에 묶인 결석 한 건(취소된 결석은 넘기지 않는다) */
export type PeriodAbsenceInput = {
  absenceId: string; classId: string; className: string; date: string; status: string;
  /**
   * 그 결석일이 속한 «수강월»(YYYY-MM) — 청구의 달이다. 달력 월과 다를 수 있다(예: 12월 1주차가 11/30 에 시작하면 11/30 결석은 12월 수강월).
   * 연간 일정으로 정해 넘긴다. 없으면 결석일의 달력 월로 본다.
   */
  month?: string;
  /** 그날 출결 기록 — 출석·지각이 하나라도 있으면 그 값 */
  attendance: "ABSENT" | "PRESENT" | "LATE" | null;
  /** 그 결석의 보강권 상태(가장 «진행된» 것 하나) */
  creditStatus: string | null;
  /** 그 결석의 보강 예약 상태(취소 제외) */
  bookingStatus: string | null;
  /** 하루씩 이미 결정된 날(이월·보강권) */
  alreadyResolved: "CARRY" | "MAKEUP" | null;
  /** 휴원 정산이 이미 처리한 날(또는 휴원 기간 중인 날) */
  pauseSettled?: boolean;
};

export type SettlementExcludeCode =
  | "OMITTED" | "FUTURE" | "RESOLVED" | "PAUSE" | "ATTENDED" | "MAKEUP_DONE" | "MAKEUP_BOOKED" | "NOT_CLASS_DAY";

/** 제외 사유 글자 — 화면에 그대로 보인다(제외된 날은 이유와 함께 흐리게) */
export const SETTLEMENT_EXCLUDE_TEXT: Record<SettlementExcludeCode, string> = {
  OMITTED: "원장이 뺀 날",
  FUTURE: "아직 지나지 않은 날",
  RESOLVED: "이미 처리됨",
  PAUSE: "휴원 정산에서 처리",
  ATTENDED: "출석 기록 있음",
  MAKEUP_DONE: "보강 완료",
  MAKEUP_BOOKED: "보강 예약 중",
  NOT_CLASS_DAY: "수업일 아님(휴무·수강 기간 밖)",
};

export type SettlementExcluded = { absenceId: string; date: string; code: SettlementExcludeCode; why: string };

export type SettlementRow = {
  /** 수강월 «YYYY-MM» */
  month: string; classId: string; className: string;
  /** 근거 종류 — 납부된 달(WORKBENCH_ISSUED·PAID_PAYMENT)만 이월이 생긴다 */
  evidence: MonthEvidence["kind"];
  /** 그 달 실제로 낸 수강료(낸 돈이 없는 달·근거 없는 달은 0) */
  tuition: number;
  /** 그 달 수업 횟수(분모) */
  sessions: number;
  /** 정산에 넣는 빠진 날짜(날짜순) */
  dates: string[];
  /** 위 날짜의 결석 id(같은 순서) */
  absenceIds: string[];
  /** 정산에서 뺀 날과 이유 */
  excluded: SettlementExcluded[];
  /** 한 번 값(표시용 반올림) */
  unitDisplay: number;
  /** 이 달 소계 = round(수강료 × 빠진 횟수 ÷ 수업 횟수) */
  subtotal: number;
  warnings: string[];
  /** 근거를 정할 수 없는 달이면 그 이유 */
  blockedReason: string | null;
};

/** 낸 돈이 없는 달의 안내 — 이월 대신 그 달 청구를 다닌 만큼만 발행한다 */
export type UnpaidGuide = {
  month: string; classId: string; className: string;
  /** 그 달 수업 횟수 / 다닌(다닐) 횟수 */
  sessions: number; attended: number;
  missedDates: string[];
  shape: Exclude<UnpaidShape, "NONE">;
  /** 수강 기간 제안(앞쪽·뒤쪽이 빠졌을 때만) */
  periodStart: string | null; periodEnd: string | null;
};

/** 확정을 막는 문제 — EVIDENCE·NO_SESSIONS 는 금액을 정할 수 없다는 뜻(학부모에게는 «학원에서 확인한 뒤 알려 드려요») */
// OPEN_BILL = 낸 돈이 없는 달에 미납 청구가 그대로 살아 있다(먼저 보류로 돌려야 다닌 만큼만 다시 발행할 수 있다) — 연결부가 넣는다
export type SettlementProblem = { code: "EVIDENCE" | "NO_SESSIONS" | "FUTURE" | "RANGE" | "OPEN_BILL"; text: string };

export type SettlementPlan = {
  rows: SettlementRow[];
  /** 이월 합계 — 분수로 모두 더한 뒤 한 번 반올림 */
  carryTotal: number;
  unpaidGuides: UnpaidGuide[];
  problems: SettlementProblem[];
};

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const YM = /^\d{4}-\d{2}$/;
/** 그 결석의 수강월 — 넘겨받은 값이 없거나 모양이 다르면 결석일의 달력 월 */
const billingMonthOf = (absence: PeriodAbsenceInput) => (absence.month && YM.test(absence.month) ? absence.month : absence.date.slice(0, 7));
const isPaidKind = (kind: MonthEvidence["kind"]) => kind === "WORKBENCH_ISSUED" || kind === "PAID_PAYMENT";
const monthLabel = (month: string) => `${Number(month.slice(5, 7))}월`;

/** 결석 한 건을 정산에서 빼야 하는 이유(없으면 null). 순서가 곧 우선순위다 */
function excludeCodeOf(
  absence: PeriodAbsenceInput, input: { todayYmd: string; omitted: Set<string> }, scheduled: readonly string[] | null,
): SettlementExcludeCode | null {
  // 오늘 이후 날짜는 아직 빠졌다고 확정할 수 없다(하루짜리 이월과 같은 기준: 오늘 수업은 포함)
  if (absence.date > input.todayYmd) return "FUTURE";
  if (absence.alreadyResolved) return "RESOLVED";
  if (absence.pauseSettled) return "PAUSE";
  if (absence.attendance === "PRESENT" || absence.attendance === "LATE") return "ATTENDED";
  if (["USED", "NO_SHOW"].includes(absence.creditStatus ?? "") || ["ATTENDED", "NO_SHOW"].includes(absence.bookingStatus ?? "")) return "MAKEUP_DONE";
  if (absence.creditStatus === "RESERVED" || absence.bookingStatus === "BOOKED") return "MAKEUP_BOOKED";
  // 연간일정상 그 달 그 반의 수업일이 아닌 날(휴무·월중 등록 전)은 값을 매길 수 없다
  if (scheduled && !scheduled.includes(absence.date)) return "NOT_CLASS_DAY";
  if (input.omitted.has(absence.absenceId)) return "OMITTED";
  return null;
}

/**
 * 기간 결석의 정산 표를 만든다.
 *
 * @param input.evidence 키 `${classId}|${수강월 YYYY-MM}` → 그 반·그 달의 근거(carryEvidence 규칙으로 정한 것)
 * @param input.period.returnDate 복귀일(다시 나오는 날). 정해지지 않았으면 null — «지금까지 예상»으로 오늘까지만 센다
 * @param input.omitAbsenceIds 원장이 뺀 날
 */
export function planIllnessPeriodSettlement(input: {
  period: { id: string; startDate: string; returnDate: string | null };
  absences: readonly PeriodAbsenceInput[];
  evidence: ReadonlyMap<string, MonthEvidence>;
  todayYmd: string;
  omitAbsenceIds?: readonly string[];
}): SettlementPlan {
  const omitted = new Set(input.omitAbsenceIds ?? []);
  const returnDate = input.period.returnDate && YMD.test(input.period.returnDate) ? input.period.returnDate : null;
  const problems: SettlementProblem[] = [];

  // 반·수강월마다 묶는다(달 → 반 이름 → 반 id 순 — 화면 줄 순서이자 지문 순서)
  const groups = new Map<string, PeriodAbsenceInput[]>();
  for (const absence of input.absences) {
    if (absence.status === "CANCELLED" || !YMD.test(absence.date)) continue;
    // 복귀일(다시 나오는 날) 이후는 결석이 아니다 — 복귀 처리 때 취소되는 날이라 표에 올리지 않는다
    // (복귀 처리 «전» 미리보기와 «후» 확정이 같은 표·같은 지문이 되게 아예 뺀다)
    if (returnDate && absence.date >= returnDate) continue;
    const key = `${absence.classId}|${billingMonthOf(absence)}`;
    const list = groups.get(key);
    if (list) list.push(absence); else groups.set(key, [absence]);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const [classA, monthA] = a.split("|"), [classB, monthB] = b.split("|");
    const nameA = groups.get(a)![0].className, nameB = groups.get(b)![0].className;
    return monthA.localeCompare(monthB) || nameA.localeCompare(nameB, "ko") || classA.localeCompare(classB);
  });

  const rows: SettlementRow[] = [];
  const unpaidGuides: UnpaidGuide[] = [];
  const fractions: Array<{ numerator: string; denominator: string }> = [];
  let futureBeforeReturn = 0;
  let lastFutureDate = "";

  for (const key of keys) {
    const absences = [...groups.get(key)!].sort((a, b) => a.date.localeCompare(b.date) || a.absenceId.localeCompare(b.absenceId));
    const [classId, month] = key.split("|");
    const className = absences[0].className;
    const evidence = input.evidence.get(key) ?? null;
    const scheduled = evidence && evidence.kind !== "BLOCKED" ? [...new Set(evidence.scheduledDates)].sort() : null;

    const included: PeriodAbsenceInput[] = [];
    const excluded: SettlementExcluded[] = [];
    for (const absence of absences) {
      // 수업일이 하나도 없는 달(일정 미입력)은 «수업일 아님»으로 조용히 빼지 않는다 — 넣을 날로 남겨 아래에서 확정을 막는다
      const code = excludeCodeOf(absence, { todayYmd: input.todayYmd, omitted }, scheduled && scheduled.length > 0 ? scheduled : null);
      if (!code) { included.push(absence); continue; }
      excluded.push({ absenceId: absence.absenceId, date: absence.date, code, why: SETTLEMENT_EXCLUDE_TEXT[code] });
      // 복귀일이 정해졌는데 그 전에 아직 지나지 않은 결석이 남아 있다 — 지금 확정하면 그 날의 보상이 사라진다
      if (code === "FUTURE" && returnDate) { futureBeforeReturn += 1; if (absence.date > lastFutureDate) lastFutureDate = absence.date; }
    }

    const row: SettlementRow = {
      month, classId, className, evidence: evidence?.kind ?? "BLOCKED", tuition: 0, sessions: scheduled?.length ?? 0,
      dates: included.map((absence) => absence.date), absenceIds: included.map((absence) => absence.absenceId), excluded,
      unitDisplay: 0, subtotal: 0, warnings: [], blockedReason: null,
    };

    if (!evidence || evidence.kind === "BLOCKED") {
      row.blockedReason = evidence?.kind === "BLOCKED" ? evidence.reason : "그 달 수강료 근거를 읽지 못했습니다.";
      // 넣을 날이 하나도 없으면(전부 제외·원장이 뺌) 이 달은 확정을 막지 않는다
      if (included.length > 0) problems.push({ code: "EVIDENCE", text: `${monthLabel(month)} ${className}: ${row.blockedReason}` });
    } else if (row.sessions === 0) {
      // 수업 0회 달은 나눌 수 없다 — 결석 행이 있는데 수업일이 없으면 일정을 먼저 확인해야 한다
      if (included.length > 0) problems.push({ code: "NO_SESSIONS", text: `${monthLabel(month)} ${className}: 연간 일정의 수업일이 없어 한 번 값을 계산할 수 없습니다.` });
    } else if (evidence.kind !== "UNPAID") {
      const tuition = evidence.tuition;
      if (!Number.isSafeInteger(tuition) || tuition < 0) {
        row.blockedReason = "그 달 청구 금액을 확인해 주세요.";
        row.evidence = "BLOCKED";
        if (included.length > 0) problems.push({ code: "EVIDENCE", text: `${monthLabel(month)} ${className}: ${row.blockedReason}` });
      } else {
        row.tuition = tuition;
        row.warnings = [...evidence.warnings];
        row.unitDisplay = Math.round(tuition / row.sessions);
        // 소계: 빠진 횟수 ≤ 수업 횟수라 그 달 수강료를 넘지 않는다
        row.subtotal = Math.round(tuition * included.length / row.sessions);
        for (let index = 0; index < included.length; index += 1) fractions.push({ numerator: String(tuition), denominator: String(row.sessions) });
      }
    } else if (included.length > 0) {
      // 낸 돈이 없는 달 — 이월을 만들지 않고 «다닌 횟수만큼만 청구» 안내를 남긴다
      const shape = unpaidGuideShape(scheduled ?? [], included.map((absence) => absence.date));
      if (shape.shape !== "NONE") {
        unpaidGuides.push({
          month, classId, className, sessions: row.sessions, attended: shape.attendedDates.length, missedDates: shape.missedDates,
          shape: shape.shape, periodStart: shape.periodStart, periodEnd: shape.periodEnd,
        });
      }
    }
    rows.push(row);
  }

  if (futureBeforeReturn > 0) {
    problems.push({ code: "FUTURE", text: `복귀일 전에 아직 지나지 않은 결석이 ${futureBeforeReturn}회 있습니다. 마지막 결석일(${lastFutureDate})이 지난 뒤 확정해 주세요.` });
  }
  return { rows, carryTotal: fractions.length ? roundCarryTotal(fractions) : 0, unpaidGuides, problems };
}

/**
 * 미리보기 지문 — 원장이 본 표와 확정 때 다시 계산한 표가 같은지 견준다(날짜를 빼거나 결석이 취소되면 달라진다).
 * 기간·복귀일·줄마다의 근거 금액·수업 횟수·넣은 결석·뺀 결석과 이유·미납 달 안내·합계를 모두 넣는다.
 */
export function settlementFingerprint(period: { id: string; returnDate: string | null }, plan: SettlementPlan): string {
  return createHash("sha256").update(JSON.stringify({
    v: 1, periodId: period.id, returnDate: period.returnDate ?? null, carryTotal: plan.carryTotal,
    rows: plan.rows.map((row) => [row.month, row.classId, row.evidence, row.tuition, row.sessions, row.absenceIds,
      row.excluded.map((item) => [item.absenceId, item.code])]),
    unpaid: plan.unpaidGuides.map((guide) => [guide.month, guide.classId, guide.sessions, guide.missedDates, guide.shape]),
    problems: plan.problems.map((problem) => problem.code),
  })).digest("hex");
}

/** 학부모 «복귀했어요» 미리보기에 보이는 모양 — 원장 표와 같은 계산 결과에서 «예정» 금액만 꺼낸다 */
export type ParentSettlementView = {
  /** 근거를 정할 수 없는 달이 있어 금액을 보이지 않는다 — «학원에서 확인한 뒤 알려 드려요» */
  pendingCheck: boolean;
  /** 이월 예정 합계(pendingCheck 면 null) */
  total: number | null;
  /** 달별: 반 · 빠진 횟수 · 소계 */
  months: Array<{ month: string; className: string; missed: number; subtotal: number }>;
  /** 아직 안 낸 달: «12월 수강료는 다닌 2회만큼 다시 안내해요» */
  unpaid: Array<{ month: string; className: string; attended: number; sessions: number; text: string }>;
};

/** 낸 돈이 없는 달의 학부모 문구 — 전부 빠진 달은 «청구하지 않아요» */
export function unpaidGuideParentText(guide: Pick<UnpaidGuide, "month" | "className" | "attended" | "shape">): string {
  return guide.shape === "WHOLE"
    ? `${monthLabel(guide.month)} ${guide.className} 수강료는 다닌 수업이 없어 청구하지 않아요`
    : `${monthLabel(guide.month)} ${guide.className} 수강료는 다닌 ${guide.attended}회만큼 다시 안내해요`;
}

/** 낸 돈이 없는 달의 원장 문구 */
export function unpaidGuideAdminText(guide: UnpaidGuide): string {
  const head = `${monthLabel(guide.month)} ${guide.className} · ${guide.sessions}회 중 ${guide.missedDates.length}회 결석`;
  if (guide.shape === "WHOLE") return `${head} → 이 달 청구는 0원으로 제안해요`;
  if (guide.shape === "PREFIX") return `${head} → 다닌 ${guide.attended}회만 청구(수강 시작일 ${guide.periodStart} 제안)`;
  if (guide.shape === "SUFFIX") return `${head} → 다닌 ${guide.attended}회만 청구(수강 종료일 ${guide.periodEnd} 제안)`;
  // 달 가운데만 빠지면 수강 기간으로 나타낼 수 없다 — 기간은 그대로 두고 빠진 횟수만큼 기간 조정 금액을 제안한다(청구 준비)
  return `${head} → 다닌 ${guide.attended}회만 청구(달 가운데가 빠져 수강 기간은 그대로, 기간 조정 금액으로 제안)`;
}

/** 퇴원 정산(환불 검토)에서 낸 돈이 없는 달의 원장 문구 — 환불할 돈이 없다는 것만 알린다 */
export function unpaidGuideRefundText(guide: Pick<UnpaidGuide, "month" | "className" | "sessions" | "missedDates">): string {
  return `${monthLabel(guide.month)} ${guide.className} · ${guide.sessions}회 중 ${guide.missedDates.length}회 결석 → 낸 돈이 없는 달이라 환불 대상이 아니에요(청구 없음)`;
}

export function parentSettlementView(plan: SettlementPlan): ParentSettlementView {
  // 금액을 정할 수 없는 달이 하나라도 있으면 숫자를 보이지 않는다(틀린 숫자를 보이지 않는다)
  const pendingCheck = plan.problems.some((problem) => problem.code === "EVIDENCE" || problem.code === "NO_SESSIONS");
  return {
    pendingCheck,
    total: pendingCheck ? null : plan.carryTotal,
    months: pendingCheck ? [] : plan.rows.filter((row) => isPaidKind(row.evidence) && row.dates.length > 0)
      .map((row) => ({ month: row.month, className: row.className, missed: row.dates.length, subtotal: row.subtotal })),
    unpaid: pendingCheck ? [] : plan.unpaidGuides.map((guide) => ({
      month: guide.month, className: guide.className, attended: guide.attended, sessions: guide.sessions, text: unpaidGuideParentText(guide),
    })),
  };
}
