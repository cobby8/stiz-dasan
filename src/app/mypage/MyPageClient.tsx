"use client";

import { useState, useTransition, useEffect } from "react";
import Link from "next/link";
// 설치된 학부모 앱은 /mypage 밖으로 나가면 돌아올 길이 없다.
// 길잡이 링크는 감추고(HideInInstalledApp), 내용인 링크는 이동만 막는다(AppSafeLink).
import HideInInstalledApp from "@/components/pwa/HideInInstalledApp";
import AppSafeLink from "@/components/pwa/AppSafeLink";
import { markNotificationRead, markAllNotificationsRead, createParentRequest } from "@/app/actions/admin";
import type { ParentShuttleOverviewItem } from "@/lib/shuttle/parent";
import type { PendingSeasonalChild } from "@/lib/seasonal/pendingSeasonalChildren";
// "오늘/이번주 우리 아이" 요약 카드용 순수 로직(표시 전용, 기존 데이터 재조합).
import { getKstNow, getKstDateStr, computeNextClass, nextClassWhenLabel, filterTodayShuttle } from "@/lib/mypage/summary";

const DAY_LABELS: Record<string, string> = {
    Mon: "월", Tue: "화", Wed: "수", Thu: "목", Fri: "금", Sat: "토", Sun: "일",
};

const PAYMENT_STATUS: Record<string, { label: string; color: string }> = {
    PENDING: { label: "미납", color: "text-yellow-700 bg-yellow-100 dark:bg-yellow-950/40 dark:text-yellow-200" },
    PAID: { label: "납부완료", color: "text-green-700 bg-green-100 dark:bg-green-950/40 dark:text-green-200" },
    OVERDUE: { label: "연체", color: "text-red-700 bg-red-100 dark:bg-red-950/40 dark:text-red-200" },
    REFUNDED: { label: "환불", color: "text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900" },
    CANCELED: { label: "취소/이월", color: "text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-900" },
};

const TYPE_LABELS: Record<string, string> = {
    MONTHLY: "수강료",
    SHUTTLE: "셔틀",
    UNIFORM: "유니폼",
    OTHER: "기타",
};

function toDateStr(d: Date | string | null): string {
    if (!d) return "-";
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toISOString().split("T")[0];
}

function formatAmount(n: number): string {
    return n.toLocaleString("ko-KR") + "원";
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

type ChildData = {
    id: string;
    name: string;
    birthDate: Date | string;
    gender: string | null;
    enrollments: {
        id: string;
        classId: string;
        className: string;
        dayOfWeek: string;
        startTime: string;
        endTime: string;
        programName: string;
    }[];
    attendance: {
        total: number;
        present: number;
        absent: number;
        late: number;
        records: { status: string; date: Date | string }[];
    };
    payments: {
        id: string;
        amount: number;
        status: string;
        dueDate: Date | string;
        paidDate: Date | string | null;
        type?: string;
        description?: string | null;
        method?: string | null;
        receiptUrl?: string | null;
        invoiceId?: string | null;
        invoiceNo?: string | null;
        invoiceStatus?: string | null;
        invoiceCheckoutUrl?: string | null;
    }[];
};

type GalleryItem = {
    id: string;
    title: string | null;
    caption: string | null;
    mediaJSON: string;
    createdAt: Date | string;
    className: string | null;
};

type NoticeItem = {
    id: string;
    title: string;
    content: string;
    targetType: string;
    isPinned: boolean;
    createdAt: Date | string;
    attachmentsJSON: string | null;
};

type NotificationItem = {
    id: string;
    userId: string;
    type: string;
    title: string;
    message: string;
    linkUrl: string | null;
    isRead: boolean;
    createdAt: Date | string;
};

type RequestItem = {
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
};

// 코치가 작성한 학습 피드백 항목 타입
type FeedbackItem = {
    id: string;
    studentId: string;
    sessionDate: Date | string | null;
    category: string;
    title: string;
    content: string;
    rating: number | null;
    createdAt: Date | string;
    coachName: string | null;
    studentName: string | null;
};

// 피드백 카테고리별 라벨과 색상
const FB_CATEGORIES: Record<string, { label: string; color: string }> = {
    SKILL: { label: "기술", color: "bg-blue-100 text-blue-700" },
    ATTITUDE: { label: "태도", color: "bg-green-100 text-green-700" },
    PHYSICAL: { label: "체력", color: "bg-purple-100 text-purple-700" },
    GENERAL: { label: "종합", color: "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200" },
};

type MyPageData = {
    parent: { id: string; name: string; email: string; phone: string | null };
    children: ChildData[];
};

// 요청 유형(결석·셔틀·조퇴·기타) 선택은 없앴다. 유형별로 나눠 받으면 그 유형대로
// 처리되는 것처럼 보이는데, 실제로는 전부 사람이 읽고 손으로 처리하는 메모였다.
// 결석처럼 진짜 기능이 있는 것은 그 기능으로 보내고, 나머지는 자유 메시지 하나로 받는다.
// 서버는 type 을 계속 받으므로(다른 경로 호환) 여기서는 항상 "OTHER" 로 보낸다.

const REQUEST_STATUS: Record<string, { label: string; color: string; iconName: string }> = {
    PENDING: { label: "대기중", color: "bg-yellow-100 text-yellow-700", iconName: "schedule" },
    CONFIRMED: { label: "확인됨", color: "bg-blue-100 text-blue-700", iconName: "check_circle" },
    COMPLETED: { label: "상담 종결", color: "bg-green-100 text-green-700", iconName: "check_circle" },
    REJECTED: { label: "반려", color: "bg-red-100 text-red-700", iconName: "cancel" },
};

const SHUTTLE_STATUS: Record<ParentShuttleOverviewItem["status"], { label: string; color: string }> = {
    REQUESTED: { label: "신청 접수", color: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-200" },
    PREPARING: { label: "배정 준비 중", color: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-200" },
    CONFIRMED: { label: "배정 확정", color: "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-200" },
    COMPLETED: { label: "운행 완료", color: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200" },
};

const SHUTTLE_DIRECTION = {
    PICKUP: "등원",
    DROPOFF: "하원",
} as const;

const SHUTTLE_RIDE_STATUS: Record<string, string> = {
    PENDING: "탑승 대기",
    BOARDED: "탑승",
    DROPPED_OFF: "하차",
    NO_SHOW: "미탑승",
};

function formatShuttleDate(value: string | null): string {
    if (!value) return "운행일 확인 중";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
}

function formatShuttleTime(value: string | null): string {
    if (!value) return "시간 확인 중";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    // 확정 시간은 UTC로 내려온다. 기기 설정과 무관하게 항상 한국시간으로 보여준다.
    return date.toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" });
}

export default function MyPageClient({ data, gallery = [], notices = [], notifications = [], unreadCount = 0, myRequests = [], feedbacks = [], parentShuttleOverview = [], shuttleDriverContact = null, pendingSeasonalChildren = [] }: {
    data: MyPageData;
    gallery?: GalleryItem[];
    notices?: NoticeItem[];
    notifications?: NotificationItem[];
    unreadCount?: number;
    myRequests?: RequestItem[];
    feedbacks?: FeedbackItem[];
    parentShuttleOverview?: ParentShuttleOverviewItem[];
    shuttleDriverContact?: { name: string; phone: string } | null;
    // 방학특강만 신청하고 아직 정식 학생으로 전환되지 않은 자녀(별도 섹션에 표시)
    pendingSeasonalChildren?: PendingSeasonalChild[];
}) {
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [showNotifications, setShowNotifications] = useState(false);
    const [showRequestForm, setShowRequestForm] = useState(false);
    const [showRequests, setShowRequests] = useState(false);
    const [isPending, startTransition] = useTransition();
    // 요청 폼 상태
    const [reqContent, setReqContent] = useState("");
    const [reqDate, setReqDate] = useState("");
    // 피드백 카드 펼치기 상태 (클릭한 피드백 ID 저장)
    const [expandedFbId, setExpandedFbId] = useState<string | null>(null);
    // 푸시 알림 상태
    const [pushSupported, setPushSupported] = useState(false);
    const [pushEnabled, setPushEnabled] = useState(false);
    const [pushLoading, setPushLoading] = useState(false);

    // 브라우저 푸시 지원 여부 및 현재 구독 상태 확인
    useEffect(() => {
        if ("serviceWorker" in navigator && "PushManager" in window) {
            setPushSupported(true);
            navigator.serviceWorker.ready.then(reg => {
                reg.pushManager.getSubscription().then(sub => {
                    setPushEnabled(!!sub);
                });
            });
            // Service Worker 등록
            navigator.serviceWorker.register("/sw.js").catch(() => {});
        }
    }, []);

    // 푸시 알림 구독/해제 토글
    async function togglePush() {
        setPushLoading(true);
        try {
            const reg = await navigator.serviceWorker.ready;
            const existing = await reg.pushManager.getSubscription();

            if (existing) {
                // 구독 해제
                await existing.unsubscribe();
                await fetch("/api/push", {
                    method: "DELETE",
                    body: JSON.stringify({ endpoint: existing.endpoint }),
                });
                setPushEnabled(false);
            } else {
                // 구독 등록
                const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
                if (!vapidKey) throw new Error("VAPID 키 없음");
                const sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
                });
                await fetch("/api/push", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ subscription: sub.toJSON() }),
                });
                setPushEnabled(true);
            }
        } catch (e) {
            console.error("Push toggle error:", e);
            alert("알림 설정에 실패했습니다. 브라우저 알림 권한을 확인해주세요.");
        }
        setPushLoading(false);
    }
    const child = data.children[selectedIdx];
    const childShuttleOverview = parentShuttleOverview.filter((item) => item.studentId === child.id);

    const enrollSummary = child.enrollments
        .map((e) => `${e.className} (${DAY_LABELS[e.dayOfWeek] || e.dayOfWeek} ${e.startTime}~${e.endTime})`)
        .join(", ");

    const pendingPayments = child.payments.filter((p) => p.status === "PENDING" || p.status === "OVERDUE");

    // ── "오늘/이번주 우리 아이" 요약 카드 계산 (표시 전용, 선택 자녀 기준) ──
    // 렌더 시점의 실제 시각을 KST로 환산해 사용한다(자녀 전환 시 자동 재계산됨).
    const now = new Date();
    const kstNow = getKstNow(now);
    const todayStr = getKstDateStr(now);
    // 1) 다음 수업: 수강 반의 요일/시작시각으로 가장 가까운 향후 1건.
    const nextClass = computeNextClass(child.enrollments, kstNow);
    // 2) 오늘 셔틀: 오늘 날짜 운행 항목만.
    const todayShuttles = filterTodayShuttle(childShuttleOverview, todayStr);
    // 4) 새 소식 배지: 이번 화면에 온 리포트/피드백 개수(있는 데이터 범위). 링크로 해당 섹션 이동.
    const feedbackCount = feedbacks.length;
    // 요약에 표시할 항목이 하나라도 있는지(전부 없으면 카드 자체를 숨긴다).
    const hasSummary = Boolean(nextClass) || todayShuttles.length > 0 || pendingPayments.length > 0 || feedbackCount > 0;

    // 요약 항목 클릭 시 해당 상세 섹션으로 부드럽게 스크롤(중복 정보지만 진입 단축).
    function scrollToSection(id: string) {
        document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    return (
        <div className="space-y-6">
            {/* 학생 카드 — navy 배경 유지, 장식 도형 추가 (about 히어로 패턴과 통일) */}
            <div className="bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 text-white rounded-2xl p-6 shadow-lg relative overflow-hidden">
                {/* 장식 도형들 — 공개 페이지 히어로와 동일한 패턴 */}
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute right-0 top-0 w-40 h-40 border-[15px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3 transition-colors duration-300" />
                    <div className="absolute left-0 bottom-0 w-28 h-28 border-[10px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4 transition-colors duration-300" />
                </div>
                <div className="relative z-10">
                    <div className="flex justify-between items-center mb-4">
                        <h1 className="text-2xl font-bold">
                            {child.name} <span className="text-brand-orange-500 dark:text-brand-neon-lime text-lg font-medium">학생</span>
                        </h1>
                        {data.children.length > 1 && (
                            <select
                                value={selectedIdx}
                                onChange={(e) => setSelectedIdx(Number(e.target.value))}
                                className="bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-full text-xs font-bold text-white transition border border-white/20"
                            >
                                {data.children.map((c, i) => (
                                    <option key={c.id} value={i} className="text-gray-900 dark:text-white">{c.name}</option>
                                ))}
                            </select>
                        )}
                    </div>
                    <p className="text-gray-300 text-sm mb-6">
                        {enrollSummary || "수강 중인 반이 없습니다"}
                    </p>

                    <div className="grid grid-cols-2 gap-4">
                        <div className="bg-white dark:bg-gray-800/10 rounded-xl p-3 backdrop-blur-sm border border-white/5">
                            <div className="text-white/60 text-xs font-medium mb-1">이번 달 출석</div>
                            <div className="text-xl font-bold">
                                {child.attendance.present}
                                <span className="text-sm font-normal text-white/60"> / {child.attendance.total}회</span>
                            </div>
                        </div>
                        <div className="bg-white dark:bg-gray-800/10 rounded-xl p-3 backdrop-blur-sm border border-white/5">
                            <div className="text-white/60 text-xs font-medium mb-1">결석/지각</div>
                            <div className="text-xl font-bold">
                                {child.attendance.absent > 0 ? (
                                    <span className="text-red-400">{child.attendance.absent}</span>
                                ) : (
                                    <span className="text-green-400">0</span>
                                )}
                                {child.attendance.late > 0 && (
                                    <span className="text-yellow-400 text-sm ml-1">지각 {child.attendance.late}</span>
                                )}
                                {child.attendance.absent === 0 && child.attendance.late === 0 && (
                                    <span className="text-sm font-normal text-white/60"> 없음</span>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* ── "오늘/이번주 우리 아이" 한눈 요약 카드 (표시 전용·상단 배치) ──
                반/출결/셔틀/미납/피드백으로 흩어진 정보를 선택 자녀 기준으로 재조합해 보여준다.
                각 줄은 값이 있을 때만 렌더하고, 전부 없으면 카드 자체를 숨긴다. */}
            {hasSummary && (
                <section aria-labelledby="mypage-summary-heading" className="rounded-2xl border border-gray-100 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-800">
                    <div className="mb-3 flex items-center gap-2">
                        <div className="rounded-full bg-brand-orange-50 p-1.5 dark:bg-brand-neon-lime/10">
                            <SymbolIcon name="today" size={18} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                        </div>
                        <h2 id="mypage-summary-heading" className="font-bold text-gray-900 dark:text-white">
                            {child.name} 학생 한눈에 보기
                        </h2>
                    </div>

                    <div className="space-y-2">
                        {/* 1) 다음 수업 */}
                        {nextClass && (
                            <button
                                type="button"
                                onClick={() => scrollToSection("mypage-enrollments")}
                                className="flex w-full items-center justify-between gap-3 rounded-xl bg-gray-50 px-4 py-3 text-left transition hover:bg-gray-100 dark:bg-gray-900/60 dark:hover:bg-gray-900"
                            >
                                <span className="flex items-center gap-2.5">
                                    <SymbolIcon name="event" size={18} className="text-brand-navy-900 dark:text-gray-200" />
                                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400">다음 수업</span>
                                </span>
                                <span className="min-w-0 text-right text-sm font-bold text-gray-900 dark:text-white">
                                    {nextClassWhenLabel(nextClass, kstNow)} {nextClass.startTime}
                                    <span className="ml-1 truncate font-normal text-gray-500 dark:text-gray-400">· {nextClass.className}</span>
                                </span>
                            </button>
                        )}

                        {/* 2) 오늘 셔틀 */}
                        {todayShuttles.length > 0 && (
                            <button
                                type="button"
                                onClick={() => scrollToSection("mypage-shuttle")}
                                className="flex w-full items-center justify-between gap-3 rounded-xl bg-gray-50 px-4 py-3 text-left transition hover:bg-gray-100 dark:bg-gray-900/60 dark:hover:bg-gray-900"
                            >
                                <span className="flex items-center gap-2.5">
                                    <SymbolIcon name="airport_shuttle" size={18} className="text-blue-600 dark:text-blue-300" />
                                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400">오늘 셔틀</span>
                                </span>
                                <span className="text-right text-sm font-bold text-gray-900 dark:text-white">
                                    {/* 확정 승·하차 시각이 있으면 요약, 없으면 방향/상태만 */}
                                    {[
                                        todayShuttles.map((s) => s.pickupEtaLabel).find(Boolean)
                                            ? `등원 ${todayShuttles.map((s) => s.pickupEtaLabel).find(Boolean)}`
                                            : null,
                                        todayShuttles.map((s) => s.dropoffEtaLabel).find(Boolean)
                                            ? `하원 ${todayShuttles.map((s) => s.dropoffEtaLabel).find(Boolean)}`
                                            : null,
                                    ].filter(Boolean).join(" · ") || `운행 ${todayShuttles.length}건`}
                                </span>
                            </button>
                        )}

                        {/* 3) 미납 알림 */}
                        {pendingPayments.length > 0 && (
                            <button
                                type="button"
                                onClick={() => scrollToSection("mypage-payment-alert")}
                                className="flex w-full items-center justify-between gap-3 rounded-xl bg-red-50 px-4 py-3 text-left transition hover:bg-red-100 dark:bg-red-500/10 dark:hover:bg-red-500/20"
                            >
                                <span className="flex items-center gap-2.5">
                                    <SymbolIcon name="credit_card" size={18} className="text-red-600 dark:text-red-300" />
                                    <span className="text-sm font-medium text-red-700 dark:text-red-200">미납 안내</span>
                                </span>
                                <span className="rounded-full bg-red-600 px-2.5 py-1 text-xs font-bold text-white">
                                    미납 {pendingPayments.length}건
                                </span>
                            </button>
                        )}

                        {/* 4) 새 소식 배지 — 학습 피드백 */}
                        {feedbackCount > 0 && (
                            <button
                                type="button"
                                onClick={() => scrollToSection("mypage-feedback")}
                                className="flex w-full items-center justify-between gap-3 rounded-xl bg-gray-50 px-4 py-3 text-left transition hover:bg-gray-100 dark:bg-gray-900/60 dark:hover:bg-gray-900"
                            >
                                <span className="flex items-center gap-2.5">
                                    <SymbolIcon name="star" size={18} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400">학습 피드백</span>
                                </span>
                                <span className="rounded-full bg-brand-orange-500 px-2.5 py-1 text-xs font-bold text-white dark:bg-brand-neon-lime dark:text-brand-navy-900">
                                    {feedbackCount}건
                                </span>
                            </button>
                        )}
                    </div>
                </section>
            )}

            {/* 방학특강 신청 자녀(전환 대기중) — 정식 학생으로 아직 전환되지 않아
                위 대시보드에 안 뜨는 자녀를 별도 섹션으로 안내한다. 목록이 비면 통째로 숨김. */}
            {pendingSeasonalChildren.length > 0 && (
                <section aria-labelledby="pending-seasonal-heading" className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm dark:border-amber-900/50 dark:bg-amber-950/20">
                    <div className="mb-4">
                        <div className="flex items-center gap-2">
                            <SymbolIcon name="hourglass_top" size={20} className="text-amber-600 dark:text-amber-300" />
                            <h2 id="pending-seasonal-heading" className="font-bold text-gray-900 dark:text-white">방학특강 신청 자녀 (전환 대기중)</h2>
                        </div>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                            정규 수강·수납 정보는 학생 등록(전환) 후 표시됩니다.
                        </p>
                    </div>
                    <div className="space-y-3">
                        {pendingSeasonalChildren.map((c, idx) => (
                            <div key={`${c.childName}-${idx}`} className="rounded-xl border border-amber-200 bg-white p-4 dark:border-amber-900/40 dark:bg-gray-800">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="font-bold text-gray-900 dark:text-white">
                                        {c.childName}
                                        {c.childGrade && (
                                            <span className="ml-2 text-xs font-medium text-gray-500 dark:text-gray-400">{c.childGrade}</span>
                                        )}
                                    </div>
                                    {c.upcomingCount > 0 && (
                                        <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-900/50 dark:text-amber-200">
                                            예정 {c.upcomingCount}회
                                        </span>
                                    )}
                                </div>
                                {c.offeringTitles.length > 0 && (
                                    <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                                        <span className="text-gray-500 dark:text-gray-400">신청 특강: </span>
                                        {c.offeringTitles.join(", ")}
                                    </p>
                                )}
                                <Link
                                    href="/mypage/seasonal"
                                    className="mt-3 inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-white transition hover:bg-amber-600 dark:bg-amber-600 dark:hover:bg-amber-500"
                                >
                                    방학특강 결석 신고 / 보강
                                    <SymbolIcon name="arrow_forward" size={16} />
                                </Link>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {childShuttleOverview.length > 0 && (
                <section id="mypage-shuttle" aria-labelledby="parent-shuttle-heading" className="scroll-mt-4 rounded-2xl border border-blue-100 bg-white p-5 shadow-sm dark:border-blue-900/50 dark:bg-gray-800">
                    <div className="mb-4 flex items-start justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-2">
                                <SymbolIcon name="airport_shuttle" size={20} className="text-blue-600 dark:text-blue-300" />
                                <h2 id="parent-shuttle-heading" className="font-bold text-gray-900 dark:text-white">셔틀 안내</h2>
                            </div>
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{child.name} 학생의 신청 및 배정 현황입니다.</p>
                        </div>
                        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:items-start">
                            {shuttleDriverContact?.phone && (
                                <a
                                    href={`tel:${shuttleDriverContact.phone.replace(/[^0-9]/g, "")}`}
                                    className="flex min-h-11 items-center justify-center gap-1.5 rounded-xl bg-green-600 px-3 py-2 text-xs font-bold text-white transition hover:bg-green-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800"
                                    aria-label={`셔틀 기사님 ${shuttleDriverContact.name}에게 전화하기`}
                                >
                                    <SymbolIcon name="call" size={16} className="text-white" />
                                    기사님께 연락 ({shuttleDriverContact.name})
                                </a>
                            )}
                            <button
                                type="button"
                                onClick={() => {
                                    // 셔틀 변경은 아직 전용 기능이 없어 메시지로 받는다.
                                    // 무엇을 적어야 할지 알 수 있게 첫 줄만 채워 준다.
                                    setReqContent((prev) => prev || "셔틀 변경 요청: ");
                                    setShowRequestForm(true);
                                    setShowRequests(false);
                                    requestAnimationFrame(() => {
                                        document.getElementById("parent-request-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
                                    });
                                }}
                                className="min-h-11 shrink-0 rounded-xl border border-blue-200 px-3 py-2 text-xs font-bold text-blue-700 transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:border-blue-700 dark:text-blue-200 dark:hover:bg-blue-950/40 dark:focus-visible:ring-offset-gray-800"
                            >
                                변경 요청
                            </button>
                        </div>
                    </div>

                    <div className="space-y-3">
                        {childShuttleOverview.map((item) => {
                            const status = SHUTTLE_STATUS[item.status];
                            const showDetails = item.status === "CONFIRMED" || item.status === "COMPLETED";
                            return (
                                <article key={item.id} className="rounded-xl bg-gray-50 p-4 dark:bg-gray-900/60">
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                        <div>
                                            <p className="text-sm font-bold text-gray-900 dark:text-white">{item.title}</p>
                                            <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
                                                {item.label}{item.direction ? ` · ${SHUTTLE_DIRECTION[item.direction]}` : ""}
                                            </p>
                                        </div>
                                        <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${status.color}`}>{status.label}</span>
                                    </div>

                                    <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-2 text-sm">
                                        <dt className="text-gray-500 dark:text-gray-400">운행일</dt>
                                        <dd className="font-medium text-gray-800 dark:text-gray-100">
                                            {item.serviceDate ? <time dateTime={item.serviceDate}>{formatShuttleDate(item.serviceDate)}</time> : "운행일 확인 중"}
                                        </dd>
                                        {/* 셔틀 확정 승·하차 시각(저장된 배차 노선 기준). 방학특강·정규 공통, 값이 있을 때만 노출한다. */}
                                        {(item.pickupEtaLabel || item.dropoffEtaLabel) && (
                                            <>
                                                <dt className="text-gray-500 dark:text-gray-400">확정 시각</dt>
                                                <dd className="font-medium text-gray-800 dark:text-gray-100">
                                                    {[
                                                        item.pickupEtaLabel ? `등원 ${item.pickupEtaLabel}` : null,
                                                        item.dropoffEtaLabel ? `하원 ${item.dropoffEtaLabel}` : null,
                                                    ].filter(Boolean).join(" · ")}
                                                </dd>
                                            </>
                                        )}
                                        {showDetails && (
                                            <>
                                                <dt className="text-gray-500 dark:text-gray-400">노선</dt>
                                                <dd className="font-medium text-gray-800 dark:text-gray-100">{item.routeName || "노선 확인 중"}</dd>
                                                <dt className="text-gray-500 dark:text-gray-400">
                                                    {item.direction === "PICKUP" ? "탑승 장소" : item.direction === "DROPOFF" ? "하차 장소" : "정류장"}
                                                </dt>
                                                <dd className="font-medium text-gray-800 dark:text-gray-100">
                                                    {item.stopName || "정류장 확인 중"}
                                                    {item.stopAddress && <span className="mt-0.5 block text-xs font-normal text-gray-500 dark:text-gray-400">{item.stopAddress}</span>}
                                                </dd>
                                                <dt className="text-gray-500 dark:text-gray-400">확정 시간</dt>
                                                <dd className="font-medium text-gray-800 dark:text-gray-100">
                                                    {item.plannedAt ? <time dateTime={item.plannedAt}>{formatShuttleTime(item.plannedAt)}</time> : "시간 확인 중"}
                                                </dd>
                                                <dt className="text-gray-500 dark:text-gray-400">차량</dt>
                                                <dd className="font-medium text-gray-800 dark:text-gray-100">{item.vehicleName || "차량 확인 중"}</dd>
                                                {item.rideStatus && (
                                                    <>
                                                        <dt className="text-gray-500 dark:text-gray-400">탑승 상태</dt>
                                                        <dd className="font-medium text-gray-800 dark:text-gray-100">
                                                            {SHUTTLE_RIDE_STATUS[item.rideStatus] || "상태 확인 중"}
                                                        </dd>
                                                    </>
                                                )}
                                            </>
                                        )}
                                    </dl>
                                </article>
                            );
                        })}
                    </div>
                </section>
            )}

            {/* 알림 토글 버튼 — 호버 시 그림자 강화 (디자인 토큰 통일) */}
            <div>
                <button
                    onClick={() => setShowNotifications(!showNotifications)}
                    className="w-full flex items-center justify-between bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm hover:shadow-md hover:border-brand-orange-200 transition"
                >
                    <div className="flex items-center gap-3">
                        <div className="bg-brand-orange-50 dark:bg-brand-neon-lime/10  p-2 rounded-full">
                            <SymbolIcon name="notifications" size={20} className="text-brand-orange-500 dark:text-brand-neon-lime" />
                        </div>
                        <span className="font-bold text-gray-900 dark:text-white">알림</span>
                        {unreadCount > 0 && (
                            <span className="bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full min-w-[20px] text-center">
                                {unreadCount}
                            </span>
                        )}
                    </div>
                    <span className="text-gray-400 text-sm">{showNotifications ? "접기" : "펼치기"}</span>
                </button>

                {showNotifications && (
                    <div className="mt-2 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm overflow-hidden">
                        {/* 상단 바: 푸시 설정 + 전체 읽음 */}
                        <div className="px-4 py-2 border-b border-gray-50 flex items-center justify-between">
                            {/* 푸시 알림 토글 */}
                            {pushSupported && (
                                <button
                                    onClick={togglePush}
                                    disabled={pushLoading}
                                    className={`text-xs flex items-center gap-1 px-2.5 py-1 rounded-full transition ${
                                        pushEnabled
                                            ? "bg-green-100 text-green-700"
                                            : "bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-orange-50 hover:text-brand-orange-500 dark:text-brand-neon-lime"
                                    }`}
                                >
                                    {pushLoading ? "..." : pushEnabled ? (
                                        <><SymbolIcon name="notifications_active" size={13} /> 푸시 ON</>
                                    ) : (
                                        <><SymbolIcon name="notifications_off" size={13} /> 푸시 OFF</>
                                    )}
                                </button>
                            )}
                            {!pushSupported && <span />}
                            {unreadCount > 0 && (
                                <button
                                    onClick={() => startTransition(() => markAllNotificationsRead(data.parent.id))}
                                    disabled={isPending}
                                    className="text-xs text-brand-orange-500 dark:text-brand-neon-lime hover:underline flex items-center gap-1"
                                >
                                    <SymbolIcon name="done_all" size={14} /> 모두 읽음
                                </button>
                            )}
                        </div>

                        {notifications.length === 0 ? (
                            <div className="p-8 text-center text-gray-400 text-sm">
                                알림이 없습니다
                            </div>
                        ) : (
                            <div className="divide-y divide-gray-50 max-h-80 overflow-y-auto">
                                {notifications.map(n => (
                                    <div
                                        key={n.id}
                                        className={`px-4 py-3 flex items-start gap-3 ${!n.isRead ? "bg-orange-50/50" : ""}`}
                                    >
                                        {/* 알림 타입 아이콘 */}
                                        <div className={`mt-0.5 p-1.5 rounded-full flex-shrink-0 ${
                                            n.type === "ATTENDANCE" ? "bg-green-100 text-green-600" :
                                            n.type === "PAYMENT" ? "bg-red-100 text-red-600" :
                                            "bg-blue-100 text-blue-600"
                                        }`}>
                                            <SymbolIcon
                                                name={n.type === "ATTENDANCE" ? "event_available" : n.type === "PAYMENT" ? "credit_card" : "notifications"}
                                                size={14}
                                            />
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <p className={`text-sm ${!n.isRead ? "font-bold text-gray-900 dark:text-white" : "text-gray-700 dark:text-gray-200"}`}>
                                                {n.title}
                                            </p>
                                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{n.message}</p>
                                            <p className="text-xs text-gray-400 mt-1">
                                                {new Date(n.createdAt).toLocaleDateString("ko-KR", {
                                                    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
                                                })}
                                            </p>
                                        </div>

                                        {/* 읽음 처리 버튼 */}
                                        {!n.isRead && (
                                            <button
                                                onClick={() => startTransition(() => markNotificationRead(n.id))}
                                                disabled={isPending}
                                                className="text-gray-400 hover:text-brand-orange-500 dark:text-brand-neon-lime p-1 flex-shrink-0"
                                                title="읽음 처리"
                                            >
                                                <SymbolIcon name="check" size={14} />
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* 학원에 메시지 보내기 */}
            <div>
                <div className="flex gap-2">
                    <button
                        onClick={() => { setShowRequestForm(!showRequestForm); setShowRequests(false); }}
                        className="flex-1 flex items-center justify-center gap-2 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold py-3 rounded-2xl hover:bg-brand-orange-600 dark:hover:bg-lime-400 transition shadow-sm"
                    >
                        <SymbolIcon name="send" size={16} /> 학원에 메시지 보내기
                    </button>
                    <button
                        onClick={() => { setShowRequests(!showRequests); setShowRequestForm(false); }}
                        className="flex items-center gap-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200 font-bold px-4 py-3 rounded-2xl hover:bg-gray-50 dark:bg-gray-900 transition shadow-sm"
                    >
                        <SymbolIcon name="forum" size={16} />
                        보낸 메시지
                        {myRequests.filter(r => r.status === "PENDING").length > 0 && (
                            <span className="bg-yellow-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full">
                                {myRequests.filter(r => r.status === "PENDING").length}
                            </span>
                        )}
                    </button>
                </div>

                {/* 메시지 작성 폼 */}
                {showRequestForm && (
                    <div id="parent-request-form" className="mt-3 scroll-mt-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-5 shadow-sm space-y-4">
                        <h3 className="font-bold text-gray-900 dark:text-white">학원에 메시지 보내기</h3>

                        {/* 유형 선택을 없앤 이유: 유형별로 나눠 받으면 학원이 그 유형대로 처리해 줄 것처럼
                            보이는데, 실제로는 전부 사람이 읽고 손으로 처리하는 메모였다. 결석처럼 진짜
                            기능이 있는 것은 그 기능으로 보내고, 나머지는 자유 메시지 하나로 받는다. */}
                        <div className="rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-100 dark:border-amber-900 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
                            결석은 여기 적지 마시고{" "}
                            <Link href="/mypage/regular-absence" className="font-bold underline">결석 미리 알리기</Link>
                            에서 신고해 주세요. <b>셔틀에서도 자동으로 빠집니다.</b>
                            <br />
                            방학특강 결석은{" "}
                            <Link href="/mypage/seasonal" className="font-bold underline">방학특강 결석 신고</Link>
                            에서 신고해 주세요.
                        </div>

                        {/* 자녀 선택 (여러 명일 때) */}
                        {data.children.length > 1 && (
                            <div>
                                <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">자녀 선택</label>
                                <select
                                    value={selectedIdx}
                                    onChange={e => setSelectedIdx(Number(e.target.value))}
                                    className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm"
                                >
                                    {data.children.map((c, i) => (
                                        <option key={c.id} value={i}>{c.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}

                        {/* 날짜 */}
                        <div>
                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
                                해당 날짜 (선택)
                            </label>
                            <input type="date" min="2020-01-01" max="2030-12-31" value={reqDate} onChange={e => setReqDate(e.target.value)}
                                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm" />
                        </div>

                        {/* 내용 */}
                        <div>
                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">메시지</label>
                            <textarea
                                value={reqContent}
                                onChange={e => setReqContent(e.target.value)}
                                placeholder="문의하실 내용을 편하게 적어주세요"
                                rows={4}
                                className="w-full border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm resize-none"
                            />
                        </div>

                        {/* 제출 */}
                        <button
                            disabled={isPending || !reqContent.trim()}
                            onClick={() => {
                                const dateLabel = reqDate ? ` (${reqDate})` : "";
                                startTransition(async () => {
                                    await createParentRequest({
                                        userId: data.parent.id,
                                        studentId: child.id,
                                        // 유형을 나누지 않는다. 전부 사람이 읽고 처리하는 자유 메시지다.
                                        type: "OTHER",
                                        title: `${child.name} 문의${dateLabel}`,
                                        content: reqContent,
                                        date: reqDate || null,
                                    });
                                    setReqContent("");
                                    setReqDate("");
                                    setShowRequestForm(false);
                                });
                            }}
                            className="w-full bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white font-bold py-3 rounded-xl hover:bg-brand-orange-600 dark:hover:bg-lime-400 transition disabled:opacity-50"
                        >
                            {isPending ? "보내는 중..." : "메시지 보내기"}
                        </button>
                    </div>
                )}

                {/* 보낸 메시지 */}
                {showRequests && (
                    <div className="mt-3 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm overflow-hidden">
                        {myRequests.length === 0 ? (
                            <div className="p-8 text-center text-gray-400 text-sm">보낸 메시지가 없습니다</div>
                        ) : (
                            <div className="divide-y divide-gray-50 max-h-96 overflow-y-auto">
                                {myRequests.map(r => {
                                    const st = REQUEST_STATUS[r.status] || REQUEST_STATUS.PENDING;
                                    return (
                                        <div key={r.id} className="px-4 py-3">
                                            <div className="flex items-center justify-between mb-1">
                                                <span className="text-sm font-bold text-gray-900 dark:text-white">{r.title}</span>
                                                <span className={`text-xs font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${st.color}`}>
                                                    <SymbolIcon name={st.iconName} size={12} /> {st.label}
                                                </span>
                                            </div>
                                            <p className="text-xs text-gray-500 dark:text-gray-400 line-clamp-2">{r.content}</p>
                                            {r.adminNote && (
                                                <div className="mt-2 bg-blue-50 rounded-lg px-3 py-2">
                                                    <p className="text-xs text-blue-700">
                                                        <span className="font-bold">학원 답변:</span> {r.adminNote}
                                                    </p>
                                                </div>
                                            )}
                                            <p className="text-xs text-gray-400 mt-1">
                                                {new Date(r.createdAt).toLocaleDateString("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                                            </p>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Payment Alert */}
            {pendingPayments.length > 0 && (
                <div id="mypage-payment-alert" className="scroll-mt-4 space-y-3">
                    {pendingPayments.map((p) => (
                        <div key={p.id} className="rounded-2xl border border-red-100 bg-red-50 p-4 shadow-sm dark:border-red-500/30 dark:bg-red-500/10">
                            <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-3 text-red-700 dark:text-red-100">
                                    <div className="mt-0.5 rounded-full bg-white p-2 text-red-500 shadow-sm dark:bg-gray-900 dark:text-red-200">
                                        <SymbolIcon name="credit_card" size={20} />
                                    </div>
                                    <div>
                                        <p className="text-xs font-bold uppercase tracking-wide text-red-500 dark:text-red-200">
                                            납부가 필요합니다
                                        </p>
                                        <p className="mt-1 text-lg font-black text-gray-900 dark:text-white">
                                            {formatAmount(p.amount)}
                                        </p>
                                        <p className="mt-1 text-xs text-red-600 dark:text-red-200">
                                            {p.description || "수강료"} · 납부 기한 {toDateStr(p.dueDate)}
                                        </p>
                                        {p.invoiceNo && (
                                            <p className="mt-1 text-[11px] font-bold text-gray-500 dark:text-gray-300">
                                                청구서 {p.invoiceNo}
                                            </p>
                                        )}
                                    </div>
                                </div>
                                <span className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-bold ${PAYMENT_STATUS[p.status]?.color || ""}`}>
                                    {PAYMENT_STATUS[p.status]?.label || p.status}
                                </span>
                            </div>
                            {p.invoiceId && (
                                <Link
                                    href={`/payments/${p.invoiceId}`}
                                    className="mt-4 flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-orange-500 px-4 text-sm font-black text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                                >
                                    청구서 확인하고 납부하기
                                </Link>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {/* 수강 중인 반 — 카드 호버 효과 추가 (디자인 토큰 통일) */}
            {child.enrollments.length > 0 && (
                <div id="mypage-enrollments" className="scroll-mt-4">
                    <h2 className="font-bold text-brand-navy-900 mb-3 px-1">수강 중인 반</h2>
                    <div className="space-y-2">
                        {child.enrollments.map((e) => (
                            <div key={e.id} className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm hover:shadow-md hover:border-brand-orange-200 transition">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <p className="font-bold text-gray-900 dark:text-white">{e.className}</p>
                                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{e.programName}</p>
                                    </div>
                                    <div className="text-right">
                                        <span className="text-sm font-bold text-brand-orange-500 dark:text-brand-neon-lime">
                                            {DAY_LABELS[e.dayOfWeek] || e.dayOfWeek}요일
                                        </span>
                                        <p className="text-xs text-gray-400">{e.startTime} ~ {e.endTime}</p>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* 이번 달 출결 기록 — 섹션 타이틀 색상 통일 */}
            {child.attendance.records.length > 0 && (
                <div>
                    {/* 헤더: 제목 + 전체 히스토리 진입 링크(선택 자녀 넘김) */}
                    <div className="mb-3 flex items-center justify-between px-1">
                        <h2 className="font-bold text-brand-navy-900">이번 달 출결 기록</h2>
                        <Link
                            href={`/mypage/history?child=${child.id}`}
                            className="text-xs font-bold text-brand-orange-500 hover:underline dark:text-brand-neon-lime"
                        >
                            전체 보기
                        </Link>
                    </div>
                    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm overflow-hidden">
                        <div className="divide-y divide-gray-50">
                            {child.attendance.records.map((r, i) => (
                                <div key={i} className="flex items-center justify-between px-4 py-3">
                                    <span className="text-sm text-gray-700 dark:text-gray-200">{toDateStr(r.date)}</span>
                                    <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${
                                        r.status === "PRESENT" ? "bg-green-100 text-green-700" :
                                        r.status === "ABSENT" ? "bg-red-100 text-red-700" :
                                        "bg-yellow-100 text-yellow-700"
                                    }`}>
                                        {r.status === "PRESENT" ? "출석" : r.status === "ABSENT" ? "결석" : "지각"}
                                    </span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {/* 최근 수납 내역 — 섹션 타이틀 색상 통일 */}
            {child.payments.length > 0 && (
                <div>
                    {/* 헤더: 제목 + 전체 히스토리 진입 링크(선택 자녀 넘김) */}
                    <div className="mb-3 flex items-center justify-between px-1">
                        <h2 className="font-bold text-brand-navy-900 dark:text-white">최근 수납 내역</h2>
                        <Link
                            href={`/mypage/history?child=${child.id}`}
                            className="text-xs font-bold text-brand-orange-500 hover:underline dark:text-brand-neon-lime"
                        >
                            전체 보기
                        </Link>
                    </div>
                    <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm overflow-hidden">
                        <div className="divide-y divide-gray-50">
                            {child.payments.map((p) => {
                                const statusInfo = PAYMENT_STATUS[p.status] || PAYMENT_STATUS.PENDING;
                                const canPay = Boolean(p.invoiceId) && (p.status === "PENDING" || p.status === "OVERDUE");
                                return (
                                    <div key={p.id} className="px-4 py-3">
                                        <div className="flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-sm font-bold text-gray-900 dark:text-white">{p.description || (p.type ? TYPE_LABELS[p.type] : null) || "수강료"}</p>
                                                <p className="mt-0.5 text-sm font-medium text-gray-900 dark:text-white">{formatAmount(p.amount)}</p>
                                                <p className="text-xs text-gray-400">기한: {toDateStr(p.dueDate)}</p>
                                                {p.invoiceNo && (
                                                    <p className="mt-1 text-[11px] font-bold text-brand-orange-500 dark:text-brand-neon-lime">
                                                        {p.invoiceNo}
                                                    </p>
                                                )}
                                            </div>
                                            <div className="shrink-0 text-right">
                                                <span className={`whitespace-nowrap text-xs font-bold px-2.5 py-1 rounded-full ${statusInfo.color}`}>
                                                    {statusInfo.label}
                                                </span>
                                                {p.paidDate && (
                                                    <p className="text-xs text-gray-400 mt-1">{toDateStr(p.paidDate)} 납부</p>
                                                )}
                                            </div>
                                        </div>
                                        <div className="mt-3 flex flex-wrap justify-end gap-2">
                                            {canPay && (
                                                <Link
                                                    href={`/payments/${p.invoiceId}`}
                                                    className="rounded-full bg-brand-orange-500 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                                                >
                                                    납부하기
                                                </Link>
                                            )}
                                            {p.invoiceId && !canPay && (
                                                <Link
                                                    href={`/payments/${p.invoiceId}`}
                                                    className="rounded-full border border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                                                >
                                                    청구서 보기
                                                </Link>
                                            )}
                                            {p.receiptUrl && (
                                                <a
                                                    href={p.receiptUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="rounded-full border border-green-200 px-3 py-1.5 text-xs font-bold text-green-700 transition hover:bg-green-50 dark:border-green-500/30 dark:text-green-200 dark:hover:bg-green-500/10"
                                                >
                                                    영수증
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {/* No data state */}
            {child.enrollments.length === 0 && child.payments.length === 0 && child.attendance.total === 0 && (
                <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 transition-colors duration-300 p-12 text-center text-gray-400 shadow-sm">
                    <SymbolIcon name="event_available" size={48} className="mx-auto mb-3 text-gray-300" />
                    <p className="font-medium">아직 수강/출결/수납 데이터가 없습니다.</p>
                    <p className="text-sm mt-1">학원에서 반 배정 후 데이터가 표시됩니다.</p>
                </div>
            )}

            {/* 공지사항 섹션 */}
            {notices.length > 0 && (
                <div>
                    <div className="flex items-center justify-between mb-3 px-1">
                        <h2 className="font-bold text-brand-navy-900 flex items-center gap-2">
                            <SymbolIcon name="notifications" size={18} className="text-brand-orange-500 dark:text-brand-neon-lime" /> 공지사항
                        </h2>
                        {/* 공개 홈페이지의 공지 목록. 설치된 앱에서 나가면 돌아올 길이 없어 감춘다.
                            아래 최근 5건은 그대로 보이므로 앱에서도 공지를 못 보는 일은 없다. */}
                        <HideInInstalledApp>
                            <Link href="/notices" className="text-xs text-brand-orange-500 dark:text-brand-neon-lime hover:underline">전체보기</Link>
                        </HideInInstalledApp>
                    </div>
                    <div className="space-y-2">
                        {notices.slice(0, 5).map(n => (
                            <Link key={n.id} href={`/notices/${n.id}`}
                                className="block bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm hover:shadow-md hover:border-brand-orange-200 transition">
                                <div className="flex items-center justify-between">
                                    <div className="flex-1 min-w-0">
                                        <p className="font-bold text-sm text-gray-900 dark:text-white truncate">{n.title}</p>
                                        <p className="text-xs text-gray-400 mt-0.5 line-clamp-1">{n.content}</p>
                                    </div>
                                    <span className="text-xs text-gray-400 flex-shrink-0 ml-3">
                                        {new Date(n.createdAt).toLocaleDateString("ko-KR")}
                                    </span>
                                </div>
                            </Link>
                        ))}
                    </div>
                </div>
            )}

            {/* 수업 리포트 바로가기 — 코치가 발행한 일일 수업 리포트 열람 */}
            <Link
                href="/mypage/reports"
                className="block bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm hover:shadow-md hover:border-brand-orange-200 transition mb-4"
            >
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-2xl text-brand-orange-500 dark:text-brand-neon-lime">assignment</span>
                        <div>
                            <p className="font-bold text-brand-navy-900">수업 리포트</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">코치가 작성한 수업 리포트를 확인하세요</p>
                        </div>
                    </div>
                    <span className="material-symbols-outlined text-gray-300">chevron_right</span>
                </div>
            </Link>


            {/* 결석 미리 알리기 허브 — 결석 경로 혼동을 없애기 위한 단일 진입점.
                방학특강·정규 둘 다 구조화 신고이고, 신고하면 그날 셔틀에서 자동으로 빠진다.
                (예전에는 정규가 '학원에 요청하기'로 들어오는 수기 처리였다) */}
            <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm mb-4">
                <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-xl text-brand-orange-500 dark:text-brand-neon-lime">event_busy</span>
                    <p className="font-bold text-brand-navy-900">결석 미리 알리기</p>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">수업 종류에 따라 알리는 방법이 달라요. 아래에서 맞는 곳을 선택하세요.</p>

                {/* 경로 ① 방학특강 — 구조화 신고(셔틀 자동제외) */}
                <Link
                    href="/mypage/seasonal"
                    className="block rounded-xl border border-gray-100 dark:border-gray-700 p-3 mb-2 hover:border-brand-orange-200 dark:hover:border-brand-neon-lime transition"
                >
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-2xl text-brand-orange-500 dark:text-brand-neon-lime">sports_basketball</span>
                            <div>
                                <p className="font-bold text-brand-navy-900">방학특강 결석 신고 · 보강</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">사전 신고하면 그날 셔틀 배차에서 자동 제외돼요. 결석한 회차 보강 신청도 여기서.</p>
                            </div>
                        </div>
                        <span className="material-symbols-outlined text-gray-300">chevron_right</span>
                    </div>
                </Link>

                {/* 경로 ② 정규수업 — 구조화 사전 결석 신고(다가오는 수업일·사유 선택) */}
                <Link
                    href="/mypage/regular-absence"
                    className="block rounded-xl border border-gray-100 dark:border-gray-700 p-3 hover:border-brand-orange-200 dark:hover:border-brand-neon-lime transition"
                >
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-2xl text-gray-400 dark:text-gray-300">edit_calendar</span>
                            <div>
                                <p className="font-bold text-brand-navy-900">정규수업 결석 신고</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">다가오는 수업 날짜를 골라 사유와 함께 미리 신고해요. 그날 셔틀에서도 자동으로 빠집니다.</p>
                            </div>
                        </div>
                        <span className="material-symbols-outlined text-gray-300">chevron_right</span>
                    </div>
                </Link>

                {/* 경로 ③ 보강 예약 — 결석으로 받은 보강권을 학부모가 직접 다른 반에 넣는다. */}
                <Link
                    href="/mypage/makeup"
                    className="block rounded-xl border border-gray-100 dark:border-gray-700 p-3 hover:border-brand-orange-200 dark:hover:border-brand-neon-lime transition"
                >
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <span className="material-symbols-outlined text-2xl text-gray-400 dark:text-gray-300">event_repeat</span>
                            <div>
                                <p className="font-bold text-brand-navy-900">보강 예약</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">결석하면 보강권이 생겨요. 학년이 맞는 다른 수업을 골라 직접 예약하세요. (결석일로부터 2개월 이내)</p>
                            </div>
                        </div>
                        <span className="material-symbols-outlined text-gray-300">chevron_right</span>
                    </div>
                </Link>
            </div>

            {/* 셔틀 당일 변경 — 수업은 오지만 셔틀만 바꾸는 경우. 결석과 별개다. */}
            <Link href="/mypage/shuttle" className="block mb-4">
                <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-2xl text-brand-orange-500 dark:text-brand-neon-lime">directions_bus</span>
                        <div>
                            <p className="font-bold text-brand-navy-900">셔틀 당일 변경</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">오늘만 안 타거나 다른 곳에서 탈 때. 기사님 화면에 바로 뜹니다.</p>
                        </div>
                    </div>
                    <span className="material-symbols-outlined text-gray-300">chevron_right</span>
                </div>
            </Link>

            {/* 청구서·영수증 — 입금해도 원장이 확인하기 전까지 "미납"으로 보여 문의가 오던 자리. */}
            <Link href="/mypage/payments" className="block mb-4">
                <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-2xl text-brand-orange-500 dark:text-brand-neon-lime">receipt_long</span>
                        <div>
                            <p className="font-bold text-brand-navy-900">청구서와 영수증</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">입금 확인 요청, 영수증 요청을 여기서 하세요.</p>
                        </div>
                    </div>
                    <span className="material-symbols-outlined text-gray-300">chevron_right</span>
                </div>
            </Link>

            {/* 수강 변경 신청 — 예전에는 "학원에 요청하기" 메모로 받아 사람이 손으로 처리했다.
                이제 신청하면 원장 승인 후 적용일에 실제로 반이 바뀐다. */}
            <Link href="/mypage/enrollment-change" className="block mb-4">
                <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <span className="material-symbols-outlined text-2xl text-brand-orange-500 dark:text-brand-neon-lime">swap_horiz</span>
                        <div>
                            <p className="font-bold text-brand-navy-900">수강 변경 신청</p>
                            <p className="text-xs text-gray-500 dark:text-gray-400">반·요일 변경, 휴원, 퇴원을 신청해요. 다음 달 1일부터 적용됩니다.</p>
                        </div>
                    </div>
                    <span className="material-symbols-outlined text-gray-300">chevron_right</span>
                </div>
            </Link>

            {/* 학습 피드백 섹션 - 코치가 작성한 자녀 피드백 표시 */}
            {feedbacks.length > 0 && (
                <div id="mypage-feedback" className="scroll-mt-4">
                    <div className="flex items-center justify-between mb-3 px-1">
                        <h2 className="font-bold text-brand-navy-900 flex items-center gap-2">
                            <SymbolIcon name="star" size={18} className="text-brand-orange-500 dark:text-brand-neon-lime" /> 학습 피드백
                        </h2>
                    </div>
                    <div className="space-y-2">
                        {feedbacks.map(fb => {
                            // 카테고리 정보 (없으면 '종합'으로 표시)
                            const cat = FB_CATEGORIES[fb.category] || FB_CATEGORIES.GENERAL;
                            // 이 카드가 펼쳐져 있는지 확인
                            const isExpanded = expandedFbId === fb.id;
                            return (
                                <div
                                    key={fb.id}
                                    onClick={() => setExpandedFbId(isExpanded ? null : fb.id)}
                                    className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm hover:shadow-md hover:border-brand-orange-200 transition cursor-pointer"
                                >
                                    {/* 상단: 학생이름, 코치이름, 날짜 */}
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-bold text-gray-900 dark:text-white">{fb.studentName}</span>
                                            {fb.coachName && (
                                                <span className="text-xs text-gray-400">| {fb.coachName} 코치</span>
                                            )}
                                        </div>
                                        <span className="text-xs text-gray-400">
                                            {fb.sessionDate
                                                ? new Date(fb.sessionDate).toLocaleDateString("ko-KR")
                                                : new Date(fb.createdAt).toLocaleDateString("ko-KR")}
                                        </span>
                                    </div>
                                    {/* 카테고리 뱃지 + 제목 + 별점 */}
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${cat.color}`}>
                                            {cat.label}
                                        </span>
                                        <span className="text-sm font-medium text-gray-800 dark:text-gray-100 flex-1 truncate">{fb.title}</span>
                                        {/* 별점 표시 (1~5) */}
                                        {fb.rating != null && fb.rating > 0 && (
                                            <span className="text-yellow-500 text-sm flex-shrink-0">
                                                {"★".repeat(fb.rating)}{"☆".repeat(5 - fb.rating)}
                                            </span>
                                        )}
                                    </div>
                                    {/* 카드 클릭 시 내용 펼치기 */}
                                    {isExpanded && (
                                        <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                                            <p className="text-sm text-gray-700 dark:text-gray-200 whitespace-pre-wrap">{fb.content}</p>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* 갤러리 섹션 */}
            {gallery.length > 0 && (
                <div>
                    <div className="flex items-center justify-between mb-3 px-1">
                        <h2 className="font-bold text-brand-navy-900 flex items-center gap-2">
                            <SymbolIcon name="image" size={18} className="text-brand-orange-500 dark:text-brand-neon-lime" /> 수업 사진
                        </h2>
                        <HideInInstalledApp>
                            <Link href="/gallery" className="text-xs text-brand-orange-500 dark:text-brand-neon-lime hover:underline">전체보기</Link>
                        </HideInInstalledApp>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                        {gallery.slice(0, 6).map(g => {
                            let media: { url: string; type: string }[] = [];
                            try { media = JSON.parse(g.mediaJSON); } catch {}
                            const first = media[0];
                            if (!first) return null;
                            return (
                                // 사진 자체가 내용이라 감추지 않는다. 설치된 앱에서는 이동만 막는다.
                                <AppSafeLink key={g.id} href="/gallery"
                                    className="aspect-square rounded-xl overflow-hidden bg-gray-100 dark:bg-gray-800 relative group">
                                    {first.type === "image" ? (
                                        <img src={first.url} alt={g.title || ""} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
                                    ) : (
                                        <video src={first.url} className="w-full h-full object-cover" muted />
                                    )}
                                </AppSafeLink>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}

// VAPID 공개키를 Uint8Array로 변환 (Web Push API에 필요)
function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}
