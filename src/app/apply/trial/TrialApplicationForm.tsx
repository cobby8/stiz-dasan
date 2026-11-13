"use client";

import { publicErrorText } from "@/components/ui/public-error-text";
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
// 잔여 인원은 숫자 대신 3단계(여유/임박/마감)로만(재원생 수 비공개 · 2026-11-13 f9)
import { SEAT_LEVEL_LABEL, SEAT_LEVEL_TEXT_CLASS } from "@/lib/seats/seatLevel";
import { trialDayForDate, trialScheduleError, trialScheduleForDate, trialSlotPeriod as getSlotPeriod, type TrialScheduleSelection } from "./trialScheduleSelection";
import TrialVisitGuide from "./TrialVisitGuide";

interface Props {
    availableSlots: AvailableSlot[];
    contactPhone: string;
    initialSource: string;
    /** 체험비(설정값)·온라인 결제 가능 여부 — 온라인이면 계좌 안내 대신 신청 직후 결제 링크(2026-11-10) */
    trialFee?: { amount: number; amountLabel: string; onlinePayment: boolean };
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

export default function TrialApplicationForm({ availableSlots, contactPhone, initialSource, trialFee }: Props) {
    // 온라인 결제가 켜져 있으면 계좌 입금 안내 대신 «신청 후 바로 결제». 꺼져 있으면 예전 계좌 안내 그대로.
    const onlinePayment = Boolean(trialFee?.onlinePayment);
    const feeLabel = trialFee?.amountLabel ?? TRIAL_FEE_PAYMENT_INFO.amountLabel;
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
    // 신청 직후 서버가 준 결제 링크 토큰(이 신청에만 묶임). 없으면 계좌 안내로 대체한다.
    // ⚠️ useState 순서: 렌더 테스트가 훅 순서(0=step, 1=form …)로 상태를 흉내 내므로 새 상태는 맨 뒤에 둔다.
    const [paymentToken, setPaymentToken] = useState<string | null>(null);
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
                setPaymentToken((result as { paymentToken?: string | null }).paymentToken ?? null);
                trackMetaEvent("Lead", {
                    content_name: "Trial application",
                    content_category: "Application",
                });
                setCompleted(true);
                window.scrollTo({ top: 0, behavior: "smooth" });
            } catch (e: unknown) {
                console.error("[trial] 신청 실패", e);
                // 서버 원문(영어·개발 용어)은 화면에 내지 않고 쉬운 안내로 바꾼다
                setError(publicErrorText(e, "신청 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."));
            }
        });
    };

    if (completed) {
        return (
            <div className="rounded-2xl bg-white p-8 text-center shadow-lg dark:bg-[var(--color-public-tint)]">
                <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-100">
                    <FontFreeIcon name="check_circle" size={40} className="text-green-600" />
                </div>
                <h2 className="mb-3 text-2xl font-black text-[var(--color-public-ink)] dark:text-white">
                    {completionMode === "updated" ? "체험수업 신청서 수정 완료!" : "체험수업 신청 완료!"}
                </h2>
                <p className="mb-2 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">담당자가 빠른 시간 안에 연락드리겠습니다.</p>
                <p className="mb-6 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
                    문의사항이 있으시면{" "}
                    <a href={`tel:${contactPhone.replace(/-/g, "")}`} className="font-semibold text-[var(--color-public-accent)] dark:text-brand-neon-lime">{contactPhone}</a>
                    로 전화해주세요.
                </p>
                {paymentToken ? (
                    // 온라인 결제: 이 신청에 묶인 결제 링크로 바로 결제 → 결제 확인 = 체험 확정
                    <div className="mb-6 space-y-3 text-left">
                        <a href={`/apply/trial/pay/${encodeURIComponent(paymentToken)}`} className="flex min-h-12 w-full items-center justify-center rounded-xl bg-[var(--color-public-trial)] px-4 text-base font-black text-[var(--color-public-white)] hover:bg-[var(--color-public-trial-hover)]">
                            체험수업비 {feeLabel} 결제하기
                        </a>
                        <p className="text-xs text-[var(--color-public-muted)]">카드·계좌이체·무통장입금으로 결제할 수 있어요. 결제가 확인되면 체험수업이 확정돼요.</p>
                        <TrialVisitGuide feeLabel={feeLabel} onlinePayment />
                    </div>
                ) : (
                <>
                <div className="mb-3 text-left"><TrialVisitGuide feeLabel={feeLabel} onlinePayment={false} /></div>
                <div className="mb-6 rounded-2xl border border-[var(--color-public-line)] bg-orange-50 p-5 text-left dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10">
                    <h3 className="text-xl font-black text-[var(--color-public-ink)] dark:text-white">체험수업비 입금 안내</h3>
                    <p className="mt-1 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">입금 확인 후 체험수업 일정 안내가 진행됩니다.</p>
                    <div className="mt-4 grid gap-3 rounded-xl bg-white p-4 text-sm dark:bg-[var(--color-public-paper)]">
                        <InfoRow label="금액" value={feeLabel} />
                        <InfoRow label="은행" value={TRIAL_FEE_PAYMENT_INFO.bankName} />
                        <InfoRow label="계좌" value={TRIAL_FEE_PAYMENT_INFO.accountNumber} />
                        <InfoRow label="예금주" value={TRIAL_FEE_PAYMENT_INFO.accountHolder} />
                    </div>
                    <div className="mt-4 grid gap-2 sm:grid-cols-2">
                        <button type="button" onClick={copyTrialFeeAccount} className="rounded-xl border border-[var(--color-public-line)] bg-white px-4 py-3 text-sm font-bold text-[var(--color-public-strong)] hover:bg-orange-50 dark:border-brand-neon-lime/40 dark:bg-[var(--color-public-paper)] dark:text-brand-neon-lime">
                            계좌번호 복사하기
                        </button>
                        <button type="button" onClick={handleTrialFeeTransfer} className="rounded-xl bg-[var(--color-public-accent)] px-4 py-3 text-sm font-bold text-white hover:bg-[var(--color-public-strong)] dark:bg-brand-neon-lime dark:text-brand-navy-900">
                            입금 정보 공유하기
                        </button>
                    </div>
                    {paymentNotice && <p className="mt-3 text-xs font-semibold text-[var(--color-public-strong)] dark:text-brand-neon-lime">{paymentNotice}</p>}
                </div>
                </>
                )}
                <Link href="/" className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-public-dark)] px-6 py-3 font-medium text-white transition-colors hover:bg-[var(--color-public-dark)]">
                    <FontFreeIcon name="home" size={18} />
                    홈으로 돌아가기
                </Link>
            </div>
        );
    }

    return (
        <div className="public-form-card public-card min-w-0 overflow-hidden rounded-2xl bg-white shadow-lg dark:bg-[var(--color-public-tint)]">
            <div className="public-stepper border-b border-[var(--color-public-line)] bg-[var(--color-public-tint)] px-4 sm:px-6 py-3 dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)]">
                <div className="mx-auto flex max-w-sm items-center justify-between">
                    {[1, 2, 3].map((number) => (
                        <div key={number} className="flex items-center">
                            <div className={`flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold transition-colors ${number < step ? "bg-green-500 text-white" : number === step ? "bg-[var(--color-public-accent)] text-white dark:bg-brand-neon-lime dark:text-brand-navy-900" : "bg-[var(--color-public-line)] text-[var(--color-public-muted)]"}`}>
                                {number < step ? <FontFreeIcon name="check" size={18} /> : number}
                            </div>
                            <span className={`ml-1.5 hidden text-xs font-medium sm:inline ${number === step ? "text-[var(--color-public-ink)] dark:text-white" : "text-[var(--color-public-muted)]"}`}>
                                {number === 1 ? "체험 일정" : number === 2 ? "신청 정보" : "비용 확인"}
                            </span>
                            {number < 3 && <div className={`mx-1.5 h-0.5 w-8 ${number < step ? "bg-green-500" : "bg-[var(--color-public-line)]"}`} />}
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
                    <div className="mb-4 flex items-center gap-2 rounded-xl border border-[var(--color-public-line)] bg-[var(--color-public-tint)] px-4 py-3 text-sm font-semibold text-[var(--color-public-ink)] dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100">
                        <FontFreeIcon name="edit" size={18} />
                        {existingNotice}
                    </div>
                )}

                {step === 1 && (
                    <div className="space-y-5">
                        <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--color-public-ink)] dark:text-white">
                            <FontFreeIcon name="calendar_today" size={20} className="text-[var(--color-public-accent)] dark:text-brand-neon-lime" />
                            체험 일정
                        </h2>
                        <Field label="체험수업 희망일" required type="date" min={todayKst()} value={form.trialDate} onChange={selectTrialDate} placeholder="연도-월-일" />
                        {dateDay ? <ButtonGroup label="희망 요일" required options={dayOptions} value={form.trialDay} onChange={selectTrialDay} /> : <p className="text-sm text-[var(--color-public-muted)]">날짜를 선택하면 요일이 자동으로 정해집니다.</p>}
                        <div>
                            <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                                희망 교시 <span className="text-red-500">*</span>
                            </label>
                            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                                {periodOptions.map(({ period, slot }) => {
                                    const isFull = slot?.seatLevel === "FULL";
                                    return (
                                        <button key={period} type="button" disabled={isFull} onClick={() => update("trialPeriod", period)} className={`rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${isFull ? "cursor-not-allowed border-[var(--color-public-line)] bg-[var(--color-public-tint)] text-[var(--color-public-dark-muted)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)]" : form.trialPeriod === period ? "border-[var(--color-public-accent)] bg-[var(--color-public-tint)] text-[var(--color-public-strong)] dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "border-gray-300 text-[var(--color-public-muted)] hover:border-gray-400 dark:text-[var(--color-public-muted)]"}`}>
                                            <span className="block">{period}교시</span>
                                            {/* 학부모가 교시 번호만으로는 몇 시 수업인지 몰라 시간도 함께 보여 준다 */}
                                            {slot?.startTime && <span className="mt-0.5 block text-xs font-semibold">{slot.startTime}~{slot.endTime}</span>}
                                            {slot && <span className={`mt-1 block text-xs font-bold ${isFull ? "" : SEAT_LEVEL_TEXT_CLASS[slot.seatLevel]}`}>{SEAT_LEVEL_LABEL[slot.seatLevel]}</span>}
                                        </button>
                                    );
                                })}
                            </div>
                            {dateDay && periodOptions.length === 0 && <p className="mt-2 text-sm text-[var(--color-public-muted)]">{availableSlots.length === 0 ? "시간표 정보를 확인할 수 없습니다. 학원으로 문의해주세요." : "선택한 날짜의 요일에는 등록된 수업이 없습니다. 다른 날짜를 선택해주세요."}</p>}
                        </div>
                    </div>
                )}

                {step === 2 && (
                    <div className="space-y-5">
                        <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--color-public-ink)] dark:text-white">
                            <FontFreeIcon name="child_care" size={20} className="text-[var(--color-public-accent)] dark:text-brand-neon-lime" />
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
                        <h2 className="flex items-center gap-2 text-lg font-bold text-[var(--color-public-ink)] dark:text-white">
                            <FontFreeIcon name="payments" size={20} className="text-[var(--color-public-accent)] dark:text-brand-neon-lime" />
                            비용 확인
                        </h2>
                        {onlinePayment ? (
                            // 온라인 결제: 계좌 대신 «신청 후 바로 결제» 안내만(금액은 설정값)
                            <div className="space-y-3 rounded-2xl border border-[var(--color-public-line)] bg-[var(--color-public-paper)] p-4">
                                <h3 className="text-lg font-black text-[var(--color-public-ink)]">체험수업비 {feeLabel}</h3>
                                <p className="text-sm text-[var(--color-public-muted)]">신청을 마치면 바로 카드·계좌이체·무통장입금으로 결제할 수 있어요. 결제가 확인되면 체험수업이 확정돼요.</p>
                                <TrialVisitGuide feeLabel={feeLabel} onlinePayment />
                            </div>
                        ) : (
                        <div className="rounded-2xl border border-[var(--color-public-line)] bg-orange-50 p-5 dark:border-brand-neon-lime/30 dark:bg-brand-neon-lime/10">
                            <h3 className="text-xl font-black text-[var(--color-public-ink)] dark:text-white">체험수업비 입금 안내</h3>
                            <p className="mt-1 text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">입금 확인 후 체험수업 일정 안내가 진행됩니다.</p>
                            <div className="mt-4 grid gap-3 rounded-xl bg-white p-4 text-sm dark:bg-[var(--color-public-paper)]">
                                <InfoRow label="금액" value={feeLabel} />
                                <InfoRow label="은행" value={TRIAL_FEE_PAYMENT_INFO.bankName} />
                                <InfoRow label="계좌" value={TRIAL_FEE_PAYMENT_INFO.accountNumber} />
                                <InfoRow label="예금주" value={TRIAL_FEE_PAYMENT_INFO.accountHolder} />
                            </div>
                            <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                <button type="button" onClick={copyTrialFeeAccount} className="rounded-xl border border-[var(--color-public-line)] bg-white px-4 py-3 text-sm font-bold text-[var(--color-public-strong)] hover:bg-orange-50 dark:border-brand-neon-lime/40 dark:bg-[var(--color-public-paper)] dark:text-brand-neon-lime">
                                    계좌번호 복사하기
                                </button>
                                <button type="button" onClick={handleTrialFeeTransfer} className="rounded-xl bg-[var(--color-public-accent)] px-4 py-3 text-sm font-bold text-white hover:bg-[var(--color-public-strong)] dark:bg-brand-neon-lime dark:text-brand-navy-900">
                                    입금 정보 공유하기
                                </button>
                            </div>
                            {paymentNotice && <p className="mt-3 text-xs font-semibold text-[var(--color-public-strong)] dark:text-brand-neon-lime">{paymentNotice}</p>}
                        </div>
                        )}
                        <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-[var(--color-public-line)] bg-[var(--color-public-tint)] p-4 text-sm text-[var(--color-public-muted)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-ink)]">
                            <input type="checkbox" checked={form.trialFeeNoticeAgreed} onChange={(event) => update("trialFeeNoticeAgreed", event.target.checked)} className="mt-1 h-4 w-4 rounded border-gray-300 text-[var(--color-public-accent)] focus:ring-[var(--color-public-accent)] dark:text-brand-neon-lime" />
                            <span>{onlinePayment ? `체험수업 비용(${feeLabel})과 결제 안내를 확인했습니다.` : "체험수업 비용과 입금 계좌를 확인했습니다."}</span>
                        </label>
                        <input type="text" value={form.honeypot} onChange={(event) => update("honeypot", event.target.value)} className="hidden" tabIndex={-1} autoComplete="off" />
                    </div>
                )}

                <div className="mt-8 flex justify-between">
                    {step > 1 ? (
                        <button type="button" onClick={goBack} className="inline-flex items-center gap-2 rounded-xl border border-gray-300 px-5 py-3 font-medium text-[var(--color-public-muted)] transition-colors hover:bg-[var(--color-public-tint)] dark:border-[var(--color-public-line)] dark:text-[var(--color-public-ink)]">
                            <FontFreeIcon name="arrow_back" size={18} />
                            이전
                        </button>
                    ) : <div />}

                    {step < 3 ? (
                        <button type="button" onClick={goNext} className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-public-accent)] px-6 py-3 font-bold text-white transition-colors hover:bg-[var(--color-public-strong)] dark:bg-brand-neon-lime dark:text-brand-navy-900">
                            다음
                            <FontFreeIcon name="arrow_forward" size={18} />
                        </button>
                    ) : (
                        <button type="button" onClick={handleSubmit} disabled={isPending} className="inline-flex items-center gap-2 rounded-xl bg-[var(--color-public-accent)] px-6 py-3 font-bold text-white transition-colors hover:bg-[var(--color-public-strong)] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900">
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
            <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <input type={type} min={min} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-[var(--color-public-ink)] outline-none transition-colors focus:border-[var(--color-public-accent)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)] dark:text-white" />
        </div>
    );
}

function ButtonGroup({ label, required, options, value, onChange }: { label: string; required?: boolean; options: string[]; value: string; onChange: (value: string) => void }) {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {options.map((option) => (
                    <button key={option} type="button" onClick={() => onChange(option)} className={`rounded-xl border px-3 py-3 text-sm font-medium transition-colors ${value === option ? "border-[var(--color-public-accent)] bg-[var(--color-public-tint)] text-[var(--color-public-strong)] dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime" : "border-gray-300 text-[var(--color-public-muted)] hover:border-gray-400 dark:text-[var(--color-public-muted)]"}`}>
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
            <label className="mb-2 block text-sm font-medium text-[var(--color-public-muted)] dark:text-[var(--color-public-ink)]">
                {label} {required && <span className="text-red-500">*</span>}
            </label>
            <select value={value} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-gray-300 px-4 py-3 text-[var(--color-public-ink)] outline-none transition-colors focus:border-[var(--color-public-accent)] focus:ring-2 focus:ring-[var(--color-public-accent)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)] dark:text-white">
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
            <span className="text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">{label}</span>
            <span className="font-bold text-[var(--color-public-ink)] dark:text-white">{value}</span>
        </div>
    );
}

function formatPhone(value: string) {
    const digits = value.replace(/\D/g, "").slice(0, 11);
    if (digits.length <= 3) return digits;
    if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}
