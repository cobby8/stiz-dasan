/**
 * 방학특강 관리자 «기간별 수강료 · 날짜별 선택» 입력 검사와 판단 규칙(2026-11-18) — 순수 함수만.
 *
 * 왜 따로 두는가:
 *   관리자 API(route.ts)는 Next 규칙상 GET/POST 같은 이름만 내보낼 수 있어 그 안의 판단을 테스트할 수 없다.
 *   그래서 «입력 검사·중복 판정·다른 반 복사 계획·날짜→요일 변환·목록 표시 문구»를 여기로 빼서
 *   단위 테스트로 지킨다. 화면(SeasonalAdminClient)도 표시 문구 함수를 같이 쓴다.
 * ⚠️ prisma import 금지(클라이언트에서도 쓴다). 날짜·요일은 kst.ts 만 쓴다(getDay·toISOString 금지).
 */
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { isKstYmd, kstDow } from "../datetime/kst.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { SeasonalError } from "./contracts.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { weekdaysFromDates } from "./application-plan.ts";

/** 관리자가 날짜를 한 번에 고를 수 있는 최대 개수(시즌 전체 회차보다 넉넉하게). */
export const ADMIN_MAX_SELECTED_DATES = 60;

/** 기간 행 저장 값(SpecialProgramOfferingPeriod 와 같은 모양, offeringId 제외). */
export type OfferingPeriodValues = {
  label: string;
  startDate: string;
  endDate: string;
  price: number;
  newApplicantPrice: number | null;
  existingApplicantPrice: number | null;
  /** NULL = 반 셔틀비를 따른다 */
  shuttleFee: number | null;
  displayOrder: number;
  isActive: boolean;
};

// ── 작은 검사 도구 ─────────────────────────────────────────────

function isBlank(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** 0 이상 정수. 숫자 모양 문자열("240000")도 받는다. */
function nonNegativeInt(value: unknown, label: string): number {
  const parsed = typeof value === "string" ? Number(value.trim()) : Number(value);
  if (isBlank(value) || !Number.isInteger(parsed) || parsed < 0) {
    throw new SeasonalError(`${label}은 0 이상의 정수여야 합니다.`, 400, "INVALID_PERIOD_PRICE");
  }
  return parsed;
}

/** 비어 있으면 null, 아니면 0 이상 정수. */
function optionalNonNegativeInt(value: unknown, label: string): number | null {
  if (isBlank(value)) return null;
  return nonNegativeInt(value, label);
}

function cleanLabel(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 60) : "";
}

/** 기간 시작·종료일 검사 — 둘 다 실재하는 'YYYY-MM-DD' 이고 종료 ≥ 시작. */
export function assertPeriodRange(startDate: unknown, endDate: unknown): { startDate: string; endDate: string } {
  const start = typeof startDate === "string" ? startDate.trim() : "";
  const end = typeof endDate === "string" ? endDate.trim() : "";
  if (!isKstYmd(start) || !isKstYmd(end)) {
    throw new SeasonalError("기간 날짜를 YYYY-MM-DD 형식으로 입력해 주세요.", 400, "INVALID_PERIOD_DATE");
  }
  // 'YYYY-MM-DD' 는 글자 비교가 곧 날짜 비교다
  if (end < start) throw new SeasonalError("기간 종료일은 시작일과 같거나 뒤여야 합니다.", 400, "INVALID_PERIOD_RANGE");
  return { startDate: start, endDate: end };
}

/**
 * 기간 행 입력 검사.
 *   before 없음 = 새로 추가(이름·시작일·종료일·기본 수강료 필수)
 *   before 있음 = 수정(보낸 칸만 바꾸고, 최종 날짜 범위를 다시 검사)
 */
export function parseOfferingPeriodInput(
  data: Record<string, unknown>,
  before?: OfferingPeriodValues,
): OfferingPeriodValues {
  const has = (key: string) => data[key] !== undefined;
  const label = has("label") || !before ? cleanLabel(data.label) : before.label;
  if (!label) throw new SeasonalError("기간 이름을 입력해 주세요.", 400, "PERIOD_LABEL_REQUIRED");
  const range = assertPeriodRange(
    has("startDate") || !before ? data.startDate : before.startDate,
    has("endDate") || !before ? data.endDate : before.endDate,
  );
  const price = has("price") || !before ? nonNegativeInt(data.price, "기본 수강료") : before.price;
  const newApplicantPrice = has("newApplicantPrice") ? optionalNonNegativeInt(data.newApplicantPrice, "신규 수강료") : before?.newApplicantPrice ?? null;
  const existingApplicantPrice = has("existingApplicantPrice") ? optionalNonNegativeInt(data.existingApplicantPrice, "재원 수강료") : before?.existingApplicantPrice ?? null;
  const shuttleFee = has("shuttleFee") ? optionalNonNegativeInt(data.shuttleFee, "셔틀비") : before?.shuttleFee ?? null;
  let displayOrder = before?.displayOrder ?? 0;
  if (has("displayOrder")) {
    const parsed = Number(data.displayOrder);
    displayOrder = Number.isInteger(parsed) ? parsed : 0;
  }
  const isActive = has("isActive") ? data.isActive !== false && data.isActive !== "false" : before?.isActive ?? true;
  return { label, ...range, price, newApplicantPrice, existingApplicantPrice, shuttleFee, displayOrder, isActive };
}

/** 같은 반에 같은 범위(시작~종료)가 이미 있는가 — 범위가 «겹치는» 것은 허용(4주 / 앞 3주처럼 나눠 판다). */
export function hasSamePeriodRange(
  existing: ReadonlyArray<{ id?: string; startDate: string; endDate: string }>,
  candidate: { startDate: string; endDate: string },
  selfId?: string,
): boolean {
  // selfId 가 없으면(새 행) id 비교를 하지 않는다 — id 없는 행끼리 undefined === undefined 로 빠지는 일 방지
  return existing.some((row) => (selfId === undefined || row.id !== selfId) && row.startDate === candidate.startDate && row.endDate === candidate.endDate);
}

// ── 같은 수업의 다른 반에 기간 복사 ───────────────────────────────

export type PeriodCopySource = Pick<OfferingPeriodValues, "label" | "startDate" | "endDate" | "displayOrder" | "isActive">;
export type PeriodCopyTarget = {
  id: string;
  title?: string | null;
  price: number;
  newApplicantPrice?: number | null;
  existingApplicantPrice?: number | null;
  periods: ReadonlyArray<{ startDate: string; endDate: string }>;
};
export type PeriodCopyPlan = {
  creates: Array<OfferingPeriodValues & { offeringId: string }>;
  skipped: Array<{ offeringId: string; label: string; reason: "SAME_RANGE_EXISTS" }>;
};

/**
 * 복사 규칙:
 *   - 이름·시작일·종료일·표시 순서·사용 여부만 복사한다.
 *   - 값은 원본 반 값을 쓰지 않는다(주1회 반 값이 주3회 반에 들어가면 안 된다).
 *     대신 «복사받는 반의 지금 반 수강료(기본·신규·재원)»를 기본값으로 넣는다 → 관리자가 줄마다 고친다.
 *   - 셔틀비는 비워 둔다(NULL = 그 반의 셔틀비를 따른다).
 *   - 받는 반에 같은 범위가 이미 있으면 건너뛴다(덮어쓰지 않는다).
 */
export function planPeriodCopy(sources: readonly PeriodCopySource[], targets: readonly PeriodCopyTarget[]): PeriodCopyPlan {
  const plan: PeriodCopyPlan = { creates: [], skipped: [] };
  for (const target of targets) {
    const taken = [...target.periods];
    for (const source of sources) {
      if (hasSamePeriodRange(taken, source)) {
        plan.skipped.push({ offeringId: target.id, label: source.label, reason: "SAME_RANGE_EXISTS" });
        continue;
      }
      plan.creates.push({
        offeringId: target.id,
        label: source.label,
        startDate: source.startDate,
        endDate: source.endDate,
        price: target.price,
        newApplicantPrice: target.newApplicantPrice ?? null,
        existingApplicantPrice: target.existingApplicantPrice ?? null,
        shuttleFee: null,
        displayOrder: source.displayOrder,
        isActive: source.isActive,
      });
      taken.push({ startDate: source.startDate, endDate: source.endDate });
    }
  }
  return plan;
}

// ── 시즌 «날짜별 선택» 설정 ──────────────────────────────────────

export type DateSelectSettings = {
  dateSelectEnabled: boolean;
  perSessionNewPrice: number | null;
  perSessionExistingPrice: number | null;
  minSessionCount: number;
};

/**
 * 시즌 저장 시 날짜별 선택 4칸 검사. 보낸 칸만 돌려준다(시즌 수정 PATCH 와 같은 «부분 수정» 방식).
 * 최종 상태(before + 보낸 칸)에서 «켬»인데 회당 신규 단가가 비었으면 400.
 */
export function parseDateSelectSettings(
  data: Record<string, unknown>,
  before?: Partial<DateSelectSettings> | null,
): Partial<DateSelectSettings> {
  const out: Partial<DateSelectSettings> = {};
  if (data.dateSelectEnabled !== undefined) out.dateSelectEnabled = data.dateSelectEnabled === true || data.dateSelectEnabled === "true" || data.dateSelectEnabled === "on";
  if (data.perSessionNewPrice !== undefined) out.perSessionNewPrice = optionalNonNegativeInt(data.perSessionNewPrice, "회당 신규 단가");
  if (data.perSessionExistingPrice !== undefined) out.perSessionExistingPrice = optionalNonNegativeInt(data.perSessionExistingPrice, "회당 재원 단가");
  if (data.minSessionCount !== undefined) {
    // 비우면 기본값 1(스키마 기본값과 같다)
    out.minSessionCount = isBlank(data.minSessionCount) ? 1 : nonNegativeInt(data.minSessionCount, "최소 횟수");
  }
  const enabled = out.dateSelectEnabled ?? before?.dateSelectEnabled ?? false;
  const newPrice = out.perSessionNewPrice !== undefined ? out.perSessionNewPrice : before?.perSessionNewPrice ?? null;
  if (enabled && newPrice === null) {
    throw new SeasonalError("날짜별 선택을 켜려면 회당 신규 단가를 입력해 주세요.", 400, "DATE_SELECT_PRICE_REQUIRED");
  }
  return out;
}

// ── 날짜 모드 배정 ─────────────────────────────────────────────

const WEEKDAY_BY_DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

/** 관리자가 보낸 날짜 목록 검사 — 실재 날짜만·중복 제거·오름차순. 배열이 아니면 400. */
export function parseAdminSelectedDates(value: unknown): string[] {
  if (!Array.isArray(value)) throw new SeasonalError("고른 날짜를 확인해 주세요.", 400, "INVALID_SELECTED_DATES");
  const cleaned = value.map((item) => (typeof item === "string" ? item.trim() : ""));
  if (cleaned.some((item) => !isKstYmd(item))) throw new SeasonalError("고른 날짜를 확인해 주세요.", 400, "INVALID_SELECTED_DATES");
  const unique = Array.from(new Set(cleaned)).sort();
  if (unique.length === 0) throw new SeasonalError("날짜를 하나 이상 골라 주세요.", 400, "SELECTED_DATES_REQUIRED");
  if (unique.length > ADMIN_MAX_SELECTED_DATES) {
    throw new SeasonalError(`날짜는 최대 ${ADMIN_MAX_SELECTED_DATES}개까지 고를 수 있습니다.`, 400, "TOO_MANY_SELECTED_DATES");
  }
  return unique;
}

// 고른 날짜들의 요일(MON~SUN 순서) — 공개 신청과 같은 함수(담당 A 의 application-plan.ts)를 그대로 내보낸다(따로 만들지 않는다).
export { weekdaysFromDates };

/** 고른 날짜가 모두 실제 수업 날짜인지. 아니면 그 날짜를 알려 주며 400. */
export function assertDatesAreSessionDates(dates: readonly string[], sessionYmds: Iterable<string>) {
  const available = new Set(sessionYmds);
  const missing = dates.filter((ymd) => !available.has(ymd));
  if (missing.length > 0) {
    throw new SeasonalError(`수업이 없는 날짜가 있습니다: ${missing.join(", ")}`, 400, "DATE_NOT_SESSION");
  }
}

/** 이 신청서가 날짜 모드인가(선택 방식이 DATE 이거나 고른 날짜가 있다). */
export function isDateModeApplication(app: { selectionMode?: string | null; selectedDates?: readonly string[] | null }) {
  return app.selectionMode === "DATE" || (Array.isArray(app.selectedDates) && app.selectedDates.length > 0);
}

// ── 목록 표시 문구 ─────────────────────────────────────────────

const WEEKDAY_LABEL: Record<string, string> = { MON: "월", TUE: "화", WED: "수", THU: "목", FRI: "금", SAT: "토", SUN: "일" };

/**
 * 신청 목록 한 줄 문구.
 *   날짜 모드 → «날짜 선택 5회»
 *   요일 모드 → «요일 선택 · 4주 · 월·수» (기간이 없으면 «요일 선택 · 월·수», 요일도 없으면 «요일 선택»)
 */
export function describeApplicationSelection(app: {
  selectionMode?: string | null;
  selectedDates?: readonly string[] | null;
  selectedWeekdays?: readonly string[] | null;
  periodLabel?: string | null;
}): string {
  if (isDateModeApplication(app)) return `날짜 선택 ${app.selectedDates?.length ?? 0}회`;
  const days = (app.selectedWeekdays ?? []).map((day) => WEEKDAY_LABEL[day] ?? day).filter(Boolean);
  return ["요일 선택", app.periodLabel?.trim() || null, days.length ? days.join("·") : null].filter(Boolean).join(" · ");
}

/** 'YYYY-MM-DD' → «1/4(월)» 짧은 표시(KST 달력 숫자 그대로). 잘못된 값은 그대로 돌려준다. */
export function shortDateLabel(ymd: string): string {
  if (!isKstYmd(ymd)) return ymd;
  const [, month, day] = ymd.split("-").map(Number);
  return `${month}/${day}(${WEEKDAY_LABEL[WEEKDAY_BY_DOW[kstDow(ymd)]]})`;
}
