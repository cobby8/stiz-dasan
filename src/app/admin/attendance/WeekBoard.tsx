"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { todayKst } from "@/lib/datetime/kst";
import {
    boardStatusOf,
    countBoardStatuses,
    isWeekInRange,
    lessonDayLabel,
    mondayOf,
    shiftWeek,
    shortLessonName,
    showsIllness,
    weekRangeLabel,
    weekTitle,
    type BoardStatus,
} from "@/lib/attendance/weekBoard";
import type { ClassItem, StudentRecord } from "./AttendanceClient";

// 주간 API 응답 한 칸 = 그 주의 수업 1회
export type WeekLesson = {
    date: string;
    lesson: ClassItem;
    students: StudentRecord[];
};

// failedDays = 수업 목록을 못 불러온 날(그날만 «다시 시도», 나머지 날은 그대로 보인다)
type WeekPayload = { start: string; days: string[]; lessons: WeekLesson[]; failedDays?: string[] };

// 어떤 수업 1회를 가리키는 표시(패널 열기·저장 뒤 카드 갱신에 같이 쓴다)
export type LessonRef = { date: string; classId: string; sessionDateId: string | null };

function sameLesson(item: WeekLesson, ref: LessonRef | null) {
    return !!ref && item.date === ref.date && item.lesson.id === ref.classId
        && (item.lesson.sessionDateId ?? null) === (ref.sessionDateId ?? null);
}

// 상태 글자 배지 — 상태색 토큰(출석 초록·결석 빨강·지각 노랑, 미확인·예정은 회색 계열)
const STATUS_BADGE: Record<BoardStatus, { label: string; className: string }> = {
    PRESENT: { label: "출석", className: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" },
    ABSENT: { label: "결석", className: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
    LATE: { label: "지각", className: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
    UNMARKED: { label: "미확인", className: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" },
    PLANNED: { label: "예정", className: "bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)]" },
    // 앞으로 올 수업인데 결석 신고가 미리 들어온 아이
    REPORTED: { label: "결석 신고", className: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
};

// 머리줄 오른쪽 집계 순서(0건은 생략)
const COUNT_ORDER: { key: BoardStatus; label: string; className: string }[] = [
    { key: "PRESENT", label: "출석", className: "text-[var(--color-academy-success)]" },
    { key: "ABSENT", label: "결석", className: "text-[var(--color-academy-danger)]" },
    { key: "LATE", label: "지각", className: "text-[var(--color-academy-warning)]" },
    { key: "UNMARKED", label: "미확인", className: "text-[var(--color-academy-muted)]" },
    { key: "REPORTED", label: "결석 신고", className: "text-[var(--color-academy-danger)]" },
    { key: "PLANNED", label: "예정", className: "text-[var(--color-academy-neutral)]" },
];

function WeekBoardSkeleton() {
    // 로딩 뼈대: 카드 자리 6개(PC 3열 두 줄)
    return (
        <div className="grid grid-cols-1 items-start gap-2 md:grid-cols-2 lg:grid-cols-3" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="overflow-hidden rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                    <div className="h-11 animate-pulse bg-[var(--color-academy-soft)]" />
                    {Array.from({ length: 4 }).map((__, j) => (
                        <div key={j} className="h-9 animate-pulse border-t border-[var(--color-academy-line)]" />
                    ))}
                </div>
            ))}
        </div>
    );
}

export default function WeekBoard({
    weekStart,
    onWeekChange,
    onOpenLesson,
    activeLesson,
    refreshSignal,
}: {
    // 보던 주(월요일)는 부모가 들고 있다 — «날짜별»로 바꿨다 돌아와도 같은 주
    weekStart: string;
    onWeekChange: (monday: string) => void;
    // 카드를 누르면 → 부모가 기존 출결 입력 패널을 그 수업·날짜로 연다(그날 수업 목록도 같이 넘긴다)
    onOpenLesson: (date: string, lesson: ClassItem, dayLessons: ClassItem[]) => void;
    // 지금 패널에 열린 수업(카드 강조용)
    activeLesson: LessonRef | null;
    // 패널에서 저장하면 부모가 바꿔 주는 신호 → 그 카드만 다시 불러온다
    refreshSignal: (LessonRef & { n: number }) | null;
}) {
    const [lessons, setLessons] = useState<WeekLesson[]>([]);
    const [failedDays, setFailedDays] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(false);
    // 주를 빨리 넘기면 늦게 온 이전 주 응답이 덮어쓰지 않게 최신 요청만 반영
    const requestRef = useRef(0);
    const today = todayKst();
    const thisWeek = mondayOf(today);

    const loadWeek = useCallback(async (start: string) => {
        const requestId = ++requestRef.current;
        setLoading(true);
        setError(false);
        try {
            const res = await fetch(`/api/admin/attendance/week?start=${encodeURIComponent(start)}`, { cache: "no-store" });
            if (!res.ok) throw new Error("Failed to load week");
            const data = (await res.json()) as WeekPayload;
            if (requestId !== requestRef.current) return;
            setLessons(data.lessons);
            setFailedDays(data.failedDays ?? []);
        } catch (err) {
            console.error("Failed to load attendance week:", err);
            if (requestId === requestRef.current) setError(true);
        } finally {
            if (requestId === requestRef.current) setLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadWeek(weekStart);
    }, [weekStart, loadWeek]);

    // 저장 뒤: 그 카드 한 장만 기존 상세 API(입력 패널과 같은 조회)로 다시 받아 바꿔 끼운다
    useEffect(() => {
        if (!refreshSignal) return;
        const target = refreshSignal;
        const params = new URLSearchParams({ classId: target.classId, date: target.date });
        if (target.sessionDateId) params.set("sessionDateId", target.sessionDateId);
        let cancelled = false;
        fetch(`/api/admin/attendance?${params.toString()}`, { cache: "no-store" })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
                if (cancelled || !data) return;
                setLessons((prev) => prev.map((item) => (sameLesson(item, target) ? { ...item, students: data.students || [] } : item)));
            })
            .catch(() => { /* 실패하면 다음 주 이동·새로고침 때 맞춰진다 */ });
        return () => { cancelled = true; };
    }, [refreshSignal]);

    // 학생 줄을 키보드로도 열 수 있게(Enter·Space)
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, item: WeekLesson) {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openCard(item);
        }
    }

    const prevWeek = shiftWeek(weekStart, -1);
    const nextWeek = shiftWeek(weekStart, 1);

    function openCard(item: WeekLesson) {
        // 패널은 «그날 수업 목록»에서 수업을 찾으므로 같은 날 수업을 함께 넘긴다
        const dayLessons = lessons.filter((other) => other.date === item.date).map((other) => other.lesson);
        onOpenLesson(item.date, item.lesson, dayLessons);
    }

    return (
        <div>
            {/* 주 이동 줄: 이전 주 · «11월 2주차 (11/9~11/15)» · 다음 주 · 이번 주 */}
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <button type="button" disabled={!isWeekInRange(prevWeek)} onClick={() => onWeekChange(prevWeek)} className="academy-button-secondary academy-button-sm">
                    ‹ 이전 주
                </button>
                <h2 className="min-w-0 text-base font-semibold text-[var(--color-academy-ink)]">
                    {weekTitle(weekStart)}{" "}
                    <span className="text-sm font-normal tabular-nums text-[var(--color-academy-muted)]">({weekRangeLabel(weekStart)})</span>
                </h2>
                <button type="button" disabled={!isWeekInRange(nextWeek)} onClick={() => onWeekChange(nextWeek)} className="academy-button-secondary academy-button-sm">
                    다음 주 ›
                </button>
                {weekStart !== thisWeek && (
                    <button type="button" onClick={() => onWeekChange(thisWeek)} className="academy-button-text academy-button-sm">
                        이번 주
                    </button>
                )}
                <span className="ml-auto text-sm text-[var(--color-academy-muted)]">
                    {loading ? "불러오는 중..." : <>수업 <span className="tabular-nums">{lessons.length}</span>회</>}
                </span>
            </div>

            {/* 수업 목록을 못 불러온 날: 그 날만 한 줄 안내 + 다시 시도(나머지 날 카드는 그대로) */}
            {!loading && !error && failedDays.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] px-3 py-1 text-sm text-[var(--color-academy-danger)]">
                    <span className="tabular-nums">{failedDays.map((d) => lessonDayLabel(d)).join(", ")} 수업을 불러오지 못함</span>
                    <button type="button" onClick={() => loadWeek(weekStart)} className="academy-button-secondary academy-button-sm ml-auto">
                        다시 시도
                    </button>
                </div>
            )}

            {loading && lessons.length === 0 ? (
                <WeekBoardSkeleton />
            ) : error ? (
                <div className="rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-4 text-center">
                    <p className="text-sm font-semibold text-[var(--color-academy-danger)]">이 주의 출결을 불러오지 못했습니다.</p>
                    <button type="button" onClick={() => loadWeek(weekStart)} className="academy-button-secondary mt-3">
                        다시 시도
                    </button>
                </div>
            ) : lessons.length === 0 && failedDays.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    이 주에는 수업이 없습니다.
                </div>
            ) : lessons.length === 0 ? null : (
                // 원생 «반별» 보기와 같은 그리드: 휴대폰 1열 · 태블릿 2열 · PC 3열. 다른 주로 넘기는 동안은 흐리게
                <div className={`grid grid-cols-1 items-start gap-2 md:grid-cols-2 lg:grid-cols-3 ${loading ? "opacity-60" : ""}`}>
                    {lessons.map((item) => {
                        const { date, lesson, students } = item;
                        const counts = countBoardStatuses(students, date, today);
                        const active = sameLesson(item, activeLesson);
                        const isToday = date === today;
                        const head = [shortLessonName(lesson.name, date), `${lessonDayLabel(date)} ${lesson.startTime}`, lesson.coachName]
                            .filter(Boolean)
                            .join(" · ");
                        return (
                            <section
                                key={`${date}:${lesson.lessonKey || lesson.sessionDateId || lesson.id}`}
                                className={`overflow-hidden rounded-lg border bg-[var(--color-academy-surface)] ${active
                                    ? "border-[var(--color-academy-secondary-strong)] ring-1 ring-[var(--color-academy-secondary-strong)]"
                                    : "border-[var(--color-academy-line)]"}`}
                            >
                                {/* 머리줄: 누르면 그 수업 출결 입력 패널(키보드는 이 버튼으로) */}
                                <button
                                    type="button"
                                    onClick={() => openCard(item)}
                                    aria-label={`${head} 출결 입력`}
                                    title={lesson.name}
                                    className={`flex min-h-11 w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1 text-left text-sm transition hover:bg-[var(--color-academy-primary-soft)] ${isToday ? "bg-[var(--color-academy-secondary-soft)]" : "bg-[var(--color-academy-soft)]"}`}
                                >
                                    <span className="font-semibold text-[var(--color-academy-ink)]">{shortLessonName(lesson.name, date)}</span>
                                    <span className="tabular-nums text-xs text-[var(--color-academy-muted)]">
                                        {lessonDayLabel(date)} {lesson.startTime}{lesson.coachName ? ` · ${lesson.coachName}` : ""}
                                    </span>
                                    {lesson.kind === "SEASONAL" && (
                                        <span className="rounded-full bg-[var(--color-academy-neutral-soft)] px-1.5 text-xs text-[var(--color-academy-neutral)]">특강</span>
                                    )}
                                    {/* 집계: 0건은 생략. 학생이 없으면 «원생 없음» */}
                                    <span className="ml-auto flex flex-wrap gap-x-1.5 text-xs tabular-nums">
                                        {students.length === 0 ? (
                                            <span className="text-[var(--color-academy-muted)]">원생 없음</span>
                                        ) : (
                                            COUNT_ORDER.filter((c) => counts[c.key] > 0).map((c) => (
                                                <span key={c.key} className={c.className}>{c.label} {counts[c.key]}</span>
                                            ))
                                        )}
                                    </span>
                                </button>
                                {/* 학생 한 줄씩: 이름 + 상태 글자 배지. 줄을 눌러도 같은 패널이 열린다 */}
                                {students.length > 0 && (
                                    <ul className="divide-y divide-[var(--color-academy-line)] border-t border-[var(--color-academy-line)]">
                                        {students.map((s) => {
                                            const status = boardStatusOf(s.status, date, today, !!s.absenceReport);
                                            const badge = STATUS_BADGE[status];
                                            return (
                                                <li
                                                    key={s.studentId}
                                                    tabIndex={0}
                                                    role="button"
                                                    aria-label={`${s.studentName} ${badge.label} — ${head} 출결 입력`}
                                                    onClick={() => openCard(item)}
                                                    onKeyDown={(event) => handleRowKeyDown(event, item)}
                                                    className="flex min-h-11 cursor-pointer items-center gap-2 px-3 text-sm hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                                                >
                                                    <span className="min-w-0 break-keep text-[var(--color-academy-ink)]">{s.studentName}</span>
                                                    {/* 질병·부상: 입력 패널과 같은 기준(결석 + 정규반 + 신고 사유) */}
                                                    {showsIllness(s, lesson.sessionDateId) && (
                                                        <span className="text-xs text-[var(--color-academy-muted)]">질병·부상</span>
                                                    )}
                                                    {s.makeup && (
                                                        <span className="text-xs text-[var(--color-academy-secondary-ink)]">보강</span>
                                                    )}
                                                    <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
                                                        {badge.label}
                                                    </span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </section>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
