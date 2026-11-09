// 관리자 «기간 결석»(부상·질병 — «11/6부터, 복귀 미정») 순수 계산 모듈.
//
// 왜 따로 두는가(2026-11-09 원장 결정):
//   부상·질병은 휴원(반 등록 상태 변경)이 아니라 결석으로 남긴다. 반 자리·셔틀 명단은 그대로 두고,
//   기간 안의 «실제 수업일»만 날짜별 RegularAbsence 로 만든다. 어떤 날이 수업일인지(요일·휴무·개강/종강)는
//   틀리기 쉬워서 이 파일에서만 계산하고 tests/absence-period-plan.test.mjs 로 실행 검증한다.
//
// ⚠️ prisma·next import 금지. 연간 일정은 호출부가 `getMonthlyClassDates`(src/lib/enrollment/monthlyClassDates.ts)를
//    감싼 함수(classDatesForMonth)로 넘긴다 — 그 파일은 DB 조회 모듈을 import 해서 여기서 직접 부를 수 없다.
//    같은 함수를 그대로 쓰므로 공개 연간일정표·청구 작업대와 수업일 기준이 같다.
import { addDaysKst, isKstYmd, kstDow } from "@/lib/datetime/kst";
import { DAY_KO, REASON_LABEL, VALID_REASONS } from "@/lib/regular/regularAbsenceRules";

/** 기간 상태 — 마이그레이션 CHECK 제약과 같은 집합(테스트가 비교한다). */
export const PERIOD_STATUSES = ["ACTIVE", "ENDED", "CANCELLED"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

/** 기간 결석 사유 — 학부모 신고와 같은 5종(마이그레이션 CHECK 제약과 같은 집합). */
export const PERIOD_REASONS = VALID_REASONS;
export const DEFAULT_PERIOD_REASON = "ILLNESS_INJURY";

/**
 * 기간 결석이 만든 결석 행의 note 머리말.
 * 결석 관리 화면에서 출처를 알 수 있게 하고, 알림 재조정(operational-notification-reconciliation)이
 * 이 행들을 «학부모 결석 신고/취소» 알림으로 복구 발송하지 않게 거르는 표시로도 쓴다.
 */
export const PERIOD_ABSENCE_NOTE_PREFIX = "기간 결석";

const YM_RE = /^(\d{4})-(\d{2})$/;

/** "11/6(금)" — 화면 표시용(요일은 시간대를 개입시키지 않는 kstDow). */
export function shortDateLabel(ymd: string): string {
  if (!isKstYmd(ymd)) return ymd;
  return `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}(${DAY_KO[kstDow(ymd)]})`;
}

/** 결석 행 note — 사람이 읽는 «기간 결석 · 질병/부상 · 11/6(금)부터». */
export function periodAbsenceNote(reason: string, startDate: string): string {
  return `${PERIOD_ABSENCE_NOTE_PREFIX} · ${REASON_LABEL[reason] ?? reason} · ${shortDateLabel(startDate)}부터`;
}

// ── 달(YYYY-MM) 계산 — 문자열 숫자만으로 한다(시간대 무관) ──
export function yearMonthOf(ymd: string): string {
  return ymd.slice(0, 7);
}

export function addMonthsYm(ym: string, n: number): string {
  const m = YM_RE.exec(ym);
  if (!m) return "";
  const total = Number(m[1]) * 12 + (Number(m[2]) - 1) + n;
  const y = Math.floor(total / 12);
  return `${y}-${String(total - y * 12 + 1).padStart(2, "0")}`;
}

/** 그 달의 말일 "YYYY-MM-DD"(윤년 포함). Date.UTC(y, m, 0) = 그 달 마지막 날 — 시간대가 끼지 않는다. */
export function lastDayOfMonth(ym: string): string {
  const m = YM_RE.exec(ym);
  if (!m) return "";
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return `${ym}-${String(day).padStart(2, "0")}`;
}

/** KST 오늘 기준 «다음 달 말일» — 복귀 미정 기간을 미리 만들어 두는 끝. */
export function nextMonthEnd(todayYmd: string): string {
  return lastDayOfMonth(addMonthsYm(yearMonthOf(todayYmd), 1));
}

/** 결석 행을 만들어야 하는 마지막 날: 복귀일 전날, 복귀 미정이면 다음 달 말일. */
export function periodTargetEnd(input: { returnDate: string | null; todayYmd: string }): string {
  return input.returnDate ? addDaysKst(input.returnDate, -1) : nextMonthEnd(input.todayYmd);
}

/** 시작일·복귀일 검사. 문제없으면 null, 있으면 화면 문구. */
export function validatePeriodDates(startDate: unknown, returnDate: unknown): string | null {
  if (!isKstYmd(startDate)) return "시작일을 확인해 주세요.";
  if (returnDate == null || returnDate === "") return null;
  if (!isKstYmd(returnDate)) return "복귀일을 확인해 주세요.";
  if (String(returnDate) <= String(startDate)) return "복귀일은 시작일 다음 날 이후여야 합니다.";
  return null;
}

/**
 * 두 기간이 겹치는가. 기간 = [시작일, 복귀일) — 복귀일은 다시 출석하는 날이라 포함하지 않는다. 복귀일 NULL = 끝없음.
 * "YYYY-MM-DD" 문자열은 사전순 = 날짜순.
 */
export function periodsOverlap(
  a: { startDate: string; returnDate: string | null },
  b: { startDate: string; returnDate: string | null },
): boolean {
  const aBeforeBEnds = b.returnDate == null || a.startDate < b.returnDate;
  const bBeforeAEnds = a.returnDate == null || b.startDate < a.returnDate;
  return aBeforeBEnds && bBeforeAEnds;
}

// ── 수업일 목록 ──
export type PeriodClass = {
  classId: string;
  /** Class.dayOfWeek — "Mon" … "Sun" */
  dayOfWeek: string;
  /** Enrollment.startsOn(확정 개시일). 이 날 전 수업일은 결석으로 만들지 않는다. NULL = 제한 없음 */
  startsOn: string | null;
};

/** (수강월 "YYYY-MM", 요일) → 그 달 수업일. 호출부가 getMonthlyClassDates(events, ym, dow) 로 만든다. */
export type ClassDatesForMonth = (yearMonth: string, dayOfWeek: string) => string[];

const ALL_DOWS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export type PeriodDatePlan = {
  /** 만들 결석 (반, 날짜) — 날짜순 */
  items: { classId: string; date: string }[];
  /** 이번 계산으로 확실히 덮은 마지막 날(새 coveredUntil). 진척이 없으면 fromDate 전날 */
  coveredUntil: string;
  /** targetEnd 까지 다 덮었는가. false = 연간 일정에 아직 없는 달이 있어 거기서 멈춤(크론이 매일 다시 본다) */
  complete: boolean;
  /** 기간 안에서 연간 일정이 비어 멈춘 달("YYYY-MM") — 화면 경고용. 없으면 null */
  missingMonth: string | null;
};

/**
 * fromDate ~ targetEnd(둘 다 포함) 안에서 각 반의 실제 수업일을 고른다.
 *
 * - 휴무일 제외·월별 회차는 classDatesForMonth(= getMonthlyClassDates) 그대로.
 * - «수강월»과 달력 월이 어긋날 수 있어(예: 12월 1주차가 11/30 에 시작) 앞뒤 한 달씩 더 읽고 날짜 범위로 자른다.
 * - 연간 일정에 그 달 정보가 아직 없으면(일곱 요일 모두 빈 배열) 추측하지 않고 그 앞 달의 마지막 수업일까지만 덮는다.
 *   복귀 미정 기간은 크론이 매일 다시 계산하므로 원장이 일정을 넣으면 그다음 날 채워진다.
 */
export function planAbsencePeriodDates(input: {
  classes: PeriodClass[];
  fromDate: string;
  targetEnd: string;
  classDatesForMonth: ClassDatesForMonth;
}): PeriodDatePlan {
  const { classes, fromDate, targetEnd, classDatesForMonth } = input;
  const before = addDaysKst(fromDate, -1);
  if (!isKstYmd(fromDate) || !isKstYmd(targetEnd) || targetEnd < fromDate) {
    return { items: [], coveredUntil: before, complete: true, missingMonth: null };
  }

  // 그 수강월의 모든 요일 수업일(연간 일정에 그 달 정보가 있는지 + 그 달의 마지막 수업일 판단용)
  const monthCache = new Map<string, string[]>();
  const allDatesOf = (ym: string) => {
    if (!monthCache.has(ym)) monthCache.set(ym, ALL_DOWS.flatMap((dow) => classDatesForMonth(ym, dow)));
    return monthCache.get(ym)!;
  };

  // 1) 덮을 수 있는 끝 — fromDate 의 달부터 targetEnd 의 달까지, 일정이 없는 첫 달에서 멈춘다.
  let coveredEnd = targetEnd;
  let missingMonth: string | null = null;
  const lastYm = yearMonthOf(targetEnd);
  for (let ym = yearMonthOf(fromDate); ym <= lastYm; ym = addMonthsYm(ym, 1)) {
    if (allDatesOf(ym).length > 0) continue;
    missingMonth = ym;
    // 앞 달(수강월)의 마지막 수업일까지만 확실하다. 앞 달도 비었으면 진척 없음.
    const prev = allDatesOf(addMonthsYm(ym, -1));
    const prevLast = prev.length ? prev.reduce((a, b) => (a > b ? a : b)) : before;
    coveredEnd = prevLast < targetEnd ? prevLast : targetEnd;
    break;
  }
  // 끝 달 다음 수강월이 아직 비었으면, 그 달 1주차가 끝 달 말일 쪽에 걸쳐 시작할 수 있다(예: 12월 1주차 = 11/30).
  // 그날을 «덮었다»고 적으면 나중에 일정을 넣어도 다시 보지 않으므로, 끝 달의 마지막 수업일까지만 덮는다(화면 경고는 없음).
  if (!missingMonth && allDatesOf(addMonthsYm(lastYm, 1)).length === 0) {
    const last = allDatesOf(lastYm).reduce((a, b) => (a > b ? a : b), before);
    if (last < coveredEnd) coveredEnd = last;
  }
  if (coveredEnd < before) coveredEnd = before;

  // 2) 반별 수업일 — 앞뒤 한 달까지 읽고 [fromDate, coveredEnd] 와 개시일로 자른다.
  const seen = new Set<string>();
  const items: { classId: string; date: string }[] = [];
  if (coveredEnd >= fromDate) {
    const endYm = addMonthsYm(yearMonthOf(coveredEnd), 1);
    for (const cls of classes) {
      for (let ym = addMonthsYm(yearMonthOf(fromDate), -1); ym <= endYm; ym = addMonthsYm(ym, 1)) {
        for (const date of classDatesForMonth(ym, cls.dayOfWeek)) {
          if (date < fromDate || date > coveredEnd) continue;
          if (cls.startsOn && date < cls.startsOn) continue; // 개시 전 수업은 아직 그 아이 수업이 아니다
          const key = `${cls.classId}|${date}`;
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({ classId: cls.classId, date });
        }
      }
    }
  }
  items.sort((a, b) => (a.date === b.date ? a.classId.localeCompare(b.classId) : a.date < b.date ? -1 : 1));
  return { items, coveredUntil: coveredEnd, complete: coveredEnd >= targetEnd, missingMonth };
}

// ── 날짜 한 칸마다 무엇을 할지(DB 상태 → 판정) ──
export type CreateDecision =
  | "INSERT" // 행 없음 → 새로 만든다
  | "REACTIVATE" // 취소된 행 → 되살려 이 기간에 묶는다
  | "EXISTS" // 살아 있는 행(학부모 신고·출석부 표시·다른 기간) → 그대로 둔다
  | "ATTENDED" // 그날 출석·지각 기록 → 만들지 않는다
  | "PROTECTED"; // 취소됐지만 이미 청구 정산된 행 → 손대지 않는다

export function decideCreate(input: {
  existing: { status: string; resolved: boolean } | null;
  attended: boolean;
}): CreateDecision {
  if (input.attended) return "ATTENDED";
  const row = input.existing;
  if (!row) return "INSERT";
  if (row.status !== "CANCELLED") return "EXISTS";
  return row.resolved ? "PROTECTED" : "REACTIVATE";
}

export type CancelDecision =
  | "CANCEL"
  | "ALREADY" // 이미 취소됨
  | "PROTECTED_BILLING" // 청구 작업대에서 이월·보강으로 정산됨
  | "PROTECTED_MAKEUP" // 보강 예약이 묶여 있음
  | "PROTECTED_PARENT_REPORT"; // 그 뒤 학부모가 같은 날을 직접 신고해 학부모 행이 됨

/** 복귀 처리·등록 취소 때 이 기간 행을 취소해도 되는가. 정산·보강 근거를 바꾸면 이중 보상 위험이라 막는다. */
export function decideCancel(row: {
  status: string;
  reportedByUserId: string | null;
  resolved: boolean;
  makeupBooked: boolean;
}): CancelDecision {
  if (row.status === "CANCELLED") return "ALREADY";
  if (row.resolved) return "PROTECTED_BILLING";
  if (row.makeupBooked) return "PROTECTED_MAKEUP";
  if (row.reportedByUserId) return "PROTECTED_PARENT_REPORT";
  return "CANCEL";
}

export type CreateCounts = { created: number; existing: number; attended: number; protectedCount: number };

/** 결과 문구 «4회 결석 등록 · 이미 있음 1 · 출석 기록 있어 제외 1». 0인 항목은 뺀다. */
export function createResultMessage(c: CreateCounts, extra?: { missingMonth: string | null }): string {
  const parts = [`${c.created}회 결석 등록`];
  if (c.existing) parts.push(`이미 있음 ${c.existing}`);
  if (c.attended) parts.push(`출석 기록 있어 제외 ${c.attended}`);
  if (c.protectedCount) parts.push(`정산된 결석이라 제외 ${c.protectedCount}`);
  let text = parts.join(" · ");
  if (extra?.missingMonth) {
    text += ` (연간 일정에 ${Number(extra.missingMonth.slice(5, 7))}월 수업일이 아직 없어 그 전까지만 등록 — 일정을 넣으면 다음 날 자동으로 채웁니다)`;
  }
  return text;
}

export type CancelCounts = { cancelled: number; billing: number; makeup: number; parent: number };

/** 결과 문구 «결석 3회 취소 · 정산돼 유지 1 · 보강 예약 있어 유지 1». */
export function cancelResultMessage(c: CancelCounts): string {
  const parts = [`결석 ${c.cancelled}회 취소`];
  if (c.billing) parts.push(`청구 정산돼 유지 ${c.billing}`);
  if (c.makeup) parts.push(`보강 예약 있어 유지 ${c.makeup}`);
  if (c.parent) parts.push(`학부모 신고라 유지 ${c.parent}`);
  return parts.join(" · ");
}
