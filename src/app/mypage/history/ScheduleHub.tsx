import Link from "next/link";
import type { ParentShuttleOverviewItem } from "@/lib/shuttle/parent";
import ParentShuttleDetail from "../ParentShuttleDetail";
import { formatKstDate } from "@/lib/datetime/kst";
import { monthTitle, shiftMonth, shortDay, type MonthCell, type ParentMonthView } from "@/lib/mypage/parentSchedule";

// «일정» 탭 (2026-11-09 원장 지시 — «일정에 수납이 있는 거 자체가 이상해»).
// 이 화면은 «확인하는 곳»이다: 연간일정(행사·휴무) · 우리 아이 수업일 · 출결을 한 달 달력으로 본다.
// - 수납 기록은 청구 탭에만 둔다(여기서 뺐다).
// - 결석·보강·셔틀 변경 신청 줄은 홈 «빠른 실행»에 이미 있어 뺐다. 수강 변경 신청은 홈 «⋯» 메뉴로 옮겼다.
// - 수강 반(#mypage-enrollments)·셔틀 배정(#mypage-shuttle)은 홈의 «다음 수업»·«오늘 셔틀» 줄이 데려오는 자리라 남긴다.
// 표시 전용 — 쓰기 없음. 달 이동·자녀 선택은 주소(?month=·?child=)로만 바꾼다(서버에서 그린다).

const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};
const WEEK_HEAD = ["일", "월", "화", "수", "목", "금", "토"];

export type ScheduleChild = {
    id: string;
    name: string;
    enrollments: {
        id: string;
        className: string;
        dayOfWeek: string;
        startTime: string;
        endTime: string;
        programName?: string | null;
        displayStatus?: string;
        startsOn?: string | null;
        startsLater?: boolean;
    }[];
};

function Icon({ name, size = 20, className = "" }: { name: string; size?: number; className?: string }) {
    return <span className={`material-symbols-outlined leading-none ${className}`} style={{ fontSize: `${size}px` }} aria-hidden="true">{name}</span>;
}

// 출결 점 색 — 공용 색 토큰만(하드코딩 색 없음)
const ATTENDANCE_DOT: Record<string, { dot: string; label: string }> = {
    PRESENT: { dot: "bg-[var(--color-academy-success)]", label: "출석" },
    LATE: { dot: "bg-[var(--color-academy-warning)]", label: "지각" },
    ABSENT: { dot: "bg-[var(--color-academy-danger)]", label: "결석" },
};

/** 달력 한 칸 — 날짜 숫자 + 아래 점(출결 또는 수업일 · 행사). 휴무는 «휴» 한 글자 */
function DayCell({ cell }: { cell: MonthCell }) {
    const att = cell.attendance ? ATTENDANCE_DOT[cell.attendance] : null;
    // 화면 낭독기용 한 줄 설명(눈으로는 점만 보인다)
    const spoken = [
        `${cell.day}일`,
        cell.closed ? "휴무" : null,
        att ? att.label : cell.isClass ? "수업" : null,
        cell.hasEvent ? "행사" : null,
    ].filter(Boolean).join(" ");
    return (
        <div
            className={`flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg ${
                cell.isToday ? "ring-2 ring-[var(--color-academy-primary)]" : ""
            } ${cell.isClass && !cell.closed ? "bg-[var(--color-academy-primary-soft)]" : ""}`}
        >
            <span className="sr-only">{spoken}</span>
            <span aria-hidden="true" className={`text-sm tabular-nums leading-none ${cell.closed ? "text-[var(--color-academy-muted)] line-through" : cell.isClass ? "font-bold text-[var(--color-academy-ink)]" : "text-[var(--color-academy-ink)]"}`}>
                {cell.day}
            </span>
            {cell.closed ? (
                <span aria-hidden="true" className="text-xs leading-none text-[var(--color-academy-danger)]">휴</span>
            ) : (
                <span className="flex h-1.5 items-center gap-0.5" aria-hidden="true">
                    {att ? <span className={`size-1.5 rounded-full ${att.dot}`} /> : cell.isClass ? <span className="size-1.5 rounded-full bg-[var(--color-academy-primary)]" /> : null}
                    {cell.hasEvent && <span className="size-1.5 rounded-full bg-[var(--color-academy-ink)]" />}
                </span>
            )}
        </div>
    );
}

export default function ScheduleHub({
    childList,
    selectedChildId,
    view,
    planReady = true,
    shuttleItems,
    driverContact = null,
}: {
    childList: ScheduleChild[];
    /** 지금 보고 있는 자녀(달력·출결·수강 반 기준) */
    selectedChildId: string;
    /** 한 달 달력 데이터(buildParentMonth 결과) */
    view: ParentMonthView;
    /** 이 달 수업일이 연간일정에서 계산됐는지 — false 면 «수업일 확정 전» 한 줄 */
    planReady?: boolean;
    shuttleItems: ParentShuttleOverviewItem[];
    driverContact?: { name: string; phone: string } | null;
}) {
    const child = childList.find((c) => c.id === selectedChildId) ?? childList[0];
    const childNames = Object.fromEntries(childList.map((c) => [c.id, c.name]));
    const enrollments = child?.enrollments ?? [];
    // 달 이동·자녀 바꾸기 주소 — 서버가 다시 그린다
    const hrefFor = (month: string, childId = child?.id ?? "") =>
        `/mypage/history?${childId ? `child=${encodeURIComponent(childId)}&` : ""}month=${month}`;
    const { summary } = view;

    return (
        <div className="space-y-3">
            {/* 제목 + 달 이동을 한 줄로(설명 문구 없음) */}
            <div className="flex items-center justify-between gap-2">
                <h1 className="text-2xl font-extrabold text-[var(--color-academy-ink)]">일정</h1>
                <nav aria-label="달 이동" className="flex items-center">
                    <Link href={hrefFor(shiftMonth(view.month, -1))} aria-label="이전 달" className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                        <Icon name="chevron_left" size={24} />
                    </Link>
                    <span className="whitespace-nowrap px-1 text-base font-bold tabular-nums text-[var(--color-academy-ink)]">{monthTitle(view.month)}</span>
                    <Link href={hrefFor(shiftMonth(view.month, 1))} aria-label="다음 달" className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                        <Icon name="chevron_right" size={24} />
                    </Link>
                </nav>
            </div>

            {/* 자녀 선택 — 둘 이상일 때만. 주소로 바꾼다(같은 달 유지) */}
            {childList.length > 1 && (
                <nav aria-label="자녀 선택" className="flex flex-wrap gap-2">
                    {childList.map((c) => (
                        <Link key={c.id} href={hrefFor(view.month, c.id)} aria-current={c.id === child?.id ? "page" : undefined} className={`academy-choice${c.id === child?.id ? " is-selected" : ""}`}>
                            {c.name}
                        </Link>
                    ))}
                </nav>
            )}

            {/* 한 달 달력 — 수업일(연한 바탕) · 출결 점 · 행사 점 · 휴무 */}
            <section aria-labelledby="schedule-records-heading" className="academy-panel scroll-mt-24 overflow-hidden">
                <h2 id="schedule-records-heading" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-academy-line)] px-3 py-2 text-sm">
                    <span className="font-bold text-[var(--color-academy-ink)]">수업 <span className="tabular-nums">{summary.classCount}</span>회</span>
                    <span className="whitespace-nowrap text-[var(--color-academy-muted)]">
                        출석 <span className="tabular-nums">{summary.present}</span>
                        {summary.late > 0 && <> · 지각 <span className="tabular-nums">{summary.late}</span></>}
                        {" · "}결석 <span className="tabular-nums">{summary.absent}</span>
                    </span>
                </h2>
                <div className="px-2 pb-2 pt-1">
                    <div className="grid grid-cols-7 text-center text-xs text-[var(--color-academy-muted)]" aria-hidden="true">
                        {WEEK_HEAD.map((d) => <span key={d} className="py-1">{d}</span>)}
                    </div>
                    <div className="grid grid-cols-7 gap-y-1">
                        {view.weeks.flat().map((cell, i) => (cell ? <DayCell key={cell.ymd} cell={cell} /> : <span key={`blank-${i}`} aria-hidden="true" />))}
                    </div>
                    {/* 범례 한 줄 */}
                    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs text-[var(--color-academy-muted)]">
                        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-[var(--color-academy-primary)]" />수업</span>
                        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-[var(--color-academy-success)]" />출석</span>
                        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-[var(--color-academy-warning)]" />지각</span>
                        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-[var(--color-academy-danger)]" />결석</span>
                        <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full bg-[var(--color-academy-ink)]" />행사</span>
                        <span className="inline-flex items-center gap-1"><span className="text-[var(--color-academy-danger)]">휴</span>휴무</span>
                    </p>
                    {!planReady && enrollments.length > 0 && (
                        <p className="mt-1 px-1 text-xs text-[var(--color-academy-muted)]">이 달 수업일은 연간일정 확정 후 보여요.</p>
                    )}
                </div>
            </section>

            {/* 이 달 행사·휴무 — 한 줄 행(날짜 · 제목) */}
            <section aria-labelledby="schedule-events-heading" className="academy-panel overflow-hidden">
                <h2 id="schedule-events-heading" className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold text-[var(--color-academy-ink)]">
                    <span>행사·휴무</span>
                    <span className="font-normal tabular-nums text-[var(--color-academy-muted)]">{view.events.length}</span>
                </h2>
                {view.events.length === 0 ? (
                    <p className="px-3 py-2 text-sm text-[var(--color-academy-muted)]">이 달 행사·휴무 없음</p>
                ) : (
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                        {view.events.map((ev) => (
                            <li key={`${ev.startYmd}-${ev.title}`} className="flex min-h-11 items-center gap-2 px-3 py-2">
                                <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-[var(--color-academy-muted)]">
                                    {shortDay(ev.startYmd)}{ev.endYmd !== ev.startYmd && `~${shortDay(ev.endYmd)}`}
                                </span>
                                <span className="min-w-0 flex-1 break-keep text-sm font-bold text-[var(--color-academy-ink)]">{ev.title}</span>
                                {ev.closed && <span className="shrink-0 rounded-full bg-[var(--color-academy-danger-soft)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-danger)]">휴무</span>}
                            </li>
                        ))}
                    </ul>
                )}
            </section>

            {/* 수강 반 — 한 줄 행(반 이름 · 요일 시간). 홈 «다음 수업»이 이 자리로 데려온다 */}
            {enrollments.length > 0 && (
                <section id="mypage-enrollments" aria-labelledby="schedule-enrollments-heading" className="academy-panel scroll-mt-24 overflow-hidden">
                    <h2 id="schedule-enrollments-heading" className="border-b border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold text-[var(--color-academy-ink)]">
                        수강 반 <span className="font-normal tabular-nums text-[var(--color-academy-muted)]">{enrollments.length}</span>
                    </h2>
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                        {enrollments.map((e) => (
                            <li key={e.id} className="flex min-h-11 items-center gap-2 px-3 py-2">
                                <div className="min-w-0 flex-1">
                                    <p className="break-keep text-sm font-bold text-[var(--color-academy-ink)]">{e.className}</p>
                                    {/* 승인된 반은 개시일 전에도 수강 중 — 첫 수업 전이면 개시일만 안내 */}
                                    {e.startsLater && <p className="text-xs font-bold text-[var(--color-academy-primary)]">{formatKstDate(e.startsOn, { month: "long", day: "numeric" })}부터 수업 시작</p>}
                                </div>
                                <span className="shrink-0 whitespace-nowrap text-right text-sm tabular-nums text-[var(--color-academy-muted)]">
                                    {DAY_LABELS[e.dayOfWeek] || e.dayOfWeek} {e.startTime}~{e.endTime}
                                </span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {/* 셔틀 배정 — 노선·정류장·차량·기사님 전화. 홈 «오늘 셔틀»이 이 자리로 데려온다 */}
            {shuttleItems.length > 0 && (
                <ParentShuttleDetail items={shuttleItems} driverContact={driverContact} childNames={childNames} />
            )}
        </div>
    );
}
