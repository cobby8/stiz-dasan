"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import AdminModal from "@/components/admin/AdminModal";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import CompactListFilters from "@/components/academy/CompactListFilters";
import ListDetailPanel from "@/components/admin/list/ListDetailPanel";
import ListViewToggle, { useRememberedListView } from "@/components/admin/list/ListViewToggle";
import ManualSmsModal from "@/app/admin/apply/ManualSmsModal";
import { trialFeeStatusLabel } from "@/lib/trial-fee-confirmation";
// 체험비 온라인 결제(2026-11-10) — 목록 짧은 표시·환불 버튼 조건은 순수 규칙 한 곳에서
import { canRefundTrialFeeOnline, trialFeeListChip } from "@/lib/trial-fee/trialFeeRules";
import { refundTrialFee } from "@/app/actions/trial-fee";
import { trialClassShortLabel, trialClassTimeRange, trialConfirmedClassShortLabel, trialPreferredSlotKeyCandidates } from "@/lib/trial-schedule-display";
import { seoulDateInputValue, seoulTimeInputValue } from "@/lib/trial-schedule-time";
import { statusBadgeClass } from "@/lib/ui/statusTones";
import { trialStaffMarkBadge } from "@/lib/staff-session-rules";
import {
    updateTrialLead,
    sendPostTrialEnrollGuide,
    sendTrialCoachNotice,
    resendTrialApplicationSms,
    recordApplicationContact,
    confirmTrialFeePayment,
    sendManualSms,
} from "@/app/actions/admin";

const TrialCrmModals = dynamic(() => import("./TrialCrmModals"), {
    loading: () => null,
});

// ── 타입 정의 ──────────────────────────────────────────────────────────────────

export interface TrialLead {
    id: string;
    childName: string;
    childAge: string | null;
    parentName: string;
    parentPhone: string;
    source: string;
    status: string;
    scheduledDate: string | null;
    scheduledClassId: string | null;
    attendedDate: string | null;
    postTrialConsultedAt: string | null;
    enrollGuideSentAt: string | null;
    enrollApplicationReceivedAt: string | null;
    enrollApplicationId: string | null;
    coachNoticeSentAt: string | null;
    coachNoticeSentTo: string | null;
    convertedDate: string | null;
    convertedStudentId: string | null;
    lostReason: string | null;
    memo: string | null;
    createdAt: string;
    updatedAt: string;
    // Phase A 추가 필드
    childBirthDate: string | null;
    childGrade: string | null;
    childGender: string | null;
    childSchool: string | null;
    basketballExp: string | null;
    preferredSlotKey: string | null;
    preferredDay: string | null;
    preferredPeriod: string | null;
    trialDate: string | null;
    trialFeeConfirmed: boolean; // 학원이 실제 입금을 확인함(관리자 전용 버튼)
    trialFeeNoticeAgreedAt?: string | null; // 학부모가 신청서에서 비용·계좌 안내에 동의한 시각(입금 아님)
    trialFeePaymentStatus?: string | null; // 체험비 온라인 결제 요약 — PAID·WAITING_FOR_DEPOSIT·REFUNDED·NEEDS_REFUND
    trialFeePaidAt?: string | null; // 온라인 결제 완료 시각
    staffAttendanceStatus?: string | null; // 선생님 출석부의 체험 출결 PRESENT·LATE·ABSENT(2026-11-13)
    hopeNote: string | null;
    agreedTerms: boolean;
    agreedPrivacy: boolean;
    latestContactAction: string | null;
    latestContactNote: string | null;
    latestContactAt: string | null;
    latestContactBy: string | null;
    openFollowUpAt: string | null;
    openFollowUpNote: string | null;
    smsDeliveryTotal: number;
    smsDeliverySent: number;
    smsDeliveryFailed: number;
    smsDeliveryPending: number;
    smsDeliveryLatestAt: string | null;
    smsDeliveryError: string | null;
}

interface TrialStats {
    NEW: number;
    CONTACTED: number;
    SCHEDULED: number;
    ATTENDED: number;
    CONVERTED: number;
    LOST: number;
    CANCELLED: number;
    total: number;
    conversionRate: number;
}

export interface ClassInfo {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    capacity: number;
    slotKey: string | null;
    coachId?: string | null;
    coachName?: string | null;
    instructorName?: string | null;
    scheduleStartTime?: string | null;
    scheduleEndTime?: string | null;
    scheduleActiveFrom?: string | null;
    scheduleActiveTo?: string | null;
    startTimeOverride?: string | null;
    endTimeOverride?: string | null;
    customStartTime?: string | null;
    customEndTime?: string | null;
    program: { id: string; name: string } | null;
}

type TrialCrmPayload = {
    leads: TrialLead[];
    stats: TrialStats;
    classes?: ClassInfo[];
    pagination?: ListPagination;
};

type ListPagination = {
    limit: number;
    offset: number;
    returned: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
    partial: boolean;
};

type FeedbackState = { type: "success" | "error" | "info"; message: string } | null;
type TrialWorkFilter = "ALL" | "NEEDS_CONTACT" | "SCHEDULED" | "AFTER_TRIAL" | "COACH_NOTICE" | "ENROLL_RECEIVED";
type TrialDateFilter = "ALL" | "UPCOMING" | "TODAY" | "THIS_WEEK" | "PAST" | "MISSING";
type ContactActionType = "CONTACTED" | "NO_ANSWER" | "FOLLOW_UP" | "MEMO";
type ContactModalState = { lead: TrialLead; defaultAction: ContactActionType } | null;
type EnrollGuideConfirmState = { lead: TrialLead; convertAfterConfirm: boolean } | null;
type ManualSmsModalState = { lead: TrialLead } | null;
// 상세 패널의 보조 작업 버튼 = 테마 보조 버튼(작은 크기). 예전과 같은 «테두리 버튼» 등급 그대로(2026-11-13 UI 통일)
const DETAIL_ACTION_CLASS = "academy-button-secondary academy-button-sm";
const EMPTY_STATS: TrialStats = {
    NEW: 0,
    CONTACTED: 0,
    SCHEDULED: 0,
    ATTENDED: 0,
    CONVERTED: 0,
    LOST: 0,
    CANCELLED: 0,
    total: 0,
    conversionRate: 0,
};

// ── 상태별 라벨/색상/아이콘 매핑 ──────────────────────────────────────────────

// 체험 상태색 = 공용 지도(statusTones). 신규(아직 연락 전 = 처리할 일) 주의 · 연락완료·체험예정(진행 중) 정보 ·
// 체험완료·등록전환 정상 · 이탈·취소 중립. 같은 색이어도 글자가 달라 구분된다(아이콘 없이 글자로 — 2026-11-13 UI 통일).
const STATUS_CONFIG: Record<string, { label: string; color: string }> = {
    NEW: { label: "신규", color: statusBadgeClass("warning") },
    CONTACTED: { label: "연락완료", color: statusBadgeClass("info") },
    SCHEDULED: { label: "체험예정", color: statusBadgeClass("info") },
    ATTENDED: { label: "체험완료", color: statusBadgeClass("success") },
    CONVERTED: { label: "등록전환", color: statusBadgeClass("success") },
    LOST: { label: "이탈", color: statusBadgeClass("neutral") },
    CANCELLED: { label: "취소", color: statusBadgeClass("neutral") },
};

// 유입경로 라벨
const SOURCE_LABELS: Record<string, string> = {
    WEBSITE: "홈페이지",
    NAVER: "네이버",
    NAVER_SEARCH: "네이버 키워드 검색",
    NAVER_AD: "네이버 검색광고",
    PORTAL_OTHER: "네이버 외 포털검색",
    NAVER_BLOG: "스티즈 네이버블로그",
    INSTAGRAM: "인스타그램",
    YOUTUBE: "유튜브",
    REFERRAL: "지인소개",
    FLYER: "전단지",
    PASSBY: "지나가다 발견",
    SOOMGO: "숨고",
    DANGGEUN: "당근마켓",
    OTHER: "기타",
};

// 상태 순서 (파이프라인 흐름)
const STATUS_ORDER = ["NEW", "CONTACTED", "SCHEDULED", "ATTENDED", "CONVERTED", "LOST", "CANCELLED"] as const;
const CLOSED_TRIAL_STATUSES = new Set(["CONVERTED", "LOST", "CANCELLED"]);
const TRIAL_PAGE_SIZE = 50;
// 목록 칸 수(상태별 묶음 머리줄이 표 전체 폭을 차지하도록 colSpan 에 쓴다)
const TRIAL_LIST_COLUMN_COUNT = 9;
// STATUS_ORDER 에 없는 옛 상태값이 와도 행이 사라지지 않게 맨 끝 «기타» 묶음에 넣는다
const OTHER_STATUS_GROUP = "OTHER";
// 보기 방식(목록 | 상태별) 기억 키 — 원생 관리의 «목록 | 반별» 과 같은 방식
const TRIAL_VIEW_STORAGE_KEY = "stiz-admin-trial-view";
const TRIAL_VIEW_VALUES = ["list", "status"] as const;
const TRIAL_VIEW_OPTIONS = [
    { value: "list", label: "목록", icon: "view_list" },
    { value: "status", label: "상태별", icon: "view_agenda" },
] as const;

const TRIAL_WORK_FILTERS: Array<{ value: TrialWorkFilter; label: string; icon: string }> = [
    { value: "ALL", label: "운영 전체", icon: "view_list" },
    { value: "NEEDS_CONTACT", label: "연락 필요", icon: "call" },
    { value: "SCHEDULED", label: "체험 예정", icon: "event_available" },
    { value: "AFTER_TRIAL", label: "상담/안내 필요", icon: "sms" },
    { value: "COACH_NOTICE", label: "쌤 알림 필요", icon: "school" },
    { value: "ENROLL_RECEIVED", label: "수강신청 접수", icon: "assignment_turned_in" },
];

const TRIAL_DATE_FILTERS: Array<{ value: TrialDateFilter; label: string }> = [
    { value: "ALL", label: "체험일 전체" },
    { value: "UPCOMING", label: "오늘 이후" },
    { value: "TODAY", label: "오늘" },
    { value: "THIS_WEEK", label: "이번 주" },
    { value: "PAST", label: "지난 일정" },
    { value: "MISSING", label: "체험일 미입력" },
];

const CONTACT_ACTION_LABELS: Record<string, string> = {
    CONTACTED: "연락 완료",
    NO_ANSWER: "부재",
    FOLLOW_UP: "재연락 예약",
    MEMO: "상담 메모",
    UPDATED: "내용 수정",
    SCHEDULED: "일정 변경",
    CANCELLED: "취소 처리",
};

function phoneHref(phone: string) {
    const digits = phone.replace(/\D/g, "");
    return digits ? `tel:${digits}` : undefined;
}

function getErrorMessage(error: unknown, fallback: string) {
    return adminErrorText(error, fallback);
}

function buildTrialManualSmsMessage(lead: TrialLead) {
    const parentName = lead.parentName || "보호자";
    return `${parentName}님, STIZ 농구교실입니다. ${lead.childName} 학생 체험수업 관련해서 안내드립니다.`;
}

function normalizeSearchValue(value: string | null | undefined) {
    return (value ?? "").replace(/\s+/g, "").replace(/-/g, "").toLowerCase();
}

function formatContactDateTime(dateStr: string | null) {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "-";
    return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isClosedTrialStatus(status: string) {
    return CLOSED_TRIAL_STATUSES.has(status);
}

function formatCompactDate(dateStr: string | null) {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "-";
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function formatMonthDayDate(dateStr: string | null) {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "-";
    return `${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")}`;
}

function formatCompactDateTime(dateStr: string | null) {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "-";
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, "0")}.${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatShortDate(dateStr: string | null) {
    if (!dateStr) return "-";
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return "-";
    return `${date.getMonth() + 1}/${date.getDate()}`;
}

function getLocalDateTime(dateStr: string | null) {
    if (!dateStr) return null;
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return null;
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function getTodayLocalDateTime() {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function matchesTrialDateFilter(lead: TrialLead, dateFilter: TrialDateFilter) {
    if (dateFilter === "ALL") return true;

    // 확정 후에는 실제 수업일로 필터링한다. 희망일은 신청 기록으로만 남긴다.
    const trialDate = getLocalDateTime(getTrialListDateValue(lead));
    if (dateFilter === "MISSING") return trialDate === null;
    if (trialDate === null) return false;

    const today = getTodayLocalDateTime();
    const weekEnd = today + 6 * 24 * 60 * 60 * 1000;

    if (dateFilter === "UPCOMING") return trialDate >= today;
    if (dateFilter === "TODAY") return trialDate === today;
    if (dateFilter === "THIS_WEEK") return trialDate >= today && trialDate <= weekEnd;
    if (dateFilter === "PAST") return trialDate < today;
    return true;
}

function isLikelyDefaultScheduleTime(dateStr: string | null) {
    if (!dateStr) return false;
    const date = new Date(dateStr);
    if (Number.isNaN(date.getTime())) return false;
    return date.getHours() === 9 && date.getMinutes() === 0;
}

const DAY_LABELS: Record<string, string> = {
    Mon: "월",
    Tue: "화",
    Wed: "수",
    Thu: "목",
    Fri: "금",
    Sat: "토",
    Sun: "일",
};

const DAY_SHORT_LABELS: Record<string, string> = {
    Mon: "월",
    Tue: "화",
    Wed: "수",
    Thu: "목",
    Fri: "금",
    Sat: "토",
    Sun: "일",
};

const DAY_CODE_BY_LABEL: Record<string, string> = {
    월: "Mon",
    월요일: "Mon",
    화: "Tue",
    화요일: "Tue",
    수: "Wed",
    수요일: "Wed",
    목: "Thu",
    목요일: "Thu",
    금: "Fri",
    금요일: "Fri",
    토: "Sat",
    토요일: "Sat",
    일: "Sun",
    일요일: "Sun",
};

function normalizePreferredDayCode(day: string | null) {
    if (!day) return null;
    const trimmed = day.trim();
    return DAY_LABELS[trimmed] ? trimmed : DAY_CODE_BY_LABEL[trimmed] ?? null;
}

function normalizePreferredPeriod(period: string | null) {
    if (!period) return null;
    const matched = period.match(/\d+/);
    return matched?.[0] ?? null;
}

function normalizeSlotKey(slotKey: string | null) {
    if (!slotKey) return null;
    const [dayPart, periodPart] = slotKey.trim().split("-");
    const dayCode = normalizePreferredDayCode(dayPart);
    const period = normalizePreferredPeriod(periodPart ?? "");
    return dayCode && period ? `${dayCode}-${period}` : slotKey.trim();
}

function getPreferredSlotKeyCandidates(lead: TrialLead) {
    const directSlotKey = normalizeSlotKey(lead.preferredSlotKey);
    const dayCode = normalizePreferredDayCode(lead.preferredDay);
    const period = normalizePreferredPeriod(lead.preferredPeriod);
    const derivedSlotKey = dayCode && period ? `${dayCode}-${period}` : null;

    return trialPreferredSlotKeyCandidates(directSlotKey, derivedSlotKey);
}

function getPreferredClass(lead: TrialLead, classesBySlotKey?: Map<string, ClassInfo>) {
    for (const slotKey of getPreferredSlotKeyCandidates(lead)) {
        const classInfo = classesBySlotKey?.get(slotKey);
        if (classInfo) return classInfo;
    }
    return null;
}

function formatClassLabel(classInfo: ClassInfo, selectedDate = "") {
    const dayLabel = DAY_LABELS[classInfo.dayOfWeek] || classInfo.dayOfWeek;
    const timeLabel = trialClassTimeRange(classInfo, selectedDate);
    const programName = classInfo.program?.name ? ` · ${classInfo.program.name}` : "";
    return [dayLabel, timeLabel].filter(Boolean).join(" ") + ` · ${classInfo.name}${programName}`;
}

function formatClassShortLabel(classInfo: ClassInfo) {
    return trialClassShortLabel(classInfo);
}

function formatSlotShortLabel(slotKey: string | null) {
    const normalized = normalizeSlotKey(slotKey);
    if (!normalized) return null;
    const [dayCode, periodPart] = normalized.split("-");
    const dayLabel = DAY_SHORT_LABELS[dayCode] || dayCode;
    const period = normalizePreferredPeriod(periodPart ?? "");
    return dayLabel && period ? `${dayLabel}${period}` : normalized;
}

function formatPreferredScheduleShort(lead: TrialLead, classesBySlotKey?: Map<string, ClassInfo>) {
    const matchedClass = getPreferredClass(lead, classesBySlotKey);
    if (matchedClass) return formatClassShortLabel(matchedClass);

    const slotLabel = formatSlotShortLabel(getPreferredSlotKeyCandidates(lead)[0] ?? null);
    if (slotLabel) return slotLabel;

    const dayCode = normalizePreferredDayCode(lead.preferredDay);
    const period = normalizePreferredPeriod(lead.preferredPeriod);
    if (dayCode && period) return `${DAY_SHORT_LABELS[dayCode] || dayCode}${period}`;
    return null;
}

function formatConfirmedScheduleShort(
    lead: TrialLead,
    classesById?: Map<string, ClassInfo>,
    classesBySlotKey?: Map<string, ClassInfo>,
) {
    const matchedClass =
        (lead.scheduledClassId ? classesById?.get(lead.scheduledClassId) : null) ||
        getPreferredClass(lead, classesBySlotKey);
    const classLabel = matchedClass
        ? trialConfirmedClassShortLabel(matchedClass, lead.scheduledDate, true)
        : formatPreferredScheduleShort(lead, classesBySlotKey);
    if (lead.scheduledDate && classLabel) return `${formatShortDate(lead.scheduledDate)} ${classLabel}`;
    if (lead.scheduledDate) return formatShortDate(lead.scheduledDate);
    return classLabel;
}

function getTrialListDateValue(lead: TrialLead) {
    return lead.scheduledDate || lead.trialDate || null;
}

function formatTrialListScheduleShort(
    lead: TrialLead,
    classesById?: Map<string, ClassInfo>,
    classesBySlotKey?: Map<string, ClassInfo>,
) {
    const confirmedClass = lead.scheduledClassId ? classesById?.get(lead.scheduledClassId) : null;
    if (confirmedClass) return trialConfirmedClassShortLabel(confirmedClass, lead.scheduledDate);
    return formatPreferredScheduleShort(lead, classesBySlotKey) || "미입력";
}

function formatTrialListTeacherName(
    lead: TrialLead,
    classesById?: Map<string, ClassInfo>,
    classesBySlotKey?: Map<string, ClassInfo>,
) {
    const matchedClass =
        (lead.scheduledClassId ? classesById?.get(lead.scheduledClassId) : null) ||
        getPreferredClass(lead, classesBySlotKey);
    return matchedClass?.coachName || matchedClass?.instructorName || "-";
}

function formatPreferredSchedule(lead: TrialLead, classesBySlotKey?: Map<string, ClassInfo>) {
    const matchedClass = getPreferredClass(lead, classesBySlotKey);
    if (matchedClass) return formatClassLabel(matchedClass, seoulDateInputValue(lead.trialDate));

    const rawDay = lead.preferredDay?.replace(/요일$/, "");
    const day = rawDay ? `${DAY_LABELS[rawDay] || rawDay}요일` : "";
    const period = lead.preferredPeriod
        ? lead.preferredPeriod.includes("교시")
            ? lead.preferredPeriod
            : `${lead.preferredPeriod}교시`
        : "";
    const label = [day, period].filter(Boolean).join(" ");
    if (label) return label;
    return lead.preferredSlotKey ? "희망 시간 확인 필요" : null;
}

function formatConfirmedSchedule(
    lead: TrialLead,
    classesById?: Map<string, ClassInfo>,
    classesBySlotKey?: Map<string, ClassInfo>,
) {
    const matchedClass =
        (lead.scheduledClassId ? classesById?.get(lead.scheduledClassId) : null) ||
        getPreferredClass(lead, classesBySlotKey);
    if (lead.scheduledDate && matchedClass) {
        return `${formatCompactDate(lead.scheduledDate)} ${seoulTimeInputValue(lead.scheduledDate)} · ${matchedClass.name}`;
    }
    if (lead.scheduledDate) {
        const preferredSchedule = formatPreferredSchedule(lead, classesBySlotKey);
        if (isLikelyDefaultScheduleTime(lead.scheduledDate) && preferredSchedule) {
            return `${formatCompactDate(lead.scheduledDate)} · ${preferredSchedule} · 시간 확인 필요`;
        }
        return formatCompactDateTime(lead.scheduledDate);
    }
    if (matchedClass) return formatClassLabel(matchedClass);
    return null;
}

function getTrialScheduleItems(
    lead: TrialLead,
    classesBySlotKey?: Map<string, ClassInfo>,
    classesById?: Map<string, ClassInfo>,
) {
    const preferredSchedule = formatPreferredSchedule(lead, classesBySlotKey);
    const confirmedSchedule = formatConfirmedSchedule(lead, classesById, classesBySlotKey);
    const preferredScheduleShort = formatPreferredScheduleShort(lead, classesBySlotKey);
    const confirmedScheduleShort = formatConfirmedScheduleShort(lead, classesById, classesBySlotKey);
    const items = [
        {
            label: "신청일",
            value: formatCompactDate(lead.createdAt),
            className: "border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
        },
        {
            label: "체험일",
            value: lead.trialDate ? formatCompactDate(lead.trialDate) : "미입력",
            className: "border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
        },
        {
            label: "수업교시",
            value: preferredSchedule || "미입력",
            className: "border-[var(--color-academy-line)] bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)]",
        },
        {
            label: "확정일정",
            value: confirmedSchedule || "미확정",
            className: "border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]",
        },
    ];
    return items.map((item, index) => {
        if (index === 2 && preferredScheduleShort) return { ...item, value: preferredScheduleShort };
        if (index === 3 && confirmedScheduleShort) return { ...item, value: confirmedScheduleShort };
        return item;
    });
}

function matchesTrialWorkFilter(lead: TrialLead, workFilter: TrialWorkFilter) {
    if (workFilter === "ALL") return true;
    if (workFilter === "NEEDS_CONTACT") return lead.status === "NEW" || lead.status === "CONTACTED";
    if (workFilter === "SCHEDULED") return lead.status === "SCHEDULED";
    if (workFilter === "AFTER_TRIAL") return lead.status === "ATTENDED" && !lead.enrollGuideSentAt;
    if (workFilter === "COACH_NOTICE") return !isClosedTrialStatus(lead.status) && !lead.coachNoticeSentAt;
    if (workFilter === "ENROLL_RECEIVED") return Boolean(lead.enrollApplicationReceivedAt);
    return true;
}

function trialLeadMatchesSearch(lead: TrialLead, query: string) {
    const normalizedQuery = normalizeSearchValue(query);
    if (!normalizedQuery) return true;

    const searchable = [
        lead.childName,
        lead.childAge,
        lead.parentName,
        lead.parentPhone,
        lead.childSchool,
        lead.childGrade,
        lead.childGender,
        lead.basketballExp,
        lead.preferredDay,
        lead.preferredPeriod,
        lead.hopeNote,
        lead.memo,
        lead.lostReason,
        SOURCE_LABELS[lead.source] || lead.source,
    ].map(normalizeSearchValue).join(" ");

    return searchable.includes(normalizedQuery);
}

function TrialCrmLoadingFallback() {
    return (
        <div role="status" aria-live="polite" className="min-w-0 space-y-3">
            <p className="text-sm text-[var(--color-academy-muted)]">체험 목록을 불러오는 중…</p>
            <div aria-hidden="true" className="h-11 animate-pulse rounded-xl bg-[var(--color-academy-soft)]" />
            <div aria-hidden="true" className="space-y-2">
                {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-12 animate-pulse rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]" />)}
            </div>
        </div>
    );
}

function TrialCrmErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-[var(--color-academy-line)] bg-white p-8 text-center shadow-sm">
            <p className="font-semibold text-[var(--color-academy-danger)]">체험 문의 정보를 불러오지 못했습니다.</p>
            <button
                type="button"
                onClick={onRetry}
                className="academy-button-primary mt-4"
            >
                다시 시도
            </button>
        </div>
    );
}

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────

export default function TrialCrmClient({
    initialLeads,
    initialStats,
    initialClasses,
    initialPagination,
    onChanged,
}: {
    initialLeads?: TrialLead[];
    initialStats?: TrialStats;
    initialClasses?: ClassInfo[];
    initialPagination?: ListPagination;
    /** 처리 성공 때마다 부르는 선택 콜백(신청함 «체험» 탭이 배지·메뉴 숫자를 다시 읽는다). 없으면 예전 그대로 */
    onChanged?: () => void;
}) {
    const onChangedRef = useRef(onChanged);
    onChangedRef.current = onChanged;
    const hasInitialData = Boolean(initialLeads && initialStats);
    const [leads, setLeads] = useState<TrialLead[]>(initialLeads ?? []);
    const [stats, setStats] = useState<TrialStats>(initialStats ?? EMPTY_STATS);
    const [classes, setClasses] = useState<ClassInfo[]>(initialClasses ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadingMore, setLoadingMore] = useState(false);
    const [pagination, setPagination] = useState<ListPagination | null>(initialPagination ?? null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [filter, setFilter] = useState<string>("ALL");
    // 목록 보기 방식: "list"(한 줄 목록) / "status"(상태별 묶음). 마지막 선택을 브라우저에 기억한다.
    const [trialView, setTrialView] = useRememberedListView(TRIAL_VIEW_STORAGE_KEY, TRIAL_VIEW_VALUES, "list");
    const [workFilter, setWorkFilter] = useState<TrialWorkFilter>("ALL");
    const [dateFilter, setDateFilter] = useState<TrialDateFilter>("ALL");
    const [searchQuery, setSearchQuery] = useState("");
    const [visibleLimit, setVisibleLimit] = useState(TRIAL_PAGE_SIZE);
    const [busy, setBusy] = useState(false);
    const [trialFeeBusyId, setTrialFeeBusyId] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<FeedbackState>(null);
    // 모달 상태
    const [showAddModal, setShowAddModal] = useState(false);
    const [showEditModal, setShowEditModal] = useState<TrialLead | null>(null);
    const [showScheduleModal, setShowScheduleModal] = useState<TrialLead | null>(null);
    const [showCancelModal, setShowCancelModal] = useState<TrialLead | null>(null);
    const [showConvertModal, setShowConvertModal] = useState<TrialLead | null>(null);
    const [showLostModal, setShowLostModal] = useState<TrialLead | null>(null);
    const [showMemoModal, setShowMemoModal] = useState<TrialLead | null>(null);
    const [showDetailModal, setShowDetailModal] = useState<TrialLead | null>(null);
    const [contactModal, setContactModal] = useState<ContactModalState>(null);
    const [enrollGuideConfirm, setEnrollGuideConfirm] = useState<EnrollGuideConfirmState>(null);
    const [manualSmsModal, setManualSmsModal] = useState<ManualSmsModalState>(null);
    const [contactBusyId, setContactBusyId] = useState<string | null>(null);
    const [manualSmsBusy, setManualSmsBusy] = useState(false);
	const feedbackTimerRef = useRef<number | null>(null);
    const hasTrialModal = Boolean(showAddModal || showEditModal || showScheduleModal || showCancelModal || showConvertModal || showLostModal || showMemoModal);

    const loadTrialData = useCallback(async (options?: { append?: boolean; offset?: number }) => {
        const append = Boolean(options?.append);
        const offset = options?.offset ?? 0;

        if (append) setLoadingMore(true);
        else setLoading(true);
        setLoadError(null);

        try {
            const params = new URLSearchParams({
                limit: String(TRIAL_PAGE_SIZE),
                offset: String(offset),
            });
            const res = await fetch(`/api/admin/trial?${params.toString()}`, { cache: "no-store" });
            if (!res.ok) throw new Error("request failed");
            const data = (await res.json()) as TrialCrmPayload;
            setLeads((current) => (append ? [...current, ...data.leads] : data.leads));
            setStats(data.stats);
            setClasses(data.classes ?? []);
            setPagination(data.pagination ?? null);
            return true;
        } catch {
            setLoadError("failed");
            return false;
        } finally {
            if (append) setLoadingMore(false);
            else setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (hasInitialData) return;
        void loadTrialData();
    }, [hasInitialData, loadTrialData]);

    const classesBySlotKey = useMemo(() => {
        const map = new Map<string, ClassInfo>();
        classes.forEach((classInfo) => {
            if (classInfo.slotKey) map.set(classInfo.slotKey, classInfo);
        });
        return map;
    }, [classes]);
    const classesById = useMemo(() => {
        const map = new Map<string, ClassInfo>();
        classes.forEach((classInfo) => {
            map.set(classInfo.id, classInfo);
        });
        return map;
    }, [classes]);
    useEffect(() => {
        return () => {
            if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
        };
    }, []);

    const showFeedback = useCallback((type: "success" | "error" | "info", message: string) => {
        if (feedbackTimerRef.current) window.clearTimeout(feedbackTimerRef.current);
        setFeedback({ type, message });
        feedbackTimerRef.current = window.setTimeout(() => setFeedback(null), type === "info" ? 8000 : 4200);
        // 성공 = 무언가 바뀌었다 → 신청함이면 배지·메뉴 숫자 갱신
        if (type === "success") onChangedRef.current?.();
    }, []);
    const handleRecordContact = useCallback(async (
        lead: TrialLead,
        action: ContactActionType,
        note?: string | null,
        nextFollowUpAt?: string | null,
    ) => {
        setContactBusyId(lead.id);
        try {
            await recordApplicationContact({
                targetType: "TRIAL",
                targetId: lead.id,
                action,
                note,
                nextFollowUpAt,
            });
            await loadTrialData();
            showFeedback("success", `${lead.childName} ${CONTACT_ACTION_LABELS[action]} 기록을 저장했습니다.`);
        } catch {
            showFeedback("error", "연락 기록 저장 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setContactBusyId(null);
        }
    }, [loadTrialData, showFeedback]);

    // 필터링된 리드 목록
    const filteredLeads = useMemo(() => {
        return leads
            .filter((lead) => {
                if (filter !== "ALL" && lead.status !== filter) return false;
                if (!matchesTrialWorkFilter(lead, workFilter)) return false;
                if (!matchesTrialDateFilter(lead, dateFilter)) return false;
                return trialLeadMatchesSearch(lead, searchQuery);
            })
            .sort((a, b) => {
                // 운영자가 새 신청을 놓치지 않도록 접수일 최신순으로 고정합니다.
                const createdAtCompare = (getLocalDateTime(b.createdAt) ?? 0) - (getLocalDateTime(a.createdAt) ?? 0);
                return createdAtCompare || b.id.localeCompare(a.id);
            });
    }, [classesBySlotKey, dateFilter, filter, leads, searchQuery, workFilter]);
    const visibleLeads = useMemo(
        () => filteredLeads.slice(0, visibleLimit),
        [filteredLeads, visibleLimit],
    );
    const hasMoreLoadedLeads = visibleLeads.length < filteredLeads.length;
    const hasMoreServerLeads = Boolean(pagination?.hasMore);
    const hasMoreLeads = hasMoreLoadedLeads || hasMoreServerLeads;
    const handleShowMoreLeads = useCallback(() => {
        if (hasMoreLoadedLeads) {
            setVisibleLimit((current) => current + TRIAL_PAGE_SIZE);
            return;
        }

        if (!hasMoreServerLeads || loadingMore) return;

        setVisibleLimit((current) => current + TRIAL_PAGE_SIZE);
        void loadTrialData({
            append: true,
            offset: pagination?.nextOffset ?? leads.length,
        });
    }, [hasMoreLoadedLeads, hasMoreServerLeads, leads.length, loadTrialData, loadingMore, pagination?.nextOffset]);
    const workFilterCounts = useMemo(() => {
        const counts: Record<TrialWorkFilter, number> = {
            ALL: leads.length,
            NEEDS_CONTACT: 0,
            SCHEDULED: 0,
            AFTER_TRIAL: 0,
            COACH_NOTICE: 0,
            ENROLL_RECEIVED: 0,
        };

        leads.forEach((lead) => {
            TRIAL_WORK_FILTERS.forEach((item) => {
                if (item.value !== "ALL" && matchesTrialWorkFilter(lead, item.value)) {
                    counts[item.value] += 1;
                }
            });
        });

        return counts;
    }, [leads]);

    useEffect(() => {
        setVisibleLimit(TRIAL_PAGE_SIZE);
    }, [dateFilter, filter, searchQuery, workFilter]);

    // 상태 변경 핸들러
    async function handleStatusChange(lead: TrialLead, newStatus: string) {
        if (busy) return;
        if (newStatus === "ATTENDED" && !confirm(`"${lead.childName}" 학생의 체험수업을 완료 처리할까요? 완료 안내 문자가 발송될 수 있습니다.`)) return;
        if (newStatus === "CONVERTED" && lead.status !== "CONVERTED") {
            setEnrollGuideConfirm({ lead, convertAfterConfirm: true });
            return;
        }

        setBusy(true);
        try {
            const updates: { status: string; attendedDate?: string; convertedDate?: string } = { status: newStatus };
            // 상태에 따른 날짜 자동 설정
            if (newStatus === "ATTENDED") {
                updates.attendedDate = new Date().toISOString();
            } else if (newStatus === "CONVERTED") {
                updates.convertedDate = new Date().toISOString();
            }
            // 체험 완료 감사 문자는 2026-11-09 없앴다 — 상태 변경 결과만 안내한다
            await updateTrialLead(lead.id, updates);
            await loadTrialData();
            showFeedback("success", `${lead.childName} 상태를 ${STATUS_CONFIG[newStatus]?.label ?? "변경"}으로 바꿨습니다.`);
        } catch {
            showFeedback("error", "상태 변경 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setBusy(false);
        }
    }

    async function handleConfirmTrialFee(lead: TrialLead) {
        if (trialFeeBusyId || lead.trialFeeConfirmed) return;
        if (!confirm(`"${lead.childName}" 체험수업 비용 입금을 확인 처리할까요?`)) return;

        showFeedback("info", `${lead.childName} 체험비 입금 확인을 처리 중입니다...`);
        setTrialFeeBusyId(lead.id);
        try {
            const result = await confirmTrialFeePayment(lead.id);
            if (!result.found) {
                showFeedback("error", "체험 신청을 찾지 못했습니다. 목록을 새로고침해 주세요.");
                return;
            }
            setShowDetailModal((current) => current?.id === lead.id ? { ...current, trialFeeConfirmed: true } : current);
            setLeads((current) => current.map((item) => item.id === lead.id ? { ...item, trialFeeConfirmed: true } : item));
            showFeedback(
                "success",
                result.alreadyConfirmed
                    ? `${lead.childName} 체험비는 이미 입금 확인된 상태입니다.`
                    : `${lead.childName} 체험비 입금을 확인 처리했습니다.`,
            );
            const refreshed = await loadTrialData();
            if (!refreshed) {
                showFeedback("error", "입금 확인은 완료됐지만 최신 목록을 불러오지 못했습니다. 화면을 새로고침해 주세요.");
            }
        } catch {
            showFeedback("error", "체험비 입금 확인 처리 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setTrialFeeBusyId(null);
        }
    }

    // 체험비 환불(토스 전액 취소) — 원장만 서버에서 통과. 체험 신청 상태는 그대로 두고 체험비만 돌려준다.
    async function handleRefundTrialFee(lead: TrialLead) {
        if (trialFeeBusyId) return;
        if (!confirm(`"${lead.childName}" 체험수업비를 카드·계좌로 전액 환불할까요?
되돌릴 수 없어요. 체험 신청 상태는 그대로예요(취소하려면 상태도 바꿔 주세요).`)) return;
        setTrialFeeBusyId(lead.id);
        showFeedback("info", `${lead.childName} 체험비 환불을 요청하는 중입니다...`);
        try {
            const result = await refundTrialFee(lead.id);
            if (!result.ok) {
                showFeedback("error", result.message);
                return;
            }
            showFeedback("success", result.alreadyApplied ? `${lead.childName} 체험비는 이미 환불된 상태입니다.` : `${lead.childName} 체험비를 환불했습니다.`);
            await loadTrialData();
        } catch (error) {
            showFeedback("error", adminErrorText(error, "체험비 환불 중 문제가 생겼습니다."));
        } finally {
            setTrialFeeBusyId(null);
        }
    }

    async function handleSendManualSms(lead: TrialLead, message: string) {
        if (manualSmsBusy) return;
        setManualSmsBusy(true);
        showFeedback("info", `${lead.childName} 보호자에게 문자 발송 중입니다...`);
        try {
            const result = await sendManualSms([lead.parentPhone], message, {
                requestId: `trial-manual-${lead.id}-${Date.now()}`,
                purpose: "체험문의 학부모 문자",
                reason: "체험문의 관리 화면에서 직접 발송",
                audienceScope: "EXTERNAL",
            });
            setManualSmsModal(null);
            if (result.success > 0 && result.failed === 0 && result.uncertain === 0) {
                showFeedback("success", `${lead.childName} 보호자에게 문자를 발송했습니다.`);
            } else if (result.success > 0) {
                showFeedback("error", `${lead.childName} 문자 일부만 발송됐습니다. 문자 발송 장부를 확인해 주세요.`);
            } else {
                showFeedback("error", result.results[0]?.reason || "문자 발송에 실패했습니다. 연락처와 문자 설정을 확인해 주세요.");
            }
        } catch (error) {
            showFeedback("error", getErrorMessage(error, "문자 발송 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요."));
        } finally {
            setManualSmsBusy(false);
        }
    }

    async function handleConfirmEnrollGuide() {
        if (busy || !enrollGuideConfirm) return;
        const { lead, convertAfterConfirm } = enrollGuideConfirm;
        setBusy(true);
        try {
            const result = await sendPostTrialEnrollGuide(lead.id, {
                convert: convertAfterConfirm,
            });
            setEnrollGuideConfirm(null);
            await loadTrialData();
            if (result.sent) {
                showFeedback("success", `${lead.childName} 보호자에게 수강신청 안내 문자를 발송했습니다.`);
            } else {
                showFeedback(
                    "error",
                    `${convertAfterConfirm ? "등록전환은 완료됐지만 " : ""}수강신청 안내 문자를 발송하지 못했습니다. ${result.message || "문자 발송 내역을 확인해주세요."}`,
                );
            }
        } catch {
            showFeedback("error", "수강신청 안내 처리 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setBusy(false);
        }
    }

    async function handleConvertWithoutSms() {
        if (busy || !enrollGuideConfirm) return;
        const { lead } = enrollGuideConfirm;
        setBusy(true);
        try {
            // 최초 전환일 보존: 문자 발송 경로는 서버에서 COALESCE("convertedDate", NOW()) 로 처음 값을 지킨다.
            // 여기서는 이미 전환일이 있으면 convertedDate 를 아예 보내지 않아 같은 결과(덮어쓰기 방지)를 만든다.
            const updates: { status: string; convertedDate?: string } = { status: "CONVERTED" };
            if (!lead.convertedDate) updates.convertedDate = new Date().toISOString();
            // 이력 기록: 문자 없이 처리한 전환이라는 사실이 상담 이력에 남아야 나중에 추적이 된다.
            await updateTrialLead(lead.id, updates, {
                action: "UPDATED",
                note: "등록전환 처리 (문자 미발송)",
            });
            setEnrollGuideConfirm(null);
            await loadTrialData();
            showFeedback("success", `${lead.childName} 등록전환 완료 (문자 미발송).`);
        } catch {
            showFeedback("error", "등록전환 처리 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setBusy(false);
        }
    }

    function handleSendEnrollGuide(lead: TrialLead) {
        if (busy) return;
        setEnrollGuideConfirm({ lead, convertAfterConfirm: false });
    }

    // 체험 완료 뒤 «수강신청 안내/안내 재발송» — ⚡ 의 주인공(primary) 작업. 같은 handleSendEnrollGuide(lead)
    function buildEnrollGuideAction(lead: TrialLead): AdminQuickAction | null {
        if (lead.status !== "ATTENDED" || lead.enrollApplicationReceivedAt) return null;
        const label = lead.enrollGuideSentAt ? "안내 재발송" : "수강신청 안내";
        return { key: "enroll-guide", label, icon: "send", tone: "primary", disabled: busy, onSelect: () => handleSendEnrollGuide(lead) };
    }

    // ⚡ 작업 목록 — 예전 메뉴의 버튼과 같은 조건·같은 함수·같은 인자(보이는 모양만 공용 메뉴로)
    function buildTrialQuickActions(lead: TrialLead, parentPhoneHref: string | undefined): AdminQuickAction[] {
        const actions: AdminQuickAction[] = [
            { key: "call", label: "전화", icon: "call", disabled: !parentPhoneHref, onSelect: () => { if (parentPhoneHref) window.location.href = parentPhoneHref; } },
            { key: "sms", label: "문자 보내기", icon: "sms", disabled: manualSmsBusy, onSelect: () => setManualSmsModal({ lead }) },
        ];
        if (!isClosedTrialStatus(lead.status) && (lead.status === "NEW" || lead.status === "CONTACTED" || lead.status === "SCHEDULED")) {
            actions.push({ key: "schedule", label: lead.status === "SCHEDULED" ? "일정 변경" : "일정 확정", icon: "event_available", onSelect: () => setShowScheduleModal(lead) });
        }
        if (lead.status === "NEW") {
            actions.push({ key: "contact", label: "연락 기록", icon: "phone_callback", disabled: contactBusyId === lead.id, onSelect: () => setContactModal({ lead, defaultAction: "CONTACTED" }) });
        }
        actions.push({ key: "memo", label: "메모", icon: "edit_note", disabled: contactBusyId === lead.id, onSelect: () => setContactModal({ lead, defaultAction: "MEMO" }) });
        if (lead.status === "SCHEDULED") {
            // 입금 완료면 누를 수 없는 표시 줄(예전과 같음)
            actions.push(lead.trialFeeConfirmed
                ? { key: "fee-done", label: "입금 완료", icon: "paid", disabled: true, onSelect: () => undefined }
                : { key: "fee", label: trialFeeBusyId === lead.id ? "확인 중…" : "입금 확인", icon: trialFeeBusyId === lead.id ? "progress_activity" : "paid", disabled: Boolean(trialFeeBusyId), onSelect: () => handleConfirmTrialFee(lead) });
            actions.push({ key: "attended", label: "체험 완료", icon: "check_circle", tone: "primary", disabled: busy, onSelect: () => handleStatusChange(lead, "ATTENDED") });
        }
        if (canRefundTrialFeeOnline(lead.trialFeePaymentStatus)) {
            actions.push({ key: "fee-refund", label: trialFeeBusyId === lead.id ? "환불 중…" : "체험비 환불", icon: "currency_exchange", tone: "danger", disabled: Boolean(trialFeeBusyId), onSelect: () => handleRefundTrialFee(lead) });
        }
        if (!isClosedTrialStatus(lead.status) && !lead.coachNoticeSentAt) {
            actions.push({ key: "coach-notice", label: "쌤 알림", icon: "school", disabled: busy, onSelect: () => handleSendCoachNotice(lead) });
        }
        if (lead.smsDeliveryFailed > 0) {
            actions.push({ key: "sms-resend", label: "문자 재발송", icon: "sms_failed", disabled: busy, onSelect: () => handleResendApplicationSms(lead) });
        }
        const enrollGuide = lead.status === "ATTENDED" ? buildEnrollGuideAction(lead) : null;
        if (enrollGuide) actions.push(enrollGuide);
        // 체험 → 원생 바로 등록(원장 결정 2026-11-09): 체험을 마쳤고 아직 원생이 없고, 학부모 수강신청서도 안 온 경우만.
        // 신청서가 왔으면 «수강 신청» 승인으로 등록한다(같은 학생이 두 번 생기지 않게).
        if ((lead.status === "ATTENDED" || lead.status === "CONVERTED") && !lead.convertedStudentId && !lead.enrollApplicationReceivedAt) {
            actions.push({ key: "register-student", label: "원생 등록", icon: "how_to_reg", disabled: busy, onSelect: () => setShowConvertModal(lead) });
        }
        return actions;
    }

    async function handleSendCoachNotice(lead: TrialLead) {
        if (busy) return;
        if (!confirm(`"${lead.childName}" 체험수업 정보를 담당 선생님에게 문자로 공유할까요?`)) return;

        setBusy(true);
        try {
            const result = await sendTrialCoachNotice(lead.id);
            await loadTrialData();
            showFeedback("success", `담당 선생님에게 체험수업 알림을 보냈습니다. 수신: ${result.sentTo.join(", ")}`);
        } catch {
            showFeedback("error", "담당 선생님 알림 발송 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setBusy(false);
        }
    }

    async function handleResendApplicationSms(lead: TrialLead) {
        if (busy) return;
        if (!confirm(`"${lead.childName}" 체험 신청 문자 중 실패한 문자만 다시 보낼까요?`)) return;

        setBusy(true);
        try {
            const result = await resendTrialApplicationSms(lead.id);
            await loadTrialData();
            showFeedback("success", result.message);
        } catch {
            showFeedback("error", "문자 재발송 중 문제가 생겼습니다. 연락처와 문자 설정을 확인해주세요.");
        } finally {
            setBusy(false);
        }
    }

    // (2026-11-09) 체험 완료 감사 문자를 없애며 «완료 문자 재시도» 버튼·처리도 지웠다.

    // 목록 한 줄(행). 목록 보기와 상태별 보기가 같은 행을 쓴다.
    function renderTrialRow(lead: TrialLead) {
        const cfg = STATUS_CONFIG[lead.status] || STATUS_CONFIG.NEW;
        const scheduleItems = getTrialScheduleItems(lead, classesBySlotKey, classesById);
        const getScheduleValue = (label: string) => scheduleItems.find((item) => item.label === label)?.value || "-";
        const parentPhoneHref = phoneHref(lead.parentPhone);
        const rowTitle = [lead.childName, lead.childSchool, lead.childGrade || lead.childAge, lead.parentName || "보호자 미입력", lead.parentPhone].filter(Boolean).join(" · ");
        const createdDateLabel = getScheduleValue("신청일");
        const trialListDate = getTrialListDateValue(lead);
        const trialDateLabel = trialListDate ? formatCompactDate(trialListDate) : getScheduleValue("체험일");
        const createdDateMobileLabel = formatMonthDayDate(lead.createdAt);
        const trialDateMobileLabel = trialListDate ? formatMonthDayDate(trialListDate) : trialDateLabel;
        const scheduleLabel = formatTrialListScheduleShort(lead, classesById, classesBySlotKey);
        const teacherLabel = formatTrialListTeacherName(lead, classesById, classesBySlotKey);
        const schoolLabel = lead.childSchool || "-";
        const gradeLabel = lead.childGrade || lead.childAge || "-";
        const feeChip = trialFeeListChip(lead);
        const staffMark = trialStaffMarkBadge(lead.staffAttendanceStatus);
        return (
            <tr
                key={`${lead.id}-list`}
                tabIndex={0}
                onClick={() => {
                    setShowDetailModal(lead);
                }}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return; // 행 안 버튼(⚡·체험 연결)의 Enter/Space 는 버튼이 처리
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setShowDetailModal(lead);
                    }
                }}
                className="cursor-pointer transition focus:bg-[var(--color-academy-primary-soft)] focus:outline-none"
            >
                <td className="px-2 py-1.5">
                    {/* 상태 — 아이콘 없이 글자 배지(2026-11-13 UI 통일: 휴대폰에서도 글자로 보인다) */}
                    <span className={`inline-flex items-center whitespace-nowrap rounded px-2 py-1 text-xs font-medium ${cfg.color}`}>{cfg.label}</span>
                </td>
                <td className="admin-cell-num px-2 py-1.5">
                    <span className="hidden text-[var(--color-academy-ink)] sm:block" title={createdDateLabel}>
                        {createdDateLabel}
                    </span>
                    <span className="block text-[var(--color-academy-ink)] sm:hidden" title={createdDateLabel}>
                        {createdDateMobileLabel}
                    </span>
                </td>
                <td className="admin-cell-num px-2 py-1.5">
                    <span className="hidden text-[var(--color-academy-ink)] sm:block" title={trialDateLabel}>
                        {trialDateLabel}
                    </span>
                    <span className="block text-[var(--color-academy-ink)] sm:hidden" title={trialDateLabel}>
                        {trialDateMobileLabel}
                    </span>
                </td>
                <td className="px-2 py-1.5">
                    <span className="block text-[var(--color-academy-ink)]" title={scheduleLabel}>
                        {scheduleLabel}
                    </span>
                </td>
                <td className="hidden px-2 py-1.5 md:table-cell">
                    <span className="block text-[var(--color-academy-muted)]" title={teacherLabel}>
                        {teacherLabel}
                    </span>
                </td>
                <td className="px-2 py-1.5">
                    <span className="block font-semibold text-[var(--color-academy-ink)]" title={rowTitle}>
                        {lead.childName}
                        {/* 체험비 상태(결제·입금 대기·환불 필요 등) — 이름 옆 한 단어, 행 높이를 늘리지 않는다 */}
                        {feeChip && (
                            <span className={`ml-1 text-xs font-medium ${feeChip.needsAction ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-muted)]"}`} title={`체험비: ${trialFeeStatusLabel(lead)}`}>
                                {feeChip.label}
                            </span>
                        )}
                        {/* 선생님이 출석부에서 찍은 체험 출결(출석·지각·결석) — 작은 배지 하나, 행 높이는 그대로 */}
                        {staffMark && (
                            <span className={`ml-1 rounded px-1 py-0.5 text-xs font-medium ${statusBadgeClass(staffMark.tone)}`} title="선생님이 출석부에서 찍은 체험 출결">
                                선생님 {staffMark.label}
                            </span>
                        )}
                    </span>
                </td>
                <td className="hidden px-2 py-1.5 md:table-cell">
                    <span className="block text-[var(--color-academy-muted)]" title={schoolLabel}>
                        {schoolLabel}
                    </span>
                </td>
                <td className="px-2 py-1.5">
                    <span className="block text-[var(--color-academy-muted)]" title={gradeLabel}>
                        {gradeLabel}
                    </span>
                </td>
                <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                    {/* 공용 ⚡ 메뉴(게슈탈트 C-A1) — 따로 만든 복사본을 없애고 같은 위험·주인공 규칙을 쓴다 */}
                    <AdminQuickActionMenu label={`${lead.childName} 빠른 처리`} actions={buildTrialQuickActions(lead, parentPhoneHref)} />
                </td>
            </tr>
        );
    }

    function renderTrialList() {
        // 상태별 보기: 상태 순서(신규→…→취소)대로 묶음 머리줄(«체험예정 · 2건») 아래 같은 한 줄 행.
        // 머리줄 건수는 «조건에 맞는 전체» 기준, 행은 지금 펼쳐 둔(더 보기) 만큼만.
        const statusGroups = trialView === "status"
            ? [...STATUS_ORDER, OTHER_STATUS_GROUP].map((status) => {
                const inGroup = (lead: TrialLead) =>
                    status === OTHER_STATUS_GROUP ? !(STATUS_ORDER as readonly string[]).includes(lead.status) : lead.status === status;
                return {
                    status,
                    label: status === OTHER_STATUS_GROUP ? "기타" : STATUS_CONFIG[status].label,
                    total: filteredLeads.filter(inGroup).length,
                    leads: visibleLeads.filter(inGroup),
                };
            }).filter((group) => group.leads.length > 0)
            : [];

        return (
            <div className="overflow-x-auto overflow-y-visible rounded-xl border border-[var(--color-academy-line)] bg-white shadow-sm">
                <table className="admin-list-table w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-[var(--color-academy-soft)] text-xs font-semibold uppercase text-[var(--color-academy-muted)]">
                        <tr>
                            <th className="px-2 py-2">상태</th>
                            <th className="admin-cell-num px-2 py-2">신청일</th>
                            <th className="admin-cell-num px-2 py-2">체험일</th>
                            <th className="px-2 py-2">수업</th>
                            <th className="hidden px-2 py-2 md:table-cell">담당교사</th>
                            <th className="px-2 py-2">수강생이름</th>
                            <th className="hidden px-2 py-2 md:table-cell">학교</th>
                            <th className="px-2 py-2">학년</th>
                            <th className="admin-cell-center px-2 py-2">액션</th>
                        </tr>
                    </thead>
                    {trialView === "status" ? (
                        statusGroups.map((group) => (
                            <tbody key={group.status}>
                                <tr>
                                    <th colSpan={TRIAL_LIST_COLUMN_COUNT} scope="rowgroup" className="bg-[var(--color-academy-soft)] px-2 py-1.5 text-xs font-semibold text-[var(--color-academy-ink)]">
                                        {group.label} · <span className="tabular-nums">{group.total}</span>건
                                    </th>
                                </tr>
                                {group.leads.map(renderTrialRow)}
                            </tbody>
                        ))
                    ) : (
                        <tbody>{visibleLeads.map(renderTrialRow)}</tbody>
                    )}
                </table>
            </div>
        );
    }

    if (loading && leads.length === 0) {
        return <TrialCrmLoadingFallback />;
    }

    if (loadError && leads.length === 0) {
        return <TrialCrmErrorState onRetry={() => void loadTrialData()} />;
    }

    return (
        <div className="space-y-2">
            {feedback && (
                <div
                    className={`fixed bottom-4 left-4 right-4 z-[120] flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium shadow-2xl sm:bottom-auto sm:left-auto sm:right-6 sm:top-6 sm:w-[380px] ${
                        feedback.type === "success"
                            ? "border-[var(--color-academy-line)] bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                            : feedback.type === "info"
                            ? "border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] text-[var(--color-academy-ink)]"
                            : "border-[var(--color-academy-line)] bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]"
                    }`}
                    role="status"
                >
                    {feedback.message}
                </div>
            )}

            <CompactListFilters
                compactSearch
                activeCount={Number(filter !== "ALL") + Number(dateFilter !== "ALL") + Number(workFilter !== "ALL")}
                summary={[filter !== "ALL" ? STATUS_CONFIG[filter]?.label : null, dateFilter !== "ALL" ? TRIAL_DATE_FILTERS.find(item => item.value === dateFilter)?.label : null, workFilter !== "ALL" ? TRIAL_WORK_FILTERS.find(item => item.value === workFilter)?.label : null].filter(Boolean).join(" · ") || `전환율 ${stats.conversionRate}%`}
                resultCount={`${filteredLeads.length}건`}
                onReset={() => { setFilter("ALL"); setDateFilter("ALL"); setWorkFilter("ALL"); }}
                search={<label className="flex min-h-11 min-w-0 items-center gap-1 rounded-md border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-2 sm:gap-2 sm:px-3">
                    <input type="search" aria-label="학생, 보호자, 전화번호, 학교, 메모로 검색" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="신청 검색" className="min-w-0 flex-1 bg-transparent py-2 text-sm text-[var(--color-academy-ink)] outline-none [&::-webkit-search-cancel-button]:appearance-none" />
                    {searchQuery && <button type="button" onClick={() => setSearchQuery("")} title="검색어 지우기" className="-mr-2 inline-flex min-h-11 w-11 shrink-0 items-center justify-center text-[var(--color-academy-muted)] sm:-mr-3"><span className="material-symbols-outlined text-lg" aria-hidden="true">close</span></button>}
                </label>}
                // 이 화면의 주 버튼. 아이콘 대신 글자 — 좁은 화면에서는 줄이 찌그러지지 않게 «등록» 두 글자만(2026-11-13 UI 통일)
                actions={<button type="button" onClick={() => setShowAddModal(true)} aria-label="체험 신청 등록" title="체험 신청 등록" className="academy-button-primary shrink-0 whitespace-nowrap"><span className="sm:hidden">등록</span><span className="hidden sm:inline">체험 신청 등록</span></button>}
            >
                <label className="min-w-0 space-y-1 text-xs font-medium text-[var(--color-academy-muted)]">신청 상태
                    <select aria-label="체험 신청 상태" value={filter} onChange={event => setFilter(event.target.value)} className="academy-input block min-w-0">
                        <option value="ALL">전체 {stats.total}</option>
                        {STATUS_ORDER.map(status => <option key={status} value={status}>{STATUS_CONFIG[status].label} {stats[status]}</option>)}
                    </select>
                </label>
                <label className="min-w-0 space-y-1 text-xs font-medium text-[var(--color-academy-muted)]">체험일
                    <select aria-label="체험일 필터" value={dateFilter} onChange={event => setDateFilter(event.target.value as TrialDateFilter)} className="academy-input block min-w-0">
                        {TRIAL_DATE_FILTERS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                </label>
                <label className="min-w-0 space-y-1 text-xs font-medium text-[var(--color-academy-muted)]">업무 조건
                    <select aria-label="체험 업무 조건" value={workFilter} onChange={event => setWorkFilter(event.target.value as TrialWorkFilter)} className="academy-input block min-w-0">
                        {TRIAL_WORK_FILTERS.map(item => <option key={item.value} value={item.value}>{item.label} {workFilterCounts[item.value]}</option>)}
                    </select>
                </label>
                <div className="min-w-0 space-y-1">
                    <p className="text-xs font-medium text-[var(--color-academy-muted)]">보기 방식</p>
                    <ListViewToggle value={trialView} options={TRIAL_VIEW_OPTIONS} onChange={setTrialView} ariaLabel="체험 문의 보기 방식" />
                </div>
            </CompactListFilters>

            {/* ── 리드 목록 ── */}
            {filteredLeads.length === 0 ? (
                <div className="text-center py-10 bg-white rounded-xl border border-[var(--color-academy-line)]">
                    <p className="text-[var(--color-academy-muted)]">
                        {searchQuery || workFilter !== "ALL" || dateFilter !== "ALL"
                            ? "조건에 맞는 체험 문의가 없습니다"
                            : filter === "ALL"
                            ? "등록된 체험 신청이 없습니다"
                            : `"${STATUS_CONFIG[filter]?.label}" 상태의 신청이 없습니다`}
                    </p>
                    {hasMoreServerLeads && (
                        <button
                            type="button"
                            onClick={handleShowMoreLeads}
                            disabled={loadingMore}
                            className="academy-button-secondary mt-4"
                        >
                            {loadingMore ? "불러오는 중..." : "다음 50건에서 더 찾아보기"}
                        </button>
                    )}
                </div>
            ) : (
                <div className="grid gap-4">
                    {renderTrialList()}
                    {hasMoreLeads && (<div className="flex flex-col gap-3 rounded-xl border border-[var(--color-academy-line)] bg-white px-4 py-3 text-sm text-[var(--color-academy-muted)] sm:flex-row sm:items-center sm:justify-between">
                        <span>
                            {filteredLeads.length}건 중 {visibleLeads.length}건 표시
                        </span>
                        {hasMoreLeads && (
                            <button
                                type="button"
                                onClick={handleShowMoreLeads}
                                disabled={loadingMore}
                                className="academy-button-secondary"
                            >
                                {loadingMore ? "불러오는 중..." : "50건 더 보기"}
                            </button>
                        )}
                    </div>)}
                </div>
            )}

            {hasTrialModal && (
                <TrialCrmModals
                    addOpen={showAddModal}
                    editLead={showEditModal}
                    scheduleLead={showScheduleModal}
                    cancelLead={showCancelModal}
                    convertLead={showConvertModal}
                    lostLead={showLostModal}
                    memoLead={showMemoModal}
                    onCloseAdd={() => setShowAddModal(false)}
                    onCloseEdit={() => setShowEditModal(null)}
                    onCloseSchedule={() => setShowScheduleModal(null)}
                    onCloseCancel={() => setShowCancelModal(null)}
                    onCloseConvert={() => setShowConvertModal(null)}
                    onCloseLost={() => setShowLostModal(null)}
                    onCloseMemo={() => setShowMemoModal(null)}
                    classes={classes}
                    // 저장 성공을 알리기 전에 최신 목록이 실제로 반영됐는지 확인한다.
                    onSaved={() => loadTrialData()}
                    onFeedback={showFeedback}
                />
            )}

            {showDetailModal && (
                <TrialLeadDetailModal
                    lead={showDetailModal}
                    scheduleItems={getTrialScheduleItems(showDetailModal, classesBySlotKey, classesById)}
                    onClose={() => setShowDetailModal(null)}
                    onEdit={() => {
                        setShowEditModal(showDetailModal);
                        setShowDetailModal(null);
                    }}
                    onSchedule={() => {
                        setShowScheduleModal(showDetailModal);
                        setShowDetailModal(null);
                    }}
                    onSendManualSms={() => {
                        setManualSmsModal({ lead: showDetailModal });
                        setShowDetailModal(null);
                    }}
                    onContact={() => {
                        setContactModal({ lead: showDetailModal, defaultAction: "CONTACTED" });
                        setShowDetailModal(null);
                    }}
                    onMarkAttended={() => void handleStatusChange(showDetailModal, "ATTENDED")}
                    onSendEnrollGuide={() => handleSendEnrollGuide(showDetailModal)}
                    onCancel={() => {
                        setShowCancelModal(showDetailModal);
                        setShowDetailModal(null);
                    }}
                    onLost={() => {
                        setShowLostModal(showDetailModal);
                        setShowDetailModal(null);
                    }}
                    onCoachNotice={() => void handleSendCoachNotice(showDetailModal)}
                    onResendSms={() => void handleResendApplicationSms(showDetailModal)}
                    onConfirmTrialFee={() => void handleConfirmTrialFee(showDetailModal)}
                    busy={busy}
                    trialFeeBusy={Boolean(trialFeeBusyId)}
                />
            )}

            {contactModal && (
                <TrialContactModal
                    lead={contactModal.lead}
                    defaultAction={contactModal.defaultAction}
                    busy={contactBusyId === contactModal.lead.id}
                    onClose={() => setContactModal(null)}
                    onSubmit={async ({ action, note, nextFollowUpAt }) => {
                        await handleRecordContact(contactModal.lead, action, note, nextFollowUpAt);
                        setContactModal(null);
                    }}
                />
            )}

            {manualSmsModal && (
                <ManualSmsModal
                    title="학부모 문자 보내기"
                    recipientLabel={`${manualSmsModal.lead.childName} · ${manualSmsModal.lead.parentName || "보호자"}`}
                    recipientPhone={manualSmsModal.lead.parentPhone}
                    defaultMessage={buildTrialManualSmsMessage(manualSmsModal.lead)}
                    busy={manualSmsBusy}
                    onClose={() => {
                        if (!manualSmsBusy) setManualSmsModal(null);
                    }}
                    onSubmit={(message) => handleSendManualSms(manualSmsModal.lead, message)}
                />
            )}

            {enrollGuideConfirm && (
                <EnrollGuideConfirmModal
                    lead={enrollGuideConfirm.lead}
                    convertAfterConfirm={enrollGuideConfirm.convertAfterConfirm}
                    busy={busy}
                    onClose={() => {
                        if (!busy) setEnrollGuideConfirm(null);
                    }}
                    onConfirm={() => void handleConfirmEnrollGuide()}
                    onConfirmNoSms={() => void handleConvertWithoutSms()}
                />
            )}
        </div>
    );
}

function EnrollGuideConfirmModal({
    lead,
    convertAfterConfirm,
    busy,
    onClose,
    onConfirm,
    onConfirmNoSms,
}: {
    lead: TrialLead;
    convertAfterConfirm: boolean;
    busy: boolean;
    onClose: () => void;
    onConfirm: () => void;
    onConfirmNoSms?: () => void;
}) {
    return (
        <AdminModal onClose={busy ? () => undefined : onClose} titleId="trial-enroll-guide-confirm-title" panelClassName="max-w-md">
            <div className="p-6">
                {/* 장식 아이콘 원을 빼고 글자로만(2026-11-13 UI 통일) */}
                <div className="flex items-start gap-3">
                    <div>
                        <p className="text-xs font-medium text-[var(--color-academy-muted)]">
                            수강신청 전환
                        </p>
                        <h2 id="trial-enroll-guide-confirm-title" className="mt-1 text-lg font-bold text-[var(--color-academy-ink)]">
                            수강신청서를 전송하시겠습니까?
                        </h2>
                        <p className="mt-2 text-sm leading-6 text-[var(--color-academy-muted)]">
                            {lead.childName} 보호자에게 수강신청서 링크를 문자로 발송합니다.
                            같은 신청 건은 중복 발송되지 않습니다.
                        </p>
                    </div>
                </div>

                <div className="mt-5 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] p-4 text-sm">
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-[var(--color-academy-muted)]">수강생</span>
                        <span className="font-semibold text-[var(--color-academy-ink)]">{lead.childName}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="text-[var(--color-academy-muted)]">처리</span>
                        <span className="font-semibold text-[var(--color-academy-ink)]">
                            {convertAfterConfirm ? "등록전환 + 문자 발송" : "문자 발송"}
                        </span>
                    </div>
                </div>

                <div className="mt-6 space-y-2">
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={busy}
                        // 문자 발송 = 이 확인창의 주 버튼(강조 등급 그대로, 테마 클래스로만 옮김)
                        className="academy-button-primary w-full"
                    >
                        {busy ? "처리 중..." : convertAfterConfirm ? "등록전환 + 문자 발송" : "문자 발송"}
                    </button>
                    {convertAfterConfirm && onConfirmNoSms && (
                        <button
                            type="button"
                            onClick={onConfirmNoSms}
                            disabled={busy}
                            className="academy-button-secondary w-full"
                        >
                            {busy ? "처리 중..." : "문자 없이 전환만"}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="academy-button-text w-full"
                    >
                        취소
                    </button>
                </div>
            </div>
        </AdminModal>
    );
}

function TrialLeadDetailModal({
    lead,
    scheduleItems,
    onClose,
    onEdit,
    onSchedule,
    onSendManualSms,
    onContact,
    onMarkAttended,
    onSendEnrollGuide,
    onCancel,
    onLost,
    onCoachNotice,
    onResendSms,
    onConfirmTrialFee,
    busy,
    trialFeeBusy,
}: {
    lead: TrialLead;
    scheduleItems: Array<{ label: string; value: string; className: string }>;
    onClose: () => void;
    onEdit: () => void;
    onSchedule: () => void;
    onSendManualSms: () => void;
    onContact: () => void;
    onMarkAttended: () => void;
    onSendEnrollGuide: () => void;
    onCancel: () => void;
    onLost: () => void;
    onCoachNotice: () => void;
    onResendSms: () => void;
    onConfirmTrialFee: () => void;
    busy: boolean;
    trialFeeBusy: boolean;
}) {
    const cfg = STATUS_CONFIG[lead.status] || STATUS_CONFIG.NEW;
    const details = [
        ["학생", [lead.childName, lead.childGrade || lead.childAge, lead.childSchool].filter(Boolean).join(" · ")],
        ["보호자", [lead.parentName || "미입력", lead.parentPhone].filter(Boolean).join(" · ")],
        ["유입경로", SOURCE_LABELS[lead.source] || lead.source],
        ["농구 경험", lead.basketballExp || "미입력"],
        // 학부모 동의(trialFeeNoticeAgreedAt)만으로는 「입금 완료」가 되지 않는다
        ["체험비", trialFeeStatusLabel(lead)],
        ["최근 연락", lead.latestContactAction ? `${CONTACT_ACTION_LABELS[lead.latestContactAction] ?? lead.latestContactAction}${lead.latestContactAt ? ` · ${formatContactDateTime(lead.latestContactAt)}` : ""}` : "기록 없음"],
    ];

    return (
        // 목록 개편: 상세는 가운데 모달 대신 오른쪽 패널(모바일은 아래 시트)로 연다. 내용·기능은 그대로.
        <ListDetailPanel onClose={onClose} titleId="trial-detail-modal-title">
            <div className="w-full p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium ${cfg.color}`}>
                                {cfg.label}
                            </span>
                            <span className="text-xs tabular-nums text-[var(--color-academy-muted)]">접수 {formatCompactDateTime(lead.createdAt)}</span>
                        </div>
                        <h2 id="trial-detail-modal-title" className="mt-2 text-lg font-bold text-[var(--color-academy-ink)]">
                            {lead.childName} 체험 신청 상세
                        </h2>
                    </div>
                    <div className="flex items-center gap-1">
                        <a
                            href={phoneHref(lead.parentPhone)}
                            className={DETAIL_ACTION_CLASS}
                        >
                            전화
                        </a>
                        {/* 패널이 길어도 위에서 바로 닫을 수 있게 */}
                        <button type="button" onClick={onClose} aria-label="상세 닫기" className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                            <span className="material-symbols-outlined text-xl" aria-hidden="true">close</span>
                        </button>
                    </div>
                </div>

                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                    {scheduleItems.map((item) => (
                        <div key={`trial-detail-${item.label}`} className={`rounded-lg border px-3 py-2 ${item.className}`}>
                            <p className="text-xs font-medium opacity-80">
                                {item.label}
                            </p>
                            <p className="mt-1 break-keep text-sm font-semibold">{item.value}</p>
                        </div>
                    ))}
                </div>

                <dl className="mt-5 grid gap-2 sm:grid-cols-2">
                    {details.map(([label, value]) => (
                        <div key={`trial-detail-row-${label}`} className="rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-3 py-2">
                            <dt className="text-xs font-medium text-[var(--color-academy-muted)]">{label}</dt>
                            <dd className="mt-0.5 break-keep text-sm text-[var(--color-academy-ink)]">{value || "미입력"}</dd>
                        </div>
                    ))}
                </dl>

                {(lead.hopeNote || lead.memo || lead.openFollowUpNote) && (
                    <div className="mt-5 space-y-2">
                        {lead.hopeNote && (
                            <p className="rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
                                희망 메모: {lead.hopeNote}
                            </p>
                        )}
                        {lead.memo && (
                            <p className="rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-muted)]">
                                관리 메모: {lead.memo}
                            </p>
                        )}
                        {lead.openFollowUpNote && (
                            <p className="rounded-lg bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
                                재연락 메모: {lead.openFollowUpNote}
                            </p>
                        )}
                    </div>
                )}

                <div className="mt-6 flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={onClose} className="academy-button-text academy-button-sm">
                        닫기
                    </button>
                    <button type="button" onClick={onContact} className={DETAIL_ACTION_CLASS}>
                        연락 기록
                    </button>
                    <button type="button" onClick={onSendManualSms} disabled={busy} className={DETAIL_ACTION_CLASS}>
                        문자 보내기
                    </button>
                    {!lead.trialFeeConfirmed && (
                        <button type="button" onClick={onConfirmTrialFee} disabled={trialFeeBusy} aria-busy={trialFeeBusy} className={DETAIL_ACTION_CLASS}>
                            {trialFeeBusy ? "확인 중…" : "입금 확인"}
                        </button>
                    )}
                    {!lead.coachNoticeSentAt && (
                        <button type="button" onClick={onCoachNotice} className={DETAIL_ACTION_CLASS}>
                            쌤 알림
                        </button>
                    )}
                    {lead.smsDeliveryFailed > 0 && (
                        <button type="button" onClick={onResendSms} className={DETAIL_ACTION_CLASS}>
                            문자 재발송
                        </button>
                    )}
                    {!isClosedTrialStatus(lead.status) && (lead.status === "NEW" || lead.status === "CONTACTED" || lead.status === "SCHEDULED") && (
                        <button type="button" onClick={onSchedule} className={DETAIL_ACTION_CLASS}>
                            {lead.status === "SCHEDULED" ? "일정 변경" : "일정 확정"}
                        </button>
                    )}
                    {lead.status === "SCHEDULED" && (
                        <button type="button" onClick={onMarkAttended} disabled={busy} className="academy-button-primary academy-button-sm">
                            체험 완료
                        </button>
                    )}
                    {lead.status === "ATTENDED" && !lead.enrollApplicationReceivedAt && (
                        <button type="button" onClick={onSendEnrollGuide} disabled={busy} className="academy-button-primary academy-button-sm">
                            {lead.enrollGuideSentAt ? "수강신청 안내 재발송" : "수강신청 안내"}
                        </button>
                    )}
                    {/* 수정은 보조 버튼 — 꽉 찬 주 버튼은 그 단계의 다음 일(체험 완료·수강신청 안내) 하나만(2026-11-13 UI 통일) */}
                    <button type="button" onClick={onEdit} className={DETAIL_ACTION_CLASS}>
                        수정
                    </button>
                </div>
                {!isClosedTrialStatus(lead.status) && (
                    <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-[var(--color-academy-line)] pt-4">
                        <span className="mr-auto self-center text-xs text-[var(--color-academy-faint)]">종료 작업</span>
                        <button type="button" onClick={onLost} className="academy-button-text academy-button-sm">이탈 처리</button>
                        <button type="button" onClick={onCancel} className="academy-button-danger academy-button-sm">신청 취소</button>
                    </div>
                )}
            </div>
        </ListDetailPanel>
    );
}

function TrialContactModal({
    lead,
    defaultAction,
    busy,
    onClose,
    onSubmit,
}: {
    lead: TrialLead;
    defaultAction: ContactActionType;
    busy: boolean;
    onClose: () => void;
    onSubmit: (input: { action: ContactActionType; note: string | null; nextFollowUpAt: string | null }) => Promise<void> | void;
}) {
    const [action, setAction] = useState<ContactActionType>(defaultAction);
    const [note, setNote] = useState("");
    const [nextFollowUpAt, setNextFollowUpAt] = useState("");
    const [formError, setFormError] = useState("");

    function handleSubmit(event: FormEvent) {
        event.preventDefault();
        if (action === "FOLLOW_UP" && !nextFollowUpAt) {
            setFormError("다음 연락 예정일을 선택해 주세요.");
            return;
        }
        setFormError("");
        void onSubmit({
            action,
            note: note.trim() || null,
            nextFollowUpAt: nextFollowUpAt ? new Date(nextFollowUpAt).toISOString() : null,
        });
    }

    return (
        <AdminModal onClose={onClose} titleId="trial-contact-modal-title" panelClassName="max-w-md" closeOnBackdrop={!busy}>
            <form
                onSubmit={handleSubmit}
                className="w-full p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            >
                <h2 id="trial-contact-modal-title" className="text-lg font-bold text-[var(--color-academy-ink)]">
                    후속 연락 기록
                </h2>
                <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                    {lead.childName} · {lead.parentName} {lead.parentPhone}
                </p>

                <div className="mt-5 grid grid-cols-2 gap-2">
                    {(["CONTACTED", "NO_ANSWER", "FOLLOW_UP", "MEMO"] as ContactActionType[]).map((option) => (
                        <button
                            key={option}
                            type="button"
                            onClick={() => setAction(option)}
                            // 고르는 칩 = 테마 선택 칩(고르면 ✓ + 하늘색) — 2026-11-13 UI 통일
                            aria-pressed={action === option}
                            className="academy-choice"
                        >
                            {CONTACT_ACTION_LABELS[option]}
                        </button>
                    ))}
                </div>

                {action === "FOLLOW_UP" && (
                    <label className="mt-4 block text-sm font-medium text-[var(--color-academy-muted)]">
                        다음 연락 예정
                        <input
                            type="datetime-local"
                            value={nextFollowUpAt}
                            onChange={(event) => setNextFollowUpAt(event.target.value)}
                            className="academy-input mt-1"
                        />
                    </label>
                )}

                <label className="mt-4 block text-sm font-medium text-[var(--color-academy-muted)]">
                    상담 메모
                    <textarea
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        rows={4}
                        className="academy-input mt-1 resize-none"
                        placeholder="상담 내용이나 다음에 확인할 내용을 적어주세요"
                    />
                </label>

                {formError && (
                    <p className="mt-3 rounded-lg bg-[var(--color-academy-danger-soft)] px-3 py-2 text-sm font-medium text-[var(--color-academy-danger)]">
                        {formError}
                    </p>
                )}

                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="academy-button-text"
                    >
                        닫기
                    </button>
                    <button
                        type="submit"
                        disabled={busy}
                        className="academy-button-primary"
                    >
                        {busy ? "저장 중..." : "저장"}
                    </button>
                </div>
            </form>
        </AdminModal>
    );
}
