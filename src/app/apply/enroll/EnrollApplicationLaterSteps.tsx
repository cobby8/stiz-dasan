"use client";

import { useState, type ReactNode } from "react";
import FontFreeIcon, { type FontFreeIconName } from "@/components/ui/FontFreeIcon";
import LocationPickerModal, { type MapLocationData } from "@/components/maps/LocationPickerModal";
import { kstMonthLabels } from "@/lib/datetime/kst";

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
    enrollmentMonths: string[];
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
    const enrollmentMonthOptions = kstMonthLabels();
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
                    <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
                        <FontFreeIcon name="person" size={20} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                        보호자 정보
                    </h2>
                    <TextInput label="보호자 이름" required value={form.parentName} onChange={(value) => update("parentName", value)} placeholder="보호자 성함" />
                    <TextInput label="보호자 연락처" required type="tel" value={form.parentPhone} onChange={(value) => update("parentPhone", formatPhone(value))} placeholder="숫자만 입력해주세요" helper="입력하면 010-0000-0000 형식으로 자동 정리됩니다." />
                    <TextInput label="주소" value={form.address} onChange={(value) => update("address", value)} placeholder="다산동 000아파트 000동" labelSuffix="(선택)" />
                </div>
            )}

            {step === 3 && (
                <div className="space-y-5">
                    <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
                        <FontFreeIcon name="sports_basketball" size={20} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                        수강 정보
                    </h2>

                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                            수강신청 월 <span className="text-red-500">*</span>
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                            {enrollmentMonthOptions.map((month) => {
                                const selected = form.enrollmentMonths.includes(month);
                                return (
                                    <button
                                        key={month}
                                        type="button"
                                        onClick={() => update("enrollmentMonths", selected ? form.enrollmentMonths.filter((item) => item !== month) : [...form.enrollmentMonths, month])}
                                        className={`rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${selected ? "border-brand-orange-500 bg-brand-orange-50 text-brand-orange-600 dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "border-gray-300 text-gray-600 hover:border-gray-400 dark:text-gray-300"}`}
                                    >
                                        {month}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                            희망 수업 <span className="text-xs font-normal text-gray-400">(복수 선택 가능)</span>
                        </label>
                        {Object.keys(slotsByDay).length > 0 ? (
                            <div className="space-y-3">
                                {DAY_ORDER.filter((day) => slotsByDay[day]).map((day) => (
                                    <div key={day}>
                                        <p className="mb-1.5 text-xs font-bold uppercase text-gray-500 dark:text-gray-400">{DAY_LABELS[day]}요일</p>
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
                                                        className={`rounded-xl border px-3 py-2.5 text-xs font-medium transition-colors ${isFull ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-300 dark:border-gray-700 dark:bg-gray-900" : isSelected ? "border-brand-orange-500 bg-brand-orange-50 text-brand-orange-600 ring-2 ring-brand-orange-500 dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "cursor-pointer border-gray-300 text-gray-700 hover:border-brand-navy-400 dark:text-gray-200"}`}
                                                    >
                                                        <span className="block text-sm font-semibold">{slot.startTime}~{slot.endTime}</span>
                                                        <span className="mt-0.5 block truncate">{slot.className}</span>
                                                        <span className={`mt-1 block ${isFull ? "text-gray-300" : slot.available <= 3 ? "text-red-500" : "text-green-600"}`}>
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
                            <p className="py-4 text-center text-sm text-gray-400">현재 조회 가능한 시간표가 없습니다. 신청 후 담당자가 안내드립니다.</p>
                        )}
                    </div>

                    <TextArea label="농구 경험" value={form.basketballExp} onChange={(value) => update("basketballExp", value)} placeholder="농구를 해본 경험이 얼마나 있는지 간단하게 적어주세요." labelSuffix="(선택)" />

                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                            셔틀 탑승 여부 <span className="text-red-500">*</span>
                        </label>
                        <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">주 1회 10,000원 / 2회 15,000원 / 3회 20,000원</p>
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
                                    className={`rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${form.shuttleChoice === choice ? "border-brand-orange-500 bg-brand-orange-50 text-brand-orange-600 dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "border-gray-300 text-gray-600 hover:border-gray-400 dark:text-gray-300"}`}
                                >
                                    {choice}
                                </button>
                            ))}
                        </div>
                    </div>

                    {form.shuttleChoice === "탑승" && (
                        <div className="ml-2 space-y-4 border-l-2 border-brand-orange-200 pl-2">
                            <ShuttleLocationField
                                label="셔틀 탑승 장소"
                                value={form.shuttlePickup}
                                selected={Boolean(form.shuttlePickupLocationData)}
                                onChange={(value) => {
                                    update("shuttlePickup", value);
                                    update("shuttlePickupLocationData", undefined);
                                    update("shuttleLocationConsent", false);
                                }}
                                onOpenMap={() => setLocationPicker("pickup")}
                            />
                            <ShuttleLocationField
                                label="셔틀 하차 장소"
                                value={form.shuttleDropoff}
                                selected={Boolean(form.shuttleDropoffLocationData)}
                                onChange={(value) => {
                                    update("shuttleDropoff", value);
                                    update("shuttleDropoffLocationData", undefined);
                                    update("shuttleLocationConsent", false);
                                }}
                                onOpenMap={() => setLocationPicker("dropoff")}
                            />
                            <TextInput label="셔틀 희망 시간" required value={form.shuttleTime} onChange={(value) => update("shuttleTime", value)} placeholder="예: 수업 시작 20분 전, 16:30 전후" helper="참고용입니다. 실제 탑승시간은 배차 확정 후 안내됩니다." />
                            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                                <input type="checkbox" checked={form.shuttleLocationConsent} onChange={(event) => update("shuttleLocationConsent", event.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-brand-orange-500 focus:ring-brand-orange-500 dark:text-brand-neon-lime" />
                                <span>셔틀 배차와 노선 계산을 위해 탑승·하차 위치 좌표를 저장하는 데 동의합니다.</span>
                            </label>
                            <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                                <input type="checkbox" checked={form.shuttleNoticeConfirmed} onChange={(event) => update("shuttleNoticeConfirmed", event.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-brand-orange-500 focus:ring-brand-orange-500 dark:text-brand-neon-lime" />
                                <span>셔틀 운행 시간은 노선 확정 후 조정될 수 있음을 확인했습니다.</span>
                            </label>
                        </div>
                    )}

                    <div>
                        <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                            가입경로 <span className="text-red-500">*</span>
                        </label>
                        <select value={form.referralSource} onChange={(event) => update("referralSource", event.target.value)} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white">
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
                    <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
                        <FontFreeIcon name="check_circle" size={20} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                        확인 및 동의
                    </h2>
                    <div className="space-y-4 rounded-xl bg-gray-50 p-4 text-sm dark:bg-gray-900">
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
                            <SummaryRow label="신청 월" value={form.enrollmentMonths.join(", ")} strong />
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
                        if (locationPicker === "pickup") {
                            // 라벨(shuttlePickup)에는 장소명 우선. 없으면 주소로 폴백(하위호환).
                            update("shuttlePickup", location.placeName ?? location.address);
                            update("shuttlePickupLocationData", location);
                        } else {
                            update("shuttleDropoff", location.placeName ?? location.address);
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

function ShuttleLocationField({ label, value, selected, onChange, onOpenMap }: { label: string; value: string; selected: boolean; onChange: (value: string) => void; onOpenMap: () => void }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                {label} <span className="text-red-500">*</span>
            </label>
            <div className="flex gap-2">
                <input value={value} onChange={(event) => onChange(event.target.value)} placeholder="주소 또는 건물명을 입력하거나 지도로 선택" className="min-w-0 flex-1 rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
                <button type="button" onClick={onOpenMap} className="min-h-11 shrink-0 rounded-xl border border-brand-orange-200 px-3 py-2 text-sm font-bold text-brand-orange-600 hover:bg-brand-orange-50 dark:border-brand-neon-lime/40 dark:text-brand-neon-lime dark:hover:bg-brand-neon-lime/10">
                    지도
                </button>
            </div>
            <p className={`mt-1 text-xs ${selected ? "text-green-600 dark:text-green-400" : "text-amber-600 dark:text-amber-400"}`}>
                {selected ? "지도 위치가 확인되었습니다." : "주소를 직접 수정하면 지도 위치를 다시 선택해야 합니다."}
            </p>
        </div>
    );
}

function TextInput({ label, labelSuffix, required, type = "text", value, onChange, placeholder, helper }: { label: string; labelSuffix?: string; required?: boolean; type?: string; value: string; onChange: (value: string) => void; placeholder: string; helper?: string }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                {label} {required && <span className="text-red-500">*</span>} {labelSuffix && <span className="text-xs font-normal text-gray-400">{labelSuffix}</span>}
            </label>
            <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            {helper && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{helper}</p>}
        </div>
    );
}

function TextArea({ label, labelSuffix, value, onChange, placeholder }: { label: string; labelSuffix?: string; value: string; onChange: (value: string) => void; placeholder: string }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                {label} {labelSuffix && <span className="text-xs font-normal text-gray-400">{labelSuffix}</span>}
            </label>
            <textarea value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} rows={3} className="w-full resize-none rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
        </div>
    );
}

function SummarySection({ title, icon, children }: { title: string; icon: FontFreeIconName; children: ReactNode }) {
    return (
        <div>
            <h3 className="mb-1.5 flex items-center gap-1 font-semibold text-gray-900 dark:text-white">
                <FontFreeIcon name={icon} size={14} className="text-gray-500 dark:text-gray-400" />
                {title}
            </h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 pl-5">{children}</div>
        </div>
    );
}

function SummaryRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
    return (
        <>
            <span className="text-gray-500 dark:text-gray-400">{label}</span>
            <span className={`text-gray-900 dark:text-white ${strong ? "font-medium" : ""}`}>{value || "-"}</span>
        </>
    );
}

function TermsAccordion({ title, required, checked, onCheck, children }: { title: string; required?: boolean; checked: boolean; onCheck: (value: boolean) => void; children: ReactNode }) {
    const [isOpen, setIsOpen] = useState(false);
    return (
        <div className="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
            <div className="flex items-center bg-gray-50 px-4 py-3 dark:bg-gray-900">
                <label className="flex flex-1 cursor-pointer items-center gap-2">
                    <input type="checkbox" checked={checked} onChange={(event) => onCheck(event.target.checked)} className="h-5 w-5 rounded border-gray-300 text-brand-orange-500 focus:ring-brand-orange-500 dark:text-brand-neon-lime dark:focus:ring-brand-neon-lime/50" />
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{title} {required && <span className="text-red-500">*</span>}</span>
                </label>
                <button type="button" onClick={() => setIsOpen(!isOpen)} className="p-1 text-gray-400 hover:text-gray-600 dark:text-gray-300">
                    <FontFreeIcon name="expand_more" size={18} className={`transition-transform ${isOpen ? "rotate-180" : ""}`} />
                </button>
            </div>
            {isOpen && <div className="max-h-48 overflow-y-auto border-t border-gray-100 px-4 py-3 text-xs leading-relaxed text-gray-600 dark:border-gray-800 dark:text-gray-300">{children}</div>}
        </div>
    );
}

function EnrollTermsContent() {
    return (
        <div className="space-y-2">
            <p className="font-semibold text-gray-800 dark:text-gray-100">STIZ 농구교실 수강 이용약관</p>
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
            <p className="font-semibold text-gray-800 dark:text-gray-100">개인정보 수집/이용 동의</p>
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
