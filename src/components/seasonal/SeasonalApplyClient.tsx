"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";
import { formatWon, normalizeProgram, programClasses, type SeasonalClass, type SeasonalProgram } from "./types";

type LoadState = "loading" | "ready" | "error";
type SubmitState = "idle" | "submitting" | "done" | "error";
type ApplicantType = "NEW" | "EXISTING";
type SeasonalWeekday = SeasonalClass["weekdays"][number];

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

function matchingOfferingForWeekdays(
  offerings: SeasonalClass[],
  base: SeasonalClass,
  selectedWeekdays: SeasonalWeekday[],
) {
  if (selectedWeekdays.length === 0) return null;
  const candidates = offerings.filter((item) => operationalClassKey(item) === operationalClassKey(base));
  const frequencyCandidates = candidates.filter((item) => seasonalOfferingFrequency(item) !== null);
  if (frequencyCandidates.length === 0) return base;
  return frequencyCandidates.find((item) => seasonalOfferingFrequency(item) === selectedWeekdays.length) ?? null;
}

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

function isFull(item: SeasonalClass) {
  return item.capacity !== null && (item.remaining ?? 0) <= 0;
}

function remainingText(item: SeasonalClass) {
  if (item.capacity === null) return "접수 가능";
  const remaining = item.remaining ?? 0;
  if (remaining > 0) return `${remaining}석`;
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
  if (status === "WAITLISTED") return "대기 접수";
  if (status === "APPROVED") return "승인";
  if (status === "PENDING") return "접수";
  return status;
}

function applicantPrice(item: SeasonalClass, applicantType: ApplicantType | "") {
  if (applicantType === "NEW") return item.newApplicantPrice ?? item.price;
  if (applicantType === "EXISTING") return item.existingApplicantPrice ?? item.price;
  return item.price;
}

export default function SeasonalApplyClient({ slug }: { slug: string }) {
  const [state, setState] = useState<LoadState>("loading");
  const [program, setProgram] = useState<SeasonalProgram | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectedWeekdayKeys, setSelectedWeekdayKeys] = useState<SeasonalWeekday[]>([]);
  const [applicantType, setApplicantType] = useState<ApplicantType | "">("");
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [shuttle, setShuttle] = useState<Record<string, ShuttleDraft>>({});
  const [locationPicker, setLocationPicker] = useState<LocationPickerTarget | null>(null);
  const [locationConsent, setLocationConsent] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<SubmitResult | null>(null);
  const idempotencyKeyRef = useRef(makeIdempotencyKey());

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
        setMessage(error instanceof Error ? error.message : "특강 정보를 불러오지 못했습니다.");
        setState("error");
      });
    return () => controller.abort();
  }, [slug]);

  const offerings = useMemo(() => program ? programClasses(program) : [], [program]);
  const selectedOfferings = offerings.filter((item) => selectedIds.includes(item.id));
  const availableWeekdays = Array.from(new Set(selectedOfferings.flatMap(offeringWeekdays)));
  const selectedWeekdays = selectedWeekdayKeys.filter((weekday) => availableWeekdays.includes(weekday));
  const selectionPlans = selectedOfferings.map((item) => ({
    base: item,
    offering: matchingOfferingForWeekdays(offerings, item, selectedWeekdays),
  }));
  const hasPricingMatch = selectedOfferings.length > 0 && selectionPlans.every((plan) => Boolean(plan.offering));
  // 신청자가 고른 회원 구분과 서버의 가격 스냅샷 기준을 화면에서도 동일하게 맞춘다.
  const tuitionTotal = selectionPlans.reduce((sum, plan) => sum + applicantPrice(plan.offering ?? plan.base, applicantType), 0);
  const shuttleTotal = selectionPlans.reduce((sum, { base, offering }) => (
    sum + shuttleFeeForDraft(offering ?? base, shuttle[base.id])
  ), 0);
  const totalPrice = tuitionTotal + shuttleTotal;
  const hasMapSelection = selectionPlans.some(({ base, offering }) => (
    offering?.shuttleAvailable
    && (shuttle[base.id]?.pickupLocationData || shuttle[base.id]?.dropoffLocationData)
  ));
  const incompleteShuttlePlans = selectionPlans.filter(({ base, offering }) => (
    offering?.shuttleAvailable && hasShuttle(shuttle[base.id]) && !hasShuttleLocation(shuttle[base.id])
  ));
  const canSubmit = selectedIds.length > 0 && applicantType && form.childName && form.childBirthDate && form.parentName
    && form.parentPhone && selectedWeekdays.length > 0 && hasPricingMatch
    && incompleteShuttlePlans.length === 0
    && form.agreedTerms && form.agreedPrivacy && (!hasMapSelection || locationConsent)
    && submitState !== "submitting";
  const incompleteItems = [
    selectedIds.length === 0 ? "신청할 수업" : "",
    selectedIds.length > 0 && selectedWeekdays.length === 0 ? "참여 요일" : "",
    selectedIds.length > 0 && selectedWeekdays.length > 0 && !hasPricingMatch ? "요일 수에 맞는 수강료" : "",
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
    setSelectedIds((current) => {
      if (current.includes(item.id)) {
        setSelectedWeekdayKeys([]);
        return [];
      }
      const frequency = seasonalOfferingFrequency(item);
      const weekdays = offeringWeekdays(item);
      setSelectedWeekdayKeys(frequency ? weekdays.slice(0, frequency) : []);
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
          selectedWeekdays,
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
      setResult(body as SubmitResult);
      setSubmitState("done");
      setMessage("신청이 접수되었습니다. 학원에서 확인 후 안내드릴게요.");
    } catch (error) {
      setSubmitState("error");
      setMessage(error instanceof Error ? error.message : "신청을 저장하지 못했습니다.");
    }
  }

  if (state === "loading") return <StatusBox icon="progress_activity" text="신청 정보를 불러오고 있어요." />;
  if (state === "error" || !program) return <StatusBox icon="error" text={message || "신청 정보를 불러오지 못했습니다."} retry />;
  if (submitState === "done") return <DoneView slug={slug} result={result} offerings={offerings} message={message} />;

  return (
    <form onSubmit={handleSubmit} className="bg-gray-50 px-4 py-8 pb-28 dark:bg-gray-900">
      <div className="mx-auto max-w-5xl space-y-6">
        <header>
          <Link href={`/seasonal/${slug}`} className="text-sm font-bold text-brand-orange-500 dark:text-brand-neon-lime">특강 상세로 돌아가기</Link>
          <p className="mt-5 text-sm font-bold text-brand-orange-500 dark:text-brand-neon-lime">방학특강 신청</p>
          <h1 className="mt-2 text-3xl font-black text-gray-900 dark:text-white">{program.title}</h1>
          {program.summary && <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600 dark:text-gray-300">{program.summary}</p>}
        </header>

        {message && (
          <p role={submitState === "error" ? "alert" : "status"} aria-live={submitState === "error" ? "assertive" : "polite"} className={`rounded-xl border px-4 py-3 text-sm font-bold ${submitState === "error" ? "border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100" : "border-green-200 bg-green-50 text-green-800 dark:border-green-500/30 dark:bg-green-500/10 dark:text-green-100"}`}>
            {message}
          </p>
        )}

        <section className="space-y-3">
          <div>
            <h2 className="text-xl font-black text-gray-900 dark:text-white">수업 선택</h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">신청할 반을 선택한 뒤 실제 참여할 요일을 골라주세요.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {offerings.map((item) => {
              const selected = selectedIds.includes(item.id);
              const disabled = isFull(item) && !item.waitlistEnabled;
              const priceItem = selected ? matchingOfferingForWeekdays(offerings, item, selectedWeekdays) ?? item : item;
              const shuttleAvailable = selected && priceItem.shuttleAvailable;
              return (
                <article key={item.id} className={`rounded-2xl border bg-white p-5 shadow-sm dark:bg-gray-800 ${selected ? "border-brand-orange-500 ring-2 ring-brand-orange-100 dark:border-brand-neon-lime dark:ring-brand-neon-lime/20" : "border-gray-200 dark:border-gray-700"} ${disabled ? "opacity-60" : ""}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-bold text-brand-orange-500 dark:text-brand-neon-lime">{item.dayLabel} {item.dateLabel}</p>
                      <h3 className="mt-1 text-lg font-black text-gray-900 dark:text-white">{item.name}</h3>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleOffering(item)}
                      disabled={disabled}
                      className={`min-h-10 rounded-xl px-4 text-sm font-black transition ${selected ? "bg-brand-orange-500 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900" : "border border-gray-300 text-gray-700 dark:border-gray-600 dark:text-gray-200"} disabled:cursor-not-allowed`}
                    >
                      {selected ? "선택됨" : disabled ? "마감" : "선택"}
                    </button>
                  </div>
                  <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <Pair label="시간" value={`${item.startTime}~${item.endTime}`} />
                    <Pair label="대상" value={item.targetGrade || "전체"} />
                    <Pair label="잔여" value={remainingText(item)} />
                    <Pair label="수강료" value={formatWon(applicantPrice(priceItem, applicantType))} />
                  </dl>
                  {item.sessionDates.length > 0 && (
                    <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700">
                      <p className="text-sm font-black text-gray-900 dark:text-white">전체 수업 일정 · {item.sessionDates.length}회</p>
                      <ol className="mt-2 space-y-1.5">
                        {item.sessionDates.map((session, index) => <li key={`${session.startsAt}-${index}`} className="text-xs text-gray-600 dark:text-gray-300"><span className="mr-2 font-bold text-brand-orange-500 dark:text-brand-neon-lime">{index + 1}회</span>{session.dateLabel} ({session.dayLabel}) {session.startTime}~{session.endTime}</li>)}
                      </ol>
                    </div>
                  )}
                  {shuttleAvailable && (
                    <div className="mt-4 rounded-xl bg-gray-50 p-3 dark:bg-gray-900">
                      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white px-3 text-sm font-black dark:border-gray-700 dark:bg-gray-800">
                        <span>셔틀 이용 신청</span>
                        <span className="flex items-center gap-2 text-xs text-blue-700 dark:text-blue-300">
                          {shuttle[item.id]?.useFreeHub ? "무료(거점)" : `${formatWon(priceItem.shuttleFee ?? 0)} 추가`}
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
                            <button type="button" onClick={() => setHubMode(item.id, true)} className={`min-h-11 rounded-xl border px-3 text-sm font-black ${shuttle[item.id]?.useFreeHub ? "border-green-500 bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-200" : "border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300"}`}>🆓 무료 거점에서 탑승</button>
                            <button type="button" onClick={() => setHubMode(item.id, false)} className={`min-h-11 rounded-xl border px-3 text-sm font-black ${!shuttle[item.id]?.useFreeHub ? "border-brand-orange-500 bg-orange-50 text-brand-orange-700 dark:bg-orange-950/30 dark:text-brand-orange-300" : "border-gray-200 text-gray-600 dark:border-gray-700 dark:text-gray-300"}`}>📍 집 앞에서 탑승</button>
                          </div>
                        )}
                        {shuttle[item.id]?.useFreeHub ? (
                          // 무료 거점 모드 — 탑승/하차 거점 위치를 안내하고, 셔틀비 무료를 표시한다.
                          <div className="sm:col-span-2 rounded-xl border border-green-200 bg-green-50 p-3 dark:border-green-800 dark:bg-green-950/30">
                            <p className="text-sm font-black text-green-800 dark:text-green-200">🆓 무료 탑승 거점 이용 · 셔틀비 무료</p>
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
                          <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2.5 text-sm font-bold text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 sm:col-span-2">
                            <input type="checkbox" checked={shuttle[item.id]?.dropoffSameAsPickup ?? true} onChange={(e) => updateShuttle(item.id, "dropoffSameAsPickup", e.target.checked)} className="h-5 w-5 accent-brand-orange-500 dark:accent-brand-neon-lime" />
                            하원(하차)은 등원과 동일
                            <span className="ml-auto text-xs font-medium text-gray-400">다르면 체크 해제</span>
                          </label>
                          {!(shuttle[item.id]?.dropoffSameAsPickup ?? true) && (
                            <LocationField label="하차(하원) 위치" value={shuttle[item.id]?.dropoffLocation ?? ""} mapValue={shuttle[item.id]?.dropoffLocationData} onChange={(value) => updateLocationText(item.id, "dropoff", value)} onOpenMap={() => setLocationPicker({ offeringId: item.id, kind: "dropoff" })} />
                          )}
                          <TextInput label="셔틀 메모" value={shuttle[item.id]?.note ?? ""} onChange={(value) => updateShuttle(item.id, "note", value)} />
                          {!hasShuttleLocation(shuttle[item.id]) && <p role="alert" className="text-xs font-bold text-amber-700 dark:text-amber-300 sm:col-span-2">🚌 셔틀 신청 시 지도에서 등원 위치를 반드시 선택해 주세요. (텍스트 설명만으로는 신청되지 않습니다)</p>}
                        </>}
                      </div>}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          {selectedOfferings.length > 0 && (
            <fieldset className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
              <legend className="px-1 text-sm font-black text-gray-900 dark:text-white">참여 요일 *</legend>
              <p className="mt-1 text-xs font-bold text-gray-500 dark:text-gray-400">선택한 요일 수에 맞춰 주2·주3·주5 수강료가 자동 적용됩니다.</p>
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
                      className={`min-h-11 rounded-xl border text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-35 ${checked ? "border-brand-orange-500 bg-brand-orange-500 text-white dark:border-brand-neon-lime dark:bg-brand-neon-lime dark:text-brand-navy-900" : "border-gray-300 text-gray-700 dark:border-gray-600 dark:text-gray-200"}`}
                      aria-pressed={checked}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              {!hasPricingMatch && selectedWeekdays.length > 0 && (
                <p role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
                  선택한 {selectedWeekdays.length}개 요일에 맞는 수강료가 아직 설정되지 않았습니다.
                </p>
              )}
            </fieldset>
          )}
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <div className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <h2 className="text-xl font-black text-gray-900 dark:text-white">신청 정보</h2>
            <fieldset>
              <legend className="text-sm font-black text-gray-700 dark:text-gray-200">회원 구분 *</legend>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">현재 학원에 등록된 학생인지 선택해 주세요. 회원별 수강료 확인에 사용됩니다.</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {([[
                  "EXISTING",
                  "기존 회원",
                ], [
                  "NEW",
                  "신규 회원",
                ]] as const).map(([value, label]) => (
                  <label key={value} className="flex min-h-11 cursor-pointer items-center gap-2 rounded-xl border border-gray-300 px-3 text-sm font-bold text-gray-700 dark:border-gray-600 dark:text-gray-200">
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
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
              요청 사항
              <textarea
                value={form.memo}
                onChange={(event) => update("memo", event.target.value)}
                rows={4}
                className="mt-1 w-full rounded-xl border border-gray-300 bg-white p-3 text-sm text-gray-900 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:focus:ring-brand-neon-lime"
                placeholder="상담 시 참고할 내용을 적어주세요"
              />
            </label>
          </div>

          <aside className="space-y-4 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <h2 className="text-xl font-black text-gray-900 dark:text-white">신청 요약</h2>
            <div className="space-y-2">
              {selectedOfferings.length === 0 ? (
                <p className="rounded-xl bg-gray-50 p-4 text-sm text-gray-500 dark:bg-gray-900 dark:text-gray-400">선택한 수업이 없습니다.</p>
              ) : selectionPlans.map((plan) => {
                const item = plan.offering ?? plan.base;
                return (
                <div key={plan.base.id} className="rounded-xl bg-gray-50 p-3 text-sm dark:bg-gray-900">
                  <p className="font-bold text-gray-900 dark:text-white">{plan.base.name}</p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{selectedWeekdays.map((weekday) => WEEKDAY_OPTIONS.find((option) => option.value === weekday)?.label).filter(Boolean).join("·") || "요일 미선택"} · {item.startTime}~{item.endTime}</p>
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs font-bold">
                    <span>수강료 {formatWon(applicantPrice(item, applicantType))}</span>
                    {hasShuttle(shuttle[plan.base.id]) && hasShuttleLocation(shuttle[plan.base.id]) && (
                      shuttle[plan.base.id]?.useFreeHub
                        ? <span className="text-green-700 dark:text-green-300">셔틀비 무료(거점)</span>
                        : <span className="text-blue-700 dark:text-blue-300">셔틀비 +{formatWon(shuttleFeeForDraft(item, shuttle[plan.base.id]))}</span>
                    )}
                  </div>
                  {item.sessionDates.length > 1 && <p className="mt-1 text-xs font-bold text-gray-600 dark:text-gray-300">총 {item.sessionDates.length}회 · {item.sessionDates.map((session) => `${session.dateLabel}(${session.dayLabel})`).join(", ")}</p>}
                  {isFull(item) && <p className="mt-1 text-xs font-bold text-amber-600 dark:text-amber-300">대기 접수로 신청됩니다.</p>}
                </div>
                );
              })}
            </div>
            <div className="border-t border-gray-100 pt-4 dark:border-gray-700">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between"><dt className="text-gray-500 dark:text-gray-400">수강료</dt><dd className="font-bold">{formatWon(tuitionTotal)}</dd></div>
                <div className="flex justify-between"><dt className="text-gray-500 dark:text-gray-400">셔틀비</dt><dd className="font-bold text-blue-700 dark:text-blue-300">{shuttleTotal ? `+${formatWon(shuttleTotal)}` : formatWon(0)}</dd></div>
              </dl>
              <p className="mt-3 text-sm font-bold text-gray-700 dark:text-gray-200">최종 예상금액</p>
              <p className="mt-1 text-2xl font-black text-brand-navy-900 dark:text-white">{formatWon(totalPrice)}</p>
              {/* 형제 여부는 등록된 보호자 연락처로 서버가 확인한다. 화면에서 미리 단정하면 실제 청구액과 어긋나므로
                  여기서는 안내만 하고, 실제 할인 금액은 접수 완료 화면에서 서버가 확정한 값으로 보여준다. */}
              <p className="mt-2 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                형제·자매가 함께 신청하면 수강료 10%가 자동 할인됩니다. (셔틀비 제외 · 접수 후 금액에 반영)
              </p>
            </div>
            <CheckBox label="방학특강 운영 안내와 환불 규정을 확인했습니다." checked={form.agreedTerms} onChange={(checked) => update("agreedTerms", checked)} />
            <CheckBox label="신청과 상담을 위한 개인정보 수집·이용에 동의합니다." checked={form.agreedPrivacy} onChange={(checked) => update("agreedPrivacy", checked)} />
            {hasMapSelection && (
              <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 dark:border-orange-500/30 dark:bg-orange-500/10">
                <CheckBox label="셔틀 운행과 노선 편성을 위해 선택한 승하차 위치(주소·좌표)를 수집·이용하는 데 동의합니다." checked={locationConsent} onChange={setLocationConsent} />
                <p className="mt-2 pl-6 text-xs leading-5 text-gray-600 dark:text-gray-300">위치 정보는 셔틀 배정과 운행 안내에 사용됩니다. 동의하지 않으면 지도 위치를 제거하고 텍스트로 위치를 적어주세요.</p>
              </div>
            )}
          </aside>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-gray-200 bg-white/95 p-3 backdrop-blur dark:border-gray-700 dark:bg-gray-900/95">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 sm:flex-nowrap">
          <div className="hidden min-w-0 flex-1 sm:block">
            <p className="truncate text-sm font-bold text-gray-900 dark:text-white">{selectedOfferings.length}개 수업 선택 · {formatWon(totalPrice)}</p>
            <p className="text-xs text-gray-500 dark:text-gray-400">제출 후 학원에서 확인 연락을 드립니다.</p>
          </div>
          <Link href={`/seasonal/${slug}`} className="flex min-h-12 items-center justify-center rounded-xl border border-gray-300 px-4 font-bold text-gray-700 dark:border-gray-600 dark:text-gray-200">취소</Link>
          {incompleteItems.length > 0 && submitState !== "submitting" && <p id="seasonal-apply-incomplete" role="status" className="order-first w-full text-xs font-bold text-amber-700 sm:order-none sm:min-w-0 sm:flex-1">미완료: {incompleteItems.join(" · ")}</p>}
          <button
            type="submit"
            disabled={!canSubmit}
            aria-describedby={incompleteItems.length > 0 ? "seasonal-apply-incomplete" : undefined}
            className="flex min-h-12 flex-1 items-center justify-center rounded-xl bg-brand-orange-500 px-5 font-black text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900 sm:flex-none"
          >
            {submitState === "submitting" ? "접수 중..." : "신청 접수"}
          </button>
        </div>
      </div>

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

function DoneView({ slug, result, offerings, message }: { slug: string; result: SubmitResult | null; offerings: SeasonalClass[]; message: string }) {
  const byId = new Map(offerings.map((item) => [item.id, item]));
  return (
    <main className="bg-gray-50 px-4 py-12 dark:bg-gray-900">
      <section className="mx-auto max-w-xl rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-green-100 text-sm font-black text-green-700 dark:bg-green-500/15 dark:text-green-200">완료</div>
        <h1 className="mt-5 text-2xl font-black text-gray-900 dark:text-white">신청이 접수되었습니다</h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-300">{message}</p>
        {result?.items && result.items.length > 0 && (
          <div className="mt-6 space-y-2 text-left">
            {result.items.map((item) => (
              <div key={item.offeringId} className="rounded-xl bg-gray-50 p-3 text-sm dark:bg-gray-900">
                <p className="font-bold text-gray-900 dark:text-white">{byId.get(item.offeringId)?.name ?? "선택 수업"}</p>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {statusText(item.status)}{item.waitlistOrder ? ` · 대기 ${item.waitlistOrder}번` : ""}
                  {typeof item.priceSnapshot === "number" ? ` · ${formatWon(item.priceSnapshot)}` : ""}
                </p>
                {/* 서버가 확정한 형제할인 금액을 그대로 보여준다(화면에서 다시 계산하지 않는다). */}
                {(item.siblingDiscountSnapshot ?? 0) > 0 && (
                  <p className="mt-1 text-xs font-bold text-emerald-700 dark:text-emerald-300">
                    수강료 {formatWon(item.tuitionPriceSnapshot ?? 0)} · 형제할인 −{formatWon(item.siblingDiscountSnapshot ?? 0)}
                    {(item.shuttleFeeSnapshot ?? 0) > 0 ? ` · 셔틀비 +${formatWon(item.shuttleFeeSnapshot ?? 0)}` : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="mt-6 flex justify-center gap-2">
          <Link href={`/seasonal/${slug}`} className="inline-flex min-h-11 items-center rounded-xl border border-gray-300 px-5 font-bold text-gray-700 dark:border-gray-600 dark:text-gray-200">상세 보기</Link>
          <Link href="/" className="inline-flex min-h-11 items-center rounded-xl bg-brand-orange-500 px-5 font-bold text-white dark:bg-brand-neon-lime dark:text-brand-navy-900">홈으로</Link>
        </div>
      </section>
    </main>
  );
}

// 무료 거점 위치 안내 카드 — 주소·좌표와 카카오맵 링크(위치 확인)를 보여준다.
function HubPointCard({ label, point }: { label: string; point: { name: string; lat: number; lng: number } }) {
  const mapHref = `https://map.kakao.com/link/map/${encodeURIComponent(point.name)},${point.lat},${point.lng}`;
  return (
    <div className="rounded-lg border border-green-200 bg-white p-2.5 dark:border-green-800 dark:bg-gray-900">
      <p className="text-[11px] font-black text-green-700 dark:text-green-300">{label}</p>
      <p className="mt-0.5 text-[13px] font-bold text-gray-900 dark:text-white">{point.name}</p>
      <a href={mapHref} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[12px] font-bold text-brand-orange-600 hover:underline dark:text-brand-neon-lime">🗺 지도에서 위치 확인</a>
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
    <div className={`rounded-xl border p-3 ${mapValue ? "border-green-300 bg-green-50/50 dark:border-green-600/50 dark:bg-green-900/10" : "border-amber-300 bg-amber-50/40 dark:border-amber-500/40 dark:bg-amber-900/10"} dark:bg-gray-800`}>
      <p className="text-sm font-bold text-gray-700 dark:text-gray-200">{label} <span className="text-red-500">*</span></p>
      {/* 지도 핀이 실제 위치의 기준 — 버튼을 1순위로 노출한다 */}
      <button type="button" onClick={onOpenMap} className={`mt-2 flex min-h-11 w-full items-center justify-center gap-1 rounded-xl px-3 text-sm font-black ${mapValue ? "border border-green-500 text-green-700 dark:border-green-500 dark:text-green-300" : "bg-brand-orange-500 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900"}`}>
        <span className="material-symbols-outlined text-lg" aria-hidden="true">{mapValue ? "check_circle" : "map"}</span>
        {mapValue ? "지도 위치 지정됨 · 다시 선택" : "지도에서 위치 선택 (필수)"}
      </button>
      {mapValue && <p className="mt-2 text-xs font-bold text-green-700 dark:text-green-300">📍 {mapValue.roadAddress ?? mapValue.address}</p>}
      {/* 텍스트는 위치 설명(선택) — 지도 핀을 찍으면 주소가 자동 입력되며, 수정해 상세 설명을 남길 수 있다. 좌표를 대체하지 않는다 */}
      <label className="mt-2 block text-xs font-medium text-gray-500 dark:text-gray-400">
        위치 설명 (선택 · 지도 선택 시 자동 입력)
        <input type="text" value={value} onChange={(event) => onChange(event.target.value)} placeholder="예: 아파트 정문, 2동 앞" className="mt-1 w-full rounded-xl border border-gray-300 bg-white p-2.5 text-sm text-gray-900 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white" />
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
    <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
      {label}
      <input
        type="text"
        inputMode={inputMode}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        className="mt-1 w-full rounded-xl border border-gray-300 bg-white p-3 text-sm text-gray-900 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:focus:ring-brand-neon-lime"
      />
    </label>
  );
}

function DateInput({ label, value, onChange, required }: { label: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return (
    <label className="block text-sm font-bold text-gray-700 dark:text-gray-200">
      {label}
      <input
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
        className="mt-1 w-full rounded-xl border border-gray-300 bg-white p-3 text-sm text-gray-900 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-900 dark:text-white dark:focus:ring-brand-neon-lime"
      />
    </label>
  );
}

function CheckBox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-sm font-bold text-gray-700 dark:text-gray-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 rounded border-gray-300 text-brand-orange-500 focus:ring-brand-orange-500 dark:border-gray-600"
      />
      <span>{label}</span>
    </label>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt><dd className="mt-0.5 font-bold text-gray-900 dark:text-white">{value}</dd></div>;
}

function StatusBox({ icon, text, retry }: { icon: string; text: string; retry?: boolean }) {
  return (
    <div className="bg-gray-50 px-4 py-12 dark:bg-gray-900">
      <div className="mx-auto max-w-3xl rounded-2xl border border-gray-200 bg-white p-10 text-center dark:border-gray-700 dark:bg-gray-800">
        <span className="material-symbols-outlined text-4xl text-gray-400" aria-hidden="true">{icon}</span>
        <p className="mt-3 text-gray-600 dark:text-gray-300">{text}</p>
        {retry && <button type="button" onClick={() => location.reload()} className="mt-4 min-h-11 rounded-xl border border-gray-300 px-5 font-bold">다시 시도</button>}
      </div>
    </div>
  );
}
