"use client";

import { publicErrorText } from "@/components/ui/public-error-text";
import Link from "next/link";
import ReturnLink from "@/components/common/ReturnLink";
import ReplaceLink from "@/components/common/ReplaceLink";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";
import { PublicBottomBar, usePublicOverlayOpen } from "@/components/public-floating";
import { SEAT_LEVEL_LABEL } from "@/lib/seats/seatLevel";
import { formatSeasonalPeriod, formatWon, normalizeProgram, programClasses, seasonalApplicationStatusLabel, seasonalDisplayState, type SeasonalClass, type SeasonalOfferingPeriod, type SeasonalProgram } from "./types";
// 기간 선택·날짜별 선택(2026-11-18) — 가격·출석 규칙·날짜 표기는 서버와 같은 공용 부품을 쓴다(화면 금액 = 청구 금액)
import { distinctPeriods, isPeriodClosed, proratedPrice, resolvePeriodPrice, resolvePeriodShuttleFee, weeklyFrequencyLabel, type DistinctPeriod } from "@/lib/seasonal/period-pricing";
import { pickSessionDatesForApplication } from "@/lib/seasonal/attendance-rule";
import { dateCountProgressText, hasLateJoinDates, requiredDateCount, ymdKoreanLabel } from "@/lib/seasonal/application-plan";
import { kstHm, kstLabel, todayKst } from "@/lib/datetime/kst";

type LoadState = "loading" | "ready" | "error";
type SubmitState = "idle" | "submitting" | "done" | "error";
type ApplicantType = "NEW" | "EXISTING";
type SeasonalWeekday = SeasonalClass["weekdays"][number];
type SelectionMode = "WEEKDAY" | "DATE";

// 기간을 가리키는 열쇠(시작|종료) — 여러 반의 같은 기간을 하나로 본다(서버도 시작·종료로 찾는다)
function periodKey(period: { startDate: string; endDate: string }) {
  return `${period.startDate}|${period.endDate}`;
}

// 선택지 문구 «4주 · 1월 4일(월)~1월 29일(금)»
function periodOptionLabel(period: DistinctPeriod) {
  return `${period.label} · ${ymdKoreanLabel(period.startDate)}~${ymdKoreanLabel(period.endDate)}`;
}

/**
 * 이 반에 적용될 기간 상품 — 서버(pickOfferingPeriod)와 같은 규칙.
 * ok=false 면 «이 기간·요일 수에 맞는 수강료가 없다»(신청 불가).
 */
function offeringPeriodFor(item: SeasonalClass, applied: DistinctPeriod | null): { period: SeasonalOfferingPeriod | null; ok: boolean } {
  const periods = item.periods ?? [];
  if (periods.length === 0) return { period: null, ok: applied === null };
  if (applied) {
    const matched = periods.find((period) => periodKey(period) === periodKey(applied));
    return { period: matched ?? null, ok: Boolean(matched) };
  }
  if (periods.length === 1) return { period: periods[0], ok: true };
  return { period: null, ok: false };
}

type FormState = {
  childName: string;
  childBirthDate: string;
  childGender: string;
  childGrade: string;
  childSchool: string;
  childPhone: string;
  parentName: string;
  parentPhone: string;
  parentRelation: string;
  address: string;
  memo: string;
  agreedTerms: boolean;
  agreedPrivacy: boolean;
};

type ShuttleDraft = {
  enabled: boolean;
  useFreeHub: boolean; // true=무료 탑승 거점(1호점)에서 타고 내림 / false=집앞(지도 핀)
  pickupLocation: string;
  pickupTime: string;
  dropoffLocation: string;
  note: string;
  dropoffSameAsPickup: boolean; // 하원=등원 동일(대부분 같음) — 기본 켜짐
  pickupLocationData?: MapLocationData;
  dropoffLocationData?: MapLocationData;
};

type LocationPickerTarget = { offeringId: string; kind: "pickup" | "dropoff" };

function offeringWeekdays(item: SeasonalClass) {
  if (item.weekdays.length > 0) return item.weekdays;
  const weekdayByLabel = { 월: "MON", 화: "TUE", 수: "WED", 목: "THU", 금: "FRI", 토: "SAT", 일: "SUN" } as const;
  return Object.entries(weekdayByLabel)
    .filter(([label]) => item.dayLabel.includes(label))
    .map(([, weekday]) => weekday);
}

const WEEKDAY_OPTIONS: Array<{ value: SeasonalWeekday; label: string }> = [
  { value: "MON", label: "월" },
  { value: "TUE", label: "화" },
  { value: "WED", label: "수" },
  { value: "THU", label: "목" },
  { value: "FRI", label: "금" },
  { value: "SAT", label: "토" },
  { value: "SUN", label: "일" },
];

function seasonalOfferingFrequency(item: Pick<SeasonalClass, "name" | "code">) {
  const matched = `${item.name ?? ""} ${item.code ?? ""}`.match(/주\s*(\d+)\s*회|-(\d)(?:\D|$)/i);
  const value = matched ? Number(matched[1] ?? matched[2]) : NaN;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function operationalClassKey(item: Pick<SeasonalClass, "id" | "linkedClassId">) {
  return item.linkedClassId || item.id;
}

/**
 * 주N회로 같은 운영 반의 «그 횟수 반»을 찾는다 — 서버와 같은 규칙.
 * N = 요일 모드는 고른 요일 수, 날짜 모드는 고른 «주N회»(2026-11-18). 0 이면 아직 못 고름(null).
 */
function matchingOfferingForCount(
  offerings: SeasonalClass[],
  base: SeasonalClass,
  count: number,
) {
  if (count <= 0) return null;
  const candidates = offerings.filter((item) => operationalClassKey(item) === operationalClassKey(base));
  const frequencyCandidates = candidates.filter((item) => seasonalOfferingFrequency(item) !== null);
  if (frequencyCandidates.length === 0) return base;
  return frequencyCandidates.find((item) => seasonalOfferingFrequency(item) === count) ?? null;
}

// 재원생 할인 고지(2026-11-18 원장 «휴원하고 특강만 들으면 할인 적용이 안 되는 부분 명확하게 고지») — 두 곳에 같은 문구
const EXISTING_DISCOUNT_NOTICE = "재원생 할인은 특강 기간에 정규반을 함께 다니는 학생만 받습니다. 정규반을 휴원하고 특강만 들으면 신규 수강료가 적용됩니다.";

type SubmitResult = {
  applicationId?: string;
  duplicate?: boolean;
  items?: Array<{
    offeringId: string;
    status: string;
    waitlistOrder?: number | null;
    priceSnapshot?: number | null;
    tuitionPriceSnapshot?: number | null;
    siblingDiscountSnapshot?: number | null;
    shuttleFeeSnapshot?: number | null;
  }>;
};

const EMPTY_FORM: FormState = {
  childName: "",
  childBirthDate: "",
  childGender: "",
  childGrade: "",
  childSchool: "",
  childPhone: "",
  parentName: "",
  parentPhone: "",
  parentRelation: "보호자",
  address: "",
  memo: "",
  agreedTerms: false,
  agreedPrivacy: false,
};

function makeIdempotencyKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `seasonal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function hasShuttle(draft?: ShuttleDraft) {
  return draft?.enabled === true;
}

function hasShuttleLocation(draft?: ShuttleDraft) {
  // 지도 핀 필수: 정확한 노선 운영을 위해 텍스트 설명이 아니라 실제 좌표(탑승 또는 하차)가 있어야 한다.
  return Boolean(draft?.pickupLocationData || draft?.dropoffLocationData);
}

// 남은 자리를 모르면(null) 예전처럼 «마감» 쪽으로 본다(안전)
function isFull(item: SeasonalClass) {
  return item.capacity !== null && (item.seatLevel ?? "FULL") === "FULL";
}

// 숫자 대신 여유/임박/마감(재원생 수 비공개 · 2026-11-13 f9)
function remainingText(item: SeasonalClass) {
  if (item.capacity === null || item.seatLevel === null) return "학원 문의";
  if (item.seatLevel !== "FULL") return SEAT_LEVEL_LABEL[item.seatLevel];
  return item.waitlistEnabled ? "대기 가능" : "마감";
}

function emptyShuttle(): ShuttleDraft {
  return { enabled: false, useFreeHub: false, pickupLocation: "", pickupTime: "", dropoffLocation: "", note: "", dropoffSameAsPickup: true };
}

// 무료 거점 이용 학생은 셔틀비를 받지 않는다(planning.isFreeHubShuttle과 같은 취지). 거점 탑승이면 fee 0.
function shuttleFeeForDraft(offering: SeasonalClass | undefined, draft?: ShuttleDraft) {
  if (!offering?.shuttleAvailable || !hasShuttle(draft) || !hasShuttleLocation(draft)) return 0;
  if (draft?.useFreeHub) return 0;
  return offering.shuttleFee ?? 0;
}

function statusText(status: string) {
  return seasonalApplicationStatusLabel(status);
}

function applicantPrice(item: SeasonalClass, applicantType: ApplicantType | "") {
  if (applicantType === "NEW") return item.newApplicantPrice ?? item.price;
  if (applicantType === "EXISTING") return item.existingApplicantPrice ?? item.price;
  return item.price;
}

/** 학부모 앱 안에서 열 때 미리 채우는 값(로그인한 학부모의 이름·연락처·아이). 고칠 수 있다 */
export type SeasonalApplyPrefill = Partial<Pick<FormState, "childName" | "childBirthDate" | "parentName" | "parentPhone">>;

// basePath·homeHref = 화면 사이 이동 주소. 공개 화면은 "/seasonal"·"/"(기본), 학부모 앱 안은 "/mypage/seasonal/apply"·"/mypage"(2026-11-14 c9)
export default function SeasonalApplyClient({ slug, basePath = "/seasonal", homeHref = "/", prefill }: { slug: string; basePath?: string; homeHref?: string; prefill?: SeasonalApplyPrefill }) {
  const [state, setState] = useState<LoadState>("loading");
  const [program, setProgram] = useState<SeasonalProgram | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedWeekdayKeys, setSelectedWeekdayKeys] = useState<SeasonalWeekday[]>([]);
  const [applicantType, setApplicantType] = useState<ApplicantType | "">("");
  const [form, setForm] = useState<FormState>(() => ({ ...EMPTY_FORM, ...prefill }));
  const [shuttle, setShuttle] = useState<Record<string, ShuttleDraft>>({});
  const [locationPicker, setLocationPicker] = useState<LocationPickerTarget | null>(null);
  const [locationConsent, setLocationConsent] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<SubmitResult | null>(null);
  // 기간 선택·날짜별 선택(2026-11-18) — 기간 0개·날짜별 신청 꺼짐이면 쓰이지 않아 화면이 예전과 같다
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("WEEKDAY");
  const [selectedDateKeys, setSelectedDateKeys] = useState<string[]>([]);
  const [selectedPeriodKey, setSelectedPeriodKey] = useState("");
  // 날짜 모드의 «주N회»(2026-11-18) — 이 값 × 회차가 있는 주 수만큼 날짜를 채워야 신청된다
  const [selectedFrequency, setSelectedFrequency] = useState<number | null>(null);
  // «8회까지만 고를 수 있습니다» 같은 날짜 고르기 안내
  const [dateLimitNotice, setDateLimitNotice] = useState("");
  const idempotencyKeyRef = useRef(makeIdempotencyKey());
  // 지도 위치 선택 모달이 열린 동안 플로팅 버튼(챗봇·입학 가이드)을 숨긴다(게슈탈트 C-P3)
  usePublicOverlayOpen(Boolean(locationPicker));

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/seasonal/${encodeURIComponent(slug)}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "특강 정보를 불러오지 못했습니다.");
        return normalizeProgram(body);
      })
      .then((data) => {
        setProgram(data);
        setState("ready");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("[seasonal] 특강 정보 조회 실패", error);
        setMessage(publicErrorText(error, "특강 정보를 불러오지 못했습니다."));
        setState("error");
      });
    return () => controller.abort();
  }, [slug]);

  const offerings = useMemo(() => program ? programClasses(program) : [], [program]);
  const selectedOfferings = offerings.filter((item) => selectedIds.includes(item.id));
  const availableWeekdays = Array.from(new Set(selectedOfferings.flatMap(offeringWeekdays)));
  const selectedWeekdays = selectedWeekdayKeys.filter((weekday) => availableWeekdays.includes(weekday));

  // ── 날짜별 신청(시즌 설정이 켜졌을 때만) ──
  const dateSelect = program?.dateSelect;
  const dateSelectOn = dateSelect?.enabled === true;
  const baseOffering = selectedOfferings[0];
  // 같은 운영 반(주2회·주3회가 한 교실)의 반들 — 기간 목록·날짜 목록은 이 범위에서 모은다(서버와 같은 범위)
  const scopeOfferings = baseOffering ? offerings.filter((item) => operationalClassKey(item) === operationalClassKey(baseOffering)) : [];
  const scopeSessions = scopeOfferings.flatMap((item) => item.sessionDates);
  const todayYmd = todayKst();
  // 시즌 모집이 마감됐지만 중간 합류(날짜로 고르기)는 열린 상태(서버 lateJoinOpen · 2026-11-18 원장)
  const seasonLateJoin = program ? seasonalDisplayState(program).lateJoin : false;

  // ── 수강 기간(요일·날짜 두 모드 공통 · 2026-11-18 «기간 → 주N회 → 날짜») ──
  const periodChoices = distinctPeriods(scopeOfferings);
  const needsPeriodChoice = periodChoices.length >= 2;
  // 기간이 하나뿐이면 자동 적용, 여럿이면 고른 것
  const appliedPeriod = periodChoices.length === 1
    ? periodChoices[0]
    : periodChoices.find((period) => periodKey(period) === selectedPeriodKey) ?? null;
  // 기간별 신청 마감(예: 4주 1/1(금) 18:00) — 시각이 지나면 고를 수 없다(서버 PERIOD_CLOSED 와 같은 규칙)
  const appliedPeriodClosed = appliedPeriod ? isPeriodClosed(appliedPeriod) : false;
  // 요일 모드(기간 전체 신청) 마감 = 시즌 모집 마감 또는 고른 기간 마감. 이때 날짜 선택이 켜져 있으면 «날짜로 고르기»만 남는다.
  const weekdayModeClosed = dateSelectOn && (seasonLateJoin || appliedPeriodClosed);
  const isDateMode = dateSelectOn && (selectionMode === "DATE" || weekdayModeClosed);
  // 마감 뒤 중간 합류는 마지막 회차 전날까지(내일 이후 수업이 남았을 때) — 서버 hasLateJoinDates 와 같은 함수
  const deadlinePassed = seasonLateJoin || appliedPeriodClosed;
  const lateJoinDatesLeft = hasLateJoinDates(scopeSessions, todayYmd, appliedPeriod);
  const periodReady = (!needsPeriodChoice || appliedPeriod !== null) && (!deadlinePassed || (isDateMode && lateJoinDatesLeft));

  // ── 주N회(날짜 모드) — 고를 수 있는 값은 같은 운영 반의 «주N회» 반들 ──
  const frequencyOptions = (() => {
    const found = new Set(scopeOfferings.map(seasonalOfferingFrequency).filter((value): value is number => value !== null));
    if (found.size > 0) return [...found].sort((a, b) => a - b);
    // 반 이름에 «주N회»가 없으면 이 반 요일 수까지(1~요일 수)
    return Array.from({ length: Math.max(availableWeekdays.length, 1) }, (_, index) => index + 1);
  })();
  const weeklyFrequency = isDateMode && selectedFrequency !== null && frequencyOptions.includes(selectedFrequency) ? selectedFrequency : null;
  // 반·가격을 고르는 N — 요일 모드는 고른 요일 수, 날짜 모드는 고른 주N회
  const frequencyCount = isDateMode ? (weeklyFrequency ?? 0) : selectedWeekdays.length;

  // 고를 수 있는 날짜 — 오늘 이전·고른 기간 밖은 숨기고, 같은 날짜는 한 줄로(고른 반의 회차를 먼저 쓴다).
  //   정원이 찬 날짜도 «마감»으로 보이되 고를 수 있다 → 그 신청은 대기로 접수된다(2026-11-18 원장).
  const dateOptions = (() => {
    const byKey = new Map<string, { dateKey: string; label: string; full: boolean }>();
    const ordered = baseOffering ? [baseOffering, ...scopeOfferings.filter((item) => item.id !== baseOffering.id)] : [];
    for (const item of ordered) {
      for (const session of item.sessionDates) {
        if (!session.dateKey || session.dateKey < todayYmd || byKey.has(session.dateKey)) continue;
        if (appliedPeriod && (session.dateKey < appliedPeriod.startDate || session.dateKey > appliedPeriod.endDate)) continue;
        byKey.set(session.dateKey, {
          dateKey: session.dateKey,
          label: `${ymdKoreanLabel(session.dateKey)} ${session.startTime}~${session.endTime}`,
          full: session.full,
        });
      }
    }
    return [...byKey.values()].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  })();
  // 실제로 보낼 날짜 = 고른 것 중 지금 목록에 있는 날짜(기간을 바꾸면 기간 밖 날짜는 빠진다)
  const selectedDates = isDateMode
    ? selectedDateKeys.filter((key) => dateOptions.some((option) => option.dateKey === key)).sort()
    : [];
  // 채워야 할 횟수 = 주N회 × 회차가 있는 주 수(서버 requiredDateCount 와 같은 함수 — 화면·서버 숫자가 같다)
  //   오늘(KST, 오늘 포함)부터 남은 회차만 센다 — 서버도 같은 todayKst() 로 같은 함수를 부른다(2026-11-18 중간 합류)
  const requiredDates = isDateMode && weeklyFrequency !== null
    ? requiredDateCount(scopeSessions, weeklyFrequency, appliedPeriod, todayYmd)
    : 0;
  // 시작 전 기준 전체 필요 횟수 — 남은 회차 비율(수강료·셔틀비)의 분모
  const fullDateCount = isDateMode && weeklyFrequency !== null
    ? requiredDateCount(scopeSessions, weeklyFrequency, appliedPeriod)
    : 0;
  // 남은 회차가 전체보다 적으면(기간 중간 합류) 수강료·셔틀비를 비율로 줄인다(100원 내림, 서버 proratedPrice 와 같은 함수)
  const prorated = isDateMode && fullDateCount > 0 && requiredDates < fullDateCount;
  const prorate = (amount: number) => (isDateMode && fullDateCount > 0 ? proratedPrice(amount, requiredDates, fullDateCount) : amount);
  const dateCountOk = requiredDates > 0 && selectedDates.length === requiredDates;
  // 고른 날짜 중 정원이 찬 날 — 있으면 대기로 접수된다
  const selectedFullDates = selectedDates.filter((key) => dateOptions.find((option) => option.dateKey === key)?.full);

  const selectionPlans = selectedOfferings.map((item) => {
    // 두 모드 모두 주N회로 그 횟수 반을 찾는다(서버와 같다)
    const offering = matchingOfferingForCount(offerings, item, frequencyCount);
    const target = offering ?? item;
    const { period, ok: periodOk } = offeringPeriodFor(target, appliedPeriod);
    // 수강료는 두 모드가 같다 — 기간 가격(없으면 반의 회원별 가격). 회당 단가는 없앴다(2026-11-18).
    const normalTuition = period ? resolvePeriodPrice(period, applicantType || undefined) : applicantPrice(target, applicantType);
    // 날짜 모드 = 정상 수강료 × 남은 회차 비율(시작 전이면 그대로)
    const tuition = prorate(normalTuition);
    return { base: item, offering, period, periodOk, tuition, normalTuition };
  });
  const hasPricingMatch = selectedOfferings.length > 0 && selectionPlans.every((plan) => Boolean(plan.offering) && plan.periodOk);
  // 기간 상품이면 기간 셔틀비(없으면 반 셔틀비) — 서버 resolvePeriodShuttleFee 와 같은 규칙
  function planShuttleFee(plan: (typeof selectionPlans)[number]) {
    const item = plan.offering ?? plan.base;
    const draft = shuttle[plan.base.id];
    if (!plan.period || !hasShuttle(draft) || !hasShuttleLocation(draft)) return prorate(shuttleFeeForDraft(item, draft));
    // 셔틀비도 수강료와 같은 남은 회차 비율(서버와 같다)
    return prorate(resolvePeriodShuttleFee(plan.period, item, true, draft?.useFreeHub === true));
  }
  const tuitionTotal = selectionPlans.reduce((sum, plan) => sum + plan.tuition, 0);
  const shuttleTotal = selectionPlans.reduce((sum, plan) => sum + planShuttleFee(plan), 0);
  // 날짜·요일 선택이 끝났는가(모드별)
  // 날짜로 고를 때는 수업 하나만 — 서버(DATE_SELECT_SINGLE_OFFERING)와 같은 규칙. 요일 모드는 그대로 여러 개 가능.
  const dateModeTooMany = isDateMode && selectedOfferings.length > 1;
  // 날짜 모드는 필요 횟수를 «정확히» 채워야 한다(모자라도 넘쳐도 안 됨 — 서버 DATE_COUNT_MISMATCH)
  const scheduleReady = isDateMode
    ? weeklyFrequency !== null && dateCountOk && !dateModeTooMany && periodReady
    : selectedWeekdays.length > 0 && periodReady;
  const totalPrice = tuitionTotal + shuttleTotal;
  const hasMapSelection = selectionPlans.some(({ base, offering }) => (
    offering?.shuttleAvailable
    && (shuttle[base.id]?.pickupLocationData || shuttle[base.id]?.dropoffLocationData)
  ));
  const incompleteShuttlePlans = selectionPlans.filter(({ base, offering }) => (
    offering?.shuttleAvailable && hasShuttle(shuttle[base.id]) && !hasShuttleLocation(shuttle[base.id])
  ));
  const canSubmit = selectedIds.length > 0 && applicantType && form.childName && form.childBirthDate && form.parentName
    && form.parentPhone && scheduleReady && hasPricingMatch
    && incompleteShuttlePlans.length === 0
    && form.agreedTerms && form.agreedPrivacy && (!hasMapSelection || locationConsent)
    && submitState !== "submitting";
  // 주N회(날짜 모드)·요일(요일 모드)을 다 골랐는가 — 수강료 없음 안내를 띄울 때 쓴다
  const frequencyPicked = isDateMode ? weeklyFrequency !== null : selectedWeekdays.length > 0;
  const incompleteItems = [
    selectedIds.length === 0 ? "신청할 수업" : "",
    // 두 모드 공통 — 기간
    selectedIds.length > 0 && needsPeriodChoice && !appliedPeriod ? "수강 기간" : "",
    // 마감 뒤: 날짜 모드에 남은 날이 있으면 중간 합류로 진행, 아니면 다른 기간을 골라야 한다
    deadlinePassed && !(isDateMode && lateJoinDatesLeft) ? (isDateMode ? "남은 수업이 있는 기간" : "신청 마감되지 않은 기간") : "",
    // 날짜 모드
    dateModeTooMany ? "날짜로 고를 때는 수업 하나만" : "",
    isDateMode && selectedIds.length > 0 && weeklyFrequency === null ? "주 몇 회" : "",
    isDateMode && weeklyFrequency !== null && requiredDates > 0 && !dateCountOk ? `수업 날짜 ${requiredDates}회` : "",
    // 요일 모드
    !isDateMode && selectedIds.length > 0 && selectedWeekdays.length === 0 ? "참여 요일" : "",
    selectedIds.length > 0 && frequencyPicked && periodReady && !hasPricingMatch ? (isDateMode ? "주N회 수강료" : "요일 수에 맞는 수강료") : "",
    !applicantType ? "회원 구분" : "",
    !form.childName || !form.childBirthDate ? "학생 필수 정보" : "",
    !form.parentName || !form.parentPhone ? "보호자 필수 정보" : "",
    incompleteShuttlePlans.length > 0 ? "셔틀 탑승 또는 하차 위치" : "",
    !form.agreedTerms ? "운영·환불 규정 동의" : "",
    !form.agreedPrivacy ? "개인정보 수집 동의" : "",
    hasMapSelection && !locationConsent ? "셔틀 위치정보 동의" : "",
  ].filter(Boolean);

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleOffering(item: SeasonalClass) {
    if (isFull(item) && !item.waitlistEnabled) return;
    // 반을 바꾸면 그 반 기준이던 날짜·기간 선택은 비운다(다른 반의 날짜가 남지 않게)
    setSelectedDateKeys([]);
    setSelectedPeriodKey("");
    setDateLimitNotice("");
    setSelectedIds((current) => {
      if (current.includes(item.id)) {
        setSelectedWeekdayKeys([]);
        setSelectedFrequency(null);
        return [];
      }
      const frequency = seasonalOfferingFrequency(item);
      const weekdays = offeringWeekdays(item);
      setSelectedWeekdayKeys(frequency ? weekdays.slice(0, frequency) : []);
      // 날짜 모드의 주N회도 고른 반의 «주N회»로 미리 채운다(바꿀 수 있다)
      setSelectedFrequency(frequency);
      return [item.id];
    });
  }

  function toggleWeekday(weekday: SeasonalWeekday) {
    setSelectedWeekdayKeys((current) => {
      const next = current.includes(weekday)
        ? current.filter((item) => item !== weekday)
        : [...current, weekday];
      return WEEKDAY_OPTIONS.map((option) => option.value).filter((item) => next.includes(item));
    });
  }

  // 날짜 하나 고르기/빼기 — 정원이 찬 날짜도 고를 수 있다(대기 접수). 필요 횟수를 넘겨 고를 수는 없다.
  function toggleDate(dateKey: string) {
    setDateLimitNotice("");
    if (selectedDates.includes(dateKey)) {
      setSelectedDateKeys((current) => current.filter((key) => key !== dateKey));
      return;
    }
    if (requiredDates > 0 && selectedDates.length >= requiredDates) {
      setDateLimitNotice(`${requiredDates}회까지만 고를 수 있습니다. 다른 날짜를 빼고 골라 주세요.`);
      return;
    }
    setSelectedDateKeys((current) => [...current.filter((key) => selectedDates.includes(key)), dateKey].sort());
  }

  function updateShuttle<K extends keyof ShuttleDraft>(offeringId: string, key: K, value: ShuttleDraft[K]) {
    setShuttle((current) => ({
      ...current,
      [offeringId]: { ...(current[offeringId] ?? emptyShuttle()), [key]: value },
    }));
  }

  // 무료 거점 탑승 on/off. on이면 탑승=거점(1호점), 하차=거점 하차(길 건너)를 좌표까지 자동 채운다.
  //   pickupLocation 텍스트에 '무료탑승'을 넣어 서버(배차·셔틀비 로직)가 거점 이용으로 인식하게 한다.
  function setHubMode(offeringId: string, on: boolean) {
    const hub = program?.shuttleHub;
    setShuttle((current) => {
      const draft = current[offeringId] ?? emptyShuttle();
      if (!on) {
        // 거점 해제 → 좌표·라벨 비우고 집앞(지도 핀) 모드로 되돌린다.
        return { ...current, [offeringId]: { ...draft, useFreeHub: false, pickupLocation: "", dropoffLocation: "", pickupLocationData: undefined, dropoffLocationData: undefined, dropoffSameAsPickup: true } };
      }
      const toPin = (p: { name: string; lat: number; lng: number }): MapLocationData => ({
        latitude: p.lat, longitude: p.lng, address: p.name, roadAddress: p.name, placeName: p.name, source: "MAP_PIN",
      });
      const pickup = hub?.pickup ? toPin(hub.pickup) : undefined;
      const dropoff = hub?.dropoff ? toPin(hub.dropoff) : pickup; // 하차 거점 미설정 시 탑승 거점과 동일 처리
      return {
        ...current,
        [offeringId]: {
          ...draft,
          useFreeHub: true,
          dropoffSameAsPickup: false,
          pickupLocation: `${hub?.pickup?.name ?? "무료 탑승 거점"}(무료탑승)`,
          dropoffLocation: hub?.dropoff?.name ?? hub?.pickup?.name ?? "무료 탑승 거점",
          pickupLocationData: pickup,
          dropoffLocationData: dropoff,
        },
      };
    });
  }

  function saveMapLocation(target: LocationPickerTarget, value: MapLocationData) {
    setShuttle((current) => {
      const draft = current[target.offeringId] ?? emptyShuttle();
      const isPickup = target.kind === "pickup";
      return {
        ...current,
        [target.offeringId]: {
          ...draft,
          [isPickup ? "pickupLocation" : "dropoffLocation"]: value.placeName ?? value.roadAddress ?? value.address,
          [isPickup ? "pickupLocationData" : "dropoffLocationData"]: value,
        },
      };
    });
    setLocationPicker(null);
  }

  function updateLocationText(offeringId: string, kind: "pickup" | "dropoff", value: string) {
    // 텍스트는 이제 '상세 설명(선택)'이다. 지도 핀 좌표를 지우지 않는다(핀이 실제 위치의 기준).
    setShuttle((current) => {
      const draft = current[offeringId] ?? emptyShuttle();
      return {
        ...current,
        [offeringId]: {
          ...draft,
          [kind === "pickup" ? "pickupLocation" : "dropoffLocation"]: value,
        },
      };
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      setMessage("필수 정보와 신청할 수업, 동의 항목을 확인해 주세요.");
      setSubmitState("error");
      return;
    }

    setSubmitState("submitting");
    setMessage("");

    try {
      const response = await fetch(`/api/seasonal/${encodeURIComponent(slug)}/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: idempotencyKeyRef.current,
          applicantType,
          child: {
            name: form.childName,
            birthDate: form.childBirthDate,
            gender: form.childGender,
            grade: form.childGrade,
            school: form.childSchool,
            phone: form.childPhone,
          },
          parent: {
            name: form.parentName,
            phone: form.parentPhone,
            relation: form.parentRelation,
          },
          address: form.address,
          memo: form.memo,
          agreedTerms: form.agreedTerms,
          agreedPrivacy: form.agreedPrivacy,
          // 날짜 모드면 요일은 서버가 고른 날짜에서 다시 채운다
          selectedWeekdays: isDateMode ? [] : selectedWeekdays,
          selectionMode: isDateMode ? "DATE" : "WEEKDAY",
          selectedDates,
          // 날짜 모드는 고른 주N회를 보낸다(서버가 필요 횟수·주N회 반·가격을 같은 규칙으로 다시 정한다)
          ...(isDateMode && weeklyFrequency !== null ? { weeklyFrequency } : {}),
          // 기간 이름은 보내지 않는다 — 서버가 기간 상품표에서 찾아 적는다
          ...(appliedPeriod ? { periodStartDate: appliedPeriod.startDate, periodEndDate: appliedPeriod.endDate } : {}),
          items: selectionPlans.flatMap(({ base, offering }) => offering ? [{
            offeringId: offering.id,
            shuttle: offering.shuttleAvailable && hasShuttle(shuttle[base.id]) && hasShuttleLocation(shuttle[base.id]) ? {
              pickupLocation: shuttle[base.id]?.pickupLocation,
              pickupTime: shuttle[base.id]?.pickupTime,
              dropoffLocation: shuttle[base.id]?.dropoffLocation,
              note: shuttle[base.id]?.note,
              pickupLocationData: shuttle[base.id]?.pickupLocationData,
              // 하원=등원 동일이면 하원 좌표는 등원을 그대로 사용(서버에서도 미러링)
              dropoffLocationData: shuttle[base.id]?.dropoffSameAsPickup ? shuttle[base.id]?.pickupLocationData : shuttle[base.id]?.dropoffLocationData,
              dropoffSameAsPickup: shuttle[base.id]?.dropoffSameAsPickup ?? true,
              locationConsent: Boolean(shuttle[base.id]?.pickupLocationData || shuttle[base.id]?.dropoffLocationData) ? locationConsent : undefined,
              locationConsentVersion: Boolean(shuttle[base.id]?.pickupLocationData || shuttle[base.id]?.dropoffLocationData) ? SHUTTLE_LOCATION_CONSENT_VERSION : undefined,
            } : undefined,
          }] : []),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "신청을 저장하지 못했습니다.");
      const saved = body as SubmitResult;
      setResult(saved);
      setSubmitState("done");
      // 정원이 찬 날짜·요일이 있으면 대기로 접수된다(날짜 모드도 같다 — 2026-11-18)
      setMessage(saved.items?.some((item) => item.status === "WAITLISTED")
        ? "정원이 차서 대기로 접수되었습니다. 자리가 나면 학원에서 연락드릴게요."
        : "신청이 접수되었습니다. 학원에서 확인 후 안내드릴게요.");
    } catch (error) {
      setSubmitState("error");
      console.error("[seasonal] 신청 저장 실패", error);
      setMessage(publicErrorText(error, "신청을 저장하지 못했습니다."));
    }
  }

  if (state === "loading") return <StatusBox text="신청 정보를 불러오고 있어요." />;
  if (state === "error" || !program) return <StatusBox text={message || "신청 정보를 불러오지 못했습니다."} retry />;
  if (submitState === "done") return <DoneView slug={slug} basePath={basePath} homeHref={homeHref} result={result} offerings={offerings} message={message} />;
  const display = seasonalDisplayState(program);
  if (!display.canApply) return (
    <section className="public-content-section bg-[var(--color-public-tint)] px-4 py-8 dark:bg-[var(--color-public-paper)]">
      <div className="public-card mx-auto max-w-3xl space-y-4 p-5">
        <p className="text-sm font-medium text-[var(--color-public-accent)]">{display.label}</p>
        <h1 className="text-2xl font-bold break-keep">{program.title}</h1>
        <p>{display.message}</p>
        <p className="text-sm text-[var(--color-public-muted)]">운영 기간 · {formatSeasonalPeriod(program.operationStart, program.operationEnd)}</p>
        <div className="public-actions"><Link href={`${basePath}/${slug}`} className="public-btn-secondary">특강 내용 보기</Link><Link href={basePath} className="public-btn-secondary">다른 특강 보기</Link></div>
      </div>
    </section>
  );

  return (
    <form onSubmit={handleSubmit} className="public-seasonal-form bg-[var(--color-public-tint)] px-4 py-8 pb-28 dark:bg-[var(--color-public-paper)]">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <ReturnLink href={`${basePath}/${slug}`} className="text-sm font-medium text-[var(--color-public-accent)] dark:text-brand-neon-lime">특강 상세로 돌아가기</ReturnLink>
          <p className="mt-5 text-sm font-medium text-[var(--color-public-accent)] dark:text-brand-neon-lime">방학특강 신청</p>
          <h1 className="mt-2 text-3xl font-bold text-[var(--color-public-ink)] dark:text-white">{program.title}</h1>
          {program.summary && <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{program.summary}</p>}
        </header>

        {message && (
          <p role={submitState === "error" ? "alert" : "status"} aria-live={submitState === "error" ? "assertive" : "polite"} className={`rounded-xl border px-4 py-3 text-sm ${submitState === "error" ? "border-red-200 bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)] dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100" : "border-green-200 bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)] dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-100"}`}>
            {message}
          </p>
        )}

        <section className="space-y-3">
          <div>
            <h2 className="text-xl font-bold text-[var(--color-public-ink)] dark:text-white">수업 선택</h2>
            <p className="mt-1 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">신청할 반을 선택한 뒤 실제 참여할 요일을 골라주세요.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {offerings.map((item) => {
              const selected = selectedIds.includes(item.id);
              const disabled = isFull(item) && !item.waitlistEnabled;
              const priceItem = selected ? matchingOfferingForCount(offerings, item, frequencyCount) ?? item : item;
              const shuttleAvailable = selected && priceItem.shuttleAvailable;
              // 고른 반이면 기간·날짜 반영 금액, 아니면 예전처럼 반 가격
              const plan = selected ? selectionPlans.find((candidate) => candidate.base.id === item.id) : undefined;
              // 두 모드 모두 같은 가격(기간 가격 또는 반 가격)
              const cardPriceText = formatWon(plan?.period ? plan.tuition : applicantPrice(priceItem, applicantType));
              const cardShuttleFee = plan?.period ? (plan.period.shuttleFee ?? priceItem.shuttleFee ?? 0) : (priceItem.shuttleFee ?? 0);
              return (
                <article key={item.id} className={`rounded-2xl border bg-white p-5 shadow-sm dark:bg-[var(--color-public-tint)] ${selected ? "border-[var(--color-public-secondary-strong)] ring-2 ring-[var(--color-public-secondary-soft)] dark:border-brand-neon-lime dark:ring-brand-neon-lime/20" : "border-[var(--color-public-line)] dark:border-[var(--color-public-line)]"} ${disabled ? "opacity-60" : ""}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-medium text-[var(--color-public-accent)] dark:text-brand-neon-lime">{item.dayLabel} {item.dateLabel}</p>
                      <h3 className="mt-1 text-lg font-bold text-[var(--color-public-ink)] dark:text-white">{item.name}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleOffering(item)}
                      disabled={disabled}
                      aria-pressed={selected}
                      // 고른 반 = 보조 색(하늘색) — 꽉 찬 주 색은 맨 아래 «신청 접수» 버튼 하나만 쓴다(2026-11-13 UI 통일)
                      className={`min-h-11 rounded px-4 text-sm font-medium transition ${selected ? "bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)] ring-1 ring-inset ring-[var(--color-public-secondary-strong)] dark:ring-0 dark:bg-brand-neon-lime dark:text-brand-navy-900" : "border border-[var(--color-public-muted)] text-[var(--color-public-ink)] dark:border-[var(--color-public-line)] dark:text-[var(--color-public-ink)]"} disabled:cursor-not-allowed`}
                    >
                      {selected ? "선택됨" : disabled ? "마감" : "선택"}
                    </button>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-sm tabular-nums">
                    <Pair label="시간" value={`${item.startTime}~${item.endTime}`} />
                    <Pair label="대상" value={item.targetGrade || "전체"} />
                    <Pair label="자리" value={remainingText(item)} />
                    <Pair label="수강료" value={cardPriceText} />
                  </dl>
                  {item.sessionDates.length > 0 && (
                    <div className="mt-4 border-t border-[var(--color-public-line)] pt-4 dark:border-[var(--color-public-line)]">
                      <p className="text-sm font-semibold text-[var(--color-public-ink)] dark:text-white">전체 수업 일정 · {item.sessionDates.length}회</p>
                      <ol className="mt-2 space-y-1.5">
                        {item.sessionDates.map((session, index) => <li key={`${session.startsAt}-${index}`} className="text-xs tabular-nums text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]"><span className="mr-2 font-medium text-[var(--color-public-accent)] dark:text-brand-neon-lime">{index + 1}회</span>{session.dateLabel} ({session.dayLabel}) {session.startTime}~{session.endTime}</li>)}
                      </ol>
                    </div>
                  )}
                  {shuttleAvailable && (
                    <div className="mt-4 rounded-xl bg-[var(--color-public-tint)] p-3 dark:bg-[var(--color-public-paper)]">
                      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border border-[var(--color-public-line)] bg-white px-3 text-sm font-medium dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]">
                        <span>셔틀 이용 신청</span>
                        <span className="flex items-center gap-2 text-xs font-normal tabular-nums text-[var(--color-public-muted)] dark:text-blue-300">
                          {shuttle[item.id]?.useFreeHub ? "무료(거점)" : `${formatWon(cardShuttleFee)} 추가`}
                          <input
                            type="checkbox"
                            checked={shuttle[item.id]?.enabled === true}
                            onChange={(event) => updateShuttle(item.id, "enabled", event.target.checked)}
                            className="size-5"
                          />
                        </span>
                      </label>
                      {shuttle[item.id]?.enabled && <div className="mt-3 grid gap-2 sm:grid-cols-2">
                        {/* 탑승 방식 선택 — 무료 거점이 설정돼 있을 때만 노출. */}
                        {program?.shuttleHub?.pickup && (
                          <div className="grid grid-cols-2 gap-2 sm:col-span-2">
                            {/* 탑승 방식 두 칩 — 고른 쪽은 같은 «고른 것» 모양(하늘색). 그림 문자는 빼고 글자로만. */}
                            <button type="button" aria-pressed={shuttle[item.id]?.useFreeHub === true} onClick={() => setHubMode(item.id, true)} className={`min-h-11 rounded border px-3 text-sm font-medium ${shuttle[item.id]?.useFreeHub ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)] dark:bg-green-950/40 dark:text-green-200" : "border-[var(--color-public-muted)] text-[var(--color-public-muted)] dark:border-[var(--color-public-line)] dark:text-[var(--color-public-muted)]"}`}>무료 거점에서 탑승</button>
                            <button type="button" aria-pressed={!shuttle[item.id]?.useFreeHub} onClick={() => setHubMode(item.id, false)} className={`min-h-11 rounded border px-3 text-sm font-medium ${!shuttle[item.id]?.useFreeHub ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)] dark:bg-orange-950/30 dark:text-[var(--color-public-muted)]" : "border-[var(--color-public-muted)] text-[var(--color-public-muted)] dark:border-[var(--color-public-line)] dark:text-[var(--color-public-muted)]"}`}>집 앞에서 탑승</button>
                          </div>
                        )}
                        {shuttle[item.id]?.useFreeHub ? (
                          // 무료 거점 모드 — 탑승/하차 거점 위치를 안내하고, 셔틀비 무료를 표시한다.
                          <div className="sm:col-span-2 rounded-xl border border-green-200 bg-[var(--color-academy-success-soft)] p-3 dark:border-green-800 dark:bg-green-950/30">
                            <p className="text-sm font-semibold text-[var(--color-academy-success)] dark:text-green-200">무료 탑승 거점 이용 · 셔틀비 무료</p>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              {program?.shuttleHub?.pickup && <HubPointCard label="등원 탑승" point={program.shuttleHub.pickup} />}
                              {(program?.shuttleHub?.dropoff ?? program?.shuttleHub?.pickup) && <HubPointCard label="하원 하차" point={(program?.shuttleHub?.dropoff ?? program?.shuttleHub?.pickup)!} />}
                            </div>
                            <TextInput label="희망 시간" value={shuttle[item.id]?.pickupTime ?? ""} onChange={(value) => updateShuttle(item.id, "pickupTime", value)} />
                            <div className="mt-2"><TextInput label="셔틀 메모" value={shuttle[item.id]?.note ?? ""} onChange={(value) => updateShuttle(item.id, "note", value)} /></div>
                          </div>
                        ) : <>
                          <LocationField label="탑승(등원) 위치" value={shuttle[item.id]?.pickupLocation ?? ""} mapValue={shuttle[item.id]?.pickupLocationData} onChange={(value) => updateLocationText(item.id, "pickup", value)} onOpenMap={() => setLocationPicker({ offeringId: item.id, kind: "pickup" })} />
                          <TextInput label="희망 시간" value={shuttle[item.id]?.pickupTime ?? ""} onChange={(value) => updateShuttle(item.id, "pickupTime", value)} />
                          {/* 하원=등원 동일 토글 — 대부분 같으므로 기본 켜짐. 켜지면 하차 위치 입력을 숨긴다. */}
                          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-[var(--color-public-line)] bg-[var(--color-public-tint)] px-3 py-2.5 text-sm text-[var(--color-public-muted)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-ink)] sm:col-span-2">
                            <input type="checkbox" checked={shuttle[item.id]?.dropoffSameAsPickup ?? true} onChange={(e) => updateShuttle(item.id, "dropoffSameAsPickup", e.target.checked)} className="h-5 w-5 accent-brand-orange-500 dark:accent-brand-neon-lime" />
                            하원(하차)은 등원과 동일
                            <span className="ml-auto text-xs text-[var(--color-public-muted)]">다르면 체크 해제</span>
                          </label>
                          {!(shuttle[item.id]?.dropoffSameAsPickup ?? true) && (
                            <LocationField label="하차(하원) 위치" value={shuttle[item.id]?.dropoffLocation ?? ""} mapValue={shuttle[item.id]?.dropoffLocationData} onChange={(value) => updateLocationText(item.id, "dropoff", value)} onOpenMap={() => setLocationPicker({ offeringId: item.id, kind: "dropoff" })} />
                          )}
                          <TextInput label="셔틀 메모" value={shuttle[item.id]?.note ?? ""} onChange={(value) => updateShuttle(item.id, "note", value)} />
                          {!hasShuttleLocation(shuttle[item.id]) && <p role="alert" className="text-xs font-medium text-[var(--color-academy-warning)] dark:text-amber-300 sm:col-span-2">셔틀 신청 시 지도에서 등원 위치를 반드시 선택해 주세요. (텍스트 설명만으로는 신청되지 않습니다)</p>}
                        </>}
                      </div>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          {/* 고르는 방식 전환 — 시즌에서 날짜별 신청을 켰을 때만 보인다(기본 «요일로 고르기») */}
          {selectedOfferings.length > 0 && dateSelectOn && (
            <div role="group" aria-label="고르는 방식" className="grid grid-cols-2 gap-2">
              {([["WEEKDAY", "요일로 고르기"], ["DATE", "날짜로 고르기"]] as const).map(([mode, label]) => {
                // 요일 모드가 마감되면(시즌·기간 마감) 날짜 모드가 강제로 켜진다 — 버튼 표시도 실제 모드를 따른다
                const active = (isDateMode ? "DATE" : "WEEKDAY") === mode;
                const disabled = mode === "WEEKDAY" && weekdayModeClosed;
                return (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => setSelectionMode(mode)}
                    // 고른 방식 = 보조 색(하늘색) 칩 — 요일 칩과 같은 모양
                    className={`min-h-11 rounded border text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${active ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)]" : "border-[var(--color-public-muted)] text-[var(--color-public-ink)]"}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          {/* 요일 신청 마감 안내 — 남은 날짜로 중간 합류만 받는다(2026-11-18 원장) */}
          {selectedOfferings.length > 0 && weekdayModeClosed && lateJoinDatesLeft && (
            <p role="status" className="rounded-xl bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-warning)]">
              요일 신청은 마감되었습니다. 남은 날짜로 중간 합류할 수 있습니다.
            </p>
          )}
          {/* 수강 기간 — 두 모드 공통. 기간이 2개 이상이면 고르고, 1개면 자동 적용(마감됐으면 안내) */}
          {selectedOfferings.length > 0 && needsPeriodChoice && (
            <fieldset className="rounded-2xl border border-[var(--color-public-line)] bg-white p-4 shadow-sm dark:bg-[var(--color-public-tint)]">
              <legend className="px-1 text-sm font-semibold text-[var(--color-public-ink)]">수강 기간 *</legend>
              <p className="mt-1 text-xs text-[var(--color-public-muted)]">다닐 기간을 골라 주세요. 기간에 따라 수강료가 달라집니다.</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {periodChoices.map((period) => {
                  const checked = appliedPeriod !== null && periodKey(appliedPeriod) === periodKey(period);
                  // 기간별 신청 마감 — 지나면 «신청 마감» 글자와 함께 고를 수 없다
                  const closed = isPeriodClosed(period);
                  // 단, 날짜 선택이 켜져 있고 남은 수업 날이 있으면 «중간 합류»로 고를 수 있다
                  //   (시즌 모집이 마감된 때도 같다 — 남은 날이 없는 기간은 고를 수 없다)
                  const periodDeadline = closed || seasonLateJoin;
                  const lateJoinable = periodDeadline && dateSelectOn && hasLateJoinDates(scopeSessions, todayYmd, period);
                  return (
                    <button
                      key={periodKey(period)}
                      type="button"
                      aria-pressed={checked}
                      disabled={periodDeadline && !lateJoinable}
                      onClick={() => { setSelectedPeriodKey(periodKey(period)); setDateLimitNotice(""); }}
                      className={`min-h-11 rounded border px-3 py-1.5 text-left text-sm font-medium tabular-nums transition disabled:cursor-not-allowed disabled:opacity-60 ${checked ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)]" : "border-[var(--color-public-muted)] text-[var(--color-public-ink)]"}`}
                    >
                      <span className="block">{periodOptionLabel(period)}</span>
                      {lateJoinable
                        ? <span className="block text-xs font-medium text-[var(--color-academy-warning)]">요일 신청 마감 · 남은 날짜로 중간 합류</span>
                        : periodDeadline
                        ? <span className="block text-xs font-medium text-[var(--color-academy-danger)]">신청 마감</span>
                        : period.applicationClosesAt && <span className="block text-xs font-normal text-[var(--color-public-muted)]">{kstLabel(period.applicationClosesAt)} {kstHm(period.applicationClosesAt)} 신청 마감</span>}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          {/* 기간이 하나뿐인데 그 기간 신청이 마감된 경우 */}
          {/* (날짜 선택이 켜져 있고 남은 날이 있으면 위 «중간 합류» 안내로 대신한다) */}
          {selectedOfferings.length > 0 && !needsPeriodChoice && appliedPeriodClosed && !(dateSelectOn && lateJoinDatesLeft) && (
            <p role="alert" className="rounded-xl bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-warning)]">
              {appliedPeriod?.label} 기간은 신청이 마감되었습니다.
            </p>
          )}
          {/* 주 몇 회 — 날짜로 고를 때. 고른 주N회 × 회차가 있는 주 수만큼 날짜를 채운다(2026-11-18) */}
          {selectedOfferings.length > 0 && isDateMode && (
            <fieldset className="rounded-2xl border border-[var(--color-public-line)] bg-white p-4 shadow-sm dark:bg-[var(--color-public-tint)]">
              <legend className="px-1 text-sm font-semibold text-[var(--color-public-ink)]">주 몇 회 *</legend>
              <p className="mt-1 text-xs text-[var(--color-public-muted)]">고른 횟수에 따라 채워야 할 수업 날짜 수와 수강료가 정해집니다.</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {frequencyOptions.map((frequency) => {
                  const checked = weeklyFrequency === frequency;
                  return (
                    <button
                      key={frequency}
                      type="button"
                      aria-pressed={checked}
                      onClick={() => { setSelectedFrequency(frequency); setDateLimitNotice(""); }}
                      className={`min-h-11 rounded border px-3 text-sm font-medium transition ${checked ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)]" : "border-[var(--color-public-muted)] text-[var(--color-public-ink)]"}`}
                    >
                      {weeklyFrequencyLabel(frequency)}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          {/* 날짜로 고르기 — 필요 횟수만큼 날짜를 체크(한 주에 몰아도 된다) */}
          {selectedOfferings.length > 0 && isDateMode && (
            <fieldset className="rounded-2xl border border-[var(--color-public-line)] bg-white p-4 shadow-sm dark:bg-[var(--color-public-tint)]">
              <legend className="px-1 text-sm font-semibold text-[var(--color-public-ink)]">수업 날짜 *</legend>
              <p className="mt-1 text-xs text-[var(--color-public-muted)]">{appliedPeriod ? `${appliedPeriod.label} 기간 안의 ` : ""}수업 날짜를 원하는 대로 골라 주세요. 한 주에 몰아서 골라도 됩니다.</p>
              {/* 수업을 둘 이상 골랐으면 제출 전에 바로 알려 준다(제출 버튼도 막힌다) */}
              {dateModeTooMany && (
                <p role="alert" className="mt-2 text-sm font-medium text-[var(--color-academy-warning)]">
                  날짜로 고를 때는 수업을 하나만 신청할 수 있습니다. 위에서 수업을 하나만 남겨 주세요.
                </p>
              )}
              {needsPeriodChoice && !appliedPeriod ? (
                <p className="mt-3 text-sm text-[var(--color-public-muted)]">먼저 수강 기간을 골라 주세요.</p>
              ) : weeklyFrequency === null ? (
                <p className="mt-3 text-sm text-[var(--color-public-muted)]">먼저 주 몇 회인지 골라 주세요.</p>
              ) : dateOptions.length === 0 ? (
                <p className="mt-3 text-sm text-[var(--color-public-muted)]">지금 고를 수 있는 수업 날짜가 없습니다.</p>
              ) : (
                <>
                  {/* 중간 합류 안내 — 남은 회차에서 고르고, 수강료는 남은 회차만큼(정상 → 실제). 시작 전 신청이면 안 보인다 */}
                  {prorated && selectionPlans[0] && (
                    <p className="mt-3 rounded-xl bg-[var(--color-public-secondary-soft)] px-3 py-2 text-sm tabular-nums text-[var(--color-public-secondary-ink)]">
                      오늘부터 남은 수업 {dateOptions.length}회 중에서 고릅니다 · 수강료는 남은 회차만큼(정상 {formatWon(selectionPlans[0].normalTuition)} → {formatWon(selectionPlans[0].tuition)})
                    </p>
                  )}
                  {/* 몇 회 중 몇 회 — 이 화면의 진행 안내 */}
                  <p role="status" className={`mt-3 text-sm font-medium tabular-nums ${dateCountOk ? "text-[var(--color-academy-success)]" : "text-[var(--color-public-ink)]"}`}>
                    {dateCountProgressText(selectedDates.length, requiredDates)}
                  </p>
                  {dateLimitNotice && <p role="alert" className="mt-1 text-xs font-medium text-[var(--color-academy-warning)]">{dateLimitNotice}</p>}
                  {dateOptions.some((option) => option.full) && (
                    <p className="mt-1 text-xs text-[var(--color-public-muted)]">«마감»된 날짜가 있으면 대기로 접수됩니다.</p>
                  )}
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {dateOptions.map((option) => {
                      const checked = selectedDates.includes(option.dateKey);
                      return (
                        <li key={option.dateKey}>
                          <label className={`flex min-h-11 cursor-pointer items-center gap-3 rounded border px-3 text-sm tabular-nums ${checked ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)]" : "border-[var(--color-public-muted)] text-[var(--color-public-ink)]"}`}>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleDate(option.dateKey)}
                              className="size-5"
                            />
                            <span className="flex-1">{option.label}</span>
                            {/* 정원이 찬 날 — 고를 수는 있고, 고르면 대기 접수 */}
                            {option.full && <span className="text-xs font-medium text-[var(--color-academy-danger)]">마감</span>}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {weeklyFrequency !== null && periodReady && !hasPricingMatch && (
                <p role="alert" className="mt-3 rounded-xl bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-warning)]">
                  {weeklyFrequencyLabel(weeklyFrequency)} 수강료가 아직 정해지지 않았습니다. 학원에 문의해 주세요.
                </p>
              )}
            </fieldset>
          )}
          {selectedOfferings.length > 0 && !isDateMode && (
            <fieldset className="rounded-2xl border border-[var(--color-public-line)] bg-white p-4 shadow-sm dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]">
              <legend className="px-1 text-sm font-semibold text-[var(--color-public-ink)] dark:text-white">참여 요일 *</legend>
              <p className="mt-1 text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">선택한 요일 수에 맞춰 주2·주3·주5 수강료가 자동 적용됩니다.</p>
              <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-7">
                {WEEKDAY_OPTIONS.map((option) => {
                  const enabled = availableWeekdays.includes(option.value);
                  const checked = selectedWeekdays.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      disabled={!enabled}
                      onClick={() => toggleWeekday(option.value)}
                      // 고른 요일 = 보조 색(하늘색) 칩
                      className={`min-h-11 rounded border text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-35 ${checked ? "border-[var(--color-public-secondary-strong)] bg-[var(--color-public-secondary-soft)] text-[var(--color-public-secondary-ink)] dark:border-brand-neon-lime dark:bg-brand-neon-lime dark:text-brand-navy-900" : "border-[var(--color-public-muted)] text-[var(--color-public-ink)] dark:border-[var(--color-public-line)] dark:text-[var(--color-public-ink)]"}`}
                      aria-pressed={checked}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              {!hasPricingMatch && selectedWeekdays.length > 0 && periodReady && (
                <p role="alert" className="mt-3 rounded-xl border border-amber-200 bg-[var(--color-academy-warning-soft)] px-3 py-2 text-xs text-[var(--color-academy-warning)] dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                  {/* 기간을 쓰는 반이면 기간까지 함께 말한다(서버 PERIOD_PRICE_NOT_CONFIGURED 와 같은 문구) */}
                  {appliedPeriod ? "선택한 기간·요일 수에 맞는 수강료가 아직 설정되지 않았습니다." : `선택한 ${selectedWeekdays.length}개 요일에 맞는 수강료가 아직 설정되지 않았습니다.`}
                </p>
              )}
            </fieldset>
          )}
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <div className="space-y-4 rounded-2xl border border-[var(--color-public-line)] bg-white p-5 shadow-sm dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]">
            <h2 className="text-xl font-bold text-[var(--color-public-ink)] dark:text-white">신청 정보</h2>
            <fieldset>
              <legend className="text-sm font-semibold text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">회원 구분 *</legend>
              <p className="mt-1 text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">현재 학원에 등록된 학생인지 선택해 주세요. 회원별 수강료 확인에 사용됩니다.</p>
              {/* 재원생 할인 고지(2026-11-18 원장) — 휴원하고 특강만 들으면 신규 수강료 */}
              <p className="mt-1 text-xs font-medium text-[var(--color-academy-warning)]">{EXISTING_DISCOUNT_NOTICE}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {([[
                  "EXISTING",
                  "기존 회원",
                ], [
                  "NEW",
                  "신규 회원",
                ]] as const).map(([value, label]) => (
                  <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded border border-[var(--color-public-muted)] px-3 text-sm text-[var(--color-public-ink)] dark:border-[var(--color-public-line)] dark:text-[var(--color-public-ink)]">
                    <input
                      type="radio"
                      name="applicantType"
                      value={value}
                      checked={applicantType === value}
                      onChange={() => setApplicantType(value)}
                      required
                    />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput label="학생 이름 *" value={form.childName} onChange={(value) => update("childName", value)} required />
              <DateInput label="학생 생년월일 *" value={form.childBirthDate} onChange={(value) => update("childBirthDate", value)} required />
              <TextInput label="학생 성별" value={form.childGender} onChange={(value) => update("childGender", value)} placeholder="예: 남 / 여" />
              <TextInput label="학년" value={form.childGrade} onChange={(value) => update("childGrade", value)} placeholder="예: 초4" />
              <TextInput label="학교" value={form.childSchool} onChange={(value) => update("childSchool", value)} />
              <TextInput label="학생 연락처" value={form.childPhone} onChange={(value) => update("childPhone", value)} inputMode="tel" />
              <TextInput label="보호자 이름 *" value={form.parentName} onChange={(value) => update("parentName", value)} required />
              <TextInput label="보호자 연락처 *" value={form.parentPhone} onChange={(value) => update("parentPhone", value)} inputMode="tel" required />
              <TextInput label="보호자 관계" value={form.parentRelation} onChange={(value) => update("parentRelation", value)} />
              <TextInput label="주소" value={form.address} onChange={(value) => update("address", value)} />
            </div>
            <label className="block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
              요청 사항
              <textarea
                value={form.memo}
                onChange={(event) => update("memo", event.target.value)}
                rows={4}
                className="mt-1 w-full rounded-xl border border-gray-300 bg-white p-3 text-sm text-[var(--color-public-ink)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white dark:focus:ring-brand-neon-lime"
                placeholder="상담 시 참고할 내용을 적어주세요"
              />
            </label>
          </div>

          <aside className="space-y-4 rounded-2xl border border-[var(--color-public-line)] bg-white p-5 shadow-sm dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]">
            <h2 className="text-xl font-bold text-[var(--color-public-ink)] dark:text-white">신청 요약</h2>
            <div className="space-y-2">
              {selectedOfferings.length === 0 ? (
                <p className="rounded-xl bg-[var(--color-public-tint)] p-4 text-sm text-[var(--color-public-muted)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-muted)]">선택한 수업이 없습니다.</p>
              ) : selectionPlans.map((plan) => {
                const item = plan.offering ?? plan.base;
                const weekdayText = selectedWeekdays.map((weekday) => WEEKDAY_OPTIONS.find((option) => option.value === weekday)?.label).filter(Boolean).join("·") || "요일 미선택";
                // 기간을 고른 경우: 그 기간 안의 고른 요일 회차만 센다(서버 출석 규칙과 같은 함수)
                const periodSessions = plan.period
                  ? pickSessionDatesForApplication(
                    item.sessionDates.map((session, index) => ({ ...session, id: String(index) })),
                    { selectedWeekdays, periodStartDate: plan.period.startDate, periodEndDate: plan.period.endDate },
                  )
                  : null;
                return (
                <div key={plan.base.id} className="rounded-xl bg-[var(--color-public-tint)] p-3 text-sm dark:bg-[var(--color-public-paper)]">
                  <p className="font-medium text-[var(--color-public-ink)] dark:text-white">{plan.base.name}</p>
                  {/* 확인 요약 — 날짜 모드 «날짜 선택 5회 · 1/4(월), …» / 기간 «4주 · 월·수 · 총 8회» / 그 밖은 예전 그대로 */}
                  {isDateMode ? (
                    <p className="mt-1 text-xs tabular-nums text-[var(--color-public-muted)]">날짜 선택 {selectedDates.length}회{selectedDates.length > 0 ? ` · ${selectedDates.map((key) => kstLabel(key)).join(", ")}` : ""}</p>
                  ) : plan.period && periodSessions ? (
                    <p className="mt-1 text-xs tabular-nums text-[var(--color-public-muted)]">{plan.period.label} · {weekdayText} · 총 {periodSessions.length}회 · {item.startTime}~{item.endTime}</p>
                  ) : (
                    <p className="mt-1 text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{weekdayText} · {item.startTime}~{item.endTime}</p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums">
                    {/* 기간·날짜 모드는 계산된 수강료, 그 밖은 예전 그대로 반의 회원별 가격 */}
                    <span>수강료 {plan.period || isDateMode ? formatWon(plan.tuition) : formatWon(applicantPrice(item, applicantType))}</span>
                    {hasShuttle(shuttle[plan.base.id]) && hasShuttleLocation(shuttle[plan.base.id]) && (
                      shuttle[plan.base.id]?.useFreeHub
                        ? <span className="text-[var(--color-academy-success)] dark:text-green-300">셔틀비 무료(거점)</span>
                        : <span className="text-[var(--color-public-muted)] dark:text-blue-300">셔틀비 +{formatWon(planShuttleFee(plan))}</span>
                    )}
                  </div>
                  {!isDateMode && periodSessions && periodSessions.length > 0 && <p className="mt-1 text-xs text-[var(--color-public-muted)]">{periodSessions.map((session) => `${session.dateLabel}(${session.dayLabel})`).join(", ")}</p>}
                  {!isDateMode && !periodSessions && item.sessionDates.length > 1 && <p className="mt-1 text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">총 {item.sessionDates.length}회 · {item.sessionDates.map((session) => `${session.dateLabel}(${session.dayLabel})`).join(", ")}</p>}
                  {/* 정원이 찼으면 대기 접수 — 요일 모드는 반 단위, 날짜 모드는 고른 날짜 중 «마감» 날짜가 있을 때(2026-11-18) */}
                  {(isDateMode ? selectedFullDates.length > 0 : isFull(item)) && <p className="mt-1 text-xs font-medium text-[var(--color-academy-warning)] dark:text-amber-300">대기 접수로 신청됩니다.</p>}
                </div>
                );
              })}
            </div>
            <div className="border-t border-[var(--color-public-line)] pt-4 dark:border-[var(--color-public-line)]">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">수강료</dt><dd className="font-medium tabular-nums">{formatWon(tuitionTotal)}</dd></div>
                <div className="flex justify-between"><dt className="text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">셔틀비</dt><dd className="font-medium tabular-nums text-[var(--color-public-muted)] dark:text-blue-300">{shuttleTotal ? `+${formatWon(shuttleTotal)}` : formatWon(0)}</dd></div>
              </dl>
              <p className="mt-3 text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">최종 예상금액</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-[var(--color-public-ink)] dark:text-white">{formatWon(totalPrice)}</p>
              {/* 형제 여부는 등록된 보호자 연락처로 서버가 확인한다. 화면에서 미리 단정하면 실제 청구액과 어긋나므로
                  여기서는 안내만 하고, 실제 할인 금액은 접수 완료 화면에서 서버가 확정한 값으로 보여준다. */}
              <p className="mt-2 text-xs text-[var(--color-academy-success)] dark:text-emerald-300">
                형제·자매가 함께 신청하면 수강료 10%가 자동 할인됩니다. (셔틀비 제외 · 접수 후 금액에 반영)
              </p>
              <p className="mt-1 text-xs text-[var(--color-academy-warning)]">{EXISTING_DISCOUNT_NOTICE}</p>
            </div>
            <CheckBox label="방학특강 운영 안내와 환불 규정을 확인했습니다." checked={form.agreedTerms} onChange={(checked) => update("agreedTerms", checked)} />
            <CheckBox label="신청과 상담을 위한 개인정보 수집·이용에 동의합니다." checked={form.agreedPrivacy} onChange={(checked) => update("agreedPrivacy", checked)} />
            {hasMapSelection && (
              <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 dark:border-orange-500/30 dark:bg-orange-500/10">
                <CheckBox label="셔틀 운행과 노선 편성을 위해 선택한 승하차 위치(주소·좌표)를 수집·이용하는 데 동의합니다." checked={locationConsent} onChange={setLocationConsent} />
                <p className="mt-2 pl-6 text-xs leading-5 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">위치 정보는 셔틀 배정과 운행 안내에 사용됩니다. 동의하지 않으면 지도 위치를 제거하고 텍스트로 위치를 적어주세요.</p>
              </div>
            )}
          </aside>
        </section>
      </div>

      {/* 하단 고정 바 — 높이를 --public-bottom-bar 로 알려 플로팅 버튼이 바 위로 올라간다(게슈탈트 C-P3) */}
      <PublicBottomBar className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--color-public-line)] bg-white/95 p-3 backdrop-blur dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)]/95">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 sm:flex-nowrap">
          <div className="hidden min-w-0 flex-1 sm:block">
            <p className="truncate text-sm font-medium text-[var(--color-public-ink)] dark:text-white">{selectedOfferings.length}개 수업 선택 · {formatWon(totalPrice)}</p>
            <p className="text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">제출 후 학원에서 확인 연락을 드립니다.</p>
          </div>
          {/* 취소·돌아가기 = 상세에서 왔으면 한 칸 뒤로(ReturnLink) — 쌓으면 상세의 «←» 가 이 신청서로 되돌아왔다(2026-11-17) */}
          <ReturnLink href={`${basePath}/${slug}`} className="public-btn-secondary">취소</ReturnLink>
          {incompleteItems.length > 0 && submitState !== "submitting" && <p id="seasonal-apply-incomplete" role="status" className="order-first w-full text-xs text-[var(--color-academy-warning)] sm:order-none sm:min-w-0 sm:flex-1">미완료: {incompleteItems.join(" · ")}</p>}
          <button
            type="submit"
            disabled={!canSubmit}
            aria-describedby={incompleteItems.length > 0 ? "seasonal-apply-incomplete" : undefined}
            // 이 화면의 주인공 버튼 하나(네이비). 모양은 공개 테마 public-btn-primary 가 정한다.
            className="public-btn-primary flex-1 disabled:cursor-not-allowed disabled:opacity-50 sm:flex-none"
          >
            {submitState === "submitting" ? "접수 중..." : "신청 접수"}
          </button>
        </div>
      </PublicBottomBar>

      {locationPicker && (
        <LocationPickerModal
          title={locationPicker.kind === "pickup" ? "탑승 위치 선택" : "하차 위치 선택"}
          initialValue={locationPicker.kind === "pickup" ? shuttle[locationPicker.offeringId]?.pickupLocationData : shuttle[locationPicker.offeringId]?.dropoffLocationData}
          onClose={() => setLocationPicker(null)}
          onConfirm={(value) => saveMapLocation(locationPicker, value)}
        />
      )}
    </form>
  );
}

function DoneView({ slug, basePath, homeHref, result, offerings, message }: { slug: string; basePath: string; homeHref: string; result: SubmitResult | null; offerings: SeasonalClass[]; message: string }) {
  const byId = new Map(offerings.map((item) => [item.id, item]));
  return (
    <main className="bg-[var(--color-public-tint)] px-4 py-12 dark:bg-[var(--color-public-paper)]">
      <section className="mx-auto max-w-xl rounded-2xl border border-[var(--color-public-line)] bg-white p-8 text-center shadow-sm dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--color-academy-success-soft)] text-sm font-semibold text-[var(--color-academy-success)] dark:bg-green-500/15 dark:text-green-200">완료</div>
        <h1 className="mt-5 text-2xl font-bold text-[var(--color-public-ink)] dark:text-white">신청이 접수되었습니다</h1>
        <p className="mt-2 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{message}</p>
        {result?.items && result.items.length > 0 && (
          <div className="mt-6 space-y-2 text-left">
            {result.items.map((item) => (
              <div key={item.offeringId} className="rounded-xl bg-[var(--color-public-tint)] p-3 text-sm dark:bg-[var(--color-public-paper)]">
                <p className="font-medium text-[var(--color-public-ink)] dark:text-white">{byId.get(item.offeringId)?.name ?? "선택 수업"}</p>
                <p className="mt-1 text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
                  {statusText(item.status)}{item.waitlistOrder ? ` · 대기 ${item.waitlistOrder}번` : ""}
                  {typeof item.priceSnapshot === "number" ? ` · ${formatWon(item.priceSnapshot)}` : ""}
                </p>
                {/* 서버가 확정한 형제할인 금액을 그대로 보여준다(화면에서 다시 계산하지 않는다). */}
                {(item.siblingDiscountSnapshot ?? 0) > 0 && (
                  <p className="mt-1 text-xs font-medium text-[var(--color-academy-success)] dark:text-emerald-300">
                    수강료 {formatWon(item.tuitionPriceSnapshot ?? 0)} · 형제할인 −{formatWon(item.siblingDiscountSnapshot ?? 0)}
                    {(item.shuttleFeeSnapshot ?? 0) > 0 ? ` · 셔틀비 +${formatWon(item.shuttleFeeSnapshot ?? 0)}` : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          {/* 신청 완료 뒤 이동은 replace(2026-11-17) — 쌓으면 그 화면의 «←» 가 빈 신청서로 되돌아왔다 */}
          <ReplaceLink href={`${basePath}/${slug}`} className="public-btn-secondary">상세 보기</ReplaceLink>
          <ReplaceLink href={homeHref} className="public-btn-primary">홈으로</ReplaceLink>
        </div>
      </section>
    </main>
  );
}

// 무료 거점 위치 안내 카드 — 주소·좌표와 카카오맵 링크(위치 확인)를 보여준다.
function HubPointCard({ label, point }: { label: string; point: { name: string; lat: number; lng: number } }) {
  const mapHref = `https://map.kakao.com/link/map/${encodeURIComponent(point.name)},${point.lat},${point.lng}`;
  return (
    <div className="rounded-lg border border-green-200 bg-white p-2.5 dark:border-green-800 dark:bg-[var(--color-public-paper)]">
      <p className="text-xs font-medium text-[var(--color-academy-success)] dark:text-green-300">{label}</p>
      <p className="mt-0.5 text-sm font-medium text-[var(--color-public-ink)] dark:text-white">{point.name}</p>
      <a href={mapHref} target="_blank" rel="noreferrer" className="mt-1 inline-flex min-h-11 items-center gap-1 text-xs font-medium text-[var(--color-public-strong)] underline underline-offset-2 dark:text-brand-neon-lime">지도에서 위치 확인</a>
    </div>
  );
}

function LocationField({
  label,
  value,
  mapValue,
  onChange,
  onOpenMap,
}: {
  label: string;
  value: string;
  mapValue?: MapLocationData;
  onChange: (value: string) => void;
  onOpenMap: () => void;
}) {
  return (
    <div className={`rounded-xl border p-3 ${mapValue ? "border-green-300 bg-[var(--color-academy-success-soft)]/50 dark:border-green-600/50 dark:bg-green-900/10" : "border-amber-300 bg-[var(--color-academy-warning-soft)]/40 dark:border-amber-500/40 dark:bg-amber-900/10"} dark:bg-[var(--color-public-tint)]`}>
      <p className="text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">{label} <span className="text-red-500">*</span></p>
      {/* 지도 핀이 실제 위치의 기준 — 버튼을 1순위로 노출한다 */}
      {/* 꽉 찬 주 색은 맨 아래 «신청 접수» 하나만 — 지도 열기는 테두리 버튼. 지정 뒤에는 초록 테두리로 «완료»를 알린다. */}
      <button type="button" onClick={onOpenMap} className={`mt-2 flex min-h-11 w-full items-center justify-center gap-1 rounded px-3 text-sm font-medium ${mapValue ? "border border-[var(--color-academy-success)] text-[var(--color-academy-success)] dark:border-green-500 dark:text-green-300" : "border border-[var(--color-public-accent)] text-[var(--color-public-accent)] dark:border-brand-neon-lime dark:text-brand-neon-lime"}`}>
        {mapValue ? "지도 위치 지정됨 · 다시 선택" : "지도에서 위치 선택 (필수)"}
      </button>
      {mapValue && <p className="mt-2 text-xs text-[var(--color-academy-success)] dark:text-green-300">선택한 위치 · {mapValue.roadAddress ?? mapValue.address}</p>}
      {/* 텍스트는 위치 설명(선택) — 지도 핀을 찍으면 주소가 자동 입력되며, 수정해 상세 설명을 남길 수 있다. 좌표를 대체하지 않는다 */}
      <label className="mt-2 block text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
        위치 설명 (선택 · 지도 선택 시 자동 입력)
        <input type="text" value={value} onChange={(event) => onChange(event.target.value)} placeholder="예: 아파트 정문, 2동 앞" className="mt-1 w-full rounded-xl border border-gray-300 bg-white p-2.5 text-sm text-[var(--color-public-ink)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white" />
      </label>
    </div>
  );
}

function TextInput({
  label,
  value,
  onChange,
  placeholder,
  required,
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  inputMode?: "text" | "tel";
}) {
  return (
    <label className="block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
      {label}
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        className="mt-1 w-full rounded-xl border border-gray-300 bg-white p-3 text-sm text-[var(--color-public-ink)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white dark:focus:ring-brand-neon-lime"
      />
    </label>
  );
}

function DateInput({ label, value, onChange, required }: { label: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return (
    <label className="block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
      {label}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        className="mt-1 w-full rounded-xl border border-gray-300 bg-white p-3 text-sm text-[var(--color-public-ink)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-white dark:focus:ring-brand-neon-lime"
      />
    </label>
  );
}

function CheckBox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 rounded border-gray-300 text-[var(--color-public-accent)] focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)]"
      />
      <span>{label}</span>
    </label>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{label}</dt><dd className="mt-0.5 font-medium text-[var(--color-public-ink)] dark:text-white">{value}</dd></div>;
}

function StatusBox({ text, retry }: { text: string; retry?: boolean }) {
  return (
    <div className="bg-[var(--color-public-tint)] px-4 py-12 dark:bg-[var(--color-public-paper)]">
      <div className="mx-auto max-w-3xl rounded-2xl border border-[var(--color-public-line)] bg-white p-10 text-center dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)]">
        <p className="text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{text}</p>
        {retry && <button type="button" onClick={() => location.reload()} className="public-btn-secondary mt-4">다시 시도</button>}
      </div>
    </div>
  );
}
