"use client";

import ChildConnectionNotice from "@/components/account/ChildConnectionNotice";

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
import { formatKstDate } from "@/lib/datetime/kst";

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
        canCheckout?: boolean;
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

// 서버(UTC) 첫 렌더와 휴대폰(KST) 렌더가 같은 글자를 내도록 날짜는 모두 KST 로 고정한다.
// (timeZone 없는 toLocaleDateString 은 서버에서 하루 전 날짜가 나와 하이드레이션 불일치 #418 이 난다)
export function formatShuttleDate(value: string | null): string {
    if (!value) return "운행일 확인 중";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    // 읽을 수 없는 모양이면 예전처럼 원문을 그대로 보인다(fallback = value).
    return formatKstDate(value, { year: "numeric", month: "long", day: "numeric", weekday: "short" }, value);
}

/** 알림·요청 시각 "10월 31일 AM 12:05" — 예전 모양 그대로, KST 기준. */
export function formatAlertTime(value: Date | string): string {
    return formatKstDate(value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 공지·피드백 날짜 "2026. 10. 31." — 예전 모양 그대로, KST 기준. */
export function formatShortDate(value: Date | string): string {
    return formatKstDate(value);
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
    // 요약에 표시할 항목이 하나라도 있는지(전부 없으면 카드 자체를 숨긴다).
    const hasSummary = Boolean(nextClass) || todayShuttles.length > 0;

    // 링크로 접힌 영역에 진입해도 내용을 바로 찾을 수 있게 한다.
    useEffect(() => {
        const revealHash = () => {
            const id = window.location.hash.slice(1);
            if (id) scrollToSection(id);
        };
        revealHash();
        window.addEventListener("hashchange", revealHash);
        return () => window.removeEventListener("hashchange", revealHash);
    }, []);

    return (
        <div className="space-y-4">
            <ChildConnectionNotice />
            {/* 전경과 배경(M-06): 이름 + 다음 수업 + 오늘 셔틀을 히어로 한 덩어리로. 예전엔 «오늘과 다음 일정» 칸이 따로 있어
                같은 자녀 정보가 두 판으로 갈라져 보였다. 줄 내용·누르면 가는 곳은 그대로다. */}
            <section aria-labelledby="parent-child-heading" className="academy-hero p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <p className="mb-1 text-xs font-bold text-[var(--color-academy-primary)]">우리 아이의 농구 생활</p>
                        <h1 id="parent-child-heading" className="academy-heading text-2xl font-extrabold">{child.name} 학생</h1>
                        <p className="mt-2 text-sm leading-relaxed text-[var(--color-academy-muted)]">
                            {child.enrollments.length > 0 ? `수강 중인 반 ${child.enrollments.length}개` : "수강 중인 반이 없습니다"}
                        </p>
                    </div>
                </div>
                {data.children.length > 1 && (
                    <div role="group" aria-label="자녀 선택" className="mt-3 flex flex-wrap gap-2">
                        {data.children.map((c, i) => (
                            <button
                                key={c.id}
                                type="button"
                                aria-pressed={selectedIdx === i}
                                onClick={() => setSelectedIdx(i)}
                                // 고른 자녀 = academy-choice(연한 바탕+체크). 꽉 찬 색은 제출·납부 버튼 몫(M-07)
                                className="academy-choice"
                            >
                                {c.name}
                            </button>
                        ))}
                    </div>
                )}
                {/* 오늘/다음 일정 — 값이 있을 때만, 전부 없으면 줄 자체를 숨긴다(표시 전용) */}
                {hasSummary && (
                    <div role="group" aria-label="오늘과 다음 일정" className="mt-3 space-y-1.5">
                        {/* 1) 다음 수업 */}
                        {nextClass && (
                            <button
                                type="button"
                                onClick={() => scrollToSection("mypage-enrollments")}
                                className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 min-h-11 rounded-xl bg-[var(--color-academy-surface)] px-3 py-2 text-left transition hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="flex items-center gap-2.5">
                                    <SymbolIcon name="event" size={18} className="text-brand-navy-900 dark:text-gray-200" />
                                    <span className="text-sm font-medium text-gray-500 dark:text-gray-400">다음 수업</span>
                                </span>
                                <span className="min-w-0 text-right text-sm font-bold text-gray-900 dark:text-white">
                                    {nextClassWhenLabel(nextClass, kstNow)} {nextClass.startTime}
                                    <span className="ml-1 break-words font-normal text-gray-500 dark:text-gray-400">· {nextClass.className}</span>
                                </span>
                            </button>
                        )}

                        {/* 2) 오늘 셔틀 */}
                        {todayShuttles.length > 0 && (
                            <button
                                type="button"
                                onClick={() => scrollToSection("mypage-shuttle")}
                                className="flex w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 min-h-11 rounded-xl bg-[var(--color-academy-surface)] px-3 py-2 text-left transition hover:bg-[var(--color-academy-soft)]"
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

                    </div>
                )}
            </section>

            {/* «할 일» 한 줄 — 안 읽은 알림이 있을 때만. 누르면 알림을 펼쳐 그 자리로 간다 */}
            {unreadCount > 0 && (
                <button
                    type="button"
                    onClick={() => { setShowNotifications(true); requestAnimationFrame(() => scrollToSection("mypage-notifications")); }}
                    className="flex min-h-11 w-full items-center gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-left text-sm font-bold text-[var(--color-academy-ink)] hover:border-[var(--color-academy-primary)]"
                >
                    <SymbolIcon name="checklist" size={18} className="shrink-0 text-[var(--color-academy-primary)]" />
                    <span className="shrink-0">할 일</span>
                    <span className="min-w-0 flex-1 text-[var(--color-academy-muted)]">안 읽은 알림 <span className="tabular-nums">{unreadCount}</span>건</span>
                    <SymbolIcon name="chevron_right" size={18} className="shrink-0 text-[var(--color-academy-muted)]" />
                </button>
            )}

            <nav aria-label="자주 하는 요청" className="academy-panel p-4">
                <h2 className="mb-3 text-sm font-bold text-[var(--color-academy-ink)]">자주 하는 요청</h2>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {[
                        { href: "#parent-absence-hub", icon: "event_busy", label: "결석·보강" },
                        { href: "/mypage/shuttle", icon: "airport_shuttle", label: "셔틀 당일 변경" },
                        { href: "/mypage/payments", icon: "receipt_long", label: "청구·수납" },
                        { href: "/mypage/enrollment-change", icon: "swap_horiz", label: "수강 변경" },
                        { href: "/mypage/reports", icon: "assignment", label: "수업 리포트" },
                    ].map((item) => (
                        <Link key={item.href} href={item.href}
                            onClick={item.href.startsWith("#") ? () => scrollToSection(item.href.slice(1)) : undefined}
                            className="flex min-h-11 items-center gap-2 rounded-xl bg-[var(--color-academy-canvas)] px-3 py-2 text-sm font-bold text-[var(--color-academy-ink)] transition-colors hover:bg-[var(--color-academy-primary-soft)]">
                            <SymbolIcon name={item.icon} size={19} className="shrink-0 text-[var(--color-academy-primary)]" />
                            <span className="break-keep">{item.label}</span>
                        </Link>
                    ))}
                </div>
            </nav>

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
                            {p.invoiceId && p.canCheckout !== false && (
                                <Link
                                    href={`/payments/${p.invoiceId}`}
                                    className="mt-4 flex min-h-12 w-full items-center justify-center rounded-xl bg-brand-orange-500 px-4 text-sm font-black text-white transition hover:bg-orange-600 dark:bg-brand-neon-lime dark:text-brand-navy-900"
                                >
                                    청구서 확인하고 납부하기
                                </Link>
                            )}
                            {p.invoiceId && p.canCheckout === false && <p className="mt-3 text-xs text-[var(--color-academy-muted)]">온라인 결제는 대표 보호자 계정에서 진행해 주세요.</p>}
                        </div>
                    ))}
                </div>
            )}

            {/* 알림 토글 버튼 — 호버 시 그림자 강화 (디자인 토큰 통일). id = «할 일» 줄이 데려오는 자리 */}
            <div id="mypage-notifications" className="scroll-mt-4">
                <button
                    aria-expanded={showNotifications}
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
                        {/* 상단 바: 전체 읽음만(44px). 푸시 설정은 목록과 떨어진 맨 아래 설정 줄로 옮겼다(M-11) */}
                        {unreadCount > 0 && (
                            <div className="px-4 py-1 border-b border-[var(--color-academy-line)] flex items-center justify-end">
                                <button
                                    onClick={() => startTransition(() => markAllNotificationsRead(data.parent.id))}
                                    disabled={isPending}
                                    className="academy-button-text text-[var(--color-academy-primary)]"
                                >
                                    <SymbolIcon name="done_all" size={16} /> 모두 읽음
                                </button>
                            </div>
                        )}

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
                                                {formatAlertTime(n.createdAt)}
                                            </p>
                                        </div>

                                        {/* 읽음 처리 버튼 */}
                                        {!n.isRead && (
                                            <button
                                                onClick={() => startTransition(() => markNotificationRead(n.id))}
                                                disabled={isPending}
                                                // 누르는 영역 44×44 — 알림 글 옆 작은 체크라 잘못 누르기 쉬웠다(M-11)
                                                className="-my-2 -mr-2 inline-flex size-11 flex-shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                                                title="읽음 처리"
                                                aria-label="읽음 처리"
                                            >
                                                <SymbolIcon name="check" size={18} />
                                            </button>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}
                        {/* 설정 줄 — 알림 목록과 구분선으로 떼어 «읽음»과 헷갈리지 않게(M-11). 동작(togglePush)은 그대로 */}
                        {pushSupported && (
                            <div className="flex items-center justify-between gap-3 border-t border-[var(--color-academy-line)] px-4 py-1.5">
                                <span className="text-sm font-bold text-[var(--color-academy-muted)]">푸시 알림</span>
                                <button
                                    onClick={togglePush}
                                    disabled={pushLoading}
                                    className={`inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-xs font-bold transition ${
                                        pushEnabled
                                            ? "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]"
                                            : "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-primary-soft)] hover:text-[var(--color-academy-primary)]"
                                    }`}
                                >
                                    {pushLoading ? "..." : pushEnabled ? (
                                        <><SymbolIcon name="notifications_active" size={13} /> 푸시 ON</>
                                    ) : (
                                        <><SymbolIcon name="notifications_off" size={13} /> 푸시 OFF</>
                                    )}
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </div>

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
                                    // 보조 버튼(테두리) — 홈의 꽉 찬 색은 납부·제출 몫(M-07)
                                    className="academy-button-secondary mt-3"
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
                <details id="mypage-shuttle" className="academy-panel scroll-mt-24">
                    <summary className="cursor-pointer p-4 text-sm font-bold text-[var(--color-academy-ink)]">셔틀 배정 상세 <span className="ml-2 font-normal text-[var(--color-academy-muted)]">{child.name} · {childShuttleOverview.length}건</span></summary>
                    <div className="border-t border-[var(--color-academy-line)] p-4">
                    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                        <div>
                            <div className="flex items-center gap-2">
                                <SymbolIcon name="airport_shuttle" size={20} className="text-blue-600 dark:text-blue-300" />
                                <h2 id="parent-shuttle-heading" className="font-bold text-gray-900 dark:text-white">셔틀 안내</h2>
                            </div>
                            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{child.name} 학생의 신청 및 배정 현황입니다.</p>
                        </div>
                        <div className="flex flex-wrap items-stretch gap-2">
                            {shuttleDriverContact?.phone && (
                                <a
                                    href={`tel:${shuttleDriverContact.phone.replace(/[^0-9]/g, "")}`}
                                    // 보조 버튼(테두리, M-07). 키보드 초점 링은 유지
                                    className="academy-button-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-academy-primary)] focus-visible:ring-offset-2"
                                    aria-label={`셔틀 기사님 ${shuttleDriverContact.name}에게 전화하기`}
                                >
                                    <SymbolIcon name="call" size={16} className="text-[var(--color-academy-success)]" />
                                    기사님께 연락 ({shuttleDriverContact.name})
                                </a>
                            )}
                            <Link href="/mypage/shuttle"
                                className="flex min-h-11 items-center justify-center rounded-xl border border-[var(--color-academy-line)] px-3 py-2 text-xs font-bold text-[var(--color-academy-primary)]">
                                셔틀 당일 변경
                            </Link>
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
                    </div>
                </details>
            )}

            {/* 학원에 메시지 보내기 */}
            <div>
                <div className="flex flex-wrap gap-2">
                    <button
                        onClick={() => { setShowRequestForm(!showRequestForm); setShowRequests(false); }}
                        // 여는 버튼 = 보조(테두리). 꽉 찬 색은 폼 안 «메시지 보내기»만(M-07)
                        className="academy-button-secondary flex-1 basis-44 whitespace-nowrap"
                    >
                        <SymbolIcon name="send" size={16} /> 학원에 메시지 보내기
                    </button>
                    <button
                        onClick={() => { setShowRequests(!showRequests); setShowRequestForm(false); }}
                        className="academy-button-secondary shrink-0 whitespace-nowrap"
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

                <p className="mt-2 text-xs text-[var(--color-academy-muted)]">보낸 메시지와 처리 상태는 자녀 전체 기준입니다. 결석·셔틀·수강 변경은 위 전용 메뉴를 이용해 주세요.</p>

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
                                                {formatAlertTime(r.createdAt)}
                                            </p>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>

            <details id="mypage-records" className="academy-panel scroll-mt-24">
                <summary className="cursor-pointer p-4 text-sm font-bold text-[var(--color-academy-ink)]">수강·출결·수납 기록 <span className="ml-2 font-normal text-[var(--color-academy-muted)]">{child.name}</span></summary>
                <div className="space-y-5 border-t border-[var(--color-academy-line)] p-4">
            {/* 수강 중인 반 — 카드 호버 효과 추가 (디자인 토큰 통일) */}
            {child.enrollments.length > 0 && (
                <div id="mypage-enrollments" className="scroll-mt-24">
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

            <p className="text-xs text-[var(--color-academy-muted)]">이번 달 출석 {child.attendance.present} / {child.attendance.total}회 · 결석 {child.attendance.absent}회 · 지각 {child.attendance.late}회</p>
            {/* 이번 달 출결 기록 */}
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
                                const canPay = p.canCheckout !== false && Boolean(p.invoiceId) && (p.status === "PENDING" || p.status === "OVERDUE");
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
                                            {p.invoiceId && p.canCheckout !== false && !canPay && (
                                                <Link
                                                    href={`/payments/${p.invoiceId}`}
                                                    className="rounded-full border border-gray-200 px-3 py-1.5 text-xs font-bold text-gray-600 transition hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900"
                                                >
                                                    청구서 보기
                                                </Link>
                                            )}
                                            {p.invoiceId && p.canCheckout === false && <p className="w-full text-xs text-[var(--color-academy-muted)]">온라인 결제는 대표 보호자 계정에서 진행해 주세요.</p>}
                                            {p.receiptUrl && p.canCheckout !== false && (
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
                <div className="py-3 text-sm text-[var(--color-academy-muted)]">
                    <p className="font-medium">아직 수강/출결/수납 데이터가 없습니다.</p>
                    <p className="text-sm mt-1">학원에서 반 배정 후 데이터가 표시됩니다.</p>
                </div>
            )}

                </div>
            </details>

            {/* 공지사항 섹션 */}
            {notices.length > 0 && (
                <div>
                    <div className="flex items-center justify-between mb-3 px-1">
                        <h2 className="font-bold text-brand-navy-900 flex items-center gap-2">
                            <SymbolIcon name="notifications" size={18} className="text-brand-orange-500 dark:text-brand-neon-lime" /> 학원 공지사항
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
                                        {formatShortDate(n.createdAt)}
                                    </span>
                                </div>
                            </Link>
                        ))}
                    </div>
                </div>
            )}

            {/* 결석 미리 알리기 허브 — 결석 경로 혼동을 없애기 위한 단일 진입점.
                방학특강·정규 둘 다 구조화 신고이고, 신고하면 그날 셔틀에서 자동으로 빠진다.
                (예전에는 정규가 '학원에 요청하기'로 들어오는 수기 처리였다) */}
            <details id="parent-absence-hub" className="academy-panel scroll-mt-24">
                <summary className="cursor-pointer p-4 text-sm font-bold text-[var(--color-academy-ink)]">결석·보강 신청 <span className="ml-2 font-normal text-[var(--color-academy-muted)]">수업 종류 선택</span></summary>
                <div className="border-t border-[var(--color-academy-line)] p-4">
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
                                <p className="break-keep font-bold text-brand-navy-900">방학특강 결석 신고 · 보강</p>
                                <p className="text-xs text-gray-500 dark:text-gray-400">신고한 결석은 선생님과 기사님에게 표시됩니다. 보강도 신청할 수 있습니다.</p>
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
                                <p className="text-xs text-gray-500 dark:text-gray-400">날짜와 사유를 골라 신고하세요. 신고한 결석은 선생님과 기사님에게 표시됩니다.</p>
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
            </details>

            {/* 학습 피드백 섹션 - 코치가 작성한 자녀 피드백 표시 */}
            {feedbacks.length > 0 && (
                <details id="mypage-feedback" className="academy-panel scroll-mt-24">
                    <summary className="cursor-pointer p-4 text-sm font-bold text-[var(--color-academy-ink)]">학습 피드백 <span className="ml-2 font-normal text-[var(--color-academy-muted)]">자녀 전체 · {feedbacks.length}건</span></summary>
                    <div className="border-t border-[var(--color-academy-line)] p-4">
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
                                                ? formatShortDate(fb.sessionDate)
                                                : formatShortDate(fb.createdAt)}
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
                </details>
            )}

            {/* 갤러리 섹션 */}
            {gallery.length > 0 && (
                <div>
                    <div className="flex items-center justify-between mb-3 px-1">
                        <h2 className="font-bold text-brand-navy-900 flex items-center gap-2">
                            <SymbolIcon name="image" size={18} className="text-brand-orange-500 dark:text-brand-neon-lime" /> 수업 사진 · 자녀 전체
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

// 접힌 기록·신청 영역으로 이동할 때 먼저 열어야 화면에서 내용을 찾을 수 있다.
function scrollToSection(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
    let ancestor: HTMLElement | null = target;
    while (ancestor) {
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
        ancestor = ancestor.parentElement;
    }
    requestAnimationFrame(() => target.scrollIntoView({ behavior: "smooth", block: "start" }));
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
