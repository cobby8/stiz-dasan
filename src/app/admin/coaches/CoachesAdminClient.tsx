"use client";

import { Fragment, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { createCoach, updateCoach, deleteCoach, reorderCoaches } from "@/app/actions/admin";
import { compressImageForUpload } from "@/lib/clientImageCompression";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";

interface Coach {
    id: string;
    name: string;
    role: string;
    description: string | null;
    imageUrl: string | null;
    phone: string | null;
    order: number;
}

interface FormState {
    name: string;
    role: string;
    description: string;
    phone: string;
    imageUrl: string;
    imageFile: File | null;
    previewUrl: string | null;
}

type CoachesPayload = {
    coaches: Coach[];
};

function defaultForm(coach?: Coach): FormState {
    return {
        name: coach?.name ?? "",
        role: coach?.role ?? "",
        description: coach?.description ?? "",
        phone: coach?.phone ?? "",
        imageUrl: coach?.imageUrl ?? "",
        imageFile: null,
        previewUrl: coach?.imageUrl ?? null,
    };
}

function getErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback;
}

async function uploadImage(file: File): Promise<string> {
    const compressed = await compressImageForUpload(file, { maxEdge: 1200, targetBytes: 600 * 1024 });
    const fd = new FormData();
    fd.append("file", compressed);
    const res = await fetch("/api/upload", { method: "POST", body: fd });
    if (!res.ok) throw new Error("이미지 업로드 실패");
    const json = await res.json();
    return json.url as string;
}

// size="sm" 은 목록 한 줄 행용 작은 원(32px), 기본은 상세 패널용(56px)
function CoachPhoto({ url, name, size = "md" }: { url: string | null; name: string; size?: "sm" | "md" }) {
    const box = size === "sm" ? "h-8 w-8" : "h-14 w-14";
    if (url) {
        return (
            <img
                src={url}
                alt={name}
                className={`${box} shrink-0 rounded-full border border-[var(--color-academy-line)] object-cover`}
            />
        );
    }
    return (
        <div className={`${box} flex shrink-0 items-center justify-center rounded-full bg-[var(--color-academy-soft)] text-xs font-bold text-[var(--color-academy-muted)]`}>
            {size === "sm" ? name.charAt(0) : "없음"}
        </div>
    );
}

function CoachesLoadingFallback() {
    return (
        <div className="space-y-8">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <div className="h-8 w-44 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    <div className="mt-2 h-4 w-80 max-w-full rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
                </div>
                <div className="h-10 w-28 rounded-xl bg-gray-200 dark:bg-gray-700 animate-pulse" />
            </div>
            <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 dark:border-gray-700">
                    <div className="h-5 w-32 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                    <div className="h-4 w-36 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-700">
                    {Array.from({ length: 5 }).map((_, index) => (
                        <div key={index} className="flex items-center justify-between gap-4 px-6 py-4">
                            <div className="flex min-w-0 flex-1 items-center gap-4">
                                <div className="h-14 w-14 rounded-full bg-gray-100 dark:bg-gray-700 animate-pulse" />
                                <div className="min-w-0 flex-1 space-y-2">
                                    <div className="h-5 w-36 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                                    <div className="h-4 w-56 max-w-full rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                                </div>
                            </div>
                            <div className="hidden gap-2 sm:flex">
                                <div className="h-8 w-16 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" />
                                <div className="h-8 w-16 rounded-lg bg-gray-100 dark:bg-gray-700 animate-pulse" />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function CoachesErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-100 bg-white p-8 text-center shadow-sm dark:border-red-900/40 dark:bg-gray-800">
            <span className="material-symbols-outlined mb-3 text-4xl text-red-500">error</span>
            <p className="font-bold text-gray-900 dark:text-white">코치 목록을 불러오지 못했습니다.</p>
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

function ImageUploadField({
    form,
    onChange,
}: {
    form: FormState;
    onChange: (patch: Partial<FormState>) => void;
}) {
    const fileRef = useRef<HTMLInputElement>(null);

    function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (!file) return;
        const previewUrl = URL.createObjectURL(file);
        onChange({ imageFile: file, previewUrl, imageUrl: "" });
    }

    function handleClear() {
        onChange({ imageFile: null, previewUrl: null, imageUrl: "" });
        if (fileRef.current) fileRef.current.value = "";
    }

    const displayUrl = form.previewUrl ?? form.imageUrl;

    return (
        <div>
            <label className="block text-xs font-bold text-gray-700 dark:text-gray-200 mb-1">
                프로필 사진
                <span className="text-gray-400 font-normal ml-1">(직접 업로드)</span>
            </label>
            <div className="flex items-center gap-3">
                {displayUrl ? (
                    <img src={displayUrl} alt="preview" className="w-14 h-14 rounded-full object-cover border border-gray-200 dark:border-gray-700 shrink-0" />
                ) : (
                    <div className="w-14 h-14 rounded-full bg-gray-100 dark:bg-gray-800 border border-dashed border-gray-300 flex items-center justify-center text-gray-400 text-xs shrink-0">
                        사진
                    </div>
                )}
                <div className="flex-1 space-y-1.5">
                    <input
                        ref={fileRef}
                        type="file"
                        accept="image/*"
                        onChange={handleFile}
                        className="block w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-bold file:bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 file:text-white hover:file:bg-orange-600 cursor-pointer"
                    />
                    {displayUrl && (
                        <button
                            type="button"
                            onClick={handleClear}
                            className="text-xs text-red-500 hover:text-red-700"
                        >
                            사진 제거
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

export default function CoachesAdminClient({ initialCoaches }: { initialCoaches?: Coach[] }) {
    const [pending, startTransition] = useTransition();
    const hasInitialData = Boolean(initialCoaches);
    const [coaches, setCoaches] = useState<Coach[]>(initialCoaches ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);
    const [showAddModal, setShowAddModal] = useState(false);
    const [addForm, setAddForm] = useState<FormState>(defaultForm());
    const [addError, setAddError] = useState<string | null>(null);
    const [editId, setEditId] = useState<string | null>(null);
    const [editForm, setEditForm] = useState<FormState>(defaultForm());
    const [editError, setEditError] = useState<string | null>(null);
    // 행 클릭 상세 패널 대상(코치 id)
    const [detailId, setDetailId] = useState<string | null>(null);

    // Drag state
    const dragIndex = useRef<number | null>(null);
    const [dragOver, setDragOver] = useState<number | null>(null);

    const loadCoaches = useCallback(async () => {
        setLoading(true);
        setLoadError(false);

        try {
            const response = await fetch("/api/admin/coaches", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load coaches.");
            }

            const data = (await response.json()) as CoachesPayload;
            setCoaches(data.coaches);
        } catch (error) {
            console.error("Failed to load coaches:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadCoaches();
    }, [hasInitialData, loadCoaches]);

    function patchAdd(patch: Partial<FormState>) {
        setAddForm((f) => ({ ...f, ...patch }));
    }
    function patchEdit(patch: Partial<FormState>) {
        setEditForm((f) => ({ ...f, ...patch }));
    }

    async function handleAdd() {
        if (!addForm.name.trim() || !addForm.role.trim()) return;
        setAddError(null);
        startTransition(async () => {
            try {
                let imageUrl = addForm.imageUrl;
                if (addForm.imageFile) imageUrl = await uploadImage(addForm.imageFile);
                const maxOrder = coaches.length > 0 ? Math.max(...coaches.map((c) => c.order)) : 0;
                await createCoach({
                    name: addForm.name.trim(),
                    role: addForm.role.trim(),
                    description: addForm.description.trim() || undefined,
                    phone: addForm.phone.trim() || undefined,
                    imageUrl: imageUrl.trim() || undefined,
                    order: maxOrder + 1,
                });
                setAddForm(defaultForm());
                setShowAddModal(false);
                await loadCoaches();
            } catch (e: unknown) {
                setAddError(getErrorMessage(e, "추가 실패"));
            }
        });
    }

    function startEdit(coach: Coach) {
        setEditId(coach.id);
        setEditForm(defaultForm(coach));
        setEditError(null);
    }

    function cancelEdit() {
        setEditId(null);
        setEditError(null);
    }

    async function handleUpdate(id: string) {
        setEditError(null);
        startTransition(async () => {
            try {
                let imageUrl = editForm.imageUrl;
                if (editForm.imageFile) imageUrl = await uploadImage(editForm.imageFile);
                const updatedData = {
                    name: editForm.name.trim(),
                    role: editForm.role.trim(),
                    description: editForm.description.trim() || undefined,
                    phone: editForm.phone.trim() || undefined,
                    imageUrl: imageUrl.trim() || undefined,
                };
                await updateCoach(id, updatedData);
                // 로컬 상태도 즉시 업데이트 (새로고침 없이 바로 반영)
                setCoaches((prev) => prev.map((c) => c.id === id ? {
                    ...c,
                    ...updatedData,
                    description: updatedData.description || null,
                    phone: updatedData.phone || null,
                    imageUrl: updatedData.imageUrl || null,
                } : c));
                setEditId(null);
                await loadCoaches();
            } catch (e: unknown) {
                setEditError(getErrorMessage(e, "수정 실패"));
            }
        });
    }

    async function handleDelete(id: string) {
        startTransition(async () => {
            try {
                await deleteCoach(id);
                setCoaches((prev) => prev.filter((c) => c.id !== id));
                await loadCoaches();
            } catch (e: unknown) {
                alert(getErrorMessage(e, "삭제 실패"));
            }
        });
    }

    // ── Drag & Drop handlers ──────────────────────────────────────────────
    function onDragStart(e: React.DragEvent, index: number) {
        dragIndex.current = index;
        e.dataTransfer.effectAllowed = "move";
    }

    function onDragOver(e: React.DragEvent, index: number) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDragOver(index);
    }

    function onDrop(e: React.DragEvent, dropIndex: number) {
        e.preventDefault();
        const from = dragIndex.current;
        if (from === null || from === dropIndex) {
            dragIndex.current = null;
            setDragOver(null);
            return;
        }
        const previous = [...coaches];
        const next = [...coaches];
        const [moved] = next.splice(from, 1);
        next.splice(dropIndex, 0, moved);
        setCoaches(next);
        dragIndex.current = null;
        setDragOver(null);
        startTransition(async () => {
            try {
                await reorderCoaches(next.map((c) => c.id));
                await loadCoaches();
            } catch (e: unknown) {
                alert(getErrorMessage(e, "순서 변경 실패"));
                setCoaches(previous);
            }
        });
    }

    function onDragEnd() {
        dragIndex.current = null;
        setDragOver(null);
    }

    const INPUT = "w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2.5 text-sm dark:text-white bg-gray-50 focus:bg-white dark:focus:bg-gray-700 dark:bg-gray-800 focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime focus:border-brand-orange-500 dark:border-brand-neon-lime transition";
    const TEXTAREA = INPUT + " resize-none";

    // ⚡·상세 패널이 같이 쓰는 작업 — 예전 ⚡ 의 수정(인라인 폼 열기/닫기)·삭제(확인창) 그대로
    function buildCoachActions(coach: Coach): AdminQuickAction[] {
        return [
            {
                key: "edit",
                label: editId === coach.id ? "수정 닫기" : "수정",
                icon: editId === coach.id ? "close" : "edit",
                onSelect: () => editId === coach.id ? cancelEdit() : startEdit(coach),
            },
            {
                key: "delete",
                label: "삭제",
                icon: "delete",
                tone: "danger",
                disabled: pending,
                onSelect: () => {
                    if (window.confirm(`"${coach.name}" 강사를 삭제할까요?`)) {
                        void handleDelete(coach.id);
                    }
                },
            },
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

    const detail = detailId ? coaches.find((c) => c.id === detailId) ?? null : null;

    if (loading && coaches.length === 0) {
        return <CoachesLoadingFallback />;
    }

    if (loadError && coaches.length === 0) {
        return <CoachesErrorState onRetry={loadCoaches} />;
    }

    return (
        <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
                <div>
                    <h1 className="text-lg font-black text-[var(--color-academy-ink)]">코치/강사진 관리</h1>
                    <p className="text-xs text-[var(--color-academy-muted)]">학원소개 페이지 코치진 소개 및 시간표 코치 배정에 사용됩니다.</p>
                </div>
                <button
                    onClick={() => { setAddForm(defaultForm()); setAddError(null); setShowAddModal(true); }}
                    className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 text-sm font-bold text-[var(--color-academy-ink)] transition hover:bg-[var(--color-academy-soft)]"
                >
                    <span className="material-symbols-outlined text-lg text-[var(--color-academy-primary)]" aria-hidden="true">add</span> 강사 추가
                </button>
            </div>

            {/* 강사 추가 모달 */}
            {showAddModal && (
                <AdminModal onClose={() => setShowAddModal(false)} titleId="add-coach-modal-title" panelClassName="max-w-xl">
                        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-gray-800">
                            <span id="add-coach-modal-title" className="font-bold text-gray-800 dark:text-gray-100 text-base">강사 추가</span>
                            <button onClick={() => setShowAddModal(false)} className="text-gray-400 hover:text-gray-600 dark:text-gray-300 text-xl leading-none">✕</button>
                        </div>
                        <div className="p-6 space-y-4">
                            {addError && (
                                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3">
                                    {addError}
                                </div>
                            )}
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-bold text-gray-700 dark:text-gray-200 mb-1">이름 *</label>
                                    <input
                                        type="text"
                                        value={addForm.name}
                                        onChange={(e) => patchAdd({ name: e.target.value })}
                                        placeholder="예: 홍길동"
                                        className={INPUT}
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-bold text-gray-700 dark:text-gray-200 mb-1">직책 *</label>
                                    <input
                                        type="text"
                                        value={addForm.role}
                                        onChange={(e) => patchAdd({ role: e.target.value })}
                                        placeholder="예: 원장, 수석코치"
                                        className={INPUT}
                                    />
                                </div>
                            </div>
                            {/* 전화번호 — SMS 수신용 (선택) */}
                            <div>
                                <label className="block text-xs font-bold text-gray-700 dark:text-gray-200 mb-1">
                                    전화번호
                                    <span className="text-gray-400 font-normal ml-1">(SMS 수신용, 선택)</span>
                                </label>
                                <input
                                    type="tel"
                                    value={addForm.phone}
                                    onChange={(e) => {
                                        const nums = e.target.value.replace(/\D/g, "").slice(0, 11);
                                        let formatted = nums;
                                        if (nums.length > 7) formatted = `${nums.slice(0,3)}-${nums.slice(3,7)}-${nums.slice(7)}`;
                                        else if (nums.length > 3) formatted = `${nums.slice(0,3)}-${nums.slice(3)}`;
                                        patchAdd({ phone: formatted });
                                    }}
                                    placeholder="숫자만 입력 (자동 변환: 010-1234-5678)"
                                    className={INPUT}
                                />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-700 dark:text-gray-200 mb-1">
                                    약력 / 소개
                                </label>
                                <textarea
                                    value={addForm.description}
                                    onChange={(e) => patchAdd({ description: e.target.value })}
                                    placeholder={"예:\nWKBL 선수 출신 (2010~2018)\n서울대학교 체육교육과 졸업\n대한농구협회 지도자 2급 자격증"}
                                    rows={4}
                                    className={TEXTAREA}
                                />
                            </div>
                            <ImageUploadField form={addForm} onChange={patchAdd} />
                            <div className="flex justify-end gap-2 pt-2">
                                <button
                                    onClick={() => setShowAddModal(false)}
                                    className="px-4 py-2.5 text-sm text-gray-600 dark:text-gray-300 border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-900 transition"
                                >
                                    취소
                                </button>
                                <button
                                    onClick={handleAdd}
                                    disabled={pending || !addForm.name.trim() || !addForm.role.trim()}
                                    className="bg-brand-navy-900 text-white px-6 py-2.5 rounded-lg font-bold hover:bg-gray-800 transition disabled:opacity-40"
                                >
                                    {pending ? "처리 중..." : "추가하기"}
                                </button>
                            </div>
                        </div>
                </AdminModal>
            )}

            {/* ── 코치 목록 — 한 줄 표(끌어서 순서 바꾸기는 행에 그대로) ─────────── */}
            <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                <div className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-3 py-2">
                    <h2 className="text-sm font-black text-[var(--color-academy-ink)]">
                        등록된 코치 <span className="tabular-nums text-[var(--color-academy-primary)]">{coaches.length}명</span>
                    </h2>
                    <span className="text-xs text-[var(--color-academy-muted)]">끌어서 순서 변경</span>
                </div>

                {coaches.length === 0 && (
                    <div className="p-4 text-center text-sm text-[var(--color-academy-muted)]">등록된 코치가 없습니다.</div>
                )}

                {coaches.length > 0 && (
                    <div className="overflow-x-auto">
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                                <tr>
                                    <th className="admin-cell-center w-8 px-1 py-2"><span className="sr-only">순서</span></th>
                                    <th className="admin-cell-center px-2 py-2">사진</th>
                                    <th className="px-2 py-2">이름</th>
                                    <th className="px-2 py-2">직책</th>
                                    <th className="admin-cell-num hidden px-2 py-2 sm:table-cell">전화번호</th>
                                    <th className="admin-cell-center hidden px-2 py-2 sm:table-cell">소개</th>
                                    <th className="admin-cell-center px-2 py-2">관리</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--color-academy-line)]">
                                {coaches.map((coach, i) => (
                                    <Fragment key={coach.id}>
                                        <tr
                                            draggable
                                            onDragStart={(e) => onDragStart(e, i)}
                                            onDragOver={(e) => onDragOver(e, i)}
                                            onDrop={(e) => onDrop(e, i)}
                                            onDragEnd={onDragEnd}
                                            tabIndex={0}
                                            aria-label={`${coach.name} 코치 상세 보기`}
                                            onClick={() => setDetailId(coach.id)}
                                            onKeyDown={(event) => handleRowKeyDown(event, coach.id)}
                                            className={`cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none ${dragOver === i ? "border-t-2 border-t-[var(--color-academy-primary)] bg-[var(--color-academy-primary-soft)]" : ""}`}
                                        >
                                            {/* 드래그 핸들 */}
                                            <td className="admin-cell-center px-1 py-1.5">
                                                <span className="material-symbols-outlined cursor-grab select-none text-lg text-[var(--color-academy-muted)] active:cursor-grabbing" title="드래그하여 순서 변경" aria-hidden="true">drag_indicator</span>
                                            </td>
                                            {/* 사진 — 행 높이를 지키려고 작은 원(큰 사진은 상세 패널) */}
                                            <td className="admin-cell-center px-2 py-1">
                                                <CoachPhoto url={coach.imageUrl} name={coach.name} size="sm" />
                                            </td>
                                            <td className="px-2 py-1.5 font-black text-[var(--color-academy-ink)]">{coach.name}</td>
                                            <td className="px-2 py-1.5">
                                                <span className="rounded-full bg-[var(--color-academy-primary-soft)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-primary)]">{coach.role}</span>
                                            </td>
                                            <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] sm:table-cell">{coach.phone || "-"}</td>
                                            {/* 소개(약력)는 여러 줄이라 표시만, 전문은 상세 패널 */}
                                            <td className="admin-cell-center hidden px-2 py-1.5 sm:table-cell">
                                                {coach.description ? <span className="material-symbols-outlined text-base text-[var(--color-academy-muted)]" aria-label="소개 있음">description</span> : <span className="text-xs text-[var(--color-academy-muted)]">-</span>}
                                            </td>
                                            {/* 관리: ⚡(수정·삭제). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                                            <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                                                <AdminQuickActionMenu label={`${coach.name} 빠른 작업`} actions={buildCoachActions(coach)} />
                                            </td>
                                        </tr>

                                        {/* 편집 폼 (인라인 확장) — 폼 내용은 예전 그대로, 행 바로 아래 펼침 칸에 */}
                                        {editId === coach.id && (
                                            <tr>
                                                <td colSpan={7} className="p-0">
                                                    <div className="whitespace-normal border-t border-blue-200 bg-blue-50 px-6 py-5 text-left">
                                                        <h3 className="text-sm font-bold text-blue-800 mb-4">코치 정보 수정</h3>
                                                        {editError && (
                                                            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg p-3 mb-4">
                                                                {editError}
                                                            </div>
                                                        )}
                                                        <div className="space-y-4">
                                                            <div className="grid grid-cols-2 gap-4">
                                                                <div>
                                                                    <label className="block text-xs font-bold text-gray-700 dark:text-gray-200 mb-1">이름 *</label>
                                                                    <input
                                                                        type="text"
                                                                        value={editForm.name}
                                                                        onChange={(e) => patchEdit({ name: e.target.value })}
                                                                        className={INPUT}
                                                                    />
                                                                </div>
                                                                <div>
                                                                    <label className="block text-xs font-bold text-gray-700 dark:text-gray-200 mb-1">직책 *</label>
                                                                    <input
                                                                        type="text"
                                                                        value={editForm.role}
                                                                        onChange={(e) => patchEdit({ role: e.target.value })}
                                                                        className={INPUT}
                                                                    />
                                                                </div>
                                                            </div>

                                                            {/* 전화번호 — SMS 수신용 (선택) */}
                                                            <div>
                                                                <label className="block text-xs font-bold text-gray-700 dark:text-gray-200 mb-1">
                                                                    전화번호
                                                                    <span className="text-gray-400 font-normal ml-1">(SMS 수신용, 선택)</span>
                                                                </label>
                                                                <input
                                                                    type="tel"
                                                                    value={editForm.phone}
                                                                    onChange={(e) => {
                                                                        // 숫자만 추출 후 자동 하이픈 포맷팅
                                                                        const nums = e.target.value.replace(/\D/g, "").slice(0, 11);
                                                                        let formatted = nums;
                                                                        if (nums.length > 7) formatted = `${nums.slice(0,3)}-${nums.slice(3,7)}-${nums.slice(7)}`;
                                                                        else if (nums.length > 3) formatted = `${nums.slice(0,3)}-${nums.slice(3)}`;
                                                                        patchEdit({ phone: formatted });
                                                                    }}
                                                                    placeholder="숫자만 입력 (자동 변환: 010-1234-5678)"
                                                                    className={INPUT}
                                                                />
                                                            </div>

                                                            <div>
                                                                <label className="block text-xs font-bold text-gray-700 dark:text-gray-200 mb-1">약력 / 소개</label>
                                                                <textarea
                                                                    value={editForm.description}
                                                                    onChange={(e) => patchEdit({ description: e.target.value })}
                                                                    rows={4}
                                                                    className={TEXTAREA}
                                                                />
                                                            </div>

                                                            <ImageUploadField form={editForm} onChange={patchEdit} />

                                                            <div className="flex justify-end gap-3 pt-2">
                                                                <button
                                                                    onClick={cancelEdit}
                                                                    className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:bg-gray-800 rounded-lg transition"
                                                                >
                                                                    취소
                                                                </button>
                                                                <button
                                                                    onClick={() => handleUpdate(coach.id)}
                                                                    disabled={pending || !editForm.name.trim() || !editForm.role.trim()}
                                                                    className="px-5 py-2 text-sm font-bold bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white rounded-lg hover:bg-orange-600 transition disabled:opacity-40"
                                                                >
                                                                    {pending ? "저장 중..." : "저장하기"}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* 행 클릭 상세 패널 — 큰 사진·소개 전문. 작업 버튼은 ⚡ 와 같은 목록 */}
            {detail && (
                <ListDetailPanel onClose={() => setDetailId(null)} titleId="coach-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <div className="mb-4 flex items-center gap-3">
                        <CoachPhoto url={detail.imageUrl} name={detail.name} />
                        <div className="min-w-0">
                            <h3 id="coach-detail-panel-title" className="break-keep text-lg font-black text-[var(--color-academy-ink)]">{detail.name}</h3>
                            <span className="rounded-full bg-[var(--color-academy-primary-soft)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-primary)]">{detail.role}</span>
                        </div>
                        <button type="button" onClick={() => setDetailId(null)} aria-label="닫기" className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                            <span className="material-symbols-outlined" aria-hidden="true">close</span>
                        </button>
                    </div>
                    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                        <dt className="font-bold text-[var(--color-academy-muted)]">전화번호</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{detail.phone || "-"}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">소개</dt>
                        <dd className="whitespace-pre-line break-keep text-[var(--color-academy-ink)]">{detail.description || "-"}</dd>
                    </dl>
                    <div className="mt-5 flex flex-wrap gap-2">
                        {buildCoachActions(detail).map((action) => (
                            <button
                                key={action.key}
                                type="button"
                                disabled={action.disabled}
                                onClick={() => { setDetailId(null); void action.onSelect(); }}
                                className={`inline-flex min-h-11 items-center gap-1 rounded-lg border px-4 text-sm font-bold disabled:opacity-50 ${
                                    action.tone === "danger"
                                        ? "border-[var(--color-academy-danger)] text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]"
                                        : "border-[var(--color-academy-line)] text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]"
                                }`}
                            >
                                <span className="material-symbols-outlined text-lg" aria-hidden="true">{action.icon}</span>
                                {action.label}
                            </button>
                        ))}
                    </div>
                </ListDetailPanel>
            )}
        </div>
    );
}
