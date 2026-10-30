"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { updateRequestStatus, getParentRequestStatusForAdmin, deleteParentRequest } from "@/app/actions/admin";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
// 날짜·시각 표시는 KST 모듈로만(기기 시간대를 따라가지 않게)
import { formatKstDate, kstLabel } from "@/lib/datetime/kst";

// 종류·상태 색은 CSS 변수 토큰(다크 모드도 토큰이 바뀐다)
const TYPE_LABELS: Record<string, { label: string; color: string }> = {
    ABSENCE: { label: "결석 신청", color: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" },
    SHUTTLE: { label: "셔틀 변경", color: "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]" },
    EARLY_LEAVE: { label: "조퇴 요청", color: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" },
    OTHER: { label: "기타", color: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" },
};

const STATUS_OPTIONS = [
    { value: "PENDING", label: "대기중", color: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]", iconName: "schedule" },
    { value: "CONFIRMED", label: "확인됨", color: "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]", iconName: "check_circle" },
    { value: "COMPLETED", label: "상담 종결", color: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]", iconName: "check_circle" },
    { value: "REJECTED", label: "반려", color: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]", iconName: "cancel" },
];

// 상태 칩 — 예전 필터 탭(대기중·확인됨·상담 종결)과 같은 filter 값. 반려도 서버가 받는 값이라 건수가 있으면 보인다
const STATUS_FILTER_ALL = "ALL";
const STATUS_FILTER_CHIPS = [
    { value: "PENDING", label: "대기중" },
    { value: "CONFIRMED", label: "확인됨" },
    { value: "COMPLETED", label: "상담 종결" },
    { value: "REJECTED", label: "반려" },
] as const;

// 접수 시각 «14:05» (KST)
function formatKstTime(value: Date | string) {
    return formatKstDate(value, { hour: "2-digit", minute: "2-digit", hour12: false }, "-");
}

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
                className="academy-button-secondary mt-4"
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

    // 상태 칩 = 예전 필터 탭과 같은 동작(filter 바꾸고 그 상태 첫 페이지를 서버에서 다시 읽기). 다시 누르면 "ALL"
    function applyStatusFilter(value: string) {
        setExpandedId(null); // 목록이 바뀌므로 열린 패널은 닫는다
        setFilter(value);
        void loadRequests({ status: value, offset: 0 });
    }

    // 행 키보드(Enter·Space) = 상세 패널. 안쪽 요소에서 누른 키는 가로채지 않는다.
    function handleRowKeyDown(event: React.KeyboardEvent<HTMLElement>, id: string) {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpandedId(id);
        }
    }

    if (loading && requests.length === 0) {
        return <RequestsLoadingFallback />;
    }

    if (loadError && requests.length === 0) {
        return <RequestsErrorState onRetry={loadRequests} />;
    }

    // 예전 «펼침» 대상(expandedId)을 그대로 상세 패널 대상으로 쓴다
    const detail = expandedId ? requests.find((r) => r.id === expandedId) ?? null : null;
    const statusChipItems = STATUS_FILTER_CHIPS.map((chip) => ({ value: chip.value, label: chip.label, count: counts[chip.value] ?? 0 }));

    return (
        <div className="max-w-4xl mx-auto space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                {/* 일반 메시지의 상담 상태를 실제 운영 반영과 구분한다. */}
                <h1 className="text-2xl font-extrabold text-[var(--color-academy-ink)]">학부모 요청 관리</h1>
                <p className="text-xs text-[var(--color-academy-muted)]">상담 상태와 답변을 관리합니다. 상담 종결은 출결·셔틀 변경 완료를 의미하지 않습니다.</p>
            </div>
            {/* 처리 결과 안내 — 패널이 열려 있으면 패널 안에 보인다(같은 글이 두 번 나오지 않게) */}
            {feedback && !detail && <p role="status" className="rounded-xl border border-[var(--color-academy-line)] p-3 text-sm text-[var(--color-academy-ink)]">{feedback}</p>}
            {loadError && requests.length > 0 && <p role="alert" className="text-sm text-[var(--color-academy-danger)]">목록을 새로 불러오지 못했습니다. 이전 내용을 표시합니다.</p>}

            {/* 상태 칩(예전 필터 탭) — 건수는 서버 counts 그대로, 누르면 그 상태, 다시 누르면 전체 */}
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-[var(--color-academy-muted)]">전체 <span className="tabular-nums">{counts.ALL ?? 0}</span>건</span>
                <StatusCountChips
                    ariaLabel="요청 상태별 건수"
                    items={statusChipItems}
                    selected={filter}
                    onSelect={applyStatusFilter}
                    allValue={STATUS_FILTER_ALL}
                />
            </div>

            {/* 요청 목록 */}
            {requests.length === 0 ? (
                <div className="rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-4 text-center text-sm text-[var(--color-academy-muted)]">
                    요청이 없습니다
                </div>
            ) : (
                <div className="space-y-2">
                    <div className="overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] shadow-sm">
                        <div className="overflow-x-auto">
                            {/* 한 줄 행: 접수일 | 시각 | 종류 | 제목 | 학부모 | 원생 | 해당 날짜 | 상태. 내용·연락처·답변·처리는 상세 패널 */}
                            <table className="admin-list-table w-full border-collapse text-sm">
                                <thead className="bg-[var(--color-academy-soft)] text-xs font-black text-[var(--color-academy-muted)]">
                                    <tr>
                                        <th className="admin-cell-num px-2 py-2">접수일</th>
                                        <th className="admin-cell-num hidden px-2 py-2 sm:table-cell">시각</th>
                                        <th className="px-2 py-2">종류</th>
                                        <th className="px-2 py-2">제목</th>
                                        <th className="px-2 py-2">학부모</th>
                                        <th className="hidden px-2 py-2 md:table-cell">원생</th>
                                        <th className="admin-cell-num hidden px-2 py-2 md:table-cell">해당 날짜</th>
                                        <th className="px-2 py-2">상태</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[var(--color-academy-line)]">
                                    {requests.map(req => {
                                        const typeInfo = TYPE_LABELS[req.type] || TYPE_LABELS.OTHER;
                                        const statusInfo = STATUS_OPTIONS.find(s => s.value === req.status) || STATUS_OPTIONS[0];
                                        return (
                                            <tr
                                                key={req.id}
                                                tabIndex={0}
                                                aria-label={`${req.title} 요청 상세 보기`}
                                                onClick={() => setExpandedId(req.id)}
                                                onKeyDown={(event) => handleRowKeyDown(event, req.id)}
                                                className="cursor-pointer transition-colors hover:bg-[var(--color-academy-soft)] focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
                                            >
                                                {/* 날짜·시각은 오른쪽 + 자릿수 폭 고정 */}
                                                <td className="admin-cell-num px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{kstLabel(req.createdAt) || "-"}</td>
                                                <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] sm:table-cell">{formatKstTime(req.createdAt)}</td>
                                                <td className="px-2 py-1.5">
                                                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${typeInfo.color}`}>{typeInfo.label}</span>
                                                </td>
                                                <td className="px-2 py-1.5 font-bold text-[var(--color-academy-ink)]">{req.title}</td>
                                                <td className="px-2 py-1.5 text-[var(--color-academy-ink)]">{req.parentName}</td>
                                                <td className="hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{req.studentName}</td>
                                                <td className="admin-cell-num hidden px-2 py-1.5 text-[var(--color-academy-muted)] md:table-cell">{req.date ? kstLabel(req.date) || "-" : "-"}</td>
                                                <td className="px-2 py-1.5">
                                                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${statusInfo.color}`}>
                                                        <SymbolIcon name={statusInfo.iconName} size={14} />
                                                        {statusInfo.label}
                                                    </span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    {pagination?.hasMore && (
                        <div className="text-center">
                            <button
                                type="button"
                                disabled={loadingMore}
                                onClick={() => void loadRequests({
                                    status: filter,
                                    offset: pagination.nextOffset ?? requests.length,
                                    append: true,
                                })}
                                className="min-h-11 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-5 text-sm font-bold text-[var(--color-academy-ink)] transition hover:border-[var(--color-academy-primary)] disabled:opacity-60"
                            >
                                {loadingMore ? "불러오는 중..." : `더 보기 (${requests.length}/${pagination.total})`}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* 행 클릭 상세 패널 — 예전 «펼침» 안의 내용·답변 입력·상태 변경·재조회·삭제를 그대로 옮겼다.
                ⚠️ 상태 변경은 학부모에게 사이트 알림·푸시가 나가는 기존 동작(updateRequestStatus) 그대로 — 자동 발송 추가 없음 */}
            {detail && (() => {
                const req = detail;
                const typeInfo = TYPE_LABELS[req.type] || TYPE_LABELS.OTHER;
                const statusInfo = STATUS_OPTIONS.find(s => s.value === req.status) || STATUS_OPTIONS[0];
                return (
                    <ListDetailPanel onClose={() => setExpandedId(null)} titleId="request-detail-panel-title" panelClassName="p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
                        <div className="mb-3 flex items-start gap-2">
                            <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${typeInfo.color}`}>{typeInfo.label}</span>
                                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${statusInfo.color}`}>
                                        <SymbolIcon name={statusInfo.iconName} size={14} />
                                        {statusInfo.label}
                                    </span>
                                </div>
                                <h3 id="request-detail-panel-title" className="mt-1 break-keep break-words text-lg font-black text-[var(--color-academy-ink)]">{req.title}</h3>
                            </div>
                            <button
                                type="button"
                                onClick={() => setExpandedId(null)}
                                aria-label="닫기"
                                className="ml-auto inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="material-symbols-outlined" aria-hidden="true">close</span>
                            </button>
                        </div>

                        {feedback && <p role="status" className="mb-3 rounded-xl border border-[var(--color-academy-line)] p-3 text-sm text-[var(--color-academy-ink)]">{feedback}</p>}

                        <div className="space-y-4">
                            {/* 요청 정보 + 내용 */}
                            <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                                <dt className="font-bold text-[var(--color-academy-muted)]">학부모</dt>
                                <dd className="min-w-0 break-keep break-words text-[var(--color-academy-ink)]">{req.parentName} ({req.studentName})</dd>
                                <dt className="font-bold text-[var(--color-academy-muted)]">접수</dt>
                                <dd className="tabular-nums text-[var(--color-academy-ink)]">{kstLabel(req.createdAt) || "-"} {formatKstTime(req.createdAt)}</dd>
                                {req.date && (
                                    <>
                                        <dt className="font-bold text-[var(--color-academy-muted)]">해당 날짜</dt>
                                        <dd className="tabular-nums font-bold text-[var(--color-academy-ink)]">{formatKstDate(req.date, { year: "numeric", month: "numeric", day: "numeric" }, "-")}</dd>
                                    </>
                                )}
                                {req.parentPhone && (
                                    <>
                                        <dt className="font-bold text-[var(--color-academy-muted)]">연락처</dt>
                                        <dd><a href={`tel:${req.parentPhone}`} className="inline-flex min-h-11 items-center font-bold tabular-nums text-[var(--color-academy-primary)]">{req.parentPhone}</a></dd>
                                    </>
                                )}
                            </dl>
                            <p className="whitespace-pre-wrap break-words rounded-lg bg-[var(--color-academy-soft)] p-3 text-sm text-[var(--color-academy-ink)]">{req.content}</p>

                            {/* 관리자 메모 */}
                            <div>
                                <label className="text-xs font-medium text-[var(--color-academy-muted)] mb-1 block">관리자 메모/답변</label>
                                <textarea
                                    disabled={isPending || !!uncertain[req.id]}
                                    value={adminNotes[req.id] ?? req.adminNote ?? ""}
                                    onChange={e => setAdminNotes(prev => ({ ...prev, [req.id]: e.target.value }))}
                                    placeholder="학부모에게 전달할 답변을 작성하세요"
                                    rows={3}
                                    className="w-full rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-sm text-[var(--color-academy-ink)] resize-none"
                                />
                            </div>

                            {uncertain[req.id] && <button type="button" disabled={isPending} className="min-h-11 text-sm font-bold underline" onClick={() => startTransition(async () => {
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
                                            className={`flex min-h-11 items-center gap-1.5 px-3 rounded-xl text-xs font-bold border border-transparent transition hover:shadow-sm disabled:opacity-50 ${s.color}`}
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
                                    className="ml-auto min-h-11 px-2 text-xs font-bold text-[var(--color-academy-danger)] transition hover:underline disabled:opacity-50"
                                >
                                    삭제
                                </button>
                            </div>
                        </div>
                    </ListDetailPanel>
                );
            })()}
        </div>
    );
}
