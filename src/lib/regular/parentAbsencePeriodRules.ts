// 학부모 «여러 날 결석»(기간 결석) 규칙 — 순수 모듈(DB·React 없음. node 테스트가 바로 실행한다).
//
// 원장 결정(2026-11-15): 학부모도 «결석 알리기»에서 여러 날을 한 번에 알린다.
//   · 한도 = 오늘부터 4주(28일) 안 — 시작일·끝일 모두. 넘으면 휴원 신청으로 안내한다. 끝일 «아직 몰라요»는 그 끝까지만 잡는다.
//   · 사유 5종 모두 허용. 날짜마다 «하루 알리기»와 같은 결과(질병·부상 = 이월 검토, 그 밖 = 보강권 1장).
//   · 연간일정 휴무일·이미 알린 날·마감(수업 1시간 전) 지난 오늘 수업은 자동으로 뺀다.
//
// 수업일은 관리자 기간 결석과 같은 계산(planAbsencePeriodDates → getMonthlyClassDates)을 쓴다 — 휴무일 기준이 한 곳이다.
// 날짜는 전부 «YYYY-MM-DD»(KST 달력 날짜) 글자. 달력 계산은 공용 모듈(kst.ts)에서만 한다.
import { addDaysKst, diffDaysKst, isKstYmd, kstDow } from "@/lib/datetime/kst";
import { planAbsencePeriodDates, shortDateLabel, type ClassDatesForMonth } from "@/lib/regular/absence-period-plan";
import { isAbsenceChangeOpen } from "@/lib/regular/regularAbsenceRules";

/** 학부모가 알릴 수 있는 범위(오늘 포함 28일 — 시작일·끝일 모두 이 안) */
export const PARENT_PERIOD_MAX_DAYS = 28;
/** 끝일 «아직 몰라요» 기간이 끝나기 며칠 전에 «연장/복귀» 안내를 보낼지 */
export const PARENT_PERIOD_REMIND_DAYS_BEFORE = 3;
/**
 * 학부모 기간 결석이 만든 결석 행의 note 머리말.
 * 알림 재조정(operational-notification-reconciliation)이 이 행들을 날짜마다 «결석 신고» 알림으로 복구 발송하지 않게 거르는 표시
 * (원장·코치·기사 알림은 기간당 1회로 묶어 따로 보낸다). 관리자 기간 결석 머리말(«기간 결석»)과 겹치지 않는 글자여야 한다.
 */
export const PARENT_PERIOD_NOTE_PREFIX = "여러 날 결석";

export function parentPeriodNote(startYmd: string, endYmd: string): string {
  return `${PARENT_PERIOD_NOTE_PREFIX} · ${shortDateLabel(startYmd)}~${shortDateLabel(endYmd)}`;
}

/** 라우트가 한국어 문구로 바꾸는 오류 코드 */
export type ParentPeriodError =
  | "PERIOD_INVALID_DATE" // 날짜 형식
  | "PERIOD_START_PAST" // 시작일이 지난 날
  | "PERIOD_START_TOO_FAR" // 시작일이 4주 뒤보다 멀다(하루 알리기와 같은 범위)
  | "PERIOD_END_BEFORE_START"
  | "PERIOD_TOO_LONG"; // 4주 초과 → 휴원 신청 안내

/** 아이 한 명당 하루(KST)에 만들 수 있는 기간 수 — 만들기·취소를 되풀이해 알림·보강권을 흔드는 것을 막는다 */
export const PARENT_PERIOD_DAILY_LIMIT = 5;

export type ParentPeriodRange = { startYmd: string; endYmd: string; openEnded: boolean };

/**
 * 시작일·끝일 검사. 끝일이 없으면(«아직 몰라요») 4주째 되는 날까지로 잡는다.
 * 끝일은 «마지막으로 쉬는 날»(포함)이다 — 관리자 기간 결석의 복귀일(다시 나오는 날)과 다르다.
 */
export function resolveParentPeriodRange(input: {
  startYmd: unknown; endYmd: unknown; todayYmd: string;
}): { ok: true; range: ParentPeriodRange } | { ok: false; code: ParentPeriodError } {
  const start = typeof input.startYmd === "string" ? input.startYmd.trim() : "";
  const endRaw = typeof input.endYmd === "string" ? input.endYmd.trim() : "";
  if (!isKstYmd(start) || (endRaw && !isKstYmd(endRaw))) return { ok: false, code: "PERIOD_INVALID_DATE" };
  if (start < input.todayYmd) return { ok: false, code: "PERIOD_START_PAST" };
  if (start > addDaysKst(input.todayYmd, PARENT_PERIOD_MAX_DAYS - 1)) return { ok: false, code: "PERIOD_START_TOO_FAR" };
  // 끝일도 «오늘부터 4주 안»까지(보안 검수 2026-11-15) — 하루 알리기와 같은 범위다. 시작일 기준으로 4주를 주면
  // 4주 뒤에 시작해 8주 앞까지 한 번에 알릴 수 있었다. 끝일 «아직 몰라요»도 오늘 +27일까지만 잡는다.
  const maxEnd = addDaysKst(input.todayYmd, PARENT_PERIOD_MAX_DAYS - 1);
  if (!endRaw) return { ok: true, range: { startYmd: start, endYmd: maxEnd, openEnded: true } };
  if (endRaw < start) return { ok: false, code: "PERIOD_END_BEFORE_START" };
  if (endRaw > maxEnd) return { ok: false, code: "PERIOD_TOO_LONG" };
  return { ok: true, range: { startYmd: start, endYmd: endRaw, openEnded: false } };
}

export type ParentPeriodClass = {
  classId: string;
  className: string;
  /** Class.dayOfWeek — "Mon" … "Sun" */
  dayOfWeek: string;
  startTime: string | null;
  /** 복귀가 승인된 휴원 반이면 복귀일 — 그날 이후 수업만 대상. 다니는 반은 null */
  resumeFrom: string | null;
};

export type ParentPeriodItem = { classId: string; className: string; date: string; label: string };

export type ParentPeriodPlan = {
  /** 알릴 수업일(날짜순) */
  items: ParentPeriodItem[];
  /** 자동으로 뺀 날 수 */
  skipped: { already: number; closed: number; holiday: number };
  /** 연간 일정에 아직 없는 달("YYYY-MM") — 그 전까지만 잡았다. 없으면 null */
  missingMonth: string | null;
};

const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * 기간 안에서 실제로 알릴 수업일을 고른다.
 *   · 연간일정 수업일만(휴무일 제외) — 관리자 기간 결석과 같은 계산
 *   · 이미 알린 날(신고·확정)은 뺀다 / 오늘 수업인데 마감(1시간 전)이 지났으면 뺀다 / 복귀 예정 반은 복귀일 이후만
 * existing: 이미 살아 있는 결석의 키 집합(`${classId}|${date}`).
 */
export function planParentPeriod(input: {
  classes: ParentPeriodClass[];
  range: Pick<ParentPeriodRange, "startYmd" | "endYmd">;
  classDatesForMonth: ClassDatesForMonth;
  existing: ReadonlySet<string>;
  now: { ymd: string; hm: string };
}): ParentPeriodPlan {
  const { classes, range, classDatesForMonth, existing, now } = input;
  const plan = planAbsencePeriodDates({
    classes: classes.map((c) => ({ classId: c.classId, dayOfWeek: c.dayOfWeek, startsOn: c.resumeFrom })),
    fromDate: range.startYmd, targetEnd: range.endYmd, classDatesForMonth,
  });
  const byId = new Map(classes.map((c) => [c.classId, c]));
  const skipped = { already: 0, closed: 0, holiday: 0 };
  const items: ParentPeriodItem[] = [];
  const planned = new Set<string>();
  for (const item of plan.items) {
    const cls = byId.get(item.classId);
    if (!cls) continue;
    planned.add(`${item.classId}|${item.date}`);
    if (existing.has(`${item.classId}|${item.date}`)) { skipped.already += 1; continue; }
    if (!isAbsenceChangeOpen(item.date, cls.startTime, now.ymd, now.hm)) { skipped.closed += 1; continue; }
    items.push({ classId: item.classId, className: cls.className, date: item.date, label: shortDateLabel(item.date) });
  }
  // 휴무일로 빠진 날 = 그 반 요일인데 연간일정 수업일이 아닌 날(일정이 잡힌 구간 안에서만 센다)
  for (const cls of classes) {
    const dow = DOW_INDEX[cls.dayOfWeek];
    if (dow == null) continue;
    for (let ymd = range.startYmd; ymd <= plan.coveredUntil && ymd <= range.endYmd; ymd = addDaysKst(ymd, 1)) {
      if (kstDow(ymd) !== dow) continue;
      if (cls.resumeFrom && ymd < cls.resumeFrom) continue;
      if (!planned.has(`${cls.classId}|${ymd}`)) skipped.holiday += 1;
    }
  }
  return { items, skipped, missingMonth: plan.missingMonth };
}

/** 미리보기 한 줄 «11/17(월) · 11/19(수) · 11/24(월) 3회» */
export function periodDatesLabel(items: Array<Pick<ParentPeriodItem, "label">>): string {
  if (items.length === 0) return "";
  return `${items.map((item) => item.label).join(" · ")} ${items.length}회`;
}

/** 자동으로 뺀 날 안내 한 줄(없으면 null) */
export function periodSkippedNote(plan: Pick<ParentPeriodPlan, "skipped" | "missingMonth">): string | null {
  const parts: string[] = [];
  if (plan.skipped.holiday) parts.push(`휴무일 ${plan.skipped.holiday}회`);
  if (plan.skipped.already) parts.push(`이미 알린 날 ${plan.skipped.already}회`);
  if (plan.skipped.closed) parts.push(`마감 지난 오늘 수업 ${plan.skipped.closed}회`);
  let text = parts.length ? `${parts.join(" · ")}는 뺐어요.` : "";
  if (plan.missingMonth) text += `${text ? " " : ""}${Number(plan.missingMonth.slice(5, 7))}월 일정이 아직 없어 그 전까지만 알려요.`;
  return text || null;
}

/** 기간 요약 «11/17(월)~11/28(금)» */
export function periodRangeLabel(startYmd: string, endYmd: string): string {
  return startYmd === endYmd ? shortDateLabel(startYmd) : `${shortDateLabel(startYmd)}~${shortDateLabel(endYmd)}`;
}

/**
 * «아직 몰라요» 기간의 «연장/복귀» 안내를 지금 보낼 때인가 — 끝나기 3일 전부터 마지막 날까지, 한 번만.
 * endYmd = 마지막으로 쉬는 날.
 */
export function shouldRemindOpenEnded(input: {
  openEnded: boolean; status: string; reminderSent: boolean; endYmd: string; todayYmd: string;
}): boolean {
  if (!input.openEnded || input.status !== "ACTIVE" || input.reminderSent) return false;
  if (!isKstYmd(input.endYmd) || !isKstYmd(input.todayYmd)) return false;
  const left = diffDaysKst(input.todayYmd, input.endYmd);
  return left >= 0 && left <= PARENT_PERIOD_REMIND_DAYS_BEFORE;
}

/**
 * «복귀했어요» — 복귀일(다시 나오는 날)부터의 결석을 취소한다. 기간에 지난 결석이 남으면 «복귀 처리»,
 * 하나도 안 남으면(시작 전에 취소) «취소»다. 복귀일은 오늘부터 기간 끝 다음 날까지만.
 */
export function resolveParentPeriodReturn(input: {
  startYmd: string; endYmd: string; returnYmd: unknown; todayYmd: string;
}): { ok: true; fromYmd: string; outcome: "ENDED" | "CANCELLED" } | { ok: false; code: "PERIOD_INVALID_DATE" | "PERIOD_RETURN_PAST" | "PERIOD_RETURN_AFTER_END" } {
  const ret = typeof input.returnYmd === "string" ? input.returnYmd.trim() : "";
  if (!isKstYmd(ret)) return { ok: false, code: "PERIOD_INVALID_DATE" };
  if (ret < input.todayYmd) return { ok: false, code: "PERIOD_RETURN_PAST" };
  if (ret > addDaysKst(input.endYmd, 1)) return { ok: false, code: "PERIOD_RETURN_AFTER_END" };
  return { ok: true, fromYmd: ret, outcome: ret <= input.startYmd ? "CANCELLED" : "ENDED" };
}
