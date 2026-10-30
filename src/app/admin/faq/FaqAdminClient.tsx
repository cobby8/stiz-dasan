"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { createFaq, updateFaq, deleteFaq } from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import { toKstYmd } from "@/lib/datetime/kst";

// FAQ 데이터 타입
type FaqData = {
    id: string;
    question: string;
    answer: string;
    order: number;
    isPublic: boolean;
    createdAt: Date | string;
};

type FaqPayload = {
    faqs: FaqData[];
};

function SymbolIcon({
    name,
    size = 18,
    className = "",
}: {
    name: string;
    size?: number;
    className?: string;
}) {
    return (
        <span
            className={`material-symbols-outlined leading-none ${className}`}
            style={{ fontSize: `${size}px` }}
            aria-hidden="true"
        >
            {name}
        </span>
    );
}

// 공개 상태 칩의 «전체» 값
const FAQ_VISIBILITY_ALL = "ALL";

// 공개/비공개 배지(목록 행·상세 패널 공용)
function FaqVisibilityBadge({ isPublic }: { isPublic: boolean }) {
    return (
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${
            isPublic
                ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"
        }`}>
            <span className="material-symbols-outlined text-sm" aria-hidden="true">{isPublic ? "visibility" : "visibility_off"}</span>
            {isPublic ? "공개" : "비공개"}
        </span>
    );
}

function FaqLoadingFallback() {
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="h-8 w-32 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="mt-2 h-4 w-80 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                </div>
                <div className="h-11 w-28 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
            </div>
            <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0 flex-1 space-y-3">
                                <div className="flex items-center gap-2">
                                    <div className="h-5 w-5 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                    <div className="h-5 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                                </div>
                                <div className="ml-7 h-4 w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                <div className="ml-7 h-4 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                <div className="ml-7 flex gap-2">
                                    <div className="h-5 w-16 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                    <div className="h-5 w-16 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                </div>
                            </div>
                            <div className="hidden gap-1 sm:flex">
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

function FaqErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-bold text-red-700 dark:text-red-200">FAQ를 불러오지 못했습니다.</p>
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

export default function FaqAdminClient({ faqs: initialFaqs }: { faqs?: FaqData[] }) {
    const [isPending, startTransition] = useTransition();
    const hasInitialData = initialFaqs !== undefined;
    const [faqs, setFaqs] = useState<FaqData[]>(initialFaqs ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);
    // 모달 표시 여부
    const [showForm, setShowForm] = useState(false);
    // 수정 중인 FAQ의 ID (null이면 새 FAQ 생성 모드)
    const [editId, setEditId] = useState<string | null>(null);
    // 폼 필드 상태
    const [question, setQuestion] = useState("");
    const [answer, setAnswer] = useState("");
    const [order, setOrder] = useState(0);
    const [isPublic, setIsPublic] = useState(true);
    // 공개 상태 칩 선택값(ALL·PUBLIC·PRIVATE), 행 클릭 상세 패널 대상
    const [visibilityFilter, setVisibilityFilter] = useState<string>(FAQ_VISIBILITY_ALL);
    const [detailFaqId, setDetailFaqId] = useState<string | null>(null);

    const loadFaqs = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const response = await fetch("/api/admin/faq", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load FAQs.");
            }
            const data = (await response.json()) as FaqPayload;
            setFaqs(data.faqs);
        } catch (error) {
            console.error("Failed to load FAQs:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadFaqs();
    }, [hasInitialData, loadFaqs]);

    // 폼 초기화
    function resetForm() {
        setEditId(null);
        setQuestion("");
        setAnswer("");
        setOrder(0);
        setIsPublic(true);
        setShowForm(false);
    }

    // 수정 모드 진입 — 기존 FAQ 데이터를 폼에 채움
    function startEdit(faq: FaqData) {
        setEditId(faq.id);
        setQuestion(faq.question);
        setAnswer(faq.answer);
        setOrder(faq.order);
        setIsPublic(faq.isPublic);
        setShowForm(true);
    }

    // 저장 (생성 또는 수정)
    function handleSubmit() {
        if (!question.trim()) { alert("질문을 입력해주세요."); return; }
        if (!answer.trim()) { alert("답변을 입력해주세요."); return; }
        const payload = { question, answer, order, isPublic };
        startTransition(async () => {
            if (editId) {
                await updateFaq(editId, payload);
            } else {
                await createFaq(payload);
            }
            resetForm();
            await loadFaqs();
        });
    }

    // 삭제 확인 후 실행
    function handleDelete(id: string) {
        if (!confirm("이 FAQ를 삭제하시겠습니까?")) return;
        startTransition(async () => {
            await deleteFaq(id);
            await loadFaqs();
        });
    }

    // 공개 상태 칩으로 거른 목록(이미 받아온 faqs 만 — 새 조회 없음)
    const visibleFaqs = faqs.filter(faq =>
        visibilityFilter === FAQ_VISIBILITY_ALL
        || (visibilityFilter === "PUBLIC" ? faq.isPublic : !faq.isPublic));
    const visibilityChipItems = [
        { value: "PUBLIC", label: "공개", count: faqs.filter(faq => faq.isPublic).length },
        { value: "PRIVATE", label: "비공개", count: faqs.filter(faq => !faq.isPublic).length },
    ];
    // id 로 찾아서, 삭제·새로고침으로 사라지면 패널도 자동으로 닫힌다
    const detailFaq = detailFaqId ? faqs.find(faq => faq.id === detailFaqId) ?? null : null;

    // 행 키보드: 안쪽 버튼에서 누른 Enter/Space 는 가로채지 않는다
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailFaqId(id);
        }
    }

    if (loading && faqs.length === 0) {
        return <FaqLoadingFallback />;
    }

    if (loadError && faqs.length === 0) {
        return <FaqErrorState onRetry={loadFaqs} />;
    }

    return (
        <div className="space-y-6">
            {/* 페이지 헤더 */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">FAQ 관리</h1>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">체험신청 페이지에 표시</p>
                </div>
                <button onClick={() => { resetForm(); setShowForm(true); }}
                    className="flex items-center gap-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-4 py-2.5 rounded-xl font-bold hover:bg-orange-600 transition">
                    <SymbolIcon name="add" size={18} /> 새 FAQ
                </button>
            </div>

            {/* 생성/수정 모달 */}
            {showForm && (
                <AdminModal onClose={resetForm} titleId="faq-form-modal-title" panelClassName="max-w-2xl">
                        <div className="p-6 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                            <h2 id="faq-form-modal-title" className="text-lg font-bold">{editId ? "FAQ 수정" : "새 FAQ"}</h2>
                            <button onClick={resetForm} className="p-1 hover:bg-gray-100 dark:bg-gray-800 rounded-lg">
                                <SymbolIcon name="close" size={20} />
                            </button>
                        </div>
                        <div className="p-6 space-y-4">
                            {/* 질문 입력 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">질문</label>
                                <input value={question} onChange={e => setQuestion(e.target.value)}
                                    placeholder="자주 묻는 질문을 입력하세요"
                                    className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm" />
                            </div>
                            {/* 답변 입력 */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">답변</label>
                                <textarea value={answer} onChange={e => setAnswer(e.target.value)}
                                    rows={4} placeholder="답변을 입력하세요"
                                    className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm" />
                            </div>
                            {/* 순서와 공개여부 — 가로 배치 */}
                            <div className="flex gap-4">
                                <div className="flex-1">
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">표시 순서</label>
                                    <input type="number" value={order} onChange={e => setOrder(Number(e.target.value))}
                                        className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm" />
                                    <p className="text-xs text-gray-400 mt-1">숫자가 작을수록 위에 표시됩니다</p>
                                </div>
                                <div className="flex items-center gap-2 pt-6">
                                    <input type="checkbox" id="isPublic" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} className="rounded" />
                                    <label htmlFor="isPublic" className="text-sm text-gray-700 dark:text-gray-200">공개</label>
                                </div>
                            </div>
                        </div>
                        {/* 모달 하단 버튼 */}
                        <div className="p-6 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
                            <button onClick={resetForm} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:bg-gray-800 rounded-xl transition">취소</button>
                            <button onClick={handleSubmit} disabled={isPending}
                                className="px-6 py-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold rounded-xl hover:bg-orange-600 transition disabled:opacity-50">
                                {isPending ? "저장 중..." : editId ? "수정" : "등록"}
                            </button>
                        </div>
                </AdminModal>
            )}

            {/* FAQ 목록 — 한 줄 행(순서 | 질문 | 공개 | 작성일 | 관리). 답변 전체는 행을 누르면 상세 패널 */}
            {faqs.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    아직 FAQ가 없습니다. &quot;새 FAQ&quot; 버튼으로 질문을 추가하세요.
                </div>
            ) : (
                <div className="space-y-2">
                    {/* 공개 상태 칩(누르면 그 상태만, 다시 누르면 전체). 바꾸면 열린 패널은 닫는다 */}
                    <StatusCountChips
                        ariaLabel="FAQ 공개 상태별 건수"
                        items={visibilityChipItems}
                        selected={visibilityFilter}
                        onSelect={(value) => { setVisibilityFilter(value); setDetailFaqId(null); }}
                        allValue={FAQ_VISIBILITY_ALL}
                    />
                    {visibleFaqs.length === 0 ? (
                        <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                            조건에 맞는 FAQ가 없습니다.
                        </div>
                    ) : (
                        <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                            <div className="overflow-x-auto">
                                {/* admin-list-table: 글자 왼쪽·순서/날짜 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
                                <table className="admin-list-table w-full border-collapse text-sm">
                                    <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                                        <tr>
                                            <th className="admin-cell-num px-2 py-2">순서</th>
                                            <th className="px-2 py-2">질문</th>
                                            <th className="px-2 py-2">공개</th>
                                            <th className="admin-cell-num hidden px-2 py-2 md:table-cell">작성일</th>
                                            <th className="admin-cell-center px-2 py-2">관리</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-[var(--color-academy-line)]">
                                        {visibleFaqs.map(faq => (
                                            <tr
                                                key={faq.id}
                                                tabIndex={0}
                                                aria-label={`${faq.question} 상세 보기`}
                                                onClick={() => setDetailFaqId(faq.id)}
                                                onKeyDown={(event) => handleRowKeyDown(event, faq.id)}
                                                className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                                            >
                                                <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{faq.order}</td>
                                                <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{faq.question}</td>
                                                <td className="px-2 py-1.5"><FaqVisibilityBadge isPublic={faq.isPublic} /></td>
                                                <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{toKstYmd(faq.createdAt)}</td>
                                                {/* 관리: 수정·삭제(행 클릭=상세 패널과 겹치지 않게 전파 차단). 함수·확인창은 기존 그대로 */}
                                                <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                                                    <div className="inline-flex gap-0.5">
                                                        <button type="button" onClick={() => startEdit(faq)}
                                                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                                                            title="수정" aria-label={`${faq.question} 수정`}>
                                                            <SymbolIcon name="edit" size={18} />
                                                        </button>
                                                        <button type="button" onClick={() => handleDelete(faq.id)}
                                                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-danger-soft)] hover:text-[var(--color-academy-danger)]"
                                                            title="삭제" aria-label={`${faq.question} 삭제`}>
                                                            <SymbolIcon name="delete" size={18} />
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
                </div>
            )}

            {/* 행 클릭 상세 패널 — 데스크톱 오른쪽 / 모바일 하단 시트. 이미 받아온 값만(새 조회 없음) */}
            {detailFaq && (
                <ListDetailPanel onClose={() => setDetailFaqId(null)} titleId="faq-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                    <div className="mb-4 flex items-start gap-2">
                        <h3 id="faq-detail-panel-title" className="min-w-0 break-keep break-words text-lg font-black text-[var(--color-academy-ink)]">
                            <span className="text-[var(--color-academy-primary)]">Q.</span> {detailFaq.question}
                        </h3>
                        <button
                            type="button"
                            onClick={() => setDetailFaqId(null)}
                            aria-label="닫기"
                            className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                        >
                            <span className="material-symbols-outlined" aria-hidden="true">close</span>
                        </button>
                    </div>
                    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                        <dt className="font-bold text-[var(--color-academy-muted)]">공개</dt>
                        <dd><FaqVisibilityBadge isPublic={detailFaq.isPublic} /></dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">표시 순서</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{detailFaq.order}</dd>
                        <dt className="font-bold text-[var(--color-academy-muted)]">작성일</dt>
                        <dd className="tabular-nums text-[var(--color-academy-ink)]">{toKstYmd(detailFaq.createdAt)}</dd>
                    </dl>
                    {/* 답변 — 말줄임 없이 전부, 줄바꿈 그대로 */}
                    <p className="mt-4 whitespace-pre-wrap break-keep break-words rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
                        {detailFaq.answer}
                    </p>
                    <div className="mt-5 flex flex-wrap gap-2">
                        <button type="button" onClick={() => { const target = detailFaq; setDetailFaqId(null); startEdit(target); }}
                            className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]">
                            <SymbolIcon name="edit" size={18} /> 수정
                        </button>
                        <button type="button" onClick={() => handleDelete(detailFaq.id)}
                            className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-academy-danger)] px-4 text-sm font-bold text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]">
                            <SymbolIcon name="delete" size={18} /> 삭제
                        </button>
                    </div>
                </ListDetailPanel>
            )}
        </div>
    );
}
