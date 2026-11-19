/**
 * 방학특강 신청 저장 전 «판단»만 모은 순수 함수(2026-11-18 기간 선택·날짜별 선택).
 *
 * 왜 따로 두는가: service.ts 는 DB 거래 안에서 돌아 테스트로 바로 실행하기 어렵다.
 *   가격 선택(기간/날짜)·제목 스냅샷·요일 채우기·날짜 검사처럼 «틀리면 돈·출석이 어긋나는» 판단을
 *   여기로 빼서 node --test 로 직접 돌려 본다.
 * ⚠️ prisma import 금지. 날짜·요일은 kst.ts 만 쓴다(getDay·toISOString 금지).
 */
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { addDaysKst, kstDow, kstWeekMonday, toKstYmd } from "../datetime/kst.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { pickSessionDatesForApplication, type SeasonalAttendanceRule } from "./attendance-rule.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { SeasonalError, type SeasonalWeekday } from "./contracts.ts";
import type { OfferingPeriodLike } from "./period-pricing";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { isPeriodClosed } from "./period-pricing.ts";
// 반 이름의 횟수 빼기 규칙(«반 = 교시 하나» 묶음과 같은 함수 · 2026-11-19)
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { offeringBaseTitle } from "./offering-groups.ts";

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

/**
 * 반 이름에서 «주N회»를 뺀 이름. 예: "슈팅 주2회" → "슈팅". 다 지워지면 원래 이름.
 * «매일(주5회)»도 통째로 뺀다(2026-11-19 — 예전엔 «매일( )»이 남았다). 규칙은 offering-groups 한 곳.
 */
export function stripWeeklyFrequency(title: string): string {
  return offeringBaseTitle(title);
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
  // 날짜 모드도 기간을 고를 수 있다(2026-11-18) — 기간이 있으면 «(4주)»를 붙인다
  if (plan.mode === "DATE") return `${stripWeeklyFrequency(offeringTitle)} 날짜 선택 ${plan.dateCount ?? 0}회${plan.periodLabel ? ` (${plan.periodLabel})` : ""}`;
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
 * 날짜 모드에서 고를 수 있는 첫 날짜(2026-11-19 원장 결정 «마감 뒤 중간 합류는 내일 수업부터»).
 *   - 마감 뒤 중간 합류(lateJoin=true) → 기준일 «다음 날». 오늘 수업은 이미 시작됐거나 준비가 안 돼 받지 않는다.
 *   - 마감 전 정상 신청(lateJoin=false) → 기준일 그대로(오늘 포함 — 예전 동작 그대로).
 * 기준일 = 공개 신청은 오늘(KST), 관리자 재배정은 그 신청서의 접수일.
 * 화면(날짜 목록·필요 횟수)·서버(필요 횟수·날짜 검사)·관리자 재배정 금액이 이 함수 하나를 쓴다.
 */
export function firstSelectableYmd(baseYmd: string, lateJoin: boolean): string {
  if (!lateJoin) return baseYmd;
  return addDaysKst(baseYmd, 1) || baseYmd; // 날짜를 못 읽으면 기준일 그대로(더 막지 않는다)
}

/**
 * 접수 시각 기준으로 «마감 뒤 중간 합류»였는가 — 공개 신청 service.ts 와 같은 규칙.
 *   기간 마감: 마감 시각 «그 순간부터»(isPeriodClosed) · 시즌 모집 마감: 마감 시각이 «지난 뒤»(now > closesAt).
 * 관리자 재배정이 접수일 기준 남은 회차를 셀 때 쓴다.
 */
export function wasLateJoinAt(
  appliedAtMs: number,
  seasonClosesAt: Date | string | null | undefined,
  period?: { applicationClosesAt?: Date | string | null } | null,
): boolean {
  if (!Number.isFinite(appliedAtMs)) return false;
  if (period && isPeriodClosed(period, appliedAtMs)) return true;
  if (!seasonClosesAt) return false;
  const seasonMs = new Date(seasonClosesAt).getTime();
  return Number.isFinite(seasonMs) && appliedAtMs > seasonMs;
}

/**
 * 날짜 모드 검사 — 고른 날짜가 모두 그 반 범위의 실제 회차 날짜이고, 오늘(KST) 이전이 아닌가.
 *   실제 회차가 아닌 날짜 → 409 DATE_NOT_OFFERED, 지난 날짜 → 400 DATE_IN_PAST
 *   firstYmd(중간 합류면 내일)보다 앞선 날짜 → 400 DATE_BEFORE_LATE_JOIN(«내일 수업부터»)
 */
export function assertSelectableDates(
  selectedDates: readonly string[],
  scopeSessionDates: ReadonlyArray<{ startsAt: Date | string }>,
  todayYmd: string,
  firstYmd: string = todayYmd,
): void {
  const offered = sessionDateKeys(scopeSessionDates);
  if (selectedDates.some((ymd) => !offered.has(ymd))) {
    throw new SeasonalError("고른 날짜 중 수업이 없는 날이 있습니다. 날짜를 다시 골라 주세요.", 409, "DATE_NOT_OFFERED");
  }
  if (selectedDates.some((ymd) => ymd < todayYmd)) {
    throw new SeasonalError("이미 지난 날짜는 신청할 수 없습니다.", 400, "DATE_IN_PAST");
  }
  // 마감 뒤 중간 합류는 오늘 수업을 고를 수 없다(내일 수업부터)
  if (selectedDates.some((ymd) => ymd < firstYmd)) {
    throw new SeasonalError("마감 뒤 중간 합류는 내일 수업부터 고를 수 있습니다. 오늘 날짜를 빼고 다시 골라 주세요.", 400, "DATE_BEFORE_LATE_JOIN");
  }
}

/**
 * 날짜 모드의 «채워야 할 횟수»(2026-11-18 원장 결정 — 주N회 총 횟수를 날짜로 채우기).
 *
 * 규칙: 기간(없으면 시즌 전체) 안의 실제 회차 날짜를 KST ISO 주(월요일 시작)로 묶고,
 *       회차가 있는 주마다 min(N, 그 주 회차 날짜 수)를 더한다.
 *   - 주마다 N회 이상 수업이 있으면 = N × (회차가 있는 주의 수). 예: 4주 주2회 = 8회.
 *   - 회차가 없는 주(설 연휴 주)는 세지 않는다. 예: 2차 2/1~2/5 + 2/15~2/26 주2회 = 3주 × 2 = 6회.
 *   - 한 주 수업이 N회보다 적으면(공휴일) 그 주는 있는 만큼만 센다 → 주5회는 «기간 전 회차».
 * 같은 날 회차가 둘이어도 날짜 하나로 센다(학생은 날짜를 고른다).
 * 화면(남은 횟수 안내)과 서버(DATE_COUNT_MISMATCH)가 이 함수 하나를 쓴다.
 *
 * todayYmd(2026-11-18 원장 «중간 합류는 남은 회차만큼»): 주면 그 날짜(포함) 이후 회차만 센다.
 *   마감 뒤 중간 합류는 호출부가 firstSelectableYmd(오늘, true) = «내일»을 넘긴다(2026-11-19 원장 «내일 수업부터»).
 *   이미 지난 날짜는 고를 수 없으니(DATE_IN_PAST) 필요 횟수에서도 뺀다. 주마다 min(N, 그 주 «남은» 회차 수).
 *   기간 시작 전이면 지난 회차가 없어 결과가 예전과 같다. 비우면(undefined) 전체 = «시작 전 기준 전체 필요 횟수».
 */
export function requiredDateCount(
  sessionDates: ReadonlyArray<{ startsAt: Date | string }>,
  weeklyFrequency: number,
  period?: { startDate: string; endDate: string } | null,
  todayYmd?: string | null,
): number {
  if (!Number.isInteger(weeklyFrequency) || weeklyFrequency <= 0) return 0;
  // 주(월요일) → 그 주의 회차 날짜 집합
  const byWeek = new Map<string, Set<string>>();
  for (const ymd of sessionDateKeys(sessionDates)) {
    if (period && (ymd < period.startDate || ymd > period.endDate)) continue;
    // 오늘보다 앞선 회차는 지난 수업 — 남은 회차만 센다(오늘은 포함)
    if (todayYmd && ymd < todayYmd) continue;
    const monday = kstWeekMonday(ymd);
    if (!monday) continue;
    const week = byWeek.get(monday) ?? new Set<string>();
    week.add(ymd);
    byWeek.set(monday, week);
  }
  let total = 0;
  for (const week of byWeek.values()) total += Math.min(weeklyFrequency, week.size);
  return total;
}

/**
 * 반 이름에 «주N회»가 없을 때 고른 날짜 수로 주N회를 거꾸로 찾는다(관리자 재배정 금액용 · 검수 M-1).
 * 규칙: N = 1~7 중 requiredDateCount(회차, N, 기간, 기준일) === 고른 날짜 수 가 되는 «가장 작은» N.
 *   requiredDateCount 는 N 이 커질수록 줄지 않으므로(주마다 min(N, 그 주 회차 수)) 가장 작은 N 이 공개 신청에서
 *   학부모가 골랐을 주N회와 같은 필요 횟수를 준다(필요 횟수가 같으면 금액 비율도 같다).
 * 못 찾으면 null — 호출부는 지금처럼 비율 없이 정상 금액을 쓴다.
 */
export function inferWeeklyFrequency(
  sessionDates: ReadonlyArray<{ startsAt: Date | string }>,
  selectedCount: number,
  period?: { startDate: string; endDate: string } | null,
  appliedOnYmd?: string | null,
): number | null {
  if (!Number.isInteger(selectedCount) || selectedCount <= 0) return null;
  for (let frequency = 1; frequency <= 7; frequency += 1) {
    if (requiredDateCount(sessionDates, frequency, period, appliedOnYmd) === selectedCount) return frequency;
  }
  return null;
}

/**
 * 중간 합류(마감 뒤 날짜 모드)를 아직 받을 수 있는가(2026-11-18 원장 결정).
 * 규칙: 그 기간(없으면 시즌 전체)의 «마지막 회차 날짜 전날 23:59(KST)»까지 받는다
 *   = 오늘(KST)보다 «뒤»의 회차 날짜가 하나라도 있으면 true. 마지막 회차 당일은 이미 수업 날이라 받지 않는다.
 * 마감 전(요일 모드도 열린 때)에는 이 함수로 막지 않는다 — 마감 뒤에만 쓴다.
 * 화면(마감된 기간·시즌에서 «날짜로 고르기» 살리기)과 서버(409 PERIOD_ENDED)가 이 함수 하나를 쓴다.
 */
export function hasLateJoinDates(
  sessionDates: ReadonlyArray<{ startsAt: Date | string }>,
  todayYmd: string,
  period?: { startDate: string; endDate: string } | null,
): boolean {
  for (const ymd of sessionDateKeys(sessionDates)) {
    if (period && (ymd < period.startDate || ymd > period.endDate)) continue;
    if (ymd > todayYmd) return true;
  }
  return false;
}

/** 남은 수업이 없어 중간 합류도 받을 수 없을 때(409 PERIOD_ENDED). */
export function periodEndedError(): SeasonalError {
  return new SeasonalError("이 기간은 남은 수업이 없습니다.", 409, "PERIOD_ENDED");
}

/** «주2회 4주»·«주3회»처럼 안내 문구에 쓰는 이름. 기간 이름이 없으면 주N회만. */
function frequencyPeriodText(weeklyFrequency: number, periodLabel?: string | null): string {
  return [`주${weeklyFrequency}회`, periodLabel?.trim() || null].filter(Boolean).join(" ");
}

/**
 * 날짜 개수 검사 — 정확히 필요 횟수만큼 골라야 한다(모자라도 넘쳐도 안 된다).
 * 400 DATE_COUNT_MISMATCH «주2회 4주는 8회를 모두 골라 주세요. 지금 5회»
 */
export function assertDateCount(selectedCount: number, required: number, weeklyFrequency: number, periodLabel?: string | null): void {
  if (required <= 0) {
    throw new SeasonalError("고를 수 있는 수업 날짜가 없습니다. 학원에 문의해 주세요.", 409, "DATE_NOT_OFFERED");
  }
  if (selectedCount !== required) {
    throw new SeasonalError(
      `${frequencyPeriodText(weeklyFrequency, periodLabel)}는 ${required}회를 모두 골라 주세요. 지금 ${selectedCount}회`,
      400,
      "DATE_COUNT_MISMATCH",
      { required, selected: selectedCount },
    );
  }
}

/** 날짜 모드 + 기간 — 고른 날짜가 모두 그 기간 안인가. 밖이면 409 DATE_OUTSIDE_PERIOD. */
export function assertDatesInPeriod(selectedDates: readonly string[], period: { startDate: string; endDate: string } | null | undefined): void {
  if (!period) return;
  if (selectedDates.some((ymd) => ymd < period.startDate || ymd > period.endDate)) {
    throw new SeasonalError("고른 수강 기간 밖의 날짜가 있습니다. 기간 안의 날짜만 골라 주세요.", 409, "DATE_OUTSIDE_PERIOD");
  }
}

/** 화면 안내 — «8회 중 5회 선택 · 3회 더 골라 주세요» / 다 채우면 «8회 모두 선택». */
export function dateCountProgressText(selectedCount: number, required: number): string {
  if (selectedCount >= required) return `${required}회 모두 선택`;
  return `${required}회 중 ${selectedCount}회 선택 · ${required - selectedCount}회 더 골라 주세요`;
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

/**
 * 공개 화면 «남은 자리» 3단계용 — 같은 운영 반(묶음) 인원표에서 «가장 찬 날짜»의 인원(2026-11-19 검수).
 *   서버 대기 판정(정원 ≤ 그날 인원 → 대기)과 같은 인원표(countOccupancyByDate)를 쓰므로,
 *   이 값으로 단계를 정하면 «여유인데 대기»가 생기지 않는다. 숫자는 화면에 내보내지 않는다(단계만).
 *   fromYmd 를 주면 그날 이후 날짜만 본다(날짜별 정원 시즌 — 지나간 날의 마감은 신청에 영향이 없다).
 */
export function peakOccupancy(occupancy: ReadonlyMap<string, number>, fromYmd?: string): number {
  let peak = 0;
  for (const [ymd, count] of occupancy) {
    if (fromYmd && ymd < fromYmd) continue;
    if (count > peak) peak = count;
  }
  return peak;
}
