/**
 * 셔틀 «계속 바꾸기» 신청 규칙 — 순수 함수(DB·시계 없음). 2026-11-14 결정표 c5.
 *
 * 학부모 화면(고를 수 있는 것)·서버 접수·원장 승인·적용일 처리가 같은 판정을 쓴다.
 * 하루만 바꾸는 «셔틀 변경»(ShuttleDayException)과 다른 것: 이 신청은 셔틀 명단(RegularShuttleStop)을 «앞으로 계속» 바꾼다.
 * 그래서 학부모가 직접 바꾸지 못하고 원장 승인을 거친다(승인 전에는 명단이 그대로다).
 *
 * 날짜는 "YYYY-MM-DD" 문자열만. 오늘은 부르는 쪽이 todayKst() 로 넣는다.
 */
import { addDaysKst } from "@/lib/datetime/kst";
import { addMonths, isYmd } from "@/lib/enrollment/changeRequestRules";

export const REGULAR_CHANGE_KINDS = ["CHANGE", "START", "STOP"] as const;
export type RegularChangeKind = (typeof REGULAR_CHANGE_KINDS)[number];

export const REGULAR_CHANGE_KIND_LABEL: Record<RegularChangeKind, string> = {
  CHANGE: "위치 바꾸기",
  START: "셔틀 이용 시작",
  STOP: "셔틀 이용 중단",
};

export const REGULAR_CHANGE_DIRECTIONS = ["PICKUP", "DROPOFF"] as const;
export type RegularChangeDirection = (typeof REGULAR_CHANGE_DIRECTIONS)[number];

/** 학부모 화면 방향 이름 — «등원 = 타는 곳, 하원 = 내리는 곳»을 같이 적어 헷갈리지 않게 */
export const REGULAR_CHANGE_DIRECTION_LABEL: Record<RegularChangeDirection, string> = {
  PICKUP: "등원 · 타는 곳",
  DROPOFF: "하원 · 내리는 곳",
};

/** 셔틀 명단의 방향 값(RegularShuttleStop.direction) */
export const ROSTER_DIRECTION: Record<RegularChangeDirection, "BOARD" | "ALIGHT"> = { PICKUP: "BOARD", DROPOFF: "ALIGHT" };

export const REGULAR_CHANGE_STATUSES = ["PENDING", "APPROVED", "APPLIED", "REJECTED", "CANCELED"] as const;
export type RegularChangeStatus = (typeof REGULAR_CHANGE_STATUSES)[number];

/** 아이당 하루(KST) 접수 상한(보안 검수 L1) — 신청→취소→재신청을 되풀이해 원장 알림이 쏟아지는 것을 막는다. 취소한 것도 센다 */
export const REGULAR_CHANGE_DAILY_LIMIT = 5;
/** 하루 상한 문구 — 화면이 이 답(code=DAILY_LIMIT)을 받으면 «학원에 전화하기» 버튼을 함께 보인다 */
export const REGULAR_CHANGE_DAILY_LIMIT_MESSAGE = "오늘은 더 신청할 수 없어요. 학원에 전화해 주세요.";

/** 전할 말 길이 상한(DB CHECK 와 같은 값) */
export const REGULAR_CHANGE_NOTE_MAX = 300;
/** 적용 시작일을 고를 수 있는 가장 먼 날(오늘부터 몇 달) — 수강 변경과 같은 3개월 */
export const REGULAR_CHANGE_MONTHS_AHEAD = 3;

const WEEKDAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
const DOW_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** 반 요일 글자("Mon") → 명단 요일 숫자(0=일 … 6=토). 모르는 값이면 null */
export function weekdayOfClassDay(dayOfWeek: string | null | undefined): number | null {
  const n = DOW_INDEX[String(dayOfWeek ?? "")];
  return n === undefined ? null : n;
}

export function weekdayLabel(weekday: number): string {
  return WEEKDAY_KO[weekday] ?? "";
}

/** 적용 시작일 범위 — 내일부터(오늘 운행은 하루 변경 «셔틀 변경»으로) 3개월 뒤까지 */
export function regularChangeDateRange(today: string): { min: string; max: string } {
  return { min: addDaysKst(today, 1), max: addMonths(today, REGULAR_CHANGE_MONTHS_AHEAD) };
}

/** 그 아이의 지금 상황 — 서버가 DB 에서 읽어 넣는다(화면이 보낸 값은 믿지 않는다) */
export type RegularChangeContext = {
  today: string;
  /** 정규 반(다니는 중·휴원 중)의 요일 */
  classWeekdays: readonly number[];
  /** 지금 셔틀 명단에 올라 있는 칸(요일·방향) */
  roster: ReadonlyArray<{ weekday: number; direction: RegularChangeDirection }>;
};

export type RegularChangeError =
  | "INVALID_KIND"
  | "DIRECTION_REQUIRED"
  | "INVALID_WEEKDAYS"
  | "NOT_ON_ROSTER"
  | "NOTHING_TO_START"
  | "WEEKDAY_NOT_ON_ROSTER"
  | "WEEKDAY_NOT_CLASS_DAY"
  | "ALREADY_ON_ROSTER"
  | "LOCATION_REQUIRED"
  | "CONSENT_REQUIRED"
  | "INVALID_DATE"
  | "DATE_TOO_SOON"
  | "DATE_TOO_FAR"
  | "NOTE_TOO_LONG";

export const REGULAR_CHANGE_MESSAGE: Record<RegularChangeError, string> = {
  INVALID_KIND: "신청 종류를 다시 골라 주세요.",
  DIRECTION_REQUIRED: "등원·하원 중 바꿀 쪽을 골라 주세요.",
  INVALID_WEEKDAYS: "요일을 다시 골라 주세요.",
  NOT_ON_ROSTER: "지금 정규 셔틀을 타고 있지 않아요. «셔틀 이용 시작»으로 신청해 주세요.",
  NOTHING_TO_START: "수업이 있는 요일은 이미 모두 셔틀을 타고 있어요. «위치 바꾸기»로 신청해 주세요.",
  WEEKDAY_NOT_ON_ROSTER: "고른 요일·방향에는 셔틀을 타고 있지 않아요. 요일을 다시 골라 주세요.",
  WEEKDAY_NOT_CLASS_DAY: "수업이 있는 요일만 고를 수 있어요.",
  ALREADY_ON_ROSTER: "고른 요일은 이미 셔틀을 타고 있어요. «위치 바꾸기»로 신청해 주세요.",
  LOCATION_REQUIRED: "새 위치를 지도에서 골라 주세요.",
  CONSENT_REQUIRED: "위치정보 이용에 동의해 주세요.",
  INVALID_DATE: "적용 시작일을 다시 확인해 주세요.",
  DATE_TOO_SOON: "적용 시작일은 내일 이후로 골라 주세요. 오늘은 «셔틀 변경»으로 하루만 바꿀 수 있어요.",
  DATE_TOO_FAR: "적용 시작일은 3개월 이내로 골라 주세요.",
  NOTE_TOO_LONG: `전할 말은 ${REGULAR_CHANGE_NOTE_MAX}자 이내로 적어 주세요.`,
};

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/** 그 방향으로 셔틀을 타는 요일 */
function rosterWeekdays(ctx: RegularChangeContext, directions: readonly RegularChangeDirection[]): number[] {
  return uniqueSorted(ctx.roster.filter((r) => directions.includes(r.direction)).map((r) => r.weekday));
}

/** «이용 시작»으로 고를 수 있는 요일 — 수업은 있는데 그 방향 셔틀을 하나도 안 타는 요일 */
export function startableWeekdays(ctx: RegularChangeContext, directions: readonly RegularChangeDirection[]): number[] {
  return uniqueSorted(ctx.classWeekdays).filter((weekday) =>
    directions.some((direction) => !ctx.roster.some((r) => r.weekday === weekday && r.direction === direction)));
}

/**
 * 종류를 골랐을 때 미리 켜 둘 방향(화면 기본값) — 그 아이에게 실제로 해당하는 쪽만.
 * 위치 바꾸기·이용 중단 = 지금 타는 방향 / 이용 시작 = 수업 요일 중 아직 안 타는 방향.
 * (등원만 타는 아이에게 «하원 위치»까지 고르라고 하면 신청이 거절된다.)
 */
export function defaultDirections(kind: RegularChangeKind, ctx: RegularChangeContext): RegularChangeDirection[] {
  const picked = REGULAR_CHANGE_DIRECTIONS.filter((direction) => kind === "START"
    ? ctx.classWeekdays.some((weekday) => !ctx.roster.some((r) => r.weekday === weekday && r.direction === direction))
    : ctx.roster.some((r) => r.direction === direction));
  return picked.length > 0 ? picked : [...REGULAR_CHANGE_DIRECTIONS];
}

/** 화면이 종류별로 보여 줄 요일 칩(고를 수 있는 요일). CHANGE·STOP = 타는 요일, START = 안 타는 수업 요일 */
export function selectableWeekdays(kind: RegularChangeKind, ctx: RegularChangeContext, directions: readonly RegularChangeDirection[]): number[] {
  return kind === "START" ? startableWeekdays(ctx, directions) : rosterWeekdays(ctx, directions);
}

export type RegularChangeInput = {
  kind?: unknown;
  directions?: unknown;
  /** null·빈 값 = 모든 요일 */
  weekdays?: unknown;
  effectiveFrom?: unknown;
  note?: unknown;
  /** 방향별로 새 위치를 보냈는지(값 검증은 서버가 validateRegularLocation 으로 따로 한다) */
  hasPickup?: boolean;
  hasDropoff?: boolean;
  consent?: boolean;
};

export type RegularChangeNormalized = {
  kind: RegularChangeKind;
  directions: RegularChangeDirection[];
  /**
   * 위치 바꾸기: null = 모든 요일(아이의 기준 위치까지 바꾼다).
   * 이용 시작·중단: 항상 요일을 «확정»해 담는다 — «모든 요일»로 신청해도 접수 시점의 대상 요일로 풀어 적는다.
   * 그래야 나중에 «신청한 칸이 전부 명단에 올랐는가/빠졌는가»를 정확히 판정할 수 있다.
   */
  weekdays: number[] | null;
  effectiveFrom: string;
  note: string | null;
};

/**
 * 접수 판정. 소유권(내 아이인가)·위치 값 검증·중복(확인 중 1건)은 부르는 쪽이 본다.
 * 고른 값을 조용히 바꾸지 않는다 — 벗어나면 거절한다(신청한 내용과 실제 반영이 달라지면 안 된다).
 */
export function validateRegularChange(input: RegularChangeInput, ctx: RegularChangeContext):
  { ok: true; value: RegularChangeNormalized } | { ok: false; error: RegularChangeError } {
  const kind = REGULAR_CHANGE_KINDS.find((k) => k === input.kind);
  if (!kind) return { ok: false, error: "INVALID_KIND" };

  const rawDirections = Array.isArray(input.directions) ? input.directions : [];
  let directions: RegularChangeDirection[] = REGULAR_CHANGE_DIRECTIONS.filter((d) => rawDirections.includes(d));
  if (directions.length === 0 || rawDirections.some((d) => !REGULAR_CHANGE_DIRECTIONS.includes(d as RegularChangeDirection))) {
    return { ok: false, error: "DIRECTION_REQUIRED" };
  }

  let weekdays: number[] | null = null;
  if (input.weekdays !== undefined && input.weekdays !== null && !(Array.isArray(input.weekdays) && input.weekdays.length === 0)) {
    if (!Array.isArray(input.weekdays) || input.weekdays.some((w) => !Number.isInteger(w) || (w as number) < 0 || (w as number) > 6)) {
      return { ok: false, error: "INVALID_WEEKDAYS" };
    }
    weekdays = uniqueSorted(input.weekdays as number[]);
  }

  if (kind === "START") {
    const open = startableWeekdays(ctx, directions);
    if (open.length === 0) return { ok: false, error: "NOTHING_TO_START" };
    if (weekdays) {
      if (weekdays.some((w) => !ctx.classWeekdays.includes(w))) return { ok: false, error: "WEEKDAY_NOT_CLASS_DAY" };
      if (weekdays.some((w) => !open.includes(w))) return { ok: false, error: "ALREADY_ON_ROSTER" };
    }
    // 요일을 확정한다(«모든 요일» = 지금 안 타는 수업 요일 전부). 방향은 그 요일 중 한 곳이라도 아직 안 타는 쪽만 남긴다
    // — 이미 타는 방향을 신청에 넣어 두면 «다 올랐다» 판정이 처음부터 참이 된다.
    const days = weekdays ?? open;
    weekdays = days;
    directions = directions.filter((d) => days.some((w) => !ctx.roster.some((r) => r.weekday === w && r.direction === d)));
  } else {
    const riding = rosterWeekdays(ctx, directions);
    if (riding.length === 0) return { ok: false, error: "NOT_ON_ROSTER" };
    if (weekdays && weekdays.some((w) => !riding.includes(w))) return { ok: false, error: "WEEKDAY_NOT_ON_ROSTER" };
    // 이용 중단도 요일을 확정한다(«모든 요일» = 지금 그 방향으로 타는 요일 전부) — 나중에 다른 요일을 새로 타도 이 신청과 무관하다.
    if (kind === "STOP") {
      const days = weekdays ?? riding;
      weekdays = days;
      directions = directions.filter((d) => days.some((w) => ctx.roster.some((r) => r.weekday === w && r.direction === d)));
    }
  }

  if (kind !== "STOP") {
    if ((directions.includes("PICKUP") && !input.hasPickup) || (directions.includes("DROPOFF") && !input.hasDropoff)) {
      return { ok: false, error: "LOCATION_REQUIRED" };
    }
    if (!input.consent) return { ok: false, error: "CONSENT_REQUIRED" };
  }

  const effectiveFrom = typeof input.effectiveFrom === "string" ? input.effectiveFrom.trim() : "";
  if (!isYmd(effectiveFrom)) return { ok: false, error: "INVALID_DATE" };
  const range = regularChangeDateRange(ctx.today);
  // "YYYY-MM-DD" 는 글자 순서 = 날짜 순서
  if (effectiveFrom < range.min) return { ok: false, error: "DATE_TOO_SOON" };
  if (effectiveFrom > range.max) return { ok: false, error: "DATE_TOO_FAR" };

  const rawNote = typeof input.note === "string" ? input.note.trim() : "";
  if (rawNote.length > REGULAR_CHANGE_NOTE_MAX) return { ok: false, error: "NOTE_TOO_LONG" };

  return { ok: true, value: { kind, directions: [...directions], weekdays, effectiveFrom, note: rawNote || null } };
}

/** "2026-12-01" → "12월 1일". 형식이 아니면 빈 문자열 */
export function koreanMonthDay(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? ""));
  return m ? `${Number(m[2])}월 ${Number(m[3])}일` : "";
}

/** 신청 한 줄 요약 — «등원·하원 위치 바꾸기 · 월·수» / «셔틀 이용 중단 · 하원» */
export function regularChangeSummary(row: { kind: string; directions: readonly string[]; weekdays: readonly number[] | null }): string {
  const both = row.directions.includes("PICKUP") && row.directions.includes("DROPOFF");
  const side = both ? "등원·하원" : row.directions.includes("PICKUP") ? "등원" : "하원";
  const days = row.weekdays && row.weekdays.length > 0 ? row.weekdays.map(weekdayLabel).join("·") : "모든 요일";
  const what = row.kind === "CHANGE" ? `${side} 위치 바꾸기` : `${REGULAR_CHANGE_KIND_LABEL[row.kind as RegularChangeKind] ?? "셔틀 신청"} · ${side}`;
  return `${what} · ${days}`;
}

/**
 * 학부모에게 보이는 상태 한 줄 — «확인 중 / 승인됨(○월 ○일부터) / 반려(사유)».
 * 승인(적용 대기)과 반영 끝(APPLIED)은 학부모에게 같은 말이다 — 언제부터인지만 알면 된다.
 */
export function regularChangeStatusLine(row: { status: string; effectiveFrom: string; decisionNote?: string | null }): { text: string; tone: "warning" | "success" | "danger" | "muted" } {
  const from = koreanMonthDay(row.effectiveFrom);
  if (row.status === "PENDING") return { text: "확인 중", tone: "warning" };
  if (row.status === "APPROVED" || row.status === "APPLIED") return { text: from ? `승인됨(${from}부터)` : "승인됨", tone: "success" };
  if (row.status === "REJECTED") {
    const note = (row.decisionNote ?? "").replace(/\s+/g, " ").trim();
    return { text: note ? `반려: ${note}` : "반려", tone: "danger" };
  }
  return { text: "취소함", tone: "muted" };
}

/**
 * 학부모가 직접 취소할 수 있는가(R9).
 * - 확인 중: 언제든.
 * - 승인됨: 아직 명단에 반영되기 전이고 적용 시작일이 «오늘보다 뒤»일 때만(취소하면 원장에게 알린다).
 *   적용일 당일부터는 cron 이 반영했거나 반영하는 중이라 학부모가 되돌리지 못한다.
 * 서버(cancelRegularChangeRequest)가 같은 조건을 SQL 로 다시 건다.
 */
export function canCancelRegularChange(row: { status: string; effectiveFrom?: string | null }, today?: string): boolean {
  if (row.status === "PENDING") return true;
  if (row.status === "APPROVED") return Boolean(today && row.effectiveFrom && row.effectiveFrom > today);
  return false;
}

export type RegularChangeApplyPlan =
  /** 아직 적용일 전 — 기다린다 */
  | { action: "WAIT" }
  /** 위치 바꾸기 — 기존 관리자 반영 함수로 명단 정류장을 맞춘다 */
  | { action: "APPLY_LOCATION" }
  /** 이용 시작·중단 — 원장이 명단을 고쳤으면 닫는다(자동으로 넣거나 빼지 않는다) */
  | { action: "CLOSE" }
  | { action: "KEEP_OPEN"; reason: string };

/**
 * 승인된 신청을 지금 어떻게 할지.
 * - 위치 바꾸기: 적용일이 되면 명단에 반영(순서·시각은 건드리지 않는다 — 기존 위치 반영 규칙 그대로).
 * - 이용 시작: 자리를 정하는 일(차량·순서·시각)은 사람이 한다 → 명단에 그 요일이 올라 있으면 끝.
 * - 이용 중단: 명단에서 빼는 일도 원장 화면에서 한다 → 그 요일·방향 칸이 없으면 끝.
 */
export function planRegularChangeApply(input: {
  kind: string;
  effectiveFrom: string;
  today: string;
  directions: readonly string[];
  weekdays: readonly number[] | null;
  roster: ReadonlyArray<{ weekday: number; direction: RegularChangeDirection }>;
}): RegularChangeApplyPlan {
  if (input.effectiveFrom > input.today) return { action: "WAIT" };
  if (input.kind === "CHANGE") return { action: "APPLY_LOCATION" };
  const inScope = input.roster.filter((r) =>
    input.directions.includes(r.direction) && (!input.weekdays || input.weekdays.includes(r.weekday)));
  if (input.kind === "START") {
    // 신청한 «요일 × 방향» 칸이 «전부» 명단에 올라야 끝이다(2026-11-15 리뷰 M1).
    // 일부 요일만 넣었거나, 예전부터 타던 칸이 하나 있다는 이유로 닫히면 원장 할 일이 목록에서 사라진다.
    // (요일이 비어 있는 옛 신청은 칸을 특정할 수 없어 «하나라도 있으면»으로 본다 — 새 신청은 접수 때 요일을 확정해 담는다.)
    const missing = (input.weekdays ?? []).flatMap((weekday) => input.directions
      .filter((direction) => !input.roster.some((r) => r.weekday === weekday && r.direction === direction))
      .map((direction) => `${weekdayLabel(weekday)} ${direction === "PICKUP" ? "등원" : "하원"}`));
    const done = input.weekdays ? missing.length === 0 : inScope.length > 0;
    return done ? { action: "CLOSE" }
      : { action: "KEEP_OPEN", reason: `셔틀 명단에 아직 없음${missing.length > 0 ? `(${missing.join(", ")})` : ""} — 명단에 추가해 주세요` };
  }
  if (input.kind === "STOP") {
    return inScope.length === 0 ? { action: "CLOSE" } : { action: "KEEP_OPEN", reason: "셔틀 명단에 아직 있음 — 명단에서 빼 주세요" };
  }
  return { action: "KEEP_OPEN", reason: "지원하지 않는 신청" };
}
