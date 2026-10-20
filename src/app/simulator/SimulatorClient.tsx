"use client";

/**
 * SimulatorClient — 우리 아이 수업 찾기 위저드 UI
 *
 * 3단계로 구성:
 * 1단계: 학년 선택 (드롭다운)
 * 2단계: 요일 + 시간대 선택
 * 3단계: 조건에 맞는 수업 결과 카드
 *
 * 모든 필터링은 클라이언트에서 처리한다 (서버 왕복 없이 즉시 반응).
 */

import { useState, useMemo } from "react";
import Image from "next/image";
import Link from "next/link";
import { GRADE_ORDER, type Grade } from "@/lib/googleSheetsSchedule";
import { type MergedSlot } from "@/app/schedule/ScheduleClient";

// --- 타입 정의 ---

type Program = { id: string; name: string };

interface SimulatorClientProps {
    allSlots: MergedSlot[];
    programs: Program[];
    phone: string;
}

// --- 상수 ---

// 요일 선택용 데이터 (월~일)
const DAY_OPTIONS = [
    { key: "Mon", label: "월" },
    { key: "Tue", label: "화" },
    { key: "Wed", label: "수" },
    { key: "Thu", label: "목" },
    { key: "Fri", label: "금" },
    { key: "Sat", label: "토" },
    { key: "Sun", label: "일" },
] as const;

// 시간대 필터 옵션 (시간 범위로 필터링)
const TIME_OPTIONS = [
    { key: "all", label: "전체", startHour: 0, endHour: 24 },
    { key: "morning", label: "오전 (8~12시)", startHour: 8, endHour: 12 },
    { key: "afternoon", label: "오후 (12~18시)", startHour: 12, endHour: 18 },
    { key: "evening", label: "저녁 (18시~)", startHour: 18, endHour: 24 },
] as const;

// --- 학년 매칭 헬퍼 ---

/**
 * gradeRange 문자열("초4~중1")에서 선택한 학년이 범위 안에 포함되는지 판별
 * GRADE_ORDER 인덱스를 비교하여 범위를 체크한다.
 *
 * 예: gradeRange="초4~중1", selectedGrade="초5" → true (초4 <= 초5 <= 중1)
 */
function isGradeInRange(gradeRange: string, selectedGrade: string): boolean {
    if (!gradeRange) return false;

    const selectedIdx = GRADE_ORDER.indexOf(selectedGrade as Grade);
    if (selectedIdx === -1) return false;

    // "초4~중1" 형태를 분리
    const parts = gradeRange.split("~").map((s) => s.trim());

    if (parts.length === 1) {
        // 단일 학년 (예: "초4")
        const idx = GRADE_ORDER.indexOf(parts[0] as Grade);
        return idx === selectedIdx;
    }

    // 범위 (예: "초4~중1")
    const startIdx = GRADE_ORDER.indexOf(parts[0] as Grade);
    const endIdx = GRADE_ORDER.indexOf(parts[1] as Grade);

    if (startIdx === -1 || endIdx === -1) return false;

    // 선택한 학년이 시작~끝 범위 안에 있는지 확인
    const minIdx = Math.min(startIdx, endIdx);
    const maxIdx = Math.max(startIdx, endIdx);
    return selectedIdx >= minIdx && selectedIdx <= maxIdx;
}

/**
 * 시간 문자열("16:00")에서 시(hour)를 추출
 */
function getHourFromTime(timeStr: string): number {
    const [h] = timeStr.split(":").map(Number);
    return h;
}

// --- 메인 컴포넌트 ---

export default function SimulatorClient({ allSlots, programs, phone }: SimulatorClientProps) {
    // 위저드 단계 (1: 학년, 2: 요일/시간, 3: 결과)
    const [step, setStep] = useState(1);

    // 1단계: 선택된 학년
    const [selectedGrade, setSelectedGrade] = useState("");

    // 2단계: 선택된 요일들 (복수 선택 가능)
    const [selectedDays, setSelectedDays] = useState<string[]>([]);

    // 2단계: 선택된 시간대
    const [selectedTime, setSelectedTime] = useState("all");

    // --- 요일 토글 핸들러 ---
    const toggleDay = (dayKey: string) => {
        setSelectedDays((prev) =>
            prev.includes(dayKey)
                ? prev.filter((d) => d !== dayKey) // 이미 선택된 요일 → 해제
                : [...prev, dayKey]                  // 새로 선택 → 추가
        );
    };

    // --- 필터링된 결과 (useMemo로 성능 최적화) ---
    const filteredSlots = useMemo(() => {
        if (!selectedGrade) return [];

        return allSlots
            .filter((slot) => {
                // 1) 학년 매칭: 선택한 학년이 슬롯의 gradeRange 범위에 포함되는가
                if (!isGradeInRange(slot.gradeRange, selectedGrade)) return false;

                // 2) 요일 매칭: 선택한 요일이 없으면 전체, 있으면 해당 요일만
                if (selectedDays.length > 0 && !selectedDays.includes(slot.dayKey)) return false;

                // 3) 시간대 매칭: "전체"가 아니면 시간 범위 필터
                if (selectedTime !== "all") {
                    const timeOpt = TIME_OPTIONS.find((t) => t.key === selectedTime);
                    if (timeOpt) {
                        const hour = getHourFromTime(slot.startTime);
                        if (hour < timeOpt.startHour || hour >= timeOpt.endHour) return false;
                    }
                }

                return true;
            })
            // 요일 순서 → 시간 순서로 정렬
            .sort((a, b) => {
                const dayOrder = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
                const dayDiff = dayOrder.indexOf(a.dayKey) - dayOrder.indexOf(b.dayKey);
                if (dayDiff !== 0) return dayDiff;
                return a.startTime.localeCompare(b.startTime);
            });
    }, [allSlots, selectedGrade, selectedDays, selectedTime]);

    // --- 프로그램 이름 찾기 헬퍼 ---
    const getProgramName = (programId: string | null): string | null => {
        if (!programId) return null;
        return programs.find((p) => p.id === programId)?.name ?? null;
    };

    // --- 단계 이동 핸들러 ---
    const goToStep2 = () => {
        if (selectedGrade) setStep(2);
    };
    const goToStep3 = () => {
        setStep(3);
    };
    const goBack = () => {
        setStep((prev) => Math.max(1, prev - 1));
    };
    const reset = () => {
        setStep(1);
        setSelectedGrade("");
        setSelectedDays([]);
        setSelectedTime("all");
    };

    return (
        <section className="py-8 md:py-12 bg-surface-section dark:bg-gray-900">
            <div className="max-w-2xl mx-auto px-6">

                {/* 단계 표시 바 — 현재 진행 상황을 시각적으로 보여준다 */}
                <div className="flex items-center justify-center gap-2 mb-10">
                    {[1, 2, 3].map((s) => (
                        <div key={s} className="flex items-center gap-2">
                            <div
                                className={[
                                    "w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all duration-300",
                                    step >= s
                                        ? "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white shadow-md"
                                        : "bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-400",
                                ].join(" ")}
                            >
                                {s}
                            </div>
                            {s < 3 && (
                                <div
                                    className={[
                                        "w-12 sm:w-16 h-1 rounded-full transition-all duration-300",
                                        step > s ? "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900" : "bg-gray-200 dark:bg-gray-700",
                                    ].join(" ")}
                                />
                            )}
                        </div>
                    ))}
                </div>

                {/* ===== 1단계: 학년 선택 ===== */}
                {step === 1 && (
                    <div data-tour-target="grade-select" className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm p-6 md:p-8">
                        <h2 className="text-xl md:text-2xl font-black text-gray-900 dark:text-white mb-2 break-keep">
                            아이의 학년을 선택해 주세요
                        </h2>
                        <p className="text-gray-500 dark:text-gray-400 dark:text-gray-400 text-sm mb-6 break-keep">
                            학년에 맞는 수업을 찾아드릴게요.
                        </p>

                        {/* 학년 드롭다운 — GRADE_ORDER 배열을 그대로 사용 */}
                        <select
                            value={selectedGrade}
                            onChange={(e) => setSelectedGrade(e.target.value)}
                            className={[
                                "w-full border rounded-xl px-4 py-3.5 text-base font-medium transition-all",
                                "focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:focus:border-brand-neon-lime",
                                selectedGrade ? "border-brand-orange-300 dark:border-brand-neon-lime bg-brand-orange-50 dark:bg-brand-neon-lime/10 /30" : "border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800",
                            ].join(" ")}
                        >
                            <option value="" className="dark:bg-gray-800">-- 학년을 선택하세요 --</option>
                            {GRADE_ORDER.map((grade) => (
                                <option key={grade} value={grade} className="dark:bg-gray-800">{grade}</option>
                            ))}
                        </select>

                        {/* 다음 버튼 */}
                        <button
                            onClick={goToStep2}
                            disabled={!selectedGrade}
                            className={[
                                "w-full mt-6 py-3.5 rounded-xl font-bold text-base transition-all duration-200",
                                selectedGrade
                                    ? "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-brand-orange-600 dark:hover:bg-lime-400 text-white shadow-md hover:shadow-lg active:scale-[0.98]"
                                    : "bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-400 cursor-not-allowed",
                            ].join(" ")}
                        >
                            다음 단계
                        </button>
                    </div>
                )}

                {/* ===== 2단계: 요일 + 시간대 선택 ===== */}
                {step === 2 && (
                    <div data-tour-target="sim-step2-card" className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm p-6 md:p-8">
                        <h2 className="text-xl md:text-2xl font-black text-gray-900 dark:text-white mb-2 break-keep">
                            원하는 요일과 시간대를 선택해 주세요
                        </h2>
                        <p className="text-gray-500 dark:text-gray-400 dark:text-gray-400 text-sm mb-6 break-keep">
                            선택 안 하면 전체 요일/시간으로 검색합니다.
                        </p>

                        {/* 선택된 학년 표시 */}
                        <div className="mb-6 bg-brand-orange-50 dark:bg-brand-neon-lime/10  border border-brand-orange-100 dark:border-brand-neon-lime/30 rounded-xl px-4 py-3 flex items-center justify-between">
                            <span className="text-sm font-bold text-brand-orange-700 dark:text-brand-neon-lime">
                                선택 학년: {selectedGrade}
                            </span>
                            <button
                                onClick={goBack}
                                className="text-xs text-brand-orange-500 dark:text-brand-neon-lime hover:text-brand-orange-600 dark:text-brand-neon-lime dark:hover:text-lime-400 font-bold"
                            >
                                변경
                            </button>
                        </div>

                        {/* 요일 복수 선택 — 체크박스 스타일의 토글 버튼 */}
                        <div data-tour-target="sim-day-select" className="mb-6">
                            <p className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-3">요일 선택 (복수 가능)</p>
                            <div className="flex flex-wrap gap-2">
                                {DAY_OPTIONS.map(({ key, label }) => (
                                    <button
                                        key={key}
                                        onClick={() => toggleDay(key)}
                                        className={[
                                            "px-4 py-2.5 rounded-xl text-sm font-bold transition-all duration-200 border",
                                            selectedDays.includes(key)
                                                ? "bg-brand-navy-900 text-white border-brand-navy-900 shadow-md"
                                                : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:border-gray-300 hover:bg-gray-50 dark:bg-gray-800",
                                        ].join(" ")}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* 시간대 선택 — 라디오 스타일 버튼 */}
                        <div data-tour-target="sim-time-select" className="mb-6">
                            <p className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-3">시간대 선택</p>
                            <div className="grid grid-cols-2 gap-2">
                                {TIME_OPTIONS.map(({ key, label }) => (
                                    <button
                                        key={key}
                                        onClick={() => setSelectedTime(key)}
                                        className={[
                                            "px-4 py-2.5 rounded-xl text-sm font-bold transition-all duration-200 border",
                                            selectedTime === key
                                                ? "bg-brand-navy-900 text-white border-brand-navy-900 shadow-md"
                                                : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:border-gray-300 hover:bg-gray-50 dark:bg-gray-800",
                                        ].join(" ")}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* 이전/검색 버튼 */}
                        <div className="flex gap-3">
                            <button
                                onClick={goBack}
                                className="flex-1 py-3.5 rounded-xl font-bold text-sm border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:bg-gray-800 transition-all"
                            >
                                이전
                            </button>
                            <button
                                data-tour-target="sim-search-btn"
                                onClick={goToStep3}
                                className="flex-[2] py-3.5 rounded-xl font-bold text-base bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-brand-orange-600 dark:hover:bg-lime-400 text-white shadow-md hover:shadow-lg active:scale-[0.98] transition-all duration-200"
                            >
                                수업 찾기
                            </button>
                        </div>
                    </div>
                )}

                {/* ===== 3단계: 결과 표시 ===== */}
                {step === 3 && (
                    <div data-tour-target="sim-results">
                        {/* 검색 조건 요약 */}
                        <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm p-5 mb-6">
                            <div className="flex items-center justify-between mb-3">
                                <h2 className="text-lg font-black text-gray-900 dark:text-white">검색 결과</h2>
                                <button
                                    onClick={reset}
                                    className="text-sm text-brand-orange-500 dark:text-brand-neon-lime hover:text-brand-orange-600 dark:text-brand-neon-lime dark:hover:text-lime-400 font-bold"
                                >
                                    처음부터
                                </button>
                            </div>
                            <div className="flex flex-wrap gap-2 text-xs">
                                {/* 선택한 조건들을 태그로 표시 */}
                                <span className="bg-brand-orange-50 dark:bg-brand-neon-lime/10  text-brand-orange-700 dark:text-brand-neon-lime px-3 py-1 rounded-full font-bold">
                                    {selectedGrade}
                                </span>
                                {selectedDays.length > 0 ? (
                                    selectedDays.map((dk) => (
                                        <span key={dk} className="bg-brand-navy-50 dark:bg-brand-navy-900/40 text-brand-navy-700 dark:text-brand-neon-lime px-3 py-1 rounded-full font-bold">
                                            {DAY_OPTIONS.find((d) => d.key === dk)?.label}요일
                                        </span>
                                    ))
                                ) : (
                                    <span className="bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 dark:text-gray-400 px-3 py-1 rounded-full font-bold">전체 요일</span>
                                )}
                                {selectedTime !== "all" && (
                                    <span className="bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 px-3 py-1 rounded-full font-bold">
                                        {TIME_OPTIONS.find((t) => t.key === selectedTime)?.label}
                                    </span>
                                )}
                                <span className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-3 py-1 rounded-full font-bold">
                                    {filteredSlots.length}개 수업
                                </span>
                            </div>
                        </div>

                        {/* 결과가 없을 때 안내 메시지 */}
                        {filteredSlots.length === 0 ? (
                            <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm p-8 text-center">
                                <div className="text-5xl mb-4">🏀</div>
                                <p className="text-lg font-bold text-gray-700 dark:text-gray-200 mb-2 break-keep">
                                    해당 조건에 맞는 수업이 없습니다
                                </p>
                                <p className="text-sm text-gray-500 dark:text-gray-400 dark:text-gray-400 mb-6 break-keep">
                                    다른 요일이나 시간대를 선택해 보시거나, 전화로 문의해 주세요.
                                </p>
                                <div className="flex flex-col sm:flex-row gap-3 justify-center">
                                    <button
                                        onClick={() => setStep(2)}
                                        className="px-6 py-3 rounded-xl font-bold text-sm border border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:bg-gray-800 transition-all"
                                    >
                                        조건 변경하기
                                    </button>
                                    <a
                                        href={`tel:${phone.replace(/-/g, "")}`}
                                        className="px-6 py-3 rounded-xl font-bold text-sm bg-brand-navy-900 text-white hover:bg-brand-navy-800 transition-all text-center"
                                    >
                                        전화 문의: {phone}
                                    </a>
                                </div>
                            </div>
                        ) : (
                            <>
                                {/* 결과 카드 목록 */}
                                <div className="space-y-3">
                                    {filteredSlots.map((slot) => {
                                        // 인원 비율 계산 (프로그레스 바용)
                                        const ratio = slot.capacity > 0 ? slot.enrolled / slot.capacity : 0;
                                        const programName = getProgramName(slot.programId);

                                        return (
                                            <div
                                                key={slot.slotKey}
                                                className={[
                                                    "bg-white dark:bg-gray-800 rounded-2xl border shadow-sm p-5 transition-all duration-200 hover:shadow-md",
                                                    slot.isFull
                                                        ? "border-red-100 dark:border-red-900 opacity-60"
                                                        : "border-gray-100 dark:border-gray-700",
                                                ].join(" ")}
                                            >
                                                <div className="flex gap-3">
                                                    {/* 좌측: 수업 정보 */}
                                                    <div className="flex-1 min-w-0">
                                                        {/* 프로그램명 + 요일/시간 */}
                                                        <div className="flex items-start gap-2 mb-2 flex-wrap">
                                                            {programName && (
                                                                <span className="text-xs bg-brand-navy-50 dark:bg-brand-navy-900/40 text-brand-navy-700 dark:text-brand-neon-lime px-2.5 py-0.5 rounded-full font-bold shrink-0">
                                                                    {programName}
                                                                </span>
                                                            )}
                                                            {/* 마감/마감임박/여유 뱃지 */}
                                                            {slot.isFull ? (
                                                                <span className="text-xs bg-red-500 text-white px-2.5 py-0.5 rounded-full font-black shrink-0">
                                                                    마감
                                                                </span>
                                                            ) : ratio >= 0.8 ? (
                                                                <span className="text-xs bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-2.5 py-0.5 rounded-full font-black shrink-0">
                                                                    마감임박
                                                                </span>
                                                            ) : (
                                                                <span className="text-xs bg-green-500 text-white px-2.5 py-0.5 rounded-full font-black shrink-0">
                                                                    여유
                                                                </span>
                                                            )}
                                                        </div>

                                                        <h3 className="font-bold text-gray-900 dark:text-white text-base mb-1.5">
                                                            {slot.displayLabel}
                                                        </h3>

                                                        {/* 시간 */}
                                                        <div className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-200 mb-1">
                                                            <span className="text-gray-400 dark:text-gray-400">&#x23F0;</span>
                                                            <span className="font-semibold">{slot.startTime} ~ {slot.endTime}</span>
                                                        </div>

                                                        {/* 대상 학년 */}
                                                        {slot.gradeRange && (
                                                            <div className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300 mb-1">
                                                                <span className="text-gray-400 dark:text-gray-400">&#x1F393;</span>
                                                                <span>{slot.gradeRange}</span>
                                                            </div>
                                                        )}

                                                        {/* 정원 프로그레스 바 */}
                                                        <div className="mt-2.5 pt-2 border-t border-gray-50 dark:border-gray-700 flex items-center gap-2">
                                                            <span className="text-xs text-gray-500 dark:text-gray-400 dark:text-gray-400 font-medium shrink-0">
                                                                {slot.enrolled}/{slot.capacity}명
                                                            </span>
                                                            <div className="flex-1 h-1.5 rounded-full bg-gray-100 dark:bg-gray-700 overflow-hidden">
                                                                <div
                                                                    className={[
                                                                        "h-full rounded-full transition-all",
                                                                        slot.isFull ? "bg-red-400 dark:bg-red-500" : ratio >= 0.8 ? "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900" : "bg-green-400 dark:bg-brand-neon-lime",
                                                                    ].join(" ")}
                                                                    style={{ width: `${Math.min(100, ratio * 100)}%` }}
                                                                />
                                                            </div>
                                                        </div>

                                                        {/* 메모 */}
                                                        {slot.note && (
                                                            <p className="text-sm text-brand-orange-600 dark:text-brand-neon-lime mt-2 font-medium">
                                                                &#x1F4CC; {slot.note}
                                                            </p>
                                                        )}
                                                    </div>

                                                    {/* 우측: 코치 프로필 (있을 때만 표시) */}
                                                    {slot.coach && (
                                                        <div className="shrink-0 flex flex-col items-center gap-1 pt-0.5 w-[58px]">
                                                            {slot.coach.imageUrl ? (
                                                                <Image
                                                                    src={slot.coach.imageUrl}
                                                                    alt={slot.coach.name}
                                                                    width={44}
                                                                    height={44}
                                                                    className="w-11 h-11 rounded-full object-cover border-2 border-gray-100 dark:border-gray-700"
                                                                />
                                                            ) : (
                                                                <div className="w-11 h-11 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-lg">
                                                                    &#x1F3C0;
                                                                </div>
                                                            )}
                                                            <p className="text-xs font-bold text-gray-800 dark:text-gray-100 text-center leading-tight truncate w-full">
                                                                {slot.coach.name}
                                                            </p>
                                                            <p className="text-xs text-gray-400 dark:text-gray-400 text-center leading-tight truncate w-full">
                                                                {slot.coach.role}
                                                            </p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>

                                {/* CTA 버튼 영역 — 체험수업 / 수강신청 */}
                                <div className="mt-8 bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm p-6 text-center">
                                    <p className="text-gray-700 dark:text-gray-200 font-bold mb-4 break-keep">
                                        원하는 수업을 찾으셨나요?
                                    </p>
                                    <div className="flex flex-col sm:flex-row gap-3 justify-center">
                                        {/* 체험수업 CTA: 항상 자체 신청 페이지(/apply/trial)로 이동 */}
                                        <Link
                                            href="/apply/trial"
                                            className="px-6 py-3.5 rounded-xl font-bold text-sm bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-brand-orange-600 dark:hover:bg-lime-400 text-white shadow-md hover:shadow-lg active:scale-[0.98] transition-all duration-200 text-center"
                                        >
                                            체험수업 신청
                                        </Link>
                                        {/* 수강신청 CTA: 항상 자체 신청 페이지(/apply/enroll)로 이동 */}
                                        <Link
                                            href="/apply/enroll"
                                            className="px-6 py-3.5 rounded-xl font-bold text-sm border-2 border-brand-navy-900 dark:border-brand-neon-lime text-brand-navy-900 dark:text-brand-neon-lime hover:bg-brand-navy-900 dark:hover:bg-brand-neon-lime hover:text-white dark:hover:text-brand-navy-900 active:scale-[0.98] transition-all duration-200 text-center"
                                        >
                                            수강신청
                                        </Link>
                                    </div>
                                </div>

                                {/* 조건 변경 버튼 */}
                                <div className="mt-4 text-center">
                                    <button
                                        onClick={() => setStep(2)}
                                        className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 font-medium transition-colors"
                                    >
                                        &#8592; 조건 변경하기
                                    </button>
                                </div>
                            </>
                        )}
                    </div>
                )}
            </div>
        </section>
    );
}
