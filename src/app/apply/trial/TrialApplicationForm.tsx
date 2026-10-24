"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import {
    findExistingTrialApplicationForEdit,
    submitTrialApplication,
    type AvailableSlot,
} from "@/app/actions/public";
import { trackMetaEvent } from "@/components/MetaPixel";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import { isKstYmd, todayKst } from "@/lib/datetime/kst";
import { trialDayForDate, trialScheduleError, trialScheduleForDate, trialSlotPeriod as getSlotPeriod, type TrialScheduleSelection } from "./trialScheduleSelection";

interface Props {
    availableSlots: AvailableSlot[];
    contactPhone: string;
    initialSource: string;
}

interface FormData {
    trialDate: string;
    trialDay: string;
    trialPeriod: string;
    childName: string;
    childGrade: string;
    childGender: string;
    childSchool: string;
    parentPhone: string;
    source: string;
    // 「체험수업 비용과 입금 계좌를 확인했습니다」 체크 — 학부모 동의일 뿐 입금 완료가 아니다
    trialFeeNoticeAgreed: boolean;
    honeypot: string;
}

const GRADE_OPTIONS = ["6세", "7세", "초1", "초2", "초3", "초4", "초5", "초6", "중1", "중2", "중3", "고1", "고2", "고3", "성인"];
const SOURCE_OPTIONS = [
    { value: "NAVER_AD", label: "네이버 검색광고" },
    { value: "NAVER_SEARCH", label: "네이버 키워드 검색" },
    { value: "PORTAL_OTHER", label: "네이버 외 포털검색" },
    { value: "NAVER_BLOG", label: "스티즈 네이버블로그" },
    { value: "INSTAGRAM", label: "인스타그램" },
    { value: "YOUTUBE", label: "유튜브" },
    { value: "PASSBY", label: "지나가다 발견" },
    { value: "REFERRAL", label: "지인소개" },
    { value: "SOOMGO", label: "숨고" },
    { value: "DANGGEUN", label: "당근마켓" },
    { value: "OTHER", label: "기타" },
];
const TRIAL_FEE_PAYMENT_INFO = {
    amountLabel: "10,000원",
    bankName: "카카오뱅크",
    accountNumber: "3333-05-1344817",
    accountHolder: "김수빈",
    memo: "STIZ 체험수업비",
};
const TRIAL_FEE_COPY_TEXT = [
    "STIZ 농구교실 다산2호점 체험수업비 입금 안내",
    `금액: ${TRIAL_FEE_PAYMENT_INFO.amountLabel}`,
    `은행: ${TRIAL_FEE_PAYMENT_INFO.bankName}`,
    `계좌: ${TRIAL_FEE_PAYMENT_INFO.accountNumber}`,
    `예금주: ${TRIAL_FEE_PAYMENT_INFO.accountHolder}`,
    `메모: ${TRIAL_FEE_PAYMENT_INFO.memo}`,
].join("\n");
const INITIAL_FORM: FormData = {
    trialDate: "",
    trialDay: "",
    trialPeriod: "",
    childName: "",
    childGrade: "",
    childGender: "",
    childSchool: "",
    parentPhone: "",
    source: "",
    trialFeeNoticeAgreed: false,
    honeypot: "",
};

export default function TrialApplicationForm({ availableSlots, contactPhone, initialSource }: Props) {
    const [step, setStep] = useState(1);
    const [form, setForm] = useState<FormData>({ ...INITIAL_FORM, source: initialSource });
    const [error, setErrorMessage] = useState("");
    const [completed, setCompleted] = useState(false);
    const [existingLeadId, setExistingLeadId] = useState<string | null>(null);
    const [existingNotice, setExistingNotice] = useState("");
    const [completionMode, setCompletionMode] = useState<"created" | "updated">("created");
    const [paymentNotice, setPaymentNotice] = useState("");
    const [isPending, startTransition] = useTransition();
    const [errorVersion, setErrorVersion] = useState(0);
    const errorRef = useRef<HTMLDivElement>(null);

    const setError = (message: string) => {
        setErrorMessage(message);
        if (message) setErrorVersion((version) => version + 1);
    };

    useEffect(() => {
        // 단계 복귀로 화면 높이가 바뀐 뒤 오류를 보여준다. 같은 오류 재시도도 포함한다.
        if (error) errorRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
    }, [error, step, errorVersion]);

    const dateDay = trialDayForDate(form.trialDate);
    const dayOptions = dateDay ? [dateDay] : [];
    const periodOptions = dateDay
        ? availableSlots
            .filter((slot) => slot.dayLabel === dateDay)
            .map((slot) => ({ period: getSlotPeriod(slot.slotKey), slot }))
            .filter((option) => option.period)
        : [];
    const selectedSlot = availableSlots.find((slot) => slot.dayLabel === form.trialDay && getSlotPeriod(slot.slotKey) === form.trialPeriod);

    const update = (field: keyof FormData, value: string | boolean) => {
        setForm((prev) => ({ ...prev, [field]: value }));
        setError("");
    };

    const selectTrialDay = (day: string) => {
        if (day !== dateDay) return;
        setForm((prev) => ({
            ...prev,
            trialDay: day,
            trialPeriod: prev.trialDay === day ? prev.trialPeriod : "",
        }));
        setError("");
    };

    const selectTrialDate = (date: string) => {
        setForm((prev) => ({ ...prev, ...trialScheduleForDate(prev, date, availableSlots) }));
        setError(isKstYmd(date) && date < todayKst() ? "오늘 이후의 체험수업 날짜를 다시 선택해주세요." : "");
    };

    const copyTextToClipboard = async (text: string) => {
        if (!navigator.clipboard?.writeText) {
            setPaymentNotice("현재 브라우저에서는 자동 복사가 어렵습니다. 계좌번호를 길게 눌러 복사해주세요.");
            return false;
        }
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            setPaymentNotice("복사 권한이 차단되었습니다. 계좌번호를 직접 선택해서 복사해주세요.");
            return false;
        }
    };

    const copyTrialFeeAccount = async () => {
        const copied = await copyTextToClipboard(TRIAL_FEE_PAYMENT_INFO.accountNumber);
        if (copied) setPaymentNotice("계좌번호가 복사되었습니다.");
    };

    const handleTrialFeeTransfer = async () => {
        const copied = await copyTextToClipboard(TRIAL_FEE_COPY_TEXT);
        const sharePayload = {
            title: "STIZ 체험수업비 입금 안내",
            text: TRIAL_FEE_COPY_TEXT,
        };

        if (navigator.share) {
            try {
                await navigator.share(sharePayload);
                setPaymentNotice("입금 정보가 공유되었습니다. 사용하는 송금 앱에서 확인해주세요.");
                return;
            } catch (e) {
                if (e instanceof DOMException && e.name === "AbortError") {
                    setPaymentNotice(copied ? "입금 정보가 복사되었습니다." : "송금 앱에서 계좌 정보를 직접 입력해주세요.");
                    return;
                }
            }
        }

        setPaymentNotice(copied ? "입금 정보가 복사되었습니다. 송금 앱에 붙여넣어 주세요." : "송금 앱에서 계좌 정보를 직접 입력해주세요.");
    };

    const validateStep1 = (selection: TrialScheduleSelection = form): boolean => {
        const scheduleError = trialScheduleError(selection, availableSlots);
        if (scheduleError) { setError(scheduleError); return false; }
        return true;
    };

    const validateStep2 = (): boolean => {
        if (!form.childName.trim()) { setError("아이 이름을 입력해주세요."); return false; }
        if (!form.childGender) { setError("성별을 선택해주세요."); return false; }
        if (!form.childSchool.trim()) { setError("학교를 입력해주세요."); return false; }
        if (!form.childGrade) { setError("학년을 선택해주세요."); return false; }
        if (!form.parentPhone.trim()) { setError("학부모 연락처를 입력해주세요."); return false; }
        const digits = form.parentPhone.replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 11) {
            setError("올바른 전화번호를 입력해주세요. 예: 010-1234-5678");
            return false;
        }
        if (!form.source) { setError("신청경로를 선택해주세요."); return false; }
        return true;
    };

    const loadExistingApplication = async () => {
        const existing = await findExistingTrialApplicationForEdit({
            childName: form.childName,
            parentPhone: form.parentPhone,
        });
        if (!existing || existing.id === existingLeadId) return null;

        setExistingLeadId(existing.id);
        setForm((prev) => ({
            ...prev,
            trialDate: existing.trialDate || prev.trialDate,
            trialDay: existing.trialDay || prev.trialDay,
            trialPeriod: existing.trialPeriod || prev.trialPeriod,
            childName: existing.childName || prev.childName,
            childGrade: existing.childGrade || prev.childGrade,
            childGender: existing.childGender || prev.childGender,
            childSchool: existing.childSchool || prev.childSchool,
            parentPhone: existing.parentPhone || prev.parentPhone,
            source: existing.source || prev.source,
            trialFeeNoticeAgreed: existing.trialFeeNoticeAgreed || prev.trialFeeNoticeAgreed,
        }));
        setExistingNotice("기존 체험수업 신청서를 불러왔습니다. 필요한 부분만 수정해서 다시 제출해주세요.");
        return {
            trialDate: existing.trialDate || form.trialDate,
            trialDay: existing.trialDay || form.trialDay,
            trialPeriod: existing.trialPeriod || form.trialPeriod,
        };
    };

    const goNext = async () => {
        if (step === 1 && !validateStep1()) return;
        if (step === 2) {
            if (!validateStep1()) { setStep(1); return; }
            if (!validateStep2()) return;
            try {
                const loadedSchedule = await loadExistingApplication();
                if (loadedSchedule && !validateStep1(loadedSchedule)) { setStep(1); return; }
            } catch {
                setError("기존 신청 정보를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
                return;
            }
        }
        setError("");
        setStep((current) => Math.min(current + 1, 3));
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const goBack = () => {
        setError("");
        setStep((current) => Math.max(current - 1, 1));
        window.scrollTo({ top: 0, behavior: "smooth" });
    };

    const handleSubmit = () => {
        if (!validateStep1()) { setStep(1); return; }
        if (!form.trialFeeNoticeAgreed) {
            setError("체험수업 비용 확인을 체크해주세요.");
            return;
        }

        startTransition(async () => {
            try {
                const preferredSlotKey = selectedSlot?.slotKey;
                const result = await submitTrialApplication({
                    existingId: existingLeadId || undefined,
                    trialDate: form.trialDate,
                    trialDay: form.trialDay,
                    trialPeriod: form.trialPeriod,
                    preferredSlotKey,
                    childName: form.childName,
                    childGrade: form.childGrade,
                    childGender: form.childGender,
                    childSchool: form.childSchool,
                    parentPhone: form.parentPhone,
                    source: form.source,
                    trialFeeNoticeAgreed: form.trialFeeNoticeAgreed,
                    honeypot: form.honeypot,
                });
                setCompletionMode(result.mode === "updated" ? "updated" : "created");
                trackMetaEvent("Lead", {
                    content_name: "Trial application",
                    content_category: "Application",
                });
                setCompleted(true);
                window.scrollTo({ top: 0, behavior: "smooth" });
            } catch (e: unknown) {
                setError(e instanceof Error ? e.message : "신청 중 오류가 발생했습니다.");
            }
        });
    };

    if (completed) {
        return (
            <div className="rounded-2xl bg-white p-8 text-center shadow-lg dark:bg-gray-800">
                <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
                    <FontFreeIcon name="check_circle" size={40} className="text-green-600" />
                </div>
                <h2 className="mb-3 text-2xl font-black text-gray-900 dark:text-white">
                    {completionMode === "updated" ? "체험수업 신청서 수정 완료!" : "체험수업 신청 완료!"}
                </h2>
                <p className="mb-2 text-gray-600 dark:text-gray-300">담당자가 빠른 시간 안에 연락드리겠습니다.</p>
                <p className="mb-6 text-sm text-gray-500 dark:text-gray-400">
                    문의사항이 있으시면{" "}
                    <a href={`tel:${contactPhone.replace(/-/g, "")}`} className="font-semibold text-brand-orange-500 dark:text-brand-neon-lime">{contactPhone}</a>
                    로 전화해주세요.
                </p>
                <div className="mb-6 rounded-2xl border border-brand-orange-200 bg-orange-50 p-5 text-left dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10">
                    <h3 className="text-xl font-black text-gray-950 dark:text-white">체험수업비 입금 안내</h3>
                    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">입금 확인 후 체험수업 일정 안내가 진행됩니다.</p>
                    <div className="mt-4 grid gap-3 rounded-xl bg-white p-4 text-sm dark:bg-gray-900">
                        <InfoRow label="금액" value={TRIAL_FEE_PAYMENT_INFO.amountLabel} />
                        <InfoRow label="은행" value={TRIAL_FEE_PAYMENT_INFO.bankName} />
                        <InfoRow label="계좌" value={TRIAL_FEE_PAYMENT_INFO.accountNumber} />
                        <InfoRow label="예금주" value={TRIAL_FEE_PAYMENT_INFO.accountHolder} />
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        <button type="button" onClick={copyTrialFeeAccount} className="rounded-xl border border-brand-orange-200 bg-white px-4 py-3 text-sm font-bold text-brand-orange-600 hover:bg-orange-50 dark:border-brand-neon-lime/40 dark:bg-gray-950 dark:text-brand-neon-lime">
                            계좌번호 복사하기
                        </button>
                        <button type="button" onClick={handleTrialFeeTransfer} className="rounded-xl bg-brand-orange-500 px-4 py-3 text-sm font-bold text-white hover:bg-brand-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900">
                            입금 정보 공유하기
                        </button>
                    </div>
                    {paymentNotice && <p className="mt-3 text-xs font-semibold text-brand-orange-600 dark:text-brand-neon-lime">{paymentNotice}</p>}
                </div>
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
                <div className="mx-auto flex max-w-sm items-center justify-between">
                    {[1, 2, 3].map((number) => (
                        <div key={number} className="flex items-center">
                            <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold transition-colors ${number < step ? "bg-green-500 text-white" : number === step ? "bg-brand-orange-500 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900" : "bg-gray-200 text-gray-400"}`}>
                                {number < step ? <FontFreeIcon name="check" size={18} /> : number}
                            </div>
                            <span className={`ml-1.5 hidden text-xs font-medium sm:inline ${number === step ? "text-gray-900 dark:text-white" : "text-gray-400"}`}>
                                {number === 1 ? "체험 일정" : number === 2 ? "신청 정보" : "비용 확인"}
                            </span>
                            {number < 3 && <div className={`mx-1.5 h-0.5 w-8 ${number < step ? "bg-green-500" : "bg-gray-200"}`} />}
                        </div>
                    ))}
                </div>
            </div>

            <div className="p-4 sm:p-6">
                {error && (
                    <div ref={errorRef} role="alert" className="mb-4 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
                            <FontFreeIcon name="calendar_today" size={20} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                            체험 일정
                        </h2>
                        <Field label="체험수업 희망일" required type="date" min={todayKst()} value={form.trialDate} onChange={selectTrialDate} placeholder="연도-월-일" />
                        {dateDay ? <ButtonGroup label="희망 요일" required options={dayOptions} value={form.trialDay} onChange={selectTrialDay} /> : <p className="text-sm text-gray-500">날짜를 선택하면 요일이 자동으로 정해집니다.</p>}
                        <div>
                            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                                희망 교시 <span className="text-red-500">*</span>
                            </label>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {periodOptions.map(({ period, slot }) => {
                                    const isFull = Boolean(slot && slot.available <= 0);
                                    return (
                                        <button key={period} type="button" disabled={isFull} onClick={() => update("trialPeriod", period)} className={`rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${isFull ? "cursor-not-allowed border-gray-200 bg-gray-50 text-gray-300 dark:border-gray-700 dark:bg-gray-900" : form.trialPeriod === period ? "border-brand-orange-500 bg-brand-orange-50 text-brand-orange-600 dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "border-gray-300 text-gray-600 hover:border-gray-400 dark:text-gray-300"}`}>
                                            <span className="block">{period}교시</span>
                                            {slot && <span className="mt-1 block text-xs">{isFull ? "마감" : `잔여 ${slot.available}명`}</span>}
                                        </button>
                                    );
                                })}
                            </div>
                            {dateDay && periodOptions.length === 0 && <p className="mt-2 text-sm text-gray-500">{availableSlots.length === 0 ? "시간표 정보를 확인할 수 없습니다. 학원으로 문의해주세요." : "선택한 날짜의 요일에는 등록된 수업이 없습니다. 다른 날짜를 선택해주세요."}</p>}
                        </div>
                    </div>
                )}

                {step === 2 && (
                    <div className="space-y-5">
                        <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
                            <FontFreeIcon name="child_care" size={20} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                            아이 정보 / 연락처
                        </h2>
                        <Field label="아이 이름" required value={form.childName} onChange={(value) => update("childName", value)} placeholder="아이 이름" />
                        <ButtonGroup label="성별" required options={["남", "여"]} value={form.childGender} onChange={(value) => update("childGender", value)} />
                        <Field label="학교" required value={form.childSchool} onChange={(value) => update("childSchool", value)} placeholder="도농초등학교" />
                        <SelectField label="학년" required value={form.childGrade} onChange={(value) => update("childGrade", value)} options={GRADE_OPTIONS} />
                        <Field label="학부모 연락처" required type="tel" value={form.parentPhone} onChange={(value) => update("parentPhone", formatPhone(value))} placeholder="010-0000-0000" />
                        <SelectField label="신청경로" required value={form.source} onChange={(value) => update("source", value)} options={SOURCE_OPTIONS.map((option) => option.label)} valueMap={SOURCE_OPTIONS} />
                    </div>
                )}

                {step === 3 && (
                    <div className="space-y-5">
                        <h2 className="flex items-center gap-2 text-lg font-bold text-gray-900 dark:text-white">
                            <FontFreeIcon name="payments" size={20} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                            비용 확인
                        </h2>
                        <div className="rounded-2xl border border-brand-orange-200 bg-orange-50 p-5 dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10">
                            <h3 className="text-xl font-black text-gray-950 dark:text-white">체험수업비 입금 안내</h3>
                            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">입금 확인 후 체험수업 일정 안내가 진행됩니다.</p>
                            <div className="mt-4 grid gap-3 rounded-xl bg-white p-4 text-sm dark:bg-gray-900">
                                <InfoRow label="금액" value={TRIAL_FEE_PAYMENT_INFO.amountLabel} />
                                <InfoRow label="은행" value={TRIAL_FEE_PAYMENT_INFO.bankName} />
                                <InfoRow label="계좌" value={TRIAL_FEE_PAYMENT_INFO.accountNumber} />
                                <InfoRow label="예금주" value={TRIAL_FEE_PAYMENT_INFO.accountHolder} />
                            </div>
                            <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                <button type="button" onClick={copyTrialFeeAccount} className="rounded-xl border border-brand-orange-200 bg-white px-4 py-3 text-sm font-bold text-brand-orange-600 hover:bg-orange-50 dark:border-brand-neon-lime/40 dark:bg-gray-950 dark:text-brand-neon-lime">
                                    계좌번호 복사하기
                                </button>
                                <button type="button" onClick={handleTrialFeeTransfer} className="rounded-xl bg-brand-orange-500 px-4 py-3 text-sm font-bold text-white hover:bg-brand-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900">
                                    입금 정보 공유하기
                                </button>
                            </div>
                            {paymentNotice && <p className="mt-3 text-xs font-semibold text-brand-orange-600 dark:text-brand-neon-lime">{paymentNotice}</p>}
                        </div>
                        <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                            <input type="checkbox" checked={form.trialFeeNoticeAgreed} onChange={(event) => update("trialFeeNoticeAgreed", event.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-brand-orange-500 focus:ring-brand-orange-500 dark:text-brand-neon-lime" />
                            <span>체험수업 비용과 입금 계좌를 확인했습니다.</span>
                        </label>
                        <input type="text" value={form.honeypot} onChange={(event) => update("honeypot", event.target.value)} className="hidden" tabIndex={-1} autoComplete="off" />
                    </div>
                )}

                <div className="mt-8 flex justify-between">
                    {step > 1 ? (
                        <button type="button" onClick={goBack} className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-5 py-3 font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200">
                            <FontFreeIcon name="arrow_back" size={18} />
                            이전
                        </button>
                    ) : <div />}

                    {step < 3 ? (
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
                                    체험수업 신청하기
                                </>
                            )}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function Field({ label, required, type = "text", min, value, onChange, placeholder }: { label: string; required?: boolean; type?: string; min?: string; value: string; onChange: (value: string) => void; placeholder: string }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <input type={type} min={min} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white" />
        </div>
    );
}

function ButtonGroup({ label, required, options, value, onChange }: { label: string; required?: boolean; options: string[]; value: string; onChange: (value: string) => void }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {options.map((option) => (
                    <button key={option} type="button" onClick={() => onChange(option)} className={`rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${value === option ? "border-brand-orange-500 bg-brand-orange-50 text-brand-orange-600 dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "border-gray-300 text-gray-600 hover:border-gray-400 dark:text-gray-300"}`}>
                        {option}
                    </button>
                ))}
            </div>
        </div>
    );
}

function SelectField({ label, required, value, onChange, options, valueMap }: { label: string; required?: boolean; value: string; onChange: (value: string) => void; options: string[]; valueMap?: { value: string; label: string }[] }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-200">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-gray-900 outline-none transition-colors focus:border-brand-orange-500 focus:ring-2 focus:ring-brand-orange-500 dark:border-gray-600 dark:bg-gray-800 dark:text-white">
                <option value="">선택해주세요</option>
                {valueMap
                    ? valueMap.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)
                    : options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
        </div>
    );
}

function InfoRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between gap-4">
            <span className="text-gray-500 dark:text-gray-400">{label}</span>
            <span className="font-bold text-gray-900 dark:text-white">{value}</span>
        </div>
    );
}

function formatPhone(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}
