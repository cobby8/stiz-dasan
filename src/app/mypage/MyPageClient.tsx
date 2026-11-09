"use client";

import ChildConnectionNotice from "@/components/account/ChildConnectionNotice";

import { useState, useTransition, useEffect } from "react";
import Link from "next/link";
import type { PublicVirtualAccountView } from "@/lib/payments/virtualAccount";
import VirtualAccountNotice from "@/components/parent/VirtualAccountNotice";
import { markNotificationRead, markAllNotificationsRead, createParentRequest } from "@/app/actions/admin";
import type { ParentShuttleOverviewItem } from "@/lib/shuttle/parent";
import type { PendingSeasonalChild } from "@/lib/seasonal/pendingSeasonalChildren";
// "오늘/이번주 우리 아이" 요약 + «오늘 할 일» 집계용 순수 로직(표시 전용, 기존 데이터 재조합).
import {
    getKstNow, getKstDateStr, computeNextClass, nextClassWhenLabel, filterTodayShuttle,
    summarizePendingPayments, countRecentAnswers, countRecentNotices, legacyHomeHashTarget,
} from "@/lib/mypage/summary";
import { formatKstDate } from "@/lib/datetime/kst";

// ─────────────────────────────────────────────────────────────────────────────
// 학부모 홈 = «오늘 할 일» 판 (2026-11-09 원장 결정 D1 안 A)
//  위에서부터: ① 납부할 청구 한 줄(꽉 찬 버튼은 이것 하나) ② 아이 이름 + 다음 수업 + 오늘 셔틀
//            ③ 처리할 일 줄들(보강권·학원 답변·방학특강·새 공지·알림) ④ 빠른 실행 4개(결석·보강·셔틀 변경·문의)
//  예전 홈에 있던 접힌 칸 5개(셔틀 배정·수강/출결/수납 기록·결석·보강 신청·학습 피드백·알림)는
//  «일정»·«소식» 탭과 «처리할 일» 줄로 옮겼다. 홈 타일을 누르면 맨 아래로 뛰던 동작도 없앴다.
// ─────────────────────────────────────────────────────────────────────────────

// 홈 청구 줄 버튼의 목적지 = «한 번에 결제»(묶음 결제, 2026-11-09). 결제 담당(대표) 보호자가 아니면 청구 탭으로.
const PAYMENT_HOME_HREF = "/mypage/payments/checkout";
const PAYMENT_LIST_HREF = "/mypage/payments";

/** 홈 «납부할 청구» 줄이 세는 미납 청구 1건 — 청구 탭과 같은 목록(getParentPaymentRequests)에서 온다 */
type PendingPaymentLite = {
    id: string;
    amount: number;
    status: string;
    canCheckout?: boolean;
    virtualAccount?: PublicVirtualAccountView | null;
};

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
        status?: string;
        displayStatus?: string;
        startsOn?: string | null;
        startsLater?: boolean;
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
        /** 무통장입금 계좌(입금 대기·만료). 대표 보호자에게만 온다. */
        virtualAccount?: PublicVirtualAccountView | null;
        invoiceNo?: string | null;
        invoiceStatus?: string | null;
        invoiceCheckoutUrl?: string | null;
    }[];
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

/** 알림·요청 시각 "10월 31일 AM 12:05" — 예전 모양 그대로, KST 기준. */
export function formatAlertTime(value: Date | string): string {
    return formatKstDate(value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 공지·피드백 날짜 "2026. 10. 31." — 예전 모양 그대로, KST 기준. */
export function formatShortDate(value: Date | string): string {
    return formatKstDate(value);
}

// «처리할 일» 한 줄 — 왼쪽 아이콘·제목, 오른쪽 숫자/설명, 끝에 화살표. 터치 44px.
const TODO_ROW = "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-academy-soft)]";

export default function MyPageClient({ data, notices = [], notifications = [], unreadCount = 0, myRequests = [], parentShuttleOverview = [], shuttleDriverContact = null, pendingSeasonalChildren = [], makeupAvailable = 0, seasonalUpcoming = 0, pendingPayments = null }: {
    data: MyPageData;
    notices?: NoticeItem[];
    notifications?: NotificationItem[];
    unreadCount?: number;
    myRequests?: RequestItem[];
    parentShuttleOverview?: ParentShuttleOverviewItem[];
    shuttleDriverContact?: { name: string; phone: string } | null;
    // 방학특강만 신청하고 아직 정식 학생으로 전환되지 않은 자녀(별도 칸에 표시)
    pendingSeasonalChildren?: PendingSeasonalChild[];
    /** 지금 쓸 수 있는 보강권 수(자녀 전체) — 0 이면 줄을 숨긴다 */
    makeupAvailable?: number;
    /** 앞으로 남은 방학특강 회차 수 — 방학 기간에만 0 보다 크다(원장 결정 D6) */
    seasonalUpcoming?: number;
    /** 청구 탭과 같은 기준의 미납 청구(자녀 전체). 없으면(조회 실패) 자녀별 최근 내역으로 센다 */
    pendingPayments?: PendingPaymentLite[] | null;
}) {
    const [selectedIdx, setSelectedIdx] = useState(0);
    const [showNotifications, setShowNotifications] = useState(false);
    const [showRequestForm, setShowRequestForm] = useState(false);
    const [showRequests, setShowRequests] = useState(false);
    const [isPending, startTransition] = useTransition();
    // 요청 폼 상태
    const [reqContent, setReqContent] = useState("");
    const [reqDate, setReqDate] = useState("");
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

    // ── ① 납부할 청구 — 자녀 전체 합계 한 줄(예전엔 건마다 빨간 카드가 쌓여 «주인공»이 여러 개였다) ──
    // 2026-11-09: 청구 탭과 같은 목록으로 센다(getMyPageData 는 자녀별 최근 5건이라 오래된 미납이 빠졌다)
    const payList: PendingPaymentLite[] = pendingPayments ?? data.children.flatMap((c) => c.payments);
    const paySummary = summarizePendingPayments([{ payments: payList }]);
    // 무통장입금 계좌를 받아 둔 미납 청구 — 계좌번호를 홈에서 바로 볼 수 있게 남긴다.
    // 묶음 결제 계좌는 여러 청구가 같은 계좌를 품는다 → 계좌 하나에 한 번만 보이고, 묶인 청구 수를 적는다.
    const waitingAccounts: { key: string; account: PublicVirtualAccountView; count: number }[] = [];
    const seenPayments = new Set<string>();
    for (const p of payList) {
        if ((p.status !== "PENDING" && p.status !== "OVERDUE") || !p.virtualAccount || seenPayments.has(p.id)) continue;
        seenPayments.add(p.id);
        const key = `${p.virtualAccount.bankName}-${p.virtualAccount.accountNumber}`;
        const found = waitingAccounts.find((entry) => entry.key === key);
        if (found) found.count += 1;
        else waitingAccounts.push({ key, account: p.virtualAccount, count: 1 });
    }

    // ── ② "오늘/이번주 우리 아이" 요약 (표시 전용, 선택 자녀 기준) ──
    // 렌더 시점의 실제 시각을 KST로 환산해 사용한다(자녀 전환 시 자동 재계산됨).
    const now = new Date();
    const kstNow = getKstNow(now);
    const todayStr = getKstDateStr(now);
    // 2026-11-09 새 기준: 승인돼 등록된 반은 개시일 전이어도 «수강 중». 개시일은 첫 수업 안내에만 쓴다
    const currentEnrollments = child.enrollments;
    const startsLaterEnrollment = child.enrollments.find((enrollment) => enrollment.startsLater && enrollment.startsOn);
    const nextClass = computeNextClass(child.enrollments, kstNow, todayStr);
    const todayShuttles = filterTodayShuttle(childShuttleOverview, todayStr);
    const hasSummary = Boolean(nextClass) || todayShuttles.length > 0;
    // 다음 수업·오늘 셔틀을 누르면 «일정» 탭의 그 칸으로(홈 아래 접힌 칸으로 뛰지 않는다)
    const scheduleHref = `/mypage/history?child=${encodeURIComponent(child.id)}`;

    // ── ③ 처리할 일 ──
    const answerCount = countRecentAnswers(myRequests, now.getTime());
    const pendingRequestCount = myRequests.filter(r => r.status === "PENDING").length;
    const newNoticeCount = countRecentNotices(notices, now.getTime());

    // ── ④ 빠른 실행 «결석 알리기» — 정규 반이 없고 방학특강만 다니면 바로 방학특강 결석으로 ──
    const hasRegularClass = data.children.some((c) => c.enrollments.length > 0);
    const absenceHref = !hasRegularClass && seasonalUpcoming > 0 ? "/mypage/seasonal" : "/mypage/regular-absence";

    // 주소에 #mypage-notifications 가 붙어 오면(«⋯» 메뉴 «알림») 알림 칸을 펼치고 그 자리로 간다.
    useEffect(() => {
        const revealHash = () => {
            const id = window.location.hash.slice(1);
            if (!id) return;
            // 옛 홈 칸 주소(#mypage-shuttle 등)는 그 칸이 옮겨 간 «일정»·«소식» 탭으로 넘긴다(뒤로가기에 빈 홈이 남지 않게 replace)
            const moved = legacyHomeHashTarget(id);
            if (moved) {
                window.location.replace(moved);
                return;
            }
            if (id === "mypage-notifications") setShowNotifications(true);
            requestAnimationFrame(() => scrollToSection(id));
        };
        revealHash();
        window.addEventListener("hashchange", revealHash);
        return () => window.removeEventListener("hashchange", revealHash);
    }, []);

    function openRequests() {
        // 보낸 메시지 목록을 펼치고 그 자리로
        setShowRequests(true);
        requestAnimationFrame(() => scrollToSection("parent-request-list"));
    }

    function openRequestForm() {
        setShowRequestForm((v) => !v);
        requestAnimationFrame(() => scrollToSection("parent-request-form"));
    }

    return (
        <div className="space-y-3">
            <ChildConnectionNotice />

            {/* ① 납부할 청구 한 줄 — 홈의 유일한 꽉 찬 버튼(교과서 2장 전경/배경: 주인공은 하나) */}
            {paySummary.count > 0 && (
                <section id="mypage-payment-alert" aria-label="납부할 청구" className="academy-panel scroll-mt-4 p-3">
                    <div className="flex items-center gap-3">
                        <SymbolIcon name="credit_card" size={22} className="shrink-0 text-[var(--color-academy-danger)]" />
                        <p className="min-w-0 flex-1 break-keep text-sm font-bold text-[var(--color-academy-ink)]">
                            납부할 청구 <span className="tabular-nums">{paySummary.count}</span>건
                            <span className="mx-1 text-[var(--color-academy-muted)]">·</span>
                            <span className="whitespace-nowrap tabular-nums">합계 {formatAmount(paySummary.total)}</span>
                        </p>
                        {/* 결제 담당 보호자 = «한 번에 결제» 화면으로(1건이면 «결제하기»). 연결 가족은 결제 대신 청구 목록 */}
                        <Link href={paySummary.canCheckoutAny ? PAYMENT_HOME_HREF : PAYMENT_LIST_HREF} className="academy-button-primary shrink-0">
                            {!paySummary.canCheckoutAny ? "청구 보기" : paySummary.count > 1 ? "한 번에 결제" : "결제하기"}
                        </Link>
                    </div>
                    {!paySummary.canCheckoutAny && (
                        <p className="mt-1 text-xs text-[var(--color-academy-muted)]">온라인 결제는 대표 보호자 계정에서 진행해 주세요.</p>
                    )}
                    {/* 무통장입금 계좌를 받아 둔 경우 — 입금 대기(계좌·복사) 또는 기한 만료 안내 */}
                    {waitingAccounts.map((entry) => (
                        <div key={entry.key} className="mt-2">
                            <VirtualAccountNotice compact account={entry.account} />
                            {entry.count > 1 && (
                                <p className="mt-1 text-xs text-[var(--color-academy-muted)]">청구 {entry.count}건을 묶은 계좌 · 합계 {formatAmount(entry.account.amount)}</p>
                            )}
                        </div>
                    ))}
                </section>
            )}

            {/* ② 전경과 배경(M-06): 이름 + 다음 수업 + 오늘 셔틀을 히어로 한 덩어리로. */}
            <section aria-labelledby="parent-child-heading" className="academy-hero p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                        <h1 id="parent-child-heading" className="academy-heading text-xl font-extrabold">{child.name} 학생</h1>
                        <p className="mt-1 text-sm leading-relaxed text-[var(--color-academy-muted)]">
                            {currentEnrollments.length > 0 ? `수강 중인 반 ${currentEnrollments.length}개` : "수강 중인 반이 없습니다"}
                            {/* 첫 수업 전인 반이 있으면 개시일만 덧붙인다(상태는 수강 중) */}
                            {startsLaterEnrollment && <span className="ml-2">{startsLaterEnrollment.startsOn}부터 수업 시작</span>}
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
                                // 고른 자녀 = academy-choice(연한 바탕+체크). 꽉 찬 색은 납부 버튼 몫(M-07)
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
                        {/* 1) 다음 수업 → 일정 탭의 수강 반 */}
                        {nextClass && (
                            <Link
                                href={`${scheduleHref}#mypage-enrollments`}
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
                            </Link>
                        )}

                        {/* 2) 오늘 셔틀 → 일정 탭의 셔틀 배정. 기사님 전화는 같은 줄 끝(예전엔 접힌 칸 안에 숨어 있었다) */}
                        {todayShuttles.length > 0 && (
                            <div className="flex items-stretch gap-1.5">
                                <Link
                                    href={`${scheduleHref}#mypage-shuttle`}
                                    className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-3 gap-y-2 min-h-11 rounded-xl bg-[var(--color-academy-surface)] px-3 py-2 text-left transition hover:bg-[var(--color-academy-soft)]"
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
                                </Link>
                                {shuttleDriverContact?.phone && (
                                    <a
                                        href={`tel:${shuttleDriverContact.phone.replace(/[^0-9]/g, "")}`}
                                        aria-label={`셔틀 기사님 ${shuttleDriverContact.name}에게 전화하기`}
                                        // 44×44 전화 버튼 — 테두리(보조). 키보드 초점 링 유지
                                        className="inline-flex min-h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-success)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-academy-primary)]"
                                    >
                                        <SymbolIcon name="call" size={18} />
                                    </a>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </section>

            {/* ③ 처리할 일 — 해야 할 일이 있는 줄만 보인다. 알림 줄은 늘 맨 끝(설정도 이 안에서) */}
            <section aria-labelledby="parent-todo-heading" className="academy-panel overflow-hidden">
                <h2 id="parent-todo-heading" className="border-b border-[var(--color-academy-line)] px-3 py-2 text-sm font-bold text-[var(--color-academy-ink)]">처리할 일</h2>
                <ul className="divide-y divide-[var(--color-academy-line)]">
                    {makeupAvailable > 0 && (
                        <li>
                            <Link href="/mypage/makeup" className={TODO_ROW}>
                                <SymbolIcon name="event_repeat" size={18} className="shrink-0 text-[var(--color-academy-primary)]" />
                                <span className="min-w-0 flex-1 font-bold text-[var(--color-academy-ink)]">보강 예약</span>
                                <span className="shrink-0 text-[var(--color-academy-muted)]">보강권 <span className="tabular-nums">{makeupAvailable}</span>장</span>
                                <SymbolIcon name="chevron_right" size={18} className="shrink-0 text-[var(--color-academy-muted)]" />
                            </Link>
                        </li>
                    )}
                    {seasonalUpcoming > 0 && (
                        <li>
                            <Link href="/mypage/seasonal" className={TODO_ROW}>
                                <SymbolIcon name="sports_basketball" size={18} className="shrink-0 text-[var(--color-academy-primary)]" />
                                <span className="min-w-0 flex-1 font-bold text-[var(--color-academy-ink)]">방학특강 결석 신고 · 보강</span>
                                <span className="shrink-0 text-[var(--color-academy-muted)]">남은 <span className="tabular-nums">{seasonalUpcoming}</span>회</span>
                                <SymbolIcon name="chevron_right" size={18} className="shrink-0 text-[var(--color-academy-muted)]" />
                            </Link>
                        </li>
                    )}
                    {(answerCount > 0 || pendingRequestCount > 0) && (
                        <li>
                            <button type="button" onClick={openRequests} className={TODO_ROW}>
                                <SymbolIcon name="forum" size={18} className="shrink-0 text-[var(--color-academy-primary)]" />
                                <span className="min-w-0 flex-1 font-bold text-[var(--color-academy-ink)]">보낸 메시지</span>
                                <span className="shrink-0 text-[var(--color-academy-muted)]">
                                    {answerCount > 0 ? <>학원 답변 <span className="tabular-nums">{answerCount}</span>건</> : <>답변 대기 <span className="tabular-nums">{pendingRequestCount}</span>건</>}
                                </span>
                                <SymbolIcon name="chevron_right" size={18} className="shrink-0 text-[var(--color-academy-muted)]" />
                            </button>
                        </li>
                    )}
                    {newNoticeCount > 0 && (
                        <li>
                            <Link href="/mypage/reports#news-notices" className={TODO_ROW}>
                                <SymbolIcon name="campaign" size={18} className="shrink-0 text-[var(--color-academy-primary)]" />
                                <span className="min-w-0 flex-1 font-bold text-[var(--color-academy-ink)]">새 공지</span>
                                <span className="shrink-0 text-[var(--color-academy-muted)]"><span className="tabular-nums">{newNoticeCount}</span>건</span>
                                <SymbolIcon name="chevron_right" size={18} className="shrink-0 text-[var(--color-academy-muted)]" />
                            </Link>
                        </li>
                    )}
                    {/* 알림 — 누르면 이 자리에서 목록을 펼친다(id = «⋯» 메뉴 «알림»이 데려오는 자리) */}
                    <li id="mypage-notifications" className="scroll-mt-20">
                        <button
                            type="button"
                            aria-expanded={showNotifications}
                            onClick={() => setShowNotifications(!showNotifications)}
                            className={TODO_ROW}
                        >
                            <SymbolIcon name="notifications" size={18} className="shrink-0 text-[var(--color-academy-primary)]" />
                            <span className="min-w-0 flex-1 font-bold text-[var(--color-academy-ink)]">알림</span>
                            <span className="shrink-0 text-[var(--color-academy-muted)]">
                                {unreadCount > 0 ? <>안 읽은 알림 <span className="tabular-nums font-bold text-[var(--color-academy-danger)]">{unreadCount}</span>건</> : "새 알림 없음"}
                            </span>
                            <SymbolIcon name={showNotifications ? "expand_less" : "expand_more"} size={18} className="shrink-0 text-[var(--color-academy-muted)]" />
                        </button>

                        {showNotifications && (
                            <div className="border-t border-[var(--color-academy-line)]">
                                {/* 상단 바: 전체 읽음만(44px). 푸시 설정은 목록과 떨어진 맨 아래 설정 줄(M-11) */}
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
                                    <div className="p-6 text-center text-gray-400 text-sm">
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
                                        <span className="text-sm font-bold text-[var(--color-academy-muted)]">휴대폰 알림</span>
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
                                                <><SymbolIcon name="notifications_active" size={13} /> 알림 켜짐</>
                                            ) : (
                                                <><SymbolIcon name="notifications_off" size={13} /> 알림 꺼짐</>
                                            )}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </li>
                </ul>
            </section>

            {/* 방학특강 신청 자녀(전환 대기중) — 정식 학생으로 아직 전환되지 않아
                위 판에 안 뜨는 자녀를 따로 안내한다. 목록이 비면 통째로 숨김. */}
            {pendingSeasonalChildren.length > 0 && (
                <section aria-labelledby="pending-seasonal-heading" className="rounded-2xl border border-amber-200 bg-amber-50/60 p-4 shadow-sm dark:border-amber-900/50 dark:bg-amber-950/20">
                    <div className="mb-3">
                        <div className="flex items-center gap-2">
                            <SymbolIcon name="hourglass_top" size={20} className="text-amber-600 dark:text-amber-300" />
                            <h2 id="pending-seasonal-heading" className="font-bold text-gray-900 dark:text-white">방학특강 신청 자녀 (전환 대기중)</h2>
                        </div>
                        <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                            정규 수강·수납 정보는 학생 등록(전환) 후 표시됩니다.
                        </p>
                    </div>
                    <div className="space-y-2">
                        {pendingSeasonalChildren.map((c, idx) => (
                            <div key={`${c.childName}-${idx}`} className="rounded-xl border border-amber-200 bg-white p-3 dark:border-amber-900/40 dark:bg-gray-800">
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
                                    <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
                                        <span className="text-gray-500 dark:text-gray-400">신청 특강: </span>
                                        {c.offeringTitles.join(", ")}
                                    </p>
                                )}
                                <Link
                                    href="/mypage/seasonal"
                                    // 보조 버튼(테두리) — 홈의 꽉 찬 색은 납부 몫(M-07)
                                    className="academy-button-secondary mt-2"
                                >
                                    방학특강 결석 신고 / 보강
                                    <SymbolIcon name="arrow_forward" size={16} />
                                </Link>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* ④ 빠른 실행 4개 — 한 줄. 화면 이동만(접힌 칸으로 뛰지 않는다). «문의»만 이 자리에서 폼을 연다 */}
            <nav aria-label="빠른 실행" className="grid grid-cols-4 gap-2">
                {[
                    { href: absenceHref, icon: "event_busy", label: "결석 알리기" },
                    { href: "/mypage/makeup", icon: "event_repeat", label: "보강 예약" },
                    { href: "/mypage/shuttle", icon: "airport_shuttle", label: "셔틀 변경" },
                ].map((item) => (
                    <Link key={item.label} href={item.href}
                        className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-1 py-2 text-xs font-bold text-[var(--color-academy-ink)] transition-colors hover:border-[var(--color-academy-primary)]">
                        <SymbolIcon name={item.icon} size={22} className="text-[var(--color-academy-primary)]" />
                        <span className="break-keep text-center">{item.label}</span>
                    </Link>
                ))}
                <button
                    type="button"
                    aria-expanded={showRequestForm}
                    onClick={openRequestForm}
                    className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2 text-xs font-bold transition-colors ${
                        showRequestForm
                            ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]"
                            : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)] hover:border-[var(--color-academy-primary)]"
                    }`}
                >
                    <SymbolIcon name="send" size={22} className="text-[var(--color-academy-primary)]" />
                    <span className="break-keep text-center">문의</span>
                </button>
            </nav>

            {/* 학원에 메시지 보내기 — «문의»를 누르면 열린다 */}
            {showRequestForm && (
                <div id="parent-request-form" className="scroll-mt-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl p-4 shadow-sm space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="font-bold text-gray-900 dark:text-white">학원에 메시지 보내기</h3>
                        <button type="button" onClick={() => (showRequests ? setShowRequests(false) : openRequests())} className="academy-button-text">
                            <SymbolIcon name="forum" size={16} />
                            보낸 메시지
                            {pendingRequestCount > 0 && (
                                <span className="bg-yellow-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full">{pendingRequestCount}</span>
                            )}
                        </button>
                    </div>

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
                        에서, 셔틀만 바꿀 때는{" "}
                        <Link href="/mypage/shuttle" className="font-bold underline">셔틀 당일 변경</Link>
                        에서 신청해 주세요.
                    </div>

                    {/* 자녀 선택 (여러 명일 때) */}
                    {data.children.length > 1 && (
                        <div>
                            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">자녀 선택</label>
                            <select
                                value={selectedIdx}
                                onChange={e => setSelectedIdx(Number(e.target.value))}
                                className="w-full min-h-11 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm"
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
                            className="w-full min-h-11 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 text-sm" />
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
                        className="academy-button-primary w-full"
                    >
                        {isPending ? "보내는 중..." : "메시지 보내기"}
                    </button>
                    <p className="text-xs text-[var(--color-academy-muted)]">보낸 메시지와 처리 상태는 자녀 전체 기준입니다.</p>
                </div>
            )}

            {/* 보낸 메시지 — «처리할 일»의 «보낸 메시지» 줄이나 폼 위 «보낸 메시지»로 연다 */}
            {showRequests && (
                <section id="parent-request-list" aria-label="보낸 메시지" className="scroll-mt-4 bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-800 rounded-2xl shadow-sm overflow-hidden">
                    <div className="flex items-center justify-between border-b border-[var(--color-academy-line)] px-4 py-1">
                        <h3 className="text-sm font-bold text-[var(--color-academy-ink)]">보낸 메시지</h3>
                        <button type="button" onClick={() => setShowRequests(false)} className="academy-button-text">닫기</button>
                    </div>
                    {myRequests.length === 0 ? (
                        <div className="p-6 text-center text-gray-400 text-sm">보낸 메시지가 없습니다</div>
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
                </section>
            )}
        </div>
    );
}

// 펼친 칸으로 화면을 옮긴다(예전엔 접힌 칸 details 를 강제로 여는 일도 했지만 접힌 칸은 없앴다).
function scrollToSection(id: string) {
    const target = document.getElementById(id);
    if (!target) return;
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
