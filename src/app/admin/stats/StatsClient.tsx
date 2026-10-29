"use client";

import { useCallback, useEffect, useState } from "react";
import LineChart from "@/components/charts/LineChart";
import BarChart from "@/components/charts/BarChart";
import DonutChart from "@/components/charts/DonutChart";

// ── 타입 정의 ────────────────────────────────────────────────────────────────

interface MonthlyRevenue {
    month: string;
    label: string;
    amount: number;
    count: number;
}

interface MonthlyAttendance {
    month: string;
    label: string;
    rate: number;
    total: number;
    present: number;
}

interface EnrollmentTrend {
    month: string;
    label: string;
    newCount: number;
    dropCount: number;
}

interface ClassCapacity {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    capacity: number;
    enrolled: number;
    remaining: number;
    waiting: number;
}

interface TrialStats {
    NEW: number;
    CONTACTED: number;
    SCHEDULED: number;
    ATTENDED: number;
    CONVERTED: number;
    LOST: number;
    total: number;
    conversionRate: number;
}

interface CoachWorkload {
    id: string;
    name: string;
    imageUrl: string | null;
    classCount: number;
    studentCount: number;
}

interface CollectionRate {
    total: number;
    paid: number;
    unpaid: number;
    rate: number;
}

interface StatsPayload {
    monthlyRevenue: MonthlyRevenue[];
    monthlyAttendance: MonthlyAttendance[];
    enrollmentTrend: EnrollmentTrend[];
    classCapacity: ClassCapacity[];
    trialStats: TrialStats;
    coachWorkload: CoachWorkload[];
    collectionRate: CollectionRate;
}

type StatsClientProps = Partial<StatsPayload>;

// ── 금액 포맷 함수 ──────────────────────────────────────────────────────────

function formatKRW(n: number): string {
    if (n >= 10000) return `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)}만원`;
    return n.toLocaleString("ko-KR") + "원";
}

function StatsLoadingFallback() {
    return (
        <div className="mx-auto max-w-7xl space-y-8">
            <div>
                <div className="h-8 w-44 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                <div className="mt-2 h-4 w-80 max-w-full rounded bg-gray-100 dark:bg-gray-800 animate-pulse" />
            </div>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-800"
                    >
                        <div className="h-4 w-24 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                        <div className="mt-3 h-8 w-28 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                        <div className="mt-2 h-4 w-32 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                    </div>
                ))}
            </div>
            <div className="flex gap-2">
                <div className="h-8 w-24 rounded-full bg-gray-200 dark:bg-gray-700 animate-pulse" />
                <div className="h-8 w-24 rounded-full bg-gray-100 dark:bg-gray-700 animate-pulse" />
            </div>
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div
                        key={index}
                        className="rounded-2xl border border-gray-100 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-800"
                    >
                        <div className="mb-4 flex items-center gap-2">
                            <div className="h-6 w-6 rounded bg-gray-100 dark:bg-gray-700 animate-pulse" />
                            <div className="h-5 w-32 rounded bg-gray-200 dark:bg-gray-700 animate-pulse" />
                        </div>
                        <div className="flex h-[220px] items-end gap-3">
                            {Array.from({ length: 8 }).map((_, barIndex) => (
                                <div
                                    key={barIndex}
                                    className="flex-1 rounded-t bg-gray-100 dark:bg-gray-700 animate-pulse"
                                    style={{ height: `${36 + ((barIndex * 17) % 58)}%` }}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function StatsErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="mx-auto max-w-7xl rounded-2xl border border-red-100 bg-white p-8 text-center shadow-sm dark:border-red-900/40 dark:bg-gray-800">
            <span className="material-symbols-outlined mb-3 text-4xl text-red-500">error</span>
            <p className="font-bold text-gray-900 dark:text-white">운영 통계를 불러오지 못했습니다.</p>
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

// ── 메인 컴포넌트 ───────────────────────────────────────────────────────────

export default function StatsClient({
    monthlyRevenue: initialMonthlyRevenue,
    monthlyAttendance: initialMonthlyAttendance,
    enrollmentTrend: initialEnrollmentTrend,
    classCapacity: initialClassCapacity,
    trialStats: initialTrialStats,
    coachWorkload: initialCoachWorkload,
    collectionRate: initialCollectionRate,
}: StatsClientProps) {
    const initialData = initialMonthlyRevenue
        && initialMonthlyAttendance
        && initialEnrollmentTrend
        && initialClassCapacity
        && initialTrialStats
        && initialCoachWorkload
        && initialCollectionRate
        ? {
            monthlyRevenue: initialMonthlyRevenue,
            monthlyAttendance: initialMonthlyAttendance,
            enrollmentTrend: initialEnrollmentTrend,
            classCapacity: initialClassCapacity,
            trialStats: initialTrialStats,
            coachWorkload: initialCoachWorkload,
            collectionRate: initialCollectionRate,
        }
        : null;
    const [statsData, setStatsData] = useState<StatsPayload | null>(() => initialData);
    const [loading, setLoading] = useState(!initialData);
    // 매출 추이 기간 선택 (6개월/12개월)
    const [revenuePeriod, setRevenuePeriod] = useState<6 | 12>(6);

    const loadStats = useCallback(async () => {
        setLoading(true);

        try {
            const res = await fetch("/api/admin/stats");
            if (!res.ok) throw new Error("Stats request failed");
            setStatsData((await res.json()) as StatsPayload);
        } catch {
            setStatsData(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (statsData) return;
        void loadStats();
    }, [loadStats, statsData]);

    if (!statsData && loading) {
        return <StatsLoadingFallback />;
    }

    if (!statsData) {
        return <StatsErrorState onRetry={loadStats} />;
    }

    const {
        monthlyRevenue,
        monthlyAttendance,
        enrollmentTrend,
        classCapacity,
        trialStats,
        coachWorkload,
        collectionRate,
    } = statsData;

    // 선택 기간에 맞춰 데이터 슬라이싱
    const revenueData = monthlyRevenue.slice(-revenuePeriod);
    const attendanceData = monthlyAttendance.slice(-revenuePeriod);
    const enrollData = enrollmentTrend.slice(-revenuePeriod);

    // 이번 달/지난 달 매출 비교
    const thisMonth = monthlyRevenue[monthlyRevenue.length - 1];
    const lastMonth = monthlyRevenue.length > 1 ? monthlyRevenue[monthlyRevenue.length - 2] : null;
    const revDiff = lastMonth && lastMonth.amount > 0
        ? Math.round(((thisMonth?.amount ?? 0) - lastMonth.amount) / lastMonth.amount * 100)
        : 0;

    // 이번 달 출석률
    const thisMonthAtt = monthlyAttendance[monthlyAttendance.length - 1];

    // 요일 라벨 매핑
    const dayLabel: Record<string, string> = {
        Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
    };

    return (
        <div className="max-w-7xl mx-auto space-y-8">
            {/* 페이지 헤더 */}
            <div>
                {/* 설명문구 제거: 제목 + 기간 토글로 이미 자명 */}
                <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">상세 운영 통계</h1>
            </div>

            {/* ── KPI 요약 카드 4개 ────────────────────────────────────────── */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                {/* 이번 달 매출 */}
                <div className="bg-white dark:bg-gray-800 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">이번 달 매출</p>
                    <h3 className="text-2xl font-extrabold text-gray-900 dark:text-white">
                        {formatKRW(thisMonth?.amount ?? 0)}
                    </h3>
                    {lastMonth && lastMonth.amount > 0 && (
                        <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${revDiff >= 0 ? "text-green-600" : "text-red-600"}`}>
                            {/* Material Symbols 아이콘: 상승/하락 */}
                            <span className="material-symbols-outlined text-sm">
                                {revDiff >= 0 ? "trending_up" : "trending_down"}
                            </span>
                            전월 대비 {revDiff > 0 ? "+" : ""}{revDiff}%
                        </div>
                    )}
                </div>

                {/* 이번 달 출석률 */}
                <div className="bg-white dark:bg-gray-800 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">이번 달 출석률</p>
                    <h3 className="text-2xl font-extrabold text-gray-900 dark:text-white">
                        {thisMonthAtt?.rate ?? 0}%
                    </h3>
                    <p className="text-xs text-gray-400 mt-1">
                        {thisMonthAtt?.present ?? 0}/{thisMonthAtt?.total ?? 0}건 출석
                    </p>
                </div>

                {/* 수납률 */}
                <div className="bg-white dark:bg-gray-800 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">이번 달 수납률</p>
                    <h3 className="text-2xl font-extrabold text-gray-900 dark:text-white">{collectionRate.rate}%</h3>
                    <p className="text-xs text-gray-400 mt-1">
                        {collectionRate.paid}/{collectionRate.total}건 납부
                    </p>
                </div>

                {/* 체험 전환율 */}
                <div className="bg-white dark:bg-gray-800 p-5 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">체험 전환율</p>
                    <h3 className="text-2xl font-extrabold text-gray-900 dark:text-white">{trialStats.conversionRate}%</h3>
                    <p className="text-xs text-gray-400 mt-1">
                        {trialStats.CONVERTED}명 전환 / 전체 {trialStats.total}명
                    </p>
                </div>
            </div>

            {/* ── 기간 선택 토글 ──────────────────────────────────────────── */}
            <div className="flex gap-2">
                <button
                    onClick={() => setRevenuePeriod(6)}
                    className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${
                        revenuePeriod === 6
                            ? "bg-gray-900 text-white"
                            : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200"
                    }`}
                >
                    최근 6개월
                </button>
                <button
                    onClick={() => setRevenuePeriod(12)}
                    className={`px-4 py-1.5 rounded-full text-sm font-medium transition ${
                        revenuePeriod === 12
                            ? "bg-gray-900 text-white"
                            : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200"
                    }`}
                >
                    최근 12개월
                </button>
            </div>

            {/* ── 매출 + 출석률 추이 (LineChart) ──────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 매출 추이 */}
                <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <h3 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined text-orange-500 dark:text-brand-neon-lime">payments</span>
                        매출 추이
                    </h3>
                    <LineChart
                        data={revenueData.map((d) => ({ label: d.label, value: d.amount }))}
                        color="var(--brand-accent)"
                        height={220}
                        formatValue={formatKRW}
                    />
                </div>

                {/* 출석률 추이 */}
                <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <h3 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined text-emerald-500">event_available</span>
                        출석률 추이
                    </h3>
                    <LineChart
                        data={attendanceData.map((d) => ({ label: d.label, value: d.rate }))}
                        color="var(--color-emerald-500)"
                        height={220}
                        unit="%"
                    />
                </div>
            </div>

            {/* ── 원생 현황: 신규/퇴원 추이 + 반별 정원 ──────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* 신규/퇴원 추이 — 두 개의 LineChart를 겹쳐서 표현 */}
                <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <h3 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined text-blue-500">group</span>
                        신규 등록 / 퇴원 추이
                    </h3>
                    <div className="space-y-4">
                        {/* 신규 등록 */}
                        <div>
                            <div className="flex items-center gap-2 mb-1">
                                <span className="w-3 h-3 rounded-full bg-blue-500 inline-block" />
                                <span className="text-xs text-gray-500 dark:text-gray-400">신규 등록</span>
                            </div>
                            <LineChart
                                data={enrollData.map((d) => ({ label: d.label, value: d.newCount }))}
                                color="var(--color-blue-500)"
                                height={100}
                                unit="명"
                            />
                        </div>
                        {/* 퇴원 */}
                        <div>
                            <div className="flex items-center gap-2 mb-1">
                                <span className="w-3 h-3 rounded-full bg-red-400 inline-block" />
                                <span className="text-xs text-gray-500 dark:text-gray-400">퇴원</span>
                            </div>
                            <LineChart
                                data={enrollData.map((d) => ({ label: d.label, value: d.dropCount }))}
                                color="var(--color-red-400)"
                                height={100}
                                unit="명"
                            />
                        </div>
                    </div>
                </div>

                {/* 반별 정원 대비 등록률 */}
                <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <h3 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined text-purple-500">school</span>
                        반별 등록 현황
                    </h3>
                    {classCapacity.length === 0 ? (
                        <p className="text-sm text-gray-400 py-8 text-center">등록된 반이 없습니다</p>
                    ) : (
                        <BarChart
                            data={classCapacity.map((c) => ({
                                label: `${c.name}(${dayLabel[c.dayOfWeek] ?? c.dayOfWeek})`,
                                value: c.enrolled,
                                max: c.capacity,
                            }))}
                            color="var(--color-violet-500)"
                            height={220}
                            unit="명"
                            showMax={true}
                        />
                    )}
                </div>
            </div>

            {/* ── 체험 전환 + 수납률 (DonutChart) ─────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* 체험 전환율 도넛 */}
                <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <h3 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined text-orange-500 dark:text-brand-neon-lime">handshake</span>
                        체험 전환율
                    </h3>
                    <div className="flex justify-center">
                        <DonutChart
                            value={trialStats.CONVERTED}
                            max={trialStats.ATTENDED + trialStats.CONVERTED}
                            label="체험 참석 대비 전환"
                            color="var(--brand-accent)"
                            size={160}
                        />
                    </div>
                    {/* 파이프라인 요약 */}
                    <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                        <PipelineItem label="신규" count={trialStats.NEW} color="blue" />
                        <PipelineItem label="연락완료" count={trialStats.CONTACTED} color="yellow" />
                        <PipelineItem label="예약" count={trialStats.SCHEDULED} color="purple" />
                        <PipelineItem label="체험완료" count={trialStats.ATTENDED} color="green" />
                        <PipelineItem label="등록전환" count={trialStats.CONVERTED} color="orange" />
                        <PipelineItem label="이탈" count={trialStats.LOST} color="red" />
                    </div>
                </div>

                {/* 수납률 도넛 */}
                <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <h3 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined text-green-500">account_balance_wallet</span>
                        이번 달 수납률
                    </h3>
                    <div className="flex justify-center">
                        <DonutChart
                            value={collectionRate.paid}
                            max={collectionRate.total}
                            label="납부 완료 비율"
                            color="var(--color-emerald-500)"
                            size={160}
                        />
                    </div>
                    <div className="mt-4 space-y-2">
                        <div className="flex justify-between text-sm">
                            <span className="text-gray-500 dark:text-gray-400">납부 완료</span>
                            <span className="font-bold text-green-600">{collectionRate.paid}건</span>
                        </div>
                        <div className="flex justify-between text-sm">
                            <span className="text-gray-500 dark:text-gray-400">미납</span>
                            <span className="font-bold text-red-600">{collectionRate.unpaid}건</span>
                        </div>
                    </div>
                </div>

                {/* 전체 원생 흐름 요약 */}
                <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                    <h3 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                        <span className="material-symbols-outlined text-blue-500">summarize</span>
                        이번 달 원생 흐름
                    </h3>
                    {(() => {
                        // 이번 달 데이터
                        const thisEnroll = enrollmentTrend[enrollmentTrend.length - 1];
                        const lastEnroll = enrollmentTrend.length > 1 ? enrollmentTrend[enrollmentTrend.length - 2] : null;
                        return (
                            <div className="space-y-4">
                                <FlowItem
                                    icon="person_add"
                                    label="신규 등록"
                                    value={thisEnroll?.newCount ?? 0}
                                    prev={lastEnroll?.newCount ?? 0}
                                    color="blue"
                                />
                                <FlowItem
                                    icon="person_remove"
                                    label="퇴원"
                                    value={thisEnroll?.dropCount ?? 0}
                                    prev={lastEnroll?.dropCount ?? 0}
                                    color="red"
                                    invertTrend
                                />
                                <FlowItem
                                    icon="diversity_3"
                                    label="체험 신청"
                                    value={trialStats.NEW + trialStats.CONTACTED + trialStats.SCHEDULED}
                                    color="orange"
                                />
                                <FlowItem
                                    icon="how_to_reg"
                                    label="체험 → 등록"
                                    value={trialStats.CONVERTED}
                                    color="green"
                                />
                                <div className="pt-2 border-t">
                                    <div className="flex justify-between">
                                        <span className="text-sm text-gray-500 dark:text-gray-400">총 대기자</span>
                                        <span className="font-bold text-gray-900 dark:text-white">
                                            {classCapacity.reduce((s, c) => s + c.waiting, 0)}명
                                        </span>
                                    </div>
                                </div>
                            </div>
                        );
                    })()}
                </div>
            </div>

            {/* ── 코치 워크로드 ───────────────────────────────────────────── */}
            <div className="bg-white dark:bg-gray-800 p-6 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800">
                <h3 className="font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                    <span className="material-symbols-outlined text-indigo-500">sports</span>
                    코치별 워크로드
                </h3>
                {coachWorkload.length === 0 ? (
                    <p className="text-sm text-gray-400 py-4">등록된 코치가 없습니다</p>
                ) : (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        {/* 수업 수 막대 그래프 */}
                        <div>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">담당 수업 수</p>
                            <BarChart
                                data={coachWorkload.map((c) => ({
                                    label: c.name,
                                    value: c.classCount,
                                }))}
                                color="var(--color-indigo-500)"
                                height={180}
                                unit="개"
                            />
                        </div>
                        {/* 원생 수 막대 그래프 */}
                        <div>
                            <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">담당 원생 수</p>
                            <BarChart
                                data={coachWorkload.map((c) => ({
                                    label: c.name,
                                    value: c.studentCount,
                                }))}
                                color="var(--color-violet-500)"
                                height={180}
                                unit="명"
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

// ── 서브 컴포넌트 ───────────────────────────────────────────────────────────

// 체험 파이프라인 항목
function PipelineItem({ label, count, color }: { label: string; count: number; color: string }) {
    const colorMap: Record<string, string> = {
        blue: "bg-blue-100 text-blue-700",
        yellow: "bg-yellow-100 text-yellow-700",
        purple: "bg-gray-800 text-white", // 스포츠 팔레트에서 주황과 겹치지 않게 차콜로 구분
        green: "bg-green-100 text-green-700",
        orange: "bg-orange-100 text-orange-700",
        red: "bg-red-100 text-red-700",
    };
    return (
        <div className={`rounded-lg py-1.5 px-2 ${colorMap[color] ?? colorMap.blue}`}>
            <p className="text-xs font-medium">{label}</p>
            <p className="text-lg font-extrabold">{count}</p>
        </div>
    );
}

// 원생 흐름 항목 (이번 달 vs 전월 비교)
function FlowItem({
    icon,
    label,
    value,
    prev,
    color,
    invertTrend = false,
}: {
    icon: string;
    label: string;
    value: number;
    prev?: number;
    color: string;
    invertTrend?: boolean;
}) {
    const colorMap: Record<string, string> = {
        blue: "text-blue-500",
        red: "text-red-500",
        orange: "text-orange-500",
        green: "text-green-500",
    };

    // 전월 대비 변화 표시
    const diff = prev !== undefined ? value - prev : null;
    // invertTrend: 퇴원처럼 줄어든 게 좋은 경우
    const isGood = diff !== null ? (invertTrend ? diff <= 0 : diff >= 0) : true;

    return (
        <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
                <span className={`material-symbols-outlined text-lg ${colorMap[color] ?? ""}`}>{icon}</span>
                <span className="text-sm text-gray-600 dark:text-gray-300">{label}</span>
            </div>
            <div className="flex items-center gap-2">
                <span className="font-bold text-gray-900 dark:text-white">{value}명</span>
                {diff !== null && diff !== 0 && (
                    <span className={`text-xs font-medium ${isGood ? "text-green-600" : "text-red-600"}`}>
                        {diff > 0 ? "+" : ""}{diff}
                    </span>
                )}
            </div>
        </div>
    );
}
