"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import {
    createStudent,
    updateStudent,
    deleteStudent,
    enrollStudent,
} from "@/app/actions/admin";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu from "@/components/admin/AdminQuickActionMenu";
import CompactListFilters from "@/components/academy/CompactListFilters";

const ExcelUploadModal = dynamic(() => import("./ExcelUploadModal"), {
    ssr: false,
    loading: () => null,
});

type Student = {
    id: string;
    name: string;
    birthDate: Date | string;
    gender: string | null;
    parentId: string;
    // 새 필드: 엑셀 업로드 일괄 등록용
    phone: string | null;       // 학생 휴대폰번호
    school: string | null;      // 학교명
    grade: string | null;       // 학년
    address: string | null;     // 주소
    enrollDate: Date | string | null;  // 입회일자
    createdAt: Date | string;
    currentStatus?: string | null;
    parent: {
        name: string | null;
        phone: string | null;
        email: string | null;
    };
    // 수강 정보 (getStudents 서브쿼리에서 가져옴)
    enrollments: {
        classId: string;
        className: string;
        status: string;
        dayOfWeek: string;
        startTime: string;
        slotKey: string | null;
        createdAt?: string;
    }[];
};

type ClassItem = {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    slotKey: string | null; // 시간표 슬롯 키 (예: "Mon-4")
    program: { id: string; name: string } | null;
};

type ScheduleMismatch = {
    slotKey: string;
    sheetCount: number;
    dbCount: number;
    diff: number;
};

type SheetImportSummary = {
    id: string;
    status: string;
    totalRows: number;
    registrationRows: number;
    vehicleRows: number;
    changeRows: number;
    teamRows: number;
    errorRows: number;
    message: string | null;
    createdAt: string;
    completedAt: string | null;
    uniqueStudents: number;
    linkedRegistrations: number;
    studentStatusCounts?: {
        total: number;
        active: number;
        paused: number;
        withdrawn: number;
        noEnrollment: number;
    };
    scheduleMismatchCount: number;
    topScheduleMismatches: ScheduleMismatch[];
} | null;

type CurrentRosterReport = {
    batch: {
        id: string;
        status: string;
        spreadsheetTitle: string | null;
        sourceUrl: string | null;
        totalRows: number;
        registrationRows: number;
        errorRows: number;
        createdAt: string;
        completedAt: string | null;
    } | null;
    targetMonth: {
        requestedMonth: number | null;
        monthNumber: number | null;
        label: string;
    };
    summary: {
        targetMonthNumber: number | null;
        targetRows: number;
        uniqueStudentKeys: number;
        linkedRows: number;
        linkedStudents: number;
        unresolvedRows: number;
        activeRows: number;
        pausedRows: number;
        withdrawnRows: number;
        rowsWithSlots: number;
        selectedSlotPairs: number;
        missingClassSlots: number;
        studentsWithHistory: number;
        previousLedgerRows: number;
        duplicateStudentGroups: number;
        nameConflictGroups: number;
    } | null;
    monthDistribution: {
        monthNumber: number | null;
        label: string;
        rowCount: number;
        linkedRows: number;
        activeRows: number;
    }[];
    unresolvedRows: {
        id: string;
        rowNumber: number;
        studentName: string;
        parentName: string | null;
        parentPhone: string | null;
        studentPhone: string | null;
        birthDate: string | null;
        school: string | null;
        grade: string | null;
        registrationMonth: string | null;
        status: string;
    }[];
    duplicateStudentGroups: {
        studentName: string;
        parentPhone: string | null;
        studentCount: number;
        studentIds: string[];
        parentNames: string[];
    }[];
    nameConflictGroups: {
        studentName: string;
        studentCount: number;
        studentIds: string[];
    }[];
    historySamples: {
        studentId: string;
        studentName: string;
        parentPhone: string | null;
        previousRows: number;
        previousMonths: string[];
    }[];
    missingClassSlots: {
        slotKey: string;
        rowCount: number;
    }[];
    statusBreakdown?: {
        status: string;
        rowCount: number;
        studentCount: number;
    }[];
    statusSamples?: {
        status: string;
        studentId: string | null;
        studentName: string;
        parentName: string | null;
        parentPhone: string | null;
        studentPhone: string | null;
        school: string | null;
        grade: string | null;
        registrationMonth: string | null;
        firstRowNumber: number;
        rowCount: number;
        slotKeys: string[] | null;
    }[];
};

type ReconcileSample = {
    studentId: string;
    studentName: string;
    slotKey: string;
    currentStatus?: string | null;
    targetStatus?: string | null;
    /** 퇴원 후보 전용 — 마지막으로 시트에 등장한 달 */
    lastSeenMonth?: string | null;
    /** 퇴원 후보 전용 — 이미 지나간 미등장 개월 수 */
    monthsMissing?: number | null;
};

type ReconcilePreview = {
    batchId: string | null;
    expectedActivePairs: number;
    missingEnrollments: number;
    reactivations: number;
    pauseExtras: number;
    unresolvedLedgerRows: number;
    missingClassSlots: number;
    outsideScopeActiveStudents: number;
    withdrawCandidates: number;
    withdrawCandidateStudents: number;
    maxPauseMonths: number;
    samples: {
        missing: ReconcileSample[];
        reactivations: ReconcileSample[];
        pauseExtras: ReconcileSample[];
        withdrawCandidates: ReconcileSample[];
    };
};

type RelinkKind = "registration" | "shuttle" | "team";

type RelinkCounts = Record<RelinkKind, number>;

type RelinkMatch = {
    studentId: string;
    confidence: "strong" | "medium" | "weak";
    matchedBy: string;
};

type RelinkReviewRow = {
    kind: RelinkKind;
    id: string;
    rawRowId: string | null;
    sheetName: string;
    rowNumber: number;
    studentName: string | null;
    studentPhone: string | null;
    parentPhone: string | null;
    match: RelinkMatch | null;
    canCreateStudent?: boolean;
    createBlockedReason?: string | null;
};

type RelinkPreview = {
    batchId: string | null;
    scanned: RelinkCounts;
    matched: RelinkCounts;
    applyReady: RelinkCounts;
    weakOnly: RelinkCounts;
    unmatched: RelinkCounts;
    ignored: RelinkCounts;
    byConfidence: Record<RelinkMatch["confidence"], number>;
    reviewRows: RelinkReviewRow[];
};

type StudentOption = {
    id: string;
    name: string;
    parent?: { name: string | null };
};

const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

// 요일 정렬 순서 (월~일)
const DAY_ORDER: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
};

const STUDENT_PAGE_SIZE = 50;

const RELINK_KIND_LABELS: Record<RelinkKind, string> = {
    registration: "등록",
    shuttle: "차량",
    team: "대표팀",
};

/**
 * slotKey에서 교시 번호를 추출하는 유틸 함수
 * 예: "Mon-4" → 4, "Sat-2" → 2, "custom-xxx" → 999 (커스텀은 맨 뒤로)
 */
function getPeriodFromSlotKey(slotKey: string | null): number {
    if (!slotKey) return 999;
    const match = slotKey.match(/-(\d+)$/);
    return match ? parseInt(match[1], 10) : 999;
}

/**
 * Class 목록을 프로그램별로 그룹화하고, 각 그룹 안에서 요일+교시 순으로 정렬
 * 반환: { programName: string, classes: ClassItem[] }[]
 */
function groupClassesByProgram(classes: ClassItem[]) {
    // 프로그램별로 그룹핑
    const groups = new Map<string, { programName: string; classes: ClassItem[] }>();

    for (const c of classes) {
        const key = c.program?.id ?? "__no_program__";
        const name = c.program?.name ?? "미지정 프로그램";
        if (!groups.has(key)) {
            groups.set(key, { programName: name, classes: [] });
        }
        groups.get(key)!.classes.push(c);
    }

    // 각 그룹 안에서 요일 + 교시 순으로 정렬
    for (const group of groups.values()) {
        group.classes.sort((a, b) => {
            const dayDiff = (DAY_ORDER[a.dayOfWeek] ?? 99) - (DAY_ORDER[b.dayOfWeek] ?? 99);
            if (dayDiff !== 0) return dayDiff;
            return getPeriodFromSlotKey(a.slotKey) - getPeriodFromSlotKey(b.slotKey);
        });
    }

    return Array.from(groups.values());
}

function ImportSummaryMetric({
    label,
    value,
    warning = false,
}: {
    label: string;
    value: number;
    warning?: boolean;
}) {
    return (
        <div className="rounded-lg bg-gray-50 px-2 py-2 dark:bg-gray-800">
            <p className="text-gray-500 dark:text-gray-400">{label}</p>
            <p
                className={`font-extrabold ${
                    warning
                        ? "text-amber-700 dark:text-amber-200"
                        : "text-gray-900 dark:text-white"
                }`}
            >
                {value.toLocaleString()}
            </p>
        </div>
    );
}

function formatSlotLabel(slotKey: string) {
    const [day, period] = slotKey.split("-");
    const dayLabel = DAY_LABELS[day] ?? day;
    return period ? `${dayLabel} ${period}교시` : slotKey;
}

function formatReportPhone(value: string | null | undefined) {
    const digits = (value ?? "").replace(/[^0-9]/g, "");
    if (digits.length === 11) {
        return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    }
    return value || "연락처 없음";
}

function formatReportList(values: string[] | null | undefined) {
    if (!values || values.length === 0) return "없음";
    return values.slice(0, 4).join(", ");
}

const ROSTER_STATUS_META: Record<string, { label: string; tone: string; note: string }> = {
    ACTIVE: {
        label: "재원",
        tone: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-300/20 dark:bg-emerald-300/10 dark:text-emerald-100",
        note: "장부 기준 실제 수업 인원",
    },
    PAUSED: {
        label: "휴원",
        tone: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-300/20 dark:bg-amber-300/10 dark:text-amber-100",
        note: "등록 행이 모두 휴원인 학생",
    },
    WITHDRAWN: {
        label: "퇴원",
        tone: "border-red-200 bg-red-50 text-red-900 dark:border-red-300/20 dark:bg-red-300/10 dark:text-red-100",
        note: "최신 상태가 퇴원인 학생",
    },
    UNKNOWN: {
        label: "확인 필요",
        tone: "border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200",
        note: "상태를 계산하지 못한 행",
    },
};

function getRosterStatusMeta(status: string) {
    return ROSTER_STATUS_META[status] ?? ROSTER_STATUS_META.UNKNOWN;
}

function formatSlotList(slotKeys: string[] | string | null | undefined) {
    if (!slotKeys) return "반 정보 없음";

    const parsed = typeof slotKeys === "string"
        ? (() => {
            try {
                const value = JSON.parse(slotKeys);
                return Array.isArray(value) ? value : [];
            } catch {
                return [];
            }
        })()
        : slotKeys;

    if (parsed.length === 0) return "반 정보 없음";
    return parsed.slice(0, 4).map((slotKey) => formatSlotLabel(String(slotKey))).join(", ");
}

function CurrentRosterReportBox({ report }: { report: CurrentRosterReport }) {
    if (!report.batch || !report.summary) {
        return (
            <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 text-xs text-gray-600 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-300">
                완료된 수강생 시트 이관 배치가 아직 없습니다.
            </div>
        );
    }

    const { summary } = report;
    const riskCount =
        summary.unresolvedRows +
        summary.missingClassSlots +
        summary.duplicateStudentGroups +
        summary.nameConflictGroups;
    const statusBreakdown = report.statusBreakdown ?? [];
    const statusByCode = new Map(statusBreakdown.map((item) => [item.status, item]));
    const operationalStudentCount = statusBreakdown.reduce((total, item) => total + item.studentCount, 0);
    const activeCount = statusByCode.get("ACTIVE")?.studentCount ?? 0;
    const pausedCount = statusByCode.get("PAUSED")?.studentCount ?? 0;
    const withdrawnCount = statusByCode.get("WITHDRAWN")?.studentCount ?? 0;
    const statusSamples = report.statusSamples ?? [];
    const pausedSamples = statusSamples.filter((sample) => sample.status === "PAUSED");
    const withdrawnSamples = statusSamples.filter((sample) => sample.status === "WITHDRAWN");

    return (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-lime-100 px-2 py-0.5 text-xs font-bold text-lime-800 dark:bg-lime-300/15 dark:text-lime-200">
                            읽기 전용
                        </span>
                        <p className="text-sm font-extrabold text-gray-900 dark:text-white">
                            {report.targetMonth.label} 최신 원생목록 점검
                        </p>
                    </div>
                </div>
                <span
                    className={`rounded-full px-2 py-1 text-xs font-bold ${
                        riskCount > 0
                            ? "bg-amber-100 text-amber-800 dark:bg-amber-300/15 dark:text-amber-100"
                            : "bg-emerald-100 text-emerald-800 dark:bg-emerald-300/15 dark:text-emerald-100"
                    }`}
                >
                    {riskCount > 0 ? `확인 필요 ${riskCount.toLocaleString()}건` : "자동 정리 가능"}
                </span>
            </div>

            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-900">
                    <p className="text-gray-500 dark:text-gray-400">현재 운영 학생</p>
                    <p className="mt-1 text-2xl font-black text-gray-950 dark:text-white">
                        {operationalStudentCount.toLocaleString()}명
                    </p>
                </div>
                {["ACTIVE", "PAUSED", "WITHDRAWN"].map((status) => {
                    const item = statusByCode.get(status);
                    const meta = getRosterStatusMeta(status);
                    return (
                        <div key={status} className={`rounded-lg border p-3 text-xs ${meta.tone}`}>
                            <p className="font-bold">{meta.label}</p>
                            <p className="mt-1 text-2xl font-black">
                                {(item?.studentCount ?? 0).toLocaleString()}명
                            </p>
                            <p className="mt-1 opacity-80">
                                행 {(item?.rowCount ?? 0).toLocaleString()}줄 · {meta.note}
                            </p>
                        </div>
                    );
                })}
            </div>

            <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600 dark:bg-gray-900 dark:text-gray-300">
                현재 {report.targetMonth.label} 기준은 재원 {activeCount.toLocaleString()}명, 휴원 {pausedCount.toLocaleString()}명,
                퇴원 {withdrawnCount.toLocaleString()}명으로 계산됩니다. 한 학생이 여러 반을 들어도 학생 수는 1명으로 봅니다.
            </p>

            <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4 lg:grid-cols-8">
                <ImportSummaryMetric label="대상 행" value={summary.targetRows} />
                <ImportSummaryMetric label="고유키" value={summary.uniqueStudentKeys} />
                <ImportSummaryMetric label="연결 행" value={summary.linkedRows} />
                <ImportSummaryMetric label="연결 학생" value={summary.linkedStudents} />
                <ImportSummaryMetric label="미연결" value={summary.unresolvedRows} warning={summary.unresolvedRows > 0} />
                <ImportSummaryMetric label="이전 이력" value={summary.studentsWithHistory} />
                <ImportSummaryMetric label="중복 의심" value={summary.duplicateStudentGroups} warning={summary.duplicateStudentGroups > 0} />
                <ImportSummaryMetric label="동명이인" value={summary.nameConflictGroups} warning={summary.nameConflictGroups > 0} />
            </div>

            {report.monthDistribution.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    {report.monthDistribution.map((item) => (
                        <span
                            key={`${item.monthNumber ?? "none"}-${item.label}`}
                            className={`rounded-full px-2 py-1 font-semibold ring-1 ${
                                item.monthNumber === report.targetMonth.monthNumber
                                    ? "bg-lime-100 text-lime-900 ring-lime-300 dark:bg-lime-300/15 dark:text-lime-100 dark:ring-lime-300/30"
                                    : "bg-gray-50 text-gray-600 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700"
                            }`}
                        >
                            {item.label} {item.rowCount.toLocaleString()}행 · 연결 {item.linkedRows.toLocaleString()}행
                        </span>
                    ))}
                </div>
            )}

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {(pausedSamples.length > 0 || withdrawnSamples.length > 0) && (
                    <div className="rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-900">
                        <p className="font-bold text-gray-900 dark:text-white">휴원/퇴원 확인 샘플</p>
                        <div className="mt-2 grid gap-2 md:grid-cols-2">
                            {[
                                { title: "휴원", rows: pausedSamples },
                                { title: "퇴원", rows: withdrawnSamples },
                            ].map((group) => (
                                <div key={group.title} className="space-y-1">
                                    <p className="font-semibold text-gray-700 dark:text-gray-200">{group.title}</p>
                                    {group.rows.length === 0 ? (
                                        <p className="text-gray-500 dark:text-gray-400">대상 없음</p>
                                    ) : (
                                        group.rows.map((row) => (
                                            <p
                                                key={`${group.title}-${row.studentId ?? row.studentName}-${row.firstRowNumber}`}
                                                className="text-gray-600 dark:text-gray-300"
                                            >
                                                #{row.firstRowNumber} {row.studentName} · {formatReportPhone(row.parentPhone)} · {formatSlotList(row.slotKeys)}
                                            </p>
                                        ))
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {report.historySamples.length > 0 && (
                    <div className="rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-900">
                        <p className="font-bold text-gray-900 dark:text-white">이전 월 이력 연결 샘플</p>
                        <div className="mt-2 space-y-1 text-gray-600 dark:text-gray-300">
                            {report.historySamples.map((row) => (
                                <p key={row.studentId}>
                                    {row.studentName} · 이전 {row.previousRows.toLocaleString()}행 · {formatReportList(row.previousMonths)}
                                </p>
                            ))}
                        </div>
                    </div>
                )}

                {report.missingClassSlots.length > 0 && (
                    <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-300/10 dark:text-amber-100">
                        <p className="font-bold">반/시간표 미매칭</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                            {report.missingClassSlots.map((slot) => (
                                <span key={slot.slotKey} className="rounded-full bg-white px-2 py-1 font-semibold ring-1 ring-amber-200 dark:bg-gray-950 dark:ring-amber-300/25">
                                    {formatSlotLabel(slot.slotKey)} {slot.rowCount.toLocaleString()}행
                                </span>
                            ))}
                        </div>
                    </div>
                )}

                {report.unresolvedRows.length > 0 && (
                    <div className="rounded-lg bg-red-50 p-3 text-xs text-red-900 dark:bg-red-500/10 dark:text-red-100">
                        <p className="font-bold">미연결 등록 행</p>
                        <div className="mt-2 space-y-1">
                            {report.unresolvedRows.map((row) => (
                                <p key={row.id}>
                                    #{row.rowNumber} {row.studentName} · {formatReportPhone(row.parentPhone)} · {row.school ?? "학교 미입력"} · {row.grade ?? "학년 미입력"}
                                </p>
                            ))}
                        </div>
                    </div>
                )}

                {report.duplicateStudentGroups.length > 0 && (
                    <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-300/10 dark:text-amber-100">
                        <p className="font-bold">같은 보호자 연락처의 중복 원생 의심</p>
                        <div className="mt-2 space-y-1">
                            {report.duplicateStudentGroups.map((group) => (
                                <p key={`${group.studentName}-${group.parentPhone}`}>
                                    {group.studentName} · {formatReportPhone(group.parentPhone)} · {group.studentCount.toLocaleString()}개 ID · 보호자 {formatReportList(group.parentNames)}
                                </p>
                            ))}
                        </div>
                    </div>
                )}

                {report.nameConflictGroups.length > 0 && (
                    <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-700 dark:bg-gray-900 dark:text-gray-300">
                        <p className="font-bold text-gray-900 dark:text-white">이름만으로는 위험한 후보</p>
                        <div className="mt-2 space-y-1">
                            {report.nameConflictGroups.map((group) => (
                                <p key={group.studentName}>
                                    {group.studentName} · 기존 Student {group.studentCount.toLocaleString()}개
                                </p>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function ReconcilePreviewBox({
    preview,
    applying,
    onApply,
    onApplyWithdrawals,
}: {
    preview: ReconcilePreview;
    applying: boolean;
    onApply: () => void;
    onApplyWithdrawals: () => void;
}) {
    const actionCount =
        preview.missingEnrollments + preview.reactivations + preview.pauseExtras;

    return (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
            <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-6">
                <ImportSummaryMetric label="기준" value={preview.expectedActivePairs} />
                <ImportSummaryMetric label="추가" value={preview.missingEnrollments} warning={preview.missingEnrollments > 0} />
                <ImportSummaryMetric label="활성화" value={preview.reactivations} warning={preview.reactivations > 0} />
                <ImportSummaryMetric label="정지" value={preview.pauseExtras} warning={preview.pauseExtras > 0} />
                <ImportSummaryMetric label="미연결" value={preview.unresolvedLedgerRows} warning={preview.unresolvedLedgerRows > 0} />
                <ImportSummaryMetric label="반 없음" value={preview.missingClassSlots} warning={preview.missingClassSlots > 0} />
            </div>

            <p className="mt-3 text-xs text-gray-600 dark:text-gray-300">
                시트 원장에 DB 학생으로 연결된 대상만 적용합니다. 시트에 없는 기존 활성 학생 {preview.outsideScopeActiveStudents}명은 자동 변경하지 않습니다.
            </p>

            <div className="mt-3 grid gap-2 text-xs md:grid-cols-3">
                <ReconcileSampleList title="추가 예정" rows={preview.samples.missing} />
                <ReconcileSampleList title="활성화 예정" rows={preview.samples.reactivations} />
                <ReconcileSampleList title="정지 예정" rows={preview.samples.pauseExtras} />
            </div>

            <div className="mt-3 flex justify-end">
                <button
                    type="button"
                    onClick={onApply}
                    disabled={applying || actionCount === 0 || preview.missingClassSlots > 0}
                    className="rounded-lg bg-gray-900 px-3 py-2 text-xs font-bold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-neon-lime dark:text-gray-950 dark:hover:bg-lime-200"
                >
                    {applying ? "적용 중" : actionCount === 0 ? "적용할 변경 없음" : "시트 기준 적용"}
                </button>
            </div>

            {/*
              퇴원 후보는 위의 "시트 기준 적용"에 절대 포함되지 않는다.
              반 명단에서 사라지고 청구가 끊기는 되돌리기 어려운 처리라, 명단을 눈으로 확인한 뒤
              아래 전용 버튼으로만 확정하도록 분리했다.
            */}
            {preview.withdrawCandidates > 0 && (
                <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-900 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
                    <p className="font-bold">
                        퇴원 후보 {preview.withdrawCandidateStudents}명 ({preview.withdrawCandidates}건)
                    </p>
                    <p className="mt-1">
                        약관상 휴원 한도({preview.maxPauseMonths}개월)를 넘겨 시트에서 사라진 학생입니다.
                        아래 버튼을 누르기 전까지는 <strong>아무것도 바뀌지 않습니다.</strong> 퇴원 후에도 다시 시트에 나타나면
                        &ldquo;시트 기준 적용&rdquo;으로 자동 복원됩니다.
                    </p>
                    <div className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                        {preview.samples.withdrawCandidates.map((row) => (
                            <p key={`withdraw-${row.studentId}-${row.slotKey}`}>
                                {row.studentName} · {formatSlotLabel(row.slotKey)} · 마지막 등장 {row.lastSeenMonth ?? "-"}
                                {typeof row.monthsMissing === "number" ? ` (${row.monthsMissing}개월 미등장)` : ""}
                                {row.currentStatus ? ` · 현재 ${row.currentStatus}` : ""}
                            </p>
                        ))}
                    </div>
                    <div className="mt-3 flex justify-end">
                        <button
                            type="button"
                            onClick={onApplyWithdrawals}
                            disabled={applying}
                            className="rounded-lg bg-red-700 px-3 py-2 text-xs font-bold text-white transition hover:bg-red-800 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {applying ? "적용 중" : `퇴원 후보 ${preview.withdrawCandidateStudents}명 퇴원 처리`}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}

function ReconcileSampleList({ title, rows }: { title: string; rows: ReconcileSample[] }) {
    return (
        <div className="rounded-md bg-gray-50 p-2 dark:bg-gray-900">
            <p className="font-bold text-gray-900 dark:text-white">{title}</p>
            {rows.length === 0 ? (
                <p className="mt-1 text-gray-500 dark:text-gray-400">대상 없음</p>
            ) : (
                <div className="mt-1 space-y-1">
                    {rows.map((row) => (
                        <p key={`${title}-${row.studentId}-${row.slotKey}`} className="text-gray-600 dark:text-gray-300">
                            {row.studentName} · {formatSlotLabel(row.slotKey)}
                            {row.targetStatus ? ` → ${row.targetStatus}` : ""}
                        </p>
                    ))}
                </div>
            )}
        </div>
    );
}

function totalRelinkCount(counts: RelinkCounts) {
    return counts.registration + counts.shuttle + counts.team;
}

function relinkRowKey(row: Pick<RelinkReviewRow, "kind" | "id">) {
    return `${row.kind}:${row.id}`;
}

function RelinkPreviewBox({
    preview,
    applying,
    manualApplyingId,
    studentOptions,
    studentOptionsLoading,
    selections,
    onSelectionChange,
    onApplyAuto,
    onApplyManual,
    onCreateTeamStudent,
}: {
    preview: RelinkPreview;
    applying: boolean;
    manualApplyingId: string | null;
    studentOptions: StudentOption[];
    studentOptionsLoading: boolean;
    selections: Record<string, string>;
    onSelectionChange: (rowKey: string, studentId: string) => void;
    onApplyAuto: () => void;
    onApplyManual: (row: RelinkReviewRow, studentId: string) => void;
    onCreateTeamStudent: (row: RelinkReviewRow) => void;
}) {
    const applyReadyTotal = totalRelinkCount(preview.applyReady);
    const weakTotal = totalRelinkCount(preview.weakOnly);
    const unmatchedTotal = totalRelinkCount(preview.unmatched);
    const ignoredTotal = totalRelinkCount(preview.ignored);
    const scannedTotal = totalRelinkCount(preview.scanned);
    const reviewableTotal = scannedTotal - ignoredTotal;
    const studentOptionById = new Map(studentOptions.map((student) => [student.id, student]));

    return (
        <div className="mt-3 rounded-lg border border-gray-200 bg-white p-3 text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
            <div className="grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-3 lg:grid-cols-6">
                <ImportSummaryMetric label="검토" value={scannedTotal} warning={scannedTotal > 0} />
                <ImportSummaryMetric label="실제 후보" value={reviewableTotal} warning={reviewableTotal > 0} />
                <ImportSummaryMetric label="확정 후보" value={applyReadyTotal} warning={applyReadyTotal > 0} />
                <ImportSummaryMetric label="이름 후보" value={weakTotal} warning={weakTotal > 0} />
                <ImportSummaryMetric label="후보 없음" value={unmatchedTotal} warning={unmatchedTotal > 0} />
                <ImportSummaryMetric label="검토 제외" value={ignoredTotal} />
            </div>

            <div className="mt-3 flex flex-col gap-2 text-xs text-gray-600 dark:text-gray-300 sm:flex-row sm:items-center sm:justify-between">
                <span>
                    빈 서식 행은 검토 제외로 분리하고, 이름·연락처·생년월일 등 단서가 있는 행만 연결 후보로 보여줍니다. 후보 없음 {unmatchedTotal}건은 수동 확인이 필요합니다.
                </span>
                <button
                    type="button"
                    onClick={onApplyAuto}
                    disabled={applying || applyReadyTotal === 0}
                    className="rounded-lg bg-gray-900 px-3 py-2 font-bold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-neon-lime dark:text-gray-950 dark:hover:bg-lime-200"
                >
                    {applying ? "적용 중" : applyReadyTotal === 0 ? "확정 후보 없음" : "확정 후보 적용"}
                </button>
            </div>

            <div className="mt-3 overflow-hidden rounded-lg border border-gray-100 dark:border-gray-800">
                {preview.reviewRows.length === 0 ? (
                    <div className="bg-gray-50 px-3 py-4 text-center text-xs text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                        재연결이 필요한 원본 행이 없습니다.
                    </div>
                ) : (
                    <div className="divide-y divide-gray-100 text-xs dark:divide-gray-800">
                        {preview.reviewRows.map((row) => {
                            const key = relinkRowKey(row);
                            const selectedStudentId = selections[key] ?? row.match?.studentId ?? "";
                            const matchedStudent = row.match ? studentOptionById.get(row.match.studentId) : null;
                            const matchLabel = row.match
                                ? row.match.confidence === "weak"
                                    ? "이름 후보"
                                    : "확정 후보"
                                : "후보 없음";

                            return (
                                <div key={key} className="grid gap-2 bg-white px-3 py-3 dark:bg-gray-950 md:grid-cols-[1.1fr_1.1fr_1.5fr_auto] md:items-center">
                                    <div>
                                        <p className="font-bold text-gray-900 dark:text-white">
                                            {RELINK_KIND_LABELS[row.kind]} · {row.sheetName} {row.rowNumber}행
                                        </p>
                                        <p className="mt-0.5 text-gray-500 dark:text-gray-400">
                                            {row.studentName || "이름 없음"}
                                        </p>
                                    </div>
                                    <div className="text-gray-600 dark:text-gray-300">
                                        <p>학생 {formatPhone(row.studentPhone)}</p>
                                        <p>보호자 {formatPhone(row.parentPhone)}</p>
                                    </div>
                                    <div>
                                        <div className="mb-1 flex flex-wrap items-center gap-2">
                                            <span
                                                className={`rounded-full px-2 py-0.5 font-bold ${
                                                    row.match
                                                        ? row.match.confidence === "weak"
                                                            ? "bg-amber-100 text-amber-800 dark:bg-amber-300/15 dark:text-amber-100"
                                                            : "bg-lime-100 text-lime-800 dark:bg-lime-300/15 dark:text-lime-100"
                                                        : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                                                }`}
                                            >
                                                {matchLabel}
                                            </span>
                                            {matchedStudent && (
                                                <span className="text-gray-500 dark:text-gray-400">
                                                    {matchedStudent.name}
                                                    {matchedStudent.parent?.name ? ` (${matchedStudent.parent.name})` : ""}
                                                </span>
                                            )}
                                        </div>
                                        <select
                                            value={selectedStudentId}
                                            onChange={(event) => onSelectionChange(key, event.target.value)}
                                            disabled={studentOptionsLoading}
                                            className="w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-xs text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                                        >
                                            <option value="">
                                                {studentOptionsLoading ? "학생 목록 불러오는 중" : "연결할 학생 선택"}
                                            </option>
                                            {studentOptions.map((student) => (
                                                <option key={student.id} value={student.id}>
                                                    {student.name}
                                                    {student.parent?.name ? ` (${student.parent.name})` : ""}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    <div className="flex flex-col gap-2">
                                        <button
                                            type="button"
                                            onClick={() => onApplyManual(row, selectedStudentId)}
                                            disabled={!selectedStudentId || manualApplyingId === row.id}
                                            className="rounded-lg border border-gray-200 px-3 py-2 font-bold text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-900"
                                        >
                                            {manualApplyingId === row.id ? "처리 중" : "연결"}
                                        </button>
                                        {row.kind === "team" && !row.match && row.canCreateStudent && (
                                            <button
                                                type="button"
                                                onClick={() => onCreateTeamStudent(row)}
                                                disabled={manualApplyingId === row.id}
                                                className="rounded-lg bg-lime-100 px-3 py-2 font-bold text-lime-900 transition hover:bg-lime-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-brand-neon-lime dark:text-gray-950 dark:hover:bg-lime-200"
                                            >
                                                {manualApplyingId === row.id ? "생성 중" : "새 학생 생성"}
                                            </button>
                                        )}
                                        {row.kind === "team" && !row.match && !row.canCreateStudent && row.createBlockedReason && (
                                            <span className="rounded-lg bg-amber-50 px-3 py-2 text-center text-[11px] font-bold text-amber-800 dark:bg-amber-300/15 dark:text-amber-100">
                                                {row.createBlockedReason}
                                            </span>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

function toDateStr(d: Date | string | null): string {
    if (!d) return "";
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().split("T")[0];
}

/**
 * 학년 문자열을 간결하게 변환하는 유틸 함수
 * "2026년 초등 4학년" -> "초4", "2026년 중등 1학년" -> "중1", "성인" -> "성인"
 */
function shortenGrade(grade: string | null): string {
    if (!grade) return "-";
    if (grade === "성인") return "성인";
    // "초등 N학년" 패턴 매칭 (연도 접두사 무시)
    const elemMatch = grade.match(/초등\s*(\d)/);
    if (elemMatch) return `초${elemMatch[1]}`;
    // "중등 N학년" 패턴 매칭
    const midMatch = grade.match(/중등\s*(\d)/);
    if (midMatch) return `중${midMatch[1]}`;
    // "고등 N학년" 패턴 매칭
    const highMatch = grade.match(/고등\s*(\d)/);
    if (highMatch) return `고${highMatch[1]}`;
    // 매칭 안 되면 원본 그대로
    return grade;
}

/**
 * 수강 반 이름을 간결하게 변환: "월요일 6교시" -> "월6"
 * slotKey가 있으면 slotKey(예: "Mon-4") 활용, 없으면 className에서 추출
 */
function shortenClassName(enrollment: { dayOfWeek: string; className: string; slotKey?: string | null }): string {
    const dayLabel = DAY_LABELS[enrollment.dayOfWeek] || enrollment.dayOfWeek;
    // slotKey에서 교시 번호 추출 (예: "Mon-4" -> 4)
    if (enrollment.slotKey) {
        const match = enrollment.slotKey.match(/-(\d+)$/);
        if (match) return `${dayLabel}${match[1]}`;
    }
    // className에서 교시 번호 추출 (예: "월요일 6교시" -> 6)
    const periodMatch = enrollment.className.match(/(\d+)\s*교시/);
    if (periodMatch) return `${dayLabel}${periodMatch[1]}`;
    // 추출 실패 시 요일 + 반이름 축약
    return `${dayLabel}`;
}

/**
 * 전화번호에 하이픈 포맷 적용: "01052594903" -> "010-5259-4903"
 */
function formatPhone(phone: string | null): string {
    if (!phone) return "-";
    // 이미 하이픈이 있으면 그대로 반환
    if (phone.includes("-")) return phone;
    // 숫자만 추출
    const digits = phone.replace(/\D/g, "");
    // 010-XXXX-XXXX (11자리)
    if (digits.length === 11) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
    // 02-XXXX-XXXX (10자리, 서울)
    if (digits.length === 10 && digits.startsWith("02")) return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6)}`;
    // 0XX-XXX-XXXX (10자리, 지역번호)
    if (digits.length === 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
    return phone;
}

/**
 * 학부모 이름을 간결하게 표시
 * "기타(기본 보호자)" -> "보호자", "기타(본인)" -> "본인"
 */
function shortenParentName(name: string | null): string {
    if (!name) return "-";
    if (name === "기타(기본 보호자)" || name === "기본 보호자") return "보호자";
    if (name === "기타(본인)") return "본인";
    // "기타(...)" 패턴에서 괄호 안의 내용만 추출
    const etcMatch = name.match(/^기타\((.+)\)$/);
    if (etcMatch) return etcMatch[1];
    return name;
}

/**
 * 학생의 대표 상태를 판단하는 헬퍼 함수
 * - ACTIVE가 1개라도 있으면 "ACTIVE" (활성 수강이 있으니까)
 * - 없으면 가장 최근 enrollment의 status를 사용
 */
function getLatestStatus(enrollments: Student["enrollments"]): string | null {
    if (!enrollments || enrollments.length === 0) return null;
    let latest = enrollments[0];
    let latestTime = latest.createdAt ? new Date(latest.createdAt).getTime() : 0;

    for (const enrollment of enrollments) {
        if (enrollment.status === "ACTIVE") return "ACTIVE";

        const createdAt = enrollment.createdAt ? new Date(enrollment.createdAt).getTime() : 0;
        if (createdAt > latestTime) {
            latest = enrollment;
            latestTime = createdAt;
        }
    }

    return latest.status;
}

function getStatusLabel(status: string | null) {
    if (status === "ACTIVE") return "활성";
    if (status === "PAUSED") return "휴원";
    if (status === "WITHDRAWN") return "퇴원";
    return "미배정";
}

function getStatusPillClass(status: string | null) {
    if (status === "ACTIVE") return "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-300/10 dark:text-emerald-100 dark:ring-emerald-300/20";
    if (status === "PAUSED") return "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-300/10 dark:text-amber-100 dark:ring-amber-300/20";
    if (status === "WITHDRAWN") return "bg-red-50 text-red-700 ring-red-200 dark:bg-red-300/10 dark:text-red-100 dark:ring-red-300/20";
    return "bg-gray-50 text-gray-500 ring-gray-200 dark:bg-gray-900 dark:text-gray-300 dark:ring-gray-700";
}

function getActiveEnrollments(enrollments: Student["enrollments"]) {
    return (enrollments ?? []).filter((enrollment) => enrollment.status === "ACTIVE");
}

export default function StudentManagementClient({
    students: initialStudents,
    classes: initialClasses,
    sheetImportSummary: initialSheetImportSummary,
    partial: initialPartial = false,
    sheetRetired = false,
}: {
    students?: Student[];
    classes?: ClassItem[];
    sheetImportSummary?: SheetImportSummary;
    partial?: boolean;
    // 구글 시트 원장 은퇴 여부 — true 면 시트 정합성 점검·재연결 버튼(점검 도구)을 숨긴다.
    // 과거 시트 이력(월 상태·월별 이력·이관 요약 숫자) 표시는 그대로 둔다.
    sheetRetired?: boolean;
}) {
    const hasInitialData = Boolean(initialStudents || initialClasses);
    const [students, setStudents] = useState<Student[]>(initialStudents ?? []);
    const [classes, setClasses] = useState<ClassItem[]>(initialClasses ?? []);
    const [sheetImportSummary, setSheetImportSummary] = useState<SheetImportSummary>(
        initialSheetImportSummary ?? null
    );
    const [dataLoading, setDataLoading] = useState(!hasInitialData);
    const [dataError, setDataError] = useState<string | null>(null);
    const [allStudentsLoaded, setAllStudentsLoaded] = useState(!initialPartial);
    const [backgroundLoading, setBackgroundLoading] = useState(false);
    const [currentRosterReport, setCurrentRosterReport] = useState<CurrentRosterReport | null>(null);
    const [currentRosterLoading, setCurrentRosterLoading] = useState(false);
    const [currentRosterError, setCurrentRosterError] = useState<string | null>(null);
    const [sheetImportSummaryLoading, setSheetImportSummaryLoading] = useState(false);
    const [sheetImportSummaryError, setSheetImportSummaryError] = useState<string | null>(null);
    const [reconcilePreview, setReconcilePreview] = useState<ReconcilePreview | null>(null);
    const [reconcileLoading, setReconcileLoading] = useState(false);
    const [reconcileApplying, setReconcileApplying] = useState(false);
    const [reconcileError, setReconcileError] = useState<string | null>(null);
    const [relinkPreview, setRelinkPreview] = useState<RelinkPreview | null>(null);
    const [relinkLoading, setRelinkLoading] = useState(false);
    const [relinkApplying, setRelinkApplying] = useState(false);
    const [relinkError, setRelinkError] = useState<string | null>(null);
    const [manualRelinkApplyingId, setManualRelinkApplyingId] = useState<string | null>(null);
    const [studentOptions, setStudentOptions] = useState<StudentOption[]>([]);
    const [studentOptionsLoading, setStudentOptionsLoading] = useState(false);
    const [manualRelinkSelections, setManualRelinkSelections] = useState<Record<string, string>>({});
    const [autoLoadRequested, setAutoLoadRequested] = useState(false);
    const [showImportTools, setShowImportTools] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [search, setSearch] = useState("");
    const [enrollModal, setEnrollModal] = useState<string | null>(null);
    // 엑셀 업로드 모달 열기/닫기 상태
    const [showExcelUpload, setShowExcelUpload] = useState(false);

    // 필터 상태: 반/학년/학교/수강상태
    const [filterClass, setFilterClass] = useState("");
    const [filterGrade, setFilterGrade] = useState("");
    const [filterSchool, setFilterSchool] = useState("");

    const loadData = useCallback(async ({ background = false }: { background?: boolean } = {}) => {
        if (background) setBackgroundLoading(true);
        else setDataLoading(true);
        setDataError(null);

        try {
            const response = await fetch("/api/admin/students", {
                cache: "no-store",
            });

            if (!response.ok) {
                throw new Error("Failed to load students.");
            }

            const data = (await response.json()) as {
                students?: Student[];
                classes?: ClassItem[];
            };

            setStudents(data.students ?? []);
            setClasses(data.classes ?? []);
            setAllStudentsLoaded(true);
        } catch (error) {
            console.error("Failed to load students:", error);
            setDataError("원생 목록을 불러오지 못했습니다.");
        } finally {
            if (background) setBackgroundLoading(false);
            else setDataLoading(false);
        }
    }, []);

    const loadSheetImportSummary = useCallback(async () => {
        if (sheetImportSummaryLoading) return;

        setSheetImportSummaryLoading(true);
        setSheetImportSummaryError(null);

        try {
            const response = await fetch("/api/admin/students/import-summary", {
                cache: "no-store",
            });
            const data = (await response.json()) as {
                sheetImportSummary?: SheetImportSummary;
                error?: string;
            };

            if (!response.ok) {
                throw new Error(data.error || "시트 이관 요약을 불러오지 못했습니다.");
            }

            setSheetImportSummary(data.sheetImportSummary ?? null);
            setShowImportTools(true);
        } catch (error) {
            setSheetImportSummaryError(error instanceof Error ? error.message : "시트 이관 요약을 불러오지 못했습니다.");
        } finally {
            setSheetImportSummaryLoading(false);
        }
    }, [sheetImportSummaryLoading]);

    const requestFullStudentLoad = useCallback(() => {
        if (allStudentsLoaded || backgroundLoading) return;

        setAutoLoadRequested(true);
        void loadData({ background: true });
    }, [allStudentsLoaded, backgroundLoading, loadData]);

    const ensureStudentOptions = useCallback(async () => {
        if (studentOptions.length > 0 || studentOptionsLoading) return;

        setStudentOptionsLoading(true);
        try {
            const response = await fetch("/api/admin/student-options", {
                cache: "no-store",
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "학생 선택 목록을 불러오지 못했습니다.");
            }

            setStudentOptions(data.students ?? []);
        } catch (error) {
            setRelinkError(error instanceof Error ? error.message : "학생 선택 목록을 불러오지 못했습니다.");
        } finally {
            setStudentOptionsLoading(false);
        }
    }, [studentOptions.length, studentOptionsLoading]);

    const loadCurrentRosterReport = useCallback(async () => {
        setCurrentRosterLoading(true);
        setCurrentRosterError(null);

        try {
            // month 를 넘기지 않으면 API 가 장부에 있는 가장 최근 달을 자동으로 고른다.
            // 예전에는 month=7 이 박혀 있어 달이 바뀌어도 계속 7월 수치를 "현재"로 보여줬다.
            const response = await fetch("/api/admin/import-students/current-roster", {
                cache: "no-store",
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "최신 원생목록 점검에 실패했습니다.");
            }

            setCurrentRosterReport(data as CurrentRosterReport);
        } catch (error) {
            setCurrentRosterError(error instanceof Error ? error.message : "최신 원생목록 점검에 실패했습니다.");
        } finally {
            setCurrentRosterLoading(false);
        }
    }, []);

    const loadReconcilePreview = useCallback(async () => {
        setReconcileLoading(true);
        setReconcileError(null);

        try {
            const response = await fetch("/api/admin/import-students/reconcile", {
                cache: "no-store",
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "시간표 차이 점검에 실패했습니다.");
            }

            setReconcilePreview(data as ReconcilePreview);
        } catch (error) {
            setReconcileError(error instanceof Error ? error.message : "시간표 차이 점검에 실패했습니다.");
        } finally {
            setReconcileLoading(false);
        }
    }, []);

    const loadRelinkPreview = useCallback(async () => {
        setRelinkLoading(true);
        setRelinkError(null);

        try {
            const response = await fetch("/api/admin/import-students/relink?reviewLimit=30", {
                cache: "no-store",
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "미연결 원본 점검에 실패했습니다.");
            }

            setRelinkPreview(data as RelinkPreview);
            if ((data.reviewRows ?? []).length > 0) {
                void ensureStudentOptions();
            }
        } catch (error) {
            setRelinkError(error instanceof Error ? error.message : "미연결 원본 점검에 실패했습니다.");
        } finally {
            setRelinkLoading(false);
        }
    }, [ensureStudentOptions]);

    // applyWithdrawals = true 일 때만 퇴원 후보까지 확정한다. 기본값은 예전과 완전히 동일한 동작.
    const applyReconcile = useCallback(async (options?: { applyWithdrawals?: boolean }) => {
        const applyWithdrawals = options?.applyWithdrawals === true;
        const message = applyWithdrawals
            ? "휴원 한도를 넘겨 사라진 학생을 퇴원 처리할까요? 반 명단에서 빠지고 청구가 중단됩니다. (시트에 다시 나타나면 복원됩니다)"
            : "최신 시트 원장을 기준으로 수강 등록 상태를 맞출까요? 삭제는 하지 않고 상태만 정리합니다.";

        if (!confirm(message)) {
            return;
        }

        setReconcileApplying(true);
        setReconcileError(null);

        try {
            const response = await fetch("/api/admin/import-students/reconcile", {
                method: "POST",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ applyWithdrawals }),
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "시트 기준 적용에 실패했습니다.");
            }

            setReconcilePreview((data.after ?? null) as ReconcilePreview | null);
            await loadData({ background: true });
        } catch (error) {
            setReconcileError(error instanceof Error ? error.message : "시트 기준 적용에 실패했습니다.");
        } finally {
            setReconcileApplying(false);
        }
    }, [loadData]);

    const applyRelink = useCallback(async () => {
        if (!confirm("연락처나 생년월일로 확인된 미연결 원본 행을 기존 학생과 연결할까요? 이름만 맞는 후보는 자동 적용하지 않습니다.")) {
            return;
        }

        setRelinkApplying(true);
        setRelinkError(null);

        try {
            const response = await fetch("/api/admin/import-students/relink", {
                method: "POST",
                cache: "no-store",
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "미연결 원본 적용에 실패했습니다.");
            }

            setRelinkPreview((data.after ?? null) as RelinkPreview | null);
            await loadData({ background: true });
        } catch (error) {
            setRelinkError(error instanceof Error ? error.message : "미연결 원본 적용에 실패했습니다.");
        } finally {
            setRelinkApplying(false);
        }
    }, [loadData]);

    const applyManualRelink = useCallback(async (row: RelinkReviewRow, studentId: string) => {
        if (!studentId) return;

        const student = studentOptions.find((option) => option.id === studentId);
        const label = student
            ? `${student.name}${student.parent?.name ? ` (${student.parent.name})` : ""}`
            : "선택한 학생";

        if (!confirm(`${row.studentName || "이름 없는 원본 행"}을 ${label}에게 연결할까요?`)) {
            return;
        }

        setManualRelinkApplyingId(row.id);
        setRelinkError(null);

        try {
            const response = await fetch("/api/admin/import-students/relink", {
                method: "POST",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "manual",
                    kind: row.kind,
                    id: row.id,
                    studentId,
                }),
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "수동 연결에 실패했습니다.");
            }

            setRelinkPreview((data.after ?? null) as RelinkPreview | null);
            setManualRelinkSelections((current) => {
                const next = { ...current };
                delete next[relinkRowKey(row)];
                return next;
            });
            await loadData({ background: true });
        } catch (error) {
            setRelinkError(error instanceof Error ? error.message : "수동 연결에 실패했습니다.");
        } finally {
            setManualRelinkApplyingId(null);
        }
    }, [loadData, studentOptions]);

    const createTeamStudentFromRow = useCallback(async (row: RelinkReviewRow) => {
        if (row.kind !== "team") return;

        if (!confirm(`${row.studentName || "대표팀 원본 학생"}을 새 학생으로 만들고 이 대표팀 행과 연결할까요? 보호자 정보는 확인 필요 상태로 저장됩니다.`)) {
            return;
        }

        setManualRelinkApplyingId(row.id);
        setRelinkError(null);

        try {
            const response = await fetch("/api/admin/import-students/relink", {
                method: "POST",
                cache: "no-store",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    action: "createStudentFromTeam",
                    kind: row.kind,
                    id: row.id,
                }),
            });
            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || "대표팀 원본으로 학생 생성에 실패했습니다.");
            }

            setRelinkPreview((data.after ?? null) as RelinkPreview | null);
            setStudentOptions([]);
            await loadData({ background: true });
        } catch (error) {
            setRelinkError(error instanceof Error ? error.message : "대표팀 원본으로 학생 생성에 실패했습니다.");
        } finally {
            setManualRelinkApplyingId(null);
        }
    }, [loadData]);

    useEffect(() => {
        if (!hasInitialData) {
            void loadData();
        }
    }, [hasInitialData, loadData]);

    useEffect(() => {
        if (!initialPartial || allStudentsLoaded || backgroundLoading || autoLoadRequested) return;

        const timer = window.setTimeout(() => {
            requestFullStudentLoad();
        }, 700);

        return () => window.clearTimeout(timer);
    }, [allStudentsLoaded, autoLoadRequested, backgroundLoading, initialPartial, requestFullStudentLoad]);
    // 기본 필터를 "활성"으로 설정 — 대부분 수강 중인 학생을 먼저 봄
    const [filterStatus, setFilterStatus] = useState("ACTIVE");
    const [visibleLimit, setVisibleLimit] = useState(STUDENT_PAGE_SIZE);

    // 필터 선택지: 학생 데이터에서 고유값 추출 (useMemo로 캐싱)
    const gradeOptions = useMemo(() => {
        const set = new Set<string>();
        students.forEach((s) => { if (s.grade) set.add(s.grade); });
        return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
    }, [students]);

    const schoolOptions = useMemo(() => {
        const set = new Set<string>();
        students.forEach((s) => { if (s.school) set.add(s.school); });
        return Array.from(set).sort((a, b) => a.localeCompare(b, "ko"));
    }, [students]);

    const studentStatusById = useMemo(() => {
        const statusMap = new Map<string, string | null>();
        students.forEach((student) => {
            statusMap.set(student.id, student.currentStatus ?? getLatestStatus(student.enrollments));
        });
        return statusMap;
    }, [students]);

    // Form state
    const [name, setName] = useState("");
    const [birthDate, setBirthDate] = useState("");
    const [gender, setGender] = useState("");
    const [parentName, setParentName] = useState("");
    const [parentPhone, setParentPhone] = useState("");
    const [parentEmail, setParentEmail] = useState("");
    // 개인정보보호법 준수: 보호자 동의 확인 체크박스 (미성년자 개인정보 수집 시 필수)
    const [guardianConsent, setGuardianConsent] = useState(false);

    function resetForm() {
        setName("");
        setBirthDate("");
        setGender("");
        setParentName("");
        setParentPhone("");
        setParentEmail("");
        setGuardianConsent(false);
        setShowForm(false);
        setEditingId(null);
    }

    function startEdit(s: Student) {
        setName(s.name);
        setBirthDate(toDateStr(s.birthDate));
        setGender(s.gender || "");
        setParentName(s.parent.name || "");
        setParentPhone(s.parent.phone || "");
        setParentEmail(s.parent.email || "");
        setEditingId(s.id);
        setShowForm(true);
    }

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!name.trim() || !birthDate || !parentName.trim()) return;
        // 신규 등록 시 보호자 동의 필수 (개인정보보호법: 미성년자 정보 수집 시 법정대리인 동의)
        if (!editingId && !guardianConsent) {
            alert("보호자 개인정보 수집 동의를 확인해주세요.");
            return;
        }
        setBusy(true);
        try {
            if (editingId) {
                await updateStudent(editingId, {
                    name: name.trim(),
                    birthDate,
                    gender: gender || null,
                    parentName: parentName.trim(),
                    parentPhone: parentPhone.trim() || null,
                });
            } else {
                await createStudent({
                    name: name.trim(),
                    birthDate,
                    gender: gender || null,
                    parentName: parentName.trim(),
                    parentPhone: parentPhone.trim() || null,
                    parentEmail: parentEmail.trim() || null,
                });
            }
            resetForm();
            await loadData();
        } catch (err: unknown) {
            alert(err instanceof Error ? err.message : "저장 실패");
        } finally {
            setBusy(false);
        }
    }

    async function handleDelete(id: string) {
        setBusy(true);
        try {
            await deleteStudent(id);
            await loadData();
        } catch (err: unknown) {
            alert(err instanceof Error ? err.message : "삭제 실패");
        } finally {
            setBusy(false);
        }
    }

    async function handleEnroll(studentId: string, classId: string) {
        setBusy(true);
        try {
            await enrollStudent(studentId, classId);
            setEnrollModal(null);
            await loadData();
        } catch (err: unknown) {
            alert(err instanceof Error ? err.message : "수강 등록 실패");
        } finally {
            setBusy(false);
        }
    }

    // 상태별 학생 수 집계 (상단 요약용)
    // 최신 enrollment 기준으로 학생의 대표 상태를 판단
    const loadedStatusCounts = useMemo(() => {
        let active = 0;
        let paused = 0;
        let withdrawn = 0;
        let noEnrollment = 0;

        for (const s of students) {
            const status = studentStatusById.get(s.id) ?? null;
            if (!status) {
                noEnrollment++;
            } else if (status === "ACTIVE") {
                active++;
            } else if (status === "PAUSED") {
                paused++;
            } else if (status === "WITHDRAWN") {
                withdrawn++;
            } else {
                noEnrollment++;
            }
        }

        return { active, paused, withdrawn, noEnrollment, total: students.length };
    }, [students, studentStatusById]);
    const statusCounts = sheetImportSummary?.studentStatusCounts ?? loadedStatusCounts;

    const applyStatusFilter = useCallback((value: string) => {
        setFilterStatus(value);
        requestFullStudentLoad();
    }, [requestFullStudentLoad]);

    // 검색 + 필터 조합 (AND 조건): useMemo로 캐싱하여 불필요한 재계산 방지
    // 결과를 이름 가나다순으로 정렬
    const filtered = useMemo(() => {
        const query = search.trim().toLowerCase();
        const result = students.filter((s) => {
            // 텍스트 검색
            if (query) {
                const matchSearch =
                    s.name.toLowerCase().includes(query) ||
                    (s.parent.name && s.parent.name.toLowerCase().includes(query)) ||
                    (s.parent.phone && s.parent.phone.includes(query)) ||
                    (s.school && s.school.toLowerCase().includes(query));
                if (!matchSearch) return false;
            }
            // 반(Class) 필터: 해당 반에 수강 중인 학생만
            if (filterClass) {
                const hasClass = s.enrollments?.some((e) => e.classId === filterClass && e.status === "ACTIVE");
                if (!hasClass) return false;
            }
            // 학년 필터
            if (filterGrade && s.grade !== filterGrade) return false;
            // 학교 필터
            if (filterSchool && s.school !== filterSchool) return false;
            // 수강 상태 필터: 최신 enrollment 상태 기준으로 판단
            if (filterStatus) {
                const latestStatus = studentStatusById.get(s.id) ?? null;
                if (filterStatus === "NONE") {
                    if (latestStatus !== null) return false;
                } else {
                    if (latestStatus !== filterStatus) return false;
                }
            }
            return true;
        });
        // 이름 가나다순 정렬 (기본 정렬)
        result.sort((a, b) => a.name.localeCompare(b.name, "ko"));
        return result;
    }, [students, search, filterClass, filterGrade, filterSchool, filterStatus, studentStatusById]);

    useEffect(() => {
        setVisibleLimit(STUDENT_PAGE_SIZE);
    }, [search, filterClass, filterGrade, filterSchool, filterStatus]);

    const visibleStudents = useMemo(
        () => filtered.slice(0, visibleLimit),
        [filtered, visibleLimit],
    );
    const hasMoreStudents = visibleStudents.length < filtered.length;
    const hasAnyFilter = Boolean(search.trim() || filterClass || filterGrade || filterSchool || filterStatus);
    const activeFilterCount = [Boolean(filterClass), Boolean(filterGrade), Boolean(filterSchool), filterStatus !== "ACTIVE"].filter(Boolean).length;
    const filterSummary = [
        filterStatus ? getStatusLabel(filterStatus === "NONE" ? null : filterStatus) : "전체 상태",
        filterClass && (classes.find((item) => item.id === filterClass)?.name ?? "선택한 반"),
        filterGrade,
        filterSchool,
        search.trim() && `검색: ${search.trim()}`,
    ].filter(Boolean).join(" · ");
    const emptyStudentsMessage = !allStudentsLoaded && hasAnyFilter
        ? "전체 원생 목록을 동기화하는 중입니다. 잠시 후 자동으로 결과가 갱신됩니다."
        : hasAnyFilter
            ? "조건에 맞는 원생이 없습니다."
            : "등록된 원생이 없습니다. \"원생 등록\" 버튼으로 새 원생을 등록하세요.";

    if (dataLoading && students.length === 0) {
        return (
            <div className="max-w-5xl mx-auto space-y-6">
                <div className="flex items-center justify-between">
                    <div className="space-y-2">
                        <div className="h-7 w-36 rounded bg-gray-200 animate-pulse dark:bg-gray-700" />
                        <div className="h-4 w-48 rounded bg-gray-100 animate-pulse dark:bg-gray-800" />
                    </div>
                    <div className="h-10 w-28 rounded-lg bg-gray-200 animate-pulse dark:bg-gray-700" />
                </div>
                <div className="h-11 w-full max-w-md rounded-lg bg-gray-100 animate-pulse dark:bg-gray-800" />
                <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
                    {Array.from({ length: 8 }).map((_, index) => (
                        <div
                            key={index}
                            className="h-12 border-b border-gray-100 bg-gray-50/60 animate-pulse last:border-b-0 dark:border-gray-700 dark:bg-gray-900/40"
                        />
                    ))}
                </div>
            </div>
        );
    }

    if (dataError && students.length === 0) {
        return (
            <div className="mx-auto max-w-5xl rounded-xl border border-red-200 bg-red-50 p-8 text-center dark:border-red-900/50 dark:bg-red-950/20">
                <p className="font-bold text-red-700 dark:text-red-200">{dataError}</p>
                <button
                    type="button"
                    onClick={() => void loadData()}
                    className="mt-4 rounded-lg bg-brand-orange-500 px-4 py-2 text-sm font-bold text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                >
                    다시 불러오기
                </button>
            </div>
        );
    }

    return (
        <div className="max-w-5xl mx-auto">
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <h1 className="text-2xl font-extrabold text-gray-900 dark:text-white">원생 관리</h1>
                <p className="text-xs text-[var(--color-academy-muted)]">
                    {sheetImportSummary?.studentStatusCounts ? "시트 기준" : allStudentsLoaded ? "전체 목록" : "불러온 목록"} {statusCounts.total}명
                    {" · "}활성 {statusCounts.active} · 휴원 {statusCounts.paused} · 퇴원 {statusCounts.withdrawn} · 미배정 {statusCounts.noEnrollment}
                </p>
            </div>

            <CompactListFilters
                activeCount={activeFilterCount}
                summary={filterSummary}
                resultCount={`${filtered.length}명${!allStudentsLoaded ? " · 전체 동기화 중" : ""}`}
                onReset={() => {
                    setFilterClass("");
                    setFilterGrade("");
                    setFilterSchool("");
                    setFilterStatus("ACTIVE");
                    requestFullStudentLoad();
                }}
                search={
                    <input
                        type="search"
                        aria-label="원생 검색"
                        placeholder="이름·학부모·연락처·학교 검색"
                        value={search}
                        onChange={(e) => {
                            setSearch(e.target.value);
                            if (e.target.value.trim()) requestFullStudentLoad();
                        }}
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                    />
                }
                actions={
                    <div className="flex flex-wrap items-center gap-2">
                        {!allStudentsLoaded && (
                            <button
                                type="button"
                                onClick={() => void loadData({ background: true })}
                                disabled={backgroundLoading}
                                className="min-h-11 rounded-lg border border-gray-300 px-3 py-2 text-sm font-bold text-gray-700 transition hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
                            >
                                {backgroundLoading ? "전체 불러오는 중" : "전체 목록 불러오기"}
                            </button>
                        )}
                        {/* 엑셀 일괄 업로드 버튼 — 랠리즈 다운로드 파일용 */}
                        <button
                            onClick={() => setShowExcelUpload(true)}
                            className="min-h-11 bg-emerald-600 text-white px-3 py-2 rounded-lg font-bold hover:bg-emerald-700 transition"
                        >
                            엑셀 업로드
                        </button>
                        {/* 기존 1명씩 수동 등록 버튼 */}
                        <button
                            onClick={() => { resetForm(); setShowForm(true); }}
                            className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white min-h-11 px-3 py-2 rounded-lg font-bold hover:bg-orange-600 transition"
                        >
                            + 원생 등록
                        </button>
                    </div>
                }
            >
                <div className="col-span-full grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {/* 반(Class) 필터 */}
                    <select
                        aria-label="반"
                        value={filterClass}
                        onChange={(e) => {
                            setFilterClass(e.target.value);
                            if (e.target.value) requestFullStudentLoad();
                        }}
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                    >
                        <option value="">전체 반</option>
                        {classes.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.name} ({DAY_LABELS[c.dayOfWeek] || c.dayOfWeek} {c.startTime})
                            </option>
                        ))}
                    </select>
                    {/* 학년 필터 */}
                    <select
                        aria-label="학년"
                        value={filterGrade}
                        onChange={(e) => {
                            setFilterGrade(e.target.value);
                            if (e.target.value) requestFullStudentLoad();
                        }}
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                    >
                        <option value="">전체 학년</option>
                        {gradeOptions.map((g) => (
                            <option key={g} value={g}>{g}</option>
                        ))}
                    </select>
                    {/* 학교 필터 */}
                    <select
                        aria-label="학교"
                        value={filterSchool}
                        onChange={(e) => {
                            setFilterSchool(e.target.value);
                            if (e.target.value) requestFullStudentLoad();
                        }}
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                    >
                        <option value="">전체 학교</option>
                        {schoolOptions.map((sc) => (
                            <option key={sc} value={sc}>{sc}</option>
                        ))}
                    </select>
                    {/* 수강 상태 필터 */}
                    <select
                        aria-label="수강 상태"
                        value={filterStatus}
                        onChange={(e) => applyStatusFilter(e.target.value)}
                        className="min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 py-2 text-[17px] text-[var(--color-academy-ink)] focus:ring-2 focus:ring-[var(--color-academy-primary)]"
                    >
                        <option value="">전체 상태</option>
                        <option value="ACTIVE">활성</option>
                        <option value="PAUSED">휴원</option>
                        <option value="WITHDRAWN">퇴원</option>
                        <option value="NONE">미배정</option>
                    </select>

                </div>
            </CompactListFilters>

            {/* Form */}
            <details className="mt-4 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4 py-2">
                <summary className="min-h-11 cursor-pointer content-center text-sm font-bold text-[var(--color-academy-muted)]">원생 자료 점검</summary>
                <div className="pt-2">
            {!sheetImportSummary && (
                <div className="mb-5 flex flex-col gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-900 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <p className="text-sm font-bold text-gray-900 dark:text-white">운영 데이터 점검</p>
                        {sheetImportSummaryError && (
                            <p className="mt-2 text-xs font-semibold text-red-600 dark:text-red-300">
                                {sheetImportSummaryError}
                            </p>
                        )}
                    </div>
                    <button
                        type="button"
                        onClick={() => void loadSheetImportSummary()}
                        disabled={sheetImportSummaryLoading}
                        className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-700 transition hover:bg-gray-50 disabled:cursor-wait disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                    >
                        {sheetImportSummaryLoading ? "불러오는 중" : "점검 불러오기"}
                    </button>
                </div>
            )}
            {sheetImportSummary && (
                <div className="mb-5 rounded-xl border border-lime-300/40 bg-white p-4 shadow-sm dark:border-lime-300/30 dark:bg-gray-900">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                        <div>
                            <div className="flex flex-wrap items-center gap-2">
                                <span
                                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                                        sheetImportSummary.status === "COMPLETED" && sheetImportSummary.errorRows === 0
                                            ? "bg-lime-100 text-lime-800 dark:bg-lime-300/15 dark:text-lime-200"
                                            : "bg-amber-100 text-amber-800 dark:bg-amber-300/15 dark:text-amber-100"
                                    }`}
                                >
                                    {sheetImportSummary.status === "COMPLETED" && sheetImportSummary.errorRows === 0
                                        ? "DB 이관 정상"
                                        : `DB 이관 ${sheetImportSummary.status}`}
                                </span>
                                <span className="text-sm font-bold text-gray-900 dark:text-white">
                                    최신 운영 데이터
                                </span>
                            </div>
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                                최신 반영:{" "}
                                {sheetImportSummary.completedAt
                                    ? new Date(sheetImportSummary.completedAt).toLocaleString("ko-KR")
                                    : new Date(sheetImportSummary.createdAt).toLocaleString("ko-KR")}
                            </p>
                        </div>
                        {/* 시트 원장 은퇴면 「점검 도구」 열기 버튼 자체를 숨긴다(점검·재연결 API 는 그대로 둠) */}
                        {!sheetRetired && (
                        <button
                            type="button"
                            onClick={() => setShowImportTools((current) => !current)}
                            className="rounded-lg border border-gray-200 px-3 py-2 text-xs font-bold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
                        >
                            {showImportTools ? "점검 도구 닫기" : "점검 도구"}
                        </button>
                        )}
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-center text-xs sm:grid-cols-4 lg:grid-cols-8">
                            <ImportSummaryMetric label="현재 기준" value={sheetImportSummary.studentStatusCounts?.total ?? statusCounts.total} />
                            <ImportSummaryMetric label="최신 원생" value={sheetImportSummary.uniqueStudents} />
                            <ImportSummaryMetric label="등록" value={sheetImportSummary.registrationRows} />
                            <ImportSummaryMetric label="차량" value={sheetImportSummary.vehicleRows} />
                            <ImportSummaryMetric label="변동" value={sheetImportSummary.changeRows} />
                            <ImportSummaryMetric label="대표팀" value={sheetImportSummary.teamRows} />
                            <ImportSummaryMetric
                                label="시간표"
                                value={sheetImportSummary.scheduleMismatchCount}
                                warning={sheetImportSummary.scheduleMismatchCount > 0}
                            />
                            <ImportSummaryMetric
                                label="확인"
                                value={sheetImportSummary.errorRows}
                                warning={sheetImportSummary.errorRows > 0}
                            />
                    </div>

                    {!allStudentsLoaded && (
                        <p className="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500 dark:bg-gray-950 dark:text-gray-400">
                            빠른 진입을 위해 먼저 50명을 표시했습니다. 전체 원생 목록과 필터는 백그라운드에서 동기화 중입니다.
                        </p>
                    )}

                    {!sheetRetired && showImportTools && (
                        <div className="mt-3 space-y-3 border-t border-gray-100 pt-3 dark:border-gray-800">
                            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <p className="font-bold">최신 원생목록 점검</p>
                                        <p className="mt-1 text-gray-500 dark:text-gray-400">
                                            실제 변경 없이 최신 등록 행의 학생 연결, 이전 이력, 중복 의심 항목을 확인합니다.
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => void loadCurrentRosterReport()}
                                        disabled={currentRosterLoading}
                                        className="rounded-lg bg-gray-900 px-3 py-2 font-bold text-white transition hover:bg-gray-800 disabled:cursor-wait disabled:opacity-60 dark:bg-brand-neon-lime dark:text-gray-950 dark:hover:bg-lime-200"
                                    >
                                        {currentRosterLoading ? "점검 중" : "상세 점검"}
                                    </button>
                                </div>
                                {currentRosterError && (
                                    <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
                                        {currentRosterError}
                                    </div>
                                )}
                                {currentRosterReport && <CurrentRosterReportBox report={currentRosterReport} />}
                            </div>

                            {sheetImportSummary.scheduleMismatchCount > 0 && (
                                <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-lime-300/25 dark:bg-lime-300/10 dark:text-lime-100">
                                    <p className="font-bold">
                                        시트 등록 인원과 DB 활성 수강 인원이 다른 반이 {sheetImportSummary.scheduleMismatchCount}개 있습니다.
                                    </p>
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {sheetImportSummary.topScheduleMismatches.map((item) => (
                                            <span
                                                key={item.slotKey}
                                                className="rounded-full bg-white px-2 py-1 font-semibold text-amber-900 ring-1 ring-amber-200 dark:bg-gray-950 dark:text-lime-100 dark:ring-lime-300/25"
                                            >
                                                {formatSlotLabel(item.slotKey)} 시트 {item.sheetCount} / DB {item.dbCount}
                                                {" "}
                                                ({item.diff > 0 ? `+${item.diff}` : item.diff})
                                            </span>
                                        ))}
                                        {sheetImportSummary.scheduleMismatchCount > sheetImportSummary.topScheduleMismatches.length && (
                                            <span className="rounded-full px-2 py-1 font-semibold text-amber-800 dark:text-lime-200">
                                                외 {sheetImportSummary.scheduleMismatchCount - sheetImportSummary.topScheduleMismatches.length}개
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-3 flex flex-wrap items-center gap-2">
                                        <button
                                            type="button"
                                            onClick={() => void loadReconcilePreview()}
                                            disabled={reconcileLoading}
                                            className="rounded-lg bg-amber-700 px-3 py-2 text-xs font-bold text-white transition hover:bg-amber-800 disabled:cursor-wait disabled:opacity-60 dark:bg-brand-neon-lime dark:text-gray-950 dark:hover:bg-lime-200"
                                        >
                                            {reconcileLoading ? "점검 중" : "차이 점검"}
                                        </button>
                                    </div>
                                    {reconcileError && (
                                        <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
                                            {reconcileError}
                                        </div>
                                    )}
                                    {reconcilePreview && (
                                        <ReconcilePreviewBox
                                            preview={reconcilePreview}
                                            applying={reconcileApplying}
                                            onApply={() => void applyReconcile()}
                                            onApplyWithdrawals={() => void applyReconcile({ applyWithdrawals: true })}
                                        />
                                    )}
                                </div>
                            )}

                            <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div>
                                        <p className="font-bold">차량·대표팀 원본 학생 연결 점검</p>
                                        <p className="mt-1 text-gray-500 dark:text-gray-400">
                                            시트 원본 중 기존 학생과 아직 연결되지 않은 행을 확인하고, 확정 후보 또는 수동 선택으로 연결합니다.
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => void loadRelinkPreview()}
                                        disabled={relinkLoading}
                                        className="rounded-lg bg-gray-900 px-3 py-2 font-bold text-white transition hover:bg-gray-800 disabled:cursor-wait disabled:opacity-60 dark:bg-brand-neon-lime dark:text-gray-950 dark:hover:bg-lime-200"
                                    >
                                        {relinkLoading ? "점검 중" : "미연결 점검"}
                                    </button>
                                </div>
                                {relinkError && (
                                    <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100">
                                        {relinkError}
                                    </div>
                                )}
                                {relinkPreview && (
                                    <RelinkPreviewBox
                                        preview={relinkPreview}
                                        applying={relinkApplying}
                                        manualApplyingId={manualRelinkApplyingId}
                                        studentOptions={studentOptions}
                                        studentOptionsLoading={studentOptionsLoading}
                                        selections={manualRelinkSelections}
                                        onSelectionChange={(rowKey, studentId) =>
                                            setManualRelinkSelections((current) => ({
                                                ...current,
                                                [rowKey]: studentId,
                                            }))
                                        }
                                        onApplyAuto={() => void applyRelink()}
                                        onApplyManual={(row, studentId) => void applyManualRelink(row, studentId)}
                                        onCreateTeamStudent={(row) => void createTeamStudentFromRow(row)}
                                    />
                                )}
                            </div>
                        </div>
                    )}
                </div>
            )}

                </div>
            </details>

            {showForm && (
                <form onSubmit={handleSubmit} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl p-6 mb-6 shadow-sm space-y-4">
                    <h3 className="font-bold text-lg text-gray-900 dark:text-white">{editingId ? "원생 수정" : "새 원생 등록"}</h3>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">이름 *</label>
                            <input
                                value={name}
                                onChange={(e) => setName(e.target.value)}
                                required
                                placeholder="홍길동"
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">생년월일 *</label>
                            <input
                                type="text"
                                inputMode="numeric"
                                placeholder="YYYY-MM-DD"
                                pattern="\d{4}-\d{2}-\d{2}"
                                title="YYYY-MM-DD 형식으로 입력해주세요."
                                maxLength={10}
                                value={birthDate}
                                onChange={(e) => {
                                    const digits = e.target.value.replace(/\D/g, "").slice(0, 8);
                                    const formatted = [
                                        digits.slice(0, 4),
                                        digits.slice(4, 6),
                                        digits.slice(6, 8),
                                    ].filter(Boolean).join("-");
                                    setBirthDate(formatted);
                                }}
                                required
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">성별</label>
                            <select
                                value={gender}
                                onChange={(e) => setGender(e.target.value)}
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            >
                                <option value="">선택 안함</option>
                                <option value="남">남</option>
                                <option value="여">여</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">학부모 이름 *</label>
                            <input
                                value={parentName}
                                onChange={(e) => setParentName(e.target.value)}
                                required
                                placeholder="보호자 이름"
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">학부모 연락처</label>
                            <input
                                value={parentPhone}
                                onChange={(e) => setParentPhone(e.target.value)}
                                placeholder="010-0000-0000"
                                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                            />
                        </div>
                        {!editingId && (
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-200 mb-1">학부모 이메일</label>
                                <input
                                    type="email"
                                    value={parentEmail}
                                    onChange={(e) => setParentEmail(e.target.value)}
                                    placeholder="parent@email.com"
                                    className="w-full border border-gray-300 dark:border-gray-600 rounded-lg p-2.5 text-sm dark:bg-gray-800 dark:text-white focus:ring-2 focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                                />
                            </div>
                        )}
                    </div>

                    {/* 신규 등록 시에만 보호자 동의 확인 체크박스 표시 (수정 시에는 불필요) */}
                    {!editingId && (
                        <div className="border-t border-gray-100 dark:border-gray-800 pt-4">
                            <label className="flex items-start gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={guardianConsent}
                                    onChange={(e) => setGuardianConsent(e.target.checked)}
                                    className="mt-0.5 w-4 h-4 rounded border-gray-300 text-brand-orange-500 dark:text-brand-neon-lime focus:ring-brand-orange-500 dark:focus:ring-brand-neon-lime"
                                />
                                <span className="text-sm text-gray-700 dark:text-gray-200">
                                    보호자로부터 <strong>개인정보 수집 및 이용 동의</strong>를 받았음을 확인합니다
                                    <span className="text-red-500 ml-1">(필수)</span>
                                </span>
                            </label>
                            <p className="text-xs text-gray-400 mt-1 ml-6">
                                미성년자 개인정보 수집 시 법정대리인(보호자)의 동의가 필요합니다.
                            </p>
                        </div>
                    )}

                    <div className="flex gap-2 justify-end">
                        <button type="button" onClick={resetForm} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 dark:text-white dark:hover:text-white">
                            취소
                        </button>
                        <button
                            type="submit"
                            disabled={busy || (!editingId && !guardianConsent)}
                            className="bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white px-6 py-2 rounded-lg font-bold hover:bg-orange-600 transition disabled:opacity-50"
                        >
                            {busy ? "저장 중..." : editingId ? "수정" : "등록"}
                        </button>
                    </div>
                </form>
            )}

            {/* Student list */}
            {filtered.length === 0 ? (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center text-gray-400">
                    {emptyStudentsMessage}
                </div>
            ) : (
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-gray-200 max-sm:!table-auto max-sm:[&_th]:whitespace-nowrap">
                            <thead className="bg-gray-50 dark:bg-gray-900">
                                <tr>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">이름</th>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">학년</th>
                                    {/* 학교/학부모/연락처: 모바일에서 숨김 */}
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">학교</th>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">수강 반</th>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">학부모</th>
                                    <th className="px-4 py-2.5 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase hidden md:table-cell">연락처</th>
                                    <th className="px-4 py-2.5 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">관리</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-100">
                                {visibleStudents.map((s) => (
                                    <tr key={s.id} className="hover:bg-gray-50 dark:bg-gray-900 transition-colors">
                                        {/* 이름: 항상 표시, 클릭하면 상세 페이지로 이동 */}
                                        <td className="whitespace-nowrap px-4 py-2">
                                            <Link
                                                href={`/admin/students/${s.id}`}
                                                prefetch={false}
                                                className="font-bold text-gray-900 hover:text-brand-orange-500 dark:text-brand-neon-lime transition-colors text-sm"
                                            >
                                                {s.name}
                                            </Link>
                                        </td>
                                        {/* 학년: 항상 표시, shortenGrade로 "초4" 형태 */}
                                        <td className="whitespace-nowrap px-4 py-2 text-sm text-gray-600 dark:text-gray-300">
                                            {shortenGrade(s.grade)}
                                        </td>
                                        {/* 학교: 모바일 숨김 */}
                                        <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hidden md:table-cell">
                                            {s.school || "-"}
                                        </td>
                                        {/* 수강 반: 활성 수강반만 우선 표시 */}
                                        <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300">
                                            {(() => {
                                                const activeEnrollments = getActiveEnrollments(s.enrollments);
                                                if (activeEnrollments.length > 0) {
                                                    return [...activeEnrollments]
                                                        .sort((a, b) => (DAY_ORDER[a.dayOfWeek] ?? 99) - (DAY_ORDER[b.dayOfWeek] ?? 99) || a.startTime.localeCompare(b.startTime))
                                                        .map((e) => shortenClassName(e)).join(", ");
                                                }

                                                const status = studentStatusById.get(s.id) ?? null;
                                                return (
                                                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-bold ring-1 ${getStatusPillClass(status)}`}>
                                                        {getStatusLabel(status)}
                                                    </span>
                                                );
                                            })()}
                                        </td>
                                        {/* 학부모: 모바일 숨김, shortenParentName으로 간결화 */}
                                        <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hidden md:table-cell">
                                            {shortenParentName(s.parent.name)}
                                        </td>
                                        {/* 연락처: 모바일 숨김, formatPhone으로 하이픈 포맷 */}
                                        <td className="px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hidden md:table-cell">
                                            {formatPhone(s.parent.phone)}
                                        </td>
                                        {/* 관리: 반복 액션은 번개 메뉴 안에 묶어 표를 한 줄로 유지 */}
                                        <td className="px-4 py-2 text-right">
                                            <AdminQuickActionMenu
                                                label={`${s.name} 빠른 작업`}
                                                actions={[
                                                    {
                                                        key: "enroll",
                                                        label: "수강등록",
                                                        icon: "how_to_reg",
                                                        tone: "primary",
                                                        onSelect: () => setEnrollModal(s.id),
                                                    },
                                                    {
                                                        key: "edit",
                                                        label: "수정",
                                                        icon: "edit",
                                                        onSelect: () => startEdit(s),
                                                    },
                                                    {
                                                        key: "delete",
                                                        label: "삭제",
                                                        icon: "delete",
                                                        tone: "danger",
                                                        disabled: busy,
                                                        onSelect: () => {
                                                            if (window.confirm(`"${s.name}" 원생을 삭제할까요?`)) {
                                                                void handleDelete(s.id);
                                                            }
                                                        },
                                                    },
                                                ]}
                                            />
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <div className="flex flex-col gap-3 border-t border-gray-100 px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400 sm:flex-row sm:items-center sm:justify-between">
                        <span>
                            {filtered.length}명 중 {visibleStudents.length}명 표시
                            {!allStudentsLoaded && " · 전체 동기화 중"}
                        </span>
                        {hasMoreStudents && (
                            <button
                                type="button"
                                onClick={() => setVisibleLimit((current) => current + STUDENT_PAGE_SIZE)}
                                className="rounded-lg border border-gray-200 px-4 py-2 font-bold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                            >
                                50명 더 보기
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* 엑셀 업로드 모달 — 파일 선택 -> 미리보기 -> 일괄 등록 */}
            {showExcelUpload && (
                <ExcelUploadModal
                    isOpen={showExcelUpload}
                    onClose={() => setShowExcelUpload(false)}
                    onComplete={() => {
                        setShowExcelUpload(false);
                        void loadData();
                    }}
                />
            )}

            {/* 수강 등록 모달 — 프로그램별 그룹화 + 요일/시간 표시 */}
            {enrollModal && (
                <AdminModal onClose={() => setEnrollModal(null)} titleId="student-enroll-title" panelClassName="max-w-lg p-6">
                        <h3 id="student-enroll-title" className="font-bold text-lg text-gray-900 dark:text-white mb-4">
                            수강 등록 — {students.find(s => s.id === enrollModal)?.name}
                        </h3>
                        {classes.length === 0 ? (
                            <p className="text-gray-500 dark:text-gray-400 text-sm">개설된 반이 없습니다. 먼저 반을 개설하세요.</p>
                        ) : (
                            <div className="max-h-[60vh] overflow-y-auto space-y-4">
                                {/* 프로그램별 그룹으로 표시 */}
                                {groupClassesByProgram(classes).map((group) => (
                                    <div key={group.programName}>
                                        {/* 프로그램명 헤더 */}
                                        <div className="bg-gray-100 dark:bg-gray-800 rounded-lg px-3 py-1.5 mb-2">
                                            <span className="text-sm font-bold text-gray-700 dark:text-gray-200">
                                                {group.programName}
                                            </span>
                                            <span className="text-xs text-gray-400 ml-2">
                                                ({group.classes.length}개 반)
                                            </span>
                                        </div>
                                        {/* 해당 프로그램의 클래스 목록 */}
                                        <div className="space-y-1 pl-2">
                                            {group.classes.map((c) => (
                                                <button
                                                    key={c.id}
                                                    onClick={() => handleEnroll(enrollModal!, c.id)}
                                                    disabled={busy}
                                                    className="w-full text-left px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-brand-orange-400 hover:bg-orange-50 transition disabled:opacity-50"
                                                >
                                                    {/* 요일 + 교시명 + 시간 표시 */}
                                                    <div className="flex items-center justify-between">
                                                        <span className="font-medium text-gray-900 dark:text-white text-sm">
                                                            {c.name}
                                                        </span>
                                                        <span className="text-xs text-gray-400">
                                                            {c.startTime}~{c.endTime}
                                                        </span>
                                                    </div>
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        <div className="mt-4 text-right">
                            <button
                                onClick={() => setEnrollModal(null)}
                                className="px-4 py-2 text-sm text-gray-600 hover:text-gray-900 dark:text-white dark:hover:text-white"
                            >
                                닫기
                            </button>
                        </div>
                </AdminModal>
            )}
        </div>
    );
}
