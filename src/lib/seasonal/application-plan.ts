/**
 * 방학특강 신청 저장 전 «판단»만 모은 순수 함수(2026-11-18 기간 선택·날짜별 선택).
 *
 * 왜 따로 두는가: service.ts 는 DB 거래 안에서 돌아 테스트로 바로 실행하기 어렵다.
 *   가격 선택(기간/날짜)·제목 스냅샷·요일 채우기·날짜 검사처럼 «틀리면 돈·출석이 어긋나는» 판단을
 *   여기로 빼서 node --test 로 직접 돌려 본다.
 * ⚠️ prisma import 금지. 날짜·요일은 kst.ts 만 쓴다(getDay·toISOString 금지).
 */
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { kstDow, toKstYmd } from "../datetime/kst.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { pickSessionDatesForApplication, type SeasonalAttendanceRule } from "./attendance-rule.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { SeasonalError, type SeasonalWeekday } from "./contracts.ts";
import type { OfferingPeriodLike } from "./period-pricing";

// kstDow 결과(0=일 … 6=토)를 요일 키로
const WEEKDAY_BY_DOW: readonly SeasonalWeekday[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
// 신청서에 저장하는 요일 순서(월→일) — 화면·기존 데이터와 같은 순서
const WEEKDAY_ORDER: readonly SeasonalWeekday[] = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/**
 * 고른 날짜들의 요일(중복 제거, 월→일 순).
 * 왜: 날짜 모드 신청서도 selectedWeekdays 를 채워 둬야 한다. 비워 두면 «요일만» 보는 옛 조회가
 *   «요일 없음 = 매일 출석»으로 읽어 모든 회차 명단에 나온다.
 */
export function weekdaysFromDates(dates: readonly string[]): SeasonalWeekday[] {
  const found = new Set<SeasonalWeekday>();
  for (const ymd of dates) {
    const dow = kstDow(ymd);
    if (Number.isInteger(dow)) found.add(WEEKDAY_BY_DOW[dow]);
  }
  return WEEKDAY_ORDER.filter((weekday) => found.has(weekday));
}

/** 반 이름에서 «주N회»를 뺀 이름. 예: "슈팅 주2회" → "슈팅". 다 지워지면 원래 이름. */
export function stripWeeklyFrequency(title: string): string {
  const stripped = title.replace(/\s*주\s*\d+\s*회\s*/g, " ").replace(/\s+/g, " ").trim();
  return stripped || title.trim();
}

/**
 * 신청 항목 제목 스냅샷(문자·관리자 목록에 그대로 쓰인다).
 *   날짜 모드 → «{주N회 뺀 이름} 날짜 선택 N회»
 *   기간 있음 → «{반 이름} ({기간 이름})»
 *   그 밖     → 반 이름 그대로(기존과 같음)
 */
export function itemTitleSnapshot(
  offeringTitle: string,
  plan: { mode: "WEEKDAY" | "DATE"; dateCount?: number; periodLabel?: string | null },
): string {
  if (plan.mode === "DATE") return `${stripWeeklyFrequency(offeringTitle)} 날짜 선택 ${plan.dateCount ?? 0}회`;
  if (plan.periodLabel) return `${offeringTitle} (${plan.periodLabel})`;
  return offeringTitle;
}

/** 켜진 기간만, 표시 순서대로. */
export function activePeriods<T extends OfferingPeriodLike>(periods: readonly T[] | null | undefined): T[] {
  return [...(periods ?? [])]
    .filter((period) => period.isActive !== false)
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.startDate.localeCompare(b.startDate));
}

/**
 * 요일 모드에서 이 반에 적용할 기간 고르기.
 * - 반에 켜진 기간이 없다: 기간을 안 보냈으면 null(기존 반 가격), 보냈으면 409 PERIOD_PRICE_NOT_CONFIGURED
 * - 기간을 보냈다: 시작·종료가 같은 줄, 없으면 409 PERIOD_PRICE_NOT_CONFIGURED
 * - 안 보냈다: 1개뿐이면 그 기간 자동 적용, 2개 이상이면 400 PERIOD_REQUIRED
 */
export function pickOfferingPeriod<T extends OfferingPeriodLike>(
  periods: readonly T[] | null | undefined,
  requested: { startDate?: string | null; endDate?: string | null },
): T | null {
  const active = activePeriods(periods);
  const wanted = requested.startDate && requested.endDate ? { start: requested.startDate, end: requested.endDate } : null;
  if (active.length === 0) {
    if (!wanted) return null;
    throw periodPriceNotConfigured();
  }
  if (wanted) {
    const matched = active.find((period) => period.startDate === wanted.start && period.endDate === wanted.end);
    if (!matched) throw periodPriceNotConfigured();
    return matched;
  }
  if (active.length === 1) return active[0];
  throw new SeasonalError("수강 기간을 골라 주세요.", 400, "PERIOD_REQUIRED");
}

function periodPriceNotConfigured() {
  return new SeasonalError("선택한 기간·요일 수에 맞는 수강료가 아직 설정되지 않았습니다.", 409, "PERIOD_PRICE_NOT_CONFIGURED");
}

/** 회차 목록 → 회차가 있는 KST 날짜 집합. */
export function sessionDateKeys(sessionDates: ReadonlyArray<{ startsAt: Date | string }>): Set<string> {
  const keys = new Set<string>();
  for (const session of sessionDates) {
    const ymd = toKstYmd(session.startsAt);
    if (ymd) keys.add(ymd);
  }
  return keys;
}

/**
 * 날짜 모드 검사 — 고른 날짜가 모두 그 반 범위의 실제 회차 날짜이고, 오늘(KST) 이전이 아닌가.
 *   실제 회차가 아닌 날짜 → 409 DATE_NOT_OFFERED, 지난 날짜 → 400 DATE_IN_PAST
 */
export function assertSelectableDates(
  selectedDates: readonly string[],
  scopeSessionDates: ReadonlyArray<{ startsAt: Date | string }>,
  todayYmd: string,
): void {
  const offered = sessionDateKeys(scopeSessionDates);
  if (selectedDates.some((ymd) => !offered.has(ymd))) {
    throw new SeasonalError("고른 날짜 중 수업이 없는 날이 있습니다. 날짜를 다시 골라 주세요.", 409, "DATE_NOT_OFFERED");
  }
  if (selectedDates.some((ymd) => ymd < todayYmd)) {
    throw new SeasonalError("이미 지난 날짜는 신청할 수 없습니다.", 400, "DATE_IN_PAST");
  }
}

/**
 * 요일 모드 + 기간 검사 — 고른 요일마다 그 기간 안에 회차가 하나 이상 있는가.
 * 없으면 409 PERIOD_WEEKDAY_NOT_OFFERED(그 기간엔 그 요일 수업이 없다).
 */
export function assertPeriodHasWeekdays(
  scopeSessionDates: ReadonlyArray<{ id: string; startsAt: Date | string }>,
  selectedWeekdays: readonly SeasonalWeekday[],
  period: { startDate: string; endDate: string },
): void {
  for (const weekday of selectedWeekdays) {
    const hits = pickSessionDatesForApplication(scopeSessionDates, {
      selectedWeekdays: [weekday],
      periodStartDate: period.startDate,
      periodEndDate: period.endDate,
    });
    if (hits.length === 0) {
      throw new SeasonalError("선택한 기간에 고른 요일 수업이 없습니다. 기간이나 요일을 다시 골라 주세요.", 409, "PERIOD_WEEKDAY_NOT_OFFERED");
    }
  }
}

/** 이 신청서(규칙)가 차지할 KST 날짜 목록(오름차순·중복 없음). 정원 판정에 쓴다. */
export function occupiedDateKeys(
  sessionDates: ReadonlyArray<{ id: string; startsAt: Date | string }>,
  rule: SeasonalAttendanceRule,
): string[] {
  return [...sessionDateKeys(pickSessionDatesForApplication(sessionDates, rule))].sort();
}

const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** 'YYYY-MM-DD' → «1월 12일(화)». 잘못된 값이면 그대로 돌려준다. (화면·서버 안내 문구 공용) */
export function ymdKoreanLabel(ymd: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  const dow = kstDow(ymd);
  if (!match || !Number.isInteger(dow)) return ymd;
  return `${Number(match[2])}월 ${Number(match[3])}일(${DOW_KO[dow]})`;
}

/** 정원이 찬 날짜 안내 — «1월 12일(화), 1월 14일(목)은 정원이 찼습니다. 이 날짜를 빼고 다시 신청해 주세요.» */
export function datesFullMessage(fullDates: readonly string[]): string {
  return `${fullDates.map(ymdKoreanLabel).join(", ")}은 정원이 찼습니다. 이 날짜를 빼고 다시 신청해 주세요.`;
}

/** 날짜별 인원표에서 정원 이상인 날짜(오름차순). 정원이 없으면(null) 빈 배열. */
export function fullDateKeysFromOccupancy(
  occupancy: ReadonlyMap<string, number>,
  capacity: number | null | undefined,
  onlyDates?: readonly string[],
): string[] {
  if (capacity === null || capacity === undefined) return [];
  const keys = onlyDates ? [...new Set(onlyDates)] : [...occupancy.keys()];
  return keys.filter((ymd) => (occupancy.get(ymd) ?? 0) >= capacity).sort();
}
