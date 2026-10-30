"use client";

import { useState, useTransition, useCallback, useEffect } from "react";
import { createFeedback, updateFeedback, deleteFeedback } from "@/app/actions/admin";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import AdminPanelActions from "@/components/admin/AdminPanelActions";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { toKstYmd } from "@/lib/datetime/kst";

// 카테고리 정의: 피드백을 4가지 유형으로 분류(색은 화면 토큰)
const CATEGORIES: Record<string, { label: string; color: string }> = {
    SKILL: { label: "기술", color: "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]" },
    ATTITUDE: { label: "태도", color: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" },
    PHYSICAL: { label: "체력", color: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
    GENERAL: { label: "종합", color: "bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]" },
};

// 목록 날짜 — 수업일이 있으면 수업일, 없으면 작성일(예전 카드와 같은 규칙). KST 달력 날짜로
function feedbackDate(fb: { sessionDate: string | null; createdAt: string }): string {
    return toKstYmd(fb.sessionDate || fb.createdAt);
}

// 피드백 데이터 타입 (getAllFeedbacks 반환값 기준)
type Feedback = {
    id: string;
    studentId: string;
    coachId: string;
    sessionDate: string | null;
    category: string;
    title: string;
    content: string;
    rating: number | null;
    isPublic: boolean;
    createdAt: string;
    coachName: string;
    studentName: string;
};

type Student = {
    id: string;
    name: string;
};

type Coach = {
    id: string;
    name: string;
};

type Props = {
    feedbacks?: Feedback[];
};

type FeedbackPayload = {
    feedbacks: Feedback[];
};

function FeedbackLoadingFallback() {
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="h-8 w-40 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                </div>
                <div className="h-11 w-28 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
            </div>
            <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                    <div
                        key={index}
                        className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-800"
                    >
                        <div className="p-5">
                            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                <div className="min-w-0 flex-1 space-y-3">
                                    <div className="flex gap-2">
                                        <div className="h-6 w-16 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                        <div className="h-6 w-20 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                    </div>
                                    <div className="h-5 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                                    <div className="h-4 w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                    <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                </div>
                                <div className="hidden gap-2 sm:flex">
                                    <div className="h-8 w-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                                    <div className="h-8 w-16 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                                </div>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function FeedbackErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-bold text-red-700 dark:text-red-200">피드백 목록을 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-lg bg-red-600 px-4 py-2 text-sm font-bold text-white transition hover:bg-red-700"
            >
                다시 불러오기
            </button>
        </div>
    );
}

export default function FeedbackManagementClient({ feedbacks: initialFeedbacks }: Props) {
    const [isPending, startTransition] = useTransition();
    const hasInitialData = initialFeedbacks !== undefined;
    const [feedbacks, setFeedbacks] = useState<Feedback[]>(initialFeedbacks ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);
    const [students, setStudents] = useState<Student[]>([]);
    const [studentsLoaded, setStudentsLoaded] = useState(false);
    const [studentsLoading, setStudentsLoading] = useState(false);
    const [studentsError, setStudentsError] = useState<string | null>(null);
    const [coaches, setCoaches] = useState<Coach[]>([]);
    const [coachesLoaded, setCoachesLoaded] = useState(false);
    const [coachesLoading, setCoachesLoading] = useState(false);
    const [coachesError, setCoachesError] = useState<string | null>(null);

    const loadFeedbacks = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const response = await fetch("/api/admin/feedback", { cache: "no-store" });
            if (!response.ok) throw new Error("Failed to load feedbacks.");
            const data = (await response.json()) as FeedbackPayload;
            setFeedbacks(data.feedbacks);
        } catch (error) {
            console.error("Failed to load feedbacks:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadFeedbacks();
    }, [hasInitialData, loadFeedbacks]);

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

    const loadCoaches = useCallback(async () => {
        if (coachesLoaded || coachesLoading) return;

        setCoachesLoading(true);
        setCoachesError(null);

        try {
            const response = await fetch("/api/admin/coach-options");

            if (!response.ok) {
                throw new Error("Failed to load coach options.");
            }

            const data = (await response.json()) as { coaches?: Coach[] };
            setCoaches(data.coaches ?? []);
            setCoachesLoaded(true);
        } catch (error) {
            console.error("Failed to load coach options:", error);
            setCoachesError("코치 목록을 불러오지 못했습니다.");
        } finally {
            setCoachesLoading(false);
        }
    }, [coachesLoaded, coachesLoading]);

    // 작성 폼 표시 여부
    const [showForm, setShowForm] = useState(false);
    // 수정 모드일 때 해당 피드백 ID
    const [editingId, setEditingId] = useState<string | null>(null);
    // 행 클릭 상세 패널 대상(피드백 id) — 예전 카드 펼침을 대신한다
    const [detailId, setDetailId] = useState<string | null>(null);

    // 폼 입력값 상태
    const [form, setForm] = useState({
        studentId: "",
        coachId: "",
        sessionDate: "",
        category: "GENERAL",
        title: "",
        content: "",
        rating: 0,
        isPublic: true,
    });

    // 폼 초기화
    function resetForm() {
        setForm({
            studentId: "",
            coachId: "",
            sessionDate: "",
            category: "GENERAL",
            title: "",
            content: "",
            rating: 0,
            isPublic: true,
        });
        setEditingId(null);
    }

    // 피드백 저장 (생성 또는 수정)
    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!form.studentId || !form.coachId || !form.title || !form.content) {
            alert("학생, 코치, 제목, 내용은 필수 항목입니다.");
            return;
        }

        startTransition(async () => {
            try {
                if (editingId) {
                    // 수정 모드: 카테고리/제목/내용/평점/공개여부만 수정 가능
                    await updateFeedback(editingId, {
                        category: form.category,
                        title: form.title,
                        content: form.content,
                        rating: form.rating > 0 ? form.rating : null,
                        isPublic: form.isPublic,
                    });
                } else {
                    // 생성 모드: 모든 필드 전달
                    await createFeedback({
                        studentId: form.studentId,
                        coachId: form.coachId,
                        sessionDate: form.sessionDate || null,
                        category: form.category,
                        title: form.title,
                        content: form.content,
                        rating: form.rating > 0 ? form.rating : null,
                        isPublic: form.isPublic,
                    });
                }
                resetForm();
                setShowForm(false);
                await loadFeedbacks();
            } catch (err: any) {
                alert(err.message || "저장 실패");
            }
        });
    }

    // 수정 버튼 클릭 시: 폼에 기존 데이터 채우기
    function handleEdit(fb: Feedback) {
        setForm({
            studentId: fb.studentId,
            coachId: fb.coachId,
            sessionDate: fb.sessionDate ? fb.sessionDate.slice(0, 10) : "",
            category: fb.category,
            title: fb.title,
            content: fb.content,
            rating: fb.rating ?? 0,
            isPublic: fb.isPublic,
        });
        setEditingId(fb.id);
        setShowForm(true);
        void loadStudents();
        void loadCoaches();
        // 페이지 상단으로 스크롤
        window.scrollTo({ top: 0, behavior: "smooth" });
    }

    // 삭제 처리
    function handleDelete(id: string) {
        if (!confirm("이 피드백을 삭제하시겠습니까?")) return;
        startTransition(async () => {
            try {
                await deleteFeedback(id);
                await loadFeedbacks();
            } catch (err: any) {
                alert(err.message || "삭제 실패");
            }
        });
    }

    // ⚡·상세 패널이 같이 쓰는 작업 — 예전 펼친 카드의 수정·삭제 버튼과 같은 함수(삭제 확인창 그대로)
    function buildFeedbackActions(fb: Feedback): AdminQuickAction[] {
        return [
            { key: "edit", label: "수정", icon: "edit", disabled: isPending, onSelect: () => handleEdit(fb) },
            { key: "delete", label: "삭제", icon: "delete", tone: "danger", disabled: isPending, onSelect: () => handleDelete(fb.id) },
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

    const detail = detailId ? feedbacks.find((fb) => fb.id === detailId) ?? null : null;

    // 별점 렌더링 (1~5)
    function renderStars(rating: number | null) {
        if (!rating) return <span className="text-sm text-[var(--color-academy-muted)]">평점 없음</span>;
        return (
            <span className="tabular-nums text-[var(--color-academy-warning)]">
                {Array.from({ length: 5 }, (_, i) => (
                    <span key={i}>{i < rating ? "\u2605" : "\u2606"}</span>
                ))}
            </span>
        );
    }

    // 별점 입력 (폼 내부에서 클릭으로 점수 선택)
    function renderStarInput() {
        return (
            <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((star) => (
                    <button
                        key={star}
                        type="button"
                        onClick={() => setForm({ ...form, rating: form.rating === star ? 0 : star })}
                        className={`text-2xl transition-colors ${
                            star <= form.rating ? "text-yellow-400" : "text-gray-300"
                        } hover:text-yellow-400`}
                    >
                        {star <= form.rating ? "\u2605" : "\u2606"}
                    </button>
                ))}
                {form.rating > 0 && (
                    <span className="text-sm text-gray-500 dark:text-gray-400 ml-2 self-center">{form.rating}점</span>
                )}
            </div>
        );
    }

    if (loading && feedbacks.length === 0) {
        return <FeedbackLoadingFallback />;
    }

    if (loadError && feedbacks.length === 0) {
        return <FeedbackErrorState onRetry={loadFeedbacks} />;
    }

    return (
        <div className="space-y-3">
            {/* 헤더: 제목 + 피드백 작성 버튼 */}
            <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-baseline gap-x-2">
                    <h1 className="text-lg font-black text-[var(--color-academy-ink)]">학습 피드백 관리</h1>
                    {/* 설명문구는 제거하고 실무에 쓰이는 건수 표시만 유지 */}
                    <p className="text-xs text-[var(--color-academy-muted)]">
                        총 <span className="tabular-nums">{feedbacks.length}</span>건
                    </p>
                </div>
                <button
                    onClick={() => {
                        if (showForm && !editingId) {
                            // 폼이 열려있고 새 작성 중이면 닫기
                            setShowForm(false);
                            resetForm();
                        } else {
                            // 폼 열기 (수정 중이었으면 초기화)
                            resetForm();
                            setShowForm(true);
                            void loadStudents();
                            void loadCoaches();
                        }
                    }}
                    className="px-5 py-2.5 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white rounded-xl font-medium hover:bg-brand-orange-600 dark:hover:bg-lime-400 transition-colors"
                >
                    {showForm && !editingId ? "닫기" : "피드백 작성"}
                </button>
            </div>

            {/* 피드백 작성/수정 폼 (토글) */}
            {showForm && (
                <form
                    onSubmit={handleSubmit}
                    className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800 p-6 space-y-4"
                >
                    <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">
                        {editingId ? "피드백 수정" : "새 피드백 작성"}
                    </h2>

                    {/* 학생 + 코치 선택 (2열) */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* 학생 드롭다운 - 수정 시에는 변경 불가 */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                                학생 <span className="text-red-500">*</span>
                            </label>
                            <select
                                value={form.studentId}
                                onChange={(e) => setForm({ ...form, studentId: e.target.value })}
                                disabled={!!editingId || studentsLoading || Boolean(studentsError)}
                                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime disabled:bg-gray-100 dark:bg-gray-800"
                            >
                                <option value="">
                                    {studentsLoading ? "학생 목록 로딩 중..." : "학생을 선택하세요"}
                                </option>
                                {students.map((s) => (
                                    <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                            </select>
                            {studentsError && (
                                <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-200">
                                    <span>{studentsError}</span>
                                    <button
                                        type="button"
                                        onClick={() => void loadStudents()}
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

                        {/* 코치 드롭다운 - 수정 시에는 변경 불가 */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                                코치 <span className="text-red-500">*</span>
                            </label>
                            <select
                                value={form.coachId}
                                onChange={(e) => setForm({ ...form, coachId: e.target.value })}
                                disabled={!!editingId || coachesLoading || Boolean(coachesError)}
                                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime disabled:bg-gray-100 dark:bg-gray-800"
                            >
                                <option value="">
                                    {coachesLoading ? "코치 목록 로딩 중..." : "코치를 선택하세요"}
                                </option>
                                {coaches.map((c) => (
                                    <option key={c.id} value={c.id}>{c.name}</option>
                                ))}
                            </select>
                            {coachesError && (
                                <div className="mt-2 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-200">
                                    <span>{coachesError}</span>
                                    <button
                                        type="button"
                                        onClick={() => void loadCoaches()}
                                        className="shrink-0 rounded-md border border-red-200 px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:text-red-200 dark:hover:bg-red-900/40"
                                    >
                                        다시 시도
                                    </button>
                                </div>
                            )}
                            {!coachesLoading && !coachesError && coaches.length === 0 && (
                                <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                                    등록된 코치가 없습니다.
                                </p>
                            )}
                        </div>
                    </div>

                    {/* 날짜 + 카테고리 (2열) */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">수업 날짜</label>
                            <input
                                type="date"
                                min="2020-01-01" max="2030-12-31"
                                value={form.sessionDate}
                                onChange={(e) => setForm({ ...form, sessionDate: e.target.value })}
                                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">카테고리</label>
                            <select
                                value={form.category}
                                onChange={(e) => setForm({ ...form, category: e.target.value })}
                                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            >
                                {Object.entries(CATEGORIES).map(([key, { label }]) => (
                                    <option key={key} value={key}>{label}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* 제목 */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                            제목 <span className="text-red-500">*</span>
                        </label>
                        <input
                            type="text"
                            value={form.title}
                            onChange={(e) => setForm({ ...form, title: e.target.value })}
                            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                        />
                    </div>

                    {/* 내용 */}
                    <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">
                            내용 <span className="text-red-500">*</span>
                        </label>
                        <textarea
                            value={form.content}
                            onChange={(e) => setForm({ ...form, content: e.target.value })}
                            rows={4}
                            className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime resize-none"
                        />
                    </div>

                    {/* 평점 + 공개여부 */}
                    <div className="flex items-center justify-between flex-wrap gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">평점</label>
                            {renderStarInput()}
                        </div>
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={form.isPublic}
                                onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
                                className="w-4 h-4 rounded border-gray-300 text-brand-orange-500 dark:text-brand-neon-lime focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                            <span className="text-sm text-gray-700 dark:text-gray-200">학부모에게 공개</span>
                        </label>
                    </div>

                    {/* 저장/취소 버튼 */}
                    <div className="flex gap-3 pt-2">
                        <button
                            type="submit"
                            disabled={isPending}
                            className="px-6 py-2.5 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white rounded-xl font-medium hover:bg-brand-orange-600 dark:hover:bg-lime-400 transition-colors disabled:opacity-50"
                        >
                            {isPending ? "저장 중..." : editingId ? "수정 완료" : "피드백 저장"}
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setShowForm(false);
                                resetForm();
                            }}
                            className="px-6 py-2.5 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 rounded-xl font-medium hover:bg-gray-200 transition-colors"
                        >
                            취소
                        </button>
                    </div>
                </form>
            )}

            {/* 피드백 목록 — 펼침 카드 → 한 줄 표. 내용 전문·수정/삭제는 상세 패널과 ⚡ */}
            {feedbacks.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    아직 작성된 피드백이 없습니다.
                </div>
            ) : (
                <div className="overflow-x-auto rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
                    <table className="admin-list-table w-full border-collapse text-sm">
                        <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                            <tr>
                                <th className="admin-cell-num px-2 py-2">날짜</th>
                                <th className="px-2 py-2">분류</th>
                                <th className="px-2 py-2">학생</th>
                                <th className="px-2 py-2">제목</th>
                                <th className="hidden px-2 py-2 md:table-cell">코치</th>
                                <th className="hidden px-2 py-2 lg:table-cell">평점</th>
                                <th className="hidden px-2 py-2 sm:table-cell">공개</th>
                                <th className="admin-cell-center px-2 py-2">관리</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--color-academy-line)]">
                            {feedbacks.map((fb) => {
                                const cat = CATEGORIES[fb.category] || CATEGORIES.GENERAL;
                                return (
                                    <tr
                                        key={fb.id}
                                        tabIndex={0}
                                        aria-label={`${fb.studentName} ${fb.title} 피드백 상세 보기`}
                                        onClick={() => setDetailId(fb.id)}
                                        onKeyDown={(event) => handleRowKeyDown(event, fb.id)}
                                        className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                                    >
                                        {/* 수업일이 없으면 작성일(예전 카드와 같은 규칙) */}
                                        <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{feedbackDate(fb)}</td>
                                        <td className="px-2 py-1.5"><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${cat.color}`}>{cat.label}</span></td>
                                        <td className="px-2 py-1.5 font-black text-[var(--color-academy-ink)]">{fb.studentName}</td>
                                        <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{fb.title}</td>
                                        <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{fb.coachName} 코치</td>
                                        <td className="hidden px-2 py-1.5 lg:table-cell">{renderStars(fb.rating)}</td>
                                        <td className="hidden px-2 py-1.5 sm:table-cell">
                                            {fb.isPublic ? (
                                                <span className="text-xs text-[var(--color-academy-muted)]">공개</span>
                                            ) : (
                                                <span className="rounded-full border border-[var(--color-academy-danger)] px-2 py-0.5 text-xs text-[var(--color-academy-danger)]">비공개</span>
                                            )}
                                        </td>
                                        {/* 관리: ⚡(수정·삭제). 눌러도 행 클릭(패널)이 같이 일어나지 않게 전파 차단 */}
                                        <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                                            <AdminQuickActionMenu label={`${fb.studentName} 피드백 빠른 작업`} actions={buildFeedbackActions(fb)} />
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {/* 행 클릭 상세 패널 — 예전 카드를 펼치면 보이던 내용 전문 + 수정/삭제 */}
            {detail && (() => {
                const fb = detail;
                const cat = CATEGORIES[fb.category] || CATEGORIES.GENERAL;
                return (
                    <ListDetailPanel onClose={() => setDetailId(null)} titleId="feedback-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                        <div className="mb-4 flex items-center gap-2">
                            <h3 id="feedback-detail-panel-title" className="min-w-0 break-keep text-lg font-black text-[var(--color-academy-ink)]">{fb.studentName}</h3>
                            <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${cat.color}`}>{cat.label}</span>
                            {!fb.isPublic && <span className="rounded-full border border-[var(--color-academy-danger)] px-2 py-0.5 text-xs text-[var(--color-academy-danger)]">비공개</span>}
                            <button type="button" onClick={() => setDetailId(null)} aria-label="닫기" className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                                <span className="material-symbols-outlined" aria-hidden="true">close</span>
                            </button>
                        </div>
                        <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                            <dt className="font-bold text-[var(--color-academy-muted)]">제목</dt>
                            <dd className="break-keep font-bold text-[var(--color-academy-ink)]">{fb.title}</dd>
                            <dt className="font-bold text-[var(--color-academy-muted)]">코치</dt>
                            <dd className="text-[var(--color-academy-ink)]">{fb.coachName} 코치</dd>
                            <dt className="font-bold text-[var(--color-academy-muted)]">수업일</dt>
                            <dd className="tabular-nums text-[var(--color-academy-ink)]">{fb.sessionDate ? toKstYmd(fb.sessionDate) : "-"}</dd>
                            <dt className="font-bold text-[var(--color-academy-muted)]">작성일</dt>
                            <dd className="tabular-nums text-[var(--color-academy-ink)]">{toKstYmd(fb.createdAt)}</dd>
                            <dt className="font-bold text-[var(--color-academy-muted)]">평점</dt>
                            <dd>{renderStars(fb.rating)}</dd>
                        </dl>
                        {/* 피드백 내용 (줄바꿈 유지) */}
                        <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-academy-ink)]">{fb.content}</p>
                        {/* 공용 패널 버튼 줄 — ⚡ 와 같은 목록·같은 함수, 위험 작업은 오른쪽 끝으로 떨어진다 */}
                        <AdminPanelActions actions={buildFeedbackActions(fb)} onBeforeSelect={() => setDetailId(null)} />
                    </ListDetailPanel>
                );
            })()}
        </div>
    );
}
