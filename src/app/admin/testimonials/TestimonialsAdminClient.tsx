"use client";

/**
 * TestimonialsAdminClient — 학부모 후기 관리 UI
 *
 * FaqAdminClient.tsx 패턴을 복제하여 구현.
 * - 상단: 네이버 플레이스 URL 설정
 * - 후기 CRUD: 모달 기반 생성/수정, 삭제 확인
 * - 순서 변경: 위/아래 버튼으로 order 값 스왑
 * - 아이콘: Material Symbols Outlined (lucide-react 사용 안 함)
 */

import { useCallback, useEffect, useState, useTransition } from "react";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { toKstYmd } from "@/lib/datetime/kst";
import {
    createTestimonial,
    updateTestimonial,
    deleteTestimonial,
    updateNaverPlaceUrl,
} from "@/app/actions/admin";

// 후기 데이터 타입
type TestimonialData = {
    id: string;
    name: string;
    info: string;
    text: string;
    rating: number;
    order: number;
    isPublic: boolean;
    createdAt: Date | string;
};

type TestimonialsPayload = {
    testimonials: TestimonialData[];
    naverPlaceUrl: string;
};

// Material Symbols 아이콘 헬퍼 — 클래스명과 텍스트만 전달
function MIcon({ name, className = "" }: { name: string; className?: string }) {
    return (
        <span className={`material-symbols-outlined ${className}`} style={{ fontSize: "inherit" }}>
            {name}
        </span>
    );
}

// 공개/비공개 배지(목록 행·상세 패널 공용)
function TestimonialVisibilityBadge({ isPublic }: { isPublic: boolean }) {
    return (
        <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${
            isPublic
                ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"
        }`}>
            <span className="material-symbols-outlined text-sm" aria-hidden="true">{isPublic ? "visibility" : "visibility_off"}</span>
            {isPublic ? "공개" : "비공개"}
        </span>
    );
}

function TestimonialsLoadingFallback() {
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="h-8 w-48 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                </div>
                <div className="h-11 w-28 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
            </div>
            <div className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <div className="h-5 w-44 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                <div className="mt-3 h-4 w-96 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                <div className="mt-4 flex gap-2">
                    <div className="h-10 flex-1 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-700" />
                    <div className="h-10 w-20 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
                </div>
            </div>
            <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1 space-y-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <div className="h-5 w-20 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                                    <div className="h-5 w-20 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                    <div className="h-5 w-24 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                </div>
                                <div className="h-4 w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                <div className="flex gap-2">
                                    <div className="h-5 w-16 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                    <div className="h-5 w-16 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                </div>
                            </div>
                            <div className="hidden gap-1 sm:flex">
                                <div className="h-8 w-8 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                                <div className="h-8 w-8 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                                <div className="h-8 w-8 animate-pulse rounded-lg bg-gray-100 dark:bg-gray-700" />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function TestimonialsErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-bold text-red-700 dark:text-red-200">후기를 불러오지 못했습니다.</p>
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

export default function TestimonialsAdminClient({
    testimonials: initialTestimonials,
    naverPlaceUrl: initialNaverUrl = "",
}: {
    testimonials?: TestimonialData[];
    naverPlaceUrl?: string;
}) {
    const [isPending, startTransition] = useTransition();
    const hasInitialData = initialTestimonials !== undefined;
    const [testimonials, setTestimonials] = useState<TestimonialData[]>(initialTestimonials ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);

    // ── 네이버 플레이스 URL 설정 ──
    const [naverUrl, setNaverUrl] = useState(initialNaverUrl);
    const [naverSaved, setNaverSaved] = useState(false);

    const loadTestimonials = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const response = await fetch("/api/admin/testimonials", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load testimonials.");
            }
            const data = (await response.json()) as TestimonialsPayload;
            setTestimonials(data.testimonials);
            setNaverUrl(data.naverPlaceUrl || "");
        } catch (error) {
            console.error("Failed to load testimonials:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadTestimonials();
    }, [hasInitialData, loadTestimonials]);

    function handleSaveNaverUrl() {
        startTransition(async () => {
            await updateNaverPlaceUrl(naverUrl);
            setNaverSaved(true);
            await loadTestimonials();
            setTimeout(() => setNaverSaved(false), 2000);
        });
    }

    // ── 모달 상태 ──
    const [showForm, setShowForm] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);

    // 폼 필드 상태
    const [name, setName] = useState("");
    const [info, setInfo] = useState("");
    const [text, setText] = useState("");
    const [rating, setRating] = useState(5);
    const [order, setOrder] = useState(0);
    const [isPublic, setIsPublic] = useState(true);
    // 행 클릭 상세 패널 대상
    const [detailTestimonialId, setDetailTestimonialId] = useState<string | null>(null);

    // 폼 초기화
    function resetForm() {
        setEditId(null);
        setName("");
        setInfo("");
        setText("");
        setRating(5);
        setOrder(0);
        setIsPublic(true);
        setShowForm(false);
    }

    // 수정 모드 — 기존 데이터를 폼에 채움
    function startEdit(t: TestimonialData) {
        setEditId(t.id);
        setName(t.name);
        setInfo(t.info);
        setText(t.text);
        setRating(t.rating);
        setOrder(t.order);
        setIsPublic(t.isPublic);
        setShowForm(true);
    }

    // 저장 (생성 또는 수정)
    function handleSubmit() {
        if (!name.trim()) { alert("작성자명을 입력해주세요."); return; }
        if (!text.trim()) { alert("후기 내용을 입력해주세요."); return; }
        const payload = { name, info, text, rating, order, isPublic };
        startTransition(async () => {
            if (editId) {
                await updateTestimonial(editId, payload);
            } else {
                await createTestimonial(payload);
            }
            resetForm();
            await loadTestimonials();
        });
    }

    // 삭제
    function handleDelete(id: string) {
        if (!confirm("이 후기를 삭제하시겠습니까?")) return;
        startTransition(async () => {
            await deleteTestimonial(id);
            await loadTestimonials();
        });
    }

    // 순서 변경 — 인접 항목과 order 값 스왑
    function handleReorder(index: number, direction: "up" | "down") {
        const targetIdx = direction === "up" ? index - 1 : index + 1;
        if (targetIdx < 0 || targetIdx >= testimonials.length) return;

        const current = testimonials[index];
        const target = testimonials[targetIdx];

        startTransition(async () => {
            // 두 항목의 order 값을 교환
            await updateTestimonial(current.id, {
                name: current.name, info: current.info, text: current.text,
                rating: current.rating, order: target.order, isPublic: current.isPublic,
            });
            await updateTestimonial(target.id, {
                name: target.name, info: target.info, text: target.text,
                rating: target.rating, order: current.order, isPublic: target.isPublic,
            });
            await loadTestimonials();
        });
    }

    // id 로 찾아서, 삭제·새로고침으로 사라지면 패널도 자동으로 닫힌다
    const detailTestimonial = detailTestimonialId ? testimonials.find(t => t.id === detailTestimonialId) ?? null : null;

    // 행 키보드: 안쪽 버튼에서 누른 Enter/Space 는 가로채지 않는다
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailTestimonialId(id);
        }
    }

    if (loading && testimonials.length === 0) {
        return <TestimonialsLoadingFallback />;
    }

    if (loadError && testimonials.length === 0) {
        return <TestimonialsErrorState onRetry={loadTestimonials} />;
    }

    // 별점 렌더링
    const renderStars = (r: number) =>
        Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={i < r ? "text-yellow-400" : "text-gray-300"}>&#9733;</span>
        ));

    return (
        <div className="space-y-6">
            {/* 페이지 헤더 */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">학부모 후기 관리</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">메인 페이지에 표시</p>
                </div>
                <button
                    onClick={() => { resetForm(); setShowForm(true); }}
                    className="flex items-center gap-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-4 py-2.5 rounded-xl font-bold hover:bg-orange-600 transition"
                >
                    <span className="text-lg"><MIcon name="add" /></span> 새 후기
                </button>
            </div>

            {/* 네이버 플레이스 URL 설정 카드 */}
            <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 transition-colors duration-300 shadow-sm p-5">
                <h2 className="text-sm font-bold text-gray-700 dark:text-gray-200 mb-3 flex items-center gap-2">
                    <span className="text-lg text-green-600"><MIcon name="link" /></span>
                    네이버 플레이스 리뷰 링크
                </h2>
                <p className="text-xs text-gray-400 mb-3">
                    메인 후기 섹션 하단에 링크 버튼 표시
                </p>
                <div className="flex gap-2">
                    <input
                        value={naverUrl}
                        onChange={e => setNaverUrl(e.target.value)}
                        placeholder="https://naver.me/... 또는 https://map.naver.com/..."
                        className="flex-1 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm"
                    />
                    <button
                        onClick={handleSaveNaverUrl}
                        disabled={isPending}
                        className="px-5 py-2.5 bg-brand-navy-900 text-white font-bold rounded-xl hover:bg-brand-navy-800 transition disabled:opacity-50 text-sm"
                    >
                        {naverSaved ? "저장됨" : "저장"}
                    </button>
                </div>
            </div>

            {/* 생성/수정 모달 */}
            {showForm && (
                <AdminModal onClose={resetForm} titleId="testimonial-form-modal-title" panelClassName="max-w-2xl">
                        {/* 모달 헤더 */}
                        <div className="p-6 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                            <h2 id="testimonial-form-modal-title" className="text-lg font-bold">{editId ? "후기 수정" : "새 후기"}</h2>
                            <button onClick={resetForm} className="p-1 hover:bg-gray-100 dark:bg-gray-800 rounded-lg text-xl">
                                <MIcon name="close" />
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            {/* 작성자명 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">작성자명</label>
                                <input value={name} onChange={e => setName(e.target.value)}
                                    placeholder='예: 김O O'
                                    className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm" />
                            </div>
                            {/* 관계/정보 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">관계/정보</label>
                                <input value={info} onChange={e => setInfo(e.target.value)}
                                    placeholder='예: 초3 학부모'
                                    className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm" />
                            </div>
                            {/* 후기 내용 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">후기 내용</label>
                                <textarea value={text} onChange={e => setText(e.target.value)}
                                    rows={4} placeholder="후기 내용을 입력하세요"
                                    className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm" />
                            </div>
                            {/* 별점, 순서, 공개여부 — 가로 배치 */}
                            <div className="flex gap-4 flex-wrap">
                                <div className="w-24">
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">별점</label>
                                    <select value={rating} onChange={e => setRating(Number(e.target.value))}
                                        className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 text-sm">
                                        {[5, 4, 3, 2, 1].map(v => (
                                            <option key={v} value={v}>{v}점</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="w-28">
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">표시 순서</label>
                                    <input type="number" value={order} onChange={e => setOrder(Number(e.target.value))}
                                        className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm" />
                                    <p className="text-xs text-gray-400 mt-1">작을수록 먼저</p>
                                </div>
                                <div className="flex items-center gap-2 pt-6">
                                    <input type="checkbox" id="isPublicT" checked={isPublic}
                                        onChange={e => setIsPublic(e.target.checked)} className="rounded" />
                                    <label htmlFor="isPublicT" className="text-sm text-gray-700 dark:text-gray-200">공개</label>
                                </div>
                            </div>
                        </div>
                        {/* 모달 하단 버튼 */}
                        <div className="p-6 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
                            <button onClick={resetForm}
                                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:bg-gray-800 rounded-xl transition">
                                취소
                            </button>
                            <button onClick={handleSubmit} disabled={isPending}
                                className="px-6 py-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold rounded-xl hover:bg-orange-600 transition disabled:opacity-50">
                                {isPending ? "저장 중..." : editId ? "수정" : "등록"}
                            </button>
                        </div>
                </AdminModal>
            )}

            {/* 후기 목록 — 한 줄 행(순서 | 작성자 | 관계 | 별점 | 공개 | 작성일 | 관리). 후기 내용 전체는 행을 누르면 상세 패널.
                순서 변경(위/아래)은 전체 목록 번호(idx)로 이웃과 바꾸는 방식이라, 목록을 거르지 않고 전부 보여 준다 */}
            {testimonials.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    아직 등록된 후기가 없습니다. &quot;새 후기&quot; 버튼으로 학부모 후기를 추가하세요.
                </div>
            ) : (
                <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                    <div className="overflow-x-auto">
                        {/* admin-list-table: 글자 왼쪽·순서/별점/날짜 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
                        <table className="admin-list-table w-full border-collapse text-sm">
                            <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                                <tr>
                                    <th className="admin-cell-num px-2 py-2">순서</th>
                                    <th className="px-2 py-2">작성자</th>
                                    <th className="hidden px-2 py-2 md:table-cell">관계</th>
                                    <th className="admin-cell-num px-2 py-2">별점</th>
                                    <th className="px-2 py-2">공개</th>
                                    <th className="admin-cell-num hidden px-2 py-2 lg:table-cell">작성일</th>
                                    <th className="admin-cell-center px-2 py-2">관리</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--color-academy-line)]">
                                {testimonials.map((t, idx) => (
                                    <tr
                                        key={t.id}
                                        tabIndex={0}
                                        aria-label={`${t.name} 후기 상세 보기`}
                                        onClick={() => setDetailTestimonialId(t.id)}
                                        onKeyDown={(event) => handleRowKeyDown(event, t.id)}
                                        className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                                    >
                                        <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{t.order}</td>
                                        <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{t.name}</td>
                                        <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{t.info || "-"}</td>
                                        <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-ink)]">{t.rating}점</td>
                                        <td className="px-2 py-1.5"><TestimonialVisibilityBadge isPublic={t.isPublic} /></td>
                                        <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] lg:table-cell">{toKstYmd(t.createdAt)}</td>
                                        {/* 관리: 위·아래·수정·삭제(행 클릭=상세 패널과 겹치지 않게 전파 차단). 함수·인자·막힘 조건은 기존 그대로 */}
                                        <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                                            <div className="inline-flex gap-0.5">
                                                <button type="button" onClick={() => handleReorder(idx, "up")}
                                                    disabled={idx === 0 || isPending}
                                                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)] disabled:opacity-30"
                                                    title="위로" aria-label={`${t.name} 후기 위로`}>
                                                    <MIcon name="arrow_upward" />
                                                </button>
                                                <button type="button" onClick={() => handleReorder(idx, "down")}
                                                    disabled={idx === testimonials.length - 1 || isPending}
                                                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)] disabled:opacity-30"
                                                    title="아래로" aria-label={`${t.name} 후기 아래로`}>
                                                    <MIcon name="arrow_downward" />
                                                </button>
                                                <button type="button" onClick={() => startEdit(t)}
                                                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                                                    title="수정" aria-label={`${t.name} 후기 수정`}>
                                                    <MIcon name="edit" />
                                                </button>
                                                <button type="button" onClick={() => handleDelete(t.id)}
                                                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-lg text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-danger-soft)] hover:text-[var(--color-academy-danger)]"
                                                    title="삭제" aria-label={`${t.name} 후기 삭제`}>
                                                    <MIcon name="delete" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* 행 클릭 상세 패널 — 데스크톱 오른쪽 / 모바일 하단 시트. 이미 받아온 값만(새 조회 없음) */}
            {detailTestimonial && (
                <ListDetailPanel onClose={() => setDetailTestimonialId(null)} titleId="testimonial-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <div className="mb-4 flex items-start gap-2">
                        <h3 id="testimonial-detail-panel-title" className="min-w-0 break-keep break-words text-lg font-black text-[var(--color-academy-ink)]">{detailTestimonial.name}</h3>
                        <TestimonialVisibilityBadge isPublic={detailTestimonial.isPublic} />
                        <button
                            type="button"
                            onClick={() => setDetailTestimonialId(null)}
                            aria-label="닫기"
                            className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                        >
                            <span className="material-symbols-outlined" aria-hidden="true">close</span>
                        </button>
                    </div>
                    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                        {detailTestimonial.info && (
                            <>
                                <dt className="font-bold text-[var(--color-academy-muted)]">관계</dt>
                                <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{detailTestimonial.info}</dd>
                            </>
                        )}
                        <dt className="font-bold text-[var(--color-academy-muted)]">별점</dt>
                        <dd className="text-[var(--color-academy-ink)]">{renderStars(detailTestimonial.rating)} <span className="tabular-nums">{detailTestimonial.rating}점</span></dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">표시 순서</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{detailTestimonial.order}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">작성일</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{toKstYmd(detailTestimonial.createdAt)}</dd>
                    </dl>
                    {/* 후기 내용 — 말줄임 없이 전부, 줄바꿈 그대로 */}
                    <p className="mt-4 whitespace-pre-wrap break-keep break-words rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
                        &ldquo;{detailTestimonial.text}&rdquo;
                    </p>
                    <div className="mt-5 flex flex-wrap gap-2">
                        <button type="button" onClick={() => { const target = detailTestimonial; setDetailTestimonialId(null); startEdit(target); }}
                            className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]">
                            <span className="text-lg"><MIcon name="edit" /></span> 수정
                        </button>
                        <button type="button" onClick={() => handleDelete(detailTestimonial.id)}
                            className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-academy-danger)] px-4 text-sm font-bold text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]">
                            <span className="text-lg"><MIcon name="delete" /></span> 삭제
                        </button>
                    </div>
                </ListDetailPanel>
            )}
        </div>
    );
}
