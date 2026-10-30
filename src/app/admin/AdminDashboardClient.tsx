"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";

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
    extendedStats: ExtendedStats;
    todayClasses: TodayClass[];
    recentStudents: RecentStudent[];
    todayLabel?: string;
};

type SystemStatusData = {
    dbOk: boolean;
    backup: {
        lastBackupAt: string | null;
        backupCount: number;
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

function formatKRW(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}만원`;
    return n.toLocaleString("ko-KR") + "원";
}

function DashboardPrimarySkeleton() {
    return (
        <div className="grid gap-4 lg:grid-cols-2" aria-label="오늘 업무 불러오는 중" role="status">
            {[0, 1].map((item) => (
                <div key={item} className="academy-panel p-5 animate-pulse">
                    <div className="mb-5 h-4 w-28 rounded bg-gray-200" />
                    <div className="mb-3 h-4 w-3/4 rounded bg-gray-100" />
                    <div className="h-4 w-1/2 rounded bg-gray-100" />
                </div>
            ))}
        </div>
    );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-100 bg-white p-8 text-center shadow-sm dark:border-red-900/40 dark:bg-gray-800">
            <SymbolIcon name="error" size={36} className="mx-auto mb-3 text-red-500" />
            <p className="font-bold text-gray-900 dark:text-white">대시보드 데이터를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="mt-4 rounded-xl academy-button-primary px-4 py-2 text-sm font-bold dark:bg-brand-neon-lime dark:text-brand-navy-900"
            >
                다시 시도
            </button>
        </div>
    );
}

export default function AdminDashboardClient({
    initialData,
    hydrateFullData = false,
}: {
    initialData?: DashboardData;
    hydrateFullData?: boolean;
}) {
    const hasInitialData = initialData !== undefined;
    const [data, setData] = useState<DashboardData | null>(initialData ?? null);
    const [loading, setLoading] = useState(!hasInitialData);
    const [error, setError] = useState<string | null>(null);
    const [detailsLoaded, setDetailsLoaded] = useState(!hasInitialData);
    const [detailsLoading, setDetailsLoading] = useState(false);
    const [systemStatus, setSystemStatus] = useState<SystemStatusData | null>(null);
    const [systemLoading, setSystemLoading] = useState(false);
    const [systemError, setSystemError] = useState(false);
    const [siteOpsResult, setSiteOpsResult] = useState<SiteOpsBotResult | null>(null);
    const [siteOpsLoading, setSiteOpsLoading] = useState(false);
    const [siteOpsError, setSiteOpsError] = useState(false);

    const loadDashboard = useCallback(async (showSkeleton = true) => {
        if (showSkeleton) setLoading(true);
        else setDetailsLoading(true);
        setError(null);

        try {
            const res = await fetch("/api/admin/dashboard");
            if (!res.ok) throw new Error("Dashboard request failed");
            setData((await res.json()) as DashboardData);
            setDetailsLoaded(true);
        } catch {
            setError("failed");
        } finally {
            if (showSkeleton) setLoading(false);
            else setDetailsLoading(false);
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
        if (!hasInitialData) {
            void loadDashboard(true);
            return;
        }
        if (!hydrateFullData) return;

        const timer = window.setTimeout(() => {
            void loadDashboard(false);
        }, 1200);

        return () => window.clearTimeout(timer);
    }, [hasInitialData, hydrateFullData, loadDashboard]);

    return (
        <div className="max-w-7xl mx-auto space-y-5">
            {/* 반복 방문에서는 설명보다 업무 제목과 바로 쓰는 두 동선이 먼저 보이게 한다. */}
            <header className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h1 className="academy-heading">오늘의 업무</h1>
                    {data?.todayLabel && <p className="text-sm text-[var(--color-academy-muted)]">{data.todayLabel}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                    <Link href="/admin/students" prefetch={false} className="academy-button-secondary">원생 찾기</Link>
                    <Link href="/staff" prefetch={false} className="academy-button-primary">수업 진행</Link>
                </div>
            </header>

            {loading && !data && <DashboardPrimarySkeleton />}
            {!loading && !data && error && <ErrorState onRetry={() => void loadDashboard(true)} />}
            {data && (
                <DashboardContent
                    data={data}
                    systemStatus={systemStatus}
                    systemLoading={systemLoading}
                    systemError={systemError}
                    siteOpsResult={siteOpsResult}
                    siteOpsLoading={siteOpsLoading}
                    siteOpsError={siteOpsError}
                    detailsLoaded={detailsLoaded}
                    detailsLoading={detailsLoading}
                    detailsError={Boolean(error)}
                    onLoadDetails={() => void loadDashboard(false)}
                    onRetrySystem={loadSystemStatus}
                    onRunSiteOpsBot={runSiteOpsBot}
                />
            )}
        </div>
    );
}

function DashboardContent({
    data,
    systemStatus,
    systemLoading,
    systemError,
    siteOpsResult,
    siteOpsLoading,
    siteOpsError,
    detailsLoaded,
    detailsLoading,
    detailsError,
    onLoadDetails,
    onRetrySystem,
    onRunSiteOpsBot,
}: {
    data: DashboardData;
    systemStatus: SystemStatusData | null;
    systemLoading: boolean;
    systemError: boolean;
    siteOpsResult: SiteOpsBotResult | null;
    siteOpsLoading: boolean;
    siteOpsError: boolean;
    detailsLoaded: boolean;
    detailsLoading: boolean;
    detailsError: boolean;
    onLoadDetails: () => void;
    onRetrySystem: () => void;
    onRunSiteOpsBot: () => void;
}) {
    const { stats, pendingRequests, pendingCount, enrollStats, extendedStats, todayClasses, recentStudents } = data;
    const revDiff = extendedStats.lastMonthRevenue > 0
        ? Math.round(((extendedStats.thisMonthRevenue - extendedStats.lastMonthRevenue) / extendedStats.lastMonthRevenue) * 100)
        : extendedStats.thisMonthRevenue > 0 ? 100 : 0;
    const maxRevenue = Math.max(...extendedStats.monthlyRevenue.map((m) => m.amount), 1);
    const dayLabels: Record<string, string> = { Sun: "일", Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토" };
    const todayLabel = data.todayLabel ?? `${dayLabels[["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date().getDay()]]}요일`;

    return (
        <>
            {/* 초기 응답에 이미 포함된 수업은 상세 통계 조회를 기다리지 않는다. */}
            <div className={`grid items-start gap-3 ${pendingCount > 0 || enrollStats.PENDING > 0 ? "xl:grid-cols-2" : ""}`}>
            <section className="academy-panel overflow-hidden">
                <div className={`flex flex-wrap items-center justify-between gap-3 px-4 py-3 ${pendingCount > 0 ? "border-b border-[var(--color-academy-line)]" : ""}`}>
                    <h2 className="academy-section-title flex items-center gap-2"><SymbolIcon name="inbox" />처리할 요청 <span className="academy-status">{pendingCount}건</span></h2>
                    <Link href="/admin/requests" prefetch={false} className="text-sm font-bold text-[var(--color-academy-primary)]">전체 보기 →</Link>
                </div>
                {detailsLoaded && pendingRequests.length > 0 ? (
                    <div className="divide-y divide-[var(--color-academy-line)]">
                        {pendingRequests.map((request) => (
                            <Link key={request.id} href="/admin/requests" prefetch={false} className="flex items-center gap-3 px-5 py-4 transition hover:bg-[var(--color-academy-soft)]">
                                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[var(--color-academy-primary-soft)] font-bold text-[var(--color-academy-primary)]">{(request.studentName ?? request.parentName ?? "요청").slice(0, 1)}</span>
                                <div className="min-w-0 flex-1"><p className="truncate text-sm font-bold text-[var(--color-academy-ink)]">{request.studentName ?? request.parentName ?? "학부모 요청"}</p><p className="mt-0.5 break-words text-sm text-[var(--color-academy-muted)]">{request.title}</p></div>
                                <span className="shrink-0 text-xs font-bold text-[var(--color-academy-warning)]">미처리</span>
                                <SymbolIcon name="chevron_right" className="shrink-0 text-[var(--color-academy-muted)]" />
                            </Link>
                        ))}
                    </div>
                ) : pendingCount > 0 ? <p className="px-4 py-3 text-sm text-[var(--color-academy-muted)]">요청 목록에서 처리할 내용을 확인하세요.</p> : null}
                {enrollStats.PENDING > 0 && <Link href="/admin/apply" prefetch={false} className="flex items-center justify-between gap-3 border-t border-[var(--color-academy-line)] bg-[var(--color-academy-primary-soft)] px-5 py-3 text-sm font-bold text-[var(--color-academy-primary)]"><span>수강 신청 대기 {enrollStats.PENDING}건</span><span>확인하기 →</span></Link>}
            </section>
                <TodayClassesCard todayClasses={todayClasses} todayLabel={todayLabel} />
            </div>

            <div className="grid items-start gap-2 sm:grid-cols-2">
            <details className="academy-panel px-4 py-2 [&[open]]:col-span-full">
                <summary className="min-h-11 cursor-pointer content-center text-sm font-bold text-[var(--color-academy-ink)]">운영 현황</summary>
                <div className="mt-5 space-y-5">
                    {/* 미조회 값의 0과 빈 배열은 실제 현황으로 보여주지 않는다. */}
                    {detailsError && <p role="alert" className="rounded-xl bg-[var(--color-academy-danger-soft)] px-4 py-3 text-sm text-[var(--color-academy-danger)]">상세 운영 현황을 불러오지 못했습니다. 현재 표시 중인 정보는 유지됩니다. 다시 불러와 주세요.</p>}
                    {(!detailsLoaded || detailsError) && <DeferredDetailsCard loading={detailsLoading} onLoad={onLoadDetails} retry={detailsError} />}
                    {detailsLoaded && <>
            {/* 게슈탈트 A-14: 두 카드 줄이 한 덩어리로 읽히지 않게 줄마다 소제목을 단다. 아이콘 색은 한 가지(muted) */}
            <h3 className="mb-2 text-xs font-bold text-[var(--color-academy-muted)]">운영 규모</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard title="등록 원생" value={`${stats.studentCount}명`}
                    icon={<SymbolIcon name="groups" size={20} className="text-[var(--color-academy-muted)]" />} href="/admin/students" />
                <StatCard title="운영 프로그램" value={`${stats.programCount}개`}
                    icon={<SymbolIcon name="menu_book" size={20} className="text-[var(--color-academy-muted)]" />} href="/admin/programs" />
                <StatCard title="코치/강사진" value={`${stats.coachCount}명`}
                    icon={<SymbolIcon name="person_check" size={20} className="text-[var(--color-academy-muted)]" />} href="/admin/coaches" />
                <StatCard title="개설 반" value={`${stats.classCount}개`}
                    icon={<SymbolIcon name="layers" size={20} className="text-[var(--color-academy-muted)]" />} href="/admin/classes" />
            </div>

            <h3 className="mb-2 mt-6 text-xs font-bold text-[var(--color-academy-muted)]">이번 달 매출·출석·미납</h3>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="academy-panel p-4">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">이번 달 매출</p>
                    <h3 className="text-2xl font-extrabold text-gray-900 dark:text-white">{formatKRW(extendedStats.thisMonthRevenue)}</h3>
                    {extendedStats.lastMonthRevenue > 0 && (
                        <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${revDiff >= 0 ? "text-green-600" : "text-red-600"}`}>
                            <SymbolIcon name={revDiff > 0 ? "trending_up" : revDiff < 0 ? "trending_down" : "remove"} size={14} />
                            전월 대비 {revDiff > 0 ? "+" : ""}{revDiff}%
                        </div>
                    )}
                </div>
                <div className="academy-panel p-4">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">이번 달 출석률</p>
                    <h3 className="text-2xl font-extrabold text-gray-900 dark:text-white">{extendedStats.attendanceRate}%</h3>
                </div>
                <Link href="/admin/finance" prefetch={false} className="academy-panel p-4 hover:border-red-200 transition">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">미납 현황</p>
                    <h3 className={`text-2xl font-extrabold ${extendedStats.unpaidCount > 0 ? "text-red-600" : "text-gray-900 dark:text-white"}`}>
                        {extendedStats.unpaidCount}건
                    </h3>
                    {extendedStats.unpaidAmount > 0 && (
                        <p className="text-xs text-red-500 mt-1 flex items-center gap-1">
                            <SymbolIcon name="warning" size={12} /> {formatKRW(extendedStats.unpaidAmount)}
                        </p>
                    )}
                </Link>
                <div className="academy-panel p-4">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">전월 매출</p>
                    <h3 className="text-2xl font-extrabold text-gray-900 dark:text-white">{formatKRW(extendedStats.lastMonthRevenue)}</h3>
                </div>
            </div>

            <Link href="/admin/stats" prefetch={false} className="flex items-center justify-between bg-[var(--color-academy-primary-soft)] border border-[var(--color-academy-line)] rounded-2xl p-4 hover:opacity-90 transition shadow-sm">
                <div className="flex items-center gap-3">
                    <SymbolIcon name="monitoring" size={28} className="text-[var(--color-academy-primary)]" />
                    <div>
                        <p className="font-bold text-[var(--color-academy-primary)]">상세 운영 통계</p>
                    </div>
                </div>
                <span className="text-[var(--color-academy-primary)] text-sm font-bold">보러가기 &rarr;</span>
            </Link>

            <ChartsSection extendedStats={extendedStats} maxRevenue={maxRevenue} />


                        <div className="grid items-start gap-4 lg:grid-cols-2">
                            <ProgramStudentsCard programStudents={extendedStats.programStudents} />
                            <RecentStudentsCard recentStudents={recentStudents} />
                        </div>
                    </>}
                </div>
            </details>

            {/* 펼치기는 표시만 바꾼다. 조회와 조치는 각 도구의 명시적 버튼에서만 실행한다. */}
            <details className="academy-panel px-4 py-2 [&[open]]:col-span-full">
                <summary className="min-h-11 cursor-pointer content-center text-sm font-bold text-[var(--color-academy-ink)]">관리 도구</summary>
                <div className="mt-5 grid items-start gap-4 lg:grid-cols-2">
                    <SiteOpsBotCard result={siteOpsResult} loading={siteOpsLoading} error={siteOpsError} onRun={onRunSiteOpsBot} />
                    <SystemStatusCard systemStatus={systemStatus} systemLoading={systemLoading} systemError={systemError} onRetry={onRetrySystem} />
                </div>
            </details>
            </div>
        </>
    );
}

function DeferredDetailsCard({ loading, onLoad, retry }: { loading: boolean; onLoad: () => void; retry: boolean }) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-[var(--color-academy-muted)]">매출·출석 추이와 최근 등록 원생은 조회 후 표시합니다.</p>
            <button type="button" onClick={onLoad} disabled={loading} className="academy-button-secondary disabled:cursor-wait disabled:opacity-60">
                <SymbolIcon name={loading ? "sync" : "download"} size={18} />
                {loading ? "불러오는 중" : retry ? "상세 데이터 다시 불러오기" : "상세 데이터 불러오기"}
            </button>
        </div>
    );
}

function ChartsSection({ extendedStats, maxRevenue }: { extendedStats: ExtendedStats; maxRevenue: number }) {
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="academy-panel p-5">
                <h3 className="font-bold text-gray-900 dark:text-white mb-4">매출 추이 (최근 6개월)</h3>
                <div className="flex items-end gap-2 h-40">
                    {extendedStats.monthlyRevenue.map((m, i) => (
                        <div key={i} className="flex-1 flex flex-col items-center gap-1">
                            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                                {m.amount > 0 ? formatKRW(m.amount) : ""}
                            </span>
                            <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-t-lg relative" style={{ height: "120px" }}>
                                <div
                                    className="absolute bottom-0 left-0 right-0 bg-[var(--color-academy-primary)] dark:bg-brand-neon-lime dark:text-brand-navy-900 rounded-t-lg transition-all duration-500"
                                    style={{ height: `${maxRevenue > 0 ? (m.amount / maxRevenue) * 100 : 0}%` }}
                                />
                            </div>
                            <span className="text-xs text-gray-400">{m.month}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="academy-panel p-5">
                <h3 className="font-bold text-gray-900 dark:text-white mb-4">출석률 추이 (최근 6개월)</h3>
                <div className="flex items-end gap-2 h-40">
                    {extendedStats.monthlyAttendance.map((m, i) => (
                        <div key={i} className="flex-1 flex flex-col items-center gap-1">
                            <span className="text-xs text-gray-500 dark:text-gray-400 font-medium">
                                {m.rate > 0 ? `${m.rate}%` : ""}
                            </span>
                            <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-t-lg relative" style={{ height: "120px" }}>
                                <div
                                    className="absolute bottom-0 left-0 right-0 bg-emerald-500 rounded-t-lg transition-all duration-500"
                                    style={{ height: `${m.rate}%` }}
                                />
                            </div>
                            <span className="text-xs text-gray-400">{m.month}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

function TodayClassesCard({ todayClasses, todayLabel }: { todayClasses: TodayClass[]; todayLabel: string }) {
    return (
        <section className="academy-panel overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-academy-line)] px-5 py-4">
                <h2 className="academy-section-title flex items-center gap-2"><SymbolIcon name="event_available" />오늘의 수업</h2>
                <span className="text-xs text-[var(--color-academy-muted)]">{todayLabel}</span>
            </div>
            {todayClasses.length === 0 ? <p className="px-5 py-6 text-sm text-[var(--color-academy-muted)]">오늘은 수업이 없습니다.</p> : (
                <div className="divide-y divide-[var(--color-academy-line)]">
                    {todayClasses.map((item) => (
                        <div key={item.id} className="flex items-center justify-between gap-3 px-5 py-4">
                            <div className="min-w-0">
                                <p className="break-words text-sm font-bold text-[var(--color-academy-ink)]">{item.name}</p>
                                <p className="mt-0.5 text-sm text-[var(--color-academy-muted)]">{item.startTime ?? "시간 미정"}{item.endTime ? `–${item.endTime}` : ""}{item.programName ? ` · ${item.programName}` : ""}</p>
                            </div>
                            <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${item.enrolled >= item.capacity ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"}`}>{item.enrolled}/{item.capacity}명</span>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
}

function RecentStudentsCard({ recentStudents }: { recentStudents: RecentStudent[] }) {
    return (
        <div className="academy-panel p-5">
            <h3 className="academy-section-title mb-4">신규 원생 (최근 7일)</h3>
            {recentStudents.length === 0 ? <p className="text-sm text-[var(--color-academy-muted)]">최근 등록된 원생이 없습니다.</p> : (
                <div className="divide-y divide-[var(--color-academy-line)]">
                    {recentStudents.map((student) => (
                        <Link key={student.id} href={`/admin/students/${student.id}`} prefetch={false} className="flex items-center justify-between gap-3 rounded-lg py-3 transition hover:bg-[var(--color-academy-soft)]">
                            <div className="min-w-0"><p className="break-words text-sm font-bold">{student.name}</p><p className="text-xs text-[var(--color-academy-muted)]">학부모: {student.parentName ?? "-"}</p></div>
                            <span className="shrink-0 text-xs text-[var(--color-academy-muted)]">{new Date(student.createdAt).toLocaleDateString("ko-KR", { month: "short", day: "numeric" })}</span>
                        </Link>
                    ))}
                </div>
            )}
        </div>
    );
}

function ProgramStudentsCard({ programStudents }: { programStudents: { name: string; count: number }[] }) {
    const maxCnt = Math.max(...programStudents.map((item) => item.count), 1);

    return (
        <div className="academy-panel p-5">
            <h3 className="font-bold text-gray-900 dark:text-white mb-4">프로그램별 원생 수</h3>
            {programStudents.length === 0 ? (
                <p className="text-sm text-gray-400">프로그램을 추가하세요</p>
            ) : (
                <div className="space-y-3">
                    {programStudents.map((program, index) => (
                        <div key={index}>
                            <div className="flex justify-between text-sm mb-1">
                                <span className="text-gray-700 dark:text-gray-200 font-medium truncate">{program.name}</span>
                                <span className="text-gray-500 dark:text-gray-400 font-bold">{program.count}명</span>
                            </div>
                            <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-2">
                                <div
                                    className="bg-blue-500 h-2 rounded-full transition-all duration-500"
                                    style={{ width: `${(program.count / maxCnt) * 100}%` }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
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
        ? "bg-gray-100 text-gray-600 dark:bg-gray-900 dark:text-gray-300"
        : result.ok
            ? "bg-green-100 text-green-700"
            : result.criticalCount > 0
                ? "bg-red-100 text-red-700"
                : "bg-yellow-100 text-yellow-700";

    return (
        <div className="academy-panel p-4">
            <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                    <h3 className="font-bold text-gray-900 dark:text-white">사이트 점검 봇</h3>
                    {/* 마지막 점검 시각은 실제 점검 결과가 있을 때만 표시한다 */}
                    {result && (
                        <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                            {new Date(result.checkedAt).toLocaleString("ko-KR")}
                        </p>
                    )}
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-bold ${statusClass}`}>
                    {loading ? "점검 중" : statusLabel}
                </span>
            </div>

            <button
                type="button"
                onClick={onRun}
                disabled={loading}
                className="mb-3 inline-flex w-full items-center justify-center gap-2 rounded-xl academy-button-primary px-4 py-2 text-sm font-bold disabled:cursor-wait disabled:opacity-60 dark:bg-brand-neon-lime dark:text-brand-navy-900"
            >
                <SymbolIcon name={loading ? "sync" : "smart_toy"} size={18} />
                {loading ? "점검 중" : "점검 실행"}
            </button>

            {error && (
                <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-medium text-red-700">
                    점검을 실행하지 못했습니다. 잠시 후 다시 시도해주세요.
                </p>
            )}

            {!result && !error && (
                <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                    사이트 운영 상태, 백업, 신청 링크, 인스타 게시 대기열을 확인합니다.
                </p>
            )}

            {result && (
                <div className="space-y-2">
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                        <div className="rounded-lg bg-gray-50 px-2 py-2 dark:bg-gray-900">
                            <p className="font-bold text-gray-900 dark:text-white">{result.checks.length}</p>
                            <p className="text-gray-500 dark:text-gray-400">점검</p>
                        </div>
                        <div className="rounded-lg bg-green-50 px-2 py-2">
                            <p className="font-bold text-green-700">{result.fixedCount}</p>
                            <p className="text-green-700/70">자동조치</p>
                        </div>
                        <div className="rounded-lg bg-yellow-50 px-2 py-2">
                            <p className="font-bold text-yellow-700">{result.manualActionCount}</p>
                            <p className="text-yellow-700/70">확인</p>
                        </div>
                    </div>

                    {previewItems.length === 0 ? (
                        <p className="rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700">
                            현재 수동 조치가 필요한 항목은 없습니다.
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {previewItems.map((item) => (
                                <div key={item.id} className="rounded-lg border border-gray-100 px-3 py-2 dark:border-gray-700">
                                    <div className="flex items-start justify-between gap-2">
                                        <div>
                                            <p className="text-xs font-bold text-gray-900 dark:text-white">{item.label}</p>
                                            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{item.message}</p>
                                        </div>
                                        <span className={`rounded-full px-1.5 py-0.5 text-xs font-bold ${
                                            item.status === "critical"
                                                ? "bg-red-100 text-red-700"
                                                : item.status === "fixed"
                                                    ? "bg-green-100 text-green-700"
                                                    : "bg-yellow-100 text-yellow-700"
                                        }`}>
                                            {item.status === "critical" ? "긴급" : item.status === "fixed" ? "완료" : "확인"}
                                        </span>
                                    </div>
                                    {item.actionHref && item.actionLabel && (
                                        <Link href={item.actionHref} prefetch={false} className="mt-2 inline-flex text-xs font-bold text-[var(--color-academy-primary)] dark:text-brand-neon-lime">
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
            <div className="mb-3 flex items-center justify-between">
                <h3 className="font-bold text-gray-900 dark:text-white">시스템 상태</h3>
                <button
                    type="button"
                    onClick={onRetry}
                    disabled={systemLoading}
                    className="text-xs font-bold text-[var(--color-academy-primary)] transition hover:text-orange-600 disabled:cursor-wait disabled:opacity-60 dark:text-brand-neon-lime"
                >
                    {systemLoading ? "확인 중" : systemError ? "다시 시도" : systemStatus ? "새로고침" : "확인"}
                </button>
            </div>
            <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                        <SymbolIcon name="database" size={14} className="text-gray-400" />
                        <span>데이터베이스</span>
                    </div>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                        !systemStatus ? "bg-gray-100 text-gray-500" : systemStatus.dbOk ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                    }`}>
                        {systemLoading ? "확인 중" : !systemStatus ? "미확인" : systemStatus.dbOk ? "정상" : "오류"}
                    </span>
                </div>
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                        <SymbolIcon name={backupWarn ? "cloud_off" : "cloud_done"} size={14} className={!systemStatus ? "text-gray-400" : backupDanger ? "text-red-500" : backupWarn ? "text-yellow-500" : "text-blue-500"} />
                        <span>마지막 백업</span>
                    </div>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${!systemStatus ? "bg-gray-100 text-gray-500" : backupDanger ? "bg-red-100 text-red-700" : backupWarn ? "bg-yellow-100 text-yellow-700" : "bg-green-100 text-green-700"}`}>
                        {systemLoading ? "확인 중" : !systemStatus ? "미확인" : backupLabel()}
                    </span>
                </div>
                {backup && backup.backupCount > 0 && (
                    <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-500 dark:text-gray-400">저장된 백업</span>
                        <span className="text-xs text-gray-500 dark:text-gray-400">{backup.backupCount}개</span>
                    </div>
                )}
                {systemStatus && backupDanger && (
                    <p className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
                        7일 이상 백업이 없습니다. 사이드바에서 즉시 저장하세요.
                    </p>
                )}
            </div>
        </div>
    );
}

function StatCard({ title, value, icon, href }: {
    title: string;
    value: string;
    icon: ReactNode;
    href?: string;
}) {
    const content = (
        <div className={`academy-panel p-4 ${href ? "hover:border-[var(--color-academy-primary)] dark:border-brand-neon-lime transition-colors cursor-pointer" : ""}`}>
            <div className="flex justify-between items-start">
                <div>
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{title}</p>
                    <h3 className="text-2xl font-extrabold text-gray-900 dark:text-white">{value}</h3>
                </div>
                <div className="p-2.5 bg-gray-50 dark:bg-gray-900 rounded-xl">{icon}</div>
            </div>
        </div>
    );
    if (href) return <Link href={href} prefetch={false}>{content}</Link>;
    return content;
}
