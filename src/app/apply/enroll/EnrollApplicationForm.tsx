"use client";

import { publicErrorText } from "@/components/ui/public-error-text";
import { useState, useTransition } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
    findExistingEnrollApplicationForEdit,
    submitEnrollApplication,
    type AvailableSlot,
    type TrialLeadForEnroll,
} from "@/app/actions/public";
import { trackMetaEvent } from "@/components/MetaPixel";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import type { MapLocationData } from "@/components/maps/LocationPickerModal";
import { SHUTTLE_LOCATION_CONSENT_VERSION } from "@/lib/seasonal/contracts";

const EnrollApplicationLaterSteps = dynamic(() => import("./EnrollApplicationLaterSteps"), {
    loading: () => (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-400">
            다음 단계를 불러오는 중...
        </div>
    ),
});

interface Props {
    availableSlots: AvailableSlot[];
    contactPhone: string;
    trialData: TrialLeadForEnroll | null;
    accessCode: string | null;
}

interface AccountHandoff {
    token: string;
    next: string;
    parentName: string;
    parentPhone: string;
    alreadyLinked?: boolean;
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
    shuttleTime: string;
    shuttleDropoff: string;
    shuttleDropoffLocationData?: MapLocationData;
    shuttleLocationConsent: boolean;
    referralSource: string;
    memo: string;
    agreedTerms: boolean;
    agreedPrivacy: boolean;
    applicationNoticeConfirmed: boolean;
    shuttleNoticeConfirmed: boolean;
    honeypot: string;
}

const STEP_LABELS = ["아이 정보", "보호자", "수강 정보", "확인/동의"];
const TOTAL_STEPS = 4;
const GRADE_OPTIONS = ["6세", "7세", "초1", "초2", "초3", "초4", "초5", "초6", "중1", "중2", "중3", "고1", "고2", "고3", "성인"];

export default function EnrollApplicationForm({ availableSlots, contactPhone, trialData, accessCode }: Props) {
    const preferredTrialSlot = trialData?.preferredSlotKey && availableSlots.some((slot) => slot.slotKey === trialData.preferredSlotKey)
        ? trialData.preferredSlotKey
        : "";
    const trialChildPhone = trialData?.childPhone || trialData?.parentPhone || "";
    const [step, setStep] = useState(1);
    const [form, setForm] = useState<FormData>({
        childName: trialData?.childName || "",
        childBirthDate: trialData?.childBirthDate || "",
        childGender: trialData?.childGender || "",
        childGrade: trialData?.childGrade || "",
        childSchool: trialData?.childSchool || "",
        childPhone: trialChildPhone,
        parentName: trialData?.parentName || "",
        parentPhone: trialData?.parentPhone || "",
        parentRelation: "",
        address: "",
        enrollmentMonths: [],
        preferredSlotKeys: preferredTrialSlot ? [preferredTrialSlot] : [],
        basketballExp: trialData?.basketballExp || "",
        shuttleChoice: "",
        shuttleNeeded: false,
        shuttlePickup: "",
        shuttlePickupLocationData: undefined,
        shuttleTime: "",
        shuttleDropoff: "",
        shuttleDropoffLocationData: undefined,
        shuttleLocationConsent: false,
        referralSource: trialData?.source || "",
        memo: "",
        agreedTerms: false,
        agreedPrivacy: false,
        applicationNoticeConfirmed: false,
        shuttleNoticeConfirmed: false,
        honeypot: "",
    });
    const [error, setError] = useState("");
    const [completed, setCompleted] = useState(false);
    const [existingApplicationId, setExistingApplicationId] = useState<string | null>(null);
    const [existingNotice, setExistingNotice] = useState("");
    const [completionMode, setCompletionMode] = useState<"created" | "updated" | "existing">("created");
    const [accountHandoff, setAccountHandoff] = useState<AccountHandoff | null>(null);
    const [isPending, startTransition] = useTransition();

    const update = (field: keyof FormData, value: string | boolean | string[] | MapLocationData | undefined) => {
        setForm((prev) => ({ ...prev, [field]: value }));
        setError("");
    };

    const validateStep1 = (): boolean => {
        if (!form.childName.trim()) { setError("아이 이름을 입력해주세요."); return false; }
        if (!form.childBirthDate) { setError("아이 생년월일을 선택해주세요."); return false; }
        if (!form.childGender) { setError("성별을 선택해주세요."); return false; }
        if (!form.childGrade) { setError("학년을 선택해주세요."); return false; }
        if (!form.childSchool.trim()) { setError("학교명을 입력해주세요."); return false; }
        if (!form.childPhone.trim()) { setError("학생 전화번호를 입력해주세요."); return false; }
        return true;
    };

    const validateStep2 = (): boolean => {
        if (!form.parentName.trim()) { setError("보호자 이름을 입력해주세요."); return false; }
        if (!form.parentPhone.trim()) { setError("보호자 연락처를 입력해주세요."); return false; }
        const digits = form.parentPhone.replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 11) {
            setError("올바른 전화번호를 입력해주세요. 예: 010-1234-5678");
            return false;
        }
        return true;
    };

    const validateStep3 = (): boolean => {
        if (form.enrollmentMonths.length === 0) { setError("수강신청 월을 선택해주세요."); return false; }
        if (!form.referralSource) { setError("가입경로를 선택해주세요."); return false; }
        if (!form.shuttleChoice) { setError("셔틀 탑승 여부를 선택해주세요."); return false; }
        if (form.shuttleChoice === "탑승") {
            if (!form.shuttlePickup.trim()) { setError("셔틀 탑승 장소를 입력해주세요."); return false; }
            if (!form.shuttlePickupLocationData) { setError("셔틀 탑승 위치를 지도에서 선택해주세요."); return false; }
            if (!form.shuttleTime) { setError("셔틀 희망 시간을 입력해주세요."); return false; }
            if (!form.shuttleDropoff.trim()) { setError("셔틀 하차 장소를 입력해주세요."); return false; }
            if (!form.shuttleDropoffLocationData) { setError("셔틀 하차 위치를 지도에서 선택해주세요."); return false; }
            if (!form.shuttleLocationConsent) { setError("셔틀 위치정보 수집·이용에 동의해주세요."); return false; }
            if (!form.shuttleNoticeConfirmed) { setError("셔틀 주의사항을 확인해주세요."); return false; }
        }
        return true;
    };

    const loadExistingApplication = async () => {
        const existing = await findExistingEnrollApplicationForEdit({
            accessCode,
            childName: form.childName,
            childBirthDate: form.childBirthDate,
            parentPhone: form.parentPhone,
        });
        if (!existing || existing.id === existingApplicationId) return;

        setExistingApplicationId(existing.id);
        if (existing.editable) {
            setForm((prev) => ({
                ...prev,
                childName: existing.childName || prev.childName,
                childBirthDate: existing.childBirthDate || prev.childBirthDate,
                childGender: existing.childGender || prev.childGender,
                childGrade: existing.childGrade || prev.childGrade,
                childSchool: existing.childSchool || prev.childSchool,
                childPhone: existing.childPhone || prev.childPhone,
                parentName: existing.parentName || prev.parentName,
                parentPhone: existing.parentPhone || prev.parentPhone,
                parentRelation: existing.parentRelation || prev.parentRelation,
                address: existing.address || prev.address,
                enrollmentMonths: existing.enrollmentMonths.length > 0 ? existing.enrollmentMonths : prev.enrollmentMonths,
                preferredSlotKeys: existing.preferredSlotKeys.length > 0 ? existing.preferredSlotKeys : prev.preferredSlotKeys,
                basketballExp: existing.basketballExp || prev.basketballExp,
                shuttleChoice: existing.shuttleNeeded ? "탑승" : "미탑승",
                shuttleNeeded: existing.shuttleNeeded,
                shuttlePickup: existing.shuttlePickup || prev.shuttlePickup,
                shuttlePickupLocationData: existing.shuttlePickupLocationData || undefined,
                shuttleTime: existing.shuttleTime || prev.shuttleTime,
                shuttleDropoff: existing.shuttleDropoff || prev.shuttleDropoff,
                shuttleDropoffLocationData: existing.shuttleDropoffLocationData || undefined,
                shuttleLocationConsent: Boolean(
                    existing.shuttlePickupLocationData
                    && existing.shuttleDropoffLocationData
                    && existing.shuttleLocationConsent === true
                    && existing.shuttleLocationConsentVersion === SHUTTLE_LOCATION_CONSENT_VERSION,
                ),
                referralSource: existing.referralSource || prev.referralSource,
                memo: existing.memo || prev.memo,
            }));
            setExistingNotice("기존 수강신청서를 불러왔습니다. 필요한 부분만 수정해서 다시 제출해주세요.");
        } else {
            setExistingNotice("이미 승인된 수강신청서가 있습니다. 변경이 필요하면 학원으로 문의해주세요.");
        }
    };

    const goNext = async () => {
        if (step === 1 && !validateStep1()) return;
        if (step === 2 && !validateStep2()) return;
        if (step === 3 && !validateStep3()) return;
        if (step === 2) await loadExistingApplication();
        setError("");
        setStep((current) => Math.min(current + 1, TOTAL_STEPS));
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const goBack = () => {
        setError("");
        setStep((current) => Math.max(current - 1, 1));
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const toggleSlot = (slotKey: string) => {
        const keys = form.preferredSlotKeys;
        update("preferredSlotKeys", keys.includes(slotKey) ? keys.filter((key) => key !== slotKey) : [...keys, slotKey]);
    };

    const handleSubmit = () => {
        if (!form.agreedTerms || !form.agreedPrivacy) {
            setError("이용약관과 개인정보 수집/이용에 모두 동의해주세요.");
            return;
        }
        if (!form.applicationNoticeConfirmed) {
            setError("수강신청 확정 안내를 확인해주세요.");
            return;
        }
        startTransition(async () => {
            try {
                const result = await submitEnrollApplication({
                    existingId: existingApplicationId || undefined,
                    accessCode: accessCode || undefined,
                    childName: form.childName,
                    childBirthDate: form.childBirthDate,
                    childGender: form.childGender || undefined,
                    childGrade: form.childGrade || undefined,
                    childSchool: form.childSchool || undefined,
                    childPhone: form.childPhone || undefined,
                    parentName: form.parentName,
                    parentPhone: form.parentPhone,
                    parentRelation: form.parentRelation || undefined,
                    address: form.address || undefined,
                    enrollmentMonths: form.enrollmentMonths.join(",") || undefined,
                    preferredSlotKeys: form.preferredSlotKeys.join(",") || undefined,
                    basketballExp: form.basketballExp || undefined,
                    shuttleNeeded: form.shuttleChoice === "탑승",
                    shuttlePickup: form.shuttlePickup || undefined,
                    shuttlePickupLocationData: form.shuttleChoice === "탑승" ? form.shuttlePickupLocationData : undefined,
                    shuttleTime: form.shuttleTime || undefined,
                    shuttleDropoff: form.shuttleDropoff || undefined,
                    shuttleDropoffLocationData: form.shuttleChoice === "탑승" ? form.shuttleDropoffLocationData : undefined,
                    shuttleLocationConsent: form.shuttleChoice === "탑승" && form.shuttleLocationConsent,
                    shuttleLocationConsentVersion: form.shuttleChoice === "탑승" ? SHUTTLE_LOCATION_CONSENT_VERSION : undefined,
                    referralSource: form.referralSource || undefined,
                    memo: form.memo || undefined,
                    agreedTerms: form.agreedTerms,
                    agreedPrivacy: form.agreedPrivacy,
                    applicationNoticeConfirmed: form.applicationNoticeConfirmed,
                    shuttleNoticeConfirmed: form.shuttleNoticeConfirmed,
                    honeypot: form.honeypot,
                });
                setCompletionMode(result.mode === "updated" ? "updated" : result.mode === "existing" ? "existing" : "created");
                setAccountHandoff("accountHandoff" in result && result.accountHandoff ? result.accountHandoff as AccountHandoff : null);
                trackMetaEvent("CompleteRegistration", {
                    content_name: "Enrollment application",
                    content_category: "Application",
                });
                setCompleted(true);
                window.scrollTo({ top: 0, behavior: "smooth" });
            } catch (e: unknown) {
                console.error("[enroll] 신청 실패", e);
                // 서버 원문(영어·개발 용어)은 화면에 내지 않고 쉬운 안내로 바꾼다
                setError(publicErrorText(e, "신청 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."));
            }
        });
    };

    const signupHref = accountHandoff
        ? `${accountHandoff.next}${accountHandoff.next.includes("?") ? "&" : "?"}${new URLSearchParams({
            name: accountHandoff.parentName,
            phone: accountHandoff.parentPhone,
            enrollmentHandoff: accountHandoff.token,
        }).toString()}`
        : "/signup/parent";
    const loginHref = accountHandoff
        ? `/login?${new URLSearchParams({ redirect: "/mypage", enrollmentHandoff: accountHandoff.token }).toString()}`
        : "/login";

    if (completed) {
        return (
            <div className="rounded-2xl bg-white p-8 text-center shadow-lg dark:bg-gray-800">
                <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
                    <FontFreeIcon name="check_circle" size={40} className="text-green-600" />
                </div>
                <h2 className="mb-3 text-2xl font-black text-gray-900 dark:text-white">
                    {completionMode === "updated" ? "수강신청서 수정 완료!" : completionMode === "existing" ? "이미 접수된 수강신청서가 있습니다" : "수강신청 완료!"}
                </h2>
                <p className="mb-2 text-gray-600 dark:text-gray-300">담당자가 빠른 시간 안에 연락드리겠습니다.</p>
                <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
                    문의사항이 있으시면{" "}
                    <a href={`tel:${contactPhone.replace(/-/g, "")}`} className="font-semibold text-brand-orange-500 dark:text-brand-neon-lime">{contactPhone}</a>
                    로 전화해주세요.
                </p>
                {accountHandoff && !accountHandoff.alreadyLinked && (
                    <div className="mb-6 rounded-2xl border border-brand-orange-200 bg-orange-50 p-5 text-left dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10">
                        <h3 className="font-black text-brand-navy-900 dark:text-white">이어서 학부모 계정을 연결해주세요</h3>
                        <p className="mt-1 text-sm leading-6 text-gray-600 dark:text-gray-300">계정을 연결하면 방금 제출한 신청서를 바로 확인할 수 있습니다. 가입하지 않아도 수강신청은 이미 정상 접수되었습니다.</p>
                        <div className="mt-4 grid gap-2 sm:grid-cols-2">
                            <Link href={signupHref} className="flex min-h-12 items-center justify-center rounded-xl bg-brand-orange-500 px-4 text-center font-bold text-white hover:bg-brand-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900">처음이에요 · 회원가입</Link>
                            <Link href={loginHref} className="flex min-h-12 items-center justify-center rounded-xl border border-gray-300 bg-white px-4 text-center font-bold text-brand-navy-900 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-900 dark:text-white">계정이 있어요 · 로그인</Link>
                        </div>
                        <p className="mt-3 text-xs leading-5 text-gray-500 dark:text-gray-400">신청서의 보호자 이름과 전화번호가 가입 또는 인증 정보와 일치해야 자동으로 연결됩니다.</p>
                    </div>
                )}
                {accountHandoff?.alreadyLinked && (
                    <div className="mb-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm font-semibold text-green-800 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200">현재 로그인한 학부모 계정에 신청서가 연결되었습니다.</div>
                )}
                <Link href="/" className="inline-flex items-center gap-2 rounded-xl bg-brand-navy-900 px-6 py-3 font-medium text-white transition-colors hover:bg-brand-navy-800">
                    <FontFreeIcon name="home" size={18} />
                    홈으로 돌아가기
                </Link>
            </div>
        );
    }

    return (
        <div className="public-form-card public-card min-w-0 overflow-hidden rounded-2xl bg-white shadow-lg dark:bg-gray-800">
            <div className="public-stepper border-b border-gray-100 bg-gray-50 px-4 sm:px-6 py-3 dark:border-gray-800 dark:bg-gray-900">
                <div className="mx-auto flex max-w-md items-center justify-between">
                    {Array.from({ length: TOTAL_STEPS }, (_, index) => index + 1).map((number) => (
                        <div key={number} className="flex items-center">
                            <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold transition-colors ${number < step ? "bg-green-500 text-white" : number === step ? "bg-brand-orange-500 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900" : "bg-gray-200 text-gray-400"}`}>
                                {number < step ? <FontFreeIcon name="check" size={18} /> : number}
                            </div>
                            <span className={`ml-1.5 hidden text-xs font-medium sm:inline ${number === step ? "text-gray-900 dark:text-white" : "text-gray-400"}`}>{STEP_LABELS[number - 1]}</span>
                            {number < TOTAL_STEPS && <div className={`mx-1.5 h-0.5 w-6 sm:w-8 ${number < step ? "bg-green-500" : "bg-gray-200"}`} />}
                        </div>
                    ))}
                </div>
            </div>

            {trialData && step === 1 && (
                <div className="mx-6 mt-4 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700">
                    <FontFreeIcon name="auto_fix_high" size={18} />
                    체험수업 정보가 자동으로 입력되었습니다. 필요하면 수정할 수 있습니다.
                </div>
            )}

            <div className="p-4 sm:p-6">
                {error && (
                    <div className="mb-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                        <FontFreeIcon name="error" size={18} />
                        {error}
                    </div>
                )}
                {existingNotice && (
                    <div className="mb-4 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100">
                        <FontFreeIcon name="edit" size={18} />
                        {existingNotice}
                    </div>
                )}

                {step === 1 && (
                    <div className="space-y-5">
                        <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
                            <FontFreeIcon name="child_care" size={20} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                            아이 정보
                        </h2>
                        <Field label="아이 이름" required value={form.childName} onChange={(value) => update("childName", value)} placeholder="아이 이름" />
                        <Field label="생년월일" required type="date" value={form.childBirthDate} onChange={(value) => update("childBirthDate", value)} placeholder="연도-월-일" />
                        <div>
                            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                                성별 <span className="text-red-500">*</span>
                            </label>
                            <div className="flex gap-2">
                                {["남", "여"].map((gender) => (
                                    <button key={gender} type="button" onClick={() => update("childGender", gender)} className={`flex-1 rounded-xl border py-3 text-sm font-medium transition-colors ${form.childGender === gender ? "border-brand-orange-500 bg-brand-orange-50 text-brand-orange-600 dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "border-gray-300 text-gray-600 hover:border-gray-400 dark:text-gray-300"}`}>
                                        {gender}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                                학년 <span className="text-red-500">*</span>
                            </label>
                            <select value={form.childGrade} onChange={(event) => update("childGrade", event.target.value)} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white">
                                <option value="">선택해주세요</option>
                                {GRADE_OPTIONS.map((grade) => <option key={grade} value={grade}>{grade}</option>)}
                            </select>
                        </div>
                        <Field label="학교명" required value={form.childSchool} onChange={(value) => update("childSchool", value)} placeholder="도농초등학교" />
                        <Field label="학생 전화번호" required type="tel" value={form.childPhone} onChange={(value) => update("childPhone", formatPhone(value))} placeholder="학생 또는 보호자 연락처" />
                    </div>
                )}

                <EnrollApplicationLaterSteps step={step} form={form} availableSlots={availableSlots} update={update} toggleSlot={toggleSlot} />

                <div className="mt-8 flex justify-between">
                    {step > 1 ? (
                        <button type="button" onClick={goBack} className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-5 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200">
                            <FontFreeIcon name="arrow_back" size={18} />
                            이전
                        </button>
                    ) : <div />}

                    {step < TOTAL_STEPS ? (
                        <button type="button" onClick={goNext} className="inline-flex items-center gap-2 rounded-xl bg-brand-orange-500 px-6 py-3 font-bold text-white transition-colors hover:bg-brand-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900">
                            다음
                            <FontFreeIcon name="arrow_forward" size={18} />
                        </button>
                    ) : (
                        <button type="button" onClick={handleSubmit} disabled={isPending} className="inline-flex items-center gap-2 rounded-xl bg-brand-orange-500 px-6 py-3 font-bold text-white transition-colors hover:bg-brand-orange-600 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900">
                            {isPending ? (
                                <>
                                    <FontFreeIcon name="progress_activity" size={18} className="animate-spin" />
                                    제출 중...
                                </>
                            ) : (
                                <>
                                    <FontFreeIcon name="send" size={18} />
                                    수강신청 제출
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function Field({ label, required, type = "text", value, onChange, placeholder, helper }: { label: string; required?: boolean; type?: string; value: string; onChange: (value: string) => void; placeholder: string; helper?: string }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
            {helper && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{helper}</p>}
        </div>
    );
}

function formatPhone(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}
