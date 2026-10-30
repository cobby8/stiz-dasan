"use client";

import { useCallback, useState, useTransition, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { deleteProgram, reorderPrograms } from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";

const ProgramFormPanel = dynamic(() => import("./ProgramFormPanel"), {
    loading: () => null,
});

// ── Constants ─────────────────────────────────────────────────────────────────

const DAY_OPTIONS = [
    { key: "Mon", label: "월" },
    { key: "Tue", label: "화" },
    { key: "Wed", label: "수" },
    { key: "Thu", label: "목" },
    { key: "Fri", label: "금" },
    { key: "Sat", label: "토" },
    { key: "Sun", label: "일" },
];

const WEEKEND = new Set(["Sat", "Sun"]);

const FREQ_TIERS = [
    { key: "priceWeek1" as const, label: "주 1회", autoShuttle: 10000 },
    { key: "priceWeek2" as const, label: "주 2회", autoShuttle: 15000 },
    { key: "priceWeek3" as const, label: "주 3회", autoShuttle: 20000 },
    { key: "priceDaily" as const, label: "매일반", autoShuttle: 20000 },
];

function isWeekendOnly(days: string[]): boolean {
    if (days.length === 0) return false;
    return days.every((d) => WEEKEND.has(d));
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface Program {
    id: string;
    name: string;
    targetAge: string | null;
    weeklyFrequency: string | null;
    frequency: string | null;
    description: string | null;
    price: number;
    days: string | null;
    priceWeek1: number | null;
    priceWeek2: number | null;
    priceWeek3: number | null;
    priceDaily: number | null;
    shuttleFeeOverride: number | null;
    imageUrl: string | null;
    runsShuttle?: boolean;
}

type ProgramsPayload = {
    programs: Program[];
};

// ── Helper to display shuttle fee for a given frequency + override ─────────────

function displayShuttleFee(
    shuttleFeeOverride: number | null | undefined,
    freqKey: typeof FREQ_TIERS[number]["key"],
    weekend: boolean,
): string | null {
    if (weekend) return null; // no service
    if (shuttleFeeOverride === 0) return null; // explicitly disabled
    if (shuttleFeeOverride != null && shuttleFeeOverride > 0)
        return shuttleFeeOverride.toLocaleString() + "원";
    // auto
    const tier = FREQ_TIERS.find((t) => t.key === freqKey);
    return tier ? tier.autoShuttle.toLocaleString() + "원" : null;
}

function ProgramsLoadingFallback() {
    return (
        <div className="space-y-8">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="h-8 w-44 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                </div>
                <div className="flex items-center gap-2">
                    <div className="h-10 w-28 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-700" />
                    <div className="h-10 w-32 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
                </div>
            </div>
            <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                <div className="h-5 w-64 animate-pulse rounded bg-blue-100" />
                <div className="mt-3 flex flex-wrap gap-3">
                    {Array.from({ length: 4 }).map((_, index) => (
                        <div key={index} className="h-8 w-36 animate-pulse rounded-lg bg-white" />
                    ))}
                </div>
            </div>
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="flex items-center justify-between gap-4 border-b border-gray-100 bg-gray-50 px-6 py-4 dark:border-gray-800 dark:bg-gray-900/50">
                    <div className="h-6 w-44 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="h-4 w-44 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                    {Array.from({ length: 5 }).map((_, index) => (
                        <div key={index} className="flex">
                            <div className="w-10 border-r border-gray-100 dark:border-gray-800">
                                <div className="mx-auto mt-6 h-5 w-5 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                            </div>
                            <div className="flex-1 p-5">
                                <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                                    <div className="min-w-0 flex-1 space-y-3">
                                        <div className="flex flex-wrap items-center gap-2">
                                            <div className="h-6 w-6 animate-pulse rounded-full bg-gray-200 dark:bg-gray-700" />
                                            <div className="h-6 w-40 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                                            <div className="h-5 w-16 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                            <div className="h-5 w-16 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                        </div>
                                        <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                        <div className="h-4 w-1/2 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                    </div>
                                    <div className="flex gap-2">
                                        <div className="h-8 w-14 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                                        <div className="h-8 w-14 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                                    </div>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function ProgramsErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-bold text-red-700 dark:text-red-200">프로그램 목록을 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white hover:bg-red-700"
            >
                다시 불러오기
            </button>
        </div>
    );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function ProgramsAdminClient({
    programs: initialPrograms,
}: {
    programs?: Program[];
}) {
    // Programs list with local state for optimistic drag-and-drop reorder
    const hasInitialData = initialPrograms !== undefined;
    const [programs, setPrograms] = useState<Program[]>(initialPrograms ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);
    useEffect(() => {
        if (initialPrograms) setPrograms(initialPrograms);
    }, [initialPrograms]);

    const [showAddModal, setShowAddModal] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [deletingId, setDeletingId] = useState<string | null>(null);
    const [formPending, setFormPending] = useState(false);
    const [deletePending, startDeleteTransition] = useTransition();

    // Drag-and-drop state
    const dragIdRef = useRef<string | null>(null);
    const [dragOverId, setDragOverId] = useState<string | null>(null);
    const [reorderPending, startReorderTransition] = useTransition();

    // 행 클릭 상세 패널 대상(id 로 찾아서, 삭제·새로고침으로 사라지면 패널도 닫힌다)
    const [detailProgramId, setDetailProgramId] = useState<string | null>(null);
    const detailProgram = detailProgramId ? programs.find((p) => p.id === detailProgramId) ?? null : null;

    const loadPrograms = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const response = await fetch("/api/admin/programs", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load programs.");
            }
            const data = (await response.json()) as ProgramsPayload;
            setPrograms(data.programs);
        } catch (error) {
            console.error("Failed to load programs:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadPrograms();
    }, [hasInitialData, loadPrograms]);

    function handleDragStart(e: React.DragEvent, id: string) {
        dragIdRef.current = id;
        e.dataTransfer.effectAllowed = "move";
    }
    function handleDragOver(e: React.DragEvent, id: string) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOverId(id);
    }
    function handleDrop(e: React.DragEvent, targetId: string) {
        e.preventDefault();
        setDragOverId(null);
        const fromId = dragIdRef.current;
        dragIdRef.current = null;
        if (!fromId || fromId === targetId) return;
        const fromIdx = programs.findIndex((p) => p.id === fromId);
        const toIdx = programs.findIndex((p) => p.id === targetId);
        if (fromIdx === -1 || toIdx === -1) return;
        const next = [...programs];
        const [moved] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, moved);
        setPrograms(next); // optimistic
        startReorderTransition(async () => {
            try {
                await reorderPrograms(next.map((p) => p.id));
            } finally {
                await loadPrograms();
            }
        });
    }
    function handleDragEnd() {
        dragIdRef.current = null;
        setDragOverId(null);
    }

    function handleDelete(id: string) {
        startDeleteTransition(async () => {
            try {
                await deleteProgram(id);
                setDeletingId(null);
                await loadPrograms();
            } catch (e: any) {
                alert(e.message || "삭제 실패");
            }
        });
    }

    if (loading && programs.length === 0) {
        return <ProgramsLoadingFallback />;
    }

    if (loadError && programs.length === 0) {
        return <ProgramsErrorState onRetry={loadPrograms} />;
    }

    return (
        <div className="space-y-8">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">프로그램 관리</h1>
                </div>
                {/* 시드 내보내기 버튼 제거: 사이드바 백업 메뉴에 동일 기능이 이미 있다 */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setShowAddModal(true)}
                        className="flex-shrink-0 flex items-center gap-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-orange-600 text-white font-bold text-sm px-4 py-2.5 rounded-xl transition shadow-sm"
                    >
                        <span className="text-lg leading-none">+</span>
                        프로그램 등록
                    </button>
                </div>
            </div>

            {/* Add Program Modal */}
            {showAddModal && (
                <AdminModal
                    titleId="add-program-title"
                    onClose={() => { if (!formPending) setShowAddModal(false); }}
                    closeOnBackdrop={!formPending}
                    panelClassName="max-w-2xl"
                >
                    {/* Dialog */}
                    <div className="w-full">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800 sticky top-0 bg-white dark:bg-gray-800 z-10 rounded-t-2xl">
                            <h2 id="add-program-title" className="text-lg font-bold text-gray-900 dark:text-white">새 프로그램 등록</h2>
                            <button
                                type="button"
                                onClick={() => setShowAddModal(false)}
                                disabled={formPending}
                                className="text-gray-400 hover:text-gray-600 dark:text-gray-300 transition text-xl leading-none px-1"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="p-6">
                            <ProgramFormPanel
                                mode="add"
                                onCancel={() => setShowAddModal(false)}
                                onSaved={() => {
                                    setShowAddModal(false);
                                    void loadPrograms();
                                }}
                                onPendingChange={setFormPending}
                            />
                        </div>
                    </div>
                </AdminModal>
            )}

            {/* 셔틀 요금 기준 박스 제거: 같은 안내가 프로그램 등록/수정 폼 안에 이미 있어 목록 화면 상시 노출은 불필요 */}

            {/* 프로그램 목록 — 한 줄 행(⠿ | # | 이름 | 대상 | 요일 | 수강료 | 셔틀 | 관리). 횟수별 가격·셔틀 요금·설명은 행을 누르면 상세 패널.
                드래그 순서 변경·제자리 수정 폼을 그대로 쓰려고 <li draggable> 구조는 유지하고, 칸만 grid 로 맞춘다
                (표로 바꾸면 전역 표 규칙이 펼쳐진 수정 폼의 정렬까지 바꾼다) */}
            <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                <div className="overflow-x-auto">
                    {/* 머리줄 — 아래 행과 같은 칸 폭(PROGRAM_ROW_GRID) */}
                    <div className={`${PROGRAM_ROW_GRID} items-center bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]`}>
                        <span className="sr-only">순서 손잡이</span>
                        <span className="px-1 py-2 text-right">#</span>
                        <span className="px-2 py-2">이름</span>
                        <span className="hidden px-2 py-2 md:block">대상</span>
                        <span className="hidden px-2 py-2 md:block">요일</span>
                        <span className="px-2 py-2 text-right">수강료</span>
                        <span className="hidden px-2 py-2 md:block">셔틀</span>
                        <span className="px-2 py-2 text-center">관리</span>
                    </div>
                    <ul className="divide-y divide-[var(--color-academy-line)]">
                        {programs.length === 0 && (
                            <li className="p-4 text-center text-sm text-[var(--color-academy-muted)]">등록된 프로그램이 없습니다.</li>
                        )}
                        {programs.map((program, i) => (
                            <li
                                key={program.id}
                                draggable={editId !== program.id}
                                onDragStart={(e) => handleDragStart(e, program.id)}
                                onDragOver={(e) => handleDragOver(e, program.id)}
                                onDrop={(e) => handleDrop(e, program.id)}
                                onDragEnd={handleDragEnd}
                                className={`transition ${dragOverId === program.id ? "bg-[var(--color-academy-primary-soft)]" : "hover:bg-[var(--color-academy-soft)]"}`}
                            >
                                {editId === program.id ? (
                                    <div className="p-6">
                                        <p className="text-sm font-bold text-blue-700 mb-3">수정 중...</p>
                                        <ProgramFormPanel
                                            mode="edit"
                                            program={program}
                                            onCancel={() => setEditId(null)}
                                            onSaved={() => {
                                                setEditId(null);
                                                void loadPrograms();
                                            }}
                                            onPendingChange={setFormPending}
                                        />
                                    </div>
                                ) : (
                                    <ProgramRowInline
                                        program={program} index={i}
                                        onOpenDetail={() => setDetailProgramId(program.id)}
                                        onEdit={() => setEditId(program.id)}
                                        onDelete={() => handleDelete(program.id)}
                                        isDeleting={deletingId === program.id}
                                        deletePending={deletePending}
                                        onSetDeleting={() => setDeletingId(program.id)}
                                        onCancelDelete={() => setDeletingId(null)}
                                    />
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            </div>

            {/* 행 클릭 상세 패널 — 이미 받아온 값만 보여 준다(새 조회·저장 없음). 수정은 기존처럼 목록 안 제자리 폼으로 */}
            {detailProgram && (
                <ListDetailPanel onClose={() => setDetailProgramId(null)} titleId="program-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <ProgramDetailContent
                        program={detailProgram}
                        onClose={() => setDetailProgramId(null)}
                        onEdit={() => { setDetailProgramId(null); setEditId(detailProgram.id); }}
                    />
                </ListDetailPanel>
            )}

        </div>
    );
}

// 목록 머리줄·행이 함께 쓰는 칸 폭. 모바일은 손잡이|#|이름|수강료|관리, md 부터 대상·요일·셔틀을 더 보인다
const PROGRAM_ROW_GRID =
    "grid min-w-0 grid-cols-[2.5rem_2rem_minmax(6rem,1fr)_7rem_8rem] md:grid-cols-[2.5rem_2rem_minmax(9rem,1fr)_7rem_7rem_8rem_5.5rem_9rem]";

// 요일 키(Mon…) → «월» 같은 한 글자
function dayLabels(program: Program): string[] {
    const days = program.days ? program.days.split(",").filter(Boolean) : [];
    return days.map((d) => DAY_OPTIONS.find((o) => o.key === d)?.label || d);
}

// 셔틀 칸 짧은 표기 — 기존 카드의 «운행 없음/미운행» 판정과 같은 조건
function shuttleShortLabel(program: Program): string {
    const days = program.days ? program.days.split(",").filter(Boolean) : [];
    if (isWeekendOnly(days)) return "없음(주말)";
    if (program.runsShuttle === false || program.shuttleFeeOverride === 0) return "미운행";
    return "운행";
}

// 수강료 칸 — 횟수별 가격이 있으면 가장 낮은 값(여러 개면 «부터»), 없으면 월 수강료. 전체 표는 상세 패널
function priceShortLabel(program: Program): string {
    const tierPrices = FREQ_TIERS.map((t) => program[t.key]).filter((v): v is number => v != null);
    if (tierPrices.length === 0) return `${program.price.toLocaleString()}원/월`;
    const min = Math.min(...tierPrices.map(Number));
    return tierPrices.length > 1 ? `${min.toLocaleString()}원부터` : `${min.toLocaleString()}원`;
}

// ── 한 줄 행 (행 클릭 = 상세 패널, 안쪽 버튼은 전파 차단) ──────────────────────

function ProgramRowInline({
    program, index, onOpenDetail, onEdit, onDelete, isDeleting, deletePending, onSetDeleting, onCancelDelete,
}: {
    program: Program;
    index: number;
    onOpenDetail: () => void;
    onEdit: () => void;
    onDelete: () => void;
    isDeleting: boolean;
    deletePending: boolean;
    onSetDeleting: () => void;
    onCancelDelete: () => void;
}) {
    const days = dayLabels(program);

    // 행 키보드: 안쪽 버튼에서 누른 Enter/Space 는 가로채지 않는다
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpenDetail();
        }
    }

    return (
        <div
            tabIndex={0}
            aria-label={`${program.name} 상세 보기`}
            onClick={onOpenDetail}
            onKeyDown={handleRowKeyDown}
            className={`${PROGRAM_ROW_GRID} cursor-pointer items-center text-sm focus:bg-[var(--color-academy-primary-soft)] focus:outline-none`}
        >
            {/* 드래그 손잡이(드래그는 li 전체에 걸려 있어 동작은 기존과 같다) */}
            <span
                className="flex min-h-11 cursor-grab select-none items-center justify-center self-stretch border-r border-[var(--color-academy-line)] text-[var(--color-academy-muted)]"
                title="드래그하여 순서 변경"
            >
                <span className="text-xl leading-none" aria-hidden="true">⠿</span>
            </span>
            <span className="px-1 py-1.5 text-right tabular-nums text-[var(--color-academy-muted)]">{index + 1}</span>
            <span className="min-w-0 break-keep px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{program.name}</span>
            <span className="hidden whitespace-nowrap px-2 py-1.5 text-[var(--color-academy-muted)] md:block">{program.targetAge || "-"}</span>
            {/* 요일: 칸마다 한 글자 칩(주말은 경고색) */}
            <span className="hidden whitespace-nowrap px-2 py-1.5 md:block">
                {days.length === 0 ? <span className="text-[var(--color-academy-muted)]">-</span> : (
                    <span className="inline-flex gap-0.5">
                        {days.map((d) => (
                            <span key={d} className={`rounded px-1 text-xs font-bold ${d === "토" || d === "일" ? "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" : "bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]"}`}>{d}</span>
                        ))}
                    </span>
                )}
            </span>
            <span className="whitespace-nowrap px-2 py-1.5 text-right font-bold tabular-nums text-[var(--color-academy-ink)]">{priceShortLabel(program)}</span>
            <span className="hidden whitespace-nowrap px-2 py-1.5 text-[var(--color-academy-muted)] md:block">{shuttleShortLabel(program)}</span>
            {/* 관리: 수정 · 삭제(확인/취소 두 단계) — 기존 함수·순서 그대로 */}
            <span className="flex items-center justify-center gap-0.5 px-1" onClick={(event) => event.stopPropagation()}>
                <button type="button" onClick={onEdit}
                    className="min-h-11 rounded-lg px-2 text-sm font-bold text-[var(--color-academy-primary)] transition hover:bg-[var(--color-academy-soft)]">
                    수정
                </button>
                {isDeleting ? (
                    <>
                        <button type="button" onClick={onDelete} disabled={deletePending}
                            className="min-h-11 rounded-lg px-2 text-sm font-bold text-[var(--color-academy-danger)] transition hover:bg-[var(--color-academy-danger-soft)]">확인</button>
                        <button type="button" onClick={onCancelDelete}
                            className="min-h-11 rounded-lg px-2 text-sm text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)]">취소</button>
                    </>
                ) : (
                    <button type="button" onClick={onSetDeleting}
                        className="min-h-11 rounded-lg px-2 text-sm font-bold text-[var(--color-academy-danger)] transition hover:bg-[var(--color-academy-danger-soft)]">
                        삭제
                    </button>
                )}
            </span>
        </div>
    );
}

// ── 상세 패널 내용 — 기존 카드에 있던 정보(횟수별 가격·셔틀 요금·설명)를 말줄임 없이 전부 ──

function ProgramDetailContent({
    program, onClose, onEdit,
}: {
    program: Program;
    onClose: () => void;
    onEdit: () => void;
}) {
    const days = program.days ? program.days.split(",").filter(Boolean) : [];
    const weekend = isWeekendOnly(days);
    const tiers = FREQ_TIERS.filter((t) => program[t.key] != null);
    const freq = program.weeklyFrequency || program.frequency;

    return (
        <>
            <div className="mb-4 flex items-start gap-2">
                <h3 id="program-detail-panel-title" className="min-w-0 break-keep break-words text-lg font-black text-[var(--color-academy-ink)]">{program.name}</h3>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="닫기"
                    className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                >
                    <span className="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
            </div>
            <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                <dt className="font-bold text-[var(--color-academy-muted)]">대상</dt>
                <dd className="min-w-0 break-keep text-[var(--color-academy-ink)]">{program.targetAge || "-"}</dd>
                <dt className="font-bold text-[var(--color-academy-muted)]">요일</dt>
                <dd className="text-[var(--color-academy-ink)]">{dayLabels(program).join(", ") || "-"}</dd>
                {tiers.length === 0 && freq && (
                    <>
                        <dt className="font-bold text-[var(--color-academy-muted)]">횟수</dt>
                        <dd className="text-[var(--color-academy-ink)]">{freq}</dd>
                    </>
                )}
                <dt className="font-bold text-[var(--color-academy-muted)]">수강료</dt>
                <dd className="min-w-0 text-[var(--color-academy-ink)]">
                    {tiers.length > 0 ? (
                        <ul className="space-y-1">
                            {tiers.map((t) => {
                                const fee = displayShuttleFee(program.shuttleFeeOverride, t.key, weekend);
                                return (
                                    <li key={t.key} className="flex flex-wrap items-baseline gap-x-2">
                                        <span className="w-14 text-xs text-[var(--color-academy-muted)]">{t.label}</span>
                                        <strong className="tabular-nums">{Number(program[t.key]).toLocaleString()}원</strong>
                                        {fee && <span className="text-xs tabular-nums text-[var(--color-academy-primary)]">+ 셔틀 {fee}</span>}
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <strong className="tabular-nums">{program.price.toLocaleString()}원 / 월</strong>
                    )}
                </dd>
                <dt className="font-bold text-[var(--color-academy-muted)]">셔틀</dt>
                <dd className="text-[var(--color-academy-ink)]">
                    {weekend ? "주말반 — 셔틀 운행 없음"
                        : (program.runsShuttle === false || program.shuttleFeeOverride === 0) ? "셔틀 미운행" : "운행"}
                </dd>
            </dl>
            {program.description && (
                <p className="mt-4 whitespace-pre-line break-keep break-words rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">{program.description}</p>
            )}
            <div className="mt-5 flex flex-wrap gap-2">
                <button type="button" onClick={onEdit}
                    className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]">
                    <span className="material-symbols-outlined text-lg" aria-hidden="true">edit</span>
                    수정
                </button>
            </div>
        </>
    );
}
