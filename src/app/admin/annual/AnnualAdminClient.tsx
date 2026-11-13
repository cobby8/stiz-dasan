"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";
import AdminPageHeader from "@/components/admin/AdminPageHeader";

import { useCallback, useEffect, useState } from "react";
import { createAnnualEvent, updateAnnualEvent, deleteAnnualEvent, updateAcademySettings } from "@/app/actions/admin";
import AdminQuickActionMenu from "@/components/admin/AdminQuickActionMenu";
import { useAdminConfirm } from "@/components/admin/AdminConfirmDialog";

type AnnualEvent = {
    id: string;
    title: string;
    date: Date | string;
    endDate?: Date | string | null;
    description?: string | null;
    category?: string | null;
};

type AnnualPayload = {
    events: AnnualEvent[];
    initialIcsUrl: string;
};

const CATEGORIES = ["일반", "대회", "방학", "특별행사", "정기행사"] as const;

const CATEGORY_COLORS: Record<string, string> = {
    "대회": "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
    "방학": "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
    "특별행사": "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
    "정기행사": "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
    "일반": "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
};

function AnnualLoadingFallback() {
    return (
        <div className="max-w-4xl mx-auto">
            <div className="mb-6 flex items-center justify-between gap-4">
                <div>
                    <div className="h-8 w-40 animate-pulse rounded bg-[var(--color-academy-line)]" />
                    <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-[var(--color-academy-soft)]" />
                </div>
                <div className="h-10 w-28 animate-pulse rounded-lg bg-[var(--color-academy-line)]" />
            </div>
            <div className="mb-6 rounded-xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm">
                <div className="h-5 w-40 animate-pulse rounded bg-[var(--color-academy-line)]" />
                <div className="mt-3 h-4 w-full animate-pulse rounded bg-[var(--color-academy-soft)]" />
                <div className="mt-2 h-4 w-3/4 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                <div className="mt-4 flex gap-2">
                    <div className="h-10 flex-1 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
                    <div className="h-10 w-20 animate-pulse rounded-lg bg-[var(--color-academy-line)]" />
                </div>
            </div>
            <div className="space-y-6">
                {Array.from({ length: 2 }).map((_, yearIndex) => (
                    <section key={yearIndex}>
                        <div className="mb-3 h-6 w-20 animate-pulse rounded bg-[var(--color-academy-line)]" />
                        <div className="rounded-xl border border-[var(--color-academy-line)] bg-white">
                            {Array.from({ length: 4 }).map((_, rowIndex) => (
                                <div key={rowIndex} className="flex items-center justify-between gap-4 border-b border-[var(--color-academy-line)] p-4 last:border-b-0">
                                    <div className="flex min-w-0 flex-1 items-center gap-4">
                                        <div className="h-4 w-24 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                                        <div className="min-w-0 flex-1 space-y-2">
                                            <div className="h-5 w-2/3 animate-pulse rounded bg-[var(--color-academy-line)]" />
                                            <div className="h-4 w-1/2 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                                        </div>
                                    </div>
                                    <div className="hidden gap-2 sm:flex">
                                        <div className="h-8 w-8 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
                                        <div className="h-8 w-8 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </div>
    );
}

function AnnualErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="mx-auto max-w-4xl rounded-xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] p-6 text-center">
            <p className="text-sm font-medium text-[var(--color-academy-danger)]">연간일정을 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="academy-button-secondary mt-4"
            >
                다시 불러오기
            </button>
        </div>
    );
}

function toDateString(d: Date | string | null | undefined): string {
    if (!d) return "";
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().split("T")[0];
}

function getErrorMessage(error: unknown, fallback: string): string {
    return adminErrorText(error, fallback);
}

export default function AnnualAdminClient({
    events: initialEvents,
    initialIcsUrl = "",
}: {
    events?: AnnualEvent[];
    initialIcsUrl?: string;
}) {
    // 삭제 확인 = 공용 확인 창(브라우저 기본 confirm 대신) — 대상 이름·위험색 확정
    const { confirm: askConfirm, confirmDialog } = useAdminConfirm();
    const hasInitialData = initialEvents !== undefined;
    const [events, setEvents] = useState<AnnualEvent[]>(initialEvents ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    // ICS URL 관련 상태
    const [icsUrl, setIcsUrl] = useState(initialIcsUrl);
    const [icsSaving, setIcsSaving] = useState(false);
    const [icsMsg, setIcsMsg] = useState<string | null>(null);

    const loadAnnual = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const response = await fetch("/api/admin/annual", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load annual events.");
            }
            const data = (await response.json()) as AnnualPayload;
            setEvents(data.events);
            setIcsUrl(data.initialIcsUrl || "");
        } catch (error) {
            console.error("Failed to load annual events:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadAnnual();
    }, [hasInitialData, loadAnnual]);

    // Form state
    const [title, setTitle] = useState("");
    const [date, setDate] = useState("");
    const [endDate, setEndDate] = useState("");
    const [description, setDescription] = useState("");
    const [category, setCategory] = useState("일반");

    function resetForm() {
        setTitle("");
        setDate("");
        setEndDate("");
        setDescription("");
        setCategory("일반");
        setShowForm(false);
        setEditingId(null);
    }

    function startEdit(event: AnnualEvent) {
        setTitle(event.title);
        setDate(toDateString(event.date));
        setEndDate(toDateString(event.endDate));
        setDescription(event.description || "");
        setCategory(event.category || "일반");
        setEditingId(event.id);
        setShowForm(true);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!title.trim() || !date) return;
        setBusy(true);
        try {
            const payload = {
                title: title.trim(),
                date,
                endDate: endDate || null,
                description: description.trim() || null,
                category,
            };
            if (editingId) {
                await updateAnnualEvent(editingId, payload);
            } else {
                await createAnnualEvent(payload);
            }
            resetForm();
            await loadAnnual();
        } catch (err: unknown) {
            alert(getErrorMessage(err, "저장 실패"));
        } finally {
            setBusy(false);
        }
    }

    async function handleDelete(id: string) {
        setBusy(true);
        try {
            await deleteAnnualEvent(id);
            await loadAnnual();
        } catch (err: unknown) {
            alert(getErrorMessage(err, "삭제 실패"));
        } finally {
            setBusy(false);
        }
    }

    // ICS URL 저장 핸들러
    async function handleSaveIcsUrl() {
        setIcsSaving(true);
        setIcsMsg(null);
        try {
            await updateAcademySettings({ googleCalendarIcsUrl: icsUrl.trim() });
            setIcsMsg("저장되었습니다.");
            await loadAnnual();
            setTimeout(() => setIcsMsg(null), 3000);
        } catch (err: unknown) {
            setIcsMsg("저장 실패: " + getErrorMessage(err, "알 수 없는 오류"));
        } finally {
            setIcsSaving(false);
        }
    }

    if (loading && events.length === 0) {
        return <AnnualLoadingFallback />;
    }

    if (loadError && events.length === 0) {
        return <AnnualErrorState onRetry={loadAnnual} />;
    }

    // Group events by year
    const eventsByYear = events.reduce<Record<number, AnnualEvent[]>>((acc, ev) => {
        const year = new Date(ev.date).getFullYear();
        (acc[year] ||= []).push(ev);
        return acc;
    }, {});
    const years = Object.keys(eventsByYear).map(Number).sort((a, b) => b - a);

    return (
        <div className="max-w-4xl mx-auto">
            <AdminPageHeader
                className="mb-6"
                title="연간일정 관리"
                actions={
                    <button
                        type="button"
                        onClick={() => { resetForm(); setShowForm(true); }}
                        className="academy-button-primary"
                    >
                        일정 추가
                    </button>
                }
            />

            {/* ── 구글 캘린더 ICS URL 설정 ────────────────────────── */}
            <div className="bg-white border border-[var(--color-academy-line)] rounded-xl p-5 mb-6 shadow-sm">
                <h3 className="academy-section-title mb-2">구글 캘린더 연동 (ICS)</h3>
                <p className="text-xs text-[var(--color-academy-muted)] mb-3">
                    구글 캘린더 → 설정 → 캘린더 통합 → &quot;iCal 형식의 공개 주소&quot;를 복사해 붙여넣으세요.
                    연동하면 공개 연간일정 페이지에 구글 캘린더 일정이 함께 표시됩니다.
                </p>
                <div className="flex gap-2">
                    <input
                        type="url"
                        value={icsUrl}
                        onChange={(e) => setIcsUrl(e.target.value)}
                        placeholder="https://calendar.google.com/calendar/ical/...@group.calendar.google.com/public/basic.ics"
                        className="academy-input min-w-0 flex-1 font-mono"
                    />
                    <button
                        type="button"
                        onClick={handleSaveIcsUrl}
                        disabled={icsSaving}
                        className="academy-button-secondary shrink-0"
                    >
                        {icsSaving ? "저장 중..." : "저장"}
                    </button>
                </div>
                {icsMsg && (
                    <p className={`text-xs mt-2 ${icsMsg.startsWith("저장 실패") ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-success)]"}`}>
                        {icsMsg}
                    </p>
                )}
            </div>

            {/* Form */}
            {showForm && (
                <form onSubmit={handleSubmit} className="bg-white border border-[var(--color-academy-line)] rounded-xl p-6 mb-6 shadow-sm space-y-4">
                    <h3 className="academy-section-title">{editingId ? "일정 수정" : "새 일정 추가"}</h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="sm:col-span-2">
                            <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">제목 *</label>
                            <input
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                required
                                placeholder="예: 3월 개강"
                                className="academy-input"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">시작일 *</label>
                            <input
                                type="date"
                                min="2020-01-01" max="2030-12-31"
                                value={date}
                                onChange={(e) => setDate(e.target.value)}
                                required
                                className="academy-input"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">종료일 (선택)</label>
                            <input
                                type="date"
                                min="2020-01-01" max="2030-12-31"
                                value={endDate}
                                onChange={(e) => setEndDate(e.target.value)}
                                className="academy-input"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">카테고리</label>
                            <select
                                value={category}
                                onChange={(e) => setCategory(e.target.value)}
                                className="academy-input"
                            >
                                {CATEGORIES.map((c) => (
                                    <option key={c} value={c}>{c}</option>
                                ))}
                            </select>
                        </div>
                        <div className="sm:col-span-2">
                            <label className="block text-sm font-medium text-[var(--color-academy-muted)] mb-1">설명 (선택)</label>
                            <textarea
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                rows={2}
                                placeholder="일정에 대한 추가 설명"
                                className="academy-input"
                            />
                        </div>
                    </div>

                    <div className="flex gap-2 justify-end">
                        <button type="button" onClick={resetForm} className="academy-button-secondary">
                            취소
                        </button>
                        <button
                            type="submit"
                            disabled={busy}
                            className="academy-button-primary"
                        >
                            {busy ? "저장 중..." : editingId ? "수정" : "추가"}
                        </button>
                    </div>
                </form>
            )}

            {/* Event list */}
            {events.length === 0 ? (
                <div className="bg-white rounded-xl border border-[var(--color-academy-line)] p-12 text-center text-[var(--color-academy-faint)]">
                    등록된 일정이 없습니다. &quot;일정 추가&quot; 버튼으로 새 일정을 등록하세요.
                </div>
            ) : (
                <div className="space-y-6">
                    {years.map((year) => (
                        <div key={year}>
                            <h2 className="academy-section-title mb-3 tabular-nums">{year}년</h2>
                            <div className="bg-white rounded-xl border border-[var(--color-academy-line)] divide-y divide-[var(--color-academy-line)]">
                                {eventsByYear[year].map((ev) => (
                                    <div key={ev.id} className="flex items-center justify-between p-4 hover:bg-[var(--color-academy-soft)] transition-colors">
                                        <div className="flex items-center gap-4 min-w-0">
                                            <div className="text-sm tabular-nums text-right text-[var(--color-academy-muted)] shrink-0 w-24">
                                                {toDateString(ev.date).slice(5)}
                                                {ev.endDate && ` ~ ${toDateString(ev.endDate).slice(5)}`}
                                            </div>
                                            <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${CATEGORY_COLORS[ev.category || "일반"] || CATEGORY_COLORS["일반"]}`}>
                                                {ev.category || "일반"}
                                            </span>
                                            <div className="min-w-0">
                                                <p className="font-medium text-[var(--color-academy-ink)] truncate">{ev.title}</p>
                                                {ev.description && (
                                                    <p className="text-xs text-[var(--color-academy-muted)] truncate">{ev.description}</p>
                                                )}
                                            </div>
                                        </div>
                                        <div className="shrink-0 ml-4">
                                            <AdminQuickActionMenu
                                                label={`${ev.title} 빠른 작업`}
                                                actions={[
                                                    {
                                                        key: "edit",
                                                        label: "수정",
                                                        icon: "edit",
                                                        onSelect: () => startEdit(ev),
                                                    },
                                                    {
                                                        key: "delete",
                                                        label: "삭제",
                                                        icon: "delete",
                                                        tone: "danger",
                                                        disabled: busy,
                                                        onSelect: async () => {
                                                            if (await askConfirm({ title: `"${ev.title}" 일정 삭제`, description: "이 일정이 바로 삭제됩니다.", confirmLabel: "삭제" })) {
                                                                void handleDelete(ev.id);
                                                            }
                                                        },
                                                    },
                                                ]}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>
            )}
            {/* 삭제 확인 창(공용) */}
            {confirmDialog}
        </div>
    );
}
