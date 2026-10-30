"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
    addToWaitlist,
    removeFromWaitlist,
    offerWaitlistSpot,
    processWaitlistResponse,
} from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { kstLabel } from "@/lib/datetime/kst";

// ── 타입 정의 ──────────────────────────────────────────────────────────────
type WaitlistItem = {
    id: string;
    studentId: string;
    classId: string;
    priority: number;
    status: string;
    offeredAt: string | null;
    respondBy: string | null;
    memo: string | null;
    createdAt: string;
    updatedAt: string;
    studentName: string;
    className: string;
    classDay: string;
    classStart: string;
    classEnd: string;
};

type CapacityInfo = {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    capacity: number;
    enrolled: number;
    remaining: number;
    waiting: number;
};

type Student = { id: string; name: string };
type ClassItem = { id: string; name: string; dayOfWeek: string; startTime: string; endTime: string; capacity: number };

type WaitlistPayload = {
    waitlist: WaitlistItem[];
    capacityInfo: CapacityInfo[];
    classes: ClassItem[];
};

// 요일 한글 변환
const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 상태 라벨 + 색상(화면 토큰)
const STATUS_CONFIG: Record<string, { label: string; tone: string }> = {
    WAITING: { label: "대기중", tone: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
    OFFERED: { label: "제안됨", tone: "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]" },
    ENROLLED: { label: "등록완료", tone: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" },
    CANCELLED: { label: "취소", tone: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" },
};

// 상태 필터 하나로 체크박스(«완료/취소 항목 포함»)와 상태 칩이 같은 값을 공유한다.
// ACTIVE = 예전 기본(대기중+제안됨), ALL = 예전 체크박스 켬, 그 밖 = 그 상태만
const STATUS_ACTIVE = "ACTIVE";
const STATUS_ALL = "ALL";
const STATUS_CHIP_VALUES = ["WAITING", "OFFERED", "ENROLLED", "CANCELLED"] as const;

function WaitlistLoadingFallback() {
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div className="space-y-2">
                    <div className="h-8 w-44 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    <div className="h-4 w-80 rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
                </div>
                <div className="h-11 w-28 rounded-lg bg-gray-200 dark:bg-gray-700 animate-pulse" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div
                        key={index}
                        className="h-32 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 animate-pulse"
                    />
                ))}
            </div>
            <div className="flex items-center gap-3">
                <div className="h-10 w-44 rounded-lg bg-gray-100 dark:bg-gray-800 animate-pulse" />
                <div className="h-5 w-32 rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
            </div>
            <div className="space-y-4">
                {Array.from({ length: 3 }).map((_, index) => (
                    <div
                        key={index}
                        className="h-40 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 animate-pulse"
                    />
                ))}
            </div>
        </div>
    );
}

function WaitlistErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-100 bg-white p-8 text-center shadow-sm dark:border-red-900/40 dark:bg-gray-800">
            <span className="material-symbols-outlined mb-3 text-4xl text-red-500">error</span>
            <p className="font-bold text-gray-900 dark:text-white">대기자 정보를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-xl bg-brand-orange-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-brand-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
            >
                다시 시도
            </button>
        </div>
    );
}

export default function WaitlistClient({
    waitlist: initialWaitlist,
    capacityInfo: initialCapacityInfo,
    classes: initialClasses,
}: {
    waitlist?: WaitlistItem[];
    capacityInfo?: CapacityInfo[];
    classes?: ClassItem[];
}) {
    const hasInitialData = Boolean(initialWaitlist && initialCapacityInfo && initialClasses);
    const [waitlist, setWaitlist] = useState<WaitlistItem[]>(initialWaitlist ?? []);
    const [capacityInfo, setCapacityInfo] = useState<CapacityInfo[]>(initialCapacityInfo ?? []);
    const [classes, setClasses] = useState<ClassItem[]>(initialClasses ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);
    const [students, setStudents] = useState<Student[]>([]);
    const [studentsLoaded, setStudentsLoaded] = useState(false);
    const [studentsLoading, setStudentsLoading] = useState(false);
    const [studentsError, setStudentsError] = useState<string | null>(null);
    // 필터: 특정 반만 보기
    const [filterClassId, setFilterClassId] = useState<string>("ALL");
    // 상태 필터: 활성(WAITING+OFFERED) / 전체 / 특정 상태 — 체크박스와 상태 칩이 같이 쓴다
    const [statusFilter, setStatusFilter] = useState<string>(STATUS_ACTIVE);
    const showAll = statusFilter === STATUS_ALL;
    // 행 클릭 상세 패널 대상(대기 id)
    const [detailId, setDetailId] = useState<string | null>(null);

    const hasAnyData = waitlist.length > 0 || capacityInfo.length > 0 || classes.length > 0;

    const loadWaitlistData = useCallback(async () => {
        setLoading(true);
        setLoadError(null);

        try {
            const response = await fetch("/api/admin/waitlist", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load waitlist.");
            }
            const data = (await response.json()) as WaitlistPayload;
            setWaitlist(data.waitlist);
            setCapacityInfo(data.capacityInfo);
            setClasses(data.classes);
        } catch (error) {
            console.error("Failed to load waitlist:", error);
            setLoadError("failed");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadWaitlistData();
    }, [hasInitialData, loadWaitlistData]);

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

    // 활성 대기자만 필터링 (WAITING + OFFERED), showAll이면 전체
    const filteredList = useMemo(() => {
        let list = statusFilter === STATUS_ALL
            ? waitlist
            : statusFilter === STATUS_ACTIVE
                ? waitlist.filter((w) => w.status === "WAITING" || w.status === "OFFERED")
                : waitlist.filter((w) => w.status === statusFilter);
        if (filterClassId !== "ALL") {
            list = list.filter((w) => w.classId === filterClassId);
        }
        return list;
    }, [waitlist, filterClassId, statusFilter]);

    // 상태 칩 건수 — 반 필터는 반영하고 상태 필터와는 무관하게 센다
    const statusChipItems = useMemo(() => {
        const inClass = filterClassId === "ALL" ? waitlist : waitlist.filter((w) => w.classId === filterClassId);
        return STATUS_CHIP_VALUES.map((value) => ({
            value,
            label: STATUS_CONFIG[value].label,
            count: inClass.filter((w) => w.status === value).length,
        }));
    }, [waitlist, filterClassId]);

    // 반별로 그룹핑
    const groupedByClass = useMemo(() => {
        const map = new Map<string, WaitlistItem[]>();
        for (const item of filteredList) {
            const key = item.classId;
            if (!map.has(key)) map.set(key, []);
            map.get(key)!.push(item);
        }
        return map;
    }, [filteredList]);

    // 정원 초과 또는 대기 있는 반만 상단 카드에 표시
    const classesWithActivity = useMemo(
        () => capacityInfo.filter((c) => c.waiting > 0 || c.remaining <= 0),
        [capacityInfo],
    );

    // ── 액션 핸들러 ──────────────────────────────────────────────────────────
    async function handleOffer(id: string) {
        if (!confirm("이 대기자에게 자리를 제안하시겠습니까?")) return;
        setBusy(true);
        try {
            await offerWaitlistSpot(id);
            await loadWaitlistData();
        } catch (e: any) {
            alert(adminErrorText(e, "자리 제안 실패"));
        } finally {
            setBusy(false);
        }
    }

    async function handleAccept(id: string) {
        if (!confirm("수락 처리하시겠습니까? 수강 등록이 생성됩니다.")) return;
        setBusy(true);
        try {
            await processWaitlistResponse(id, true);
            await loadWaitlistData();
        } catch (e: any) {
            alert(adminErrorText(e, "수락 처리 실패"));
        } finally {
            setBusy(false);
        }
    }

    async function handleReject(id: string) {
        if (!confirm("거절 처리하시겠습니까?")) return;
        setBusy(true);
        try {
            await processWaitlistResponse(id, false);
            await loadWaitlistData();
        } catch (e: any) {
            alert(adminErrorText(e, "거절 처리 실패"));
        } finally {
            setBusy(false);
        }
    }

    async function handleCancel(id: string) {
        if (!confirm("대기를 취소하시겠습니까?")) return;
        setBusy(true);
        try {
            await removeFromWaitlist(id);
            await loadWaitlistData();
        } catch (e: any) {
            alert(adminErrorText(e, "대기 취소 실패"));
        } finally {
            setBusy(false);
        }
    }

    // ⚡·상세 패널이 같이 쓰는 작업 — 예전 행의 자리 제안 / 수락·거절 / 대기 취소(X) 버튼을
    // 같은 함수·같은 인자로 옮긴 것(각 함수 안의 확인창도 그대로). 등록완료·취소 건은 예전처럼 작업 없음.
    function buildWaitlistActions(w: WaitlistItem): AdminQuickAction[] {
        const id = w.id; // 패널을 닫은 뒤 실행돼도 대상이 바뀌지 않게 미리 붙잡아 둔다
        const actions: AdminQuickAction[] = [];
        if (w.status === "WAITING") {
            actions.push({ key: "offer", label: "자리 제안", icon: "campaign", tone: "primary", disabled: busy, onSelect: () => handleOffer(id) });
        }
        if (w.status === "OFFERED") {
            actions.push({ key: "accept", label: "수락", icon: "check", tone: "primary", disabled: busy, onSelect: () => handleAccept(id) });
            actions.push({ key: "reject", label: "거절", icon: "block", disabled: busy, onSelect: () => handleReject(id) });
        }
        if (w.status === "WAITING" || w.status === "OFFERED") {
            actions.push({ key: "cancel", label: "대기 취소", icon: "close", tone: "danger", disabled: busy, onSelect: () => handleCancel(id) });
        }
        return actions;
    }

    // 행 키보드(Enter·Space) = 상세 패널. 행 안의 ⚡ 버튼에서 누른 키는 가로채지 않는다.
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailId(id);
        }
    }

    // 반 필터·상태 칩을 바꾸면 열린 패널은 닫는다
    function changeClassFilter(next: string) {
        setDetailId(null);
        setFilterClassId(next);
    }
    function changeStatusFilter(next: string) {
        setDetailId(null);
        setStatusFilter(next);
    }

    function statusBadge(w: WaitlistItem) {
        const cfg = STATUS_CONFIG[w.status] ?? STATUS_CONFIG.WAITING;
        return <span className={`rounded-full px-2 py-0.5 text-xs font-black ${cfg.tone}`}>{cfg.label}</span>;
    }

    if (loading && !hasAnyData) {
        return <WaitlistLoadingFallback />;
    }

    if (loadError && !hasAnyData) {
        return <WaitlistErrorState onRetry={loadWaitlistData} />;
    }

    // 표 칸 수(반 머리줄 colSpan 용)
    const columnCount = 7;
    const detail = detailId ? waitlist.find((w) => w.id === detailId) ?? null : null;

    return (
        <div className="space-y-3">
            {/* 페이지 헤더 */}
            <div className="flex items-center justify-between gap-2">
                <h1 className="flex items-center gap-2 text-lg font-black text-[var(--color-academy-ink)]">
                    <span className="material-symbols-outlined text-2xl text-[var(--color-academy-primary)]" aria-hidden="true">hourglass_top</span>
                    대기자 관리
                </h1>
                <button
                    onClick={() => {
                        setShowAddModal(true);
                        void loadStudents();
                    }}
                    className="inline-flex min-h-11 items-center gap-1.5 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] transition-colors hover:bg-[var(--color-academy-primary-hover)]"
                >
                    <span className="material-symbols-outlined text-xl" aria-hidden="true">person_add</span>
                    대기 등록
                </button>
            </div>

            {/* 반별 정원 현황 — 예전 큰 카드(정원 막대)를 한 줄 버튼으로. 누르면 그 반만 보기(다시 누르면 전체) */}
            {classesWithActivity.length > 0 && (
                <div className="flex flex-wrap gap-1.5" role="group" aria-label="반별 정원 현황">
                    {classesWithActivity.map((c) => {
                        const selected = filterClassId === c.id;
                        return (
                            <button
                                key={c.id}
                                type="button"
                                aria-pressed={selected}
                                onClick={() => changeClassFilter(selected ? "ALL" : c.id)}
                                className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 text-left text-sm transition ${
                                    selected
                                        ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary-soft)]"
                                        : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] hover:border-[var(--color-academy-primary)]"
                                }`}
                            >
                                <span className="font-bold text-[var(--color-academy-ink)]">{c.name}</span>
                                <span className="tabular-nums text-xs text-[var(--color-academy-muted)]">{DAY_LABELS[c.dayOfWeek] ?? c.dayOfWeek} {c.startTime}~{c.endTime}</span>
                                {/* 정원이 찼으면 위험색, 2자리 이하 남으면 주의색 */}
                                <span className={`tabular-nums text-xs font-bold ${c.remaining <= 0 ? "text-[var(--color-academy-danger)]" : c.remaining <= 2 ? "text-[var(--color-academy-warning)]" : "text-[var(--color-academy-success)]"}`}>
                                    등록 {c.enrolled}/{c.capacity}
                                </span>
                                <span className="tabular-nums text-xs text-[var(--color-academy-muted)]">잔여 {c.remaining}</span>
                                {c.waiting > 0 && (
                                    <span className="tabular-nums rounded-full bg-[var(--color-academy-warning-soft)] px-2 py-0.5 text-xs font-black text-[var(--color-academy-warning)]">대기 {c.waiting}</span>
                                )}
                            </button>
                        );
                    })}
                </div>
            )}

            {/* 필터 바: 반 선택 · 상태 칩(체크박스와 같은 상태값 공유) · 건수 */}
            <div className="flex flex-wrap items-center gap-2">
                <select
                    value={filterClassId}
                    onChange={(e) => changeClassFilter(e.target.value)}
                    aria-label="반 선택"
                    className="min-h-11 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-bold text-[var(--color-academy-ink)]"
                >
                    <option value="ALL">전체 반</option>
                    {classes.map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.name} ({DAY_LABELS[c.dayOfWeek] ?? c.dayOfWeek})
                        </option>
                    ))}
                </select>

                <StatusCountChips
                    ariaLabel="대기 상태별 건수"
                    items={statusChipItems}
                    selected={statusFilter}
                    onSelect={changeStatusFilter}
                    allValue={STATUS_ACTIVE}
                />

                <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-[var(--color-academy-muted)]">
                    <input
                        type="checkbox"
                        checked={showAll}
                        onChange={(e) => changeStatusFilter(e.target.checked ? STATUS_ALL : STATUS_ACTIVE)}
                        className="h-5 w-5 rounded border-[var(--color-academy-line)]"
                    />
                    완료/취소 항목 포함
                </label>

                <span className="ml-auto text-sm text-[var(--color-academy-muted)]">
                    총 <span className="tabular-nums">{filteredList.length}</span>건
                </span>
            </div>

            {/* 대기자 목록 — 한 줄 표, 반별 묶음 머리줄 */}
            {filteredList.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    대기자가 없습니다
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                    <table className="admin-list-table w-full border-collapse text-sm">
                        <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                            <tr>
                                <th className="admin-cell-num px-2 py-2">순번</th>
                                <th className="px-2 py-2">원생</th>
                                <th className="px-2 py-2">상태</th>
                                <th className="admin-cell-num hidden px-2 py-2 sm:table-cell">등록일</th>
                                <th className="admin-cell-num px-2 py-2">응답 기한</th>
                                <th className="admin-cell-center hidden px-2 py-2 sm:table-cell">메모</th>
                                <th className="admin-cell-center px-2 py-2">관리</th>
                            </tr>
                        </thead>
                        {Array.from(groupedByClass.entries()).map(([classId, items]) => (
                            <tbody key={classId} className="divide-y divide-[var(--color-academy-line)]">
                                {/* 반 머리줄: 반 이름 · 요일 시간 · n명 */}
                                <tr>
                                    <th colSpan={columnCount} scope="rowgroup" className="bg-[var(--color-academy-soft)] px-2 py-1.5 text-xs font-black text-[var(--color-academy-ink)]">
                                        {items[0].className}
                                        <span className="ml-2 font-bold tabular-nums text-[var(--color-academy-muted)]">
                                            {DAY_LABELS[items[0].classDay] ?? items[0].classDay} {items[0].classStart}~{items[0].classEnd}
                                        </span>
                                        <span className="ml-2 tabular-nums text-[var(--color-academy-muted)]">{items.length}명 대기</span>
                                    </th>
                                </tr>
                                {items.map((w, idx) => {
                                    const actions = buildWaitlistActions(w);
                                    return (
                                        <tr
                                            key={w.id}
                                            tabIndex={0}
                                            aria-label={`${w.studentName} ${w.className} 대기 상세 보기`}
                                            onClick={() => setDetailId(w.id)}
                                            onKeyDown={(event) => handleRowKeyDown(event, w.id)}
                                            className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                                        >
                                            <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{idx + 1}</td>
                                            <td className="px-2 py-1.5 font-black text-[var(--color-academy-ink)]">{w.studentName}</td>
                                            <td className="px-2 py-1.5">{statusBadge(w)}</td>
                                            <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] sm:table-cell">{kstLabel(w.createdAt) || "-"}</td>
                                            {/* 응답 기한은 제안됨(OFFERED)일 때만 */}
                                            <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-primary)]">{w.status === "OFFERED" && w.respondBy ? kstLabel(w.respondBy) : "-"}</td>
                                            {/* 메모는 줄이 늘어나지 않게 아이콘만, 내용은 상세 패널 */}
                                            <td className="admin-cell-center hidden px-2 py-1.5 sm:table-cell">
                                                {w.memo ? <span className="material-symbols-outlined text-base text-[var(--color-academy-muted)]" aria-label="메모 있음">sticky_note_2</span> : <span className="text-xs text-[var(--color-academy-muted)]">-</span>}
                                            </td>
                                            {/* 관리: ⚡. 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                                            <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                                                {actions.length > 0 ? (
                                                    <AdminQuickActionMenu label={`${w.studentName} 대기 빠른 작업`} actions={actions} />
                                                ) : (
                                                    <span className="text-xs text-[var(--color-academy-muted)]">-</span>
                                                )}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        ))}
                    </table>
                </div>
            )}

            {/* 행 클릭 상세 패널 — 이미 받아온 값만(새 조회 없음). 작업 버튼은 ⚡ 와 같은 목록 */}
            {detail && (() => {
                const d = detail;
                const actions = buildWaitlistActions(d);
                const panelRows: { label: string; value: React.ReactNode }[] = [
                    { label: "반", value: d.className },
                    { label: "수업", value: <span className="tabular-nums">{DAY_LABELS[d.classDay] ?? d.classDay} {d.classStart}~{d.classEnd}</span> },
                    { label: "등록일", value: kstLabel(d.createdAt) ? <span className="tabular-nums">{kstLabel(d.createdAt)}</span> : null },
                    { label: "제안일", value: d.offeredAt ? <span className="tabular-nums">{kstLabel(d.offeredAt)}</span> : null },
                    { label: "응답 기한", value: d.respondBy ? <span className="tabular-nums">{kstLabel(d.respondBy)}</span> : null },
                    { label: "메모", value: d.memo ? <span className="whitespace-pre-wrap">{d.memo}</span> : null },
                ].filter((row) => row.value !== null);
                return (
                    <ListDetailPanel onClose={() => setDetailId(null)} titleId="waitlist-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                        <div className="mb-4 flex items-center gap-2">
                            <h3 id="waitlist-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{d.studentName}</h3>
                            {statusBadge(d)}
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
                            {panelRows.map((row) => (
                                <div key={row.label} className="contents">
                                    <dt className="font-bold text-[var(--color-academy-muted)]">{row.label}</dt>
                                    <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{row.value}</dd>
                                </div>
                            ))}
                        </dl>
                        {actions.length > 0 && (
                            <div className="mt-5 flex flex-wrap gap-2">
                                {actions.map((action) => (
                                    <button
                                        key={action.key}
                                        type="button"
                                        disabled={action.disabled}
                                        onClick={() => { setDetailId(null); void action.onSelect(); }}
                                        className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-4 text-sm font-bold disabled:opacity-50 ${
                                            action.tone === "danger"
                                                ? "border-[var(--color-academy-danger)] text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]"
                                                : action.tone === "primary"
                                                    ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]"
                                                    : "border-[var(--color-academy-line)] text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"
                                        }`}
                                    >
                                        <span className="material-symbols-outlined text-lg" aria-hidden="true">{action.icon}</span>
                                        {action.label}
                                    </button>
                                ))}
                            </div>
                        )}
                    </ListDetailPanel>
                );
            })()}

            {/* 대기 등록 모달 */}
            {showAddModal && (
                <AddWaitlistModal
                    students={students}
                    studentsLoading={studentsLoading}
                    studentsError={studentsError}
                    onRetryLoadStudents={loadStudents}
                    classes={classes}
                    onClose={() => setShowAddModal(false)}
                    onDone={async () => {
                        setShowAddModal(false);
                        await loadWaitlistData();
                    }}
                />
            )}
        </div>
    );
}

// ── 대기 등록 모달 ──────────────────────────────────────────────────────────
function AddWaitlistModal({
    students,
    studentsLoading,
    studentsError,
    onRetryLoadStudents,
    classes,
    onClose,
    onDone,
}: {
    students: Student[];
    studentsLoading: boolean;
    studentsError: string | null;
    onRetryLoadStudents: () => Promise<void>;
    classes: ClassItem[];
    onClose: () => void;
    onDone: () => Promise<void> | void;
}) {
    const [studentId, setStudentId] = useState("");
    const [classId, setClassId] = useState("");
    const [memo, setMemo] = useState("");
    const [busy, setBusy] = useState(false);
    // 학생 검색 필터
    const [studentSearch, setStudentSearch] = useState("");

    const filteredStudents = useMemo(
        () => studentSearch.trim()
            ? students.filter((s) => s.name.includes(studentSearch.trim()))
            : students,
        [students, studentSearch],
    );

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!studentId || !classId) {
            alert("학생과 반을 선택해주세요.");
            return;
        }
        setBusy(true);
        try {
            await addToWaitlist(studentId, classId, memo || undefined);
            await onDone();
        } catch (err: any) {
            alert(adminErrorText(err, "대기 등록 실패"));
        } finally {
            setBusy(false);
        }
    }

    return (
        <AdminModal
            titleId="add-waitlist-title"
            onClose={onClose}
            closeOnBackdrop={false}
            panelClassName="max-w-md"
        >
            <div className="w-full p-6">
                <div className="flex items-center justify-between mb-5">
                    <h3 id="add-waitlist-title" className="text-lg font-bold text-gray-900 dark:text-white flex items-center gap-2">
                        <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime">person_add</span>
                        대기 등록
                    </h3>
                    <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:text-gray-300">
                        <span className="material-symbols-outlined">close</span>
                    </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-4">
                    {/* 학생 선택 */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">학생 *</label>
                        <input
                            type="text"
                            placeholder="이름 검색..."
                            value={studentSearch}
                            onChange={(e) => setStudentSearch(e.target.value)}
                            disabled={studentsLoading || Boolean(studentsError)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm mb-1"
                        />
                        <select
                            value={studentId}
                            onChange={(e) => setStudentId(e.target.value)}
                            disabled={studentsLoading || Boolean(studentsError)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                            size={5}
                        >
                            <option value="">
                                {studentsLoading ? "학생 목록 로딩 중..." : "-- 학생 선택 --"}
                            </option>
                            {filteredStudents.map((s) => (
                                <option key={s.id} value={s.id}>{s.name}</option>
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
                                등록된 학생이 없습니다.
                            </p>
                        )}
                    </div>

                    {/* 반 선택 */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">반 *</label>
                        <select
                            value={classId}
                            onChange={(e) => setClassId(e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        >
                            <option value="">-- 반 선택 --</option>
                            {classes.map((c) => (
                                <option key={c.id} value={c.id}>
                                    {c.name} ({DAY_LABELS[c.dayOfWeek] ?? c.dayOfWeek} {c.startTime}~{c.endTime})
                                </option>
                            ))}
                        </select>
                    </div>

                    {/* 메모 */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">메모 (선택)</label>
                        <input
                            type="text"
                            value={memo}
                            onChange={(e) => setMemo(e.target.value)}
                            placeholder="대기 사유나 참고사항"
                            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
                        />
                    </div>

                    {/* 버튼 */}
                    <div className="flex justify-end gap-2 pt-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 dark:text-gray-100"
                        >
                            취소
                        </button>
                        <button
                            type="submit"
                            disabled={busy}
                            className="px-5 py-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white text-sm font-semibold rounded-lg hover:bg-brand-orange-600 dark:hover:bg-lime-400 disabled:opacity-50 transition-colors"
                        >
                            {busy ? "등록 중..." : "대기 등록"}
                        </button>
                    </div>
                </form>
            </div>
        </AdminModal>
    );
}
