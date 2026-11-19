/**
 * 방학특강 기간 상품·날짜별 선택 가격 계산(2026-11-18) — 순수 함수만.
 *
 * 왜 따로 두는가: 신청 화면(미리 보기 금액)과 서버(확정 금액 스냅샷)가 같은 계산을 해야 한다.
 *   한쪽만 고치면 «화면 금액 ≠ 청구 금액» 사고가 나므로 여기 한 곳에서만 계산한다.
 * ⚠️ prisma import 금지(클라이언트에서도 쓴다).
 */
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { SeasonalError } from "./contracts.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { kstHm, kstLabel } from "../datetime/kst.ts";
import type { ApplicantType } from "./planning";

/**
 * 신청자 구분의 화면 이름(2026-11-19 원장 «기존·신규는 헷갈리니 재원생·신입생으로»).
 *   재원생(EXISTING) = 지금 정규반 수업을 들으면서 방학특강도 듣는 학생
 *   신입생(NEW)      = 그 밖의 학생(정규반 휴원 중 포함)
 * 코드 값(EXISTING/NEW)은 그대로 두고 «보이는 글자»만 이 한 곳에서 정한다.
 */
export const APPLICANT_TYPE_LABEL: Record<ApplicantType, string> = { EXISTING: "재원생", NEW: "신입생" };

/** 신청자 구분 값 → «재원생»/«신입생». 모르는 값이면 fallback(기본 빈 글자). */
export function applicantTypeLabel(value: string | null | undefined, fallback = ""): string {
  return value === "EXISTING" || value === "NEW" ? APPLICANT_TYPE_LABEL[value] : fallback;
}

/** 반별 기간 상품 한 줄(SpecialProgramOfferingPeriod 행과 같은 모양). */
export type OfferingPeriodLike = {
  id?: string;
  label: string;
  startDate: string;
  endDate: string;
  price: number;
  newApplicantPrice?: number | null;
  existingApplicantPrice?: number | null;
  /** NULL 이면 반의 셔틀비를 쓴다. */
  shuttleFee?: number | null;
  displayOrder?: number | null;
  isActive?: boolean | null;
  /** 이 기간의 신청 마감 시각(2026-11-18). NULL 이면 시즌 마감을 따른다. */
  applicationClosesAt?: Date | string | null;
};

/** 셔틀비 판정에 필요한 반 정보. */
export type PeriodShuttleOffering = { shuttleAvailable: boolean; shuttleFee?: number | null };

/**
 * 기간별 신청 마감 판정(2026-11-18 원장 «1차 마감은 모두 시작 전주 금요일 6시»).
 * 마감 시각이 없으면(NULL) 시즌 마감을 따른다 → 여기서는 false.
 * 경계: 마감 시각 «그 순간부터» 닫힌다(17:59:59 는 받고 18:00:00 은 거절).
 */
export function isPeriodClosed(
  period: { applicationClosesAt?: Date | string | null },
  nowMs: number = Date.now(),
): boolean {
  if (!period.applicationClosesAt) return false;
  const closesMs = new Date(period.applicationClosesAt).getTime();
  return Number.isFinite(closesMs) && nowMs >= closesMs;
}

/** 고른 기간의 신청이 마감됐을 때의 안내(409 PERIOD_CLOSED). */
export function periodClosedError(label?: string | null): SeasonalError {
  return new SeasonalError(`${label?.trim() ? `«${label.trim()}» 기간은` : "고른 기간은"} 신청이 마감되었습니다. 다른 기간을 골라 주세요.`, 409, "PERIOD_CLOSED");
}

/** 주N회 고르기 칸의 이름 — 5회는 «매일(주5회)», 그 밖은 «주N회». */
export function weeklyFrequencyLabel(frequency: number): string {
  return frequency === 5 ? "매일(주5회)" : `주${frequency}회`;
}

/** 기간 수강료 — planning.ts resolveOfferingPrice 와 같은 규칙(신입생/재원생 값이 있으면 그 값, 없으면 기본가). */
export function resolvePeriodPrice(period: OfferingPeriodLike, applicantType?: ApplicantType): number {
  if (applicantType === "NEW" && period.newApplicantPrice !== null && period.newApplicantPrice !== undefined) {
    return period.newApplicantPrice;
  }
  if (applicantType === "EXISTING" && period.existingApplicantPrice !== null && period.existingApplicantPrice !== undefined) {
    return period.existingApplicantPrice;
  }
  return period.price;
}

/**
 * 기간 셔틀비 — 셔틀 신청 안 함·반이 셔틀 불가·무료 거점이면 0.
 * 기간 셔틀비가 NULL 이면 반의 셔틀비(planning.ts resolveShuttleFee 와 같은 규칙).
 */
export function resolvePeriodShuttleFee(
  period: Pick<OfferingPeriodLike, "shuttleFee">,
  offering: PeriodShuttleOffering,
  shuttleRequested: boolean,
  isFreeHub = false,
): number {
  if (!shuttleRequested || !offering.shuttleAvailable) return 0;
  if (isFreeHub) return 0; // 무료 탑승 거점 이용 학생은 셔틀비를 받지 않는다
  const fee = period.shuttleFee ?? offering.shuttleFee ?? 0;
  return Math.max(0, fee);
}

/**
 * 남은 회차만큼 받는 금액(2026-11-18 원장 «중간 합류는 남은 회차만큼»).
 * = 정상 금액 × (남은 필요 횟수 ÷ 시작 전 기준 전체 필요 횟수), **100원 단위 내림**.
 *   예: 240,000 × 3/8 = 90,000 · 240,000 × 6/8 = 180,000 · 100,000 × 1/3 = 33,333 → 33,300.
 * 비율이 1 이상(시작 전 신청)이거나 전체 횟수를 모르면(0 이하) 정상 금액 그대로(내림도 안 한다).
 * 수강료·셔틀비 둘 다 이 함수로 줄인다. 화면 미리보기와 서버 스냅샷이 같은 함수를 쓴다.
 */
export function proratedPrice(full: number, remainingCount: number, fullCount: number): number {
  if (!Number.isFinite(full) || full <= 0) return Math.max(0, Number.isFinite(full) ? full : 0);
  if (!Number.isFinite(fullCount) || fullCount <= 0 || remainingCount >= fullCount) return full;
  if (!Number.isFinite(remainingCount) || remainingCount <= 0) return 0;
  // 정수 곱 → 나눗셈 → 100원 내림(금액은 정수, 소수 오차는 floor 가 아래로만 깎는다)
  return Math.floor((full * remainingCount) / (fullCount * 100)) * 100;
}

// 날짜별 선택 수강료(회당 단가 × 횟수, dateSelectTuition)는 2026-11-18 원장 결정으로 없앴다.
// 날짜로 골라도 «그 주N회 반의 기간 가격»(요일 모드와 같은 resolvePeriodPrice / 반 가격)을 받는다 — 같은 규칙 두 벌 금지.

/**
 * 켜진(isActive=true) 기간 행 수 — 꺼진 행(isActive=false)은 «없는 것»으로 본다.
 * isActive 가 비어 있으면(옛 데이터·화면 값) 켜진 것으로 센다(DB 기본값 true 와 같다).
 */
export function countActivePeriods(periods: ReadonlyArray<Pick<OfferingPeriodLike, "isActive">> | null | undefined): number {
  return (periods ?? []).filter((period) => period.isActive !== false).length;
}

/** 신청서 하나가 기간·날짜를 골랐는가(고른 날짜가 있거나 기간 시작/끝이 적혀 있으면 true). */
export function applicationUsesPeriodOrDate(rule: {
  selectionMode?: string | null;
  selectedDates?: readonly string[] | null;
  periodStartDate?: string | null;
  periodEndDate?: string | null;
} | null | undefined): boolean {
  if (!rule) return false;
  return rule.selectionMode === "DATE"
    || (Array.isArray(rule.selectedDates) && rule.selectedDates.length > 0)
    || Boolean(rule.periodStartDate)
    || Boolean(rule.periodEndDate);
}

/**
 * «새 기능(기간 선택·날짜별 선택) 시즌인가» — 공개 신청·관리자 승인·보강 정원·출석부가 **이 함수 하나**로 판정한다.
 * (2026-11-18 검수 M-2: 네 곳의 기준이 서로 달라 같은 반을 다른 잣대로 셌다.)
 *
 * 기준: 시즌의 날짜별 선택이 켜졌거나 · 같은 운영 범위에 켜진 기간 행이 하나라도 있거나 ·
 *       (알 수 있는 곳에서는) 기간/날짜를 고른 신청서가 있으면 true.
 * 기존 시즌(켜진 기간 행 0개·날짜 선택 꺼짐·기간/날짜 고른 신청 없음)은 언제나 false → 예전 요일 계산 그대로.
 */
export function usesPeriodOrDateFeatures(params: {
  dateSelectEnabled?: boolean | null;
  /** 같은 운영 범위의 «켜진(isActive=true)» 기간 행 수. 꺼진 행은 세지 않는다. */
  activePeriodCount: number;
  applicationsUsePeriodOrDate?: boolean;
}): boolean {
  return params.dateSelectEnabled === true
    || params.activePeriodCount > 0
    || params.applicationsUsePeriodOrDate === true;
}

/**
 * 한 신청서에 담긴 반들의 «기간 표시»가 서로 다른가.
 * 값 = 항목별 기간 키(예: "2027-01-04|2027-01-29"), 기간 없는 반은 null/"".
 * 반이 하나뿐이면 언제나 false(섞일 수 없다).
 */
export function hasPeriodMix(keys: ReadonlyArray<string | null | undefined>): boolean {
  return new Set(keys.map((key) => key ?? "")).size > 1;
}

/**
 * 기간 있는 반·없는 반이 섞였거나 항목마다 기간이 다를 때의 안내(검수 L-1).
 * «가격이 없다»(PERIOD_PRICE_NOT_CONFIGURED)와 구분해 학부모가 무엇을 바꿔야 할지 알게 한다.
 */
export function periodMixedOfferingsError(): SeasonalError {
  return new SeasonalError("같은 수강 기간으로 신청할 수 있는 수업만 함께 골라 주세요.", 409, "PERIOD_MIXED_OFFERINGS");
}

/** 시즌 전체에서 고를 수 있는 기간 목록 한 줄. */
export type DistinctPeriod = {
  label: string;
  startDate: string;
  endDate: string;
  displayOrder: number;
  /** 이 범위의 가장 이른 신청 마감 시각(ISO). 없으면 null = 시즌 마감을 따른다. */
  applicationClosesAt: string | null;
};

/**
 * 여러 반의 기간 상품을 (시작일, 종료일)로 묶어 «학부모가 고르는 기간» 목록을 만든다.
 * 꺼진 기간(isActive=false)은 뺀다. 같은 범위면 표시 순서가 가장 앞선 줄의 이름을 쓴다.
 * 마감 시각은 같은 범위 중 «가장 이른» 값(안전한 쪽 — 서버는 실제 반의 기간 행으로 다시 판정한다).
 * 정렬: displayOrder → label.
 */
export function distinctPeriods(
  offerings: ReadonlyArray<{ periods?: readonly OfferingPeriodLike[] | null }>,
): DistinctPeriod[] {
  const byRange = new Map<string, DistinctPeriod>();
  for (const offering of offerings) {
    for (const period of offering.periods ?? []) {
      if (period.isActive === false) continue;
      const key = `${period.startDate}|${period.endDate}`;
      const closesAt = period.applicationClosesAt ? new Date(period.applicationClosesAt) : null;
      const closesIso = closesAt && Number.isFinite(closesAt.getTime()) ? closesAt.toISOString() : null;
      const candidate: DistinctPeriod = {
        label: period.label,
        startDate: period.startDate,
        endDate: period.endDate,
        displayOrder: period.displayOrder ?? 0,
        applicationClosesAt: closesIso,
      };
      const prev = byRange.get(key);
      // 같은 범위가 여러 반에 있으면 순서가 앞선(같으면 이름이 앞선) 것을 대표로
      const chosen = !prev || comparePeriods(candidate, prev) < 0 ? candidate : prev;
      // 마감 시각은 둘 중 이른 것(ISO 문자열은 글자 비교가 곧 시각 비교)
      const closes = [prev?.applicationClosesAt, closesIso].filter((value): value is string => Boolean(value)).sort()[0] ?? null;
      byRange.set(key, { ...chosen, applicationClosesAt: closes });
    }
  }
  return [...byRange.values()].sort(comparePeriods);
}

function comparePeriods(a: DistinctPeriod, b: DistinctPeriod): number {
  if (a.displayOrder !== b.displayOrder) return a.displayOrder - b.displayOrder;
  return a.label.localeCompare(b.label, "ko");
}

/**
 * 반 이름·코드에서 «주N회»를 읽는다(service.ts seasonalOfferingFrequency 와 같은 정규식).
 * 예: "슈팅 주2회" → 2, 코드 "SHOOT-3" → 3. 못 읽으면 null.
 */
export function offeringWeeklyFrequency(offering: { title?: string | null; code?: string | null }): number | null {
  const matched = `${offering.title ?? ""} ${offering.code ?? ""}`.match(/주\s*(\d+)\s*회|-(\d)(?:\D|$)/i);
  const value = matched ? Number(matched[1] ?? matched[2]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 기간 한 줄 요약(2026-11-19 원장 «4주와 3주의 재원생가·신입생가가 제대로 세팅된 건지 안 보여»).
 *   예: «4주 · 신입생 240,000원 · 재원생 200,000원 · 셔틀 10,000원 · 마감 1/1(금) 18:00»
 * 칸을 비워 «기본»을 쓰는 경우에도 실제로 적용되는 금액(resolvePeriodPrice)을 보여 준다 — 신청 화면이 받는 값과 같다.
 * 셔틀: 반이 셔틀 불가면 뺀다. 기간 셔틀비가 비면 반 셔틀비. 마감: 비면 «마감 = 시즌 모집 마감».
 */
export function periodPriceSummary(
  period: OfferingPeriodLike,
  offering?: { shuttleAvailable?: boolean | null; shuttleFee?: number | null } | null,
): string {
  const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;
  const parts = [
    period.label?.trim() || `${period.startDate}~${period.endDate}`,
    `신입생 ${won(resolvePeriodPrice(period, "NEW"))}`,
    `재원생 ${won(resolvePeriodPrice(period, "EXISTING"))}`,
  ];
  if (offering?.shuttleAvailable) parts.push(`셔틀 ${won(Math.max(0, period.shuttleFee ?? offering.shuttleFee ?? 0))}`);
  // 마감 시각은 KST 로 읽는다(서버·휴대폰 시간대가 달라도 같은 글자)
  const closes = period.applicationClosesAt ? new Date(period.applicationClosesAt) : null;
  const closesText = closes && Number.isFinite(closes.getTime()) ? `${kstLabel(closes)} ${kstHm(closes)}` : "";
  parts.push(closesText ? `마감 ${closesText}` : "마감 = 시즌 모집 마감");
  return parts.join(" · ");
}
