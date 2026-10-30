"use client";

import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import ScheduleTableView from "@/components/ScheduleTableView";
import { usePublicOverlayOpen } from "@/components/public-floating";

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
    // 필터 모달 열림 상태 + 모달 안에서 고르는 중인 값(«적용» 전까지는 화면을 바꾸지 않는다)
    const [filterOpen, setFilterOpen] = useState(false);
    const [pendingProgramId, setPendingProgramId] = useState("");
    const openFilter = () => {
        setPendingProgramId(filterProgramId ?? "");
        setFilterOpen(true);
    };
    // 모달이 열린 동안 챗봇·입학 가이드 플로팅 버튼 숨김(게슈탈트 C-P3)
    usePublicOverlayOpen(filterOpen);

    return (
        <>
            {/* 게슈탈트 P-07: 필터 한 줄 — «필터(n)» 버튼 하나 + 선택 이름(작게) + 카드/표 전환(같은 줄, 44px).
                프로그램 칩 줄과 중복 «프로그램 필터» 카드는 없앴고, 프로그램 고르기는 모달(모바일 하단 시트)에서 한다. */}
            <div className="sticky top-0 z-10 border-b border-gray-100 bg-white dark:border-gray-800 dark:bg-gray-900">
                <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2">
                    {programs.length > 0 && (
                        <button
                            type="button"
                            onClick={openFilter}
                            aria-haspopup="dialog"
                            className={selectedProgram ? "public-btn-primary shrink-0 px-4 text-sm" : "public-btn-secondary shrink-0 px-4 text-sm"}
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: "18px" }} aria-hidden="true">tune</span>
                            {/* 적용 개수 표시 — 프로그램은 하나만 고르므로 0 또는 1 */}
                            {selectedProgram ? "필터 1" : "필터"}
                        </button>
                    )}
                    {/* 선택된 프로그램 이름 — 버튼 옆에 작게(없으면 «전체 프로그램») */}
                    {programs.length > 0 ? (
                        <p className="min-w-0 flex-1 truncate text-sm text-gray-500 dark:text-gray-400">
                            {selectedProgram ? selectedProgram.name : "전체 프로그램"}
                        </p>
                    ) : (
                        <div className="flex-1" />
                    )}
                    {/* 뷰 토글 — 카드 / 표 (각 44px) */}
                    <div className="flex shrink-0 overflow-hidden rounded-full border border-gray-200 dark:border-gray-700" role="group" aria-label="보기 방식">
                        <button
                            type="button"
                            onClick={() => setViewMode("card")}
                            aria-pressed={viewMode === "card"}
                            className={`flex min-h-11 items-center gap-1 px-4 text-xs font-bold transition-colors ${
                                viewMode === "card"
                                    ? "bg-brand-navy-900 text-white dark:bg-[var(--color-public-orange)] dark:text-[var(--color-public-dark)]"
                                    : "bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900"
                            }`}
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>grid_view</span>
                            카드
                        </button>
                        <button
                            type="button"
                            onClick={() => setViewMode("table")}
                            aria-pressed={viewMode === "table"}
                            className={`flex min-h-11 items-center gap-1 px-4 text-xs font-bold transition-colors ${
                                viewMode === "table"
                                    ? "bg-brand-navy-900 text-white dark:bg-[var(--color-public-orange)] dark:text-[var(--color-public-dark)]"
                                    : "bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-900"
                            }`}
                        >
                            <span className="material-symbols-outlined" style={{ fontSize: "16px" }}>table_chart</span>
                            표
                        </button>
                    </div>
                </div>
            </div>

            {/* 프로그램 필터 모달 — PC 가운데, 모바일 하단 시트. 고른 뒤 «적용»을 눌러야 이동한다. */}
            {filterOpen && (
                <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label="프로그램 필터">
                    <div className="absolute inset-0 bg-black/50" onClick={() => setFilterOpen(false)} aria-hidden="true" />
                    <div className="relative flex max-h-[85vh] w-full flex-col rounded-t-2xl bg-white shadow-2xl dark:bg-gray-800 sm:mx-4 sm:max-w-md sm:rounded-2xl">
                        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-1 dark:border-gray-700">
                            <h2 className="text-base font-black text-gray-900 dark:text-white">프로그램 필터</h2>
                            <button type="button" onClick={() => setFilterOpen(false)} aria-label="닫기" className="flex h-11 w-11 items-center justify-center rounded-full text-lg text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700">✕</button>
                        </div>
                        <div className="overflow-y-auto px-5 py-2">
                            {[{ id: "", name: "전체" }, ...programs].map((p) => (
                                <label key={p.id || "all"} className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-gray-100 text-sm font-bold text-gray-800 last:border-b-0 dark:border-gray-700 dark:text-gray-100">
                                    <input
                                        type="radio"
                                        name="schedule-program"
                                        checked={pendingProgramId === p.id}
                                        onChange={() => setPendingProgramId(p.id)}
                                        className="h-4 w-4 accent-[var(--color-public-accent)]"
                                    />
                                    {p.name}
                                </label>
                            ))}
                        </div>
                        <div className="flex gap-2 border-t border-gray-100 px-5 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] dark:border-gray-700">
                            <button type="button" onClick={() => setPendingProgramId("")} className="public-btn-secondary flex-1 text-sm">초기화</button>
                            {/* 적용 = 기존 칩과 같은 주소(/schedule?program=…)로 이동 — 필터 방식은 그대로 */}
                            <a href={pendingProgramId ? `/schedule?program=${pendingProgramId}` : "/schedule"} className="public-btn-primary flex-1 text-sm">적용</a>
                        </div>
                    </div>
                </div>
            )}

            {/* 시간표 그리드 — 배경색을 따뜻한 톤으로 변경 */}
            <section className="public-content-section py-6 md:py-8 bg-surface-section dark:bg-gray-900 transition-colors duration-300">
                <div className="max-w-6xl mx-auto px-4">
                    {/* 데이터 없을 때 안내 메시지 */}
                    {!hasData ? (
                        /* 게슈탈트 P-12 빈 상태: 큰 그림 없이 한 줄 문구 + 전화 링크 */
                        <div className="py-6 text-center text-sm text-gray-500 dark:text-gray-400 bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700">
                            <span className="font-bold">{filterProgramId ? "해당 프로그램의 수업이 없습니다." : "시간표를 준비 중입니다."}</span>{" "}
                            <a href={`tel:${phone.replace(/-/g, "")}`} className="inline-flex min-h-11 items-center font-bold text-[var(--color-public-accent)] underline underline-offset-2">문의 {phone}</a>
                        </div>
                    ) : viewMode === "table" ? (
                        /* 표 보기 모드 — ScheduleTableView 렌더링 */
                        <ScheduleTableView slots={slots} />
                    ) : (
                        <div data-tour-target="schedule-grid" className="space-y-5">
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
                                                    className="public-card bg-white dark:bg-gray-800 rounded-xl p-3 sm:p-4 shadow-sm border border-gray-100 dark:border-gray-700 hover:shadow-md hover:-translate-y-0.5 transition-all duration-200"
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
                                                                            <span className="text-xs leading-none bg-red-50 text-red-500 font-black px-1.5 py-0.5 rounded uppercase">마감</span>
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
                                                                <p className="text-xs font-bold text-gray-800 dark:text-gray-100 text-center leading-tight break-keep w-full">{slot.coach.name}</p>
                                                                <p className="text-xs text-gray-400 text-center leading-tight break-words w-full">{slot.coach.role}</p>
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
