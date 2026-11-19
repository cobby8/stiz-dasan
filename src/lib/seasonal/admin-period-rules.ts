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
import { isKstYmd, kstAt, kstDow, kstHm, toKstYmd } from "../datetime/kst.ts";
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
  /** 이 기간의 신청 마감 시각(2026-11-18). NULL = 시즌 마감을 따른다. */
  applicationClosesAt: Date | null;
};

// ── KST «날짜 + 시각» 입력 ──────────────────────────────────────

/**
 * 관리자 입력 «YYYY-MM-DD» + «HH:MM»(KST) → 절대 시각. 비어 있으면 null.
 * 왜: 날짜만 `new Date("2027-01-01")` 로 만들면 UTC 자정 = KST 오전 9시가 되어 «마감일 오전 9시에 닫히는» 함정이 생긴다.
 *     반드시 kst.ts kstAt 으로 KST 시각을 해석한다(9시간 함정 금지).
 * 시각을 비우면 fallbackTime(예: 마감 "18:00").
 */
export function parseKstDateTime(ymd: unknown, hm: unknown, fallbackTime: string, label: string): Date | null {
  const date = typeof ymd === "string" ? ymd.trim() : "";
  if (!date) return null;
  const time = typeof hm === "string" && hm.trim() ? hm.trim() : fallbackTime;
  if (!isKstYmd(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new SeasonalError(`${label}의 날짜·시각을 확인해 주세요.`, 400, "INVALID_DATETIME");
  }
  return new Date(kstAt(date, time));
}

/**
 * «YYYY-MM-DDTHH:MM»(KST, 날짜·시각 한 줄) 입력 → 절대 시각. 비어 있으면 null.
 * 기간 행의 «신청 마감» 칸이 이 모양으로 보낸다.
 */
export function parseKstDateTimeText(value: unknown, label: string): Date | null {
  if (isBlank(value)) return null;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(String(value).trim());
  if (!match) throw new SeasonalError(`${label}의 날짜·시각을 확인해 주세요.`, 400, "INVALID_DATETIME");
  return parseKstDateTime(match[1], match[2], "18:00", label);
}

/** 저장된 시각 → 입력칸 값 {date: "YYYY-MM-DD", time: "HH:MM"}(KST). 없으면 빈 날짜 + fallbackTime. */
export function kstDateTimeParts(value: Date | string | null | undefined, fallbackTime: string): { date: string; time: string } {
  if (!value) return { date: "", time: fallbackTime };
  const date = toKstYmd(value);
  return date ? { date, time: kstHm(value) } : { date: "", time: fallbackTime };
}

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
  const newApplicantPrice = has("newApplicantPrice") ? optionalNonNegativeInt(data.newApplicantPrice, "신입생 수강료") : before?.newApplicantPrice ?? null;
  const existingApplicantPrice = has("existingApplicantPrice") ? optionalNonNegativeInt(data.existingApplicantPrice, "재원생 수강료") : before?.existingApplicantPrice ?? null;
  const shuttleFee = has("shuttleFee") ? optionalNonNegativeInt(data.shuttleFee, "셔틀비") : before?.shuttleFee ?? null;
  let displayOrder = before?.displayOrder ?? 0;
  if (has("displayOrder")) {
    const parsed = Number(data.displayOrder);
    displayOrder = Number.isInteger(parsed) ? parsed : 0;
  }
  const isActive = has("isActive") ? data.isActive !== false && data.isActive !== "false" : before?.isActive ?? true;
  // 신청 마감(«YYYY-MM-DDTHH:MM» KST) — 안 보내면 지금 값 유지, 빈 값이면 지움(= 시즌 마감)
  const applicationClosesAt = has("applicationClosesAt")
    ? parseKstDateTimeText(data.applicationClosesAt, "신청 마감")
    : before?.applicationClosesAt ?? null;
  return { label, ...range, price, newApplicantPrice, existingApplicantPrice, shuttleFee, displayOrder, isActive, applicationClosesAt };
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

export type PeriodCopySource = Pick<OfferingPeriodValues, "label" | "startDate" | "endDate" | "displayOrder" | "isActive">
  & { applicationClosesAt?: Date | null };
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
 *   - 이름·시작일·종료일·표시 순서·사용 여부·신청 마감 시각만 복사한다.
 *   - 값은 원본 반 값을 쓰지 않는다(주1회 반 값이 주3회 반에 들어가면 안 된다).
 *     대신 «복사받는 반의 지금 반 수강료(기본·신입생·재원생)»를 기본값으로 넣는다 → 관리자가 줄마다 고친다.
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
        // 같은 기간이면 마감도 같다(예: 4주 = 1/1(금) 18:00) — 날짜처럼 그대로 복사
        applicationClosesAt: source.applicationClosesAt ?? null,
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
 * 시즌 저장 시 날짜별 선택 칸 검사. 보낸 칸만 돌려준다(시즌 수정 PATCH 와 같은 «부분 수정» 방식).
 * 2026-11-18 원장 결정 — 날짜로 골라도 «주N회 반의 기간 가격»을 받으므로 회당 단가·최소 횟수는 더 쓰지 않는다.
 *   켜기만 하면 된다(단가 없이 켜도 400 아님). 단가·최소 횟수 칸은 DB 에 남아 있고, 옛 화면이 보내면 검사만 해서 저장한다.
 */
export function parseDateSelectSettings(
  data: Record<string, unknown>,
  // 예전 «켜려면 단가 필요» 검사용 인자 — 호출 모양을 바꾸지 않으려고 남겨 둔다
  _before?: Partial<DateSelectSettings> | null,
): Partial<DateSelectSettings> {
  const out: Partial<DateSelectSettings> = {};
  if (data.dateSelectEnabled !== undefined) out.dateSelectEnabled = data.dateSelectEnabled === true || data.dateSelectEnabled === "true" || data.dateSelectEnabled === "on";
  if (data.perSessionNewPrice !== undefined) out.perSessionNewPrice = optionalNonNegativeInt(data.perSessionNewPrice, "회당 신입생 단가");
  if (data.perSessionExistingPrice !== undefined) out.perSessionExistingPrice = optionalNonNegativeInt(data.perSessionExistingPrice, "회당 재원생 단가");
  if (data.minSessionCount !== undefined) {
    // 비우면 기본값 1(스키마 기본값과 같다)
    out.minSessionCount = isBlank(data.minSessionCount) ? 1 : nonNegativeInt(data.minSessionCount, "최소 횟수");
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

/**
 * «중간 합류» 신청인가(2026-11-18 원장 — 이미 시작한 기간에 남은 회차로 날짜 선택 신청).
 * 기준: 날짜 모드 신청이고, 접수일(KST)이 기간 시작일(기간이 없으면 시즌 시작일)보다 «뒤».
 *   시작 당일 접수는 남은 회차 = 전체라 수강료가 그대로여서 중간 합류로 보지 않는다.
 * 관리자 목록·상세에 «중간 합류» 표시만 한다(가격·출석에는 영향 없음).
 */
export function isLateJoinApplication(
  app: { selectionMode?: string | null; selectedDates?: readonly string[] | null; createdAt?: string | Date | null; periodStartDate?: string | null },
  seasonStartsAt?: string | Date | null,
): boolean {
  if (!isDateModeApplication(app) || !app.createdAt) return false;
  const startYmd = app.periodStartDate || (seasonStartsAt ? toKstYmd(seasonStartsAt) : "");
  const createdYmd = toKstYmd(app.createdAt);
  return Boolean(startYmd && createdYmd) && createdYmd > startYmd;
}

/**
 * 저장된 수강료가 정상 수강료보다 실제로 줄었는가(검수 L-3 — «남은 회차만큼 수강료» 문구를 붙일지).
 * 날짜만 기간 시작 뒤이고 수강료는 정상가로 저장된 신청(예: 관리자 재배정에서 비율을 못 구한 경우)에
 *   «남은 회차만큼»이라고 잘못 쓰지 않게 한다. 정상 수강료를 모르면(0·없음) false.
 */
export function isTuitionReduced(savedTuition: number | null | undefined, normalTuition: number | null | undefined): boolean {
  if (typeof savedTuition !== "number" || typeof normalTuition !== "number") return false;
  if (!Number.isFinite(savedTuition) || !Number.isFinite(normalTuition) || normalTuition <= 0) return false;
  return savedTuition < normalTuition;
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
