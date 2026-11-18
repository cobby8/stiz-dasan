/**
 * 방학특강 기간 상품·날짜별 선택 가격 계산(2026-11-18) — 순수 함수만.
 *
 * 왜 따로 두는가: 신청 화면(미리 보기 금액)과 서버(확정 금액 스냅샷)가 같은 계산을 해야 한다.
 *   한쪽만 고치면 «화면 금액 ≠ 청구 금액» 사고가 나므로 여기 한 곳에서만 계산한다.
 * ⚠️ prisma import 금지(클라이언트에서도 쓴다).
 */
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { SeasonalError } from "./contracts.ts";
import type { ApplicantType } from "./planning";

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
};

/** 셔틀비 판정에 필요한 반 정보. */
export type PeriodShuttleOffering = { shuttleAvailable: boolean; shuttleFee?: number | null };

/** 날짜별 선택 단가에 필요한 시즌 정보. */
export type DateSelectSeason = {
  perSessionNewPrice?: number | null;
  perSessionExistingPrice?: number | null;
  minSessionCount?: number | null;
};

/** 기간 수강료 — planning.ts resolveOfferingPrice 와 같은 규칙(신규/재원 값이 있으면 그 값, 없으면 기본가). */
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
 * 날짜별 선택 수강료 = 고른 회수 × 회당 단가.
 * - 재원(EXISTING): 재원 단가, 없으면 신규 단가
 * - 신규(NEW)·판정 전(undefined): 신규 단가(재원가로 깎아 주지 않는다)
 * - 최소 횟수 미달 → DATE_SELECT_MIN_COUNT, 단가 미설정 → DATE_SELECT_PRICE_NOT_CONFIGURED
 */
export function dateSelectTuition(
  count: number,
  season: DateSelectSeason,
  applicantType?: ApplicantType,
): { unitPrice: number; tuition: number } {
  const newPrice = season.perSessionNewPrice ?? null;
  const existingPrice = season.perSessionExistingPrice ?? null;
  const unitPrice = applicantType === "EXISTING" ? (existingPrice ?? newPrice) : newPrice;
  if (unitPrice === null || !Number.isInteger(unitPrice) || unitPrice < 0) {
    throw new SeasonalError("날짜별 신청 단가가 아직 정해지지 않았습니다.", 400, "DATE_SELECT_PRICE_NOT_CONFIGURED");
  }
  const minCount = Math.max(1, season.minSessionCount ?? 1);
  if (!Number.isInteger(count) || count < minCount) {
    throw new SeasonalError(`날짜는 ${minCount}회 이상 골라 주세요.`, 400, "DATE_SELECT_MIN_COUNT");
  }
  return { unitPrice, tuition: unitPrice * count };
}

/** 시즌 전체에서 고를 수 있는 기간 목록 한 줄. */
export type DistinctPeriod = { label: string; startDate: string; endDate: string; displayOrder: number };

/**
 * 여러 반의 기간 상품을 (시작일, 종료일)로 묶어 «학부모가 고르는 기간» 목록을 만든다.
 * 꺼진 기간(isActive=false)은 뺀다. 같은 범위면 표시 순서가 가장 앞선 줄의 이름을 쓴다.
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
      const candidate: DistinctPeriod = {
        label: period.label,
        startDate: period.startDate,
        endDate: period.endDate,
        displayOrder: period.displayOrder ?? 0,
      };
      const prev = byRange.get(key);
      // 같은 범위가 여러 반에 있으면 순서가 앞선(같으면 이름이 앞선) 것을 대표로
      if (!prev || comparePeriods(candidate, prev) < 0) byRange.set(key, candidate);
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
