"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from "react";
import dynamic from "next/dynamic";
import AdminModal from "@/components/admin/AdminModal";
import CompactListFilters from "@/components/academy/CompactListFilters";
import ManualSmsModal from "@/app/admin/apply/ManualSmsModal";
import { trialFeeStatusLabel } from "@/lib/trial-fee-confirmation";
import {
    updateTrialLead,
    sendPostTrialEnrollGuide,
    sendTrialCoachNotice,
    resendTrialApplicationSms,
    resendTrialAttendedSms,
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
const LIST_ACTION_TRIGGER_CLASS = "inline-flex size-9 items-center justify-center rounded-full bg-red-500 text-white shadow-lg shadow-red-500/20 transition hover:scale-105 hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-300 disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:shadow-brand-neon-lime/20 dark:hover:bg-lime-300";
const LIST_ACTION_MENU_CLASS = "fixed z-[80] flex max-h-[70vh] w-44 -translate-y-1/2 flex-col gap-2 overflow-y-auto rounded-2xl border border-gray-200 bg-white/95 p-2 text-left shadow-2xl backdrop-blur dark:border-gray-700 dark:bg-gray-950/95";
const LIST_ACTION_ITEM_CLASS = "flex min-h-9 w-full items-center justify-between gap-2 rounded-full border border-gray-200 bg-white px-2 pl-3 text-left text-xs font-black text-gray-700 shadow-sm transition hover:border-brand-orange-300 hover:bg-brand-orange-50 hover:text-brand-orange-700 disabled:opacity-50 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:hover:border-brand-neon-lime dark:hover:bg-brand-neon-lime/10 dark:hover:text-brand-neon-lime";
const LIST_ACTION_PRIMARY_CLASS = "flex min-h-9 w-full items-center justify-between gap-2 rounded-full bg-brand-neon-lime px-2 pl-3 text-left text-xs font-black text-brand-navy-900 shadow-sm transition hover:bg-lime-300 disabled:opacity-50";
const LIST_ACTION_ICON_CLASS = "inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-gray-900 text-white dark:bg-brand-neon-lime dark:text-brand-navy-900";
const DETAIL_ACTION_CLASS = "inline-flex min-h-8 items-center gap-1.5 rounded-md border border-gray-200 px-3 text-xs font-bold text-gray-700 transition hover:border-brand-orange-300 hover:bg-brand-orange-50 hover:text-brand-orange-700 dark:border-gray-700 dark:text-gray-100 dark:hover:border-brand-neon-lime dark:hover:bg-brand-neon-lime/10";
const QUICK_ACTION_MENU_WIDTH = 176;
const QUICK_ACTION_MENU_HALF_HEIGHT = 176;

type QuickActionMenuPosition = {
    top: number;
    left: number;
};

function getQuickActionMenuPosition(button: HTMLButtonElement): QuickActionMenuPosition {
    const rect = button.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - QUICK_ACTION_MENU_WIDTH - 8);
    const left = Math.min(Math.max(8, rect.left - QUICK_ACTION_MENU_WIDTH - 8), maxLeft);
    const minTop = Math.min(window.innerHeight / 2, QUICK_ACTION_MENU_HALF_HEIGHT + 8);
    const maxTop = Math.max(minTop, window.innerHeight - QUICK_ACTION_MENU_HALF_HEIGHT - 8);
    const top = Math.min(Math.max(rect.top + rect.height / 2, minTop), maxTop);
    return { top, left };
}

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

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
    NEW: { label: "신규", color: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-200", icon: "fiber_new" },
    CONTACTED: { label: "연락완료", color: "bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200", icon: "call" },
    SCHEDULED: { label: "체험예정", color: "bg-purple-100 text-purple-800 dark:bg-purple-950/50 dark:text-purple-200", icon: "event" },
    ATTENDED: { label: "체험완료", color: "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200", icon: "check_circle" },
    CONVERTED: { label: "등록전환", color: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200", icon: "how_to_reg" },
    LOST: { label: "이탈", color: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400", icon: "person_off" },
    CANCELLED: { label: "취소", color: "bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400", icon: "block" },
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
    return error instanceof Error ? error.message : fallback;
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
    const candidates: string[] = [];
    const directSlotKey = normalizeSlotKey(lead.preferredSlotKey);
    const dayCode = normalizePreferredDayCode(lead.preferredDay);
    const period = normalizePreferredPeriod(lead.preferredPeriod);
    const derivedSlotKey = dayCode && period ? `${dayCode}-${period}` : null;

    [directSlotKey, derivedSlotKey].forEach((slotKey) => {
        if (slotKey && !candidates.includes(slotKey)) candidates.push(slotKey);
    });

    return candidates;
}

function getPreferredClass(lead: TrialLead, classesBySlotKey?: Map<string, ClassInfo>) {
    for (const slotKey of getPreferredSlotKeyCandidates(lead)) {
        const classInfo = classesBySlotKey?.get(slotKey);
        if (classInfo) return classInfo;
    }
    return null;
}

function formatClassLabel(classInfo: ClassInfo) {
    const dayLabel = DAY_LABELS[classInfo.dayOfWeek] || classInfo.dayOfWeek;
    const timeLabel = [classInfo.startTime, classInfo.endTime].filter(Boolean).join("~");
    const programName = classInfo.program?.name ? ` · ${classInfo.program.name}` : "";
    return [dayLabel, timeLabel].filter(Boolean).join(" ") + ` · ${classInfo.name}${programName}`;
}

function getPeriodFromClass(classInfo: ClassInfo) {
    const slotPeriod = classInfo.slotKey?.split("-")[1]?.match(/\d+/)?.[0];
    if (slotPeriod) return slotPeriod;
    return classInfo.name.match(/\d+/)?.[0] ?? "";
}

function formatClassShortLabel(classInfo: ClassInfo) {
    const dayLabel = DAY_SHORT_LABELS[classInfo.dayOfWeek] || classInfo.dayOfWeek;
    const period = getPeriodFromClass(classInfo);
    return [dayLabel, period].filter(Boolean).join("");
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

    const slotLabel = formatSlotShortLabel(lead.preferredSlotKey);
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
    const classLabel = matchedClass ? formatClassShortLabel(matchedClass) : formatPreferredScheduleShort(lead, classesBySlotKey);
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
    if (confirmedClass) return formatClassShortLabel(confirmedClass);
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
    if (matchedClass) return formatClassLabel(matchedClass);

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
        return `${formatCompactDate(lead.scheduledDate)} · ${formatClassLabel(matchedClass)}`;
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
            icon: "inbox",
            value: formatCompactDate(lead.createdAt),
            className: "border-gray-100 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200",
        },
        {
            label: "체험일",
            icon: "event",
            value: lead.trialDate ? formatCompactDate(lead.trialDate) : "미입력",
            className: "border-lime-100 bg-lime-50 text-lime-800 dark:border-lime-900/50 dark:bg-lime-950/30 dark:text-lime-200",
        },
        {
            label: "수업교시",
            icon: "schedule",
            value: preferredSchedule || "미입력",
            className: "border-purple-100 bg-purple-50 text-purple-800 dark:border-purple-900/50 dark:bg-purple-950/30 dark:text-purple-200",
        },
        {
            label: "확정일정",
            icon: "event_available",
            value: confirmedSchedule || "미확정",
            className: "border-sky-100 bg-sky-50 text-sky-800 dark:border-sky-900/50 dark:bg-sky-950/30 dark:text-sky-200",
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
        <div className="rounded-2xl border border-red-100 bg-white p-8 text-center shadow-sm dark:border-red-900/40 dark:bg-gray-800">
            <span className="material-symbols-outlined mb-3 text-4xl text-red-500">error</span>
            <p className="font-bold text-gray-900 dark:text-white">체험 문의 정보를 불러오지 못했습니다.</p>
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

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────

export default function TrialCrmClient({
    initialLeads,
    initialStats,
    initialClasses,
    initialPagination,
}: {
    initialLeads?: TrialLead[];
    initialStats?: TrialStats;
    initialClasses?: ClassInfo[];
    initialPagination?: ListPagination;
}) {
    const hasInitialData = Boolean(initialLeads && initialStats);
    const [leads, setLeads] = useState<TrialLead[]>(initialLeads ?? []);
    const [stats, setStats] = useState<TrialStats>(initialStats ?? EMPTY_STATS);
    const [classes, setClasses] = useState<ClassInfo[]>(initialClasses ?? []);
    const [loading, setLoading] = useState(!hasInitialData);
    const [loadingMore, setLoadingMore] = useState(false);
    const [pagination, setPagination] = useState<ListPagination | null>(initialPagination ?? null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [filter, setFilter] = useState<string>("ALL");
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
    const [openQuickActionId, setOpenQuickActionId] = useState<string | null>(null);
    const [quickActionMenuPosition, setQuickActionMenuPosition] = useState<QuickActionMenuPosition | null>(null);
	const feedbackTimerRef = useRef<number | null>(null);
    const hasTrialModal = Boolean(showAddModal || showEditModal || showScheduleModal || showCancelModal || showConvertModal || showLostModal || showMemoModal);

    const closeQuickActionMenu = useCallback(() => {
        setOpenQuickActionId(null);
        setQuickActionMenuPosition(null);
    }, []);

    const toggleQuickActionMenu = useCallback((event: MouseEvent<HTMLButtonElement>, leadId: string) => {
        event.stopPropagation();
        if (openQuickActionId === leadId) {
            closeQuickActionMenu();
            return;
        }
        setQuickActionMenuPosition(getQuickActionMenuPosition(event.currentTarget));
        setOpenQuickActionId(leadId);
    }, [closeQuickActionMenu, openQuickActionId]);

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

    useEffect(() => {
        if (!openQuickActionId) return;
        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === "Escape") closeQuickActionMenu();
        };
        window.addEventListener("resize", closeQuickActionMenu);
        window.addEventListener("scroll", closeQuickActionMenu, true);
        window.addEventListener("keydown", handleEscape);
        return () => {
            window.removeEventListener("resize", closeQuickActionMenu);
            window.removeEventListener("scroll", closeQuickActionMenu, true);
            window.removeEventListener("keydown", handleEscape);
        };
    }, [closeQuickActionMenu, openQuickActionId]);

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
            closeQuickActionMenu();
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
            const result = await updateTrialLead(lead.id, updates);
            await loadTrialData();
            if (result?.attendedSms.attempted && !result.attendedSms.sent) {
                const needsOperatorCheck = result.attendedSms.message?.includes("자동 재전송")
                    || result.attendedSms.message?.includes("결과 확인")
                    || result.attendedSms.message?.includes("처리 중");
                const smsFailureGuide = needsOperatorCheck
                    ? result.attendedSms.message
                    : `${result.attendedSms.message || "문자 발송에 실패했습니다."} 상세 보기에서 '완료 문자 재시도'를 눌러 다시 시도해주세요.`;
                showFeedback(
                    "error",
                    `${lead.childName} 상태는 변경됐지만 문자 발송은 실패했습니다. ${smsFailureGuide}`,
                );
            } else {
                showFeedback("success", `${lead.childName} 상태를 ${STATUS_CONFIG[newStatus]?.label ?? "변경"}으로 바꿨습니다.`);
            }
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

    function renderActionIcon(icon: string, primary = false) {
        return (
            <span className={primary ? "inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-brand-navy-900 text-white" : LIST_ACTION_ICON_CLASS}>
                <span className="material-symbols-outlined text-base">{icon}</span>
            </span>
        );
    }

    function renderEnrollGuideButton(lead: TrialLead) {
        if (lead.status !== "ATTENDED" || lead.enrollApplicationReceivedAt) return null;
        const label = lead.enrollGuideSentAt ? "안내 재발송" : "수강신청 안내";
        return (
            <button
                type="button"
                onClick={() => {
                    closeQuickActionMenu();
                    void handleSendEnrollGuide(lead);
                }}
                disabled={busy}
                className={LIST_ACTION_PRIMARY_CLASS}
            >
                <span>{label}</span>
                {renderActionIcon("send", true)}
            </button>
        );
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

    async function handleResendAttendedSms(lead: TrialLead) {
        if (busy) return;
        setBusy(true);
        try {
            const result = await resendTrialAttendedSms(lead.id);
            await loadTrialData();
            showFeedback(result.sent ? "success" : "error", result.message);
        } catch {
            showFeedback("error", "체험 완료 문자 재시도에 실패했습니다. 연락처와 문자 장부를 확인해주세요.");
        } finally {
            setBusy(false);
        }
    }

    function renderTrialList() {
        return (
            <div className="overflow-x-auto overflow-y-visible rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <table className="w-full min-w-[760px] table-fixed border-collapse text-center text-[13px] lg:min-w-0">
                    <colgroup>
                        <col className="w-[12%]" />
                        <col className="w-[9%]" />
                        <col className="w-[9%]" />
                        <col className="w-[6%]" />
                        <col className="w-[8%]" />
                        <col className="w-[10%]" />
                        <col className="w-[18%]" />
                        <col className="w-[5%]" />
                        <col className="w-[12%]" />
                    </colgroup>
                    <thead className="sticky top-0 z-10 bg-gray-50 text-xs font-black uppercase text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                        <tr className="divide-x divide-gray-200 dark:divide-gray-700">
                            <th className="px-2 py-2">상태</th>
                            <th className="px-2 py-2">신청일</th>
                            <th className="px-2 py-2">체험일</th>
                            <th className="px-2 py-2">수업</th>
                            <th className="px-2 py-2">담당교사</th>
                            <th className="px-2 py-2">수강생이름</th>
                            <th className="px-2 py-2">학교</th>
                            <th className="px-2 py-2">학년</th>
                            <th className="px-2 py-2">액션</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                        {visibleLeads.map((lead) => {
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
                            const isActionOpen = openQuickActionId === lead.id;
                            return (
                                <tr
                                    key={`${lead.id}-list`}
                                    tabIndex={0}
                                    onClick={() => {
                                        closeQuickActionMenu();
                                        setShowDetailModal(lead);
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter" || event.key === " ") {
                                            event.preventDefault();
                                            closeQuickActionMenu();
                                            setShowDetailModal(lead);
                                        }
                                    }}
                                    className="cursor-pointer divide-x divide-gray-100 transition hover:bg-gray-50/80 focus:bg-brand-orange-50 focus:outline-none dark:divide-gray-700 dark:hover:bg-gray-900/50 dark:focus:bg-brand-neon-lime/10"
                                >
                                    <td className="px-2 py-1.5 text-center align-middle">
                                        <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold sm:h-auto sm:w-auto sm:max-w-full sm:gap-1 sm:px-2 sm:py-1 ${cfg.color}`} title={cfg.label}>
                                            <span className="material-symbols-outlined text-lg sm:text-sm">{cfg.icon}</span>
                                            <span className="hidden truncate sm:inline">{cfg.label}</span>
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 text-center align-middle">
                                        <span className="hidden truncate font-bold text-gray-800 sm:block dark:text-gray-100" title={createdDateLabel}>
                                            {createdDateLabel}
                                        </span>
                                        <span className="block truncate font-bold text-gray-800 sm:hidden dark:text-gray-100" title={createdDateLabel}>
                                            {createdDateMobileLabel}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 text-center align-middle">
                                        <span className="hidden truncate font-bold text-gray-800 sm:block dark:text-gray-100" title={trialDateLabel}>
                                            {trialDateLabel}
                                        </span>
                                        <span className="block truncate font-bold text-gray-800 sm:hidden dark:text-gray-100" title={trialDateLabel}>
                                            {trialDateMobileLabel}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 text-center align-middle">
                                        <span className="block truncate font-bold text-gray-800 dark:text-gray-100" title={scheduleLabel}>
                                            {scheduleLabel}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 text-center align-middle">
                                        <span className="block truncate font-bold text-gray-700 dark:text-gray-200" title={teacherLabel}>
                                            {teacherLabel}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 text-center align-middle">
                                        <span className="block truncate font-black text-gray-900 dark:text-white" title={rowTitle}>
                                            {lead.childName}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 text-center align-middle">
                                        <span className="block truncate font-bold text-gray-700 dark:text-gray-200" title={schoolLabel}>
                                            {schoolLabel}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 text-center align-middle">
                                        <span className="block truncate font-bold text-gray-700 dark:text-gray-200" title={gradeLabel}>
                                            {gradeLabel}
                                        </span>
                                    </td>
                                    <td className="px-2 py-1.5 text-center align-middle" onClick={(event) => event.stopPropagation()}>
                                        <button
                                            type="button"
                                            onClick={(event) => toggleQuickActionMenu(event, lead.id)}
                                            className={LIST_ACTION_TRIGGER_CLASS}
                                            aria-expanded={isActionOpen}
                                            aria-label={`${lead.childName} 빠른 처리 열기`}
                                        >
                                            <span className="material-symbols-outlined text-lg">flash_on</span>
                                        </button>
                                        {isActionOpen && quickActionMenuPosition && (
                                            <div
                                                className={LIST_ACTION_MENU_CLASS}
                                                aria-label={`${lead.childName} 빠른 처리`}
                                                style={{
                                                    top: `${quickActionMenuPosition.top}px`,
                                                    left: `${quickActionMenuPosition.left}px`,
                                                }}
                                            >
                                                <a href={parentPhoneHref} onClick={closeQuickActionMenu} className={LIST_ACTION_ITEM_CLASS}>
                                                    <span>전화</span>
                                                    {renderActionIcon("call")}
                                                </a>
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        closeQuickActionMenu();
                                                        setManualSmsModal({ lead });
                                                    }}
                                                    disabled={manualSmsBusy}
                                                    className={LIST_ACTION_ITEM_CLASS}
                                                >
                                                    <span>문자 보내기</span>
                                                    {renderActionIcon("sms")}
                                                </button>
                                                {!isClosedTrialStatus(lead.status) && (lead.status === "NEW" || lead.status === "CONTACTED" || lead.status === "SCHEDULED") && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            closeQuickActionMenu();
                                                            setShowScheduleModal(lead);
                                                        }}
                                                        className={LIST_ACTION_ITEM_CLASS}
                                                    >
                                                        <span>{lead.status === "SCHEDULED" ? "일정 변경" : "일정 확정"}</span>
                                                        {renderActionIcon("event_available")}
                                                    </button>
                                                )}
                                                {lead.status === "NEW" && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            closeQuickActionMenu();
                                                            setContactModal({ lead, defaultAction: "CONTACTED" });
                                                        }}
                                                        disabled={contactBusyId === lead.id}
                                                        className={LIST_ACTION_ITEM_CLASS}
                                                    >
                                                        <span>연락 기록</span>
                                                        {renderActionIcon("phone_callback")}
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        closeQuickActionMenu();
                                                        setContactModal({ lead, defaultAction: "MEMO" });
                                                    }}
                                                    disabled={contactBusyId === lead.id}
                                                    className={LIST_ACTION_ITEM_CLASS}
                                                >
                                                    <span>메모</span>
                                                    {renderActionIcon("edit_note")}
                                                </button>
                                                {lead.status === "SCHEDULED" && (lead.trialFeeConfirmed ? (
                                                    <div className={`${LIST_ACTION_ITEM_CLASS} pointer-events-none bg-emerald-50 text-emerald-700 opacity-90 dark:bg-emerald-950/30 dark:text-emerald-200`}>
                                                        <span>입금 완료</span>
                                                        {renderActionIcon("paid")}
                                                    </div>
                                                ) : (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            closeQuickActionMenu();
                                                            void handleConfirmTrialFee(lead);
                                                        }}
                                                        disabled={Boolean(trialFeeBusyId)}
                                                        className={LIST_ACTION_ITEM_CLASS}
                                                    >
                                                        <span>{trialFeeBusyId === lead.id ? "확인 중…" : "입금 확인"}</span>
                                                        {renderActionIcon(trialFeeBusyId === lead.id ? "progress_activity" : "paid")}
                                                    </button>
                                                ))}
                                                {lead.status === "SCHEDULED" && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            closeQuickActionMenu();
                                                            void handleStatusChange(lead, "ATTENDED");
                                                        }}
                                                        disabled={busy}
                                                        className={LIST_ACTION_PRIMARY_CLASS}
                                                    >
                                                        <span>체험 완료</span>
                                                        {renderActionIcon("check_circle", true)}
                                                    </button>
                                                )}
                                                {!isClosedTrialStatus(lead.status) && !lead.coachNoticeSentAt && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            closeQuickActionMenu();
                                                            void handleSendCoachNotice(lead);
                                                        }}
                                                        disabled={busy}
                                                        className={LIST_ACTION_ITEM_CLASS}
                                                    >
                                                        <span>쌤 알림</span>
                                                        {renderActionIcon("school")}
                                                    </button>
                                                )}
                                                {lead.smsDeliveryFailed > 0 && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            closeQuickActionMenu();
                                                            void handleResendApplicationSms(lead);
                                                        }}
                                                        disabled={busy}
                                                        className={LIST_ACTION_ITEM_CLASS}
                                                    >
                                                        <span>문자 재발송</span>
                                                        {renderActionIcon("sms_failed")}
                                                    </button>
                                                )}
                                                {lead.status === "ATTENDED" && renderEnrollGuideButton(lead)}
                                            </div>
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
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
        <div className="space-y-6">
            {feedback && (
                <div
                    className={`fixed bottom-4 left-4 right-4 z-[120] flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold shadow-2xl sm:bottom-auto sm:left-auto sm:right-6 sm:top-6 sm:w-[380px] ${
                        feedback.type === "success"
                            ? "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200"
                            : feedback.type === "info"
                            ? "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100"
                            : "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
                    }`}
                    role="status"
                >
                    <span className={`material-symbols-outlined text-lg ${feedback.type === "info" ? "animate-spin" : ""}`}>
                        {feedback.type === "success" ? "check_circle" : feedback.type === "info" ? "progress_activity" : "error"}
                    </span>
                    {feedback.message}
                </div>
            )}

            <CompactListFilters
                activeCount={Number(filter !== "ALL") + Number(dateFilter !== "ALL") + Number(workFilter !== "ALL")}
                summary={[filter !== "ALL" ? STATUS_CONFIG[filter]?.label : null, dateFilter !== "ALL" ? TRIAL_DATE_FILTERS.find(item => item.value === dateFilter)?.label : null, workFilter !== "ALL" ? TRIAL_WORK_FILTERS.find(item => item.value === workFilter)?.label : null].filter(Boolean).join(" · ") || `전체 조건 · 전환율 ${stats.conversionRate}%`}
                resultCount={`${filteredLeads.length}건`}
                onReset={() => { setFilter("ALL"); setDateFilter("ALL"); setWorkFilter("ALL"); }}
                search={<label className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3">
                    <span className="material-symbols-outlined text-lg text-[var(--color-academy-muted)]" aria-hidden="true">search</span>
                    <input type="search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="학생, 보호자, 전화번호, 학교, 메모로 검색" className="min-w-0 flex-1 bg-transparent py-2 text-[17px] text-[var(--color-academy-ink)] outline-none [&::-webkit-search-cancel-button]:appearance-none" />
                    {searchQuery && <button type="button" onClick={() => setSearchQuery("")} title="검색어 지우기" className="inline-flex min-h-11 w-11 shrink-0 items-center justify-center text-[var(--color-academy-muted)]"><span className="material-symbols-outlined text-lg" aria-hidden="true">close</span></button>}
                </label>}
                actions={<button type="button" onClick={() => setShowAddModal(true)} aria-label="체험 신청 등록" title="체험 신청 등록" className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-[var(--color-academy-primary)] px-2 text-sm font-bold text-[var(--color-academy-on-primary)] sm:px-3"><span className="material-symbols-outlined text-lg" aria-hidden="true">person_add</span><span className="hidden sm:inline">체험 신청 등록</span></button>}
            >
                <label className="min-w-0 space-y-1 text-xs font-bold text-[var(--color-academy-muted)]">신청 상태
                    <select aria-label="체험 신청 상태" value={filter} onChange={event => setFilter(event.target.value)} className="block min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-[17px] text-[var(--color-academy-ink)]">
                        <option value="ALL">전체 {stats.total}</option>
                        {STATUS_ORDER.map(status => <option key={status} value={status}>{STATUS_CONFIG[status].label} {stats[status]}</option>)}
                    </select>
                </label>
                <label className="min-w-0 space-y-1 text-xs font-bold text-[var(--color-academy-muted)]">체험일
                    <select aria-label="체험일 필터" value={dateFilter} onChange={event => setDateFilter(event.target.value as TrialDateFilter)} className="block min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-[17px] text-[var(--color-academy-ink)]">
                        {TRIAL_DATE_FILTERS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                </label>
                <label className="min-w-0 space-y-1 text-xs font-bold text-[var(--color-academy-muted)]">업무 조건
                    <select aria-label="체험 업무 조건" value={workFilter} onChange={event => setWorkFilter(event.target.value as TrialWorkFilter)} className="block min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-[17px] text-[var(--color-academy-ink)]">
                        {TRIAL_WORK_FILTERS.map(item => <option key={item.value} value={item.value}>{item.label} {workFilterCounts[item.value]}</option>)}
                    </select>
                </label>
            </CompactListFilters>

            {/* ── 리드 목록 ── */}
            {filteredLeads.length === 0 ? (
                <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                    <span className="material-symbols-outlined text-5xl text-gray-300">person_search</span>
                    <p className="text-gray-500 dark:text-gray-400 mt-3">
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
                            className="mt-4 rounded-lg border border-gray-200 px-4 py-2 text-sm font-bold text-gray-700 transition hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                        >
                            {loadingMore ? "불러오는 중..." : "다음 50건에서 더 찾아보기"}
                        </button>
                    )}
                </div>
            ) : (
                <div className="grid gap-4">
                    {renderTrialList()}
                    {hasMoreLeads && (<div className="flex flex-col gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 sm:flex-row sm:items-center sm:justify-between">
                        <span>
                            {filteredLeads.length}건 중 {visibleLeads.length}건 표시
                        </span>
                        {hasMoreLeads && (
                            <button
                                type="button"
                                onClick={handleShowMoreLeads}
                                disabled={loadingMore}
                                className="rounded-lg border border-gray-200 px-4 py-2 font-bold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
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
                    onResendAttendedSms={() => void handleResendAttendedSms(showDetailModal)}
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
                <div className="flex items-start gap-3">
                    <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-neon-lime text-brand-navy-900">
                        <span className="material-symbols-outlined">send</span>
                    </span>
                    <div>
                        <p className="text-xs font-black uppercase tracking-widest text-brand-orange-500 dark:text-brand-neon-lime">
                            수강신청 전환
                        </p>
                        <h2 id="trial-enroll-guide-confirm-title" className="mt-1 text-xl font-black text-gray-900 dark:text-white">
                            수강신청서를 전송하시겠습니까?
                        </h2>
                        <p className="mt-2 text-sm font-semibold leading-6 text-gray-600 dark:text-gray-300">
                            {lead.childName} 보호자에게 수강신청서 링크를 문자로 발송합니다.
                            같은 신청 건은 중복 발송되지 않습니다.
                        </p>
                    </div>
                </div>

                <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm dark:border-gray-700 dark:bg-gray-900">
                    <div className="flex items-center justify-between gap-3">
                        <span className="font-bold text-gray-500 dark:text-gray-400">수강생</span>
                        <span className="font-black text-gray-900 dark:text-white">{lead.childName}</span>
                    </div>
                    <div className="mt-2 flex items-center justify-between gap-3">
                        <span className="font-bold text-gray-500 dark:text-gray-400">처리</span>
                        <span className="font-black text-gray-900 dark:text-white">
                            {convertAfterConfirm ? "등록전환 + 문자 발송" : "문자 발송"}
                        </span>
                    </div>
                </div>

                <div className="mt-6 space-y-2">
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={busy}
                        className="min-h-11 w-full rounded-xl bg-brand-orange-500 px-4 text-sm font-black text-white transition hover:bg-brand-orange-600 disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-300"
                    >
                        {busy ? "처리 중..." : convertAfterConfirm ? "등록전환 + 문자 발송" : "문자 발송"}
                    </button>
                    {convertAfterConfirm && onConfirmNoSms && (
                        <button
                            type="button"
                            onClick={onConfirmNoSms}
                            disabled={busy}
                            className="min-h-11 w-full rounded-xl border border-brand-orange-300 px-4 text-sm font-black text-brand-orange-600 transition hover:bg-brand-orange-50 disabled:opacity-50 dark:border-brand-neon-lime/40 dark:text-brand-neon-lime dark:hover:bg-brand-neon-lime/10"
                        >
                            {busy ? "처리 중..." : "문자 없이 전환만"}
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onClose}
                        disabled={busy}
                        className="min-h-11 w-full rounded-xl border border-gray-200 px-4 text-sm font-black text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
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
    onResendAttendedSms,
    onConfirmTrialFee,
    busy,
    trialFeeBusy,
}: {
    lead: TrialLead;
    scheduleItems: Array<{ label: string; icon: string; value: string; className: string }>;
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
    onResendAttendedSms: () => void;
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
        <AdminModal onClose={onClose} titleId="trial-detail-modal-title" panelClassName="max-w-2xl">
            <div className="w-full p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-black ${cfg.color}`}>
                                <span className="material-symbols-outlined text-sm">{cfg.icon}</span>
                                {cfg.label}
                            </span>
                            <span className="text-xs font-bold text-gray-500 dark:text-gray-400">접수 {formatCompactDateTime(lead.createdAt)}</span>
                        </div>
                        <h2 id="trial-detail-modal-title" className="mt-2 text-xl font-black text-gray-900 dark:text-white">
                            {lead.childName} 체험 신청 상세
                        </h2>
                    </div>
                    <a
                        href={phoneHref(lead.parentPhone)}
                        className={DETAIL_ACTION_CLASS}
                    >
                        <span className="material-symbols-outlined text-base">call</span>
                        전화
                    </a>
                </div>

                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                    {scheduleItems.map((item) => (
                        <div key={`trial-detail-${item.label}`} className={`rounded-lg border px-3 py-2 ${item.className}`}>
                            <p className="flex items-center gap-1 text-[11px] font-black uppercase opacity-80">
                                <span className="material-symbols-outlined text-sm">{item.icon}</span>
                                {item.label}
                            </p>
                            <p className="mt-1 break-keep text-sm font-black">{item.value}</p>
                        </div>
                    ))}
                </div>

                <dl className="mt-5 grid gap-2 sm:grid-cols-2">
                    {details.map(([label, value]) => (
                        <div key={`trial-detail-row-${label}`} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 dark:border-gray-700 dark:bg-gray-900">
                            <dt className="text-[11px] font-black text-gray-500 dark:text-gray-400">{label}</dt>
                            <dd className="mt-0.5 break-keep text-sm font-bold text-gray-900 dark:text-white">{value || "미입력"}</dd>
                        </div>
                    ))}
                </dl>

                {(lead.hopeNote || lead.memo || lead.openFollowUpNote) && (
                    <div className="mt-5 space-y-2">
                        {lead.hopeNote && (
                            <p className="rounded-lg bg-lime-50 px-3 py-2 text-sm font-bold text-lime-800 dark:bg-lime-950/30 dark:text-lime-200">
                                희망 메모: {lead.hopeNote}
                            </p>
                        )}
                        {lead.memo && (
                            <p className="rounded-lg bg-gray-50 px-3 py-2 text-sm font-bold text-gray-700 dark:bg-gray-900 dark:text-gray-200">
                                관리 메모: {lead.memo}
                            </p>
                        )}
                        {lead.openFollowUpNote && (
                            <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm font-bold text-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
                                재연락 메모: {lead.openFollowUpNote}
                            </p>
                        )}
                    </div>
                )}

                <div className="mt-6 flex flex-wrap justify-end gap-2">
                    <button type="button" onClick={onClose} className="rounded-lg px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900">
                        닫기
                    </button>
                    <button type="button" onClick={onContact} className={DETAIL_ACTION_CLASS}>
                        <span className="material-symbols-outlined text-base">phone_callback</span>
                        연락 기록
                    </button>
                    <button type="button" onClick={onSendManualSms} disabled={busy} className={`${DETAIL_ACTION_CLASS} disabled:opacity-50`}>
                        <span className="material-symbols-outlined text-base">sms</span>
                        문자 보내기
                    </button>
                    {!lead.trialFeeConfirmed && (
                        <button type="button" onClick={onConfirmTrialFee} disabled={trialFeeBusy} aria-busy={trialFeeBusy} className={`${DETAIL_ACTION_CLASS} disabled:opacity-50`}>
                            <span className={`material-symbols-outlined text-base ${trialFeeBusy ? "animate-spin" : ""}`}>{trialFeeBusy ? "progress_activity" : "paid"}</span>
                            {trialFeeBusy ? "확인 중…" : "입금 확인"}
                        </button>
                    )}
                    {!lead.coachNoticeSentAt && (
                        <button type="button" onClick={onCoachNotice} className={DETAIL_ACTION_CLASS}>
                            <span className="material-symbols-outlined text-base">school</span>
                            쌤 알림
                        </button>
                    )}
                    {lead.smsDeliveryFailed > 0 && (
                        <button type="button" onClick={onResendSms} className={DETAIL_ACTION_CLASS}>
                            <span className="material-symbols-outlined text-base">sms_failed</span>
                            문자 재발송
                        </button>
                    )}
                    {lead.status === "ATTENDED" && (
                        <button type="button" onClick={onResendAttendedSms} disabled={busy} className={`${DETAIL_ACTION_CLASS} disabled:opacity-50`}>
                            <span className="material-symbols-outlined text-base">forward_to_inbox</span>
                            완료 문자 재시도
                        </button>
                    )}
                    {!isClosedTrialStatus(lead.status) && (lead.status === "NEW" || lead.status === "CONTACTED" || lead.status === "SCHEDULED") && (
                        <button type="button" onClick={onSchedule} className={DETAIL_ACTION_CLASS}>
                            <span className="material-symbols-outlined text-base">event_available</span>
                            {lead.status === "SCHEDULED" ? "일정 변경" : "일정 확정"}
                        </button>
                    )}
                    {lead.status === "SCHEDULED" && (
                        <button type="button" onClick={onMarkAttended} disabled={busy} className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-brand-orange-500 px-3 text-xs font-black text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900">
                            <span className="material-symbols-outlined text-base">check_circle</span>
                            체험 완료
                        </button>
                    )}
                    {lead.status === "ATTENDED" && !lead.enrollApplicationReceivedAt && (
                        <button type="button" onClick={onSendEnrollGuide} disabled={busy} className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-brand-orange-500 px-3 text-xs font-black text-white disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900">
                            <span className="material-symbols-outlined text-base">send</span>
                            {lead.enrollGuideSentAt ? "수강신청 안내 재발송" : "수강신청 안내"}
                        </button>
                    )}
                    <button type="button" onClick={onEdit} className="inline-flex min-h-8 items-center gap-1.5 rounded-md bg-brand-orange-500 px-3 text-xs font-black text-white transition hover:bg-brand-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-400">
                        <span className="material-symbols-outlined text-base">edit</span>
                        수정
                    </button>
                </div>
                {!isClosedTrialStatus(lead.status) && (
                    <div className="mt-5 flex flex-wrap justify-end gap-2 border-t border-gray-100 pt-4 dark:border-gray-800">
                        <span className="mr-auto text-xs font-bold text-gray-400">종료 작업</span>
                        <button type="button" onClick={onLost} className="rounded-md px-3 py-2 text-xs font-bold text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-900">이탈 처리</button>
                        <button type="button" onClick={onCancel} className="rounded-md px-3 py-2 text-xs font-bold text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30">신청 취소</button>
                    </div>
                )}
            </div>
        </AdminModal>
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
                <h2 id="trial-contact-modal-title" className="flex items-center gap-2 text-lg font-black text-gray-900 dark:text-white">
                    <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime">phone_callback</span>
                    후속 연락 기록
                </h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {lead.childName} · {lead.parentName} {lead.parentPhone}
                </p>

                <div className="mt-5 grid grid-cols-2 gap-2">
                    {(["CONTACTED", "NO_ANSWER", "FOLLOW_UP", "MEMO"] as ContactActionType[]).map((option) => (
                        <button
                            key={option}
                            type="button"
                            onClick={() => setAction(option)}
                            className={`rounded-xl border px-3 py-2 text-sm font-black transition ${
                                action === option
                                    ? "border-brand-orange-500 bg-brand-orange-50 text-brand-orange-700 dark:border-brand-neon-lime dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime"
                                    : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
                            }`}
                        >
                            {CONTACT_ACTION_LABELS[option]}
                        </button>
                    ))}
                </div>

                {action === "FOLLOW_UP" && (
                    <label className="mt-4 block text-sm font-bold text-gray-700 dark:text-gray-200">
                        다음 연락 예정
                        <input
                            type="datetime-local"
                            value={nextFollowUpAt}
                            onChange={(event) => setNextFollowUpAt(event.target.value)}
                            className="mt-1 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange-500 dark:border-gray-700 dark:bg-gray-900 dark:focus:border-brand-neon-lime"
                        />
                    </label>
                )}

                <label className="mt-4 block text-sm font-bold text-gray-700 dark:text-gray-200">
                    상담 메모
                    <textarea
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        rows={4}
                        className="mt-1 w-full resize-none rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-brand-orange-500 dark:border-gray-700 dark:bg-gray-900 dark:focus:border-brand-neon-lime"
                        placeholder="상담 내용이나 다음에 확인할 내용을 적어주세요"
                    />
                </label>

                {formError && (
                    <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-bold text-red-700 dark:bg-red-950/40 dark:text-red-200">
                        {formError}
                    </p>
                )}

                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="rounded-xl px-4 py-2 text-sm font-bold text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-900"
                    >
                        닫기
                    </button>
                    <button
                        type="submit"
                        disabled={busy}
                        className="rounded-xl bg-brand-orange-500 px-5 py-2 text-sm font-black text-white transition hover:bg-brand-orange-600 disabled:opacity-50 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:bg-lime-400"
                    >
                        {busy ? "저장 중..." : "저장"}
                    </button>
                </div>
            </form>
        </AdminModal>
    );
}
