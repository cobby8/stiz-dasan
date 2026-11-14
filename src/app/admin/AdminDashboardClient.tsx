"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { INBOX_TABS } from "@/lib/requests/catalog";
import type { InboxCounts } from "@/lib/requests/admin-inbox";
import type { DashboardSummary } from "@/lib/stats/statsTypes";
// 2026-11-13 대시보드 개편: 맨 위 카드 6개(재원생·수납률·출석률·신규/퇴원·체험→등록·유니폼).
// 예전에 접혀 있던 상세 칸(운영 규모·매출·출석 추이·프로그램별 원생·최근 7일 신규)은 통계 탭(/admin/stats)으로 옮겼다.
import DashboardSummaryCards from "@/components/admin/DashboardSummaryCards";

type DashboardStats = {
    studentCount: number;
    programCount: number;
    coachCount: number;
    classCount: number;
};

type EnrollStats = {
    PENDING: number;
    APPROVED: number;
    REJECTED: number;
    CANCELLED: number;
    total: number;
};

type PendingRequest = {
    id: string;
    title: string;
    createdAt: string;
    studentName: string | null;
    parentName: string | null;
};

type ExtendedStats = {
    thisMonthRevenue: number;
    lastMonthRevenue: number;
    attendanceRate: number;
    unpaidCount: number;
    unpaidAmount: number;
    monthlyRevenue: { month: string; amount: number }[];
    monthlyAttendance: { month: string; rate: number }[];
    programStudents: { name: string; count: number }[];
};

type TodayClass = {
    id: string;
    name: string;
    startTime: string | null;
    endTime: string | null;
    capacity: number;
    programName: string | null;
    enrolled: number;
};

type RecentStudent = {
    id: string;
    name: string;
    createdAt: string;
    parentName: string | null;
};

type DashboardData = {
    stats: DashboardStats;
    pendingRequests: PendingRequest[];
    pendingCount: number;
    enrollStats: EnrollStats;
    // 부원장에게는 서버가 null 로 보낸다(stripDashboardMoneyForRole, 검수 L3)
    extendedStats: ExtendedStats | null;
    todayClasses: TodayClass[];
    recentStudents: RecentStudent[];
    todayLabel?: string;
};

type SystemStatusData = {
    dbOk: boolean;
    backup: {
        lastBackupAt: string | null;
        backupCount: number;
        // 최신 백업 파일 크기·담긴 업무 자료(표·행 수) — 예전 응답·예전 파일이면 없다
        lastBackupBytes?: number | null;
        archive?: { tables: number; rows: number; complete: boolean } | null;
    };
};

type SiteOpsCheckStatus = "ok" | "fixed" | "warning" | "critical";

type SiteOpsCheck = {
    id: string;
    label: string;
    status: SiteOpsCheckStatus;
    message: string;
    actionLabel?: string;
    actionHref?: string;
};

type SiteOpsBotResult = {
    checkedAt: string;
    ok: boolean;
    fixedCount: number;
    manualActionCount: number;
    criticalCount: number;
    checks: SiteOpsCheck[];
    notified: boolean;
};

function DashboardPrimarySkeleton() {
    return (
        <div className="grid gap-4 lg:grid-cols-2" aria-label="대시보드 불러오는 중" role="status">
            {[0, 1].map((item) => (
                <div key={item} className="academy-panel p-5 animate-pulse">
                    <div className="mb-5 h-4 w-28 rounded bg-[var(--color-academy-line)]" />
                    <div className="mb-3 h-4 w-3/4 rounded bg-[var(--color-academy-soft)]" />
                    <div className="h-4 w-1/2 rounded bg-[var(--color-academy-soft)]" />
                </div>
            ))}
        </div>
    );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-[var(--color-academy-danger)] bg-[var(--color-academy-surface)] p-8 text-center shadow-sm">
            <p className="font-semibold text-[var(--color-academy-ink)]">대시보드 데이터를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="academy-button-secondary mt-4"
            >
                다시 시도
            </button>
        </div>
    );
}

export default function AdminDashboardClient({
    initialData,
    hydrateFullData = false,
    inboxCounts = null,
    summary = null,
}: {
    initialData?: DashboardData;
    hydrateFullData?: boolean;
    /** 신청함 개수(getInboxCounts) — 없으면 옛 숫자(문의 대기)로 */
    inboxCounts?: InboxCounts | null;
    /** 맨 위 카드 6개 숫자(getCachedAdminDashboardSummary) — 못 읽었으면 카드 칸을 그리지 않는다 */
    summary?: DashboardSummary | null;
}) {
    const hasInitialData = initialData !== undefined;
    const [data, setData] = useState<DashboardData | null>(initialData ?? null);
    const [loading, setLoading] = useState(!hasInitialData);
    const [error, setError] = useState<string | null>(null);
    const [systemStatus, setSystemStatus] = useState<SystemStatusData | null>(null);
    const [systemLoading, setSystemLoading] = useState(false);
    const [systemError, setSystemError] = useState(false);
    const [siteOpsResult, setSiteOpsResult] = useState<SiteOpsBotResult | null>(null);
    const [siteOpsLoading, setSiteOpsLoading] = useState(false);
    const [siteOpsError, setSiteOpsError] = useState(false);

    // 첫 응답이 없을 때(다른 화면에 끼워 쓸 때)만 API 로 한 번 읽는다
    const loadDashboard = useCallback(async () => {
        setLoading(true);
        setError(null);

        try {
            // no-store: 공용 PC 에서 다른 역할이 받아 둔 응답을 다시 쓰지 않게(검수 S3)
            const res = await fetch("/api/admin/dashboard", { cache: "no-store" });
            if (!res.ok) throw new Error("Dashboard request failed");
            setData((await res.json()) as DashboardData);
        } catch {
            setError("failed");
        } finally {
            setLoading(false);
        }
    }, []);

    const loadSystemStatus = useCallback(async () => {
        setSystemError(false);
        setSystemLoading(true);

        try {
            const res = await fetch("/api/admin/dashboard/system");
            if (!res.ok) throw new Error("System status request failed");
            setSystemStatus((await res.json()) as SystemStatusData);
        } catch {
            setSystemError(true);
        } finally {
            setSystemLoading(false);
        }
    }, []);

    const runSiteOpsBot = useCallback(async () => {
        setSiteOpsError(false);
        setSiteOpsLoading(true);

        try {
            const res = await fetch("/api/admin/site-ops-bot", {
                method: "POST",
                cache: "no-store",
            });
            if (!res.ok) throw new Error("Site ops bot request failed");
            setSiteOpsResult((await res.json()) as SiteOpsBotResult);
        } catch {
            setSiteOpsError(true);
        } finally {
            setSiteOpsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (!hasInitialData || hydrateFullData) void loadDashboard();
    }, [hasInitialData, hydrateFullData, loadDashboard]);

    return (
        <div className="max-w-7xl mx-auto space-y-5">
            {/* 반복 방문에서는 설명보다 업무 제목과 바로 쓰는 두 동선이 먼저 보이게 한다. */}
            <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                    {/* AdminPageHeader 를 쓰지 않는 이유: tests/admin-work-navigation.test.mjs 가 @/components/* 를 빈 부품으로 바꿔 렌더해 «수업 진행» 링크가 사라진다 */}
                    <h1 className="academy-page-title">대시보드</h1>
                    {data?.todayLabel && <p className="academy-page-description">{data.todayLabel}</p>}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Link href="/admin/students" prefetch={false} className="academy-button-secondary">원생 찾기</Link>
                    <Link href="/staff" prefetch={false} className="academy-button-primary">수업 진행</Link>
                </div>
            </header>

            {summary && <DashboardSummaryCards summary={summary} />}
            {loading && !data && <DashboardPrimarySkeleton />}
            {!loading && !data && error && <ErrorState onRetry={() => void loadDashboard()} />}
            {data && (
                <DashboardContent
                    data={data}
                    inboxCounts={inboxCounts}
                    systemStatus={systemStatus}
                    systemLoading={systemLoading}
                    systemError={systemError}
                    siteOpsResult={siteOpsResult}
                    siteOpsLoading={siteOpsLoading}
                    siteOpsError={siteOpsError}
                    onRetrySystem={loadSystemStatus}
                    onRunSiteOpsBot={runSiteOpsBot}
                />
            )}
        </div>
    );
}

function DashboardContent({
    data,
    inboxCounts,
    systemStatus,
    systemLoading,
    systemError,
    siteOpsResult,
    siteOpsLoading,
    siteOpsError,
    onRetrySystem,
    onRunSiteOpsBot,
}: {
    data: DashboardData;
    inboxCounts: InboxCounts | null;
    systemStatus: SystemStatusData | null;
    systemLoading: boolean;
    systemError: boolean;
    siteOpsResult: SiteOpsBotResult | null;
    siteOpsLoading: boolean;
    siteOpsError: boolean;
    onRetrySystem: () => void;
    onRunSiteOpsBot: () => void;
}) {
    const { pendingRequests, enrollStats, todayClasses } = data;
    // «처리할 신청» 숫자 = 신청함 «처리 필요»와 같은 숫자(메뉴 배지와 일치). 못 읽었으면 옛 숫자(문의 대기)
    const pendingCount = inboxCounts ? inboxCounts.action : data.pendingCount;
    // 칩 = 신청함 6탭 배지 그대로(칩 합 = «처리할 신청» 숫자). 누르면 그 탭이 열린다
    const inboxTabs = inboxCounts ? INBOX_TABS.filter((entry) => inboxCounts.byTab[entry.tab] > 0) : [];
    // 요일 글은 서버가 KST 로 만들어 준다(브라우저 시계로 다시 계산하지 않는다)
    const todayLabel = data.todayLabel ?? "";

    return (
        <>
            {/* 초기 응답에 이미 포함된 수업은 상세 통계 조회를 기다리지 않는다. */}
            <div className={`grid items-start gap-3 ${pendingCount > 0 || enrollStats.PENDING > 0 ? "xl:grid-cols-2" : ""}`}>
            <section className="academy-panel overflow-hidden">
                <div className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${pendingCount > 0 ? "border-b border-[var(--color-academy-line)]" : ""}`}>
                    <h2 className="academy-section-title flex items-center gap-2">처리할 신청 <span className="academy-status">{pendingCount}건</span></h2>
                    <Link href="/admin/inbox" prefetch={false} className="text-sm font-medium text-[var(--color-academy-primary)]">전체 보기 →</Link>
                </div>
                {/* 탭별 건수 한 줄 — 누르면 신청함이 그 탭으로 열린다 */}
                {inboxTabs.length > 0 && (
                    <div className="flex flex-wrap gap-2 border-b border-[var(--color-academy-line)] px-4 py-2">
                        {inboxTabs.map((entry) => (
                            <Link key={entry.tab} href={`/admin/inbox?tab=${entry.tab}`} prefetch={false} className="academy-button-secondary academy-button-sm">
                                {entry.label} <span className="font-semibold tabular-nums">{inboxCounts?.byTab[entry.tab]}</span>
                            </Link>
                        ))}
                    </div>
                )}
                {pendingRequests.length > 0 ? (
                    <div className="divide-y divide-[var(--color-academy-line)]">
                        {pendingRequests.map((request) => (
                            <Link key={request.id} href="/admin/inbox?kind=PARENT_REQUEST" prefetch={false} className="flex items-center gap-3 px-5 py-4 transition hover:bg-[var(--color-academy-soft)]">
                                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--color-academy-primary-soft)] font-semibold text-[var(--color-academy-primary)]">{(request.studentName ?? request.parentName ?? "요청").slice(0, 1)}</span>
                                <div className="min-w-0 flex-1"><p className="truncate text-sm font-semibold text-[var(--color-academy-ink)]">{request.studentName ?? request.parentName ?? "학부모 요청"}</p><p className="mt-0.5 break-words text-sm text-[var(--color-academy-muted)]">{request.title}</p></div>
                                <span className="shrink-0 text-xs font-medium text-[var(--color-academy-warning)]">미처리</span>
                            </Link>
                        ))}
                    </div>
                ) : pendingCount > 0 && inboxTabs.length === 0 ? <p className="px-4 py-3 text-sm text-[var(--color-academy-muted)]">요청 목록에서 처리할 내용을 확인하세요.</p> : null}
                {enrollStats.PENDING > 0 && <Link href="/admin/inbox?tab=ENROLL" prefetch={false} className="flex items-center justify-between gap-3 border-t border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-5 py-3 text-sm font-medium text-[var(--color-academy-primary)]"><span>수강 신청 대기 {enrollStats.PENDING}건</span><span>확인하기 →</span></Link>}
            </section>
                <TodayClassesCard todayClasses={todayClasses} todayLabel={todayLabel} />
            </div>

            {/* 펼치기는 표시만 바꾼다. 조회와 조치는 각 도구의 명시적 버튼에서만 실행한다. */}
            <details className="academy-panel px-4 py-2">
                <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-[var(--color-academy-ink)]">관리 도구</summary>
                <div className="mt-5 grid items-start gap-4 lg:grid-cols-2">
                    <SiteOpsBotCard result={siteOpsResult} loading={siteOpsLoading} error={siteOpsError} onRun={onRunSiteOpsBot} />
                    <SystemStatusCard systemStatus={systemStatus} systemLoading={systemLoading} systemError={systemError} onRetry={onRetrySystem} />
                </div>
            </details>
        </>
    );
}

function TodayClassesCard({ todayClasses, todayLabel }: { todayClasses: TodayClass[]; todayLabel: string }) {
    return (
        <section className="academy-panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-academy-line)] px-5 py-4">
                <h2 className="academy-section-title">오늘의 수업</h2>
                <span className="text-xs text-[var(--color-academy-muted)]">{todayLabel}</span>
            </div>
            {todayClasses.length === 0 ? <p className="px-5 py-6 text-sm text-[var(--color-academy-muted)]">오늘은 수업이 없습니다.</p> : (
                <div className="divide-y divide-[var(--color-academy-line)]">
                    {todayClasses.map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-3 px-5 py-4">
                            <div className="min-w-0">
                                <p className="break-words text-sm font-semibold text-[var(--color-academy-ink)]">{item.name}</p>
                                <p className="mt-0.5 text-sm text-[var(--color-academy-muted)]">{item.startTime ?? "시간 미정"}{item.endTime ? `–${item.endTime}` : ""}{item.programName ? ` · ${item.programName}` : ""}</p>
                            </div>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs tabular-nums ${item.enrolled >= item.capacity ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" : "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"}`}>{item.enrolled}/{item.capacity}명</span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}

function SiteOpsBotCard({
    result,
    loading,
    error,
    onRun,
}: {
    result: SiteOpsBotResult | null;
    loading: boolean;
    error: boolean;
    onRun: () => void;
}) {
    const attentionItems = result?.checks.filter((check) => check.status === "warning" || check.status === "critical") ?? [];
    const fixedItems = result?.checks.filter((check) => check.status === "fixed") ?? [];
    const previewItems = attentionItems.length > 0 ? attentionItems.slice(0, 3) : fixedItems.slice(0, 2);
    const statusLabel = !result
        ? "미점검"
        : result.ok
            ? result.fixedCount > 0 ? "자동 조치 완료" : "정상"
            : result.criticalCount > 0 ? "긴급 확인" : "확인 필요";
    const statusClass = !result
        ? "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]"
        : result.ok
            ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
            : result.criticalCount > 0
                ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                : "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]";

    return (
        <div className="academy-panel p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                    <h3 className="academy-section-title">사이트 점검 봇</h3>
                    {/* 마지막 점검 시각은 실제 점검 결과가 있을 때만 표시한다 */}
                    {result && (
                        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">
                            {new Date(result.checkedAt).toLocaleString("ko-KR")}
                        </p>
                    )}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusClass}`}>
                    {loading ? "점검 중" : statusLabel}
                </span>
            </div>

            <button
                type="button"
                onClick={onRun}
                disabled={loading}
                className="academy-button-secondary mb-3 w-full"
            >
                {loading ? "점검 중" : "점검 실행"}
            </button>

            {error && (
                <p className="mb-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-xs font-medium text-[var(--color-academy-danger)]">
                    점검을 실행하지 못했습니다. 잠시 후 다시 시도해주세요.
                </p>
            )}

            {!result && !error && (
                <p className="rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-xs text-[var(--color-academy-muted)]">
                    사이트 운영 상태, 백업, 신청 링크, 인스타 게시 대기열을 확인합니다.
                </p>
            )}

            {result && (
                <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-lg bg-[var(--color-academy-soft)] px-2 py-2">
                            <p className="font-semibold tabular-nums text-[var(--color-academy-ink)]">{result.checks.length}</p>
                            <p className="text-[var(--color-academy-muted)]">점검</p>
                        </div>
                        <div className="rounded-lg bg-[var(--color-academy-success-soft)] px-2 py-2">
                            <p className="font-semibold tabular-nums text-[var(--color-academy-success)]">{result.fixedCount}</p>
                            <p className="text-[var(--color-academy-success)]/70">자동조치</p>
                        </div>
                        <div className="rounded-lg bg-[var(--color-academy-warning-soft)] px-2 py-2">
                            <p className="font-semibold tabular-nums text-[var(--color-academy-warning)]">{result.manualActionCount}</p>
                            <p className="text-[var(--color-academy-warning)]/70">확인</p>
                        </div>
                    </div>

                    {previewItems.length === 0 ? (
                        <p className="rounded-lg bg-[var(--color-academy-success-soft)] px-3 py-2 text-xs text-[var(--color-academy-success)]">
                            현재 수동 조치가 필요한 항목은 없습니다.
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {previewItems.map((item) => (
                                <div key={item.id} className="rounded-lg border border-[var(--color-academy-line)] px-3 py-2">
                                    <div className="flex items-start justify-between gap-2">
                                        <div>
                                            <p className="text-xs font-semibold text-[var(--color-academy-ink)]">{item.label}</p>
                                            <p className="mt-0.5 text-xs text-[var(--color-academy-muted)]">{item.message}</p>
                                        </div>
                                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-xs ${
                                            item.status === "critical"
                                                ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                                                : item.status === "fixed"
                                                    ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                                                    : "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]"
                                        }`}>
                                            {item.status === "critical" ? "긴급" : item.status === "fixed" ? "완료" : "확인"}
                                        </span>
                                    </div>
                                    {item.actionHref && item.actionLabel && (
                                        <Link href={item.actionHref} prefetch={false} className="mt-2 inline-flex text-xs font-medium text-[var(--color-academy-primary)]">
                                            {item.actionLabel} &rarr;
                                        </Link>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function SystemStatusCard({
    systemStatus,
    systemLoading,
    systemError,
    onRetry,
}: {
    systemStatus: SystemStatusData | null;
    systemLoading: boolean;
    systemError: boolean;
    onRetry: () => void;
}) {
    const backup = systemStatus?.backup;
    const lastBackupAt = backup?.lastBackupAt ? new Date(backup.lastBackupAt) : null;
    const now = new Date();
    const backupAgeMs = lastBackupAt ? now.getTime() - lastBackupAt.getTime() : Infinity;
    const backupAgeDays = Math.floor(backupAgeMs / (1000 * 60 * 60 * 24));
    const backupAgeHours = Math.floor(backupAgeMs / (1000 * 60 * 60));
    const backupWarn = Boolean(systemStatus && backupAgeMs > 2 * 24 * 60 * 60 * 1000);
    const backupDanger = Boolean(systemStatus && backupAgeMs > 7 * 24 * 60 * 60 * 1000);

    function backupLabel() {
        if (!lastBackupAt) return "백업 없음";
        if (backupAgeHours < 1) return "방금 전";
        if (backupAgeHours < 24) return `${backupAgeHours}시간 전`;
        return `${backupAgeDays}일 전`;
    }

    return (
        <div className="academy-panel p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="academy-section-title">시스템 상태</h3>
                <button
                    type="button"
                    onClick={onRetry}
                    disabled={systemLoading}
                    className="academy-button-tonal academy-button-sm shrink-0"
                >
                    {systemLoading ? "확인 중" : systemError ? "다시 시도" : systemStatus ? "새로고침" : "확인"}
                </button>
            </div>
            <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                    <span className="text-sm text-[var(--color-academy-muted)]">자료 저장소</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                        !systemStatus ? "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" : systemStatus.dbOk ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]" : "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                    }`}>
                        {systemLoading ? "확인 중" : !systemStatus ? "미확인" : systemStatus.dbOk ? "정상" : "오류"}
                    </span>
                </div>
                <div className="flex items-center justify-between">
                    <span className="text-sm text-[var(--color-academy-muted)]">마지막 백업</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${!systemStatus ? "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]" : backupDanger ? "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]" : backupWarn ? "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]" : "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"}`}>
                        {systemLoading ? "확인 중" : !systemStatus ? "미확인" : backupLabel()}
                    </span>
                </div>
                {backup && backup.backupCount > 0 && (
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-[var(--color-academy-muted)]">저장된 백업</span>
                        <span className="text-xs text-[var(--color-academy-muted)]">{backup.backupCount}개</span>
                    </div>
                )}
                {backup?.archive && (
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-[var(--color-academy-muted)]">담긴 업무 자료</span>
                        <span className={`text-xs ${backup.archive.complete ? "text-[var(--color-academy-muted)]" : "font-semibold text-[var(--color-academy-warning)]"}`}>
                            표 {backup.archive.tables}개 · {backup.archive.rows.toLocaleString("ko-KR")}줄
                            {typeof backup.lastBackupBytes === "number" ? ` · ${(backup.lastBackupBytes / 1024 / 1024).toFixed(1)}MB` : ""}
                            {backup.archive.complete ? "" : " · 일부 누락"}
                        </span>
                    </div>
                )}
                {systemStatus && backupDanger && (
                    <p className="text-xs text-[var(--color-academy-danger)] bg-[var(--color-academy-danger-soft)] rounded-lg px-3 py-2">
                        7일 이상 백업이 없습니다. 사이드바에서 즉시 저장하세요.
                    </p>
                )}
            </div>
        </div>
    );
}
