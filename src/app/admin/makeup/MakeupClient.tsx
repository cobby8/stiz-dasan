"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    bookMakeupSession,
    cancelMakeupSession,
    loadMakeupSlotAvailability,
    updateMakeupStatus,
} from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import AdminPanelActions from "@/components/admin/AdminPanelActions";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import ListViewToggle, { useRememberedListView } from "@/components/admin/list/ListViewToggle";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
// 보강일 묶음(오늘/이번 주/다음 주/이후/지난 건)은 결석 신고 화면과 같은 공용 계산을 쓴다
import { groupByUpcomingDate, type UpcomingDateGroupKey } from "@/components/admin/list/upcomingDateGroups";
// 날짜 표시는 KST 달력 모듈로만 계산한다(서버 UTC / PC KST 차이로 하루 밀리는 사고 방지)
import { kstLabel, toKstYmd, todayKst } from "@/lib/datetime/kst";
// 잔여석 표시/판정은 서버(queries.ts)와 같은 계산식을 쓴다 — 화면만 낙관 표시하는 사고 방지
import { formatSeatLabel, isMakeupSlotFull } from "@/lib/makeup/capacity";

// ── 타입 정의 ──────────────────────────────────────────────────────────────
type MakeupItem = {
    id: string;
    studentId: string;
    originalClassId: string;
    originalDate: string;
    makeupClassId: string;
    makeupDate: string;
    status: string;
    requestId: string | null;
    createdAt: string;
    updatedAt: string;
    studentName: string;
    originalClassName: string;
    originalDay: string;
    makeupClassName: string;
    makeupDay: string;
    makeupStart: string;
    makeupEnd: string;
    programName: string;
};

type Student = {
    id: string;
    name: string;
    parent?: { name: string | null };
};

type ClassItem = {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    capacity: number;
    programId: string;
    program: { id: string; name: string } | null;
};

type MakeupSlot = {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    capacity: number;
    enrolled: number;
    bookedMakeups: number;
    remaining: number;
};

type MakeupPayload = {
    sessions: MakeupItem[];
    classes: ClassItem[];
};

// 요일 한글 변환
const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 상태 라벨 + 색상(CSS 변수 토큰 — 다크 모드도 토큰이 알아서 바뀐다)
const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
    BOOKED:    { label: "예약", color: "text-[var(--color-academy-primary)]", bg: "bg-[var(--color-academy-primary-soft)]" },
    ATTENDED:  { label: "출석", color: "text-[var(--color-academy-success)]", bg: "bg-[var(--color-academy-success-soft)]" },
    CANCELLED: { label: "취소", color: "text-[var(--color-academy-muted)]", bg: "bg-[var(--color-academy-soft)]" },
    NO_SHOW:   { label: "노쇼", color: "text-[var(--color-academy-danger)]", bg: "bg-[var(--color-academy-danger-soft)]" },
};

// 상태 칩 목록 — 칩은 예전 상태 탭과 같은 statusFilter 값을 쓴다(다시 누르면 "ALL" = 전체)
const STATUS_ALL = "ALL";
const STATUS_TABS = [
    { key: "BOOKED", label: "예약" },
    { key: "ATTENDED", label: "출석" },
    { key: "CANCELLED", label: "취소" },
    { key: "NO_SHOW", label: "노쇼" },
];

// 보기 전환 «날짜별 | 목록» — 기본은 보강일 기준 날짜별 묶음, 선택은 브라우저에 기억
const MAKEUP_VIEW_STORAGE_KEY = "admin-makeup-view-mode";
const MAKEUP_VIEW_VALUES = ["date", "list"] as const;
type MakeupViewMode = (typeof MAKEUP_VIEW_VALUES)[number];
const MAKEUP_VIEW_OPTIONS = [
    { value: "date", label: "날짜별", icon: "calendar_view_week" },
    { value: "list", label: "목록", icon: "view_list" },
] as const;

// 보강일 묶음 이름: 오늘 / 이번 주 / 다음 주 / 이후 / 지난 보강 (앞으로 할 보강이 먼저 보이게)
const MAKEUP_DATE_GROUP_LABELS: Record<UpcomingDateGroupKey, string> = {
    today: "오늘",
    thisWeek: "이번 주",
    nextWeek: "다음 주",
    later: "이후",
    past: "지난 보강",
};

function MakeupLoadingFallback() {
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div className="space-y-2">
                    <div className="h-8 w-32 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    <div className="h-4 w-72 rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
                </div>
                <div className="h-10 w-28 rounded-lg bg-gray-200 dark:bg-gray-700 animate-pulse" />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div
                        key={index}
                        className="h-24 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 animate-pulse"
                    />
                ))}
            </div>
            <div className="h-10 w-80 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden">
                {Array.from({ length: 8 }).map((_, index) => (
                    <div
                        key={index}
                        className="h-14 border-b border-gray-100 dark:border-gray-700 last:border-b-0 bg-gray-50/60 dark:bg-gray-900/40 animate-pulse"
                    />
                ))}
            </div>
        </div>
    );
}

function MakeupErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-100 bg-white p-8 text-center shadow-sm dark:border-red-900/40 dark:bg-gray-800">
            <span className="material-symbols-outlined mb-3 text-4xl text-red-500">error</span>
            <p className="font-bold text-gray-900 dark:text-white">보강 예약 정보를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-xl bg-brand-orange-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
            >
                다시 시도
            </button>
        </div>
    );
}

export default function MakeupClient({
    sessions: initialSessions,
    classes: initialClasses,
}: {
    sessions?: MakeupItem[];
    classes?: ClassItem[];
}) {
    const hasInitialData = Boolean(initialSessions && initialClasses);
    const [sessions, setSessions] = useState<MakeupItem[]>(initialSessions ?? []);
    const [classes, setClasses] = useState<ClassItem[]>(initialClasses ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [statusFilter, setStatusFilter] = useState("ALL");
    const [showBookModal, setShowBookModal] = useState(false);
    const [students, setStudents] = useState<Student[]>([]);
    const [studentsLoaded, setStudentsLoaded] = useState(false);
    const [studentsLoading, setStudentsLoading] = useState(false);
    const [studentsError, setStudentsError] = useState<string | null>(null);
    // 행 클릭 상세 패널 대상, 보기 방식(날짜별 | 목록)
    const [detailId, setDetailId] = useState<string | null>(null);
    const [viewMode, setViewMode] = useRememberedListView<MakeupViewMode>(MAKEUP_VIEW_STORAGE_KEY, MAKEUP_VIEW_VALUES, "date");

    const hasAnyData = sessions.length > 0 || classes.length > 0;

    const loadMakeupData = useCallback(async () => {
        setLoading(true);
        setLoadError(null);

        try {
            const response = await fetch("/api/admin/makeup", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load makeup data.");
            }
            const data = (await response.json()) as MakeupPayload;
            setSessions(data.sessions);
            setClasses(data.classes);
        } catch (error) {
            console.error("Failed to load makeup data:", error);
            setLoadError("failed");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadMakeupData();
    }, [hasInitialData, loadMakeupData]);

    const loadStudents = useCallback(async () => {
        if (studentsLoaded || studentsLoading) return;

        setStudentsLoading(true);
        setStudentsError(null);

        try {
            const response = await fetch("/api/admin/student-options");

            if (!response.ok) {
                throw new Error("Failed to load student options.");
            }

            const data = (await response.json()) as { students?: Student[] };
            setStudents(data.students ?? []);
            setStudentsLoaded(true);
        } catch (error) {
            console.error("Failed to load student options:", error);
            setStudentsError("원생 목록을 불러오지 못했습니다.");
        } finally {
            setStudentsLoading(false);
        }
    }, [studentsLoaded, studentsLoading]);

    // 상태별 필터링
    const filteredSessions = useMemo(() => {
        if (statusFilter === "ALL") return sessions;
        return sessions.filter((s) => s.status === statusFilter);
    }, [sessions, statusFilter]);

    // 상태별 카운트 (요약 카드용)
    const statusCounts = useMemo(() => {
        const counts: Record<string, number> = { BOOKED: 0, ATTENDED: 0, CANCELLED: 0, NO_SHOW: 0 };
        sessions.forEach((s) => {
            if (counts[s.status] !== undefined) counts[s.status]++;
        });
        return counts;
    }, [sessions]);

    // 보강일 날짜별 묶음 — 앞으로 할 보강은 가까운 날부터, 지난 보강은 최근부터
    const today = todayKst();
    const dateGroups = useMemo(
        () => groupByUpcomingDate(filteredSessions, (item) => toKstYmd(item.makeupDate), today, MAKEUP_DATE_GROUP_LABELS),
        [filteredSessions, today],
    );

    // 상태 칩(건수는 위 statusCounts 그대로)
    const statusChipItems = STATUS_TABS.map((tab) => ({
        value: tab.key,
        label: tab.label,
        count: statusCounts[tab.key] ?? 0,
    }));

    // 날짜 표시 «8/14(금)» — KST 달력 기준(예전 표시는 기기 시간대를 따라갔다)
    function fmtDate(d: string | null) {
        if (!d) return "-";
        return kstLabel(d) || "-";
    }

    // 보강 시간 «16:00~17:00»
    function fmtTime(item: MakeupItem) {
        if (!item.makeupStart && !item.makeupEnd) return "-";
        return `${item.makeupStart || "-"}~${item.makeupEnd || "-"}`;
    }

    // 상태 변경 핸들러
    async function handleStatusChange(id: string, newStatus: string) {
        if (busy) return;
        setBusy(true);
        try {
            await updateMakeupStatus(id, newStatus);
            await loadMakeupData();
        } catch (e: any) {
            alert(e.message || "상태 변경 실패");
        } finally {
            setBusy(false);
        }
    }

    // 보강 취소 핸들러
    async function handleCancel(id: string) {
        if (busy) return;
        if (!confirm("이 보강 예약을 취소하시겠습니까?")) return;
        setBusy(true);
        try {
            await cancelMakeupSession(id);
            await loadMakeupData();
        } catch (e: any) {
            alert(e.message || "취소 실패");
        } finally {
            setBusy(false);
        }
    }

    // ⚡·상세 패널이 같이 쓰는 작업 목록 — 예전 행의 상태 드롭다운(출석·노쇼·취소)과 «취소» 버튼을 같은 인자로 옮긴 것.
    // 예약(BOOKED) 상태에서만 바꿀 수 있던 예전 규칙 그대로(다른 상태는 작업 없음).
    // ⚠️ «취소 처리»(상태 변경 = 보강권 동기화)와 «예약 취소»(확인창 후 취소)는 서버 동작이 달라 둘 다 남긴다.
    function buildMakeupActions(item: MakeupItem): AdminQuickAction[] {
        if (item.status !== "BOOKED") return [];
        const id = item.id; // 패널을 닫은 뒤 실행돼도 대상이 바뀌지 않게 미리 붙잡아 둔다
        return [
            { key: "attended", label: "출석 처리", icon: "check_circle", tone: "primary", disabled: busy, onSelect: () => handleStatusChange(id, "ATTENDED") },
            { key: "no-show", label: "노쇼 처리", icon: "person_off", disabled: busy, onSelect: () => handleStatusChange(id, "NO_SHOW") },
            { key: "status-cancelled", label: "취소 처리", icon: "event_busy", disabled: busy, onSelect: () => handleStatusChange(id, "CANCELLED") },
            { key: "cancel", label: "예약 취소", icon: "cancel", tone: "danger", disabled: busy, onSelect: () => handleCancel(id) },
        ];
    }

    // 행 키보드(Enter·Space) = 상세 패널. 행 안의 ⚡ 버튼에서 누른 키는 가로채지 않는다.
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailId(id);
        }
    }

    // 보기 전환 시 열린 패널은 닫는다(다른 묶음의 행을 가리키지 않게)
    function changeViewMode(next: MakeupViewMode) {
        setDetailId(null);
        setViewMode(next);
    }

    // 표 칸 수(날짜별 머리줄 colSpan 용)
    const columnCount = 8;

    // 한 줄 행: 보강일 | 시간 | 원생 | 보강 반 | 원래 반 | 결석일 | 상태 | 관리(⚡). 요일·프로그램은 상세 패널에서
    function renderMakeupRow(item: MakeupItem) {
        const cfg = STATUS_CONFIG[item.status] ?? STATUS_CONFIG.BOOKED;
        const actions = buildMakeupActions(item);
        return (
            <tr
                key={item.id}
                tabIndex={0}
                aria-label={`${item.studentName} 보강 상세 보기`}
                onClick={() => setDetailId(item.id)}
                onKeyDown={(event) => handleRowKeyDown(event, item.id)}
                className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
            >
                {/* 날짜·시간은 오른쪽 + 자릿수 폭 고정 */}
                <td className="admin-cell-num px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{fmtDate(item.makeupDate)}</td>
                <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{fmtTime(item)}</td>
                <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{item.studentName}</td>
                <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{item.makeupClassName}</td>
                <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{item.originalClassName}</td>
                <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{fmtDate(item.originalDate)}</td>
                <td className="px-2 py-1.5">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                </td>
                {/* 관리: ⚡(출석·노쇼·취소). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                    {actions.length > 0 ? (
                        <AdminQuickActionMenu label={`${item.studentName} 보강 빠른 작업`} actions={actions} />
                    ) : (
                        <span className="text-xs text-[var(--color-academy-muted)]">-</span>
                    )}
                </td>
            </tr>
        );
    }

    if (loading && !hasAnyData) {
        return <MakeupLoadingFallback />;
    }

    if (loadError && !hasAnyData) {
        return <MakeupErrorState onRetry={loadMakeupData} />;
    }

    const detailItem = detailId ? sessions.find((s) => s.id === detailId) ?? null : null;

    return (
        <div className="space-y-3">
            {/* 페이지 제목 + 예약 버튼 */}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h1 className="text-2xl font-extrabold text-[var(--color-academy-ink)]">보강 관리</h1>
                    <p className="text-xs text-[var(--color-academy-muted)]">보강 예약 <span className="tabular-nums">{sessions.length}</span>건</p>
                </div>
                <button
                    onClick={() => {
                        setShowBookModal(true);
                        void loadStudents();
                    }}
                    className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] transition-colors hover:bg-[var(--color-academy-primary-hover)]"
                >
                    <span className="material-symbols-outlined text-[20px]" aria-hidden="true">event_repeat</span>
                    보강 예약
                </button>
            </div>

            {/* 상태 칩(예전 요약 카드 4개 + 상태 탭을 한 줄로) + 보기 전환(날짜별 | 목록) */}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <StatusCountChips
                    ariaLabel="보강 상태별 건수"
                    items={statusChipItems}
                    selected={statusFilter}
                    onSelect={(value) => { setStatusFilter(value); setDetailId(null); }}
                    allValue={STATUS_ALL}
                />
                <ListViewToggle
                    value={viewMode}
                    options={MAKEUP_VIEW_OPTIONS}
                    ariaLabel="보강 보기 방식"
                    onChange={changeViewMode}
                />
            </div>

            {/* 보강 목록 표 */}
            {filteredSessions.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    보강 예약이 없습니다
                </div>
            ) : (
                <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                    <div className="overflow-x-auto">
                        {/* admin-list-table: 글자 왼쪽·날짜/시간 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                                <tr>
                                    <th className="admin-cell-num px-2 py-2">보강일</th>
                                    <th className="admin-cell-num hidden px-2 py-2 md:table-cell">시간</th>
                                    <th className="px-2 py-2">원생</th>
                                    <th className="px-2 py-2">보강 반</th>
                                    <th className="hidden px-2 py-2 md:table-cell">원래 반</th>
                                    <th className="admin-cell-num hidden px-2 py-2 md:table-cell">결석일</th>
                                    <th className="px-2 py-2">상태</th>
                                    <th className="admin-cell-center px-2 py-2">관리</th>
                                </tr>
                            </thead>
                            {viewMode === "date" ? (
                                // 날짜별 보기: 머리줄 «오늘 · 3건 · 예약 2» 아래 그 기간 보강들
                                dateGroups.map((group) => {
                                    const bookedCount = group.items.filter((s) => s.status === "BOOKED").length;
                                    return (
                                        <tbody key={group.key} className="divide-y divide-[var(--color-academy-line)]">
                                            <tr>
                                                <th colSpan={columnCount} scope="rowgroup" className="bg-[var(--color-academy-soft)] px-2 py-1.5 text-xs font-black text-[var(--color-academy-ink)]">
                                                    {group.label} · <span className="tabular-nums">{group.items.length}</span>건
                                                    {bookedCount > 0 && <> · 예약 <span className="tabular-nums">{bookedCount}</span></>}
                                                </th>
                                            </tr>
                                            {group.items.map(renderMakeupRow)}
                                        </tbody>
                                    );
                                })
                            ) : (
                                <tbody className="divide-y divide-[var(--color-academy-line)]">{filteredSessions.map(renderMakeupRow)}</tbody>
                            )}
                        </table>
                    </div>
                </div>
            )}

            {/* 행 클릭 상세 패널 — 데스크톱 오른쪽 / 모바일 하단 시트. 작업 버튼은 ⚡ 와 같은 목록 */}
            {detailItem && (() => {
                const d = detailItem;
                const cfg = STATUS_CONFIG[d.status] ?? STATUS_CONFIG.BOOKED;
                const dayOf = (day: string) => (day ? `${DAY_LABELS[day] ?? day}요일` : "");
                const rows: { label: string; value: React.ReactNode }[] = [
                    { label: "보강일", value: <span className="tabular-nums">{toKstYmd(d.makeupDate) || "-"} {fmtTime(d)}</span> },
                    { label: "보강 반", value: [d.makeupClassName, dayOf(d.makeupDay)].filter(Boolean).join(" ") },
                    { label: "프로그램", value: d.programName || null },
                    { label: "원래 반", value: [d.originalClassName, dayOf(d.originalDay)].filter(Boolean).join(" ") },
                    { label: "결석일", value: <span className="tabular-nums">{toKstYmd(d.originalDate) || "-"}</span> },
                    { label: "등록일", value: d.createdAt ? <span className="tabular-nums">{toKstYmd(d.createdAt)}</span> : null },
                ].filter((row) => row.value !== null && row.value !== undefined && row.value !== "");
                const detailActions = buildMakeupActions(d);
                return (
                    <ListDetailPanel onClose={() => setDetailId(null)} titleId="makeup-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                        <div className="mb-4 flex items-center gap-2">
                            <h3 id="makeup-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{d.studentName}</h3>
                            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${cfg.bg} ${cfg.color}`}>{cfg.label}</span>
                            <button
                                type="button"
                                onClick={() => setDetailId(null)}
                                aria-label="닫기"
                                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="material-symbols-outlined" aria-hidden="true">close</span>
                            </button>
                        </div>
                        <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                            {rows.map((row) => (
                                <div key={row.label} className="contents">
                                    <dt className="font-bold text-[var(--color-academy-muted)]">{row.label}</dt>
                                    <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{row.value}</dd>
                                </div>
                            ))}
                        </dl>
                        {detailActions.length > 0 && (
                            <AdminPanelActions actions={detailActions} onBeforeSelect={() => setDetailId(null)} />
                        )}
                    </ListDetailPanel>
                );
            })()}

            {/* 보강 예약 모달 */}
            {showBookModal && (
                <BookMakeupModal
                    students={students}
                    studentsLoading={studentsLoading}
                    studentsError={studentsError}
                    onRetryLoadStudents={loadStudents}
                    classes={classes}
                    onClose={() => setShowBookModal(false)}
                    onSuccess={async () => {
                        setShowBookModal(false);
                        await loadMakeupData();
                    }}
                />
            )}
        </div>
    );
}

// ── 보강 예약 모달 ─────────────────────────────────────────────────────────

function BookMakeupModal({
    students,
    studentsLoading,
    studentsError,
    onRetryLoadStudents,
    classes,
    onClose,
    onSuccess,
}: {
    students: Student[];
    studentsLoading: boolean;
    studentsError: string | null;
    onRetryLoadStudents: () => Promise<void>;
    classes: ClassItem[];
    onClose: () => void;
    onSuccess: () => Promise<void> | void;
}) {
    const [step, setStep] = useState(1); // 1: 학생+원래반 선택, 2: 보강반 선택
    const [studentId, setStudentId] = useState("");
    const [originalClassId, setOriginalClassId] = useState("");
    const [originalDate, setOriginalDate] = useState("");
    const [makeupClassId, setMakeupClassId] = useState("");
    const [makeupDate, setMakeupDate] = useState("");
    const [availableSlots, setAvailableSlots] = useState<MakeupSlot[]>([]);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    // 잔여석을 서버에서 실제로 받아왔는지 여부. false면 "확인 중"으로 중립 표시한다.
    const [seatsLoaded, setSeatsLoaded] = useState(false);

    // 학생 검색 필터
    const [studentSearch, setStudentSearch] = useState("");

    // 선택한 원래 반의 프로그램/정보
    const selectedClass = classes.find((c) => c.id === originalClassId);

    // 학생 필터링 (이름 검색)
    const filteredStudents = useMemo(() => {
        if (!studentSearch) return students;
        return students.filter((s) => s.name.includes(studentSearch));
    }, [students, studentSearch]);

    // 보강 반 후보 목록 — 같은 프로그램의 다른 반. 잔여석은 "모름" 상태로 둔다.
    // (예전에는 remaining 에 총정원을 넣어 빈자리인 것처럼 보여줘 정원 초과 예약이 났다)
    const buildBaseSlots = useCallback((): MakeupSlot[] => {
        if (!selectedClass?.programId || !originalClassId) return [];
        return classes
            .filter((c) => c.programId === selectedClass.programId && c.id !== originalClassId)
            .map((c) => ({
                id: c.id,
                name: c.name,
                dayOfWeek: c.dayOfWeek,
                startTime: c.startTime,
                endTime: c.endTime,
                capacity: c.capacity,
                enrolled: 0,
                bookedMakeups: 0,
                remaining: 0, // seatsLoaded=false 이므로 화면에는 "확인 중"으로만 표시된다
            }));
    }, [classes, originalClassId, selectedClass?.programId]);

    // 보강일이 정해지면 그 날짜 기준 실제 잔여석을 서버에서 조회한다.
    useEffect(() => {
        if (step !== 2) return;
        const programId = selectedClass?.programId;
        if (!programId || !originalClassId) return;

        // 날짜 미선택 → 잔여석을 알 수 없는 상태. 총정원을 잔여석처럼 보여주지 않는다.
        if (!/^\d{4}-\d{2}-\d{2}$/.test(makeupDate)) {
            setAvailableSlots(buildBaseSlots());
            setSeatsLoaded(false);
            return;
        }

        let aborted = false;
        setLoading(true);
        loadMakeupSlotAvailability({ programId, excludeClassId: originalClassId, makeupDate })
            .then((res) => {
                if (aborted) return;
                if (res?.ok && Array.isArray(res.slots)) {
                    setAvailableSlots(res.slots as MakeupSlot[]);
                    setSeatsLoaded(true); // 실제 잔여석 확보
                } else {
                    setAvailableSlots(buildBaseSlots());
                    setSeatsLoaded(false);
                }
            })
            .catch((e) => {
                if (aborted) return;
                console.error("Failed to load makeup slot availability:", e);
                setAvailableSlots(buildBaseSlots());
                setSeatsLoaded(false); // 실패 시에도 낙관 표시 금지
            })
            .finally(() => {
                if (!aborted) setLoading(false);
            });

        return () => {
            aborted = true;
        };
    }, [step, makeupDate, originalClassId, selectedClass?.programId, buildBaseSlots]);

    // 잔여석을 받아본 결과 이미 선택해 둔 반이 마감이면 선택을 해제한다.
    useEffect(() => {
        if (!seatsLoaded || !makeupClassId) return;
        const picked = availableSlots.find((s) => s.id === makeupClassId);
        if (picked && isMakeupSlotFull(picked)) setMakeupClassId("");
    }, [seatsLoaded, availableSlots, makeupClassId]);

    // 다음 단계로 이동
    function goToStep2() {
        if (!studentId || !originalClassId || !originalDate) {
            alert("원생, 원래 반, 결석일을 모두 선택해주세요");
            return;
        }
        setStep(2); // 슬롯/잔여석은 위 useEffect가 채운다
    }

    // 예약 실행
    async function handleBook() {
        if (!makeupClassId || !makeupDate) {
            alert("보강 반과 보강일을 선택해주세요");
            return;
        }
        // 마감된 반은 화면에서도 막는다(최종 판단은 서버가 다시 한다).
        const picked = availableSlots.find((s) => s.id === makeupClassId);
        if (seatsLoaded && picked && isMakeupSlotFull(picked)) {
            alert("이미 정원이 찼습니다. 다른 날짜나 반을 선택해 주세요.");
            return;
        }
        setBusy(true);
        try {
            await bookMakeupSession({
                studentId,
                originalClassId,
                originalDate,
                makeupClassId,
                makeupDate,
            });
            await onSuccess();
        } catch (e: any) {
            alert(e.message || "보강 예약 실패");
        } finally {
            setBusy(false);
        }
    }

    return (
        <AdminModal
            titleId="book-makeup-title"
            onClose={onClose}
            closeOnBackdrop={false}
            panelClassName="max-w-lg"
        >
            <div className="w-full">
                {/* 모달 헤더 */}
                <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
                    <h2 id="book-makeup-title" className="text-lg font-bold text-gray-900 dark:text-white">
                        {step === 1 ? "보강 예약 - 원생/결석 정보" : "보강 예약 - 보강 반 선택"}
                    </h2>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-gray-300">
                        <span className="material-symbols-outlined">close</span>
                    </button>
                </div>

                <div className="p-6 space-y-4">
                    {step === 1 && (
                        <>
                            {/* 원생 선택 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">원생 선택</label>
                                <input
                                    type="text"
                                    placeholder="이름 검색..."
                                    value={studentSearch}
                                    onChange={(e) => setStudentSearch(e.target.value)}
                                    disabled={studentsLoading || Boolean(studentsError)}
                                    className="w-full border border-gray-300 dark:border-gray-600 dark:text-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm mb-2"
                                />
                                <select
                                    value={studentId}
                                    onChange={(e) => setStudentId(e.target.value)}
                                    disabled={studentsLoading || Boolean(studentsError)}
                                    className="w-full border border-gray-300 dark:border-gray-600 dark:text-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm"
                                    size={5}
                                >
                                    <option value="">
                                        {studentsLoading ? "원생 목록 로딩 중..." : "-- 원생 선택 --"}
                                    </option>
                                    {filteredStudents.map((s) => (
                                        <option key={s.id} value={s.id}>
                                            {s.name}
                                        </option>
                                    ))}
                                </select>
                                {studentsError && (
                                    <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-200">
                                        <span>{studentsError}</span>
                                        <button
                                            type="button"
                                            onClick={() => void onRetryLoadStudents()}
                                            className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900/40"
                                        >
                                            다시 시도
                                        </button>
                                    </div>
                                )}
                                {!studentsLoading && !studentsError && students.length === 0 && (
                                    <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                                        등록된 원생이 없습니다.
                                    </p>
                                )}
                            </div>

                            {/* 원래 반 선택 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">원래 반 (결석한 반)</label>
                                <select
                                    value={originalClassId}
                                    onChange={(e) => setOriginalClassId(e.target.value)}
                                    className="w-full border border-gray-300 dark:border-gray-600 dark:text-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm"
                                >
                                    <option value="">-- 반 선택 --</option>
                                    {classes.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.name} ({DAY_LABELS[c.dayOfWeek] ?? c.dayOfWeek} {c.startTime}~{c.endTime})
                                            {c.program ? ` - ${c.program.name}` : ""}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* 결석일 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">결석일</label>
                                <input
                                    type="date"
                                    min="2020-01-01" max="2030-12-31"
                                    value={originalDate}
                                    onChange={(e) => setOriginalDate(e.target.value)}
                                    className="w-full border border-gray-300 dark:border-gray-600 dark:text-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm"
                                />
                            </div>

                            <button
                                onClick={goToStep2}
                                className="w-full py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition-colors"
                            >
                                다음: 보강 반 선택
                            </button>
                        </>
                    )}

                    {step === 2 && (
                        <>
                            {/* 선택된 정보 요약 */}
                            <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3 text-sm space-y-1">
                                <p>
                                    <span className="text-gray-500 dark:text-gray-400">원생:</span>{" "}
                                    <span className="font-medium">{students.find((s) => s.id === studentId)?.name}</span>
                                </p>
                                <p>
                                    <span className="text-gray-500 dark:text-gray-400">원래 반:</span>{" "}
                                    <span className="font-medium">
                                        {selectedClass?.name} ({DAY_LABELS[selectedClass?.dayOfWeek ?? ""] ?? selectedClass?.dayOfWeek})
                                    </span>
                                </p>
                                <p>
                                    <span className="text-gray-500 dark:text-gray-400">결석일:</span>{" "}
                                    <span className="font-medium">{originalDate}</span>
                                </p>
                            </div>

                            {/* 보강 반 선택 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                                    보강 반 선택 (같은 프로그램: {selectedClass?.program?.name ?? "미지정"})
                                </label>
                                {loading ? (
                                    <p className="text-sm text-gray-400 py-4 text-center">조회 중...</p>
                                ) : availableSlots.length === 0 ? (
                                    <p className="text-sm text-gray-400 py-4 text-center">
                                        같은 프로그램의 다른 반이 없습니다
                                    </p>
                                ) : (
                                    <div className="space-y-2">
                                        {!seatsLoaded && (
                                            <p className="text-xs text-gray-500 dark:text-gray-400">
                                                아래 &quot;보강 수업일&quot;을 선택하면 그 날짜의 실제 잔여석이 표시됩니다.
                                            </p>
                                        )}
                                        {availableSlots.map((slot) => {
                                            // 잔여석을 실제로 확인한 경우에만 마감 판정(모르면 막지 않고 서버가 최종 검증)
                                            const full = seatsLoaded && isMakeupSlotFull(slot);
                                            return (
                                            <label
                                                key={slot.id}
                                                className={`flex items-center gap-3 p-3 border rounded-lg transition-all ${
                                                    full
                                                        ? "border-gray-200 dark:border-gray-700 opacity-60 cursor-not-allowed"
                                                        : makeupClassId === slot.id
                                                            ? "border-blue-500 bg-blue-50 cursor-pointer"
                                                            : "border-gray-200 dark:border-gray-700 hover:border-gray-300 cursor-pointer"
                                                }`}
                                            >
                                                <input
                                                    type="radio"
                                                    name="makeupClass"
                                                    value={slot.id}
                                                    checked={makeupClassId === slot.id}
                                                    onChange={() => setMakeupClassId(slot.id)}
                                                    disabled={full}
                                                    className="accent-blue-600"
                                                />
                                                <div className="flex-1">
                                                    <p className="font-medium text-sm">{slot.name}</p>
                                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                                        {DAY_LABELS[slot.dayOfWeek] ?? slot.dayOfWeek}요일 {slot.startTime}~{slot.endTime}
                                                        {" / "}
                                                        {/* 잔여 N석 · 정원 M명 (아직 모르면 "잔여석 확인 중") */}
                                                        <span className={full ? "font-semibold text-red-600" : ""}>
                                                            {formatSeatLabel(slot, seatsLoaded)}
                                                        </span>
                                                    </p>
                                                </div>
                                            </label>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            {/* 보강일 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">보강 수업일</label>
                                <input
                                    type="date"
                                    min="2020-01-01" max="2030-12-31"
                                    value={makeupDate}
                                    onChange={(e) => setMakeupDate(e.target.value)}
                                    className="w-full border border-gray-300 dark:border-gray-600 dark:text-white dark:bg-gray-800 rounded-lg px-3 py-2 text-sm"
                                />
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setStep(1)}
                                    className="flex-1 py-2.5 border border-gray-300 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-50 dark:bg-gray-900 font-medium transition-colors"
                                >
                                    이전
                                </button>
                                <button
                                    onClick={handleBook}
                                    disabled={busy || !makeupClassId || !makeupDate}
                                    className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium transition-colors disabled:opacity-50"
                                >
                                    {busy ? "처리 중..." : "보강 예약"}
                                </button>
                            </div>
                        </>
                    )}
                </div>
            </div>
        </AdminModal>
    );
}
