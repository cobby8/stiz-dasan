"use client";
import { adminErrorText } from "@/components/admin/adminDisplayText";

import { formatClassLabel } from "@/lib/application-display-format";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getEnrollTrialLinkSuggestions, linkEnrollApplicationToTrialLead, recordApplicationContact, sendManualSms } from "@/app/actions/admin";
import type { TrialLinkSuggestion } from "@/lib/enrollment/trialLeadMatch";
import AdminModal from "@/components/admin/AdminModal";
import { statusToneClass } from "@/components/admin/StatusBadge";
import AdminQuickActionMenu, { type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";
import ManualSmsModal from "./ManualSmsModal";
import CompactListFilters from "@/components/academy/CompactListFilters";
import StatusCountChips from "@/components/admin/list/StatusCountChips";
import ListViewToggle, { useRememberedListView } from "@/components/admin/list/ListViewToggle";

const ApplyAdminModals = dynamic(() => import("./ApplyAdminModals"), {
    loading: () => null,
});

const TrialCrmClient = dynamic(() => import("../trial/TrialCrmClient"), {
    loading: () => <ApplyLoadingFallback />,
});

// 대기자는 신청의 뒷단이라 같은 화면에 둔다(별도 메뉴에서 이동).
// 다른 탭과 같이 지연 로딩해, 대기자 탭을 열기 전에는 내려받지 않는다.
const WaitlistClient = dynamic(() => import("@/app/admin/waitlist/WaitlistClient"), {
    loading: () => <ApplyLoadingFallback />,
});

const ApplySettingsTab = dynamic(() => import("./ApplySettingsTab"), {
    loading: () => (
        <div className="rounded-xl border border-gray-200 bg-white p-6 text-center text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
            신청 안내 설정을 불러오는 중...
        </div>
    ),
});

// ── 타입 정의 ──────────────────────────────────────────────────────────────────

interface EnrollApplication {
    id: string;
    trialLeadId: string | null;
    childName: string;
    childBirthDate: string;
    childGender: string | null;
    childGrade: string | null;
    childSchool: string | null;
    childPhone: string | null;
    parentName: string;
    parentPhone: string;
    parentRelation: string | null;
    address: string | null;
    enrollmentMonths: string | null;
    preferredSlotKeys: string | null;
    assignedClassId: string | null;
    basketballExp: string | null;
    uniformSize: string | null;
    shuttleNeeded: boolean;
    shuttlePickup: string | null;
    shuttleTime: string | null;
    shuttleDropoff: string | null;
    paymentMethod: string | null;
    referralSource: string | null;
    memo: string | null;
    applicationNoticeConfirmed: boolean;
    shuttleNoticeConfirmed: boolean;
    status: string;
    processedAt: string | null;
    processedNote: string | null;
    convertedStudentId: string | null;
    createdAt: string;
    updatedAt: string;
    latestContactAction: string | null;
    latestContactNote: string | null;
    latestContactAt: string | null;
    latestContactBy: string | null;
    openFollowUpAt: string | null;
    openFollowUpNote: string | null;
}

interface EnrollStats {
    PENDING: number;
    APPROVED: number;
    REJECTED: number;
    CANCELLED: number;
    total: number;
}

interface ClassInfo {
    id: string;
    name: string;
    dayOfWeek: string;
    startTime: string;
    endTime: string;
    capacity: number;
    slotKey: string | null;
    program: { id: string; name: string } | null;
}

interface TrialLead {
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
    childBirthDate: string | null;
    childGrade: string | null;
    childGender: string | null;
    childSchool: string | null;
    basketballExp: string | null;
    preferredSlotKey: string | null;
    preferredDay: string | null;
    preferredPeriod: string | null;
    trialDate: string | null;
    trialFeeConfirmed: boolean;
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

type ListPagination = {
    limit: number;
    offset: number;
    returned: number;
    total: number;
    hasMore: boolean;
    nextOffset: number | null;
    partial: boolean;
};

interface ApplyAdminClientProps {
    initialApplications?: EnrollApplication[];
    initialStats?: EnrollStats;
    initialClasses?: ClassInfo[];
    initialApplyPagination?: ListPagination;
    initialTrialLeads?: TrialLead[];
    initialTrialStats?: TrialStats;
    initialTrialClasses?: ClassInfo[];
    initialTrialPagination?: ListPagination;
}

type ApplyPayload = {
    applications: EnrollApplication[];
    stats: EnrollStats;
    classes: ClassInfo[];
    pagination?: ListPagination;
};

type SourceStatsRange = "ALL" | "30D" | "THIS_MONTH";

type SourceStatsRow = {
    source: string;
    total: number;
    trialTotal: number;
    trialScheduled: number;
    trialAttended: number;
    trialConverted: number;
    enrollTotal: number;
    enrollPending: number;
    enrollApproved: number;
    enrollClosed: number;
    conversionRate: number;
    trialAttendRate: number;
    enrollApproveRate: number;
    latestAt: string | null;
};

type SourceStatsPayload = {
    range: SourceStatsRange;
    generatedAt: string;
    rows: SourceStatsRow[];
    totals: {
        total: number;
        trialTotal: number;
        trialAttended: number;
        trialConverted: number;
        enrollTotal: number;
        enrollApproved: number;
        conversionRate: number;
        trialAttendRate: number;
        enrollApproveRate: number;
    };
};

type FeedbackState = { type: "success" | "error"; message: string } | null;
type ApplicationWorkFilter = "ALL" | "NEEDS_ACTION" | "CLASS_ASSIGNMENT" | "SHUTTLE" | "TRIAL_LINKED" | "TIME_CHECK";
type ContactActionType = "CONTACTED" | "NO_ANSWER" | "FOLLOW_UP" | "MEMO";
type ContactModalState = { app: EnrollApplication; defaultAction: ContactActionType } | null;
type ManualSmsModalState = { app: EnrollApplication } | null;
// ── 상태별 설정 ──────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
    // 색은 공용 상태 배지 색(학원 변수)으로 통일(게슈탈트 C-A3)
    PENDING: { label: "대기중", color: statusToneClass("warning"), icon: "hourglass_top" },
    APPROVED: { label: "승인완료", color: statusToneClass("success"), icon: "check_circle" },
    REJECTED: { label: "반려", color: statusToneClass("danger"), icon: "cancel" },
    CANCELLED: { label: "취소", color: statusToneClass("neutral"), icon: "block" },
};

// 유입경로 라벨 (9개 + 레거시 호환)
const SOURCE_LABELS: Record<string, string> = {
    REFERRAL: "지인소개",
    PASSBY: "지나가다 발견",
    NAVER_SEARCH: "네이버 키워드 검색",
    NAVER_BLOG: "네이버 블로그",
    PORTAL_OTHER: "기타 포털검색",
    INSTAGRAM: "인스타그램",
    SOOMGO: "숨고",
    EXISTING_STUDENT: "기존 수강생",
    OTHER: "기타",
    // 레거시 호환 (기존 데이터용)
    WEBSITE: "홈페이지",
    NAVER: "네이버",
    FLYER: "전단지",
    UNKNOWN: "미입력",
};

const STATUS_ORDER = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
const APPLICATION_PAGE_SIZE = 50;
// 목록 칸 수(상태별 묶음 머리줄이 표 전체 폭을 차지하도록 colSpan 에 쓴다)
const APPLICATION_LIST_COLUMN_COUNT = 11;
// STATUS_ORDER 에 없는 옛 상태값이 와도 행이 사라지지 않게 맨 끝 «기타» 묶음에 넣는다
const OTHER_STATUS_GROUP = "OTHER";
// 보기 방식(목록 | 상태별) 기억 키 — 원생 관리의 «목록 | 반별» 과 같은 방식
const APPLY_VIEW_STORAGE_KEY = "stiz-admin-apply-view";
const APPLY_VIEW_VALUES = ["list", "status"] as const;
const APPLY_VIEW_OPTIONS = [
    { value: "list", label: "목록", icon: "view_list" },
    { value: "status", label: "상태별", icon: "view_agenda" },
] as const;
const DAY_SHORT_LABELS: Record<string, string> = { Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일" };

const APPLICATION_WORK_FILTERS: Array<{ value: ApplicationWorkFilter; label: string; icon: string }> = [
    { value: "ALL", label: "운영 전체", icon: "view_list" },
    { value: "NEEDS_ACTION", label: "처리 필요", icon: "priority_high" },
    { value: "CLASS_ASSIGNMENT", label: "반 배정", icon: "edit_calendar" },
    { value: "SHUTTLE", label: "셔틀 확인", icon: "directions_bus" },
    { value: "TRIAL_LINKED", label: "체험 후 신청", icon: "link" },
    { value: "TIME_CHECK", label: "희망시간 확인", icon: "schedule" },
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

const EMPTY_STATS: EnrollStats = {
    PENDING: 0,
    APPROVED: 0,
    REJECTED: 0,
    CANCELLED: 0,
    total: 0,
};

const SOURCE_STATS_RANGES: Array<{ value: SourceStatsRange; label: string }> = [
    { value: "30D", label: "최근 30일" },
    { value: "THIS_MONTH", label: "이번 달" },
    { value: "ALL", label: "전체" },
];

function formatPreferredSlots(slotKeys: string | null, classesBySlotKey: Map<string, ClassInfo>) {
    if (!slotKeys) return null;
    const keys = slotKeys.split(",").map((key) => key.trim()).filter(Boolean);
    if (keys.length === 0) return null;

    const labels: string[] = [];
    let unknownCount = 0;

    keys.forEach((key) => {
        const classInfo = classesBySlotKey.get(key);
        if (classInfo) {
            labels.push(formatClassLabel(classInfo));
        } else {
            unknownCount += 1;
        }
    });

    if (labels.length === 0) return "희망 시간 확인 필요";
    if (unknownCount > 0) return `${labels.join(" / ")} 외 ${unknownCount}개 시간 확인 필요`;
    return labels.join(" / ");
}

// 목록 칸용 짧은 희망 수업 표기(예: «화4 목4»). 긴 반 이름·시간은 상세 패널에서 본다.
// slotKey 는 «요일코드-교시»(예: Tue-4) 형식이라, 반을 못 찾아도 키에서 요일·교시를 읽는다.
function formatPreferredSlotsShort(slotKeys: string | null, classesBySlotKey: Map<string, ClassInfo>) {
    if (!slotKeys) return null;
    const labels = slotKeys
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
        .map((key) => {
            const classInfo = classesBySlotKey.get(key);
            const [dayPart, periodPart] = key.split("-");
            const day = DAY_SHORT_LABELS[classInfo?.dayOfWeek ?? dayPart] ?? null;
            const period = (periodPart ?? "").match(/\d+/)?.[0] ?? classInfo?.name.match(/\d+/)?.[0] ?? "";
            return day ? `${day}${period}` : null;
        })
        .filter((label): label is string => Boolean(label));
    return labels.length > 0 ? labels.join(" ") : null;
}

// 목록 칸용 짧은 수강 시작월(예: «2026년 11월,2026년 12월» → «11월 외 1»). 전체는 상세 패널에서.
function formatEnrollmentMonthsShort(value: string | null) {
    const months = (value ?? "").split(",").map((month) => month.trim()).filter(Boolean);
    if (months.length === 0) return "-";
    const first = months[0].replace(/^\d{4}년\s*/, "");
    return months.length > 1 ? `${first} 외 ${months.length - 1}` : first;
}

function phoneHref(phone: string) {
    const digits = phone.replace(/\D/g, "");
    return digits ? `tel:${digits}` : undefined;
}

function getErrorMessage(error: unknown, fallback: string) {
    return adminErrorText(error, fallback);
}

function buildEnrollManualSmsMessage(app: EnrollApplication) {
    const parentName = app.parentName || "보호자";
    return `${parentName}님, STIZ 농구교실입니다. ${app.childName} 학생 수강신청 관련해서 안내드립니다.`;
}

function normalizeSearchValue(value: string | null | undefined) {
    return (value ?? "").replace(/\s+/g, "").replace(/-/g, "").toLowerCase();
}

function matchesApplicationWorkFilter(
    app: EnrollApplication,
    preferredSlotLabel: string | null,
    workFilter: ApplicationWorkFilter,
) {
    if (workFilter === "ALL") return true;
    if (workFilter === "NEEDS_ACTION") return app.status === "PENDING";
    if (workFilter === "CLASS_ASSIGNMENT") return app.status === "PENDING" && !app.assignedClassId;
    if (workFilter === "SHUTTLE") return app.shuttleNeeded;
    if (workFilter === "TRIAL_LINKED") return Boolean(app.trialLeadId);
    if (workFilter === "TIME_CHECK") return !preferredSlotLabel;
    return true;
}

function applicationMatchesSearch(app: EnrollApplication, preferredSlotLabel: string | null, query: string) {
    const normalizedQuery = normalizeSearchValue(query);
    if (!normalizedQuery) return true;

    const searchable = [
        app.childName,
        app.parentName,
        app.parentPhone,
        app.childPhone,
        app.childSchool,
        app.childGrade,
        app.parentRelation,
        app.memo,
        app.basketballExp,
        app.shuttlePickup,
        app.shuttleDropoff,
        app.referralSource ? SOURCE_LABELS[app.referralSource] || app.referralSource : null,
        preferredSlotLabel,
    ].map(normalizeSearchValue).join(" ");

    return searchable.includes(normalizedQuery);
}

function ApplyLoadingFallback() {
    return (
        <div role="status" aria-live="polite" className="min-w-0 space-y-3">
            <p className="text-sm text-[var(--color-academy-muted)]">신청 목록을 불러오는 중…</p>
            <div aria-hidden="true" className="h-11 animate-pulse rounded-xl bg-[var(--color-academy-soft)]" />
            <div aria-hidden="true" className="space-y-2">
                {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-12 animate-pulse rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]" />)}
            </div>
        </div>
    );
}

function ApplyErrorState({ onRetry }: { onRetry: () => void }) {
    return (
        <div className="rounded-2xl border border-red-100 bg-white p-8 text-center shadow-sm dark:border-red-900/40 dark:bg-gray-800">
            <span className="material-symbols-outlined mb-3 text-4xl text-red-500">error</span>
            <p className="font-bold text-gray-900 dark:text-white">수강 신청 정보를 불러오지 못했습니다.</p>
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

// ── 탭 상수 ──────────────────────────────────────────────────────────────────────

type TabType = "trial" | "applications" | "waitlist" | "sources" | "settings";

// ── 메인 컴포넌트 ──────────────────────────────────────────────────────────────

export default function ApplyAdminClient({
    initialApplications,
    initialStats,
    initialClasses,
    initialApplyPagination,
    initialTrialLeads,
    initialTrialStats,
    initialTrialClasses,
    initialTrialPagination,
}: ApplyAdminClientProps) {
    const hasInitialApplyData = Boolean(initialApplications && initialClasses);
    const [applications, setApplications] = useState<EnrollApplication[]>(initialApplications ?? []);
    const [stats, setStats] = useState<EnrollStats>(initialStats ?? EMPTY_STATS);
    const [classes, setClasses] = useState<ClassInfo[]>(initialClasses ?? []);
    const [applyLoaded, setApplyLoaded] = useState(hasInitialApplyData);
    const [loading, setLoading] = useState(false);
    const [loadingMore, setLoadingMore] = useState(false);
    const [applyPagination, setApplyPagination] = useState<ListPagination | null>(initialApplyPagination ?? null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [filter, setFilter] = useState<string>("ALL");
    // 목록 보기 방식: "list"(한 줄 목록) / "status"(상태별 묶음). 마지막 선택을 브라우저에 기억한다.
    const [applyView, setApplyView] = useRememberedListView(APPLY_VIEW_STORAGE_KEY, APPLY_VIEW_VALUES, "list");
    const [workFilter, setWorkFilter] = useState<ApplicationWorkFilter>("ALL");
    const [searchQuery, setSearchQuery] = useState("");
    const [visibleLimit, setVisibleLimit] = useState(APPLICATION_PAGE_SIZE);
    const [activeTab, setActiveTab] = useState<TabType>("trial");
    const [feedback, setFeedback] = useState<FeedbackState>(null);
    const [sourceStatsRange, setSourceStatsRange] = useState<SourceStatsRange>("30D");
    const [sourceStatsData, setSourceStatsData] = useState<SourceStatsPayload | null>(null);
    const [sourceStatsLoading, setSourceStatsLoading] = useState(false);
    const [sourceStatsError, setSourceStatsError] = useState<string | null>(null);

    // 모달 상태
    const [showApproveModal, setShowApproveModal] = useState<EnrollApplication | null>(null);
    const [showRejectModal, setShowRejectModal] = useState<EnrollApplication | null>(null);
    const [showDetailModal, setShowDetailModal] = useState<EnrollApplication | null>(null);
    const [showEditModal, setShowEditModal] = useState<EnrollApplication | null>(null);
    const [showCancelModal, setShowCancelModal] = useState<EnrollApplication | null>(null);
    const [showReopenModal, setShowReopenModal] = useState<EnrollApplication | null>(null);
    const [contactModal, setContactModal] = useState<ContactModalState>(null);
    const [manualSmsModal, setManualSmsModal] = useState<ManualSmsModalState>(null);
    const [contactBusyId, setContactBusyId] = useState<string | null>(null);
    const [manualSmsBusy, setManualSmsBusy] = useState(false);
    // 체험과 연결되지 않은 신청서별 "체험 기록 후보"(신청서 id → 후보). 수강신청 탭을 열 때 한 번 읽는다.
    const [trialSuggestions, setTrialSuggestions] = useState<Record<string, TrialLinkSuggestion[]> | null>(null);
    const [trialLinkBusyId, setTrialLinkBusyId] = useState<string | null>(null);

    const hasAnyData = applications.length > 0 || classes.length > 0 || stats.total > 0;

    const loadApplyData = useCallback(async (options?: { append?: boolean; offset?: number }) => {
        const append = Boolean(options?.append);
        const offset = options?.offset ?? 0;

        if (append) setLoadingMore(true);
        else setLoading(true);
        setLoadError(null);

        try {
            const params = new URLSearchParams({
                limit: String(APPLICATION_PAGE_SIZE),
                offset: String(offset),
            });
            const response = await fetch(`/api/admin/apply?${params.toString()}`, { cache: "no-store" });
            if (!response.ok) {
                throw new Error("request failed");
            }
            const data = (await response.json()) as ApplyPayload;
            setApplications((current) => (append ? [...current, ...data.applications] : data.applications));
            setStats(data.stats);
            setClasses(data.classes);
            setApplyPagination(data.pagination ?? null);
            setApplyLoaded(true);
        } catch {
            setLoadError("failed");
        } finally {
            if (append) setLoadingMore(false);
            else setLoading(false);
        }
    }, []);

    const loadSourceStats = useCallback(async (range: SourceStatsRange) => {
        setSourceStatsLoading(true);
        setSourceStatsError(null);

        try {
            const response = await fetch(`/api/admin/apply/source-stats?range=${range}`, { cache: "no-store" });
            if (!response.ok) throw new Error("request failed");
            const data = (await response.json()) as SourceStatsPayload;
            setSourceStatsData(data);
        } catch {
            setSourceStatsError("failed");
        } finally {
            setSourceStatsLoading(false);
        }
    }, []);

    useEffect(() => {
        if (activeTab !== "applications" || applyLoaded || loading) return;
        void loadApplyData();
    }, [activeTab, applyLoaded, loading, loadApplyData]);

    // 체험 기록 후보는 목록 표시를 막지 않도록 신청 목록을 받은 뒤 따로 읽는다(실패하면 후보만 안 보인다).
    const loadTrialSuggestions = useCallback(async () => {
        try {
            setTrialSuggestions(await getEnrollTrialLinkSuggestions());
        } catch {
            setTrialSuggestions({});
        }
    }, []);

    useEffect(() => {
        if (activeTab !== "applications" || !applyLoaded || trialSuggestions !== null) return;
        void loadTrialSuggestions();
    }, [activeTab, applyLoaded, trialSuggestions, loadTrialSuggestions]);

    useEffect(() => {
        if (activeTab !== "sources") return;
        if (sourceStatsData?.range === sourceStatsRange) return;
        if (sourceStatsLoading) return;
        void loadSourceStats(sourceStatsRange);
    }, [activeTab, loadSourceStats, sourceStatsData?.range, sourceStatsLoading, sourceStatsRange]);

    const classesBySlotKey = useMemo(() => {
        const map = new Map<string, ClassInfo>();
        classes.forEach((classInfo) => {
            if (classInfo.slotKey) map.set(classInfo.slotKey, classInfo);
        });
        return map;
    }, [classes]);
    const showFeedback = useCallback((type: "success" | "error", message: string) => {
        setFeedback({ type, message });
        window.setTimeout(() => setFeedback(null), 3500);
    }, []);
    const handleRecordContact = useCallback(async (
        app: EnrollApplication,
        action: ContactActionType,
        note?: string | null,
        nextFollowUpAt?: string | null,
    ) => {
        setContactBusyId(app.id);
        try {
            await recordApplicationContact({
                targetType: "ENROLL",
                targetId: app.id,
                action,
                note,
                nextFollowUpAt,
            });
            await loadApplyData();
            showFeedback("success", `${app.childName} ${CONTACT_ACTION_LABELS[action]} 기록을 저장했습니다.`);
        } catch {
            showFeedback("error", "연락 기록 저장 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setContactBusyId(null);
        }
    }, [loadApplyData, showFeedback]);

    // [연결] — 관리자가 확인한 체험 기록을 신청서에 붙인다(문자 발송 없음).
    async function handleLinkTrial(app: EnrollApplication, suggestion: TrialLinkSuggestion) {
        if (trialLinkBusyId) return;
        const ok = window.confirm(`${app.childName} 신청서를 체험 기록 「${suggestion.childName}」과 연결할까요?
(${suggestion.reason})
문자는 발송되지 않습니다.`);
        if (!ok) return;
        setTrialLinkBusyId(app.id);
        try {
            const result = await linkEnrollApplicationToTrialLead(app.id, suggestion.trialLeadId);
            if (!result.linked) {
                showFeedback("error", result.reason);
                await loadTrialSuggestions();
                return;
            }
            await loadApplyData();
            await loadTrialSuggestions();
            showFeedback("success", `${app.childName} 신청서를 체험 기록과 연결했습니다.`);
        } catch (error) {
            showFeedback("error", getErrorMessage(error, "체험 기록 연결에 실패했습니다. 새로고침 후 다시 시도해주세요."));
        } finally {
            setTrialLinkBusyId(null);
        }
    }

    async function handleSendManualSms(app: EnrollApplication, message: string) {
        if (manualSmsBusy) return;
        setManualSmsBusy(true);
        try {
            const result = await sendManualSms([app.parentPhone], message, {
                requestId: `enroll-manual-${app.id}-${Date.now()}`,
                purpose: "수강신청 학부모 문자",
                reason: "수강신청 관리 화면에서 직접 발송",
                audienceScope: "EXTERNAL",
            });
            setManualSmsModal(null);
            if (result.success > 0 && result.failed === 0 && result.uncertain === 0) {
                showFeedback("success", `${app.childName} 보호자에게 문자를 발송했습니다.`);
            } else if (result.success > 0) {
                showFeedback("error", `${app.childName} 문자 일부만 발송됐습니다. 문자 발송 장부를 확인해 주세요.`);
            } else {
                showFeedback("error", result.results[0]?.reason || "문자 발송에 실패했습니다. 연락처와 문자 설정을 확인해 주세요.");
            }
        } catch (error) {
            showFeedback("error", getErrorMessage(error, "문자 발송 중 문제가 생겼습니다. 잠시 후 다시 시도해주세요."));
        } finally {
            setManualSmsBusy(false);
        }
    }

    // 필터링된 신청서 목록
    const filteredApps = useMemo(() => {
        return applications
            .filter((app) => {
                const preferredSlotLabel = formatPreferredSlots(app.preferredSlotKeys, classesBySlotKey);
                if (filter !== "ALL" && app.status !== filter) return false;
                if (!matchesApplicationWorkFilter(app, preferredSlotLabel, workFilter)) return false;
                return applicationMatchesSearch(app, preferredSlotLabel, searchQuery);
            })
            .sort((a, b) => {
                const createdAtCompare = (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0);
                return createdAtCompare || b.id.localeCompare(a.id);
            });
    }, [applications, classesBySlotKey, filter, searchQuery, workFilter]);
    const visibleApps = useMemo(
        () => filteredApps.slice(0, visibleLimit),
        [filteredApps, visibleLimit],
    );
    const hasMoreLoadedApps = visibleApps.length < filteredApps.length;
    const hasMoreServerApps = Boolean(applyPagination?.hasMore);
    const hasMoreApps = hasMoreLoadedApps || hasMoreServerApps;
    const handleShowMoreApps = useCallback(() => {
        if (hasMoreLoadedApps) {
            setVisibleLimit((current) => current + APPLICATION_PAGE_SIZE);
            return;
        }

        if (!hasMoreServerApps || loadingMore) return;

        setVisibleLimit((current) => current + APPLICATION_PAGE_SIZE);
        void loadApplyData({
            append: true,
            offset: applyPagination?.nextOffset ?? applications.length,
        });
    }, [applications.length, applyPagination?.nextOffset, hasMoreLoadedApps, hasMoreServerApps, loadApplyData, loadingMore]);
    const workFilterCounts = useMemo(() => {
        const counts: Record<ApplicationWorkFilter, number> = {
            ALL: applications.length,
            NEEDS_ACTION: 0,
            CLASS_ASSIGNMENT: 0,
            SHUTTLE: 0,
            TRIAL_LINKED: 0,
            TIME_CHECK: 0,
        };

        applications.forEach((app) => {
            const preferredSlotLabel = formatPreferredSlots(app.preferredSlotKeys, classesBySlotKey);
            APPLICATION_WORK_FILTERS.forEach((item) => {
                if (item.value !== "ALL" && matchesApplicationWorkFilter(app, preferredSlotLabel, item.value)) {
                    counts[item.value] += 1;
                }
            });
        });

        return counts;
    }, [applications, classesBySlotKey]);

    useEffect(() => {
        setVisibleLimit(APPLICATION_PAGE_SIZE);
    }, [filter, searchQuery, workFilter]);
    const hasApplyModal = Boolean(showApproveModal || showRejectModal || showDetailModal || showEditModal || showCancelModal || showReopenModal);

    // 날짜 포맷
    function formatDate(dateStr: string | null) {
        if (!dateStr) return "-";
        const d = new Date(dateStr);
        return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
    }

    // 생년월일에서 나이 계산
    function calcAge(birthDateStr: string | null) {
        if (!birthDateStr) return null;
        const birth = new Date(birthDateStr);
        const today = new Date();
        let age = today.getFullYear() - birth.getFullYear();
        const m = today.getMonth() - birth.getMonth();
        if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
        return age;
    }

    function sourceLabel(source: string) {
        return SOURCE_LABELS[source] || source || "미입력";
    }

    function renderSourceStats() {
        const payload = sourceStatsData?.range === sourceStatsRange ? sourceStatsData : null;
        const rows = payload?.rows ?? [];
        const totals = payload?.totals;
        const maxTotal = rows.reduce((max, row) => Math.max(max, row.total), 0);

        return (
            <div className="space-y-4">
                <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <h2 className="text-lg font-black text-gray-900 dark:text-white">유입경로 통계</h2>
                        </div>
                        <div className="flex items-center gap-2">
                            <select
                                value={sourceStatsRange}
                                onChange={(event) => setSourceStatsRange(event.target.value as SourceStatsRange)}
                                className="min-h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm font-bold text-gray-900 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
                            >
                                {SOURCE_STATS_RANGES.map((range) => (
                                    <option key={range.value} value={range.value}>
                                        {range.label}
                                    </option>
                                ))}
                            </select>
                            <button
                                type="button"
                                onClick={() => void loadSourceStats(sourceStatsRange)}
                                disabled={sourceStatsLoading}
                                className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-gray-200 px-3 text-sm font-bold text-gray-700 transition hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                            >
                                <span className="material-symbols-outlined text-base">refresh</span>
                                새로고침
                            </button>
                        </div>
                    </div>
                </div>

                {sourceStatsLoading && !payload ? (
                    <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-sm font-bold text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400">
                        유입경로 통계를 불러오는 중입니다.
                    </div>
                ) : sourceStatsError && !payload ? (
                    <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm font-bold text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
                        통계를 불러오지 못했습니다.
                        <button
                            type="button"
                            onClick={() => void loadSourceStats(sourceStatsRange)}
                            className="ml-3 rounded-lg bg-red-600 px-3 py-1.5 text-white"
                        >
                            다시 시도
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                            <SourceMetricCard label="전체 접수" value={`${totals?.total ?? 0}건`} icon="inbox" />
                            <SourceMetricCard label="체험 문의" value={`${totals?.trialTotal ?? 0}건`} icon="diversity_3" />
                            <SourceMetricCard label="수강신청" value={`${totals?.enrollTotal ?? 0}건`} icon="assignment" />
                            <SourceMetricCard label="등록 전환" value={`${totals?.conversionRate ?? 0}%`} icon="trending_up" />
                        </div>

                        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                            <table className="w-full min-w-[860px] table-fixed border-collapse text-left text-sm">
                                <colgroup>
                                    <col className="w-[24%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[16%]" />
                                </colgroup>
                                <thead className="bg-gray-50 text-xs font-black uppercase text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                                    <tr className="divide-x divide-gray-200 dark:divide-gray-700">
                                        <th className="px-3 py-2">유입경로</th>
                                        <th className="px-3 py-2">전체</th>
                                        <th className="px-3 py-2">체험</th>
                                        <th className="px-3 py-2">수강신청</th>
                                        <th className="px-3 py-2">등록</th>
                                        <th className="px-3 py-2">전환율</th>
                                        <th className="px-3 py-2">최근 접수</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                                    {rows.length === 0 ? (
                                        <tr>
                                            <td colSpan={7} className="px-3 py-8 text-center text-sm font-bold text-gray-500 dark:text-gray-400">
                                                선택한 기간에 접수된 신청이 없습니다.
                                            </td>
                                        </tr>
                                    ) : (
                                        rows.map((row) => {
                                            const width = maxTotal > 0 ? Math.max(8, Math.round((row.total / maxTotal) * 100)) : 0;
                                            return (
                                                <tr key={row.source} className="divide-x divide-gray-100 dark:divide-gray-700">
                                                    <td className="px-3 py-2 align-middle">
                                                        <div className="min-w-0">
                                                            <div className="flex items-center justify-between gap-3">
                                                                <span className="truncate font-black text-gray-900 dark:text-white">{sourceLabel(row.source)}</span>
                                                                <span className="shrink-0 text-xs font-bold text-gray-400">{row.source}</span>
                                                            </div>
                                                            <div className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-900">
                                                                <div className="h-full rounded-full bg-brand-orange-500 dark:bg-brand-neon-lime" style={{ width: `${width}%` }} />
                                                            </div>
                                                        </div>
                                                    </td>
                                                    <td className="px-3 py-2 font-black text-gray-900 dark:text-white">{row.total}</td>
                                                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
                                                        <span className="font-black">{row.trialTotal}</span>
                                                        <span className="ml-1 text-xs text-gray-400">완료 {row.trialAttended}</span>
                                                    </td>
                                                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">
                                                        <span className="font-black">{row.enrollTotal}</span>
                                                        <span className="ml-1 text-xs text-gray-400">대기 {row.enrollPending}</span>
                                                    </td>
                                                    <td className="px-3 py-2 text-gray-700 dark:text-gray-200">{row.trialConverted + row.enrollApproved}</td>
                                                    <td className="px-3 py-2 font-black text-gray-900 dark:text-white">{row.conversionRate}%</td>
                                                    <td className="px-3 py-2 text-xs font-bold text-gray-500 dark:text-gray-400">{formatDate(row.latestAt)}</td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>
        );
    }

    // ⚡ 작업 목록 — 예전 «⋯» 메뉴와 같은 조건·같은 함수·같은 인자(보이는 모양만 공용 메뉴로)
    function buildApplicationQuickActions(app: EnrollApplication, parentPhoneHref: string | undefined): AdminQuickAction[] {
        const actions: AdminQuickAction[] = [
            { key: "call", label: "전화", icon: "call", disabled: !parentPhoneHref, onSelect: () => { if (parentPhoneHref) window.location.href = parentPhoneHref; } },
            { key: "sms", label: "문자 보내기", icon: "sms", disabled: manualSmsBusy, onSelect: () => setManualSmsModal({ app }) },
            { key: "contacted", label: "연락 완료", icon: "done_all", disabled: contactBusyId === app.id, onSelect: () => handleRecordContact(app, "CONTACTED") },
            { key: "memo", label: "메모", icon: "edit_note", onSelect: () => setContactModal({ app, defaultAction: "MEMO" }) },
        ];
        if (app.status === "REJECTED" && !app.convertedStudentId) {
            actions.push({ key: "reopen", label: "재검토로 되돌리기", icon: "restart_alt", onSelect: () => setShowReopenModal(app) });
        }
        if (app.status === "PENDING") {
            // 승인 전에 상담 결과를 반영해 신청 내용을 고칠 수 있다(승인 후에는 원생/수강 등록 메뉴에서).
            actions.push(
                { key: "edit", label: "수정", icon: "edit", onSelect: () => setShowEditModal(app) },
                { key: "approve", label: "승인", icon: "check_circle", tone: "primary", onSelect: () => setShowApproveModal(app) },
                { key: "reject", label: "반려", icon: "cancel", tone: "danger", onSelect: () => setShowRejectModal(app) },
                { key: "cancel", label: "취소", icon: "block", tone: "danger", onSelect: () => setShowCancelModal(app) },
            );
        }
        return actions;
    }

    // 목록 한 줄(행). 목록 보기와 상태별 보기가 같은 행을 쓴다.
    // 긴 값(셔틀 주소·긴 반 이름)은 짧게 보여주고 전체 내용은 행을 눌러 여는 상세 패널에서 본다(말줄임 금지).
    function renderApplicationRow(app: EnrollApplication) {
        const cfg = STATUS_CONFIG[app.status] || STATUS_CONFIG.PENDING;
        const age = calcAge(app.childBirthDate);
        const preferredSlotShort = formatPreferredSlotsShort(app.preferredSlotKeys, classesBySlotKey);
        const parentPhoneHref = phoneHref(app.parentPhone);
        // 체험과 아직 연결 안 된 신청서에만 후보 1건(가장 유력한 것)을 같은 줄의 작은 버튼으로 보여준다.
        const trialSuggestion = !app.trialLeadId ? trialSuggestions?.[app.id]?.[0] ?? null : null;
        const trialSuggestionLabel = trialSuggestion
            ? `체험 기록 후보: ${trialSuggestion.childName}(${[trialSuggestion.trialYmd, trialSuggestion.classLabel].filter(Boolean).join("·") || "일정 미정"})`
            : "";
        return (
            <tr
                key={`${app.id}-list`}
                tabIndex={0}
                onClick={() => {
                    setShowDetailModal(app);
                }}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return; // 행 안 버튼(⚡·체험 연결)의 Enter/Space 는 버튼이 처리
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setShowDetailModal(app);
                    }
                }}
                className="cursor-pointer transition focus:bg-brand-orange-50 focus:outline-none dark:focus:bg-brand-neon-lime/10"
            >
                {/* 상태 — 휴대폰에선 아이콘만, sm 이상에서 글자까지 */}
                <td className="px-2 py-1.5">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${cfg.color}`} title={cfg.label}>
                        <span className="material-symbols-outlined text-sm" aria-hidden="true">{cfg.icon}</span>
                        <span className="sr-only sm:not-sr-only">{cfg.label}</span>
                    </span>
                    {app.trialLeadId && <span className="ml-1 text-xs font-bold text-[var(--color-academy-muted)]">체험후</span>}
                    {app.assignedClassId && <span className="ml-1 text-xs font-bold text-[var(--color-academy-muted)]">배정</span>}
                </td>
                <td className="px-2 py-1.5">
                    <span className="font-black text-gray-900 dark:text-white">{app.childName}</span>
                    {trialSuggestion && (
                        <button
                            type="button"
                            onClick={(event) => {
                                event.stopPropagation();
                                void handleLinkTrial(app, trialSuggestion);
                            }}
                            disabled={trialLinkBusyId !== null}
                            title={`${trialSuggestionLabel} · ${trialSuggestion.reason}`}
                            className="ml-1.5 inline-flex min-h-11 min-w-11 justify-center items-center gap-0.5 rounded-md sm:min-h-8 sm:min-w-0 border border-[var(--color-academy-line)] px-2 text-xs font-black text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-surface)] disabled:opacity-50"
                            aria-label={`${app.childName} 신청서를 체험 기록 ${trialSuggestion.childName}과 연결 (${trialSuggestionLabel})`}
                        >
                            <span className="material-symbols-outlined text-sm" aria-hidden="true">link</span>
                            {/* 휴대폰 폭(sm 미만)에선 아이콘만 보여 행이 두 줄로 밀리지 않게 한다(뜻은 aria-label 이 읽어 준다) */}
                            <span className="sr-only sm:not-sr-only">{trialLinkBusyId === app.id ? "연결 중" : "체험 연결"}</span>
                        </button>
                    )}
                </td>
                <td className="px-2 py-1.5 text-gray-800 dark:text-gray-100">
                    {app.childGrade || "-"}
                    {age !== null && <span className="ml-1 text-xs tabular-nums text-[var(--color-academy-muted)]">만 {age}세</span>}
                </td>
                <td className="hidden px-2 py-1.5 text-gray-700 dark:text-gray-200 md:table-cell">{app.childSchool || "-"}</td>
                <td className="hidden px-2 py-1.5 text-gray-700 dark:text-gray-200 lg:table-cell">{app.parentName || "-"}</td>
                <td className="hidden px-2 py-1.5 tabular-nums text-gray-700 dark:text-gray-200 md:table-cell">{app.parentPhone || "-"}</td>
                <td className="admin-cell-num px-2 py-1.5 text-gray-700 dark:text-gray-200">{formatDate(app.createdAt)}</td>
                <td className="px-2 py-1.5 font-bold text-gray-800 dark:text-gray-100">
                    {preferredSlotShort ?? <span className="text-xs font-bold text-amber-700 dark:text-amber-300">확인 필요</span>}
                </td>
                <td className="hidden px-2 py-1.5 text-gray-700 dark:text-gray-200 lg:table-cell">{formatEnrollmentMonthsShort(app.enrollmentMonths)}</td>
                <td className="hidden px-2 py-1.5 text-gray-700 dark:text-gray-200 md:table-cell">{app.shuttleNeeded ? "이용" : "미이용"}</td>
                <td className="admin-cell-center px-2 py-1.5" onClick={(event) => event.stopPropagation()}>
                    {/* 공용 ⚡ 메뉴(게슈탈트 A-06) — 따로 만든 «⋯» 복사본 대신. 승인=주인공, 반려·취소=위험(구분선 아래) */}
                    <AdminQuickActionMenu label={`${app.childName} 빠른 처리`} actions={buildApplicationQuickActions(app, parentPhoneHref)} />
                </td>
            </tr>
        );
    }

    function renderApplicationList() {
        // 상태별 보기: 상태 순서대로 묶음 머리줄(«대기중 · 2건») 아래 같은 한 줄 행을 둔다.
        // 머리줄 건수는 «조건에 맞는 전체» 기준, 행은 지금 펼쳐 둔(더 보기) 만큼만.
        const statusGroups = applyView === "status"
            ? [...STATUS_ORDER, OTHER_STATUS_GROUP].map((status) => {
                const inGroup = (app: EnrollApplication) =>
                    status === OTHER_STATUS_GROUP ? !(STATUS_ORDER as readonly string[]).includes(app.status) : app.status === status;
                return {
                    status,
                    label: status === OTHER_STATUS_GROUP ? "기타" : STATUS_CONFIG[status].label,
                    total: filteredApps.filter(inGroup).length,
                    apps: visibleApps.filter(inGroup),
                };
            }).filter((group) => group.apps.length > 0)
            : [];

        return (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <table className="admin-list-table w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 bg-gray-50 text-xs font-black uppercase text-gray-500 dark:bg-gray-900 dark:text-gray-400">
                        <tr>
                            <th className="px-2 py-2">상태</th>
                            <th className="px-2 py-2">학생</th>
                            <th className="px-2 py-2">학년</th>
                            <th className="hidden px-2 py-2 md:table-cell">학교</th>
                            <th className="hidden px-2 py-2 lg:table-cell">보호자</th>
                            <th className="hidden px-2 py-2 md:table-cell">연락처</th>
                            <th className="admin-cell-num px-2 py-2">접수일</th>
                            <th className="px-2 py-2">희망 수업</th>
                            <th className="hidden px-2 py-2 lg:table-cell">수강 시작월</th>
                            <th className="hidden px-2 py-2 md:table-cell">셔틀</th>
                            <th className="admin-cell-center px-2 py-2"><span className="sr-only">빠른 처리</span></th>
                        </tr>
                    </thead>
                    {applyView === "status" ? (
                        statusGroups.map((group) => (
                            <tbody key={group.status}>
                                <tr>
                                    <th colSpan={APPLICATION_LIST_COLUMN_COUNT} scope="rowgroup" className="bg-[var(--color-academy-soft)] px-2 py-1.5 text-xs font-black text-[var(--color-academy-ink)]">
                                        {group.label} · <span className="tabular-nums">{group.total}</span>건
                                    </th>
                                </tr>
                                {group.apps.map(renderApplicationRow)}
                            </tbody>
                        ))
                    ) : (
                        <tbody>{visibleApps.map(renderApplicationRow)}</tbody>
                    )}
                </table>
            </div>
        );
    }

    if (loading && !hasAnyData) {
        return <ApplyLoadingFallback />;
    }

    if (loadError && !hasAnyData) {
        return <ApplyErrorState onRetry={loadApplyData} />;
    }

    return (
        <div className="min-w-0 space-y-4">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h1 className="flex min-w-0 items-center gap-2 text-2xl font-bold text-[var(--color-academy-ink)]">
                    <span className="material-symbols-outlined text-2xl text-[var(--color-academy-primary)]" aria-hidden="true">how_to_reg</span>
                    체험/수강신청 관리
                </h1>
                <div className="flex max-w-full flex-wrap items-center gap-2">
                    <Link href="/admin/registration-readiness" className="inline-flex min-h-11 items-center gap-1 rounded-xl px-2 text-sm font-bold text-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-soft)]" prefetch={false}>
                        <span className="material-symbols-outlined text-lg" aria-hidden="true">checklist</span>
                        입학 점검
                    </Link>
                </div>
            </div>

            {/* 업무 탭 — 드롭다운을 열지 않아도 다섯 업무와 처리할 건수가 한눈에 보이게 한 줄로 펼친다. */}
            <div role="group" aria-label="신청 관리 업무" className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
                {([
                    { key: "trial", label: "체험 문의", icon: "sports_basketball", count: initialTrialStats?.NEW ?? 0, countLabel: "신규" },
                    { key: "applications", label: "수강신청", icon: "assignment", count: stats.PENDING, countLabel: "대기" },
                    { key: "waitlist", label: "대기자", icon: "hourglass_top", count: 0, countLabel: "" },
                    { key: "sources", label: "유입 통계", icon: "insights", count: 0, countLabel: "" },
                    { key: "settings", label: "안내 설정", icon: "tune", count: 0, countLabel: "" },
                ] as const).map(tab => {
                    const active = activeTab === tab.key;
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            aria-pressed={active}
                            onClick={() => setActiveTab(tab.key as TabType)}
                            className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-xl border px-3.5 text-sm font-bold transition ${
                                active
                                    ? "border-[var(--color-academy-ink)] bg-[var(--color-academy-ink)] text-white"
                                    : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)] hover:border-[var(--color-academy-primary)] hover:text-[var(--color-academy-primary)]"
                            }`}
                        >
                            <span className="material-symbols-outlined text-lg" aria-hidden="true">{tab.icon}</span>
                            {tab.label}
                            {tab.count > 0 && (
                                <span className={`rounded-full px-1.5 py-0.5 text-xs font-extrabold leading-none ${active ? "bg-white text-[var(--color-academy-ink)]" : "bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]"}`}>
                                    <span className="sr-only">{tab.countLabel} </span>{tab.count}
                                </span>
                            )}
                        </button>
                    );
                })}
            </div>

            {feedback && (
                <div
                    className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold ${
                        feedback.type === "success"
                            ? "border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200"
                            : "border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200"
                    }`}
                    role="status"
                >
                    <span className="material-symbols-outlined text-lg">
                        {feedback.type === "success" ? "check_circle" : "error"}
                    </span>
                    {feedback.message}
                </div>
            )}

            {/* 탭 내용 */}
            {activeTab === "trial" ? (
                <TrialCrmClient
                    initialLeads={initialTrialLeads}
                    initialStats={initialTrialStats}
                    initialClasses={initialTrialClasses}
                    initialPagination={initialTrialPagination}
                />
            ) : activeTab === "applications" ? (
                !applyLoaded ? (
                    loadError ? <ApplyErrorState onRetry={loadApplyData} /> : <ApplyLoadingFallback />
                ) : (
                <>
                    <CompactListFilters
                        activeCount={Number(filter !== "ALL") + Number(workFilter !== "ALL")}
                        summary={[filter !== "ALL" ? STATUS_CONFIG[filter]?.label : null, workFilter !== "ALL" ? APPLICATION_WORK_FILTERS.find(item => item.value === workFilter)?.label : null].filter(Boolean).join(" · ") || "전체 조건"}
                        resultCount={`${filteredApps.length}건`}
                        onReset={() => { setFilter("ALL"); setWorkFilter("ALL"); }}
                        search={<label className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3">
                            <span className="material-symbols-outlined text-lg text-[var(--color-academy-muted)]" aria-hidden="true">search</span>
                            <input type="search" value={searchQuery} onChange={event => setSearchQuery(event.target.value)} placeholder="학생, 보호자, 전화번호로 검색" className="min-w-0 flex-1 bg-transparent py-2 text-[17px] text-[var(--color-academy-ink)] outline-none [&::-webkit-search-cancel-button]:appearance-none" />
                            {searchQuery && <button type="button" onClick={() => setSearchQuery("")} title="검색어 지우기" className="inline-flex min-h-11 w-11 shrink-0 items-center justify-center text-[var(--color-academy-muted)]"><span className="material-symbols-outlined text-lg" aria-hidden="true">close</span></button>}
                        </label>}
                    >
                        <label className="min-w-0 space-y-1 text-xs font-bold text-[var(--color-academy-muted)]">신청 상태
                            <select aria-label="수강신청 상태" value={filter} onChange={event => setFilter(event.target.value)} className="h-11 block min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-[17px] text-[var(--color-academy-ink)]">
                                <option value="ALL">전체 {stats.total}</option>
                                {STATUS_ORDER.map(status => <option key={status} value={status}>{STATUS_CONFIG[status].label} {stats[status]}</option>)}
                            </select>
                        </label>
                        <label className="min-w-0 space-y-1 text-xs font-bold text-[var(--color-academy-muted)]">업무 조건
                            <select aria-label="수강신청 업무 조건" value={workFilter} onChange={event => setWorkFilter(event.target.value as ApplicationWorkFilter)} className="h-11 block min-h-11 w-full min-w-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-2 text-[17px] text-[var(--color-academy-ink)]">
                                {APPLICATION_WORK_FILTERS.map(item => <option key={item.value} value={item.value}>{item.label} {workFilterCounts[item.value]}</option>)}
                            </select>
                        </label>
                    </CompactListFilters>

                    {/* 상태별 건수 칩(누르면 그 상태만, 다시 누르면 해제) + 목록|상태별 전환.
                        칩은 필터 모달의 «신청 상태»(filter)와 같은 값을 공유한다. */}
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                        <StatusCountChips
                            ariaLabel="수강신청 상태별 건수"
                            items={STATUS_ORDER.map((status) => ({ value: status, label: STATUS_CONFIG[status].label, count: stats[status] }))}
                            selected={filter}
                            onSelect={setFilter}
                        />
                        <ListViewToggle value={applyView} options={APPLY_VIEW_OPTIONS} onChange={setApplyView} ariaLabel="수강신청 보기 방식" />
                    </div>

                    {/* 신청서 목록 */}
                    {filteredApps.length === 0 ? (
                        <div className="text-center py-16 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700">
                            <span className="material-symbols-outlined text-5xl text-gray-300">inbox</span>
                            <p className="text-gray-500 dark:text-gray-400 mt-3">
                                {searchQuery || workFilter !== "ALL"
                                    ? "조건에 맞는 수강신청이 없습니다"
                                    : filter === "ALL"
                                    ? "접수된 수강 신청이 없습니다"
                                    : `"${STATUS_CONFIG[filter]?.label}" 상태의 신청이 없습니다`}
                            </p>
                            {hasMoreServerApps && (
                                <button
                                    type="button"
                                    onClick={handleShowMoreApps}
                                    disabled={loadingMore}
                                    className="mt-4 rounded-lg border border-gray-200 px-4 py-2 text-sm font-bold text-gray-700 transition hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                                >
                                    {loadingMore ? "불러오는 중..." : "다음 50건에서 더 찾아보기"}
                                </button>
                            )}
                        </div>
                    ) : (
                        <div className="grid gap-2.5">
                            {renderApplicationList()}
                            {hasMoreApps && (<div className="flex flex-col gap-3 rounded-xl border border-gray-100 bg-white px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 sm:flex-row sm:items-center sm:justify-between">
                                <span>
                                    {filteredApps.length}건 중 {visibleApps.length}건 표시
                                </span>
                                {hasMoreApps && (
                                    <button
                                        type="button"
                                        onClick={handleShowMoreApps}
                                        disabled={loadingMore}
                                        className="rounded-lg border border-gray-200 px-4 py-2 font-bold text-gray-700 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                                    >
                                        {loadingMore ? "불러오는 중..." : "50건 더 보기"}
                                    </button>
                                )}
                            </div>)}
                        </div>
                    )}
                </>
                )
            ) : activeTab === "waitlist" ? (
                /* 대기자 탭 — 컴포넌트가 스스로 데이터를 불러온다(props 선택형) */
                <WaitlistClient />
            ) : activeTab === "sources" ? (
                renderSourceStats()
            ) : (
                /* 설정 탭 — 기존 안내 설정 UI */
                <ApplySettingsTab />
            )}

            {hasApplyModal && (
                <ApplyAdminModals
                    approveApp={showApproveModal}
                    rejectApp={showRejectModal}
                    detailApp={showDetailModal}
                    editApp={showEditModal}
                    cancelApp={showCancelModal}
                    reopenApp={showReopenModal}
                    classes={classes}
                    onCloseApprove={() => setShowApproveModal(null)}
                    onCloseReject={() => setShowRejectModal(null)}
                    onCloseDetail={() => setShowDetailModal(null)}
                    onCloseEdit={() => setShowEditModal(null)}
                    onCloseCancel={() => setShowCancelModal(null)}
                    onCloseReopen={() => setShowReopenModal(null)}
                    onSaved={loadApplyData}
                    onFeedback={showFeedback}
                />
            )}

            {contactModal && (
                <ApplicationContactModal
                    app={contactModal.app}
                    defaultAction={contactModal.defaultAction}
                    busy={contactBusyId === contactModal.app.id}
                    onClose={() => setContactModal(null)}
                    onSubmit={async ({ action, note, nextFollowUpAt }) => {
                        await handleRecordContact(contactModal.app, action, note, nextFollowUpAt);
                        setContactModal(null);
                    }}
                />
            )}

            {manualSmsModal && (
                <ManualSmsModal
                    title="학부모 문자 보내기"
                    recipientLabel={`${manualSmsModal.app.childName} · ${manualSmsModal.app.parentName || "보호자"}`}
                    recipientPhone={manualSmsModal.app.parentPhone}
                    defaultMessage={buildEnrollManualSmsMessage(manualSmsModal.app)}
                    busy={manualSmsBusy}
                    onClose={() => {
                        if (!manualSmsBusy) setManualSmsModal(null);
                    }}
                    onSubmit={(message) => handleSendManualSms(manualSmsModal.app, message)}
                />
            )}
        </div>
    );
}

function SourceMetricCard({ label, value, icon }: { label: string; value: string; icon: string }) {
    return (
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center justify-between gap-3">
                <div>
                    <p className="text-xs font-bold text-gray-500 dark:text-gray-400">{label}</p>
                    <p className="mt-1 text-2xl font-black text-gray-900 dark:text-white">{value}</p>
                </div>
                <span className="inline-flex size-10 items-center justify-center rounded-xl bg-brand-orange-50 text-brand-orange-600 dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime">
                    <span className="material-symbols-outlined">{icon}</span>
                </span>
            </div>
        </div>
    );
}

function ApplicationContactModal({
    app,
    defaultAction,
    busy,
    onClose,
    onSubmit,
}: {
    app: EnrollApplication;
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
        <AdminModal onClose={onClose} titleId="application-contact-modal-title" panelClassName="max-w-md" closeOnBackdrop={!busy}>
            <form
                onSubmit={handleSubmit}
                className="w-full p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]"
            >
                <h2 id="application-contact-modal-title" className="flex items-center gap-2 text-lg font-black text-gray-900 dark:text-white">
                    <span className="material-symbols-outlined text-brand-orange-500 dark:text-brand-neon-lime">phone_callback</span>
                    후속 연락 기록
                </h2>
                <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    {app.childName} · {app.parentName} {app.parentPhone}
                </p>

                <div className="mt-5 grid grid-cols-2 gap-2">
                    {(["FOLLOW_UP", "MEMO"] as ContactActionType[]).map((option) => (
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
