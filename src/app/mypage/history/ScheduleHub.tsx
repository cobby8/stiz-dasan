import Link from "next/link";
import type { ReactNode } from "react";
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

// 달력 표시 — 색만으로 구분하지 않는다(색약·작은 화면). 상태마다 «모양»이 다르다 (2026-11-09 원장 «색상 구분이 잘 안 돼»).
//   출석 = 초록 채운 점 · 지각 = 주황 빈 고리 · 결석 = 빨강 × · 행사 = 파랑 별
//   수업 예정 = 연한 청회색 칸 · 휴무 = 회색 칸 + «휴» · 오늘 = 굵은 검정 테두리
// 색은 academy-theme.css 의 --color-academy-cal-* 토큰만 쓴다(하드코딩 색 없음).
type MarkKind = "PRESENT" | "LATE" | "ABSENT" | "EVENT";

const MARK_LABEL: Record<MarkKind, string> = { PRESENT: "출석", LATE: "지각", ABSENT: "결석", EVENT: "행사" };

/** 칸 아래 표시 하나 — 달력 칸과 범례가 같은 부품을 쓴다(모양이 어긋나지 않게) */
function Mark({ kind }: { kind: MarkKind }) {
    if (kind === "PRESENT") {
        // 채운 동그라미
        return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full bg-[var(--color-academy-cal-present)]" />;
    }
    if (kind === "LATE") {
        // 속이 빈 고리 — 채운 출석 점과 모양으로 갈린다
        return <span aria-hidden="true" className="inline-block size-2.5 shrink-0 rounded-full border-2 border-[var(--color-academy-cal-late)]" />;
    }
    if (kind === "ABSENT") {
        // 굵은 × — 점이 아니라 선이라 빨강·초록을 못 가려도 구분된다
        return <span aria-hidden="true" className="material-symbols-outlined shrink-0 font-bold leading-none text-[var(--color-academy-cal-absent)]" style={{ fontSize: "16px", fontVariationSettings: "'wght' 700" }}>close</span>;
    }
    // 행사 = 채운 별
    return <span aria-hidden="true" className="material-symbols-outlined shrink-0 leading-none text-[var(--color-academy-cal-event)]" style={{ fontSize: "13px", fontVariationSettings: "'FILL' 1" }}>star</span>;
}

/** 달력 한 칸 — 날짜 숫자 + 아래 표시(출결 · 행사). 수업일은 칸 바탕, 휴무는 회색 칸 «휴» */
function DayCell({ cell }: { cell: MonthCell }) {
    const att = cell.attendance as MarkKind | null;
    // 화면 낭독기용 한 줄 설명(눈으로는 모양만 보인다)
    const spoken = [
        `${cell.day}일`,
        cell.isToday ? "오늘" : null,
        cell.closed ? "휴무" : null,
        att ? MARK_LABEL[att] : cell.isClass ? "수업" : null,
        cell.hasEvent ? "행사" : null,
    ].filter(Boolean).join(" ");
    // 칸 바탕: 휴무(회색) > 수업일(연한 청회색 + 얇은 테두리) > 기본(없음)
    const tone = cell.closed
        ? "bg-[var(--color-academy-cal-closed-soft)]"
        : cell.isClass
            ? "bg-[var(--color-academy-cal-class-soft)] border border-[var(--color-academy-cal-class-line)]"
            : "";
    return (
        <div
            className={`relative flex h-11 flex-col items-center justify-center gap-0.5 rounded-lg ${tone} ${
                // 오늘 = 굵은 검정 테두리(상태색과 겹치지 않는 색)
                cell.isToday ? "ring-2 ring-inset ring-[var(--color-academy-cal-today)]" : ""
            }`}
        >
            <span className="sr-only">{spoken}</span>
            <span aria-hidden="true" className={`text-sm tabular-nums leading-none ${
                cell.closed
                    ? "text-[var(--color-academy-cal-closed)]"
                    : cell.isClass || cell.isToday
                        ? "font-bold text-[var(--color-academy-ink)]"
                        : "text-[var(--color-academy-ink)]"
            }`}>
                {cell.day}
            </span>
            {cell.closed ? (
                <span aria-hidden="true" className="text-xs font-bold leading-none text-[var(--color-academy-cal-closed)]">휴</span>
            ) : (
                <span className="flex h-3.5 items-center gap-0.5" aria-hidden="true">
                    {att && <Mark kind={att} />}
                    {cell.hasEvent && <Mark kind="EVENT" />}
                </span>
            )}
        </div>
    );
}

/** 범례 한 칸 — 표시 + 글자 */
function LegendItem({ children, label }: { children: ReactNode; label: string }) {
    return <span className="inline-flex items-center gap-1 whitespace-nowrap">{children}{label}</span>;
}

/**
 * 한 달 달력 칸(일정 탭·수업 탭이 같이 쓴다 — 2026-11-10 수업 탭에 붙임).
 * monthNav 를 주면 제목 줄에 달 이동(‹ 2026년 11월 ›)을 함께 둔다(수업 탭). 일정 탭은 화면 제목 줄에 이미 있다.
 */
export function MonthCalendar({
    view,
    planReady = true,
    hasEnrollments,
    monthNav,
}: {
    view: ParentMonthView;
    planReady?: boolean;
    hasEnrollments: boolean;
    monthNav?: { prevHref: string; nextHref: string };
}) {
    const { summary } = view;
    const summaryLine = (
        <>
            <span className="font-bold text-[var(--color-academy-ink)]">수업 <span className="tabular-nums">{summary.classCount}</span>회</span>
            <span className="whitespace-nowrap text-[var(--color-academy-muted)]">
                출석 <span className="tabular-nums">{summary.present}</span>
                {summary.late > 0 && <> · 지각 <span className="tabular-nums">{summary.late}</span></>}
                {" · "}결석 <span className="tabular-nums">{summary.absent}</span>
            </span>
        </>
    );
    return (
            <section aria-labelledby="schedule-records-heading" className="academy-panel scroll-mt-24 overflow-hidden">
                {monthNav ? (
                    // 달 이동 + 이 달 요약을 한 줄로(수업 탭)
                    <div className="flex flex-wrap items-center justify-between gap-x-2 border-b border-[var(--color-academy-line)] pr-3">
                        <nav aria-label="달 이동" className="flex items-center">
                            <Link href={monthNav.prevHref} scroll={false} aria-label="이전 달" className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                                <Icon name="chevron_left" size={22} />
                            </Link>
                            <span className="whitespace-nowrap text-sm font-bold tabular-nums text-[var(--color-academy-ink)]">{monthTitle(view.month)}</span>
                            <Link href={monthNav.nextHref} scroll={false} aria-label="다음 달" className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                                <Icon name="chevron_right" size={22} />
                            </Link>
                        </nav>
                        <h2 id="schedule-records-heading" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">{summaryLine}</h2>
                    </div>
                ) : (
                    <h2 id="schedule-records-heading" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--color-academy-line)] px-3 py-2 text-sm">
                        {summaryLine}
                    </h2>
                )}
                <div className="px-2 pb-2 pt-1">
                    <div className="grid grid-cols-7 text-center text-xs text-[var(--color-academy-muted)]" aria-hidden="true">
                        {WEEK_HEAD.map((d) => <span key={d} className="py-1">{d}</span>)}
                    </div>
                    <div className="grid grid-cols-7 gap-y-1">
                        {view.weeks.flat().map((cell, i) => (cell ? <DayCell key={cell.ymd} cell={cell} /> : <span key={`blank-${i}`} aria-hidden="true" />))}
                    </div>
                    {/* 범례 한 줄 — 달력 칸과 같은 부품·같은 토큰 */}
                    <p className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 px-1 text-xs text-[var(--color-academy-muted)]">
                        <LegendItem label="수업"><span aria-hidden="true" className="inline-block size-3.5 rounded border border-[var(--color-academy-cal-class-line)] bg-[var(--color-academy-cal-class-soft)]" /></LegendItem>
                        <LegendItem label="출석"><Mark kind="PRESENT" /></LegendItem>
                        <LegendItem label="지각"><Mark kind="LATE" /></LegendItem>
                        <LegendItem label="결석"><Mark kind="ABSENT" /></LegendItem>
                        <LegendItem label="행사"><Mark kind="EVENT" /></LegendItem>
                        <LegendItem label="휴무"><span aria-hidden="true" className="inline-flex size-4 items-center justify-center rounded bg-[var(--color-academy-cal-closed-soft)] text-xs font-bold leading-none text-[var(--color-academy-cal-closed)]">휴</span></LegendItem>
                        <LegendItem label="오늘"><span aria-hidden="true" className="inline-block size-3.5 rounded ring-2 ring-inset ring-[var(--color-academy-cal-today)]" /></LegendItem>
                    </p>
                    {!planReady && hasEnrollments && (
                        <p className="mt-1 px-1 text-xs text-[var(--color-academy-muted)]">이 달 수업일은 연간일정 확정 후 보여요.</p>
                    )}
                </div>
            </section>
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

            {/* 한 달 달력 — 수업일(연한 칸) · 출결(점·고리·×) · 행사(별) · 휴무(회색 «휴») · 오늘(굵은 테두리) */}
            <MonthCalendar view={view} planReady={planReady} hasEnrollments={enrollments.length > 0} />

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
                                {/* 휴무 꼬리표 — 달력 «휴» 칸과 같은 회색 */}
                                {ev.closed && <span className="shrink-0 rounded-full bg-[var(--color-academy-cal-closed-soft)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-cal-closed)]">휴무</span>}
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
                                    {e.startsLater && <p className="text-xs font-bold text-[var(--color-academy-info)]">{formatKstDate(e.startsOn, { month: "long", day: "numeric" })}부터 수업 시작</p>}
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
