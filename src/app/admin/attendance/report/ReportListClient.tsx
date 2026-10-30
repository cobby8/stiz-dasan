"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { addDaysKst, kstDow, kstLabel, toKstYmd, todayKst } from "@/lib/datetime/kst";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import ListViewToggle, { useRememberedListView } from "@/components/admin/list/ListViewToggle";
import StatusCountChips from "@/components/admin/list/StatusCountChips";

type ReportSession = {
    id: string;
    classId: string;
    date: string;
    topic: string | null;
    published: boolean;
    publishedAt: string | null;
    className: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    programName: string | null;
    coachName: string | null;
    attendanceCount: number;
};

type ReportListPayload = {
    sessions: ReportSession[];
};

// 보기 전환 «날짜별 | 목록» — 기본은 날짜별 묶음, 선택은 브라우저에 기억
const REPORT_VIEW_STORAGE_KEY = "admin-report-list-view-mode";
const REPORT_VIEW_VALUES = ["date", "list"] as const;
type ReportViewMode = (typeof REPORT_VIEW_VALUES)[number];
const REPORT_VIEW_OPTIONS = [
    { value: "date", label: "날짜별", icon: "calendar_view_week" },
    { value: "list", label: "목록", icon: "view_list" },
] as const;

// 발행 상태 칩(이미 받아오는 published 값만으로 센다)
const PUBLISH_ALL = "ALL";
const PUBLISH_CHIPS = [
    { value: "DRAFT", label: "미발행" },
    { value: "PUBLISHED", label: "발행됨" },
] as const;

// 날짜 묶음: 오늘 / 이번 주(월~일) / 지난 주 / 이전 (+ 혹시 있는 앞날짜는 «예정»)
type DateGroupKey = "upcoming" | "today" | "thisWeek" | "lastWeek" | "older";
const DATE_GROUP_LABELS: Record<DateGroupKey, string> = {
    upcoming: "예정",
    today: "오늘",
    thisWeek: "이번 주",
    lastWeek: "지난 주",
    older: "이전",
};
const DATE_GROUP_ORDER: DateGroupKey[] = ["upcoming", "today", "thisWeek", "lastWeek", "older"];

// 수업 날짜(YYYY-MM-DD)가 어느 묶음인지. 주 시작은 월요일, 계산은 KST 달력 모듈로만 한다
function dateGroupOf(ymd: string, today: string): DateGroupKey {
    const weekStart = addDaysKst(today, -((kstDow(today) + 6) % 7));
    const lastWeekStart = addDaysKst(weekStart, -7);
    if (ymd > today) return "upcoming";
    if (ymd === today) return "today";
    if (ymd >= weekStart) return "thisWeek";
    if (ymd >= lastWeekStart) return "lastWeek";
    return "older";
}

function PublishBadge({ published }: { published: boolean }) {
    return published ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-success-soft)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-success)]">
            <span className="material-symbols-outlined text-sm" aria-hidden="true">check_circle</span>
            발행됨
        </span>
    ) : (
        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-academy-soft)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-muted)]">
            <span className="material-symbols-outlined text-sm" aria-hidden="true">edit_note</span>
            미발행
        </span>
    );
}

function ReportListLoadingFallback() {
    return (
        <div className="mx-auto max-w-5xl">
            <div className="mb-3 h-8 w-48 animate-pulse rounded bg-[var(--color-academy-soft)]" />
            <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                {Array.from({ length: 8 }).map((_, index) => (
                    <div key={index} className="h-11 animate-pulse border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] last:border-b-0" />
                ))}
            </div>
        </div>
    );
}

function ReportListErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="mx-auto max-w-5xl rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-4 text-center">
            <p className="text-sm font-bold text-[var(--color-academy-danger)]">수업 리포트 목록을 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-3 min-h-11 rounded-lg bg-[var(--color-academy-danger)] px-4 text-sm font-bold text-white"
            >
                다시 시도
            </button>
        </div>
    );
}

export default function ReportListClient({ sessions: initialSessions }: { sessions?: ReportSession[] }) {
    const hasInitialData = initialSessions !== undefined;
    const [sessions, setSessions] = useState<ReportSession[]>(initialSessions ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);
    // 발행 상태 칩 선택값, 행 클릭 상세 패널 대상
    const [publishFilter, setPublishFilter] = useState<string>(PUBLISH_ALL);
    const [detailSessionId, setDetailSessionId] = useState<string | null>(null);
    const [viewMode, changeViewMode] = useRememberedListView<ReportViewMode>(REPORT_VIEW_STORAGE_KEY, REPORT_VIEW_VALUES, "date");

    const loadSessions = useCallback(async () => {
        setLoading(true);
        setLoadError(false);

        try {
            const response = await fetch("/api/admin/attendance/report?limit=50", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load report sessions.");
            }

            const data = (await response.json()) as ReportListPayload;
            setSessions(data.sessions);
        } catch (error) {
            console.error("Failed to load report sessions:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadSessions();
    }, [hasInitialData, loadSessions]);

    // 수업 날짜를 KST 달력 날짜로 한 번만 바꿔 둔다(묶음·표시 모두 이 값)
    const today = todayKst();
    const visibleSessions = useMemo(
        () => sessions.filter((session) =>
            publishFilter === PUBLISH_ALL
            || (publishFilter === "PUBLISHED" ? session.published : !session.published)),
        [sessions, publishFilter],
    );
    const dateGroups = useMemo(() => {
        const buckets = new Map<DateGroupKey, ReportSession[]>();
        for (const session of visibleSessions) {
            const key = dateGroupOf(toKstYmd(session.date), today);
            const bucket = buckets.get(key) ?? [];
            bucket.push(session);
            buckets.set(key, bucket);
        }
        // 서버가 날짜 내림차순으로 주므로 묶음 안 순서는 그대로 둔다
        return DATE_GROUP_ORDER
            .filter((key) => buckets.has(key))
            .map((key) => ({ key, label: DATE_GROUP_LABELS[key], items: buckets.get(key)! }));
    }, [visibleSessions, today]);

    const publishChipItems = PUBLISH_CHIPS.map((chip) => ({
        value: chip.value,
        label: chip.label,
        count: sessions.filter((session) => (chip.value === "PUBLISHED" ? session.published : !session.published)).length,
    }));

    const detailSession = detailSessionId ? sessions.find((session) => session.id === detailSessionId) ?? null : null;

    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailSessionId(id);
        }
    }

    // 표 칸 수(날짜별 머리줄 colSpan 용)
    const columnCount = 8;

    // 한 줄 행: 날짜 | 반 | 시간 | 코치 | 주제 | 출석 | 상태 | 관리. 긴 주제·프로그램은 상세 패널에서 전부
    function renderSessionRow(session: ReportSession) {
        return (
            <tr
                key={session.id}
                tabIndex={0}
                aria-label={`${session.className} ${kstLabel(session.date)} 리포트 요약 보기`}
                onClick={() => setDetailSessionId(session.id)}
                onKeyDown={(event) => handleRowKeyDown(event, session.id)}
                className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
            >
                {/* 날짜: «10/30(목)» 오른쪽 정렬 */}
                <td className="admin-cell-num px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{kstLabel(session.date)}</td>
                <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{session.className}</td>
                <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{session.startTime}~{session.endTime}</td>
                <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] lg:table-cell">{session.coachName || "-"}</td>
                <td className="hidden px-2 py-1.5 text-[var(--color-academy-ink)] lg:table-cell">
                    {session.topic || <span className="text-[var(--color-academy-muted)]">미작성</span>}
                </td>
                <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{session.attendanceCount}명</td>
                <td className="px-2 py-1.5"><PublishBadge published={session.published} /></td>
                {/* 관리: 편집 페이지로(행 클릭=요약 패널과 겹치지 않게 전파 차단) */}
                <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                    <Link
                        href={`/admin/attendance/report/${session.id}`}
                        prefetch={false}
                        className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-3 text-xs font-bold text-[var(--color-academy-on-primary)] transition hover:bg-[var(--color-academy-primary-hover)]"
                    >
                        <span className="material-symbols-outlined text-sm" aria-hidden="true">edit</span>
                        편집
                    </Link>
                </td>
            </tr>
        );
    }

    if (loading && sessions.length === 0) {
        return <ReportListLoadingFallback />;
    }

    if (loadError && sessions.length === 0) {
        return <ReportListErrorState onRetry={loadSessions} />;
    }

    return (
        <div className="mx-auto max-w-5xl">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="text-2xl font-extrabold text-[var(--color-academy-ink)]">수업 리포트 관리</h1>
                <p className="text-xs text-[var(--color-academy-muted)]">출결이 기록된 최근 수업 <span className="tabular-nums">{sessions.length}</span>개</p>
            </div>

            {sessions.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    출결이 기록된 수업이 없습니다.
                </div>
            ) : (
                <>
                    {/* 발행 상태 칩(누르면 그 상태만, 다시 누르면 전체) + 보기 전환(날짜별 | 목록) */}
                    <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <StatusCountChips
                            ariaLabel="리포트 발행 상태별 건수"
                            items={publishChipItems}
                            selected={publishFilter}
                            onSelect={setPublishFilter}
                            allValue={PUBLISH_ALL}
                        />
                        <ListViewToggle
                            value={viewMode}
                            options={REPORT_VIEW_OPTIONS}
                            ariaLabel="리포트 보기 방식"
                            onChange={changeViewMode}
                        />
                    </div>

                    {visibleSessions.length === 0 ? (
                        <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                            조건에 맞는 리포트가 없습니다.
                        </div>
                    ) : (
                        <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                            <div className="overflow-x-auto">
                                {/* admin-list-table: 글자 왼쪽·날짜/시간/인원 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
                                <table className="admin-list-table w-full border-collapse text-sm">
                                    <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                                        <tr>
                                            <th className="admin-cell-num px-2 py-2">날짜</th>
                                            <th className="px-2 py-2">반</th>
                                            <th className="admin-cell-num hidden px-2 py-2 md:table-cell">시간</th>
                                            <th className="hidden px-2 py-2 lg:table-cell">코치</th>
                                            <th className="hidden px-2 py-2 lg:table-cell">주제</th>
                                            <th className="admin-cell-num px-2 py-2">출석</th>
                                            <th className="px-2 py-2">상태</th>
                                            <th className="admin-cell-center px-2 py-2">관리</th>
                                        </tr>
                                    </thead>
                                    {viewMode === "date" ? (
                                        // 날짜별 보기: 머리줄 «오늘 · 3개 · 미발행 1» 아래 그 기간 수업들
                                        dateGroups.map((group) => {
                                            const draftCount = group.items.filter((session) => !session.published).length;
                                            return (
                                                <tbody key={group.key} className="divide-y divide-[var(--color-academy-line)]">
                                                    <tr>
                                                        <th colSpan={columnCount} scope="rowgroup" className="bg-[var(--color-academy-soft)] px-2 py-1.5 text-xs font-black text-[var(--color-academy-ink)]">
                                                            {group.label} · <span className="tabular-nums">{group.items.length}</span>개
                                                            {draftCount > 0 && <> · 미발행 <span className="tabular-nums">{draftCount}</span></>}
                                                        </th>
                                                    </tr>
                                                    {group.items.map(renderSessionRow)}
                                                </tbody>
                                            );
                                        })
                                    ) : (
                                        <tbody className="divide-y divide-[var(--color-academy-line)]">{visibleSessions.map(renderSessionRow)}</tbody>
                                    )}
                                </table>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* 행 클릭 상세 패널 — 데스크톱 오른쪽 패널 / 모바일 하단 시트. 이미 불러온 값만 보여 준다(새 조회 없음) */}
            {detailSession && (() => {
                const d = detailSession;
                // 값이 있는 줄만 보인다. 긴 주제·프로그램 이름도 말줄임 없이 전부
                const rows: { label: string; value: React.ReactNode }[] = [
                    { label: "날짜", value: <span className="tabular-nums">{kstLabel(d.date)}</span> },
                    { label: "시간", value: <span className="tabular-nums">{d.startTime}~{d.endTime}</span> },
                    { label: "프로그램", value: d.programName },
                    { label: "코치", value: d.coachName },
                    { label: "주제", value: d.topic || "미작성" },
                    { label: "출석", value: <span className="tabular-nums">{d.attendanceCount}명</span> },
                    { label: "발행일", value: d.published && d.publishedAt ? <span className="tabular-nums">{kstLabel(d.publishedAt)}</span> : null },
                ].filter((row) => row.value !== null && row.value !== undefined && row.value !== "");
                return (
                    <ListDetailPanel onClose={() => setDetailSessionId(null)} titleId="report-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                        <div className="mb-4 flex items-center gap-2">
                            <h3 id="report-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{d.className}</h3>
                            <PublishBadge published={d.published} />
                            <button
                                type="button"
                                onClick={() => setDetailSessionId(null)}
                                aria-label="닫기"
                                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="material-symbols-outlined" aria-hidden="true">close</span>
                            </button>
                        </div>
                        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                            {rows.map((row) => (
                                <div key={row.label} className="contents">
                                    <dt className="font-bold text-[var(--color-academy-muted)]">{row.label}</dt>
                                    <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{row.value}</dd>
                                </div>
                            ))}
                        </dl>
                        <div className="mt-5 flex flex-wrap gap-2">
                            <Link
                                href={`/admin/attendance/report/${d.id}`}
                                prefetch={false}
                                className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]"
                            >
                                <span className="material-symbols-outlined text-lg" aria-hidden="true">edit</span>
                                리포트 편집
                            </Link>
                        </div>
                    </ListDetailPanel>
                );
            })()}
        </div>
    );
}
