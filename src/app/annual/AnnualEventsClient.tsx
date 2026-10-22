"use client";

import { useState, useMemo, useEffect, useRef, type KeyboardEvent } from "react";
import { useRouter } from "next/navigation";
import EventDetailPanel from "./EventDetailPanel";
import { DAY_NAMES } from "@/lib/classSchedule";
import { getKoreanAnnualPeriod, isSameAnnualPeriod, type AnnualPeriod } from "./annualPeriod";
import "./annual-months.css";

// 5분마다 서버 데이터 자동 새로고침
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

// 카테고리별 스타일 — 이벤트 유형을 시각적으로 구분
const CATEGORY_STYLES: Record<string, { bg: string; text: string; dot: string; border: string }> = {
    대회:     { bg: "bg-orange-50",  text: "text-orange-700",  dot: "bg-orange-500",  border: "border-orange-200"  },
    방학:     { bg: "bg-red-50",    text: "text-red-700",    dot: "bg-red-500",    border: "border-red-200"    },
    특별행사: { bg: "bg-purple-50", text: "text-purple-700", dot: "bg-purple-500", border: "border-purple-200" },
    정기행사: { bg: "bg-blue-50",   text: "text-blue-700",   dot: "bg-blue-500",   border: "border-blue-200"   },
    일반:     { bg: "bg-green-50",  text: "text-green-700",  dot: "bg-green-500",  border: "border-green-200"  },
};

const MONTH_NAMES = ["1월","2월","3월","4월","5월","6월","7월","8월","9월","10월","11월","12월"];
const DOW_KO = ["일","월","화","수","목","금","토"];

export interface SerializedEvent {
    id: string;
    title: string;
    date: string;
    endDate?: string;
    description?: string;
    category: string;
    isAllDay: boolean;
    url?: string;
    source: "db" | "google";
    // "n월 개강/종강/주차" 이벤트: 실제 날짜와 관계없이 n월 섹션에 표시
    academicYear?:  number;
    academicMonth?: number;
}

interface Props {
    allEvents: SerializedEvent[];
    classDays: number[];
    // 서버에서 계산된 수강 연도별·수강월별 수업일자: { 연도: { 수강월(0-11): { 요일(0-6): [ISO날짜, ...] } } }
    yearlySchedules: Record<number, Record<number, Record<number, string[]>>>;
}

export default function AnnualEventsClient({ allEvents, yearlySchedules }: Props) {
    const router      = useRouter();
    const [currentPeriod, setCurrentPeriod] = useState(getKoreanAnnualPeriod);
    const [selection, setSelection] = useState<AnnualPeriod>(currentPeriod);
    const currentPeriodRef = useRef(currentPeriod);
    const monthStripRef = useRef<HTMLDivElement>(null);
    const monthButtonsRef = useRef(new Map<number, HTMLButtonElement>());
    const { year: currentYear, month: thisMonth } = currentPeriod;
    const { year: selectedYear, month: selectedMonth } = selection;
    const nextMonth = (thisMonth + 1) % 12;
    const nextMonthYear = thisMonth === 11 ? currentYear + 1 : currentYear;

    const [selectedEvent, setSelectedEvent]           = useState<SerializedEvent | null>(null);
    const [openScheduleMonths, setOpenScheduleMonths] = useState<Set<number>>(new Set());

    // 기존 5분 재조회는 유지하고, 월이 넘어가면 '이번 달'을 보고 있던 선택도 함께 넘긴다.
    useEffect(() => {
        const updateCurrentPeriod = () => {
            const next = getKoreanAnnualPeriod();
            const previous = currentPeriodRef.current;
            if (!isSameAnnualPeriod(previous, next)) {
                currentPeriodRef.current = next;
                setCurrentPeriod(next);
                setSelection((selected) => isSameAnnualPeriod(selected, previous) ? next : selected);
                setOpenScheduleMonths(new Set());
            }
        };
        const id = setInterval(() => {
            router.refresh();
            updateCurrentPeriod();
        }, SYNC_INTERVAL_MS);
        const onVisible = () => { if (!document.hidden) updateCurrentPeriod(); };
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            clearInterval(id);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [router]);

    // 월 선택 띠 안에서만 이동한다. 페이지 전체를 아래로 끌어내리지 않는다.
    useEffect(() => {
        const strip = monthStripRef.current;
        const button = monthButtonsRef.current.get(selectedMonth);
        if (!strip || !button) return;
        const alignSelectedMonth = () => {
            strip.scrollTo({ left: button.offsetLeft - (strip.clientWidth - button.clientWidth) / 2 });
        };
        alignSelectedMonth();
        // 화면 회전이나 큰 글씨로 폭이 바뀌어도 선택한 월을 띠 안에 유지한다.
        if (typeof ResizeObserver !== "undefined") {
            const observer = new ResizeObserver(alignSelectedMonth);
            observer.observe(strip);
            observer.observe(button);
            return () => observer.disconnect();
        }
        window.addEventListener("resize", alignSelectedMonth, { passive: true });
        return () => window.removeEventListener("resize", alignSelectedMonth);
    }, [selectedYear, selectedMonth]);

    function selectPeriod(next: AnnualPeriod) {
        setSelection(next);
        setOpenScheduleMonths(new Set());
    }

    function goToCurrentMonth() {
        const now = getKoreanAnnualPeriod();
        currentPeriodRef.current = now;
        setCurrentPeriod(now);
        selectPeriod(now);
    }

    function onMonthKeyDown(event: KeyboardEvent<HTMLButtonElement>, month: number) {
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const next = event.key === "ArrowRight" ? (month + 1) % 12
            : event.key === "ArrowLeft" ? (month + 11) % 12
            : event.key === "Home" ? 0 : event.key === "End" ? 11 : null;
        if (next === null) return;
        event.preventDefault();
        selectPeriod({ year: selectedYear, month: next });
        monthButtonsRef.current.get(next)?.focus();
    }

    /* -- 이벤트의 "표시 연도/월" 결정 --
     * "n월 개강/종강/주차" 이벤트는 academicYear/Month를 우선 사용해 n월 섹션에 표시 */
    const displayYearOf  = (ev: SerializedEvent) => ev.academicYear  ?? new Date(ev.date).getUTCFullYear();
    const displayMonthOf = (ev: SerializedEvent) => ev.academicMonth ?? new Date(ev.date).getUTCMonth();

    /* -- 연도 목록 -- */
    const availableYears = useMemo(() => {
        const s = new Set<number>();
        allEvents.forEach(e => s.add(displayYearOf(e)));
        Object.keys(yearlySchedules).forEach(year => s.add(Number(year)));
        s.add(currentYear);
        return Array.from(s).sort((a, b) => b - a);
    }, [allEvents, yearlySchedules, currentYear]);

    /* -- 선택 연도 필터 -- */
    const filteredEvents = useMemo(
        () => allEvents.filter(e => displayYearOf(e) === selectedYear),
        [allEvents, selectedYear],
    );

    /* -- month -> dateKey -> [events] -- */
    const byMonthDate = useMemo(() => {
        const g: Record<number, Record<string, SerializedEvent[]>> = {};
        filteredEvents.forEach(ev => {
            const mon = displayMonthOf(ev);
            const key = ev.date.slice(0, 10);
            if (!g[mon])      g[mon]      = {};
            if (!g[mon][key]) g[mon][key] = [];
            g[mon][key].push(ev);
        });
        return g;
    }, [filteredEvents]);

    function toggleSchedule(mon: number) {
        setOpenScheduleMonths(prev => {
            const next = new Set(prev);
            if (next.has(mon)) next.delete(mon);
            else next.add(mon);
            return next;
        });
    }

    return (
        <>
            {/* 메인 일정 영역 — 따뜻한 배경색으로 통일 */}
            <section className="public-content-section py-6 md:py-8 bg-surface-section dark:bg-gray-900 transition-colors duration-300">
                <div className="max-w-6xl mx-auto px-4">

                    {/* 연도 선택 — 가로 스크롤 */}
                    <div className="annual-year-controls">
                        <span className="text-sm font-bold text-gray-400 shrink-0">연도</span>
                        <div className="public-filter-row min-w-0 flex gap-2 overflow-x-auto scrollbar-hide">
                            {availableYears.map(year => (
                                <button
                                    key={year}
                                    type="button"
                                    aria-pressed={selectedYear === year}
                                    onClick={() => selectPeriod({ year, month: year === currentYear ? thisMonth : selectedMonth })}
                                    className={`px-5 py-2 rounded-full text-sm font-bold transition-all duration-200 shrink-0 whitespace-nowrap ${
                                        selectedYear === year
                                            ? "bg-brand-navy-900 text-white shadow-md"
                                            : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 hover:shadow-sm"
                                    }`}
                                >
                                    {year}년
                                </button>
                            ))}
                        </div>
                        <button type="button" className="annual-current-month" onClick={goToCurrentMonth}>
                            이번 달
                        </button>
                    </div>

                    <div ref={monthStripRef} className="annual-month-strip" role="tablist" aria-label="월 선택">
                        {MONTH_NAMES.map((name, month) => (
                            <button
                                key={month}
                                ref={(node) => {
                                    if (node) monthButtonsRef.current.set(month, node);
                                    else monthButtonsRef.current.delete(month);
                                }}
                                id={`annual-month-${month}`}
                                type="button"
                                role="tab"
                                aria-selected={selectedMonth === month}
                                aria-controls="annual-month-panel"
                                aria-label={`${month + 1}월${selectedYear === currentYear && month === thisMonth ? " · 이번 달" : ""}`}
                                tabIndex={selectedMonth === month ? 0 : -1}
                                className="annual-month-tab"
                                onClick={() => selectPeriod({ year: selectedYear, month })}
                                onKeyDown={(event) => onMonthKeyDown(event, month)}
                            >
                                {name}
                                {selectedYear === currentYear && month === thisMonth && <span className="annual-month-current-dot" aria-hidden="true" />}
                            </button>
                        ))}
                    </div>

                        <div id="annual-month-panel" role="tabpanel" aria-labelledby={`annual-month-${selectedMonth}`} className="space-y-6" tabIndex={0}>
                            {[selectedMonth].map(mon => {
                                const dateMap     = byMonthDate[mon] ?? {};
                                const schedule    = yearlySchedules[selectedYear]?.[mon];
                                const hasSchedule = !!schedule &&
                                    Object.values(schedule).some(dates => dates.length > 0);
                                const isScheduleOpen = openScheduleMonths.has(mon);
                                const sortedKeys  = Object.keys(dateMap).sort();
                                const eventCount  = Object.values(dateMap).flat().length;
                                const isThisMonth = selectedYear === currentYear && mon === thisMonth;
                                const isNextMonth = selectedYear === nextMonthYear && mon === nextMonth;

                                return (
                                    <div key={mon}>
                                        <div className="annual-selected-heading">
                                            <h2>{selectedYear}년 {MONTH_NAMES[mon]}</h2>
                                            {isThisMonth && <span className="annual-current-label">이번 달</span>}
                                            {isNextMonth && <span className="annual-next-label">다음 달</span>}
                                            <span className="annual-event-count">일정 {eventCount}개</span>
                                        </div>
                                        {sortedKeys.length === 0 && (
                                            <div className="public-card annual-empty-month">
                                                <p>{selectedYear}년 {MONTH_NAMES[mon]}에 등록된 행사가 없습니다.</p>
                                                {hasSchedule && <p>수업 날짜는 아래에서 확인해 주세요.</p>}
                                            </div>
                                        )}
                                        {/* 수업일자 확인 버튼 — pill 스타일 개선 */}
                                        {hasSchedule && (
                                            <div className="mb-4">
                                                <button
                                                    type="button"
                                                    aria-expanded={isScheduleOpen}
                                                    onClick={e => { e.stopPropagation(); toggleSchedule(mon); }}
                                                    className={`flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-full border transition-all duration-200 ${
                                                        isScheduleOpen
                                                            ? "bg-brand-navy-900 dark:bg-gray-700 text-white border-brand-navy-900 dark:border-gray-700 shadow-md"
                                                            : "bg-white dark:bg-gray-800 text-brand-navy-900 dark:text-gray-300 border-brand-navy-900/30 dark:border-gray-700 hover:border-brand-navy-900 hover:shadow-sm"
                                                    }`}
                                                >
                                                    수업일자 확인
                                                    <span className="text-[10px]">{isScheduleOpen ? "▲" : "▼"}</span>
                                                </button>
                                            </div>
                                        )}

                                        {/* 수업일자 패널 — 스타일 약간 개선 (둥근 모서리 + 그림자) */}
                                        {isScheduleOpen && schedule && (
                                            <div className="mb-5 bg-brand-navy-900 text-white rounded-2xl px-6 py-5 shadow-lg">
                                                <p className="text-[11px] font-bold text-blue-300 mb-3 uppercase tracking-wide">
                                                    {mon + 1}월 수업일자
                                                </p>
                                                <div className="space-y-1.5">
                                                    {[1, 2, 3, 4, 5, 6].map(day => {
                                                        const dates = schedule[day] ?? [];
                                                        if (dates.length === 0) return null;
                                                        return (
                                                            <div key={day} className="flex items-baseline gap-3">
                                                                <span className="text-sm font-black w-5 shrink-0 text-white">
                                                                    {DAY_NAMES[day]}
                                                                </span>
                                                                <span className="text-sm text-blue-100 tracking-wide">
                                                                    {dates.map(iso => {
                                                                        const d = new Date(iso);
                                                                        const dMon = d.getUTCMonth();
                                                                        // 수강월과 다른 달인 경우 "M/D" 표시
                                                                        return dMon !== mon
                                                                            ? `${dMon + 1}/${d.getUTCDate()}`
                                                                            : `${d.getUTCDate()}일`;
                                                                    }).join(",  ")}
                                                                </span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        )}

                                        {/* 날짜별 이벤트 그룹 — 카드 스타일 개선 */}
                                        <div className="space-y-3 mb-8">
                                            {sortedKeys.map(dateKey => {
                                                const events = dateMap[dateKey];
                                                const d   = new Date(dateKey);
                                                // UTC 메서드 사용 — 날짜가 UTC 자정으로 정규화되어 있으므로
                                                const mo  = d.getUTCMonth() + 1;
                                                const day = d.getUTCDate();
                                                const dow = DOW_KO[d.getUTCDay()];

                                                return (
                                                    <div
                                                        key={dateKey}
                                                        className="public-card bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 transition-colors duration-300 overflow-hidden shadow-sm hover:shadow-md transition-shadow duration-200"
                                                    >
                                                        {/* 날짜 헤더 — 더 깔끔한 디자인 */}
                                                        <div className="px-5 py-2.5 bg-gray-50/80 dark:bg-gray-700/80 border-b border-gray-100 dark:border-gray-700 flex items-center gap-2 transition-colors">
                                                            <span className="text-sm font-black text-gray-800 dark:text-gray-200">
                                                                {mo}월 {day}일
                                                            </span>
                                                            <span className="text-xs font-bold text-gray-400 bg-gray-200/70 dark:bg-gray-600/70 px-2 py-0.5 rounded-full leading-none transition-colors">
                                                                {dow}
                                                            </span>
                                                        </div>

                                                        {/* 이벤트 행 목록 */}
                                                        <div className="divide-y divide-gray-50 dark:divide-gray-700/50 transition-colors">
                                                            {events.map(ev => {
                                                                const cat = CATEGORY_STYLES[ev.category] ?? CATEGORY_STYLES["일반"];
                                                                return (
                                                                    <button
                                                                        key={ev.id}
                                                                        type="button"
                                                                        onClick={() => setSelectedEvent(ev)}
                                                                        className="annual-event-row w-full text-left px-5 py-3.5 flex items-center gap-3 hover:bg-gray-50 dark:bg-gray-900/50 dark:hover:bg-gray-700/50 active:bg-gray-100 dark:bg-gray-800 dark:active:bg-gray-600 transition-colors duration-150 group"
                                                                    >
                                                                        {/* 카테고리 뱃지 */}
                                                                        <span className={`flex items-center gap-1.5 text-xs font-bold px-2.5 py-0.5 rounded-full border shrink-0 ${cat.bg} ${cat.text} ${cat.border}`}>
                                                                            <span className={`w-1.5 h-1.5 rounded-full ${cat.dot}`} />
                                                                            {ev.category || "일반"}
                                                                        </span>
                                                                        {/* 이벤트 제목 + 기간 */}
                                                                        <span className="min-w-0 flex-1 break-words text-sm font-bold text-gray-900 dark:text-white transition-colors">
                                                                            {ev.title}
                                                                            {ev.endDate && (() => {
                                                                                const s = new Date(ev.date);
                                                                                const e = new Date(ev.endDate);
                                                                                // startDate와 endDate가 같은 날이면 종료일 표시 생략 (당일 일정)
                                                                                if (s.getUTCFullYear() === e.getUTCFullYear() &&
                                                                                    s.getUTCMonth() === e.getUTCMonth() &&
                                                                                    s.getUTCDate() === e.getUTCDate()) return null;
                                                                                return (
                                                                                    <span className="ml-1.5 text-sm font-semibold text-gray-600 dark:text-gray-400 transition-colors">
                                                                                        ~ {e.getUTCMonth() + 1}월 {e.getUTCDate()}일
                                                                                    </span>
                                                                                );
                                                                            })()}
                                                                        </span>
                                                                        {/* 데스크톱에서만 설명 미리보기 */}
                                                                        {ev.description && (
                                                                            <span className="hidden sm:block text-xs text-gray-400 truncate max-w-[180px]">
                                                                                {ev.description}
                                                                            </span>
                                                                        )}
                                                                        {/* 더보기 화살표 */}
                                                                        <span className="text-gray-300 group-hover:text-brand-orange-500 dark:text-brand-neon-lime transition-colors text-lg shrink-0 leading-none">
                                                                            ›
                                                                        </span>
                                                                    </button>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                </div>
            </section>

            {/* 상세 패널 — 기존 컴포넌트 그대로 사용 */}
            <EventDetailPanel
                event={selectedEvent}
                onClose={() => setSelectedEvent(null)}
            />
        </>
    );
}
