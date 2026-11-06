"use client";

import { useMemo, useState } from "react";
import { CLOSED_RE } from "@/lib/classSchedule";
import { buildMonthGrid, eventsByDay, shortEventLabel } from "./annualCalendar";
import type { SerializedEvent } from "./AnnualEventsClient";

// 구분 색 점 — 목록형·범례와 같은 색(같은 뜻은 같은 색)
const CATEGORY_DOT: Record<string, string> = {
    대회: "bg-orange-500",
    방학: "bg-red-500",
    특별행사: "bg-amber-500",
    정기행사: "bg-blue-500",
    일반: "bg-green-500",
};
const DOW_KO = ["일", "월", "화", "수", "목", "금", "토"];

interface Props {
    year: number;
    /** 0=1월 */
    month: number;
    events: SerializedEvent[];
    /** 오늘(KST) "YYYY-MM-DD" — 오늘 칸 표시와 처음 고를 날짜에 쓴다 */
    todayYmd: string | null;
    onSelectEvent: (event: SerializedEvent) => void;
}

export default function AnnualCalendarView({ year, month, events, todayYmd, onSelectEvent }: Props) {
    const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
    const byDay = useMemo(() => eventsByDay(events, weeks), [events, weeks]);
    const monthPrefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
    // 처음엔 오늘(이번 달일 때)을 골라 두어, 달력 아래에 오늘 일정이 바로 보이게 한다.
    const [pickedDay, setPickedDay] = useState<string | null>(null);
    const selectedDay = pickedDay?.startsWith(monthPrefix) ? pickedDay
        : todayYmd?.startsWith(monthPrefix) ? todayYmd : null;
    const selectedEvents = selectedDay ? byDay.get(selectedDay) ?? [] : [];

    return (
        <div className="annual-calendar">
            <div className="annual-calendar-grid" role="group" aria-label={`${year}년 ${month + 1}월 달력`}>
                <div className="annual-calendar-row" aria-hidden="true">
                    {DOW_KO.map((name, dow) => (
                        <div key={name} className={`annual-calendar-dow${dow === 0 ? " is-sunday" : dow === 6 ? " is-saturday" : ""}`}>
                            {name}
                        </div>
                    ))}
                </div>
                {weeks.map((week) => (
                    <div key={week[0].ymd} className="annual-calendar-row">
                        {week.map((cell) => {
                            const dayEvents = byDay.get(cell.ymd) ?? [];
                            const closed = dayEvents.some((ev) => CLOSED_RE.test(ev.title));
                            const isToday = cell.ymd === todayYmd;
                            const isSelected = cell.ymd === selectedDay;
                            const label = `${Number(cell.ymd.slice(5, 7))}월 ${cell.day}일 ${DOW_KO[cell.dow]}요일`
                                + (dayEvents.length ? `, 일정 ${dayEvents.length}개` : "")
                                + (closed ? ", 학원 휴무" : "")
                                + (isToday ? ", 오늘" : "");
                            return (
                                <button
                                    key={cell.ymd}
                                    type="button"
                                    aria-label={label}
                                    aria-pressed={isSelected}
                                    disabled={!cell.inMonth}
                                    onClick={() => setPickedDay(cell.ymd)}
                                    className={[
                                        "annual-calendar-cell",
                                        cell.inMonth ? "" : "is-outside",
                                        closed ? "is-closed" : "",
                                        isSelected ? "is-selected" : "",
                                        cell.dow === 0 ? "is-sunday" : cell.dow === 6 ? "is-saturday" : "",
                                    ].filter(Boolean).join(" ")}
                                >
                                    <span className={`annual-calendar-day${isToday ? " is-today" : ""}`}>{cell.day}</span>
                                    {cell.inMonth && dayEvents.length > 0 && (
                                        <>
                                            {/* 휴대폰: 짧은 이름(개강·종강·휴무…) 2개 + 남은 개수. 같은 이름은 한 번만 */}
                                            <span className="annual-calendar-dots" aria-hidden="true">
                                                {(() => {
                                                    const labels = [...new Map(dayEvents.map((ev) => {
                                                        const short = shortEventLabel(ev.title, ev.category);
                                                        return [short, { short, dot: CATEGORY_DOT[ev.category] ?? CATEGORY_DOT["일반"] }] as const;
                                                    })).values()];
                                                    return (
                                                        <>
                                                            {labels.slice(0, 2).map((l) => (
                                                                <span key={l.short} className={`annual-calendar-short${l.short === "휴무" ? " is-closed" : ""}`}>
                                                                    <span className={`annual-calendar-dot ${l.dot}`} />
                                                                    {l.short}
                                                                </span>
                                                            ))}
                                                            {labels.length > 2 && <span className="annual-calendar-more">+{labels.length - 2}</span>}
                                                        </>
                                                    );
                                                })()}
                                            </span>
                                            {/* PC: 짧은 제목 2개 + 남은 개수 */}
                                            <span className="annual-calendar-titles" aria-hidden="true">
                                                {dayEvents.slice(0, 2).map((ev) => (
                                                    <span key={ev.id} className="annual-calendar-title">
                                                        <span className={`annual-calendar-dot ${CATEGORY_DOT[ev.category] ?? CATEGORY_DOT["일반"]}`} />
                                                        <span className="annual-calendar-title-text">{ev.title}</span>
                                                    </span>
                                                ))}
                                                {dayEvents.length > 2 && <span className="annual-calendar-more">+{dayEvents.length - 2}</span>}
                                            </span>
                                        </>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                ))}
            </div>

            {/* 고른 날의 일정 — 달력 바로 아래(근접성: 누른 칸과 결과를 가까이) */}
            <div className="annual-calendar-detail" aria-live="polite">
                {!selectedDay ? (
                    <p className="annual-calendar-hint">날짜를 누르면 그날 일정을 볼 수 있습니다.</p>
                ) : (
                    <>
                        <p className="annual-calendar-detail-date">
                            {Number(selectedDay.slice(5, 7))}월 {Number(selectedDay.slice(8, 10))}일 ({DOW_KO[weeks.flat().find((c) => c.ymd === selectedDay)?.dow ?? 0]})
                        </p>
                        {selectedEvents.length === 0 ? (
                            <p className="annual-calendar-hint">이 날은 등록된 일정이 없습니다.</p>
                        ) : (
                            <ul className="annual-calendar-detail-list">
                                {selectedEvents.map((ev) => (
                                    <li key={ev.id}>
                                        <button type="button" className="annual-calendar-detail-row" onClick={() => onSelectEvent(ev)}>
                                            <span className={`annual-calendar-dot ${CATEGORY_DOT[ev.category] ?? CATEGORY_DOT["일반"]}`} />
                                            <span className="annual-calendar-detail-category">{ev.category || "일반"}</span>
                                            <span className="annual-calendar-detail-title">{ev.title}</span>
                                            <span className="annual-calendar-detail-arrow" aria-hidden="true">›</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
