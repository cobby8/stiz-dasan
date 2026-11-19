"use client";

/**
 * 체험 «셔틀 요청» 입력 부품 — 학부모 체험 신청서와 관리자 체험 상세가 같이 쓴다(2026-11-19 원장 결정).
 *
 * 흐름: «셔틀이 필요하신가요?» 필요 없음(기본)/필요 → 등원·하원 고르기 → 지도에서 위치 지정 + 위치명(필수)
 *       → (둘 다일 때) «하원 위치가 다릅니다» 체크 뒤 하원 위치 따로.
 * 검사 규칙·문구는 @/lib/trial/trialShuttleRequest 한 곳(서버도 같은 규칙).
 * 색은 토큰만: 고른 칩 = 보조 색(하늘색), 누르는 버튼 = 주 색(네이비). 아이콘 없이 글자, 터치 44px.
 * 공개 화면(.academy-app 밖)에서도 써야 해서 테마 클래스(academy-choice) 대신 토큰을 직접 쓴다.
 */
import { useState } from "react";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import { SHUTTLE_PLACE_NAME_MAX } from "@/lib/shuttle/placeNameRule";
import {
    TRIAL_SHUTTLE_DIRECTIONS,
    TRIAL_SHUTTLE_DIRECTION_LABEL,
    TRIAL_SHUTTLE_CHANGE_NOTICE,
    TRIAL_SHUTTLE_NOTICES,
    TRIAL_SHUTTLE_QUESTION,
    trialShuttlePlaceLabels,
    type TrialShuttleErrors,
    type TrialShuttleFormValue,
    type TrialShuttlePlace,
} from "@/lib/trial/trialShuttleRequest";

const CHIP_BASE = "min-h-11 rounded-xl border px-3 py-2 text-sm transition-colors";
// 고른 칩 = 보조 색(연한 하늘 바탕 + 굵은 테두리). aria-pressed 로도 알린다(색만으로 뜻을 전하지 않는다)
const CHIP_ON = "border-2 border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)] font-semibold text-[var(--color-academy-secondary-ink)]";
const CHIP_OFF = "border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] font-medium text-[var(--color-academy-ink)]";
const LABEL_CLASS = "mb-1.5 block text-sm font-medium text-[var(--color-academy-ink)]";
const ERROR_CLASS = "mt-1 text-sm font-medium text-[var(--color-academy-danger)]";

type PickerTarget = "pickup" | "dropoff";

export default function TrialShuttleRequestFields({
    value,
    onChange,
    errors = {},
    hideQuestion = false,
    disabled = false,
}: {
    value: TrialShuttleFormValue;
    onChange: (next: TrialShuttleFormValue) => void;
    /** 칸별 안내 — 각 칸 바로 아래에 보인다 */
    errors?: TrialShuttleErrors;
    /** 관리자 «셔틀 요청 넣기/고치기»처럼 이미 «필요»로 정해진 자리에서는 질문 줄을 숨긴다 */
    hideQuestion?: boolean;
    disabled?: boolean;
}) {
    const [picker, setPicker] = useState<PickerTarget | null>(null);
    const labels = trialShuttlePlaceLabels(value.direction, value.dropoffDifferent);
    const showDropoffToggle = value.direction === "BOTH";

    const patch = (part: Partial<TrialShuttleFormValue>) => onChange({ ...value, ...part });

    // 지도 창에 넘길 처음 값(다시 고르기 때 예전 위치·이름을 그대로 보여 준다)
    const pickerInitial = (place: TrialShuttlePlace | null): MapLocationData | undefined =>
        place ? { address: place.address, placeName: place.name || undefined, latitude: place.latitude, longitude: place.longitude, source: "MAP_PIN" } : undefined;

    const confirmLocation = (location: MapLocationData) => {
        const target = picker;
        if (!target) return;
        const previous = target === "pickup" ? value.pickup : value.dropoff;
        const place: TrialShuttlePlace = {
            // 지도 창에서 적은 이름(필수)을 쓰고, 혹시 비어 오면 전에 적어 둔 이름을 지우지 않는다
            name: location.placeName?.trim() || previous?.name || "",
            // 화면에 보일 주소: 도로명 우선, 없으면 지번
            address: location.roadAddress || location.address || "",
            latitude: location.latitude,
            longitude: location.longitude,
        };
        patch(target === "pickup" ? { pickup: place } : { dropoff: place });
        setPicker(null);
    };

    return (
        <div className="space-y-3">
            {!hideQuestion && (
                <div>
                    <p className={LABEL_CLASS}>{TRIAL_SHUTTLE_QUESTION}</p>
                    <div className="grid grid-cols-2 gap-2">
                        {([false, true] as const).map((needed) => (
                            <button
                                key={needed ? "need" : "none"}
                                type="button"
                                disabled={disabled}
                                aria-pressed={value.needed === needed}
                                onClick={() => patch({ needed })}
                                className={`${CHIP_BASE} ${value.needed === needed ? CHIP_ON : CHIP_OFF}`}
                            >
                                {needed ? "필요" : "필요 없음"}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {value.needed && (
                <div className="space-y-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-3">
                    <div>
                        <p className={LABEL_CLASS}>등원·하원</p>
                        <div className="grid grid-cols-3 gap-2">
                            {TRIAL_SHUTTLE_DIRECTIONS.map((direction) => (
                                <button
                                    key={direction}
                                    type="button"
                                    disabled={disabled}
                                    aria-pressed={value.direction === direction}
                                    // 둘 다가 아니면 «하원 위치가 다릅니다»는 뜻이 없다 → 끈다(적어 둔 하원 위치는 지우지 않는다)
                                    onClick={() => patch({ direction, dropoffDifferent: direction === "BOTH" ? value.dropoffDifferent : false })}
                                    className={`${CHIP_BASE} ${value.direction === direction ? CHIP_ON : CHIP_OFF}`}
                                >
                                    {TRIAL_SHUTTLE_DIRECTION_LABEL[direction]}
                                </button>
                            ))}
                        </div>
                        {errors.direction && <p role="alert" className={ERROR_CLASS}>{errors.direction}</p>}
                    </div>

                    <PlaceField
                        label={labels.main}
                        place={value.pickup}
                        disabled={disabled}
                        locationError={errors.pickupLocation}
                        nameError={errors.pickupName}
                        onOpenMap={() => setPicker("pickup")}
                        onNameChange={(name) => value.pickup && patch({ pickup: { ...value.pickup, name } })}
                    />

                    {showDropoffToggle && (
                        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-academy-ink)]">
                            <input
                                type="checkbox"
                                disabled={disabled}
                                checked={value.dropoffDifferent}
                                onChange={(event) => patch({ dropoffDifferent: event.target.checked })}
                                className="h-5 w-5 rounded border-[var(--color-academy-line-input)] accent-[var(--color-academy-primary)]"
                            />
                            <span>하원 위치가 다릅니다</span>
                        </label>
                    )}

                    {showDropoffToggle && value.dropoffDifferent && (
                        <PlaceField
                            label={labels.dropoff}
                            place={value.dropoff}
                            disabled={disabled}
                            locationError={errors.dropoffLocation}
                            nameError={errors.dropoffName}
                            onOpenMap={() => setPicker("dropoff")}
                            onNameChange={(name) => value.dropoff && patch({ dropoff: { ...value.dropoff, name } })}
                        />
                    )}

                    <ul className="space-y-1 text-xs leading-5 text-[var(--color-academy-muted)]">
                        {TRIAL_SHUTTLE_NOTICES.map((notice) => <li key={notice}>{notice}</li>)}
                        {/* 신청서에서만: 이미 낸 신청의 셔틀은 신청서로 바꾸지 못한다(관리자 화면에는 필요 없는 말) */}
                        {!hideQuestion && <li>{TRIAL_SHUTTLE_CHANGE_NOTICE}</li>}
                    </ul>
                </div>
            )}

            {picker && (
                <LocationPickerModal
                    title={picker === "pickup" ? `셔틀 ${labels.main} 선택` : `셔틀 ${labels.dropoff} 선택`}
                    initialValue={pickerInitial(picker === "pickup" ? value.pickup : value.dropoff)}
                    // 정규 배정과 같이 지도 창에서 장소명을 꼭 받는다(기사님 명단에 이 이름이 나온다)
                    requirePlaceName
                    onClose={() => setPicker(null)}
                    onConfirm={confirmLocation}
                />
            )}
        </div>
    );
}

/** 한 곳 칸: ① 지도에서 위치 고르기 → ② 고른 주소 확인 + 위치명 적기(필수) */
function PlaceField({
    label,
    place,
    disabled,
    locationError,
    nameError,
    onOpenMap,
    onNameChange,
}: {
    label: string;
    place: TrialShuttlePlace | null;
    disabled: boolean;
    locationError?: string;
    nameError?: string;
    onOpenMap: () => void;
    onNameChange: (name: string) => void;
}) {
    return (
        <div>
            <p className={LABEL_CLASS}>
                {label} <span className="text-[var(--color-academy-danger)]">*</span>
            </p>
            {!place ? (
                <button
                    type="button"
                    disabled={disabled}
                    onClick={onOpenMap}
                    className="flex min-h-11 w-full items-center justify-center rounded-xl border border-[var(--color-academy-primary)] bg-[var(--color-academy-surface)] px-3 py-2 text-sm font-semibold text-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-soft)]"
                >
                    지도에서 위치 고르기
                </button>
            ) : (
                <div className="space-y-2">
                    {/* 고른 주소(읽기 전용) + 다시 고르기 */}
                    <div className="flex items-center gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-1">
                        <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-ink)]">{place.address || "주소 없음(지도에서 고른 위치)"}</span>
                        <button
                            type="button"
                            disabled={disabled}
                            onClick={onOpenMap}
                            className="min-h-11 shrink-0 rounded-lg px-2 text-sm font-semibold text-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-soft)]"
                        >
                            다시 고르기
                        </button>
                    </div>
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium text-[var(--color-academy-ink)]">
                            {label} 이름 <span className="text-[var(--color-academy-danger)]">*</span>
                        </span>
                        <input
                            aria-label={`${label} 이름`}
                            aria-invalid={nameError ? true : undefined}
                            disabled={disabled}
                            value={place.name}
                            maxLength={SHUTTLE_PLACE_NAME_MAX}
                            onChange={(event) => onNameChange(event.target.value)}
                            placeholder="예: OO아파트 후문 맘스테이션 앞"
                            className="min-h-11 w-full rounded-xl border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-3 py-2 text-base text-[var(--color-academy-ink)] outline-none focus:border-[var(--color-academy-primary)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                        />
                    </label>
                    {nameError && <p role="alert" className={ERROR_CLASS}>{nameError}</p>}
                </div>
            )}
            {locationError && <p role="alert" className={ERROR_CLASS}>{locationError}</p>}
        </div>
    );
}
