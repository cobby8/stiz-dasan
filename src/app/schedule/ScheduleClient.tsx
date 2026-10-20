"use client";

import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import ScheduleTableView from "@/components/ScheduleTableView";

// 요일 순서 — 월~일 표시용
const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// 요일별 헤더 배경색 — 각 요일을 시각적으로 구분
const DAY_BG: Record<string, string> = {
    Mon: "bg-blue-600", Tue: "bg-green-600", Wed: "bg-yellow-500",
    Thu: "bg-purple-600", Fri: "bg-red-500", Sat: "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900",
    Sun: "bg-gray-500",
};

// 요일별 카드 영역 배경색 — 헤더 색상과 어울리는 연한 톤
const DAY_CARD_BG: Record<string, string> = {
    Mon: "bg-blue-50/50 border-blue-100", Tue: "bg-green-50/50 border-green-100",
    Wed: "bg-yellow-50/50 border-yellow-100", Thu: "bg-purple-50/50 border-purple-100",
    Fri: "bg-red-50/50 border-red-100", Sat: "bg-orange-50/50 border-orange-100",
    Sun: "bg-gray-50 dark:bg-gray-900/50 border-gray-100 dark:border-gray-800",
};

export type MergedSlot = {
    slotKey: string;
    dayKey: string;
    dayLabel: string;
    startTime: string;
    endTime: string;
    gradeRange: string;
    enrolled: number;
    displayLabel: string;
    note: string | null;
    capacity: number;
    isFull: boolean;
    coach: { name: string; role: string; imageUrl: string | null } | null;
    programId: string | null;
};

type Program = { id: string; name: string };

function ScheduleFilter({ programs, allSlots, phone }: {
    programs: Program[];
    allSlots: MergedSlot[];
    phone: string;
}) {
    const searchParams = useSearchParams();
    const filterProgramId = searchParams.get("program") ?? undefined;
    // 카드 보기 / 표 보기 전환 상태 ("card" 기본)
    const [viewMode, setViewMode] = useState<"card" | "table">("card");

    // 프로그램 필터 적용 — 선택된 프로그램이 있으면 해당 프로그램만 표시
    let slots = allSlots;
    if (filterProgramId) {
        slots = allSlots.filter((s) => s.programId === filterProgramId);
    }

    // 요일별 그룹핑 + 시간순 정렬
    const byDay = DAY_ORDER.reduce<Record<string, MergedSlot[]>>((acc, d) => {
        acc[d] = slots.filter((s) => s.dayKey === d).sort((a, b) => a.startTime.localeCompare(b.startTime));
        return acc;
    }, {});
    const activeDays = DAY_ORDER.filter((d) => byDay[d].length > 0);
    const hasData = slots.length > 0;
    const selectedProgram = programs.find((p) => p.id === filterProgramId);

    return (
        <>
            {/* 프로그램 필터 탭 — 디자인 개선 (둥글고 부드러운 pill 스타일) */}
            {programs.length > 0 && (
                <div className="bg-white dark:bg-gray-800/80 backdrop-blur-sm border-b border-gray-100 dark:border-gray-800 sticky top-0 z-10">
                    {/* 수평 스크롤 칩 + 뷰 토글 — 모바일에서 자연스러운 좌우 스와이프 */}
                    <div className="max-w-6xl mx-auto px-4 py-3 flex gap-2 items-center overflow-x-auto scrollbar-hide">
                        <a
                            href="/schedule"
                            className={`shrink-0 text-sm font-bold px-5 py-2 rounded-full transition-all duration-200 whitespace-nowrap ${
                                !filterProgramId
                                    ? "bg-brand-navy-900 text-white shadow-md"
                                    : "bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:bg-gray-800 hover:shadow-sm border border-gray-200 dark:border-gray-700"
                            }`}
                        >
                            전체
                        </a>
                        {programs.map((p) => (
                            <a
                                key={p.id}
                                href={`/schedule?program=${p.id}`}
                                className={`shrink-0 text-sm font-bold px-5 py-2 rounded-full transition-all duration-200 whitespace-nowrap ${
                                    filterProgramId === p.id
                                        ? "bg-brand-navy-900 text-white shadow-md"
                                        : "bg-gray-50 dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:bg-gray-800 hover:shadow-sm border border-gray-200 dark:border-gray-700"
                                }`}
                            >
                                {p.name}
                            </a>
                        ))}

                    </div>
                </div>
            )}

            {/* 시간표 그리드 — 배경색을 따뜻한 톤으로 변경 */}
            <section className="py-16 md:py-20 bg-surface-section dark:bg-gray-900 transition-colors duration-300">
                <div className="max-w-6xl mx-auto px-4">
                    {/* 뷰 토글 — 수업 카드 영역 오른쪽 위 */}
                    <div className="flex justify-end mb-4">
                        <div className="flex rounded-full border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
                            <button
                                onClick={() => setViewMode("card")}
                                className={`flex items-center gap-1 px-4 py-2 text-xs font-bold transition-colors ${
                                    viewMode === "card"
                                        ? "bg-brand-navy-900 text-white"
                                        : "bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:bg-gray-900"
                                }`}
                            >
                                <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>grid_view</span>
                                카드
                            </button>
                            <button
                                onClick={() => setViewMode("table")}
                                className={`flex items-center gap-1 px-4 py-2 text-xs font-bold transition-colors ${
                                    viewMode === "table"
                                        ? "bg-brand-navy-900 text-white"
                                        : "bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:bg-gray-900"
                                }`}
                            >
                                <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>table_chart</span>
                                표
                            </button>
                        </div>
                    </div>

                    {/* 프로그램 필터 표시 배너 — 선택 시 상단에 안내 */}
                    {filterProgramId && selectedProgram && (
                        <div className="mb-6 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-2xl px-6 py-4 flex items-center justify-between gap-4 shadow-sm transition-colors">
                            <div>
                                <p className="text-sm text-gray-400 mb-0.5 font-medium">프로그램 필터</p>
                                <p className="font-bold text-gray-900 dark:text-white">{selectedProgram.name}</p>
                            </div>
                            <a href="/schedule" className="text-sm text-brand-orange-500 dark:text-brand-neon-lime hover:text-brand-orange-600 dark:text-brand-neon-lime dark:hover:text-lime-400 font-bold transition">
                                전체 보기
                            </a>
                        </div>
                    )}

                    {/* 데이터 없을 때 안내 메시지 */}
                    {!hasData ? (
                        <div className="text-center py-20 text-gray-400 bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm transition-colors">
                            <div className="text-5xl mb-4">🏀</div>
                            <p className="text-lg font-bold text-gray-500 dark:text-gray-400">
                                {filterProgramId ? "해당 프로그램의 수업이 없습니다." : "시간표를 준비 중입니다."}
                            </p>
                            <p className="text-sm mt-2 text-gray-400">문의: {phone}</p>
                        </div>
                    ) : viewMode === "table" ? (
                        /* 표 보기 모드 — ScheduleTableView 렌더링 */
                        <ScheduleTableView slots={slots} />
                    ) : (
                        <div data-tour-target="schedule-grid" className="space-y-8">
                            {activeDays.map((dayKey) => (
                                <div key={dayKey} className={`rounded-2xl border ${DAY_CARD_BG[dayKey]} dark:bg-gray-900 dark:border-gray-800 overflow-hidden shadow-sm transition-colors`}>
                                    {/* 요일 헤더 — 색상 바 + 클래스 수 표시 */}
                                    <div className={`${DAY_BG[dayKey]} text-white px-6 py-3.5 flex items-center gap-3`}>
                                        <span className="font-black text-lg">{byDay[dayKey][0].dayLabel}</span>
                                        <span className="text-white/70 text-sm font-medium">{byDay[dayKey].length}개 클래스</span>
                                    </div>

                                    {/* 클래스 카드 그리드 */}
                                    <div className="p-4 md:p-5">
                                        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
                                            {byDay[dayKey].map((slot) => (
                                                <div
                                                    key={slot.slotKey}
                                                    className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-100 dark:border-gray-700 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
                                                >
                                                    <div className="flex gap-3">
                                                        {/* 좌측: 수업 정보 */}
                                                        <div className="flex-1 min-w-0">
                                                            <h4 className="font-bold text-gray-900 dark:text-white mb-2 text-base">{slot.displayLabel}</h4>
                                                            {/* 시간 표시 */}
                                                            <div className="flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300 mb-1">
                                                                <span className="text-gray-400">⏰</span>
                                                                <span className="font-semibold">{slot.startTime} ~ {slot.endTime}</span>
                                                            </div>
                                                            {/* 대상 학년 */}
                                                            {slot.gradeRange && (
                                                                <div className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 mb-1">
                                                                    <span className="text-gray-400">🎓</span>
                                                                    <span>{slot.gradeRange}</span>
                                                                </div>
                                                            )}
                                                            {/* 수강인원 인디케이터 바 */}
                                                            <div className="mt-3 pt-2 border-t border-gray-50">
                                                                <div className="flex justify-between items-center mb-1.5 gap-2">
                                                                    <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">수강 현황</span>
                                                                    <div className="flex items-center gap-1.5">
                                                                        {slot.isFull && (
                                                                            <span className="text-[10px] leading-none bg-red-50 text-red-500 font-black px-1.5 py-0.5 rounded uppercase">마감</span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                                <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-1.5 overflow-hidden">
                                                                    <div
                                                                        className={`h-full rounded-full transition-all duration-500 ${
                                                                            slot.isFull ? "bg-red-500" :
                                                                            (slot.enrolled / Math.max(slot.capacity, 1) >= 0.8) ? "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900" :
                                                                            "bg-blue-500"
                                                                        }`}
                                                                        style={{ width: `${Math.min((slot.enrolled / Math.max(slot.capacity, 1)) * 100, 100)}%` }}
                                                                    />
                                                                </div>
                                                            </div>
                                                            {/* 메모 — 있을 때만 표시 */}
                                                            {slot.note && (
                                                                <p className="text-sm text-brand-orange-600 dark:text-brand-neon-lime mt-2 font-medium">📌 {slot.note}</p>
                                                            )}
                                                        </div>

                                                        {/* 우측: 코치 프로필 — 있을 때만 표시 */}
                                                        {slot.coach && (
                                                            <div className="shrink-0 flex flex-col items-center gap-1 pt-0.5 w-[58px]">
                                                                {slot.coach.imageUrl ? (
                                                                    <Image
                                                                        src={slot.coach.imageUrl}
                                                                        alt={slot.coach.name}
                                                                        width={44}
                                                                        height={44}
                                                                        className="w-11 h-11 rounded-full object-cover border-2 border-gray-100 dark:border-gray-800"
                                                                    />
                                                                ) : (
                                                                    <div className="w-11 h-11 rounded-full bg-gray-200 flex items-center justify-center text-lg">🏀</div>
                                                                )}
                                                                <p className="text-xs font-bold text-gray-800 dark:text-gray-100 text-center leading-tight truncate w-full">{slot.coach.name}</p>
                                                                <p className="text-xs text-gray-400 text-center leading-tight truncate w-full">{slot.coach.role}</p>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </section>
        </>
    );
}

export default function ScheduleClient(props: { programs: Program[]; allSlots: MergedSlot[]; phone: string }) {
    return (
        <Suspense fallback={
            <div className="py-20 text-center text-gray-400">
                <div className="text-4xl mb-3">🏀</div>
                <p>시간표 불러오는 중...</p>
            </div>
        }>
            <ScheduleFilter {...props} />
        </Suspense>
    );
}
