"use client";

/**
 * 관리자 «원생 등록» 창 — 창 하나 3단계(모바일은 아래에서 올라오는 시트). 2026-11-09 원장 승인 설계.
 *
 * ① 학생·보호자 → ② 수업·셔틀 → ③ 확인(사진 동의·메모·개인정보 동의 + 요약) → «등록» 한 번.
 * 2026-11-09 실사용 후 원장 지시: 반 줄에 대상 학년 · 셔틀 장소명 필수 · 유니폼은 주문 내역으로 자동(선택칸 없음) ·
 * 사진 동의는 체크박스 하나(확인 방법 = 대면 기본값).
 * 저장은 서버 액션 registerStudent 하나(트랜잭션 하나)라 중간에 실패하면 아무것도 남지 않는다.
 * 목록 «원생 등록»과 체험 «원생 등록»(체험 정보를 미리 채움)이 같은 창을 쓴다.
 *
 * 화면 규칙: 색은 학원 토큰(var(--color-academy-*)), 아이콘은 Material Symbols, 터치 44px·글자 12px 이상.
 */

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import AdminModal from "@/components/admin/AdminModal";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import type { MapLocationData } from "@/components/maps/LocationPickerModal";
import {
    getStudentRegisterOptions,
    previewStudentRegistration,
    registerStudent,
    type RegisterClassOption,
    type StudentRegisterOptions,
    type StudentRegisterPreview,
} from "@/app/actions/student-register";
import {
    branchFromClassLocations,
    branchLabel,
    GUARDIAN_RELATION_CHOICES,
    REFERRAL_SOURCE_OPTIONS,
    REGISTER_BRANCH_OPTIONS,
    REGISTER_MEDIA_CONSENT_METHOD,
    SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE,
    validateRegisterStep1,
    type DuplicateSuspect,
} from "@/lib/students/student-register-rules";
import { previewRegularTuition } from "@/lib/billing/regular-tuition-preview";
import { formatGuardianPhone, MAX_GUARDIANS_PER_STUDENT, normalizeGuardianPhone } from "@/lib/guardians/guardianLogic";
import { isUsablePhoneKey } from "@/lib/enrollment/parentIdentity";
import type { OverCapacityClass } from "@/lib/enrollment/class-capacity";

// 지도 창은 무거워서(카카오 지도) 셔틀 위치를 고를 때만 불러온다
const LocationPickerModal = dynamic(() => import("@/components/maps/LocationPickerModal"), { ssr: false, loading: () => null });

/** 체험 → 원생 전환 때 미리 채울 값 */
export type StudentRegisterPrefill = {
    trialLeadId?: string | null;
    name?: string | null;
    birthDate?: string | null;
    gender?: string | null;
    grade?: string | null;
    school?: string | null;
    parentName?: string | null;
    parentPhone?: string | null;
    memo?: string | null;
    referralSource?: string | null;
};

/** 등록이 끝난 뒤 부르는 쪽(목록·체험)에 알려 주는 값 */
export type StudentRegistered = {
    studentId: string;
    name: string;
    classCount: number;
    parentAccountCreated: boolean;
    staffAccount: boolean;
};

const DAY_KEYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const DAY_LABELS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };
const STEP_LABELS = ["학생·보호자", "수업·셔틀", "확인"] as const;

// 2026-11-13 UI 통일 2단계: 입력칸·버튼은 테마 공용 클래스(academy-theme.css)를 쓴다
const INPUT = "academy-input min-w-0";
const LABEL = "mb-1 block text-xs font-medium text-[var(--color-academy-muted)]";
const BTN_SECONDARY = "academy-button-secondary";
const BTN_PRIMARY = "academy-button-primary";

type GuardianRow = { relation: string; name: string; phone: string };

/** 생년월일 숫자 입력 → 2016-03-15 형식(목록 폼에서 쓰던 자동 하이픈과 같음) */
function formatBirthInput(raw: string): string {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    return [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6, 8)].filter(Boolean).join("-");
}

/** 휴대폰 숫자 입력 → 010-1234-5678 */
function formatPhoneTyping(raw: string): string {
    const nums = raw.replace(/\D/g, "").slice(0, 11);
    if (nums.length > 7) return `${nums.slice(0, 3)}-${nums.slice(3, 7)}-${nums.slice(7)}`;
    if (nums.length > 3) return `${nums.slice(0, 3)}-${nums.slice(3)}`;
    return nums;
}

function won(amount: number): string {
    return `${amount.toLocaleString()}원`;
}

function classTimeLabel(c: Pick<RegisterClassOption, "dayOfWeek" | "startTime" | "endTime">): string {
    return `${DAY_LABELS[c.dayOfWeek] ?? c.dayOfWeek} ${c.startTime}${c.endTime ? `~${c.endTime}` : ""}`;
}

function duplicateReason(d: DuplicateSuspect): string {
    return d.reason === "SAME_BIRTH" ? "이름·생년월일 같음" : "이름·보호자 번호 같음";
}

export default function StudentRegisterModal({
    prefill,
    onClose,
    onRegistered,
    onOpenStudent,
}: {
    prefill?: StudentRegisterPrefill;
    onClose: () => void;
    onRegistered: (result: StudentRegistered) => void;
    /** 중복 의심 학생 «그 학생 열기» — 없으면 상세 화면으로 이동 */
    onOpenStudent?: (studentId: string) => void;
}) {
    const [step, setStep] = useState<1 | 2 | 3>(1);
    const [options, setOptions] = useState<StudentRegisterOptions | null>(null);
    const [optionsError, setOptionsError] = useState<string | null>(null);

    // ① 학생·보호자
    const [name, setName] = useState(prefill?.name ?? "");
    const [birthDate, setBirthDate] = useState(prefill?.birthDate ?? "");
    const [gender, setGender] = useState(prefill?.gender ?? "");
    const [grade, setGrade] = useState(prefill?.grade ?? "");
    const [school, setSchool] = useState(prefill?.school ?? "");
    const [showMore, setShowMore] = useState(false);
    const [studentPhone, setStudentPhone] = useState("");
    const [address, setAddress] = useState("");
    const [referralSource, setReferralSource] = useState(prefill?.referralSource ?? (prefill?.trialLeadId ? "체험수업" : ""));
    const [guardians, setGuardians] = useState<GuardianRow[]>([
        { relation: "", name: prefill?.parentName ?? "", phone: prefill?.parentPhone ? formatPhoneTyping(prefill.parentPhone) : "" },
    ]);
    const [preview, setPreview] = useState<StudentRegisterPreview | null>(null);
    const [duplicateAck, setDuplicateAck] = useState(false);

    // ② 수업·셔틀
    const [dayTab, setDayTab] = useState<string>("Mon");
    const [classIds, setClassIds] = useState<string[]>([]);
    const [assignLater, setAssignLater] = useState(false);
    const [startOn, setStartOn] = useState("");
    const [manualBranch, setManualBranch] = useState("");
    const [shuttleNeeded, setShuttleNeeded] = useState(false);
    const [pickup, setPickup] = useState<MapLocationData | null>(null);
    const [dropoff, setDropoff] = useState<MapLocationData | null>(null);
    const [pickerKind, setPickerKind] = useState<"PICKUP" | "DROPOFF" | null>(null);

    // ③ 확인 — 유니폼은 고르지 않는다(서버가 주문 내역으로 채움). 사진 동의는 체크박스 하나 + 범위 3칸
    const [mediaChecked, setMediaChecked] = useState(false);
    const [mediaInternal, setMediaInternal] = useState(false);
    const [mediaGallery, setMediaGallery] = useState(false);
    const [mediaInstagram, setMediaInstagram] = useState(false);
    const [memo, setMemo] = useState(prefill?.memo ?? "");
    const [privacyConfirmed, setPrivacyConfirmed] = useState(false);

    // 저장
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [capacityWarning, setCapacityWarning] = useState<OverCapacityClass[] | null>(null);

    // 반·프로그램·오늘 날짜를 한 번 읽는다(수강 시작일 기본값 = 오늘 KST)
    useEffect(() => {
        let alive = true;
        getStudentRegisterOptions()
            .then((data) => {
                if (!alive) return;
                setOptions(data);
                setStartOn((current) => current || data.today);
                // 반이 있는 첫 요일을 기본 탭으로
                const firstDay = DAY_KEYS.find((d) => data.classes.some((c) => c.dayOfWeek === d));
                if (firstDay) setDayTab(firstDay);
            })
            .catch((err: unknown) => {
                if (alive) setOptionsError(adminErrorText(err, "반 목록을 불러오지 못했습니다. 창을 닫고 다시 열어 주세요."));
            });
        return () => { alive = false; };
    }, []);

    // 주 보호자 번호·이름·생년이 바뀌면 «어느 계정에 붙는지·이미 있는 학생인지»를 다시 본다(0.4초 쉬었다가)
    const primaryDigits = normalizeGuardianPhone(guardians[0]?.phone);
    const extraPhones = guardians.slice(1).map((g) => normalizeGuardianPhone(g.phone)).filter(Boolean).join(",");
    useEffect(() => {
        const trimmed = name.trim();
        if (!trimmed && !isUsablePhoneKey(primaryDigits)) { setPreview(null); return; }
        const timer = window.setTimeout(() => {
            previewStudentRegistration({
                name: trimmed,
                birthDate,
                primaryPhone: primaryDigits,
                guardianPhones: extraPhones ? extraPhones.split(",") : [],
            }).then(setPreview).catch(() => setPreview(null));
        }, 400);
        return () => window.clearTimeout(timer);
    }, [name, birthDate, primaryDigits, extraPhones]);
    // 입력이 바뀌면 «새로 등록 계속» 확인은 다시 받는다
    useEffect(() => { setDuplicateAck(false); }, [name, birthDate, primaryDigits]);

    const classesById = useMemo(() => new Map((options?.classes ?? []).map((c) => [c.id, c])), [options]);
    const selectedClasses = classIds.map((id) => classesById.get(id)).filter((c): c is RegisterClassOption => Boolean(c));
    const dayClasses = (options?.classes ?? []).filter((c) => c.dayOfWeek === dayTab);
    const autoBranch = branchFromClassLocations(selectedClasses.map((c) => c.location));
    const tuition = useMemo(
        // 청구 제안값과 같은 계산(청구 모듈 함수 호출) — 반 요일·슬롯을 넘겨 주말·대표팀 면제도 같게
        () => previewRegularTuition(
            options?.programs ?? [],
            selectedClasses.map((c) => ({ id: c.id, programId: c.programId, dayOfWeek: c.dayOfWeek, slotKey: c.slotKey })),
            shuttleNeeded,
        ),
        [options, selectedClasses, shuttleNeeded],
    );
    const duplicates = preview?.duplicates ?? [];

    function updateGuardian(index: number, patch: Partial<GuardianRow>) {
        setGuardians((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    }

    function toggleClass(id: string) {
        setAssignLater(false);
        setClassIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
    }

    function goNext() {
        setError(null);
        if (step === 1) {
            const checked = validateRegisterStep1({
                student: { name, birthDate, gender: gender || null },
                guardians,
            }, options?.today ?? "2100-12-31");
            if (!checked.ok) { setError(checked.error); return; }
            if (duplicates.length > 0 && !duplicateAck) {
                setError("이미 있는 학생일 수 있어요. 아래에서 그 학생을 열거나 «새로 등록 계속»을 눌러 주세요.");
                return;
            }
            setStep(2);
            return;
        }
        if (step === 2) {
            if (!assignLater && classIds.length === 0) { setError("수강할 반을 고르거나 «반은 나중에 배정»을 체크해 주세요."); return; }
            if (!startOn) { setError("수강 시작일을 입력해 주세요."); return; }
            // 셔틀 위치는 장소명 필수(지도 창이 이미 막지만, 서버와 같은 기준으로 한 번 더)
            if (shuttleNeeded && [pickup, dropoff].some((l) => l && !l.placeName?.trim())) {
                setError(SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE);
                return;
            }
            setStep(3);
        }
    }

    async function submit(force = false) {
        if (!privacyConfirmed) { setError("보호자 개인정보 수집·이용 동의를 받았는지 확인해 주세요."); return; }
        setSaving(true);
        setError(null);
        try {
            const result = await registerStudent({
                trialLeadId: prefill?.trialLeadId ?? null,
                student: {
                    name, birthDate, gender: gender || null, grade, school,
                    phone: studentPhone, address, referralSource: referralSource || null,
                },
                guardians,
                classIds: assignLater ? [] : classIds,
                assignLater,
                // 반 장소로 지점을 알 수 있으면 서버가 그 값을 쓴다 — 모를 때만 직접 고른 값
                branch: autoBranch ? null : manualBranch || null,
                startOn,
                shuttle: {
                    needed: shuttleNeeded,
                    pickup: shuttleNeeded ? pickup : null,
                    dropoff: shuttleNeeded ? dropoff : null,
                },
                // 체크했을 때만 동의 기록 — 확인 방법은 기본값(대면). 범위 3칸·정책 버전 저장 구조는 그대로
                mediaConsent: mediaChecked
                    ? { internalAllowed: mediaInternal, galleryAllowed: mediaGallery, instagramAllowed: mediaInstagram, method: REGISTER_MEDIA_CONSENT_METHOD }
                    : null,
                memo,
                privacyConfirmed,
                force,
                // 1단계에서 «새로 등록 계속»을 눌렀으면 서버 중복 확인도 넘긴다
                allowDuplicate: duplicateAck,
            });
            if (result.ok) {
                onRegistered({
                    studentId: result.studentId,
                    name: name.trim(),
                    classCount: result.classCount,
                    parentAccountCreated: result.parentAccountCreated,
                    staffAccount: result.staffAccount,
                });
                return;
            }
            if (result.code === "CAPACITY_WARNING") {
                setCapacityWarning(result.classes);
                return;
            }
            if (result.code === "DUPLICATE_SUSPECT") {
                // 그 사이 다른 화면에서 같은 학생이 등록됐을 수 있다 → 1단계로 돌아가 확인받는다
                setPreview((current) => ({ account: current?.account ?? { kind: "NO_PHONE" }, duplicates: result.duplicates, uniform: current?.uniform ?? null }));
                setDuplicateAck(false);
                setStep(1);
                setError(result.error);
                return;
            }
            setError(result.error);
            if (result.step) setStep(result.step);
        } catch (err: unknown) {
            setError(adminErrorText(err, "원생을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요."));
        } finally {
            setSaving(false);
        }
    }

    const primary = guardians[0];
    const account = preview?.account;

    return (
        <AdminModal onClose={onClose} titleId="student-register-title" panelClassName="max-w-2xl" closeOnBackdrop={false}>
            {/* 머리: 제목 + 단계(누르면 앞 단계로 돌아간다) */}
            <div className="sticky top-0 z-10 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 pt-3">
                <div className="flex items-center gap-2">
                    <h2 id="student-register-title" className="min-w-0 flex-1 truncate text-base font-bold text-[var(--color-academy-ink)]">
                        {prefill?.trialLeadId ? "체험 → 원생 등록" : "원생 등록"}
                    </h2>
                    <button type="button" onClick={onClose} aria-label="닫기" className="-mr-2 inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                        <span className="material-symbols-outlined" aria-hidden="true">close</span>
                    </button>
                </div>
                <ol className="flex gap-1 pb-2" aria-label="등록 단계">
                    {STEP_LABELS.map((label, index) => {
                        const n = (index + 1) as 1 | 2 | 3;
                        const current = n === step;
                        return (
                            <li key={label} className="min-w-0 flex-1">
                                <button
                                    type="button"
                                    disabled={n >= step}
                                    onClick={() => { setError(null); setStep(n); }}
                                    aria-current={current ? "step" : undefined}
                                    className={`flex min-h-11 w-full items-center justify-center gap-1 rounded-lg px-1 text-xs font-medium ${current
                                        ? "bg-[var(--color-academy-secondary-soft)] font-semibold text-[var(--color-academy-secondary-ink)]"
                                        : n < step ? "text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]" : "text-[var(--color-academy-muted)]"}`}
                                >
                                    <span className="tabular-nums">{n}</span>
                                    <span className="truncate">{label}</span>
                                </button>
                            </li>
                        );
                    })}
                </ol>
            </div>

            <div className="space-y-3 px-4 py-3">
                {optionsError && <p role="alert" className="rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">{optionsError}</p>}

                {step === 1 && (
                    <>
                        {/* 학생 — PC 3열 · 모바일 2열 */}
                        <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3">
                            <label className="col-span-2 block min-w-0 sm:col-span-1">
                                <span className={LABEL}>학생 이름 *</span>
                                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="홍길동" className={INPUT} data-admin-modal-initial-focus />
                            </label>
                            <label className="block min-w-0">
                                <span className={LABEL}>생년월일 *</span>
                                <input value={birthDate} onChange={(e) => setBirthDate(formatBirthInput(e.target.value))} inputMode="numeric" maxLength={10} placeholder="2016-03-15" className={INPUT} />
                            </label>
                            <label className="block min-w-0">
                                <span className={LABEL}>성별</span>
                                <select value={gender} onChange={(e) => setGender(e.target.value)} className={INPUT}>
                                    <option value="">선택 안함</option>
                                    <option value="남">남</option>
                                    <option value="여">여</option>
                                </select>
                            </label>
                            <label className="block min-w-0">
                                <span className={LABEL}>학년</span>
                                <input value={grade} onChange={(e) => setGrade(e.target.value)} placeholder="예: 초3" className={INPUT} />
                            </label>
                            <label className="block min-w-0 sm:col-span-2">
                                <span className={LABEL}>학교</span>
                                <input value={school} onChange={(e) => setSchool(e.target.value)} placeholder="예: 다산초" className={INPUT} />
                            </label>
                        </div>
                        <button type="button" onClick={() => setShowMore((v) => !v)} aria-expanded={showMore} className="academy-button-text">
                            <span className="material-symbols-outlined text-lg" aria-hidden="true">{showMore ? "expand_less" : "expand_more"}</span>
                            더 입력(학생 휴대폰·주소·가입 경로)
                        </button>
                        {showMore && (
                            <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-3">
                                <label className="block min-w-0">
                                    <span className={LABEL}>학생 휴대폰</span>
                                    <input value={studentPhone} onChange={(e) => setStudentPhone(formatPhoneTyping(e.target.value))} type="tel" inputMode="tel" placeholder="010-0000-0000" className={INPUT} />
                                </label>
                                <label className="block min-w-0">
                                    <span className={LABEL}>가입 경로</span>
                                    <select value={referralSource} onChange={(e) => setReferralSource(e.target.value)} className={INPUT}>
                                        <option value="">선택 안함</option>
                                        {REFERRAL_SOURCE_OPTIONS.map((o) => <option key={o} value={o}>{o}</option>)}
                                    </select>
                                </label>
                                <label className="block min-w-0 sm:col-span-3">
                                    <span className={LABEL}>주소</span>
                                    <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="도로명 주소" className={INPUT} />
                                </label>
                            </div>
                        )}

                        {/* 보호자 — 한 줄에 관계·이름·휴대폰(모바일은 관계+이름 / 휴대폰 두 줄) */}
                        <div className="border-t border-[var(--color-academy-line)] pt-2">
                            <p className={LABEL}>보호자 (첫 줄 = 주 보호자 · 관계·이름·휴대폰 필수)</p>
                            <div className="space-y-2">
                                {guardians.map((g, index) => (
                                    <div key={index} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 sm:grid-cols-[7rem_minmax(0,1fr)_minmax(0,1fr)_3.5rem]">
                                        <select aria-label={`보호자 ${index + 1} 관계`} value={g.relation} onChange={(e) => updateGuardian(index, { relation: e.target.value })} className={INPUT}>
                                            <option value="">관계{index === 0 ? " *" : ""}</option>
                                            {GUARDIAN_RELATION_CHOICES.map((r) => <option key={r} value={r}>{r}</option>)}
                                        </select>
                                        <input aria-label={`보호자 ${index + 1} 이름`} value={g.name} onChange={(e) => updateGuardian(index, { name: e.target.value })} placeholder={index === 0 ? "주 보호자 이름 *" : "이름"} className={INPUT} />
                                        <input aria-label={`보호자 ${index + 1} 휴대폰`} value={g.phone} onChange={(e) => updateGuardian(index, { phone: formatPhoneTyping(e.target.value) })} type="tel" inputMode="tel" placeholder={index === 0 ? "휴대폰 * 010-0000-0000" : "휴대폰"} className={`${INPUT} col-span-2 sm:col-span-1`} />
                                        {index === 0 ? (
                                            <span className="hidden items-center justify-center text-xs font-medium text-[var(--color-academy-ink)] sm:inline-flex">주</span>
                                        ) : (
                                            <button type="button" onClick={() => setGuardians((rows) => rows.filter((_, i) => i !== index))} aria-label={`보호자 ${index + 1} 빼기`} className="academy-button-text academy-button-sm col-span-2 sm:col-span-1">
                                                빼기
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                            {guardians.length < MAX_GUARDIANS_PER_STUDENT && (
                                <button type="button" onClick={() => setGuardians((rows) => [...rows, { relation: "", name: "", phone: "" }])} className="academy-button-text mt-1">
                                    보호자 추가
                                </button>
                            )}
                            {/* 계정 연결 미리보기 — 저장 때와 같은 판정 */}
                            {account && account.kind !== "NO_PHONE" && (
                                <p className="mt-1 flex items-start gap-1 text-xs text-[var(--color-academy-muted)]" role="status">
                                    <span className="min-w-0 break-keep">
                                        {account.kind === "CREATE_NEW" && "이 번호의 계정이 없어 새 학부모 계정을 만듭니다(학부모가 같은 번호로 가입하면 자동 연결)."}
                                        {account.kind === "AMBIGUOUS" && <strong className="text-[var(--color-academy-danger)]">같은 번호 계정이 {account.accountCount}개라 연결할 수 없습니다. 기존 학생 상세에서 계정을 먼저 정리해 주세요.</strong>}
                                        {account.kind === "USE_EXISTING" && (
                                            <>
                                                {account.staffAccount ? "직원 계정(직원 자녀)에 연결: " : "기존 학부모 계정에 연결: "}
                                                <strong className="text-[var(--color-academy-ink)]">{account.accountName || "이름 없음"}</strong>
                                                {` · 끝번호 ${primaryDigits.slice(-4)} · ${account.loginLinked ? "로그인 연결됨" : "로그인 전"}`}
                                                {account.children.length > 0 ? ` · 다른 자녀 ${account.children.join(", ")}` : " · 다른 자녀 없음"}
                                                {" (계정 이름·번호는 바꾸지 않아요)"}
                                            </>
                                        )}
                                    </span>
                                </p>
                            )}
                        </div>

                        {/* 중복 의심 — 이름+생년, 또는 이름+보호자 번호 */}
                        {duplicates.length > 0 && (
                            <div role="alert" className="rounded-lg border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
                                <p className="font-semibold text-[var(--color-academy-warning)]">이미 있는 학생일 수 있어요</p>
                                <ul className="mt-1 space-y-1">
                                    {duplicates.map((d) => (
                                        <li key={d.id} className="flex flex-wrap items-center gap-x-2">
                                            <span className="min-w-0 break-keep">
                                                <strong>{d.name}</strong> ({d.birthDate || "생년 없음"} · {d.classNames.length ? d.classNames.join(", ") : "수강 반 없음"} · {duplicateReason(d)})
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => (onOpenStudent ? onOpenStudent(d.id) : window.location.assign(`/admin/students/${d.id}`))}
                                                className="academy-button-text"
                                            >
                                                그 학생 열기
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                                <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-2 font-medium">
                                    <input type="checkbox" checked={duplicateAck} onChange={(e) => setDuplicateAck(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]" />
                                    다른 학생이 맞아요 — 새로 등록 계속
                                </label>
                            </div>
                        )}
                    </>
                )}

                {step === 2 && (
                    <>
                        {/* 요일 탭 + 한 줄 행 반 선택. 여러 개 고르면 주 n회 */}
                        <div>
                            <div className="flex items-center justify-between gap-2">
                                <p className={LABEL}>수강 반 * (여러 개 = 주 n회)</p>
                                <span className="text-xs font-medium text-[var(--color-academy-ink)]">{classIds.length > 0 ? `주 ${classIds.length}회 선택` : ""}</span>
                            </div>
                            <div role="tablist" aria-label="요일" className="flex gap-1 overflow-x-auto pb-1">
                                {DAY_KEYS.map((day) => {
                                    const count = (options?.classes ?? []).filter((c) => c.dayOfWeek === day).length;
                                    const picked = selectedClasses.filter((c) => c.dayOfWeek === day).length;
                                    if (count === 0) return null;
                                    return (
                                        <button
                                            key={day}
                                            type="button"
                                            role="tab"
                                            aria-selected={dayTab === day}
                                            onClick={() => setDayTab(day)}
                                            className={`academy-choice is-tab min-w-11 shrink-0 ${dayTab === day ? "is-selected" : ""}`}
                                        >
                                            {DAY_LABELS[day]}
                                            {picked > 0 && <span className="tabular-nums">·{picked}</span>}
                                        </button>
                                    );
                                })}
                            </div>
                            {!options && !optionsError && <p className="py-3 text-sm text-[var(--color-academy-muted)]">반 목록을 불러오는 중…</p>}
                            <ul className="divide-y divide-[var(--color-academy-line)] rounded-lg border border-[var(--color-academy-line)]">
                                {dayClasses.map((c) => {
                                    const checked = classIds.includes(c.id);
                                    const full = c.activeCount >= c.capacity;
                                    return (
                                        <li key={c.id}>
                                            <label className={`flex min-h-11 cursor-pointer items-center gap-2 px-3 py-1.5 text-sm ${checked ? "bg-[var(--color-academy-secondary-soft)]" : "hover:bg-[var(--color-academy-soft)]"}`}>
                                                <input type="checkbox" checked={checked} onChange={() => toggleClass(c.id)} className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]" />
                                                <span className="min-w-0 flex-1 truncate font-medium text-[var(--color-academy-ink)]">{c.name}</span>
                                                {/* 대상 학년(예: 초3~초6) — 반 고를 때 가장 먼저 보는 값이라 모바일에서도 보인다 */}
                                                {c.gradeRange && (
                                                    <span className="max-w-[6.5rem] shrink-0 truncate text-xs text-[var(--color-academy-ink)]" title={`대상 ${c.gradeRange}`}>
                                                        {c.gradeRange}
                                                    </span>
                                                )}
                                                <span className="hidden shrink-0 text-xs text-[var(--color-academy-muted)] sm:inline">{c.startTime}~{c.endTime}</span>
                                                {c.location && <span className="hidden max-w-[8rem] shrink-0 truncate text-xs text-[var(--color-academy-muted)] md:inline">{c.location}</span>}
                                                <span className={`shrink-0 text-xs tabular-nums ${full ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`}>
                                                    {c.activeCount}/{c.capacity}{full ? " 정원" : ""}
                                                </span>
                                            </label>
                                        </li>
                                    );
                                })}
                                {options && dayClasses.length === 0 && <li className="px-3 py-2 text-sm text-[var(--color-academy-muted)]">이 요일에는 반이 없습니다.</li>}
                            </ul>
                            {selectedClasses.length > 0 && (
                                <p className="mt-1 text-xs text-[var(--color-academy-ink)]">
                                    선택: {selectedClasses.map((c) => `${c.name}(${classTimeLabel(c)})`).join(", ")}
                                </p>
                            )}
                            <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-academy-ink)]">
                                <input
                                    type="checkbox"
                                    checked={assignLater}
                                    onChange={(e) => { setAssignLater(e.target.checked); if (e.target.checked) setClassIds([]); }}
                                    className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]"
                                />
                                반은 나중에 배정 <span className="text-xs text-[var(--color-academy-muted)]">(목록에 «미배정»으로 보여요)</span>
                            </label>
                        </div>

                        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                            <label className="block min-w-0">
                                <span className={LABEL}>수강 시작일 *</span>
                                <input type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} className={INPUT} />
                            </label>
                            <div className="min-w-0">
                                <span className={LABEL}>지점</span>
                                {autoBranch ? (
                                    <p className="flex min-h-11 items-center text-sm font-medium text-[var(--color-academy-ink)]">
                                        {branchLabel(autoBranch)} <span className="ml-1 text-xs font-normal text-[var(--color-academy-muted)]">반에서 자동</span>
                                    </p>
                                ) : (
                                    <select aria-label="지점" value={manualBranch} onChange={(e) => setManualBranch(e.target.value)} className={INPUT}>
                                        <option value="">선택 안함</option>
                                        {REGISTER_BRANCH_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                    </select>
                                )}
                            </div>
                        </div>

                        {/* 수강료 미리보기 한 줄 — 표시만, 청구는 월 장부에서 */}
                        {tuition.lines.length > 0 && (
                            <p className="rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
                                {tuition.lines.map((l) => `${l.programName} 주${l.weeklyCount}회 · 월 ${won(l.tuition)}`).join(" + ")}
                                {shuttleNeeded && tuition.shuttleFee > 0 ? ` (+셔틀 ${won(tuition.shuttleFee)})` : ""}
                                <span className="ml-1 text-xs text-[var(--color-academy-muted)]">청구 자동 제안과 같은 참고 금액 · 청구는 월 장부에서</span>
                                {/* 청구 화면과 같은 경고(주N회 요금 빈 칸·여러 프로그램·셔틀 운행 반 없음) */}
                                {[...new Set([...tuition.lines.map((l) => l.warning), tuition.shuttleWarning].filter(Boolean))].map((w) => (
                                    <span key={w} className="mt-1 block text-xs text-[var(--color-academy-warning)]">{w}</span>
                                ))}
                            </p>
                        )}

                        {/* 셔틀(선택) — 위치만 받는다. 노선 배정은 셔틀 화면 몫 */}
                        <div className="border-t border-[var(--color-academy-line)] pt-2">
                            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-[var(--color-academy-ink)]">
                                <input type="checkbox" checked={shuttleNeeded} onChange={(e) => setShuttleNeeded(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]" />
                                셔틀 이용
                            </label>
                            {shuttleNeeded && (
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                    {(["PICKUP", "DROPOFF"] as const).map((kind) => {
                                        const value = kind === "PICKUP" ? pickup : dropoff;
                                        return (
                                            <button key={kind} type="button" onClick={() => setPickerKind(kind)} className={BTN_SECONDARY}>
                                                <span className="min-w-0 flex-1 truncate text-left">
                                                    {/* 장소명은 지도 창에서 필수로 받는다 */}
                                                    {kind === "PICKUP" ? "탑승" : "하차"}: {value ? (value.placeName || value.roadAddress || value.address) : "지도에서 고르기(선택)"}
                                                </span>
                                            </button>
                                        );
                                    })}
                                    <p className="text-xs text-[var(--color-academy-muted)] sm:col-span-2">노선 배정은 등록 뒤 셔틀 화면에서 해 주세요. 위치는 나중에 학생 상세에서 넣어도 돼요.</p>
                                </div>
                            )}
                        </div>
                    </>
                )}

                {step === 3 && (
                    <>
                        {/* 사진 동의 — 체크하면 기록(범위 3칸은 기본 모두 켬, 필요하면 끔), 안 하면 기록 안 함 */}
                        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-[var(--color-academy-ink)]">
                            <input
                                type="checkbox"
                                checked={mediaChecked}
                                onChange={(e) => {
                                    const on = e.target.checked;
                                    setMediaChecked(on);
                                    // 켜면 내부 보관·갤러리만 켠다. 인스타그램(외부 공개)은 따로 확인받고 직접 켠다(옵트인). 끄면 범위도 비운다
                                    setMediaInternal(on); setMediaGallery(on); setMediaInstagram(false);
                                }}
                                className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]"
                            />
                            사진·영상 활용 동의를 받았어요
                        </label>
                        {mediaChecked && (
                            <fieldset className="-mt-2 flex flex-wrap gap-x-4 pl-7">
                                <legend className="sr-only">사진 사용 동의 범위</legend>
                                {([
                                    // 범위를 모두 끄면 «동의 받음» 체크도 함께 끈다(빈 동의 기록을 남기지 않게)
                                    ["내부 보관", mediaInternal, (v: boolean) => { setMediaInternal(v); if (!v) { setMediaGallery(false); setMediaInstagram(false); setMediaChecked(false); } }],
                                    ["갤러리", mediaGallery, (v: boolean) => { setMediaGallery(v); if (v) setMediaInternal(true); else setMediaInstagram(false); }],
                                    ["인스타그램", mediaInstagram, (v: boolean) => { setMediaInstagram(v); if (v) { setMediaInternal(true); setMediaGallery(true); } }],
                                ] as const).map(([label, checked, set]) => (
                                    <label key={label} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-academy-ink)]">
                                        <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]" />
                                        {label}
                                    </label>
                                ))}
                            </fieldset>
                        )}
                        <label className="block">
                            <span className={LABEL}>메모</span>
                            <textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} className={`${INPUT} resize-none`} />
                        </label>

                        {/* 요약 3줄 */}
                        <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-sm">
                            <dt className="font-medium text-[var(--color-academy-muted)]">학생</dt>
                            <dd className="min-w-0 break-keep text-[var(--color-academy-ink)]">{name.trim()} · {birthDate}{gender ? ` · ${gender}` : ""}{grade ? ` · ${grade}` : ""}{school ? ` · ${school}` : ""}</dd>
                            <dt className="font-medium text-[var(--color-academy-muted)]">보호자</dt>
                            <dd className="min-w-0 break-keep text-[var(--color-academy-ink)]">
                                {primary?.relation} {primary?.name} {formatGuardianPhone(normalizeGuardianPhone(primary?.phone))}
                                {guardians.length > 1 ? ` 외 ${guardians.length - 1}명` : ""}
                                {account?.kind === "USE_EXISTING" ? " · 기존 계정 연결" : account?.kind === "CREATE_NEW" ? " · 새 계정" : ""}
                            </dd>
                            <dt className="font-medium text-[var(--color-academy-muted)]">수업</dt>
                            <dd className="min-w-0 break-keep text-[var(--color-academy-ink)]">
                                {assignLater ? "반 나중에 배정" : `${selectedClasses.map((c) => c.name).join(", ")} (주 ${selectedClasses.length}회)`}
                                {` · ${startOn} 시작`}
                                {tuition.lines.length > 0 ? ` · 월 ${won(tuition.tuitionTotal)}` : ""}
                                {shuttleNeeded ? ` · 셔틀${tuition.shuttleFee ? ` ${won(tuition.shuttleFee)}` : ""}` : ""}
                            </dd>
                            {/* 유니폼 — 같은 보호자 번호·학생 이름의 주문 내역을 보고 서버가 자동으로 채운다(표시만) */}
                            <dt className="font-medium text-[var(--color-academy-muted)]">유니폼</dt>
                            <dd className="min-w-0 break-keep text-[var(--color-academy-ink)]">
                                {!preview
                                    ? "주문 내역 확인 중(등록할 때 다시 확인해요)"
                                    : preview.uniform
                                        ? `주문 내역 있음(${preview.uniform.status}${preview.uniform.orderCount > 1 ? ` · ${preview.uniform.orderCount}건` : ""})`
                                        : "주문 내역 없음"}
                            </dd>
                        </dl>

                        <label className="flex min-h-11 cursor-pointer items-center gap-2 border-t border-[var(--color-academy-line)] pt-2 text-sm text-[var(--color-academy-ink)]">
                            <input type="checkbox" checked={privacyConfirmed} onChange={(e) => setPrivacyConfirmed(e.target.checked)} className="h-5 w-5 shrink-0 accent-[var(--color-academy-primary)]" />
                            <span className="break-keep">
                                보호자에게 <strong>개인정보 수집·이용 동의</strong>를 받았습니다
                                <span className="ml-1 text-[var(--color-academy-warning)]">(필수 · 확인한 날짜가 학생 기록에 남아요)</span>
                            </span>
                        </label>
                    </>
                )}

                {/* 정원 초과 경고 — 재확인하면 그대로 등록 */}
                {capacityWarning && (
                    <div role="alert" className="rounded-lg border border-[var(--color-academy-warning)] bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
                        <p className="font-semibold text-[var(--color-academy-warning)]">정원이 찬 반이 있어요</p>
                        <p className="break-keep">{capacityWarning.map((c) => `${c.name} ${c.current}/${c.capacity}`).join(", ")}</p>
                        <div className="mt-1 flex gap-2">
                            <button type="button" onClick={() => { setCapacityWarning(null); setStep(2); }} className={BTN_SECONDARY}>반 다시 고르기</button>
                            <button type="button" disabled={saving} onClick={() => { setCapacityWarning(null); void submit(true); }} className={BTN_PRIMARY}>그래도 등록</button>
                        </div>
                    </div>
                )}

                {error && <p role="alert" className="rounded-lg bg-[var(--color-academy-warning-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-warning)]">{error}</p>}
            </div>

            {/* 아래 고정 버튼 줄 */}
            <div className="sticky bottom-0 z-10 mt-auto flex gap-2 border-t border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-2">
                {step > 1 ? (
                    <button type="button" onClick={() => { setError(null); setStep((s) => (s > 1 ? ((s - 1) as 1 | 2) : s)); }} className={BTN_SECONDARY}>
                        이전
                    </button>
                ) : (
                    <button type="button" onClick={onClose} className={BTN_SECONDARY}>취소</button>
                )}
                <div className="flex-1" />
                {step < 3 ? (
                    <button type="button" onClick={goNext} className={BTN_PRIMARY}>
                        다음
                    </button>
                ) : (
                    <button type="button" onClick={() => void submit(false)} disabled={saving || !privacyConfirmed} className={BTN_PRIMARY}>
                        {saving ? "등록 중…" : "등록"}
                    </button>
                )}
            </div>

            {pickerKind && (
                <LocationPickerModal
                    title={`셔틀 ${pickerKind === "PICKUP" ? "탑승" : "하차"} 위치`}
                    initialValue={(pickerKind === "PICKUP" ? pickup : dropoff) ?? undefined}
                    requirePlaceName
                    onConfirm={(location) => {
                        if (pickerKind === "PICKUP") setPickup(location);
                        else setDropoff(location);
                        setPickerKind(null);
                    }}
                    onClose={() => setPickerKind(null)}
                />
            )}
        </AdminModal>
    );
}
