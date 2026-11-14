"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import AdminPageHeader from "@/components/admin/AdminPageHeader";
// 편집 본문(주제·내용·사진·학생 코멘트·저장·발행)은 수업 피드 패널과 같은 공용 부품을 쓴다(2026-11-14)
import SessionReportEditor, {
    type SessionReportCoach as Coach,
    type SessionReportData as ReportData,
} from "@/components/admin/SessionReportEditor";

// 요일 한글 변환
const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

type ReportPayload = {
    report: ReportData | null;
    coaches: Coach[];
};

function ReportEditLoadingFallback() {
    return (
        <div className="mx-auto max-w-4xl">
            <div className="mb-6 flex items-center justify-between gap-4">
                <div>
                    <div className="h-5 w-28 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                    <div className="mt-3 h-8 w-48 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                    <div className="mt-2 h-4 w-96 max-w-full animate-pulse rounded bg-[var(--color-academy-soft)]" />
                </div>
                <div className="h-8 w-24 animate-pulse rounded-full bg-[var(--color-academy-soft)]" />
            </div>

            <div className="mb-6 rounded-xl border border-[var(--color-academy-line)] bg-white p-6 shadow-sm">
                <div className="h-7 w-32 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                <div className="mt-5 space-y-4">
                    <div className="h-11 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
                    <div className="h-11 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
                    <div className="h-28 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
                    <div className="h-10 w-32 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
                </div>
            </div>

            <div className="mb-6 overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-white shadow-sm">
                <div className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-5">
                    <div className="h-7 w-56 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                    <div className="mt-2 h-3 w-80 max-w-full animate-pulse rounded bg-[var(--color-academy-soft)]" />
                </div>
                <div className="divide-y divide-[var(--color-academy-line)]">
                    {Array.from({ length: 5 }).map((_, index) => (
                        <div key={index} className="px-5 py-4">
                            <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="h-5 w-24 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                                <div className="h-6 w-14 animate-pulse rounded-full bg-[var(--color-academy-soft)]" />
                            </div>
                            <div className="mb-3 h-5 w-32 animate-pulse rounded bg-[var(--color-academy-soft)]" />
                            <div className="h-16 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-[var(--color-academy-line)] bg-white p-5 shadow-sm">
                <div className="h-10 w-32 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
                <div className="h-10 w-24 animate-pulse rounded-lg bg-[var(--color-academy-soft)]" />
            </div>
        </div>
    );
}

function ReportEditErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="mx-auto max-w-4xl rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] p-6 text-center">
            <p className="text-sm font-semibold text-[var(--color-academy-danger)]">수업 리포트 정보를 불러오지 못했습니다.</p>
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

export default function ReportEditClient({
    report: initialReport,
    coaches: initialCoaches,
    sessionId,
}: {
    report?: ReportData | null;
    coaches?: Coach[];
    sessionId?: string;
}) {
    const hasInitialData = initialReport !== undefined && initialCoaches !== undefined;
    const [report, setReport] = useState<ReportData | null>(initialReport ?? null);
    const [coaches, setCoaches] = useState<Coach[]>(initialCoaches ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadError, setLoadError] = useState(false);

    const loadReport = useCallback(async () => {
        if (!sessionId) {
            setLoadError(true);
            setLoading(false);
            return;
        }

        setLoading(true);
        setLoadError(false);
        try {
            const response = await fetch(`/api/admin/attendance/report/${sessionId}`, { cache: "no-store" });
            if (!response.ok) throw new Error("Failed to load report.");
            const data = (await response.json()) as ReportPayload;
            setReport(data.report);
            setCoaches(data.coaches);
            setLoadError(!data.report);
        } catch (error) {
            console.error("Failed to load report:", error);
            setLoadError(true);
        } finally {
            setLoading(false);
        }
    }, [sessionId]);

    useEffect(() => {
        if (hasInitialData) return;
        void loadReport();
    }, [hasInitialData, loadReport]);

    if (loading && !report) {
        return <ReportEditLoadingFallback />;
    }

    if (loadError || !report) {
        return <ReportEditErrorState onRetry={loadReport} />;
    }

    return <ReportEditForm report={report} coaches={coaches} />;
}

function ReportEditForm({
    report,
    coaches,
}: {
    report: ReportData;
    coaches: Coach[];
}) {
    // 머리말의 발행 배지 — 편집 부품이 발행 상태를 바꾸면 알려 준다
    const [published, setPublished] = useState(report.published);

    // 날짜 포맷
    const dateStr = new Date(report.date).toLocaleDateString("ko-KR", {
        year: "numeric", month: "long", day: "numeric", weekday: "short",
    });

    return (
        <div className="max-w-4xl mx-auto">
            {/* 헤더: 뒤로가기 + 제목 */}
            <div className="mb-6 min-w-0">
                {/* 뒤로가기는 글자 버튼 — 리포트 목록은 수업 피드로 합쳐졌다(2026-11-14) */}
                <Link
                    href="/admin/attendance/feed"
                    prefetch={false}
                    className="academy-button-text academy-button-sm -ml-2"
                >
                    ← 수업 피드
                </Link>
                <AdminPageHeader
                    className="mt-1"
                    title="수업 리포트 편집"
                    description={
                        <>
                            <span className="tabular-nums">{dateStr} | {report.className} ({DAY_LABELS[report.dayOfWeek] || report.dayOfWeek} {report.startTime}~{report.endTime})</span>
                            {report.programName && <span className="ml-2 text-[var(--color-academy-faint)]">- {report.programName}</span>}
                        </>
                    }
                    // 발행 상태 배지(상태색 그대로 — 발행됨 초록 · 미발행 회색)
                    actions={
                        published ? (
                            <span className="inline-flex items-center rounded-full px-3 py-1 text-sm bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]">
                                발행됨
                            </span>
                        ) : (
                            <span className="inline-flex items-center rounded-full px-3 py-1 text-sm bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]">
                                미발행
                            </span>
                        )
                    }
                />
            </div>

            <SessionReportEditor report={report} coaches={coaches} onPublishedChange={setPublished} />
        </div>
    );
}
