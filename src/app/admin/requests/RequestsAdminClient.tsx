"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { updateRequestStatus, getParentRequestStatusForAdmin, deleteParentRequest } from "@/app/actions/admin";

const TYPE_LABELS: Record<string, { label: string; color: string }> = {
    ABSENCE: { label: "결석 신청", color: "bg-red-100 text-red-700" },
    SHUTTLE: { label: "셔틀 변경", color: "bg-blue-100 text-blue-700" },
    EARLY_LEAVE: { label: "조퇴 요청", color: "bg-yellow-100 text-yellow-700" },
    OTHER: { label: "기타", color: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200" },
};

const STATUS_OPTIONS = [
    { value: "PENDING", label: "대기중", color: "bg-yellow-100 text-yellow-700", iconName: "schedule" },
    { value: "CONFIRMED", label: "확인됨", color: "bg-blue-100 text-blue-700", iconName: "check_circle" },
    { value: "COMPLETED", label: "상담 종결", color: "bg-green-100 text-green-700", iconName: "check_circle" },
    { value: "REJECTED", label: "반려", color: "bg-red-100 text-red-700", iconName: "cancel" },
];

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

type RequestData = {
    id: string;
    userId: string;
    studentId: string;
    type: string;
    title: string;
    content: string;
    date: Date | string | null;
    status: string;
    adminNote: string | null;
    createdAt: Date | string;
    updatedAt: Date | string;
    studentName: string;
    parentName: string;
    parentPhone: string | null;
};

type RequestsPayload = {
    requests: RequestData[];
    counts?: RequestCounts;
    pagination?: RequestPagination;
    statusFilter?: string;
};

type RequestCounts = {
    ALL: number;
    PENDING: number;
    CONFIRMED: number;
    COMPLETED: number;
    REJECTED: number;
};

type RequestPagination = {
    limit: number;
    offset: number;
    returned: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
    partial?: boolean;
};

const DEFAULT_REQUEST_COUNTS: RequestCounts = {
    ALL: 0,
    PENDING: 0,
    CONFIRMED: 0,
    COMPLETED: 0,
    REJECTED: 0,
};

function RequestsLoadingFallback() {
    return (
        <div className="mx-auto max-w-4xl space-y-6">
            <div>
                <div className="h-8 w-56 animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-800" />
            </div>
            <div className="flex flex-wrap gap-2">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div
                        key={index}
                        className="h-10 w-24 animate-pulse rounded-xl bg-gray-200 dark:bg-gray-700"
                    />
                ))}
            </div>
            <div className="space-y-3">
                {Array.from({ length: 5 }).map((_, index) => (
                    <div
                        key={index}
                        className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-800"
                    >
                        <div className="flex items-center gap-3 px-5 py-4">
                            <div className="h-9 w-9 flex-shrink-0 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                            <div className="min-w-0 flex-1 space-y-2">
                                <div className="flex gap-2">
                                    <div className="h-5 w-20 animate-pulse rounded-full bg-gray-100 dark:bg-gray-700" />
                                    <div className="h-5 w-48 max-w-full animate-pulse rounded bg-gray-200 dark:bg-gray-700" />
                                </div>
                                <div className="h-4 w-64 max-w-full animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                            </div>
                            <div className="h-5 w-5 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function RequestsErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="mx-auto max-w-4xl rounded-2xl border border-red-200 bg-red-50 p-6 text-center dark:border-red-800 dark:bg-red-950/30">
            <p className="text-sm font-bold text-red-700 dark:text-red-200">요청 목록을 불러오지 못했습니다.</p>
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

export default function RequestsAdminClient({
    requests: initialRequests,
    counts: initialCounts,
    pagination: initialPagination,
    statusFilter: initialStatusFilter = "ALL",
}: {
    requests?: RequestData[];
    counts?: RequestCounts;
    pagination?: RequestPagination;
    statusFilter?: string;
}) {
    const hasInitialData = initialRequests !== undefined;
    const [requests, setRequests] = useState<RequestData[]>(initialRequests ?? []);
    const [counts, setCounts] = useState<RequestCounts>(initialCounts ?? DEFAULT_REQUEST_COUNTS);
    const [pagination, setPagination] = useState<RequestPagination | undefined>(initialPagination);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadingMore, setLoadingMore] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [filter, setFilter] = useState<string>(initialStatusFilter);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const [adminNotes, setAdminNotes] = useState<Record<string, string>>({});
    const [feedback, setFeedback] = useState<string | null>(null);
    const [uncertain, setUncertain] = useState<Record<string, { status: string; note: string }>>({});
    const [isPending, startTransition] = useTransition();
    const requestedInitialLoad = useRef(false);

    const loadRequests = useCallback(async ({
        status = filter,
        offset = 0,
        append = false,
    }: {
        status?: string;
        offset?: number;
        append?: boolean;
    } = {}) => {
        if (append) {
            setLoadingMore(true);
        } else {
            setLoading(true);
        }
        setLoadError(false);
        try {
            const params = new URLSearchParams({
                limit: String(pagination?.limit ?? 30),
                offset: String(offset),
            });
            if (status && status !== "ALL") {
                params.set("status", status);
            }
            const response = await fetch(`/api/admin/requests?${params.toString()}`, { cache: "no-store" });
            if (!response.ok) {
                throw new Error("Failed to load requests.");
            }
            const data = (await response.json()) as RequestsPayload;
            setRequests((current) => {
                if (!append) return data.requests;
                const seen = new Set(current.map((request) => request.id));
                return [...current, ...data.requests.filter((request) => !seen.has(request.id))];
            });
            if (data.counts) setCounts(data.counts);
            if (data.pagination) setPagination(data.pagination);
        } catch (error) {
            console.error("Failed to load requests:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
            setLoadingMore(false);
        }
    }, [filter, pagination?.limit]);

    useEffect(() => {
        if (hasInitialData || requestedInitialLoad.current) return;
        requestedInitialLoad.current = true;
        void loadRequests();
    }, [hasInitialData, loadRequests]);

    if (loading && requests.length === 0) {
        return <RequestsLoadingFallback />;
    }

    if (loadError && requests.length === 0) {
        return <RequestsErrorState onRetry={loadRequests} />;
    }

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div>
                {/* 일반 메시지의 상담 상태를 실제 운영 반영과 구분한다. */}
                <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">학부모 요청 관리</h1>
                <p className="mt-2 text-sm text-gray-500">상담 상태와 답변을 관리합니다. 상담 종결은 출결·셔틀 변경 완료를 의미하지 않습니다.</p>
            </div>
            {feedback && <p role="status" className="rounded-xl border border-gray-200 p-3 text-sm">{feedback}</p>}
            {loadError && requests.length > 0 && <p role="alert" className="text-sm text-red-600">목록을 새로 불러오지 못했습니다. 이전 내용을 표시합니다.</p>}

            {/* 필터 탭 */}
            <div className="flex gap-2 flex-wrap">
                {[
                    { value: "ALL", label: "전체" },
                    { value: "PENDING", label: "대기중" },
                    { value: "CONFIRMED", label: "확인됨" },
                    { value: "COMPLETED", label: "상담 종결" },
                ].map(f => (
                    <button key={f.value}
                        onClick={() => {
                            setFilter(f.value);
                            void loadRequests({ status: f.value, offset: 0 });
                        }}
                        className={`px-4 py-2 rounded-xl text-sm font-bold transition ${
                            filter === f.value
                                ? "bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white"
                                : "bg-white dark:bg-gray-800 border border-gray-200 text-gray-600 dark:text-gray-300 hover:border-brand-orange-300 dark:border-brand-neon-lime"
                        }`}
                    >
                        {f.label}
                        <span className="ml-1 opacity-70">({counts[f.value as keyof typeof counts] ?? 0})</span>
                    </button>
                ))}
            </div>

            {/* 요청 목록 */}
            {requests.length === 0 ? (
                <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 transition-colors duration-300 p-12 text-center text-gray-400 shadow-sm">
                    <SymbolIcon name="forum" size={48} className="mx-auto mb-3 text-gray-300" />
                    <p className="font-medium">요청이 없습니다</p>
                </div>
            ) : (
                <div className="space-y-3">
                    {requests.map(req => {
                        const typeInfo = TYPE_LABELS[req.type] || TYPE_LABELS.OTHER;
                        const statusInfo = STATUS_OPTIONS.find(s => s.value === req.status) || STATUS_OPTIONS[0];
                        const isExpanded = expandedId === req.id;

                        return (
                            <div key={req.id} className={`bg-white dark:bg-gray-800 rounded-2xl border shadow-sm overflow-hidden transition ${
                                req.status === "PENDING" ? "border-yellow-200" : "border-gray-100 dark:border-gray-800"
                            }`}>
                                {/* 요약 헤더 (클릭하면 펼침) */}
                                <button
                                    onClick={() => setExpandedId(isExpanded ? null : req.id)}
                                    className="w-full px-5 py-4 flex items-center gap-3 text-left hover:bg-gray-50 dark:bg-gray-900 transition"
                                >
                                    {/* 상태 아이콘 */}
                                    <div className={`p-2 rounded-full flex-shrink-0 ${statusInfo.color}`}>
                                        <SymbolIcon name={statusInfo.iconName} size={16} />
                                    </div>

                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${typeInfo.color}`}>
                                                {typeInfo.label}
                                            </span>
                                            <span className="font-bold text-sm text-gray-900 dark:text-white truncate">{req.title}</span>
                                        </div>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                            {req.parentName} ({req.studentName}) &middot; {new Date(req.createdAt).toLocaleDateString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                        </p>
                                    </div>

                                    <SymbolIcon
                                        name={isExpanded ? "expand_less" : "expand_more"}
                                        size={18}
                                        className="text-gray-400"
                                    />
                                </button>

                                {/* 상세 (펼침) */}
                                {isExpanded && (
                                    <div className="px-5 pb-5 border-t border-gray-50 space-y-4">
                                        {/* 요청 내용 */}
                                        <div className="pt-3">
                                            <p className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap">{req.content}</p>
                                            {req.date && (
                                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                                                    해당 날짜: <span className="font-bold">{new Date(req.date).toLocaleDateString("ko-KR")}</span>
                                                </p>
                                            )}
                                            {req.parentPhone && (
                                                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                                    연락처: <a href={`tel:${req.parentPhone}`} className="text-brand-orange-500 dark:text-brand-neon-lime font-bold">{req.parentPhone}</a>
                                                </p>
                                            )}
                                        </div>

                                        {/* 관리자 메모 */}
                                        <div>
                                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">관리자 메모/답변</label>
                                            <textarea
                                                disabled={isPending || !!uncertain[req.id]}
                                                value={adminNotes[req.id] ?? req.adminNote ?? ""}
                                                onChange={e => setAdminNotes(prev => ({ ...prev, [req.id]: e.target.value }))}
                                                placeholder="학부모에게 전달할 답변을 작성하세요"
                                                rows={2}
                                                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm resize-none"
                                            />
                                        </div>

                                        {uncertain[req.id] && <button type="button" disabled={isPending} className="text-sm font-bold underline" onClick={() => startTransition(async () => {
                                            try {
                                                const stored = await getParentRequestStatusForAdmin(req.id);
                                                const expected = uncertain[req.id];
                                                if (!stored) { setFeedback("요청을 찾을 수 없습니다. 입력한 답변은 유지됩니다."); return; }
                                                if (stored.status === expected.status && (stored.adminNote ?? "") === expected.note) {
                                                    setFeedback("상담 상태 저장을 확인했습니다. 알림 결과는 확인되지 않아 다시 보내지 않습니다.");
                                                } else {
                                                    setFeedback("현재 저장 내용이 입력값과 다릅니다. 답변을 유지했으니 현재 상태를 확인하고 다시 처리해 주세요.");
                                                }
                                                setUncertain(prev => { const next = { ...prev }; delete next[req.id]; return next; });
                                                await loadRequests({ status: filter, offset: 0 });
                                            } catch { setFeedback("현재 상태도 조회하지 못했습니다. 입력한 답변을 유지하고 중복 처리를 막았습니다."); }
                                        })}>저장 상태 다시 조회</button>}
                                        {/* 상태 변경 버튼 */}
                                        <div className="flex gap-2 flex-wrap">
                                            {STATUS_OPTIONS.filter(s => s.value !== req.status).map(s => {
                                                return (
                                                    <button key={s.value}
                                                        disabled={isPending || !!uncertain[req.id]}
                                                        onClick={() => startTransition(async () => {
                                                            const note = adminNotes[req.id] ?? req.adminNote ?? "";
                                                            setFeedback(null);
                                                            try {
                                                                const result = await updateRequestStatus(req.id, s.value, note);
                                                                if (!result.saved) {
                                                                    setUncertain(prev => ({ ...prev, [req.id]: { status: s.value, note } }));
                                                                    setFeedback("저장 결과 확인이 필요합니다. 입력한 답변은 유지됩니다. 상태를 다시 조회해 주세요.");
                                                                    return;
                                                                }
                                                                setFeedback(result.notification === "REGISTERED"
                                                                    ? `상담 상태 저장 완료 · 사이트 알림 등록 완료 · ${result.push === "SENT" ? "푸시 전송 접수" : result.push === "NO_SUBSCRIPTION" ? "푸시 미등록" : result.push === "NOT_CONFIGURED" ? "푸시 설정 필요" : result.push === "PARTIAL" ? "푸시 일부 실패" : result.push === "FAILED" ? "푸시 전송 실패" : "푸시 결과 확인 필요"}`
                                                                    : result.notification === "UNCHANGED" ? "기존 저장 상태를 확인했습니다. 알림은 다시 보내지 않았습니다." : "상담 상태 저장 완료 · 사이트 알림 등록 결과 확인 필요. 자동 재발송하지 않습니다.");
                                                                await loadRequests({ status: filter, offset: 0 });
                                                            } catch {
                                                                setUncertain(prev => ({ ...prev, [req.id]: { status: s.value, note } }));
                                                                setFeedback("저장 응답을 확인하지 못했습니다. 입력한 답변은 유지됩니다. 먼저 상태를 다시 조회해 주세요.");
                                                            }
                                                        })}
                                                        className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition hover:shadow-sm ${s.color}`}
                                                    >
                                                        <SymbolIcon name={s.iconName} size={14} /> {s.label}
                                                    </button>
                                                );
                                            })}
                                            <button
                                                disabled={isPending || !!uncertain[req.id]}
                                                onClick={() => {
                                                    if (confirm("이 요청을 삭제하시겠습니까?")) {
                                                        startTransition(async () => {
                                                            await deleteParentRequest(req.id);
                                                            setExpandedId(null);
                                                            await loadRequests({ status: filter, offset: 0 });
                                                        });
                                                    }
                                                }}
                                                className="ml-auto text-xs text-red-400 hover:text-red-600 transition"
                                            >
                                                삭제
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {pagination?.hasMore && (
                        <div className="pt-2 text-center">
                            <button
                                type="button"
                                disabled={loadingMore}
                                onClick={() => void loadRequests({
                                    status: filter,
                                    offset: pagination.nextOffset ?? requests.length,
                                    append: true,
                                })}
                                className="rounded-xl border border-gray-200 bg-white px-5 py-2 text-sm font-bold text-gray-700 transition hover:border-brand-orange-300 disabled:opacity-60 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100"
                            >
                                {loadingMore ? "불러오는 중..." : `더 보기 (${requests.length}/${pagination.total})`}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
