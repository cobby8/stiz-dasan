"use client";

import ChildConnectionNotice from "@/components/account/ChildConnectionNotice";

import { useState, useTransition, useEffect } from "react";
import Link from "next/link";
import type { PublicVirtualAccountView } from "@/lib/payments/virtualAccount";
import VirtualAccountNotice from "@/components/parent/VirtualAccountNotice";
import { createParentRequest } from "@/app/actions/admin";
import { useRememberedChild } from "./useRememberedChild";
import type { ParentShuttleOverviewItem } from "@/lib/shuttle/parent";
import type { PendingSeasonalChild } from "@/lib/seasonal/pendingSeasonalChildren";
// "오늘/이번주 우리 아이" 요약 + «오늘 할 일» 집계용 순수 로직(표시 전용, 기존 데이터 재조합).
import {
    getKstNow, getKstDateStr, computeNextClass, nextClassWhenLabel, filterTodayShuttle,
    summarizePendingPayments, countRecentNotices, legacyHomeHashTarget,
} from "@/lib/mypage/summary";
import { formatKstDate } from "@/lib/datetime/kst";
import type { ParentClassStatusLine } from "@/lib/enrollment/parent-change-request";
// «최신 수업 피드» 카드 — 고른 아이의 최신 공개 수업 1건(2026-11-14)
import LatestFeedCard from "@/components/parent/LatestFeedCard";
import { pickFeedCard, type FeedCandidate } from "@/lib/feed/rules";
// 프로필 사진(2026-11-15) — 히어로 이름 왼쪽 64px · 자녀 칩 28px
import ProfileAvatar from "@/components/common/ProfileAvatar";
import { profilePhotoUrl } from "@/lib/profilePhoto/rules";

// ─────────────────────────────────────────────────────────────────────────────
// 학부모 홈 = «오늘 할 일» 판 (2026-11-09 원장 결정 D1 안 A)
//  위에서부터: ① 납부할 청구 한 줄(꽉 찬 버튼은 이것 하나) ② 아이 이름 + 다음 수업 + 오늘 셔틀
//            ③ 처리할 일 줄들(보강권·학원 답변·방학특강·새 공지 — 알림은 머리줄 🔔) ④ 빠른 실행 4개(결석·보강·셔틀 변경·문의)
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

type ChildData = {
    id: string;
    name: string;
    birthDate: Date | string;
    gender: string | null;
    /** 프로필 사진 캐시 버전(사진 없으면 null → 이름 첫 글자) */
    photoVersion?: string | null;
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
    // 복귀 예정 반(휴원 중 + 복귀 승인·반영 전, 2026-11-14) — «다음 수업»을 복귀일 이후 수업으로 잡는 데만 쓴다(수강 중 목록 아님)
    resumingEnrollments?: {
        id: string;
        classId: string;
        className: string;
        dayOfWeek: string;
        startTime: string;
        endTime: string;
        programName: string;
        startsOn?: string | null;
        resumeFrom: string;
        /** 화면용 «11/16»(서버가 만들어 준다) */
        resumeFromLabel: string;
    }[];
    // 일정 계산용 목록 = 수강 중인 반 + 복귀 예정 반(개시일 자리에 복귀일). 서버(getMyPageData)가 만들어 준다
    scheduleEnrollments?: { className: string; dayOfWeek: string; startTime: string; endTime: string; startsOn?: string | null }[];
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

/** 보낸 문의 건수(답변 옴·답변 대기) — «보낸 문의» 줄 오른쪽 글자용. 목록·대화는 /mypage/requests 화면이 그린다 */
type InquiryCounts = { answered: number; waiting: number };

type MyPageData = {
    parent: { id: string; name: string; email: string; phone: string | null };
    children: ChildData[];
};

// 요청 유형(결석·셔틀·조퇴·기타) 선택은 없앴다. 유형별로 나눠 받으면 그 유형대로
// 처리되는 것처럼 보이는데, 실제로는 전부 사람이 읽고 손으로 처리하는 메모였다.
// 결석처럼 진짜 기능이 있는 것은 그 기능으로 보내고, 나머지는 자유 메시지 하나로 받는다.
// 서버는 type 을 계속 받으므로(다른 경로 호환) 여기서는 항상 "OTHER" 로 보낸다.


/** 알림·요청 시각 "10월 31일 AM 12:05" — 예전 모양 그대로, KST 기준. */
export function formatAlertTime(value: Date | string): string {
    return formatKstDate(value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 공지·피드백 날짜 "2026. 10. 31." — 예전 모양 그대로, KST 기준. */
export function formatShortDate(value: Date | string): string {
    return formatKstDate(value);
}

// «처리할 일» 한 줄 — 왼쪽 제목, 오른쪽 숫자/설명, 끝에 «›». 터치 44px.
const TODO_ROW = "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-academy-soft)]";

export default function MyPageClient({ data, notices = [], inquiryCounts = { answered: 0, waiting: 0 }, parentShuttleOverview = [], shuttleDriverContact = null, pendingSeasonalChildren = [], makeupAvailable = 0, seasonalUpcoming = 0, pendingPayments = null, classStatusLines = [], initialChildId, recordLines, feedCandidates = [] }: {
    data: MyPageData;
    notices?: NoticeItem[];
    /** 보낸 문의 중 «답변 옴»·«답변 대기» 건수(보낸 문의 화면과 같은 판정) */
    inquiryCounts?: InquiryCounts;
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
    /** 반 상태 한 줄(휴원 예정·검토 중·휴원 중) — 그냥 다니는 반은 없다 */
    classStatusLines?: ParentClassStatusLine[];
    /** 주소 ?child= 로 서버가 고른 아이(내 자녀일 때만). 없으면 첫째 */
    initialChildId?: string;
    /** 아이별 «다닌 지 n년 n개월 · 올해 출석 n%» 한 줄(아이 기록 화면 진입) — 조회 실패면 «전체 기록» */
    recordLines?: Record<string, string>;
    /** 아이마다 최신 공개 수업 후보 — 고른 아이 것 1건만 카드로(없으면 카드 숨김) */
    feedCandidates?: FeedCandidate[];
}) {
    // 아이 선택 — 주소(?child=)·기기 기억으로 마지막 선택 유지(다른 화면 갔다 뒤로 와도 그 아이)
    const childIds = data.children.map((c) => c.id);
    const [selectedChildId, selectChild] = useRememberedChild(childIds, initialChildId ?? childIds[0] ?? "");
    const selectedIdx = Math.max(0, childIds.indexOf(selectedChildId));
    const setSelectedIdx = (i: number) => { const id = childIds[i]; if (id) selectChild(id); };
    const [showRequestForm, setShowRequestForm] = useState(false);
    const [isPending, startTransition] = useTransition();
    // 요청 폼 상태
    const [reqContent, setReqContent] = useState("");
    const [reqDate, setReqDate] = useState("");
    // 보내기 결과 안내 — 실패해도 화면 전체가 오류로 바뀌지 않고 그 자리에 한 줄 안내 + 쓴 글은 그대로 둔다(d1)
    const [reqError, setReqError] = useState("");
    const [reqSent, setReqSent] = useState(false);
    const child = data.children[selectedIdx];
    const childShuttleOverview = parentShuttleOverview.filter((item) => item.studentId === child.id);

    // ── ① 납부할 청구 — 자녀 전체 합계 한 줄(예전엔 건마다 빨간 카드가 쌓여 «주인공»이 여러 개였다) ──
    // 2026-11-09: 청구 탭과 같은 목록으로 센다(getMyPageData 는 자녀별 최근 5건이라 오래된 미납이 빠졌다)
    const payList: PendingPaymentLite[] = pendingPayments ?? data.children.flatMap((c) => c.payments);
    const paySummary = summarizePendingPayments([{ payments: payList }]);
    // 버튼 이름(«한 번에 결제»/«결제하기»)은 내가 대표 보호자로 결제할 수 있는 건 수로 정한다(합계 표시는 전체 그대로)
    const payableCount = summarizePendingPayments([{ payments: payList.filter((p) => p.canCheckout !== false) }]).count;
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
    // 복귀 예정 반은 복귀일 당일부터 수업이 있는 반으로 넣는다(개시일 자리에 복귀일 — computeNextClass 가 그 전 주차를 건너뛴다)
    const resumingEnrollments = child.resumingEnrollments ?? [];
    const nextClass = computeNextClass(child.scheduleEnrollments ?? child.enrollments, kstNow, todayStr);
    const todayShuttles = filterTodayShuttle(childShuttleOverview, todayStr);
    // 고른 아이의 반 상태 한 줄(휴원 예정 · 12/1부터 등). 눌러서 수강 변경 화면(결과·사유)으로.
    const childStatusLines = classStatusLines.filter((line) => line.studentId === child.id);
    const hasSummary = Boolean(nextClass) || todayShuttles.length > 0 || childStatusLines.length > 0;
    // 이름 아래 한 줄 — «다음 수업» 줄이 보이면 반 개수는 겹치는 말이라 뺀다(복귀 예정 수만 남긴다).
    // 전부 복귀 예정인 아이는 «수강 중인 반이 없습니다» 대신 복귀 예정을 말한다(2026-11-14)
    const heroEnrollLine = currentEnrollments.length > 0
        ? nextClass
            ? (resumingEnrollments.length > 0 ? `복귀 예정 ${resumingEnrollments.length}개` : "")
            : `수강 중인 반 ${currentEnrollments.length}개${resumingEnrollments.length > 0 ? ` · 복귀 예정 ${resumingEnrollments.length}개` : ""}`
        : resumingEnrollments.length > 0
            ? `복귀 예정인 반 ${resumingEnrollments.length}개 · ${[...resumingEnrollments].sort((a, b) => a.resumeFrom.localeCompare(b.resumeFrom))[0].resumeFromLabel}부터`
            : "수강 중인 반이 없습니다";
    // 오늘 셔틀 줄의 «등원 08:40»·«하원 17:30» — 확정 시각이 있는 것만
    const todayPickup = todayShuttles.map((s) => s.pickupEtaLabel).find(Boolean);
    const todayDropoff = todayShuttles.map((s) => s.dropoffEtaLabel).find(Boolean);
    const todayShuttleLines = [todayPickup ? `등원 ${todayPickup}` : null, todayDropoff ? `하원 ${todayDropoff}` : null].filter((v): v is string => Boolean(v));
    // 다음 수업·오늘 셔틀을 누르면 «일정» 탭의 그 칸으로(홈 아래 접힌 칸으로 뛰지 않는다)
    const scheduleHref = `/mypage/history?child=${encodeURIComponent(child.id)}`;

    // ── ③ 처리할 일 ──
    const newNoticeCount = countRecentNotices(notices, now.getTime());
    // 알림 줄이 머리줄 🔔 로 옮겨 가(2026-11-10) 처리할 일이 하나도 없을 수 있다 → 빈 칸 대신 한 줄 안내
    // «보낸 문의»는 처리할 일에서 빼고 빠른 실행 아래 «늘 보이는 줄»로 옮겼다(2026-11-14 c3 — 끝난 문의도 다시 볼 수 있게)
    const hasTodo = makeupAvailable > 0 || seasonalUpcoming > 0 || newNoticeCount > 0;

    // ── ④ 빠른 실행 «결석 알리기» — 정규 반이 없고 방학특강만 다니면 바로 방학특강 결석으로 ──
    // 복귀 예정 반도 정규 반이다(복귀일 이후 수업은 결석 신고를 받는다)
    const hasRegularClass = data.children.some((c) => c.enrollments.length > 0 || (c.resumingEnrollments ?? []).length > 0);
    const absenceHref = !hasRegularClass && seasonalUpcoming > 0 ? "/mypage/seasonal" : "/mypage/regular-absence";

    // 주소에 #칸 이름이 붙어 오면 그 자리로 간다(옛 홈 칸 주소는 옮겨 간 탭으로).
    // «#mypage-notifications»(옛 알림 칸)는 머리줄 종(ParentNotificationBell)이 받아 알림 패널을 연다(2026-11-10).
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
            // 다른 화면의 «학원에 문의» 버튼(/mypage#parent-request-form)으로 오면 메시지 폼을 펴서 보인다
            // (폼은 접혀 있으면 화면에 없어서, 펴지 않으면 갈 자리가 없다)
            if (id === "parent-request-form") setShowRequestForm(true);
            requestAnimationFrame(() => scrollToSection(id));
        };
        revealHash();
        window.addEventListener("hashchange", revealHash);
        return () => window.removeEventListener("hashchange", revealHash);
    }, []);

    // 메시지 폼이 «펴진 뒤»에 그 자리로 간다 — 폼은 펴져야 화면에 생기므로, 펴는 것과 같은 순간에 찾으면 아직 없다.
    // (주소가 #parent-request-form 일 때만. 홈에서 «문의»를 직접 누른 경우는 openRequestForm 이 맡는다)
    useEffect(() => {
        if (showRequestForm && window.location.hash === "#parent-request-form") scrollToSection("parent-request-form");
    }, [showRequestForm]);

    function openRequestForm() {
        setShowRequestForm((v) => !v);
        setReqSent(false);
        setReqError("");
        requestAnimationFrame(() => scrollToSection("parent-request-form"));
    }

    return (
        <div className="space-y-3">
            <ChildConnectionNotice />

            {/* ① 납부할 청구 한 줄 — 홈의 유일한 꽉 찬 버튼(교과서 2장 전경/배경: 주인공은 하나) */}
            {paySummary.count > 0 && (
                <section id="mypage-payment-alert" aria-label="납부할 청구" className="academy-panel scroll-mt-4 p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <p className="min-w-0 flex-1 break-keep text-sm font-semibold text-[var(--color-academy-ink)]">
                            납부할 청구 <span className="tabular-nums">{paySummary.count}</span>건
                            <span className="mx-1 text-[var(--color-academy-muted)]">·</span>
                            <span className="whitespace-nowrap tabular-nums">합계 {formatAmount(paySummary.total)}</span>
                        </p>
                        {/* 결제 담당 보호자 = «한 번에 결제» 화면으로(1건이면 «결제하기»). 연결 가족은 결제 대신 청구 목록 */}
                        <Link href={paySummary.canCheckoutAny ? PAYMENT_HOME_HREF : PAYMENT_LIST_HREF} className="academy-button-primary shrink-0">
                            {!paySummary.canCheckoutAny ? "청구 보기" : payableCount > 1 ? "한 번에 결제" : "결제하기"}
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
                <div className="flex items-center gap-3">
                    {/* 아이 사진(64px) — 이름 + 아래 한 줄 높이 안에 들어가 히어로가 커지지 않는다. 사진이 없으면 이름 첫 글자 */}
                    <ProfileAvatar decorative name={child.name} size={64} src={profilePhotoUrl({ kind: "student", id: child.id }, child.photoVersion, true)} />
                    <div className="min-w-0 flex-1">
                        <h1 id="parent-child-heading" className="academy-heading">{child.name} 학생</h1>
                        {/* 아이 사진이 아직 없으면 사진 칸(아이 기록 → 아이 정보)으로 바로 가는 글자 버튼(2026-11-14).
                            설정의 «내 사진»에 아이 사진을 올리는 헷갈림이 실제로 있었다 */}
                        {!child.photoVersion && (
                            <Link
                                href={`/mypage/record?child=${encodeURIComponent(child.id)}#record-info`}
                                className="academy-button-text min-h-11! -my-2 inline-flex items-center"
                            >
                                아이 사진 올리기
                            </Link>
                        )}
                        {/* 2026-11-14 문구 정리: 바로 아래 «다음 수업» 줄이 있으면 «수강 중인 반 N개»는 같은 말이라 뺀다.
                            복귀 예정·개시일처럼 아래 줄에 없는 내용만 남기고, 남길 말이 없으면 줄째 그리지 않는다. */}
                        {(heroEnrollLine || startsLaterEnrollment) && (
                            <p className="mt-1 text-sm leading-relaxed text-[var(--color-academy-muted)]">
                                {heroEnrollLine}
                                {/* 첫 수업 전인 반이 있으면 개시일만 덧붙인다(상태는 수강 중) */}
                                {startsLaterEnrollment && <span className={heroEnrollLine ? "ml-2" : undefined}>{formatKstDate(startsLaterEnrollment.startsOn, { month: "long", day: "numeric" })}부터 수업 시작</span>}
                            </p>
                        )}
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
                                {/* 칩 사진 28px — 칩 높이(44px) 안이라 줄이 커지지 않는다 */}
                                <ProfileAvatar decorative name={c.name} size={28} src={profilePhotoUrl({ kind: "student", id: c.id }, c.photoVersion, true)} />
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
                                // 좁은 휴대폰(360px)에서 «요일 시간 · 반 이름»이 줄을 넘던 문제 — 라벨·시간은 한 줄 고정,
                                // 반 이름은 시간 아래 작은 글씨로 내린다(말줄임 없음)
                                className="flex w-full items-center justify-between gap-2 min-h-11 rounded-xl bg-[var(--color-academy-surface)] px-3 py-1.5 text-left transition hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="flex shrink-0 items-center gap-2">
                                    <span className="whitespace-nowrap text-sm font-medium text-[var(--color-academy-muted)]">다음 수업</span>
                                </span>
                                <span className="min-w-0 text-right">
                                    <span className="block whitespace-nowrap text-sm font-semibold tabular-nums text-[var(--color-academy-ink)]">{nextClassWhenLabel(nextClass, kstNow)} {nextClass.startTime}</span>
                                    <span className="block break-keep text-xs text-[var(--color-academy-muted)]">{nextClass.className}</span>
                                </span>
                            </Link>
                        )}

                        {/* 1-2) 반 상태 한 줄 — 휴원 예정·검토 중·휴원 중(원장 승인 결과가 홈에서 바로 보이게, 2026-11-10) */}
                        {childStatusLines.map((line) => (
                            <Link
                                key={line.enrollmentId}
                                href="/mypage/enrollment-change"
                                className="flex w-full items-center justify-between gap-2 min-h-11 rounded-xl bg-[var(--color-academy-surface)] px-3 py-1.5 text-left transition hover:bg-[var(--color-academy-soft)]"
                            >
                                <span className="flex min-w-0 items-center gap-2">
                                    <span className="break-keep text-sm font-medium text-[var(--color-academy-muted)]">{line.className}</span>
                                </span>
                                <span className={`break-keep text-right text-sm font-semibold ${line.tone === "warning" ? "text-[var(--color-academy-warning)]" : "text-[var(--color-academy-ink)]"}`}>{line.text}</span>
                            </Link>
                        ))}

                        {/* 2) 오늘 셔틀 → 일정 탭의 셔틀 배정. 기사님 전화는 같은 줄 끝(예전엔 접힌 칸 안에 숨어 있었다) */}
                        {todayShuttles.length > 0 && (
                            <div className="flex items-stretch gap-1.5">
                                <Link
                                    href={`${scheduleHref}#mypage-shuttle`}
                                    className="flex min-w-0 flex-1 items-center justify-between gap-2 min-h-11 rounded-xl bg-[var(--color-academy-surface)] px-3 py-1.5 text-left transition hover:bg-[var(--color-academy-soft)]"
                                >
                                    <span className="flex shrink-0 items-center gap-2">
                                        <span className="whitespace-nowrap text-sm font-medium text-[var(--color-academy-muted)]">오늘 셔틀</span>
                                    </span>
                                    <span className="text-right text-sm font-semibold tabular-nums text-[var(--color-academy-ink)]">
                                        {/* 확정 승·하차 시각이 있으면 한 줄씩(한 줄에 둘이면 좁은 폭에서 전화 버튼 옆으로 넘친다), 없으면 운행 건수 */}
                                        {todayShuttleLines.length === 0
                                            ? `운행 ${todayShuttles.length}건`
                                            : todayShuttleLines.map((line) => <span key={line} className="block whitespace-nowrap">{line}</span>)}
                                    </span>
                                </Link>
                                {shuttleDriverContact?.phone && (
                                    <a
                                        href={`tel:${shuttleDriverContact.phone.replace(/[^0-9]/g, "")}`}
                                        aria-label={`셔틀 기사님 ${shuttleDriverContact.name}에게 전화하기`}
                                        // 전화 버튼 — 보조 버튼(흰 바탕·입력선 테두리). 2026-11-13 UI 통일: 전화 아이콘 → «전화» 글자(44px 유지). 키보드 초점 링 유지
                                        className="academy-button-secondary shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-academy-primary)]"
                                    >
                                        전화
                                    </a>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </section>

            {/* ②-1 아이 기록 한 줄(2026-11-14 원장 결정 w1) — 다닌 기간·올해 출석률. 누르면 «아이 기록» 화면 */}
            <Link
                href={`/mypage/record?child=${encodeURIComponent(child.id)}`}
                className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl bg-[var(--color-academy-surface)] px-3 py-1.5 text-sm ring-1 ring-inset ring-[var(--color-academy-line)] transition hover:bg-[var(--color-academy-soft)]"
            >
                <span className="min-w-0 break-keep tabular-nums text-[var(--color-academy-ink)]"><b className="font-bold">우리 아이 기록</b>{recordLines?.[child.id] && recordLines[child.id] !== "전체 기록" ? <span className="text-[var(--color-academy-muted)]"> · {recordLines[child.id]}</span> : null}</span>
                <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">▸</span>
            </Link>

            {/* ③ 처리할 일 — 해야 할 일이 있는 줄만 보인다. 알림·설정은 머리줄의 «알림»·«설정»으로 옮겼다.
                할 일이 0건이면 칸째 그리지 않는다(2026-11-14 원장 결정 d7 — «처리할 일이 없어요» 한 줄을 위해 칸을 두지 않는다) */}
            {hasTodo && (
            <section aria-labelledby="parent-todo-heading" className="academy-panel overflow-hidden">
                <h2 id="parent-todo-heading" className="academy-section-title border-b border-[var(--color-academy-line)] px-3 py-2">처리할 일</h2>
                <ul className="divide-y divide-[var(--color-academy-line)]">
                    {makeupAvailable > 0 && (
                        <li>
                            <Link href="/mypage/makeup" className={TODO_ROW}>
                                <span className="min-w-0 flex-1 font-medium text-[var(--color-academy-ink)]">보강 예약</span>
                                <span className="shrink-0 text-[var(--color-academy-muted)]">보강권 <span className="tabular-nums">{makeupAvailable}</span>장</span>
                                <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                            </Link>
                        </li>
                    )}
                    {seasonalUpcoming > 0 && (
                        <li>
                            <Link href="/mypage/seasonal" className={TODO_ROW}>
                                <span className="min-w-0 flex-1 font-medium text-[var(--color-academy-ink)]">방학특강 결석·보강</span>
                                <span className="shrink-0 text-[var(--color-academy-muted)]">남은 <span className="tabular-nums">{seasonalUpcoming}</span>회</span>
                                <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                            </Link>
                        </li>
                    )}
                    {newNoticeCount > 0 && (
                        <li>
                            <Link href="/mypage/reports#news-notices" className={TODO_ROW}>
                                <span className="min-w-0 flex-1 font-medium text-[var(--color-academy-ink)]">새 공지</span>
                                <span className="shrink-0 text-[var(--color-academy-muted)]"><span className="tabular-nums">{newNoticeCount}</span>건</span>
                                <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                            </Link>
                        </li>
                    )}
                </ul>
            </section>
            )}

            {/* 최신 수업 피드 — «처리할 일» 바로 아래, 고른 아이의 최신 공개 수업 1건. 없으면 칸을 그리지 않는다 */}
            {(() => {
                const feedCard = pickFeedCard(feedCandidates, selectedChildId);
                return feedCard ? <LatestFeedCard card={feedCard} /> : null;
            })()}

            {/* 방학특강 신청 자녀(전환 대기중) — 정식 학생으로 아직 전환되지 않아
                위 판에 안 뜨는 자녀를 따로 안내한다. 목록이 비면 통째로 숨김. */}
            {pendingSeasonalChildren.length > 0 && (
                <section aria-labelledby="pending-seasonal-heading" className="rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-warning-soft)] p-4 shadow-sm">
                    <div className="mb-3">
                        <h2 id="pending-seasonal-heading" className="academy-section-title">방학특강 신청 자녀</h2>
                    </div>
                    <div className="space-y-2">
                        {pendingSeasonalChildren.map((c, idx) => (
                            <div key={`${c.childName}-${idx}`} className="rounded-xl border border-[var(--color-academy-line)] bg-white p-3">
                                <div className="flex items-center justify-between gap-2">
                                    <div className="font-semibold text-[var(--color-academy-ink)]">
                                        {c.childName}
                                        {c.childGrade && (
                                            <span className="ml-2 text-xs font-normal text-[var(--color-academy-muted)]">{c.childGrade}</span>
                                        )}
                                    </div>
                                    {c.upcomingCount > 0 && (
                                        <span className="shrink-0 rounded-full bg-[var(--color-academy-warning-soft)] px-2.5 py-1 text-xs tabular-nums text-[var(--color-academy-warning)]">
                                            예정 {c.upcomingCount}회
                                        </span>
                                    )}
                                </div>
                                {c.offeringTitles.length > 0 && (
                                    <p className="mt-1 text-sm text-[var(--color-academy-muted)]">
                                        <span className="text-[var(--color-academy-muted)]">신청 특강: </span>
                                        {c.offeringTitles.join(", ")}
                                    </p>
                                )}
                                {/* 위 «처리할 일»에 같은 목적지(/mypage/seasonal) 줄이 이미 보이면 버튼은 그리지 않는다 — 같은 길 하나만 */}
                                {seasonalUpcoming <= 0 && (
                                    <Link
                                        href="/mypage/seasonal"
                                        // 보조 버튼(테두리) — 홈의 꽉 찬 색은 납부 몫(M-07)
                                        className="academy-button-secondary mt-2"
                                    >
                                        방학특강 결석·보강
                                    </Link>
                                )}
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* ④ 빠른 실행 4개 — 한 줄. 화면 이동만(접힌 칸으로 뛰지 않는다). «문의»만 이 자리에서 폼을 연다 */}
            <nav aria-label="빠른 실행" className="grid grid-cols-4 gap-2">
                {[
                    { href: absenceHref, label: "결석 알리기" },
                    { href: "/mypage/makeup", label: "보강 예약" },
                    { href: "/mypage/shuttle", label: "셔틀 변경" },
                ].map((item) => (
                    <Link key={item.label} href={item.href}
                        className="flex min-h-12 items-center justify-center rounded-md border border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] px-1 py-2 text-sm font-medium text-[var(--color-academy-ink)] transition-colors hover:border-[var(--color-academy-primary)] hover:bg-[var(--color-academy-soft)]">
                        <span className="break-keep text-center leading-tight">{item.label}</span>
                    </Link>
                ))}
                <button
                    type="button"
                    aria-expanded={showRequestForm}
                    onClick={openRequestForm}
                    // 열려 있는 동안 = «지금 고른 것» → 보조 색(하늘색) 바탕·테두리·글자(주 색은 주 버튼 몫)
                    className={`flex min-h-12 items-center justify-center rounded-md border px-1 py-2 text-sm transition-colors ${
                        showRequestForm
                            ? "border-[var(--color-academy-secondary-strong)] bg-[var(--color-academy-secondary-soft)] font-semibold text-[var(--color-academy-secondary-ink)]"
                            : "border-[var(--color-academy-line-input)] bg-[var(--color-academy-surface)] font-medium text-[var(--color-academy-ink)] hover:border-[var(--color-academy-primary)] hover:bg-[var(--color-academy-soft)]"
                    }`}
                >
                    <span className="break-keep text-center leading-tight">문의</span>
                </button>
            </nav>

            {/* 늘 보이는 한 줄 행 — 보낸 문의(끝난 문의도 다시 보고 이어 쓴다, c3) · 신청(유니폼·대관·방학특강으로 가는 길, c9). 2026-11-14 */}
            <ul aria-label="더 보기" className="academy-panel divide-y divide-[var(--color-academy-line)] overflow-hidden">
                <li>
                    <Link href="/mypage/requests" className={TODO_ROW}>
                        <span className="min-w-0 flex-1 font-medium text-[var(--color-academy-ink)]">보낸 문의</span>
                        {(inquiryCounts.answered > 0 || inquiryCounts.waiting > 0) && (
                            <span className="shrink-0 text-[var(--color-academy-muted)]">
                                {inquiryCounts.answered > 0 ? <>답변 옴 <span className="tabular-nums">{inquiryCounts.answered}</span>건</> : <>답변 대기 <span className="tabular-nums">{inquiryCounts.waiting}</span>건</>}
                            </span>
                        )}
                        <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                    </Link>
                </li>
                <li>
                    {/* 신청 메뉴 화면(/mypage/apply) — 세 가지 신청을 앱 안에서 연다(공개 홈페이지로 나가지 않는다) */}
                    <Link href="/mypage/apply" className={TODO_ROW}>
                        <span className="min-w-0 flex-1 font-medium text-[var(--color-academy-ink)]">신청</span>
                        <span className="shrink-0 text-[var(--color-academy-muted)]">유니폼 · 대관 · 방학특강</span>
                        <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
                    </Link>
                </li>
            </ul>

            {/* 학원에 메시지 보내기 — «문의»를 누르면 열린다 */}
            {showRequestForm && (
                <div id="parent-request-form" className="scroll-mt-4 bg-white border border-[var(--color-academy-line)] rounded-2xl p-4 shadow-sm space-y-3">
                    <div className="flex items-center justify-between gap-2">
                        <h3 className="academy-section-title">학원에 메시지 보내기</h3>
                        <Link href="/mypage/requests" className="academy-button-text">보낸 문의</Link>
                    </div>

                    {/* 유형 선택을 없앤 이유: 유형별로 나눠 받으면 학원이 그 유형대로 처리해 줄 것처럼
                        보이는데, 실제로는 전부 사람이 읽고 손으로 처리하는 메모였다. 결석처럼 진짜
                        기능이 있는 것은 그 기능으로 보내고, 나머지는 자유 메시지 하나로 받는다. */}
                    <div className="rounded-xl bg-[var(--color-academy-warning-soft)] border border-[var(--color-academy-line)] px-3 py-2 text-xs text-[var(--color-academy-warning)] leading-relaxed">
                        결석·셔틀은 위 버튼으로 알려 주세요
                    </div>

                    {/* 자녀 선택 (여러 명일 때) */}
                    {data.children.length > 1 && (
                        <div>
                            <label className="text-xs font-medium text-[var(--color-academy-muted)] mb-1 block">자녀 선택</label>
                            <select
                                value={selectedIdx}
                                onChange={e => setSelectedIdx(Number(e.target.value))}
                                className="academy-input"
                            >
                                {data.children.map((c, i) => (
                                    <option key={c.id} value={i}>{c.name}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* 날짜 */}
                    <div>
                        <label className="text-xs font-medium text-[var(--color-academy-muted)] mb-1 block">
                            날짜 (선택)
                        </label>
                        <input type="date" min="2020-01-01" max="2030-12-31" value={reqDate} onChange={e => setReqDate(e.target.value)}
                            className="academy-input" />
                    </div>

                    {/* 내용 */}
                    <div>
                        <label className="text-xs font-medium text-[var(--color-academy-muted)] mb-1 block">메시지</label>
                        <textarea
                            value={reqContent}
                            onChange={e => setReqContent(e.target.value)}
                            placeholder="문의하실 내용을 편하게 적어주세요"
                            rows={4}
                            // 서버 한도(createParentRequest 2,000자)와 같게 — 넘겨 쓰고 보냈다가 거절되는 일이 없게
                            maxLength={2000}
                            className="academy-input resize-none"
                        />
                        {/* 글자 수는 한도(2,000자)에 가까워질 때만(1,800자 초과) 보인다 — 평소엔 필요 없는 숫자 */}
                        {reqContent.length > 1800 && (
                            <p className="mt-0.5 text-right text-xs tabular-nums text-[var(--color-academy-faint)]" aria-live="polite">{reqContent.length.toLocaleString("ko-KR")} / 2,000자</p>
                        )}
                    </div>

                    {/* 제출 */}
                    <button
                        disabled={isPending || !reqContent.trim()}
                        onClick={() => {
                            const dateLabel = reqDate ? ` (${reqDate})` : "";
                            setReqError("");
                            startTransition(async () => {
                                try {
                                    await createParentRequest({
                                        userId: data.parent.id,
                                        studentId: child.id,
                                        // 유형을 나누지 않는다. 전부 사람이 읽고 처리하는 자유 메시지다.
                                        type: "OTHER",
                                        title: `${child.name} 문의${dateLabel}`,
                                        content: reqContent,
                                        date: reqDate || null,
                                    });
                                } catch {
                                    // 통신 끊김·서버 오류 — 쓴 글은 지우지 않고 그 자리에서 다시 누르게 한다
                                    setReqError("보내지 못했습니다. 다시 시도해 주세요.");
                                    return;
                                }
                                setReqContent("");
                                setReqDate("");
                                setShowRequestForm(false);
                                setReqSent(true);
                            });
                        }}
                        className="academy-button-primary w-full"
                    >
                        {isPending ? "보내는 중..." : "메시지 보내기"}
                    </button>
                    {reqError && (
                        <p role="alert" className="text-xs font-semibold text-[var(--color-academy-danger)]">{reqError}</p>
                    )}
                </div>
            )}

            {/* 보낸 뒤 안내 — 폼이 닫혀도 «보냈다»는 걸 알 수 있게 */}
            {reqSent && !showRequestForm && (
                <div role="status" className="flex items-center justify-between gap-2 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-success-soft)] px-3 py-2 text-xs font-medium text-[var(--color-academy-success)]">
                    <span className="min-w-0 break-keep">보냈어요. 답변은 <Link href="/mypage/requests" className="underline">보낸 문의</Link>에서 볼 수 있어요</span>
                    <button type="button" onClick={() => setReqSent(false)} className="academy-button-text shrink-0" aria-label="안내 닫기">닫기</button>
                </div>
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
