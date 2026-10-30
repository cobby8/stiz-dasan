"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link"; // 클래스 상세 페이지 링크용
import { deleteClass } from "@/app/actions/admin";
import AdminQuickActionMenu from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import ListViewToggle, { useRememberedListView } from "@/components/admin/list/ListViewToggle";
import StatusCountChips from "@/components/admin/list/StatusCountChips";

const ClassFormPanel = dynamic(() => import("./ClassFormPanel"), {
    loading: () => null,
});

export type Program = { id: string; name: string };
export type ClassItem = {
    id: string;
    programId: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    location: string | null;
    capacity: number;
    program: { id: string; name: string } | null;
};

type ClassesPayload = {
    programs: Program[];
    classes: ClassItem[];
};

const DAYS = [
    { value: "Mon", label: "월요일", short: "월" },
    { value: "Tue", label: "화요일", short: "화" },
    { value: "Wed", label: "수요일", short: "수" },
    { value: "Thu", label: "목요일", short: "목" },
    { value: "Fri", label: "금요일", short: "금" },
    { value: "Sat", label: "토요일", short: "토" },
    { value: "Sun", label: "일요일", short: "일" },
] as const;

// 요일 칩 «전체» 값, 보기 전환 «요일별 | 목록»(브라우저에 기억)
const DAY_ALL = "ALL";
const CLASS_VIEW_STORAGE_KEY = "admin-classes-view-mode";
const CLASS_VIEW_VALUES = ["day", "list"] as const;
type ClassViewMode = (typeof CLASS_VIEW_VALUES)[number];
const CLASS_VIEW_OPTIONS = [
    { value: "day", label: "요일별", icon: "calendar_view_week" },
    { value: "list", label: "목록", icon: "view_list" },
] as const;

function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

function dayLabelOf(dayOfWeek: string) {
    return DAYS.find((d) => d.value === dayOfWeek)?.label || dayOfWeek;
}

function ClassesLoadingFallback() {
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <div className="h-8 w-40 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                <div className="h-11 w-24 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
            </div>
            <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                {Array.from({ length: 8 }).map((_, index) => (
                    <div key={index} className="h-11 animate-pulse border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] last:border-b-0" />
                ))}
            </div>
        </div>
    );
}

function ClassesErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-4 text-center">
            <p className="text-sm font-bold text-[var(--color-academy-danger)]">반 목록을 불러오지 못했습니다.</p>
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

export default function ClassManagementClient({
    programs: initialPrograms,
    classes: initialClasses,
}: {
    programs?: Program[];
    classes?: ClassItem[];
}) {
    const hasInitialData = Boolean(initialPrograms || initialClasses);
    const [programs, setPrograms] = useState<Program[]>(initialPrograms ?? []);
    const [classes, setClasses] = useState<ClassItem[]>(initialClasses ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editingClass, setEditingClass] = useState<ClassItem | null>(null);
    const [busy, setBusy] = useState(false);
    // 요일 칩 선택값, 행 클릭 상세 패널 대상, 보기 방식
    const [dayFilter, setDayFilter] = useState<string>(DAY_ALL);
    const [detailClassId, setDetailClassId] = useState<string | null>(null);
    const [viewMode, changeViewMode] = useRememberedListView<ClassViewMode>(CLASS_VIEW_STORAGE_KEY, CLASS_VIEW_VALUES, "day");

    const loadClasses = useCallback(async () => {
        setLoading(true);
        setLoadError(false);

        try {
            const response = await fetch("/api/admin/classes", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load classes.");
            }

            const data = (await response.json()) as ClassesPayload;
            setPrograms(data.programs);
            setClasses(data.classes);
        } catch (error) {
            console.error("Failed to load classes:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadClasses();
    }, [hasInitialData, loadClasses]);

    function resetForm() {
        setShowForm(false);
        setEditingClass(null);
    }

    function startEdit(c: ClassItem) {
        setEditingClass(c);
        setShowForm(true);
    }

    async function handleDelete(id: string) {
        setBusy(true);
        try {
            await deleteClass(id);
            await loadClasses();
        } catch (err: unknown) {
            alert(getErrorMessage(err, "삭제 실패"));
        } finally {
            setBusy(false);
        }
    }

    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailClassId(id);
        }
    }

    // ⚡ 빠른 작업 목록(기존 그대로: 수정·삭제)
    function buildQuickActions(cls: ClassItem) {
        return [
            {
                key: "edit",
                label: "수정",
                icon: "edit",
                onSelect: () => startEdit(cls),
            },
            {
                key: "delete",
                label: "삭제",
                icon: "delete",
                tone: "danger" as const,
                disabled: busy,
                onSelect: () => {
                    if (window.confirm(`"${cls.name}" 반을 삭제할까요?`)) {
                        void handleDelete(cls.id);
                    }
                },
            },
        ];
    }

    // 요일 칩: 이미 받아온 dayOfWeek 로 센다(0개 요일은 칩이 숨는다)
    const dayChipItems = DAYS.map((day) => ({
        value: day.value,
        label: day.short,
        count: classes.filter((cls) => cls.dayOfWeek === day.value).length,
    }));
    const visibleClasses = useMemo(
        () => (dayFilter === DAY_ALL ? classes : classes.filter((cls) => cls.dayOfWeek === dayFilter)),
        [classes, dayFilter],
    );
    // 요일별 보기: 월~일 순서, 요일 안에서는 시작 시간 순. 모르는 요일 값은 맨 뒤 «기타»
    const dayGroups = useMemo(() => {
        const known = DAYS.map((day) => ({
            key: day.value as string,
            label: day.label as string,
            items: visibleClasses
                .filter((cls) => cls.dayOfWeek === day.value)
                .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || "")),
        }));
        const others = visibleClasses.filter((cls) => !DAYS.some((day) => day.value === cls.dayOfWeek));
        return [...known, { key: "other", label: "기타", items: others }].filter((group) => group.items.length > 0);
    }, [visibleClasses]);

    const detailClass = detailClassId ? classes.find((cls) => cls.id === detailClassId) ?? null : null;
    const columnCount = 7;

    // 한 줄 행: 요일 | 시간 | 반 이름 | 프로그램 | 장소 | 정원 | 관리(⚡). 긴 프로그램·장소는 상세 패널에서도 전부
    function renderClassRow(cls: ClassItem) {
        return (
            <tr
                key={cls.id}
                tabIndex={0}
                aria-label={`${cls.name} 요약 보기`}
                onClick={() => setDetailClassId(cls.id)}
                onKeyDown={(event) => handleRowKeyDown(event, cls.id)}
                className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
            >
                <td className="px-2 py-1.5 font-bold text-[var(--color-academy-primary)]">{dayLabelOf(cls.dayOfWeek)}</td>
                {/* 시간: 오른쪽 정렬 + 자릿수 폭 고정 */}
                <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{cls.startTime || "-"}~{cls.endTime || "-"}</td>
                <td className="px-2 py-1.5">
                    {/* 반 이름 클릭 시 클래스 상세 페이지로 이동(행 클릭=요약 패널과 겹치지 않게 전파 차단) */}
                    <Link
                        href={`/admin/classes/${cls.id}`}
                        prefetch={false}
                        onClick={(event) => event.stopPropagation()}
                        className="font-bold text-[var(--color-academy-ink)] hover:text-[var(--color-academy-primary)] hover:underline"
                    >
                        {cls.name}
                    </Link>
                </td>
                <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{cls.program?.name || "-"}</td>
                <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{cls.location || "미지정"}</td>
                <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{cls.capacity}명</td>
                {/* 관리: ⚡ 메뉴. 눌러도 행 클릭(패널 열기)이 같이 일어나지 않게 전파 차단 */}
                <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                    <AdminQuickActionMenu
                        label={`${cls.name} 빠른 작업`}
                        actions={buildQuickActions(cls)}
                    />
                </td>
            </tr>
        );
    }

    if (loading && classes.length === 0 && programs.length === 0) {
        return <ClassesLoadingFallback />;
    }

    if (loadError && classes.length === 0 && programs.length === 0) {
        return <ClassesErrorState onRetry={loadClasses} />;
    }

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h1 className="text-2xl font-bold text-[var(--color-academy-ink)]">클래스(반) 관리</h1>
                    <p className="text-xs text-[var(--color-academy-muted)]">개설된 전체 시간표 <span className="tabular-nums">{classes.length}</span>개</p>
                </div>
                <button
                    onClick={() => { setEditingClass(null); setShowForm(true); }}
                    className="min-h-11 shrink-0 rounded-lg bg-[var(--color-academy-primary)] px-4 font-bold text-[var(--color-academy-on-primary)] transition hover:bg-[var(--color-academy-primary-hover)]"
                >
                    + 반 개설
                </button>
            </div>

            {programs.length === 0 && (
                <div className="rounded-md bg-[var(--color-academy-warning-soft)] p-3 text-sm text-[var(--color-academy-warning)]">
                    먼저 [프로그램 관리] 메뉴에서 프로그램을 하나 이상 등록해야 반을 개설할 수 있습니다.
                </div>
            )}

            {/* Form */}
            {showForm && (
                <ClassFormPanel
                    programs={programs}
                    classItem={editingClass}
                    onClose={resetForm}
                    onSaved={async () => {
                        resetForm();
                        await loadClasses();
                    }}
                />
            )}

            {/* 요일 칩(누르면 그 요일만, 다시 누르면 전체) + 보기 전환(요일별 | 목록) */}
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <StatusCountChips
                    ariaLabel="요일별 반 수"
                    items={dayChipItems}
                    selected={dayFilter}
                    onSelect={setDayFilter}
                    allValue={DAY_ALL}
                />
                <ListViewToggle
                    value={viewMode}
                    options={CLASS_VIEW_OPTIONS}
                    ariaLabel="반 보기 방식"
                    onChange={changeViewMode}
                />
            </div>

            {/* Class List */}
            {visibleClasses.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    개설된 반이 없습니다.
                </div>
            ) : (
                <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                    <div className="overflow-x-auto">
                        {/* admin-list-table: 글자 왼쪽·시간/정원 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                                <tr>
                                    <th className="px-2 py-2">요일</th>
                                    <th className="admin-cell-num px-2 py-2">시간</th>
                                    <th className="px-2 py-2">반 이름</th>
                                    <th className="hidden px-2 py-2 md:table-cell">참조 프로그램</th>
                                    <th className="hidden px-2 py-2 md:table-cell">장소</th>
                                    <th className="admin-cell-num px-2 py-2">정원</th>
                                    <th className="admin-cell-center px-2 py-2">관리</th>
                                </tr>
                            </thead>
                            {viewMode === "day" ? (
                                // 요일별 보기: 머리줄 «월요일 · 6개 반» 아래 그 요일 반들(시간 순)
                                dayGroups.map((group) => (
                                    <tbody key={group.key} className="divide-y divide-[var(--color-academy-line)]">
                                        <tr>
                                            <th colSpan={columnCount} scope="rowgroup" className="bg-[var(--color-academy-soft)] px-2 py-1.5 text-xs font-black text-[var(--color-academy-ink)]">
                                                {group.label} · <span className="tabular-nums">{group.items.length}</span>개 반
                                            </th>
                                        </tr>
                                        {group.items.map(renderClassRow)}
                                    </tbody>
                                ))
                            ) : (
                                <tbody className="divide-y divide-[var(--color-academy-line)]">{visibleClasses.map(renderClassRow)}</tbody>
                            )}
                        </table>
                    </div>
                </div>
            )}

            {/* 행 클릭 상세 패널 — 데스크톱 오른쪽 패널 / 모바일 하단 시트. 이미 불러온 값만 보여 준다(새 조회 없음) */}
            {detailClass && (() => {
                const d = detailClass;
                const rows: { label: string; value: React.ReactNode }[] = [
                    { label: "요일", value: dayLabelOf(d.dayOfWeek) },
                    { label: "시간", value: <span className="tabular-nums">{d.startTime || "-"}~{d.endTime || "-"}</span> },
                    { label: "프로그램", value: d.program?.name || "-" },
                    { label: "장소", value: d.location || "미지정" },
                    { label: "정원", value: <span className="tabular-nums">{d.capacity}명</span> },
                ];
                return (
                    <ListDetailPanel onClose={() => setDetailClassId(null)} titleId="class-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                        <div className="mb-4 flex items-center gap-2">
                            <h3 id="class-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{d.name}</h3>
                            <button
                                type="button"
                                onClick={() => setDetailClassId(null)}
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
                        {/* 작업: 상세 페이지 열기 + 기존 ⚡ 의 «수정». 패널을 닫고 기존 폼을 연다(삭제는 ⚡ 에만 둔다) */}
                        <div className="mt-5 flex flex-wrap gap-2">
                            <Link
                                href={`/admin/classes/${d.id}`}
                                prefetch={false}
                                className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]"
                            >
                                <span className="material-symbols-outlined text-lg" aria-hidden="true">open_in_new</span>
                                상세 페이지 열기
                            </Link>
                            <button
                                type="button"
                                onClick={() => {
                                    setDetailClassId(null);
                                    startEdit(d);
                                }}
                                className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-academy-line)] px-4 text-sm font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="material-symbols-outlined text-lg" aria-hidden="true">edit</span>
                                수정
                            </button>
                        </div>
                    </ListDetailPanel>
                );
            })()}
        </div>
    );
}
