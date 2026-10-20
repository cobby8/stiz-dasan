"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { publicScheduleNotice } from "./publicSchedulePresentation";
import { Suspense, useState } from "react";
import ScheduleTableView from "@/components/ScheduleTableView";

// 요일 순서 — 월~일 표시용
const DAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

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
    const router = useRouter();
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

    return (
        <>
            <section className="public-section">
                <div className="public-container">
                    <div className="mb-4 flex flex-wrap items-center gap-3">
                        <label className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
                            <span className="shrink-0">프로그램</span>
                            <select aria-label="프로그램 선택" value={filterProgramId ?? ""} onChange={(event) => router.push(event.target.value ? `/schedule?program=${encodeURIComponent(event.target.value)}` : "/schedule")} className="min-h-11 min-w-0 max-w-full rounded-xl border border-[var(--color-public-border)] bg-[var(--color-public-surface)] px-3 text-base">
                                <option value="">전체 수업</option>{programs.map((program) => <option key={program.id} value={program.id}>{program.name}</option>)}
                            </select>
                        </label>
                        <span className="text-sm text-[var(--color-public-muted)]">{slots.length}개 수업</span>
                        <div className="flex shrink-0 gap-1" role="group" aria-label="시간표 보기 방식">
                            <button type="button" aria-pressed={viewMode === "card"} onClick={() => setViewMode("card")} className={viewMode === "card" ? "public-button" : "public-button-secondary"}>카드</button>
                            <button type="button" aria-pressed={viewMode === "table"} onClick={() => setViewMode("table")} className={viewMode === "table" ? "public-button" : "public-button-secondary"}>표</button>
                        </div>
                    </div>

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
                        <div data-tour-target="schedule-grid" className="space-y-5">
                            {activeDays.map((dayKey) => (
                                <div key={dayKey} className="public-card overflow-hidden">
                                    {/* 요일 헤더 — 색상 바 + 클래스 수 표시 */}
                                    <div className="flex items-center gap-3 bg-[var(--color-public-soft)] px-4 py-3 text-[var(--color-public-text)]">
                                        <span className="font-black text-lg">{byDay[dayKey][0].dayLabel}</span>
                                        <span className="text-[var(--color-public-muted)] text-sm font-medium">{byDay[dayKey].length}개 클래스</span>
                                    </div>

                                    {/* 클래스 카드 그리드 */}
                                    <div className="p-3 md:p-4">
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
                                                            {publicScheduleNotice(slot.note) && (
                                                                <p className="text-sm text-brand-orange-600 dark:text-brand-neon-lime mt-2 font-medium">{publicScheduleNotice(slot.note)}</p>
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
