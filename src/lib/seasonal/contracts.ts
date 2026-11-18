// 날짜 형식 검사는 공용 KST 모듈 한 곳만 쓴다(.ts 확장자 = Node 타입 제거 테스트가 바로 읽기 위함).
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { isKstYmd } from "../datetime/kst.ts";

export const SHUTTLE_LOCATION_SOURCES =["MAP_PIN", "SEARCH", "CURRENT_LOCATION"] as const;
export const SHUTTLE_LOCATION_CONSENT_VERSION = "2026-07-21";
export type ShuttleLocationSource = (typeof SHUTTLE_LOCATION_SOURCES)[number];

export type SeasonalShuttleLocationInput = {
  address: string;
  roadAddress?: string;
  latitude: number;
  longitude: number;
  placeId?: string;
  source: ShuttleLocationSource;
  accuracyMeters?: number;
};

/** 신청서 선택 방식 — 요일로 고르기(기본·기존) / 날짜 하나씩 고르기(2026-11-18). attendance-rule.ts SELECTION_MODES 와 같은 값. */
export type SeasonalSelectionMode = "WEEKDAY" | "DATE";

/** 날짜별 선택에서 한 번에 고를 수 있는 최대 날짜 수(방학 전체 회차보다 넉넉하게). */
export const MAX_SELECTED_DATES = 60;

export type SeasonalApplicationInput = {
  idempotencyKey: string;
  applicantType?: "NEW" | "EXISTING";
  selectedWeekdays: SeasonalWeekday[];
  /** 선택 방식 — 보내지 않으면 WEEKDAY(옛 화면·옛 앱 호환). */
  selectionMode: SeasonalSelectionMode;
  /** 날짜별 선택일 때 고른 날짜(KST 'YYYY-MM-DD', 중복 없이 오름차순). 요일 모드면 빈 배열. */
  selectedDates: string[];
  /** 고른 수강 기간(시작·종료 둘 다 있거나 둘 다 없음). 요일 모드·날짜 모드 모두 쓴다(2026-11-18). */
  periodStartDate?: string;
  periodEndDate?: string;
  /**
   * 날짜 모드에서 고른 «주N회»(2026-11-18 원장 결정). 요일 모드는 고른 요일 수가 곧 N 이라 보내지 않는다.
   * 서버는 이 N 으로 주N회 반·가격을 고르고, «N × 회차가 있는 주 수»만큼 날짜를 골랐는지 본다.
   */
  weeklyFrequency?: number;
  child: {
    name: string;
    birthDate: string;
    gender?: string;
    grade?: string;
    school?: string;
    phone?: string;
  };
  parent: { name: string; phone: string; relation?: string };
  address?: string;
  memo?: string;
  agreedTerms: boolean;
  agreedPrivacy: boolean;
  items: Array<{
    offeringId: string;
    shuttle?: {
      pickupLocation?: string;
      pickupTime?: string;
      dropoffLocation?: string;
      note?: string;
      pickupLocationData?: SeasonalShuttleLocationInput;
      dropoffLocationData?: SeasonalShuttleLocationInput;
      dropoffSameAsPickup?: boolean;
      locationConsent?: true;
      locationConsentVersion?: string;
    };
  }>;
};

export const SEASONAL_WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type SeasonalWeekday = (typeof SEASONAL_WEEKDAYS)[number];

const WEEKDAY_ALIASES: Record<string, SeasonalWeekday> = {
  MON: "MON", MONDAY: "MON", 월: "MON", 월요일: "MON",
  TUE: "TUE", TUESDAY: "TUE", 화: "TUE", 화요일: "TUE",
  WED: "WED", WEDNESDAY: "WED", 수: "WED", 수요일: "WED",
  THU: "THU", THURSDAY: "THU", 목: "THU", 목요일: "THU",
  FRI: "FRI", FRIDAY: "FRI", 금: "FRI", 금요일: "FRI",
  SAT: "SAT", SATURDAY: "SAT", 토: "SAT", 토요일: "SAT",
  SUN: "SUN", SUNDAY: "SUN", 일: "SUN", 일요일: "SUN",
};

export function normalizeSeasonalWeekdays(values: unknown): SeasonalWeekday[] {
  if (!Array.isArray(values)) return [];
  const normalized = values.map((value) => WEEKDAY_ALIASES[String(value).trim().toUpperCase()]);
  if (normalized.some((weekday) => !weekday)) throw new SeasonalError("선택 요일을 확인해 주세요.", 400, "INVALID_WEEKDAY");
  return Array.from(new Set(normalized));
}

export class SeasonalError extends Error {
  readonly status: number;
  readonly code: string;
  /** 화면이 쓸 추가 정보(예: DATES_FULL 의 { fullDates }). 기존 호출은 넘기지 않아도 된다. */
  readonly details?: unknown;

  constructor(
    message: string,
    status = 400,
    code = "INVALID_REQUEST",
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * 고른 날짜 목록 정리 — 형식(실재하는 KST 달력 날짜) 검사, 중복 제거, 오름차순 정렬, 최대 60개.
 * 보내지 않았으면(undefined/null) 빈 배열. 배열이 아니거나 잘못된 날짜가 하나라도 있으면 400.
 */
export function normalizeSelectedDates(values: unknown): string[] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new SeasonalError("선택한 날짜를 확인해 주세요.", 400, "INVALID_SELECTED_DATES");
  const cleaned = values.map((value) => (typeof value === "string" ? value.trim() : ""));
  if (cleaned.some((value) => !isKstYmd(value))) {
    throw new SeasonalError("선택한 날짜를 확인해 주세요.", 400, "INVALID_SELECTED_DATES");
  }
  // 'YYYY-MM-DD' 는 글자 정렬이 곧 날짜 정렬이다.
  const unique = Array.from(new Set(cleaned)).sort();
  if (unique.length > MAX_SELECTED_DATES) {
    throw new SeasonalError(`날짜는 한 번에 최대 ${MAX_SELECTED_DATES}개까지 고를 수 있습니다.`, 400, "TOO_MANY_SELECTED_DATES");
  }
  return unique;
}

/** 수강 기간(시작·종료) 검사 — 둘 다 없거나, 둘 다 올바른 날짜이고 종료 ≥ 시작. */
function parsePeriodRange(startValue: unknown, endValue: unknown): { periodStartDate?: string; periodEndDate?: string } {
  const start = typeof startValue === "string" ? startValue.trim() : startValue ?? "";
  const end = typeof endValue === "string" ? endValue.trim() : endValue ?? "";
  if (start === "" && end === "") return {};
  if (!isKstYmd(start) || !isKstYmd(end) || String(end) < String(start)) {
    throw new SeasonalError("수강 기간을 확인해 주세요.", 400, "INVALID_PERIOD");
  }
  return { periodStartDate: String(start), periodEndDate: String(end) };
}

export function cleanText(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, maxLength) : undefined;
}

export function normalizePhone(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseShuttleLocation(
  value: unknown,
  label: string,
): SeasonalShuttleLocationInput | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new SeasonalError(`${label} 위치 정보가 올바르지 않습니다.`, 400, "INVALID_SHUTTLE_LOCATION");
  }

  const location = value as Record<string, unknown>;
  const address = cleanText(location.address, 300);
  const roadAddress = cleanText(location.roadAddress, 300);
  const latitude = finiteNumber(location.latitude);
  const longitude = finiteNumber(location.longitude);
  const source = cleanText(location.source, 30);
  const accuracyMeters = location.accuracyMeters === undefined
    ? undefined
    : finiteNumber(location.accuracyMeters);

  if (!address || latitude === undefined || longitude === undefined) {
    throw new SeasonalError(`${label} 주소와 지도 좌표를 확인해 주세요.`, 400, "INVALID_SHUTTLE_LOCATION");
  }
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new SeasonalError(`${label} 지도 좌표의 범위를 확인해 주세요.`, 400, "INVALID_SHUTTLE_COORDINATES");
  }
  if (!source || !SHUTTLE_LOCATION_SOURCES.includes(source as ShuttleLocationSource)) {
    throw new SeasonalError(`${label} 위치 선택 방식을 확인해 주세요.`, 400, "INVALID_SHUTTLE_LOCATION_SOURCE");
  }
  if (location.accuracyMeters !== undefined && (accuracyMeters === undefined || accuracyMeters < 0 || accuracyMeters > 100_000)) {
    throw new SeasonalError(`${label} 위치 정확도를 확인해 주세요.`, 400, "INVALID_SHUTTLE_ACCURACY");
  }

  return {
    address,
    roadAddress,
    latitude,
    longitude,
    placeId: cleanText(location.placeId, 200),
    source: source as ShuttleLocationSource,
    accuracyMeters,
  };
}

export function parseApplicationInput(value: unknown): SeasonalApplicationInput {
  const body = value as Partial<SeasonalApplicationInput> | null;
  const key = cleanText(body?.idempotencyKey, 120);
  const childName = cleanText(body?.child?.name, 80);
  const parentName = cleanText(body?.parent?.name, 80);
  const parentPhone = normalizePhone(cleanText(body?.parent?.phone, 30) || "");
  const birthDate = cleanText(body?.child?.birthDate, 30);
  const birth = birthDate ? new Date(birthDate) : null;
  const applicantType = body?.applicantType;
  if (applicantType !== undefined && applicantType !== "NEW" && applicantType !== "EXISTING") {
    throw new SeasonalError("신청자 구분을 확인해 주세요.");
  }
  const selectedWeekdays = normalizeSeasonalWeekdays(body?.selectedWeekdays);
  // 선택 방식 — 안 보내면 요일 모드(옛 화면 호환). 그 밖의 값은 거절.
  const rawMode = body?.selectionMode;
  if (rawMode !== undefined && rawMode !== null && rawMode !== "WEEKDAY" && rawMode !== "DATE") {
    throw new SeasonalError("신청 방식을 확인해 주세요.", 400, "INVALID_SELECTION_MODE");
  }
  const selectionMode: SeasonalSelectionMode = rawMode === "DATE" ? "DATE" : "WEEKDAY";
  const selectedDates = normalizeSelectedDates(body?.selectedDates);
  const period = parsePeriodRange(body?.periodStartDate, body?.periodEndDate);

  if (!key) throw new SeasonalError("중복 제출 방지 키가 필요합니다.");
  if (!childName || !birth || Number.isNaN(birth.getTime())) throw new SeasonalError("학생 이름과 생년월일을 확인해 주세요.");
  if (!parentName || parentPhone.length < 10 || parentPhone.length > 11) throw new SeasonalError("보호자 이름과 연락처를 확인해 주세요.");
  if (!body?.agreedTerms || !body?.agreedPrivacy) throw new SeasonalError("약관과 개인정보 처리에 동의해 주세요.");
  if (!Array.isArray(body.items) || body.items.length === 0) throw new SeasonalError("특강을 한 개 이상 선택해 주세요.");
  if (body.items.length > 20) throw new SeasonalError("특강은 한 번에 최대 20개까지 신청할 수 있습니다.", 413, "TOO_MANY_ITEMS");
  if (selectionMode === "DATE") {
    // 날짜 모드: 고른 날짜가 출석 기준이다 — 요일은 서버가 날짜에서 다시 채운다(요일 필수 검사 생략).
    if (selectedDates.length === 0) throw new SeasonalError("수업 날짜를 한 개 이상 골라 주세요.", 400, "DATE_REQUIRED");
    // 고른 날짜는 신청서에 한 벌만 저장된다 — 반이 둘이면 어느 반 날짜인지 갈리므로 한 반만 받는다(검수 L-2).
    if (body.items.length > 1) {
      throw new SeasonalError("날짜로 고를 때는 수업을 하나만 신청할 수 있습니다.", 400, "DATE_SELECT_SINGLE_OFFERING");
    }
    // 주N회를 골라야 «몇 회를 채워야 하는지»가 정해진다(1~7회).
    const frequency = Number(body?.weeklyFrequency);
    if (!Number.isInteger(frequency) || frequency < 1 || frequency > 7) {
      throw new SeasonalError("주 몇 회 수업인지 먼저 골라 주세요.", 400, "FREQUENCY_REQUIRED");
    }
  } else {
    if (selectedWeekdays.length === 0) throw new SeasonalError("수강할 요일을 한 개 이상 선택해 주세요.", 400, "WEEKDAY_REQUIRED");
  }

  const seen = new Set<string>();
  const items = body.items.map((item) => {
    const offeringId = cleanText(item?.offeringId, 100);
    if (!offeringId || seen.has(offeringId)) throw new SeasonalError("특강 선택 항목이 올바르지 않습니다.");
    seen.add(offeringId);
    const dropoffSameAsPickup = item.shuttle?.dropoffSameAsPickup !== false; // 기본 true(대부분 동일)
    const pickupLocationData = parseShuttleLocation(item.shuttle?.pickupLocationData, "탑승");
    // 하원=등원 동일이면 하원 좌표는 등원을 그대로 사용한다.
    const dropoffLocationData = dropoffSameAsPickup ? pickupLocationData : parseShuttleLocation(item.shuttle?.dropoffLocationData, "하차");
    const hasMapLocation = Boolean(pickupLocationData || dropoffLocationData);
    // 지도 핀 필수: 셔틀을 신청했다면 텍스트 설명만으로는 안 되고 실제 좌표(탑승/하차)가 있어야 한다.
    // (클라이언트도 막지만, 직접 API 호출을 통한 우회를 방지하기 위해 서버에서도 강제한다)
    if (item.shuttle && !hasMapLocation) {
      throw new SeasonalError(
        "셔틀 신청 시 지도에서 탑승 또는 하차 위치를 선택해 주세요.",
        400,
        "SHUTTLE_LOCATION_REQUIRED",
      );
    }
    const locationConsentVersion = cleanText(item.shuttle?.locationConsentVersion, 80);
    if (hasMapLocation && (
      item.shuttle?.locationConsent !== true
      || locationConsentVersion !== SHUTTLE_LOCATION_CONSENT_VERSION
    )) {
      throw new SeasonalError(
        "셔틀 위치정보 수집 및 이용에 동의해 주세요.",
        400,
        "SHUTTLE_LOCATION_CONSENT_REQUIRED",
      );
    }

    return {
      offeringId,
      shuttle: item.shuttle
        ? {
            pickupLocation: cleanText(item.shuttle.pickupLocation, 200),
            pickupTime: cleanText(item.shuttle.pickupTime, 30),
            dropoffLocation: cleanText(item.shuttle.dropoffLocation, 200),
            note: cleanText(item.shuttle.note, 500),
            pickupLocationData,
            dropoffLocationData,
            dropoffSameAsPickup,
            locationConsent: hasMapLocation ? true as const : undefined,
            locationConsentVersion: hasMapLocation ? locationConsentVersion : undefined,
          }
        : undefined,
    };
  });

  return {
    idempotencyKey: key,
    applicantType,
    selectedWeekdays,
    selectionMode,
    // 요일 모드에서 날짜가 같이 와도 버린다 — 날짜가 남으면 출석 규칙(날짜 우선)이 뒤바뀐다.
    selectedDates: selectionMode === "DATE" ? selectedDates : [],
    // 기간은 두 모드 모두 쓴다(2026-11-18 — 날짜 모드도 «기간 → 주N회 → 날짜» 순서로 고른다).
    ...period,
    // 주N회는 날짜 모드에서만 싣는다(요일 모드는 요일 수가 곧 N).
    ...(selectionMode === "DATE" ? { weeklyFrequency: Number(body?.weeklyFrequency) } : {}),
    child: {
      name: childName,
      birthDate: birth.toISOString(),
      gender: cleanText(body.child?.gender, 30),
      grade: cleanText(body.child?.grade, 50),
      school: cleanText(body.child?.school, 100),
      phone: cleanText(body.child?.phone, 30),
    },
    parent: { name: parentName, phone: parentPhone, relation: cleanText(body.parent?.relation, 30) },
    address: cleanText(body.address, 300),
    memo: cleanText(body.memo, 1000),
    agreedTerms: true,
    agreedPrivacy: true,
    items,
  };
}
