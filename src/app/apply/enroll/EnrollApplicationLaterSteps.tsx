"use client";

import { useState, type ReactNode } from "react";
import FontFreeIcon, { type FontFreeIconName } from "@/components/ui/FontFreeIcon";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import { nextPlaceNameAfterRepick } from "@/lib/enrollment/shuttle-place-name";

interface AvailableSlot {
    slotKey: string;
    className: string;
    dayOfWeek: string;
    dayLabel: string;
    startTime: string;
    endTime: string;
    capacity: number;
    enrolled: number;
    available: number;
}

interface FormData {
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
    requestedStartOn: string;
    preferredSlotKeys: string[];
    basketballExp: string;
    shuttleChoice: string;
    shuttleNeeded: boolean;
    shuttlePickup: string;
    shuttlePickupLocationData?: MapLocationData;
    shuttleDropoff: string;
    shuttleDropoffLocationData?: MapLocationData;
    shuttleLocationConsent: boolean;
    shuttleTime: string;
    referralSource: string;
    memo: string;
    agreedTerms: boolean;
    agreedPrivacy: boolean;
    applicationNoticeConfirmed: boolean;
    shuttleNoticeConfirmed: boolean;
    honeypot: string;
}

interface Props {
    step: number;
    form: FormData;
    availableSlots: AvailableSlot[];
    update: (field: keyof FormData, value: string | boolean | string[] | MapLocationData | undefined) => void;
    toggleSlot: (slotKey: string) => void;
}

const SOURCE_OPTIONS = [
    { value: "NAVER_SEARCH", label: "네이버 키워드 검색" },
    { value: "PORTAL_OTHER", label: "네이버 외 포털검색" },
    { value: "NAVER_BLOG", label: "스티즈 네이버블로그" },
    { value: "YOUTUBE", label: "유튜브" },
    { value: "INSTAGRAM", label: "인스타그램" },
    { value: "REFERRAL", label: "지인소개" },
    { value: "PASSBY", label: "지나가다 발견" },
    { value: "SMS_PROMOTION", label: "문자 홍보" },
    { value: "SOOMGO", label: "숨고" },
    { value: "DANGGEUN", label: "당근마켓" },
];

const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DAY_LABELS: Record<string, string> = {
    Mon: "월",
    Tue: "화",
    Wed: "수",
    Thu: "목",
    Fri: "금",
    Sat: "토",
    Sun: "일",
};

export default function EnrollApplicationLaterSteps({ step, form, availableSlots, update, toggleSlot }: Props) {
    const [locationPicker, setLocationPicker] = useState<"pickup" | "dropoff" | null>(null);
    const slotsByDay = DAY_ORDER.reduce<Record<string, AvailableSlot[]>>((acc, day) => {
        const daySlots = availableSlots.filter((slot) => slot.dayOfWeek === day);
        if (daySlots.length > 0) acc[day] = daySlots;
        return acc;
    }, {});

    const selectedSlotsLabel = form.preferredSlotKeys
        .map((key) => {
            const slot = availableSlots.find((item) => item.slotKey === key);
            if (!slot) return key;
            return `${slot.dayLabel} ${slot.startTime}~${slot.endTime} (${slot.className})`;
        })
        .join(", ");

    return (
        <>
            {step === 2 && (
                <div className="space-y-5">
                    <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--color-public-ink)] dark:text-white">
                        <FontFreeIcon name="person" size={20} className="text-[var(--color-public-accent)] dark:text-brand-neon-lime" />
                        보호자 정보
                    </h2>
                    <TextInput label="보호자 이름" required value={form.parentName} onChange={(value) => update("parentName", value)} placeholder="보호자 성함" />
                    <TextInput label="보호자 연락처" required type="tel" value={form.parentPhone} onChange={(value) => update("parentPhone", formatPhone(value))} placeholder="숫자만 입력해주세요" helper="입력하면 010-0000-0000 형식으로 자동 정리됩니다." />
                    <TextInput label="주소" value={form.address} onChange={(value) => update("address", value)} placeholder="다산동 000아파트 000동" labelSuffix="(선택)" />
                </div>
            )}

            {step === 3 && (
                <div className="space-y-5">
                    <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--color-public-ink)] dark:text-white">
                        <FontFreeIcon name="sports_basketball" size={20} className="text-[var(--color-public-accent)] dark:text-brand-neon-lime" />
                        수강 정보
                    </h2>

                    <div>
                        <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                            수강 개시일 <span className="text-red-500">*</span>
                        </label>
                        <input aria-label="수강 개시일" type="date" required value={form.requestedStartOn} onChange={(event) => update("requestedStartOn", event.target.value)} className="box-border min-h-11 w-full min-w-0 max-w-full rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)]" />
                        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">처음 수업에 참여할 날짜를 선택해 주세요. 배정할 수업과 함께 학원에서 확인합니다.</p>
                    </div>

                    <div>
                        <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                            희망 수업 <span className="text-xs font-normal text-[var(--color-public-muted)]">(복수 선택 가능)</span>
                        </label>
                        {Object.keys(slotsByDay).length > 0 ? (
                            <div className="space-y-3">
                                {DAY_ORDER.filter((day) => slotsByDay[day]).map((day) => (
                                    <div key={day}>
                                        <p className="mb-1.5 text-xs font-bold uppercase text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{DAY_LABELS[day]}요일</p>
                                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                                            {slotsByDay[day]!.map((slot) => {
                                                const isFull = slot.available <= 0;
                                                const isSelected = form.preferredSlotKeys.includes(slot.slotKey);
                                                return (
                                                    <button
                                                        key={slot.slotKey}
                                                        type="button"
                                                        disabled={isFull}
                                                        onClick={() => toggleSlot(slot.slotKey)}
                                                        className={`rounded-xl border px-3 py-2.5 text-xs font-medium transition-colors ${isFull ? "cursor-not-allowed border-[var(--color-public-line)] bg-[var(--color-public-tint)] text-[var(--color-public-dark-muted)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)]" : isSelected ? "border-[var(--color-public-accent)] bg-[var(--color-public-tint)] text-[var(--color-public-strong)] ring-2 ring-[var(--color-public-accent)] dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "cursor-pointer border-gray-300 text-[var(--color-public-muted)] hover:border-[var(--color-public-dark)] dark:text-[var(--color-public-ink)]"}`}
                                                    >
                                                        <span className="block text-sm font-semibold">{slot.startTime}~{slot.endTime}</span>
                                                        <span className="mt-0.5 block truncate">{slot.className}</span>
                                                        <span className={`mt-1 block ${isFull ? "text-[var(--color-public-dark-muted)]" : slot.available <= 3 ? "text-red-500" : "text-green-600"}`}>
                                                            {isFull ? "마감" : `잔여 ${slot.available}명`}
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="py-4 text-center text-sm text-[var(--color-public-muted)]">현재 조회 가능한 시간표가 없습니다. 신청 후 담당자가 안내드립니다.</p>
                        )}
                    </div>

                    <TextArea label="농구 경험" value={form.basketballExp} onChange={(value) => update("basketballExp", value)} placeholder="농구를 해본 경험이 얼마나 있는지 간단하게 적어주세요." labelSuffix="(선택)" />

                    <div>
                        <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                            셔틀 탑승 여부 <span className="text-red-500">*</span>
                        </label>
                        <p className="mb-2 text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">주 1회 10,000원 / 2회 15,000원 / 3회 20,000원</p>
                        <div className="grid grid-cols-2 gap-2">
                            {["탑승", "미탑승"].map((choice) => (
                                <button
                                    key={choice}
                                    type="button"
                                    onClick={() => {
                                        update("shuttleChoice", choice);
                                        update("shuttleNeeded", choice === "탑승");
                                        if (choice === "미탑승") {
                                            update("shuttlePickup", "");
                                            update("shuttlePickupLocationData", undefined);
                                            update("shuttleTime", "");
                                            update("shuttleDropoff", "");
                                            update("shuttleDropoffLocationData", undefined);
                                            update("shuttleLocationConsent", false);
                                            update("shuttleNoticeConfirmed", false);
                                        }
                                    }}
                                    className={`rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${form.shuttleChoice === choice ? "border-[var(--color-public-accent)] bg-[var(--color-public-tint)] text-[var(--color-public-strong)] dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "border-gray-300 text-[var(--color-public-muted)] hover:border-gray-400 dark:text-[var(--color-public-muted)]"}`}
                                >
                                    {choice}
                                </button>
                            ))}
                        </div>
                    </div>

                    {form.shuttleChoice === "탑승" && (
                        <div className="ml-2 space-y-4 border-l-2 border-[var(--color-public-line)] pl-2">
                            {/* 이름 칸만 고쳐도 좌표는 그대로 둔다 — 위치는 지도에서만 바뀐다 */}
                            <ShuttleLocationField
                                label="셔틀 탑승 장소"
                                nameLabel="타는 곳 이름"
                                value={form.shuttlePickup}
                                location={form.shuttlePickupLocationData}
                                onChange={(value) => update("shuttlePickup", value)}
                                onOpenMap={() => setLocationPicker("pickup")}
                            />
                            <ShuttleLocationField
                                label="셔틀 하차 장소"
                                nameLabel="내리는 곳 이름"
                                value={form.shuttleDropoff}
                                location={form.shuttleDropoffLocationData}
                                onChange={(value) => update("shuttleDropoff", value)}
                                onOpenMap={() => setLocationPicker("dropoff")}
                            />
                            <TextInput label="셔틀 희망 시간" required value={form.shuttleTime} onChange={(value) => update("shuttleTime", value)} placeholder="예: 수업 시작 20분 전, 16:30 전후" helper="참고용입니다. 실제 탑승시간은 배차 확정 후 안내됩니다." />
                            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[var(--color-public-line)] bg-[var(--color-public-tint)] p-3 text-sm text-[var(--color-public-muted)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-ink)]">
                                <input type="checkbox" checked={form.shuttleLocationConsent} onChange={(event) => update("shuttleLocationConsent", event.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-[var(--color-public-accent)] focus:ring-[var(--color-public-accent)] dark:text-brand-neon-lime" />
                                <span>셔틀 배차와 노선 계산을 위해 탑승·하차 위치 좌표를 저장하는 데 동의합니다.</span>
                            </label>
                            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[var(--color-public-line)] bg-[var(--color-public-tint)] p-3 text-sm text-[var(--color-public-muted)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-ink)]">
                                <input type="checkbox" checked={form.shuttleNoticeConfirmed} onChange={(event) => update("shuttleNoticeConfirmed", event.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-[var(--color-public-accent)] focus:ring-[var(--color-public-accent)] dark:text-brand-neon-lime" />
                                <span>셔틀 운행 시간은 노선 확정 후 조정될 수 있음을 확인했습니다.</span>
                            </label>
                        </div>
                    )}

                    <div>
                        <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                            가입경로 <span className="text-red-500">*</span>
                        </label>
                        <select value={form.referralSource} onChange={(event) => update("referralSource", event.target.value)} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-[var(--color-public-ink)] outline-none transition-colors focus:border-[var(--color-public-accent)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)] dark:text-white">
                            <option value="">선택해주세요</option>
                            {SOURCE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                    </div>

                    <TextArea label="요청사항" value={form.memo} onChange={(value) => update("memo", value)} placeholder="상담 시 참고할 내용이 있으면 적어주세요." labelSuffix="(선택)" />
                </div>
            )}

            {step === 4 && (
                <div className="space-y-5">
                    <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--color-public-ink)] dark:text-white">
                        <FontFreeIcon name="check_circle" size={20} className="text-[var(--color-public-accent)] dark:text-brand-neon-lime" />
                        확인 및 동의
                    </h2>
                    <div className="space-y-4 rounded-xl bg-[var(--color-public-tint)] p-4 text-sm dark:bg-[var(--color-public-paper)]">
                        <SummarySection title="아이 정보" icon="child_care">
                            <SummaryRow label="이름" value={form.childName} strong />
                            <SummaryRow label="생년월일" value={form.childBirthDate} />
                            <SummaryRow label="성별/학년" value={`${form.childGender} · ${form.childGrade}`} />
                            <SummaryRow label="학교" value={form.childSchool} />
                            <SummaryRow label="학생 연락처" value={form.childPhone} />
                        </SummarySection>
                        <SummarySection title="보호자 정보" icon="person">
                            <SummaryRow label="이름" value={form.parentName} strong />
                            <SummaryRow label="연락처" value={form.parentPhone} />
                            {form.address && <SummaryRow label="주소" value={form.address} />}
                        </SummarySection>
                        <SummarySection title="수강 정보" icon="sports_basketball">
                            <SummaryRow label="수강 개시일" value={form.requestedStartOn || "선택 필요"} strong />
                            <SummaryRow label="희망 수업" value={selectedSlotsLabel || "담당자 상담 후 결정"} />
                            <SummaryRow label="셔틀" value={form.shuttleChoice} />
                            {form.shuttleChoice === "탑승" && <SummaryRow label="탑승/하차" value={`${form.shuttlePickup} / ${form.shuttleDropoff}`} />}
                            {form.referralSource && <SummaryRow label="가입경로" value={SOURCE_OPTIONS.find((option) => option.value === form.referralSource)?.label || form.referralSource} />}
                        </SummarySection>
                    </div>

                    <TermsAccordion title="수강 이용약관 동의" required checked={form.agreedTerms} onCheck={(value) => update("agreedTerms", value)}>
                        <EnrollTermsContent />
                    </TermsAccordion>
                    <TermsAccordion title="개인정보 수집/이용 동의" required checked={form.agreedPrivacy} onCheck={(value) => update("agreedPrivacy", value)}>
                        <EnrollPrivacyContent />
                    </TermsAccordion>
                    <TermsAccordion title="수강신청 확정 안내 확인" required checked={form.applicationNoticeConfirmed} onCheck={(value) => update("applicationNoticeConfirmed", value)}>
                        <ApplicationNoticeContent />
                    </TermsAccordion>
                    <input type="text" value={form.honeypot} onChange={(event) => update("honeypot", event.target.value)} className="hidden" tabIndex={-1} autoComplete="off" />
                </div>
            )}

            {locationPicker && (
                <LocationPickerModal
                    title={locationPicker === "pickup" ? "셔틀 탑승 위치 선택" : "셔틀 하차 위치 선택"}
                    initialValue={locationPicker === "pickup" ? form.shuttlePickupLocationData : form.shuttleDropoffLocationData}
                    onClose={() => setLocationPicker(null)}
                    onConfirm={(location: MapLocationData) => {
                        // 이름 칸에는 지도가 준 가게·건물 이름만 미리 넣는다. 주소뿐이면 빈칸 → 학부모가 직접 적는다.
                        // (예전엔 주소를 자동으로 넣어 「다산동 4002-1」만 남고 기사님이 어디서 태울지 몰랐다)
                        // 「다시 고르기」 때 학부모가 직접 적은 이름은 지우지 않는다(자동값·빈칸일 때만 새 장소명으로).
                        if (locationPicker === "pickup") {
                            update("shuttlePickup", nextPlaceNameAfterRepick(form.shuttlePickup, form.shuttlePickupLocationData, location));
                            update("shuttlePickupLocationData", location);
                        } else {
                            update("shuttleDropoff", nextPlaceNameAfterRepick(form.shuttleDropoff, form.shuttleDropoffLocationData, location));
                            update("shuttleDropoffLocationData", location);
                        }
                        update("shuttleLocationConsent", false);
                        setLocationPicker(null);
                    }}
                />
            )}
        </>
    );
}

/**
 * 셔틀 장소 칸: ① 지도에서 위치 고르기 → ② 고른 주소 확인 + 「타는 곳 이름」 직접 적기.
 * 주소만으로는 기사님이 아파트 어느 문 앞인지 모르므로, 이름 칸은 위치를 고른 뒤 항상 보인다.
 */
function ShuttleLocationField({ label, nameLabel, value, location, onChange, onOpenMap }: { label: string; nameLabel: string; value: string; location?: MapLocationData; onChange: (value: string) => void; onOpenMap: () => void }) {
    // 화면에 보일 주소: 도로명 우선, 없으면 지번
    const shownAddress = location ? (location.roadAddress || location.address) : "";
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                {label} <span className="text-red-500">*</span>
            </label>
            {!location ? (
                // 아직 위치를 안 골랐으면 지도 버튼 하나만 크게 보인다
                <button type="button" onClick={onOpenMap} className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--color-academy-primary)] px-3 py-2 text-sm font-bold text-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-soft)]">
                    <FontFreeIcon name="location_on" size={18} />
                    지도에서 위치 고르기
                </button>
            ) : (
                <div className="space-y-2">
                    {/* 고른 주소(읽기 전용) + 다시 고르기 */}
                    <div className="flex items-center gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-3 py-2">
                        <FontFreeIcon name="location_on" size={16} className="shrink-0 text-[var(--color-academy-success)]" />
                        <span className="min-w-0 flex-1 break-keep text-sm text-[var(--color-academy-ink)]">{shownAddress}</span>
                        <button type="button" onClick={onOpenMap} className="min-h-11 shrink-0 rounded-lg px-2 text-sm font-bold text-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-soft)]">
                            다시 고르기
                        </button>
                    </div>
                    {/* 타는 곳(내리는 곳) 이름 — 지도 장소명이 있으면 미리 채워지고, 주소뿐이면 빈칸 */}
                    <label className="block">
                        <span className="mb-1 block text-sm font-medium text-[var(--color-academy-ink)]">
                            {nameLabel} <span className="text-[var(--color-academy-danger)]">*</span>
                        </span>
                        <input
                            aria-label={nameLabel}
                            value={value}
                            onChange={(event) => onChange(event.target.value)}
                            placeholder="예: OO아파트 후문 맘스테이션 앞"
                            className="min-h-11 w-full rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-3 text-[var(--color-academy-ink)] outline-none focus:border-[var(--color-academy-primary)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                        />
                        <span className="mt-1 block text-xs text-[var(--color-academy-muted)]">
                            기사님이 이 이름을 보고 찾아갑니다. 주소 말고 건물·출입구 이름을 적어 주세요.
                        </span>
                    </label>
                </div>
            )}
        </div>
    );
}

function TextInput({ label, labelSuffix, required, type = "text", value, onChange, placeholder, helper }: { label: string; labelSuffix?: string; required?: boolean; type?: string; value: string; onChange: (value: string) => void; placeholder: string; helper?: string }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                {label} {required && <span className="text-red-500">*</span>} {labelSuffix && <span className="text-xs font-normal text-[var(--color-public-muted)]">{labelSuffix}</span>}
            </label>
            <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-[var(--color-public-ink)] outline-none transition-colors focus:border-[var(--color-public-accent)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)] dark:text-white" />
            {helper && <p className="mt-1 text-xs text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{helper}</p>}
        </div>
    );
}

function TextArea({ label, labelSuffix, value, onChange, placeholder }: { label: string; labelSuffix?: string; value: string; onChange: (value: string) => void; placeholder: string }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                {label} {labelSuffix && <span className="text-xs font-normal text-[var(--color-public-muted)]">{labelSuffix}</span>}
            </label>
            <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={3} className="w-full resize-none rounded-xl border border-gray-300 px-4 py-3 text-[var(--color-public-ink)] outline-none transition-colors focus:border-[var(--color-public-accent)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)] dark:text-white" />
        </div>
    );
}

function SummarySection({ title, icon, children }: { title: string; icon: FontFreeIconName; children: ReactNode }) {
    return (
        <div>
            <h3 className="mb-1.5 flex items-center gap-1 font-semibold text-[var(--color-public-ink)] dark:text-white">
                <FontFreeIcon name={icon} size={14} className="text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]" />
                {title}
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 pl-5">{children}</div>
        </div>
    );
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
    return (
        <>
            <span className="text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{label}</span>
            <span className={`text-[var(--color-public-ink)] dark:text-white ${strong ? "font-medium" : ""}`}>{value || "-"}</span>
        </>
    );
}

function TermsAccordion({ title, required, checked, onCheck, children }: { title: string; required?: boolean; checked: boolean; onCheck: (value: boolean) => void; children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <div className="overflow-hidden rounded-xl border border-[var(--color-public-line)] dark:border-[var(--color-public-line)]">
            <div className="flex items-center bg-[var(--color-public-tint)] px-4 py-3 dark:bg-[var(--color-public-paper)]">
                <label className="flex flex-1 cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} className="h-5 w-5 rounded border-gray-300 text-[var(--color-public-accent)] focus:ring-[var(--color-public-accent)] dark:text-brand-neon-lime dark:focus:ring-brand-neon-lime/50" />
                    <span className="text-sm font-medium text-[var(--color-public-ink)] dark:text-white">{title} {required && <span className="text-red-500">*</span>}</span>
                </label>
                <button type="button" onClick={() => setIsOpen(!isOpen)} className="p-1 text-[var(--color-public-muted)] hover:text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
                    <FontFreeIcon name="expand_more" size={18} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
            </div>
            {isOpen && <div className="max-h-48 overflow-y-auto border-t border-[var(--color-public-line)] px-4 py-3 text-xs leading-relaxed text-[var(--color-public-muted)] dark:border-[var(--color-public-line)] dark:text-[var(--color-public-muted)]">{children}</div>}
        </div>
    );
}

function EnrollTermsContent() {
    return (
        <div className="space-y-2">
            <p className="font-semibold text-[var(--color-public-ink)] dark:text-[var(--color-public-ink)]">STIZ 농구교실 수강 이용약관</p>
            <p>1. 수강료는 수강 시작 전 안내에 따라 납부합니다.</p>
            <p>2. 개인 사정으로 인한 결석은 이월 또는 환불 대상이 아닙니다.</p>
            <p>3. 질병이나 부상 등 증빙이 가능한 경우에는 확인 후 이월 또는 환불을 안내합니다.</p>
            <p>4. 보강 수업은 결석일로부터 2개월 이내에 참여해야 하며, 기간이 지나면 자동 소멸됩니다.</p>
            <p>5. 모든 수강생은 수업 중 코치의 안전 지시를 따라야 합니다.</p>
        </div>
    );
}

function EnrollPrivacyContent() {
    return (
        <div className="space-y-2">
            <p className="font-semibold text-[var(--color-public-ink)] dark:text-[var(--color-public-ink)]">개인정보 수집/이용 동의</p>
            <p><strong>수집 항목:</strong> 수강생 이름, 생년월일, 성별, 학교명, 연락처, 보호자 이름, 보호자 연락처, 주소</p>
            <p><strong>수집 목적:</strong> 수강 신청 접수, 반 배정, 수강료 안내, 셔틀 운행, 수업 운영</p>
            <p><strong>보유 기간:</strong> 수강 종료 후 1년, 미등록 시 6개월</p>
            <p>동의를 거부할 수 있으나, 동의하지 않을 경우 수강 신청이 제한될 수 있습니다.</p>
        </div>
    );
}

function ApplicationNoticeContent() {
    return (
        <div className="space-y-2">
            <p>본 신청서는 희망 요일과 시간에 대한 접수이며, 수강 확정을 의미하지 않습니다.</p>
            <p>수강 확정은 반 배정 안내를 받고 결제를 완료하면 최종 확정됩니다.</p>
            <p>희망 시간이 마감된 경우 가능한 시간대로 다시 안내드릴 수 있습니다.</p>
        </div>
    );
}

function formatPhone(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}
