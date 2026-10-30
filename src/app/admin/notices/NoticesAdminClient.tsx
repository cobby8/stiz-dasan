"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import dynamic from "next/dynamic";
import { createNotice, updateNotice, deleteNotice } from "@/app/actions/admin";
import { isImageAttachment, isHtmlContent, plainToEditorHtml, stripHtmlForPreview } from "@/lib/noticeContent";
import { compressImageForUpload } from "@/lib/clientImageCompression";
import AdminModal from "@/components/admin/AdminModal";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import { toKstYmd } from "@/lib/datetime/kst";

const RichTextEditor = dynamic(() => import("@/components/RichTextEditor"), {
    ssr: false,
    loading: () => (
        <div className="border border-gray-300 dark:border-gray-700 rounded-xl p-4 min-h-[180px] bg-gray-50 dark:bg-gray-900 flex items-center justify-center text-sm text-gray-400">
            에디터 로딩중...
        </div>
    ),
});

const NoticeSocialModal = dynamic(() => import("./NoticeSocialModal"), {
    loading: () => null,
});

// 리치 에디터가 비어있으면 getHTML()이 "<p></p>"를 반환하므로, 태그를 걷어내 실제 내용 유무를 판단한다.
// 이미지/표/영상만 있는 공지(텍스트 0)도 유효하므로, 그런 미디어 태그가 있으면 "내용 있음"으로 본다.
function isEmptyContent(html: string): boolean {
    if (/<(?:img|iframe|table)\b/i.test(html)) return false;
    const text = html
        .replace(/<[^>]*>/g, "")
        .replace(/&nbsp;/gi, " ")
        .trim();
    return text.length === 0;
}

type Attachment = { url: string; filename: string; size: number };
export type NoticeData = {
    id: string;
    title: string;
    content: string;
    targetType: string;
    targetClassIds: string | null;
    attachmentsJSON: string | null;
    isPinned: boolean;
    createdAt: Date | string;
};
type ClassInfo = { id: string; name: string; program?: { name: string } | null };
type NoticePagination = {
    limit: number;
    offset: number;
    returned: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
    partial?: boolean;
};

type NoticesPayload = {
    notices: NoticeData[];
    classes?: ClassInfo[];
    pagination?: NoticePagination;
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

function NoticesLoadingFallback() {
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between gap-4">
                <div>
                    <div className="h-8 w-40 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                    <div className="mt-2 h-4 w-64 animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
                </div>
                <div className="h-11 w-28 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700" />
            </div>
            <div className="space-y-3">
                {Array.from({ length: 6 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
                    >
                        <div className="flex items-start justify-between gap-4">
                            <div className="flex-1 space-y-3">
                                <div className="h-5 w-2/3 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                                <div className="h-4 w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                <div className="h-4 w-3/4 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                                <div className="flex gap-2">
                                    <div className="h-6 w-16 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                    <div className="h-6 w-20 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                </div>
                            </div>
                            <div className="hidden gap-2 sm:flex">
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

function NoticesErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-bold text-red-700 dark:text-red-200">공지사항을 불러오지 못했습니다.</p>
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

export default function NoticesAdminClient({
    notices: initialNotices,
    classes: initialClasses,
    pagination: initialPagination,
}: {
    notices?: NoticeData[];
    classes?: ClassInfo[];
    pagination?: NoticePagination;
}) {
    const [isPending, startTransition] = useTransition();
    const hasInitialData = initialNotices !== undefined && initialClasses !== undefined;
    const [notices, setNotices] = useState<NoticeData[]>(initialNotices ?? []);
    const [classes, setClasses] = useState<ClassInfo[]>(initialClasses ?? []);
    const [pagination, setPagination] = useState<NoticePagination | null>(initialPagination ?? null);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editId, setEditId] = useState<string | null>(null);
    const [formTitle, setFormTitle] = useState("");
    const [content, setContent] = useState("");
    const [targetType, setTargetType] = useState("ALL");
    const [selectedClassIds, setSelectedClassIds] = useState<string[]>([]);
    const [isPinned, setIsPinned] = useState(false);
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const [uploading, setUploading] = useState(false);
    // 본문(리치 에디터) 이미지 업로드 진행 상태 — 하단 첨부용 uploading과 별개로 추적한다.
    const [editorUploading, setEditorUploading] = useState(false);
    const [socialNotice, setSocialNotice] = useState<NoticeData | null>(null);
    // 행 클릭 상세 패널 대상(id 로 들고 있어 삭제·새로고침 뒤 사라진 공지는 패널도 자동으로 닫힌다)
    const [detailNoticeId, setDetailNoticeId] = useState<string | null>(null);

    const loadNotices = useCallback(async () => {
        setLoading(true);
        setLoadError(false);
        try {
            const response = await fetch("/api/admin/notices?limit=30", { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load notices.");
            }
            const data = (await response.json()) as NoticesPayload;
            setNotices(data.notices);
            if (data.classes) {
                setClasses(data.classes);
            }
            setPagination(data.pagination ?? null);
        } catch (error) {
            console.error("Failed to load notices:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, []);

    const loadMoreNotices = useCallback(async () => {
        if (!pagination?.hasMore || pagination.nextOffset === null || loadingMore) return;
        setLoadingMore(true);
        setLoadError(false);
        try {
            const params = new URLSearchParams({
                noticesOnly: "1",
                limit: String(pagination.limit),
                offset: String(pagination.nextOffset),
            });
            const response = await fetch(`/api/admin/notices?${params.toString()}`, { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load more notices.");
            }
            const data = (await response.json()) as NoticesPayload;
            setNotices(prev => {
                const seen = new Set(prev.map(notice => notice.id));
                const nextItems = data.notices.filter(notice => !seen.has(notice.id));
                return [...prev, ...nextItems];
            });
            setPagination(data.pagination ?? null);
        } catch (error) {
            console.error("Failed to load more notices:", error);
            setLoadError(true);
        } finally {
            setLoadingMore(false);
        }
    }, [loadingMore, pagination]);

    useEffect(() => {
        if (hasInitialData) return;
        void loadNotices();
    }, [hasInitialData, loadNotices]);

    function resetForm() {
        setEditId(null);
        setFormTitle("");
        setContent("");
        setTargetType("ALL");
        setSelectedClassIds([]);
        setIsPinned(false);
        setAttachments([]);
        setShowForm(false);
    }

    function startEdit(n: NoticeData) {
        setEditId(n.id);
        setFormTitle(n.title);
        // 옛 순수 텍스트 공지는 줄바꿈이 사라지지 않도록 HTML로 변환해 에디터에 넣고,
        // 이미 HTML(리치 에디터로 쓴 공지)이면 그대로 초기값으로 로드한다.
        setContent(isHtmlContent(n.content) ? n.content : plainToEditorHtml(n.content));
        setTargetType(n.targetType);
        setSelectedClassIds(n.targetClassIds ? n.targetClassIds.split(",").map(s => s.trim()) : []);
        setIsPinned(n.isPinned);
        try { setAttachments(n.attachmentsJSON ? JSON.parse(n.attachmentsJSON) : []); } catch { setAttachments([]); }
        setShowForm(true);
    }

    async function handleFileUpload(files: FileList | null) {
        if (!files || files.length === 0) return;
        setUploading(true);
        const failedNames: string[] = [];
        for (const file of Array.from(files)) {
            try {
                const compressed = await compressImageForUpload(file);
                const fd = new FormData();
                fd.append("file", compressed);
                fd.append("folder", "notices");
                const res = await fetch("/api/upload", { method: "POST", body: fd });
                const data = await res.json();
                if (data.url) {
                    setAttachments(prev => [...prev, { url: data.url, filename: file.name, size: compressed.size }]);
                } else {
                    failedNames.push(file.name);
                }
            } catch (e) {
                console.error("Upload failed:", e);
                failedNames.push(file.name);
            }
        }
        setUploading(false);
        if (failedNames.length > 0) {
            alert(`업로드하지 못한 첨부 이미지가 있습니다: ${failedNames.join(", ")}`);
        }
    }

    function toggleClassId(id: string) {
        setSelectedClassIds(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
    }

    function handleSubmit() {
        if (!formTitle.trim()) { alert("제목을 입력해주세요."); return; }
        // 리치 에디터는 빈 상태에서도 "<p></p>"를 내보내므로 태그를 걷어내 실제 내용 유무로 검사한다.
        if (isEmptyContent(content)) { alert("내용을 입력해주세요."); return; }
        // 본문 이미지가 아직 업로드 중이면 미완 이미지가 저장될 수 있어 잠시 대기시킨다.
        if (editorUploading) { alert("본문 이미지 업로드가 끝날 때까지 잠시 기다려주세요."); return; }
        if (targetType === "CLASS" && selectedClassIds.length === 0) { alert("대상 반을 선택해주세요."); return; }
        const payload = {
            title: formTitle,
            content,
            targetType,
            targetClassIds: targetType === "CLASS" ? selectedClassIds.join(",") : null,
            attachmentsJSON: attachments.length > 0 ? JSON.stringify(attachments) : null,
            isPinned,
        };
        startTransition(async () => {
            try {
                if (editId) {
                    await updateNotice(editId, payload);
                } else {
                    await createNotice(payload);
                }
                resetForm();
                await loadNotices();
            } catch (e) {
                console.error("공지 저장 실패:", e);
                alert("공지 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.\n(문제가 계속되면 관리자에게 문의하세요.)");
            }
        });
    }

    function handleDelete(id: string) {
        if (!confirm("이 공지사항을 삭제하시겠습니까?")) return;
        startTransition(async () => {
            await deleteNotice(id);
            await loadNotices();
        });
    }

    // 첨부 JSON 을 안전하게 읽는다(깨진 값이면 빈 목록 — 기존 목록 카드와 같은 처리)
    function parseAttachments(n: NoticeData): Attachment[] {
        try { return n.attachmentsJSON ? JSON.parse(n.attachmentsJSON) : []; } catch { return []; }
    }

    // 반별 공지의 대상 반 이름(이미 받아온 classes 에서 찾는다 — 새 조회 없음)
    function targetClassNames(n: NoticeData): string[] {
        if (n.targetType !== "CLASS" || !n.targetClassIds) return [];
        return n.targetClassIds.split(",").map(s => s.trim()).filter(Boolean)
            .map(id => classes.find(c => c.id === id)?.name ?? "삭제된 반");
    }

    // 행 키보드: 안쪽 버튼에서 누른 Enter/Space 는 가로채지 않는다
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailNoticeId(id);
        }
    }

    const detailNotice = detailNoticeId ? notices.find(n => n.id === detailNoticeId) ?? null : null;

    if (loading && notices.length === 0) {
        return <NoticesLoadingFallback />;
    }

    if (loadError && notices.length === 0) {
        return <NoticesErrorState onRetry={loadNotices} />;
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold text-gray-900 dark:text-white">공지사항 관리</h1>
                </div>
                <button onClick={() => { resetForm(); setShowForm(true); }}
                    className="flex items-center gap-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-4 py-2.5 rounded-xl font-bold hover:bg-orange-600 transition">
                    <SymbolIcon name="add" size={18} /> 새 공지
                </button>
            </div>

            {/* Form Modal */}
            {showForm && (
                <AdminModal onClose={resetForm} titleId="notice-form-modal-title" panelClassName="max-w-2xl">
                        <div className="p-6 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
                            <h2 id="notice-form-modal-title" className="text-lg font-bold">{editId ? "공지 수정" : "새 공지"}</h2>
                            <button onClick={resetForm} className="p-1 hover:bg-gray-100 dark:bg-gray-800 rounded-lg"><SymbolIcon name="close" size={20} /></button>
                        </div>
                        <div className="p-6 space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">제목</label>
                                <input value={formTitle} onChange={e => setFormTitle(e.target.value)}
                                    placeholder="공지 제목을 입력하세요"
                                    className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 text-sm" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">내용</label>
                                {/* 리치 에디터 — 굵게/색상/목록/링크/이미지/표/영상 등 서식 지원. 저장은 기존 content 컬럼(HTML)에 그대로 들어간다.
                                    본문에 넣은 이미지는 "notices" 폴더로 업로드된다(하단 첨부와 폴더 공유). */}
                                <RichTextEditor
                                    value={content}
                                    onChange={setContent}
                                    uploadFolder="notices"
                                    placeholder="공지 내용을 입력하세요"
                                    onUploadingChange={setEditorUploading}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">공지 대상</label>
                                <div className="flex gap-3 mb-2">
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input type="radio" checked={targetType === "ALL"} onChange={() => setTargetType("ALL")} />
                                        <span className="text-sm">전체 공지</span>
                                    </label>
                                    <label className="flex items-center gap-2 cursor-pointer">
                                        <input type="radio" checked={targetType === "CLASS"} onChange={() => setTargetType("CLASS")} />
                                        <span className="text-sm">반별 공지</span>
                                    </label>
                                </div>
                                {targetType === "CLASS" && (
                                    <div className="flex flex-wrap gap-2 mt-2">
                                        {classes.map(c => (
                                            <button key={c.id}
                                                onClick={() => toggleClassId(c.id)}
                                                className={`text-xs px-3 py-1.5 rounded-full border transition ${
                                                    selectedClassIds.includes(c.id)
                                                        ? "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white border-brand-orange-500 dark:border-brand-neon-lime"
                                                        : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 border-gray-200 hover:border-brand-orange-300 dark:border-brand-neon-lime"
                                                }`}>
                                                {c.name}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-200 mb-1">첨부파일</label>
                                <label className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-brand-orange-500 dark:text-brand-neon-lime cursor-pointer transition">
                                    <SymbolIcon name="attach_file" size={16} /> {uploading ? "업로드 중..." : "이미지 첨부"}
                                    <input type="file" accept="image/*" className="hidden" multiple onChange={e => handleFileUpload(e.target.files)} disabled={uploading} />
                                </label>
                                <p className="text-xs text-gray-400 mt-1">JPG·PNG·WebP·GIF, 최대 5MB</p>
                                {attachments.length > 0 && (
                                    <div className="mt-2 space-y-1">
                                        {attachments.map((a, i) => (
                                            <div key={i} className="flex items-center justify-between gap-2 bg-gray-50 dark:bg-gray-900 rounded-lg px-3 py-2">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    {isImageAttachment(a) && (
                                                        // eslint-disable-next-line @next/next/no-img-element
                                                        <img src={a.url} alt="" className="w-9 h-9 rounded object-cover border border-gray-200 dark:border-gray-700 shrink-0" />
                                                    )}
                                                    <span className="text-xs text-gray-600 dark:text-gray-300 truncate">{a.filename}</span>
                                                </div>
                                                <button onClick={() => setAttachments(prev => prev.filter((_, j) => j !== i))}
                                                    className="text-gray-400 hover:text-red-500 shrink-0">
                                                    <SymbolIcon name="close" size={14} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-2">
                                <input type="checkbox" id="isPinned" checked={isPinned} onChange={e => setIsPinned(e.target.checked)} className="rounded" />
                                <label htmlFor="isPinned" className="text-sm text-gray-700 dark:text-gray-200">상단 고정</label>
                            </div>
                        </div>
                        <div className="p-6 border-t border-gray-100 dark:border-gray-800 flex justify-end gap-3">
                            <button onClick={resetForm} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:bg-gray-800 rounded-xl transition">취소</button>
                            <button onClick={handleSubmit} disabled={isPending || uploading || editorUploading}
                                className="px-6 py-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold rounded-xl hover:bg-orange-600 transition disabled:opacity-50">
                                {isPending ? "저장 중..." : editorUploading ? "이미지 업로드 중..." : editId ? "수정" : "등록"}
                            </button>
                        </div>
                </AdminModal>
            )}

            {socialNotice && <NoticeSocialModal notice={socialNotice} onClose={() => setSocialNotice(null)} />}

            {/* 공지 목록 — 한 줄 행(고정 | 제목 | 대상 | 첨부 | 작성일 | 관리). 본문 미리보기·대상 반·첨부는 행을 누르면 상세 패널 */}
            {notices.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    아직 공지사항이 없습니다. &quot;새 공지&quot; 버튼으로 공지를 작성하세요.
                </div>
            ) : (
                <div className="space-y-3">
                    <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                        <div className="overflow-x-auto">
                            {/* admin-list-table: 글자 왼쪽·날짜/개수 오른쪽(tabular)·한 줄(말줄임 없음, 좁으면 가로 스크롤) */}
                            <table className="admin-list-table w-full border-collapse text-sm">
                                <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                                    <tr>
                                        <th className="admin-cell-center px-2 py-2">고정</th>
                                        <th className="px-2 py-2">제목</th>
                                        <th className="px-2 py-2">대상</th>
                                        <th className="admin-cell-num hidden px-2 py-2 md:table-cell">첨부</th>
                                        <th className="admin-cell-num px-2 py-2">작성일</th>
                                        <th className="admin-cell-center px-2 py-2">관리</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[var(--color-academy-line)]">
                                    {notices.map(n => {
                                        const atts = parseAttachments(n);
                                        const classNames = targetClassNames(n);
                                        return (
                                            <tr
                                                key={n.id}
                                                tabIndex={0}
                                                aria-label={`${n.title} 공지 상세 보기`}
                                                onClick={() => setDetailNoticeId(n.id)}
                                                onKeyDown={(event) => handleRowKeyDown(event, n.id)}
                                                className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                                            >
                                                <td className="admin-cell-center px-2 py-1.5">
                                                    {n.isPinned
                                                        ? <span className="material-symbols-outlined text-base text-[var(--color-academy-primary)]" aria-label="상단 고정">push_pin</span>
                                                        : <span className="text-[var(--color-academy-muted)]" aria-hidden="true">-</span>}
                                                </td>
                                                <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{n.title}</td>
                                                {/* 대상: 전체 / 반별(반 1개면 이름, 여러 개면 «반별 N개») — 전체 반 이름은 상세 패널 */}
                                                <td className="px-2 py-1.5 text-[var(--color-academy-muted)]">
                                                    {n.targetType === "ALL"
                                                        ? "전체"
                                                        : classNames.length === 1 ? classNames[0] : <>반별 <span className="tabular-nums">{classNames.length}</span>개</>}
                                                </td>
                                                <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{atts.length > 0 ? `${atts.length}개` : "-"}</td>
                                                <td className="admin-cell-num px-2 py-1.5 text-[var(--color-academy-muted)]">{toKstYmd(n.createdAt)}</td>
                                                {/* 관리: 소셜 발행·수정·삭제(행 클릭=상세 패널과 겹치지 않게 전파 차단). 함수·확인창은 기존 그대로 */}
                                                <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                                                    <div className="inline-flex gap-0.5">
                                                        <button type="button" onClick={() => setSocialNotice(n)}
                                                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                                                            title="소셜 발행" aria-label={`${n.title} 소셜 발행`}>
                                                            <SymbolIcon name="campaign" size={18} />
                                                        </button>
                                                        <button type="button" onClick={() => startEdit(n)}
                                                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                                                            title="수정" aria-label={`${n.title} 수정`}>
                                                            <SymbolIcon name="edit" size={18} />
                                                        </button>
                                                        <button type="button" onClick={() => handleDelete(n.id)}
                                                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] transition hover:bg-[var(--color-academy-danger-soft)] hover:text-[var(--color-academy-danger)]"
                                                            title="삭제" aria-label={`${n.title} 삭제`}>
                                                            <SymbolIcon name="delete" size={18} />
                                                        </button>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    {pagination?.hasMore && (
                        <div className="flex justify-center">
                            <button
                                type="button"
                                onClick={loadMoreNotices}
                                disabled={loadingMore}
                                className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-5 text-sm font-bold text-[var(--color-academy-ink)] transition hover:border-[var(--color-academy-primary)] disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                <SymbolIcon name={loadingMore ? "progress_activity" : "expand_more"} size={18} />
                                {loadingMore ? "불러오는 중..." : `더 보기 (${Math.max(pagination.total - notices.length, 0)}개 남음)`}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* 행 클릭 상세 패널 — 데스크톱 오른쪽 / 모바일 하단 시트. 이미 받아온 값만 보여 준다(새 조회 없음) */}
            {detailNotice && (() => {
                const d = detailNotice;
                const atts = parseAttachments(d);
                const classNames = targetClassNames(d);
                return (
                    <ListDetailPanel onClose={() => setDetailNoticeId(null)} titleId="notice-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                        <div className="mb-4 flex items-start gap-2">
                            {d.isPinned && <SymbolIcon name="push_pin" size={18} className="mt-1 shrink-0 text-[var(--color-academy-primary)]" />}
                            <h3 id="notice-detail-panel-title" className="min-w-0 break-keep break-words text-lg font-black text-[var(--color-academy-ink)]">{d.title}</h3>
                            <button
                                type="button"
                                onClick={() => setDetailNoticeId(null)}
                                aria-label="닫기"
                                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="material-symbols-outlined" aria-hidden="true">close</span>
                            </button>
                        </div>
                        <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                            <dt className="font-bold text-[var(--color-academy-muted)]">대상</dt>
                            <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">
                                {d.targetType === "ALL" ? "전체 공지" : `반별 공지 · ${classNames.join(", ") || "선택된 반 없음"}`}
                            </dd>
                            <dt className="font-bold text-[var(--color-academy-muted)]">작성일</dt>
                            <dd className="tabular-nums text-[var(--color-academy-ink)]">{toKstYmd(d.createdAt)}</dd>
                            <dt className="font-bold text-[var(--color-academy-muted)]">상단 고정</dt>
                            <dd className="text-[var(--color-academy-ink)]">{d.isPinned ? "고정" : "고정 안 함"}</dd>
                            {atts.length > 0 && (
                                <>
                                    <dt className="font-bold text-[var(--color-academy-muted)]">첨부</dt>
                                    <dd className="min-w-0 space-y-1">
                                        {atts.map((a, i) => (
                                            <a key={i} href={a.url} target="_blank" rel="noopener noreferrer"
                                                className="flex min-h-11 items-center gap-1 break-all text-[var(--color-academy-primary)] hover:underline">
                                                <SymbolIcon name="attach_file" size={16} className="shrink-0" /> {a.filename}
                                            </a>
                                        ))}
                                    </dd>
                                </>
                            )}
                        </dl>
                        {/* 본문 미리보기 — HTML 공지는 태그를 걷어낸 글자만(기존 목록 미리보기와 같은 함수), 말줄임 없이 전부 */}
                        <p className="mt-4 whitespace-pre-wrap break-keep break-words rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
                            {stripHtmlForPreview(d.content) || "(글자 없이 이미지·표만 있는 공지)"}
                        </p>
                        <div className="mt-5 flex flex-wrap gap-2">
                            <button type="button" onClick={() => { setDetailNoticeId(null); startEdit(d); }}
                                className="inline-flex min-h-11 items-center gap-1 rounded-lg bg-[var(--color-academy-primary)] px-4 text-sm font-bold text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]">
                                <SymbolIcon name="edit" size={18} /> 수정
                            </button>
                            <button type="button" onClick={() => { setDetailNoticeId(null); setSocialNotice(d); }}
                                className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-academy-line)] px-4 text-sm font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]">
                                <SymbolIcon name="campaign" size={18} /> 소셜 발행
                            </button>
                            <button type="button" onClick={() => handleDelete(d.id)}
                                className="inline-flex min-h-11 items-center gap-1 rounded-lg border border-[var(--color-academy-danger)] px-4 text-sm font-bold text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]">
                                <SymbolIcon name="delete" size={18} /> 삭제
                            </button>
                        </div>
                    </ListDetailPanel>
                );
            })()}
        </div>
    );
}
