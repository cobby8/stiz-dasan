"use client";

import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { logout } from "@/app/actions/auth";
import AcademyTheme from "@/components/academy/AcademyTheme";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
import AppBackButton from "@/components/AppBackButton";
import AccountViewSwitcher from "@/components/AccountViewSwitcher";
import type { AccountViewOption } from "@/lib/account-views";

const LazyBackupButtons = dynamic(() => import("./AdminBackupButtons"), {
    ssr: false,
    loading: () => <div className="px-8 py-3 text-xs text-gray-500">도구 준비 중...</div>,
});

const LazyNotificationBell = dynamic(() => import("./AdminNotificationBell"), {
    ssr: false,
    loading: () => (
        <div className="h-10 w-10 rounded-lg bg-gray-100 dark:bg-gray-800" aria-hidden="true" />
    ),
});

// 접두사가 같은 다른 메뉴까지 활성화하지 않도록 경로 경계를 확인한다.
function matchesNavPath(pathname: string, path: string): boolean {
    return pathname === path || pathname.startsWith(`${path}/`);
}

function isShuttlePath(pathname: string): boolean {
    return pathname.startsWith("/admin/shuttle") || pathname.startsWith("/admin/seasonal/shuttle") || pathname.startsWith("/admin/seasonal/dispatch");
}

const EXTRA_GROUPS = [
    { label: "업무별 상세 메뉴", icon: "assignment", items: [
        ["/admin/requests", "학부모 요청", "📩"],
        ["/admin/enrollment-changes", "수강 변경 신청", "🔁"],
        ["/admin/withdrawals", "회원 탈퇴 신청", "🚪"],
        ["/admin/role-requests", "직원 역할 신청", "🪪"],
        ["/admin/kakao-requests", "카카오 접수함", "💬"],
        ["/admin/absence", "정규 결석 신고", "🙅"],
        ["/admin/makeup", "보강", "🔄"],
        ["/admin/schedule", "수업시간표 관리", "📅"],
        ["/admin/attendance/report", "수업 리포트", "📝"],
        ["/staff/quick-post", "사진 빠른 업로드", "⚡"],
        ["/admin/seasonal", "방학특강", "🏀"],
        ["/admin/payment-requests", "입금 확인·영수증", "🧾"],
        ["/admin/payment-confirmations", "현장 수납 승인", "💵"],
        ["/admin/pos-reconcile", "POS 결제 대사", "🧮"],
        ["/admin/uniform", "유니폼 주문", "👕"],
    ] },
    { label: "홈페이지·소식", icon: "web", items: [
        ["/admin/settings", "학원 소개 관리", "🏫"],
        ["/admin/coaches", "코치/강사진 관리", "👤"],
        ["/admin/programs", "프로그램 관리", "📋"],
        ["/admin/notices", "공지사항 관리", "📢"],
        ["/admin/gallery", "사진/영상 갤러리", "📸"],
        ["/admin/faq", "FAQ 관리", "❓"],
        ["/admin/testimonials", "학부모 후기", "⭐"],
    ] },
    { label: "설정·도구", icon: "settings", items: [
        ["/admin/stats", "상세 통계", "📊"],
        ["/admin/notification-deliveries", "담당자 전달 장부", "🔔"],
        ["/admin/sms", "문자/템플릿", "💬"],
        ["/admin/staff", "스태프", "👥"],
        ["/admin/kakao-policy", "카카오 정책 답변", "📘"],
        ["/admin/media-revocations", "사진 공개 회수", "🔐"],
        ["/admin/import", "수강생 이관", "📥"],
        ["/admin/terms", "이용약관 관리", "📜"],
        ["/admin/privacy", "개인정보처리방침", "🔐"],
    ] },
] as const;

export default function AdminShellClient({
    children,
    initialUserName,
    initialUserEmail,
    sheetRetired = false,
    accountViews = [],
}: {
    children: React.ReactNode;
    initialUserName: string;
    initialUserEmail: string;
    // 구글 시트 원장 은퇴 여부 — 백업 버튼 묶음의 「시트 동기화」 표시 여부로만 쓴다
    sheetRetired?: boolean;
    accountViews?: AccountViewOption[];
}) {
    const pathname = usePathname() || "/admin";
    const userName = initialUserName;
    const userEmail = initialUserEmail;
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [systemToolsOpen, setSystemToolsOpen] = useState(false);
    useEffect(() => {
        // 화면 이동 다음 프레임에 닫아 새 페이지 렌더와 메뉴 상태 변경을 겹치지 않는다.
        const frame = window.requestAnimationFrame(() => {
            setMobileMenuOpen(false);
            setSystemToolsOpen(false);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [pathname]);

    return (
        <AcademyTheme role="admin" className="min-h-screen flex">
            {mobileMenuOpen && (
                <button
                    type="button"
                    aria-label="관리자 메뉴 닫기"
                    className="fixed inset-0 z-30 bg-black/45 md:hidden"
                    onClick={() => setMobileMenuOpen(false)}
                />
            )}

            {/* Sidebar */}
            <aside
                className={`${
                    mobileMenuOpen
                        ? "fixed inset-y-0 left-0 z-40 flex h-dvh w-72 max-w-[85vw]"
                        : "hidden"
                } flex-shrink-0 flex-col border-r border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)] md:fixed md:inset-y-0 md:left-0 md:z-10 md:flex md:h-full md:w-64 md:max-w-none`}
            >
                <div className="px-5 py-3 border-b border-[var(--color-academy-line)] flex items-center gap-3 flex-shrink-0 [@media(max-height:500px)]:min-h-11 [@media(max-height:500px)]:px-3 [@media(max-height:500px)]:py-0">
                    <div className="bg-white rounded-md flex items-center justify-center">
                        <Image
                            src="/stiz-logo.png"
                            alt="STIZ Admin"
                            width={124}
                            height={44}
                            className="h-[44px] w-[124px] shrink-0 object-contain [@media(max-height:500px)]:h-8 [@media(max-height:500px)]:w-20"
                        />
                    </div>
                    <span className="text-xs font-bold text-[var(--color-academy-muted)] tracking-tight">학원 운영</span>
                </div>
                <nav aria-label="관리자 업무 메뉴" className="min-h-0 p-3 space-y-1 flex-1 overflow-y-auto [@media(max-height:500px)]:p-2">
                    <NavItem href="/admin" active={pathname === "/admin"} icon="📊" label="오늘 업무" />
                    <NavItem href="/admin/apply" active={matchesNavPath(pathname, "/admin/apply")} icon="📝" label="신청·상담" />
                    <NavItem href="/admin/students" active={matchesNavPath(pathname, "/admin/students")} icon="🧑‍🎓" label="원생" />
                    <NavItem href="/admin/attendance" active={matchesNavPath(pathname, "/admin/attendance") && !matchesNavPath(pathname, "/admin/attendance/report")} icon="✅" label="수업·출결" />
                    <NavItem href="/admin/finance" active={matchesNavPath(pathname, "/admin/finance")} icon="💳" label="청구·수납" />
                    <NavItem href="/admin/shuttle/regular-dispatch" active={isShuttlePath(pathname)} icon="🚌" label="셔틀" />
                    {EXTRA_GROUPS.map((group) => (
                        <details key={`${group.label}-${pathname}`} className="group border-t border-[var(--color-academy-line)] pt-1" open={group.items.some(([href]) => matchesNavPath(pathname, href) && !(href === "/admin/seasonal" && isShuttlePath(pathname)))}>
                            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-2 text-sm font-bold text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                                <span className="material-symbols-outlined text-xl leading-none" aria-hidden="true">{group.icon}</span>
                                <span className="min-w-0 flex-1">{group.label}</span>
                                <FontFreeIcon name="expand_more" size={18} className="transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="space-y-1 border-l border-[var(--color-academy-line)] pl-2">
                                {group.items.map(([href, label, icon]) => (
                                    <NavItem key={href} href={href} label={label} icon={icon} compact active={matchesNavPath(pathname, href) && !(href === "/admin/seasonal" && isShuttlePath(pathname))} />
                                ))}
                                {group.label === "홈페이지·소식" && <NavItem href="/" label="홈페이지 보기" icon="🏫" compact />}
                                {group.label === "설정·도구" && <>
                                    <button type="button" aria-controls="admin-system-tools" aria-expanded={systemToolsOpen} onClick={() => setSystemToolsOpen((current) => !current)} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-4 py-2 text-left text-sm text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                                        <FontFreeIcon name="sync" size={18} /><span className="flex-1">시스템 도구</span><FontFreeIcon name="expand_more" size={18} />
                                    </button>
                                    {systemToolsOpen && <div id="admin-system-tools"><LazyBackupButtons sheetRetired={sheetRetired} /></div>}
                                </>}
                            </div>
                        </details>
                    ))}
                </nav>

                {/* 사용자 정보 + 로그아웃 */}
                <div className="p-4 border-t border-[var(--color-academy-line)] flex-shrink-0 [@media(max-height:500px)]:flex [@media(max-height:500px)]:items-center [@media(max-height:500px)]:gap-2 [@media(max-height:500px)]:p-2">
                    {accountViews.length > 0 && <div className="mb-1 flex justify-end [@media(max-height:500px)]:mb-0 [@media(max-height:500px)]:min-w-0 [@media(max-height:500px)]:flex-1">
                        <AccountViewSwitcher views={accountViews} placement="above" />
                    </div>}
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-[var(--color-academy-primary-soft)] rounded-full flex items-center justify-center text-[var(--color-academy-ink)] font-bold text-sm flex-shrink-0 [@media(max-height:500px)]:hidden">
                            {userName.charAt(0) || "A"}
                        </div>
                        <div className="flex-1 min-w-0 [@media(max-height:500px)]:hidden">
                            <p className="text-sm font-medium text-[var(--color-academy-ink)] truncate">{userName}</p>
                            <p className="text-xs text-gray-400 truncate">{userEmail}</p>
                        </div>
                        <form action={logout} className="flex-shrink-0">
                            <button
                                type="submit"
                                title="로그아웃"
                                className="p-1.5 text-gray-400 hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)] rounded-lg transition-colors [@media(max-height:500px)]:inline-flex [@media(max-height:500px)]:h-11 [@media(max-height:500px)]:w-11 [@media(max-height:500px)]:items-center [@media(max-height:500px)]:justify-center"
                            >
                                <FontFreeIcon name="logout" size={18} />
                            </button>
                        </form>
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex min-h-screen w-full min-w-0 flex-1 flex-col md:ml-64">
                <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 dark:bg-gray-800 dark:border-gray-700 md:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                        <button
                            type="button"
                            aria-label="관리자 메뉴 열기"
                            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-gray-200 text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700 md:hidden"
                            onClick={() => setMobileMenuOpen(true)}
                        >
                            <FontFreeIcon name="menu" size={22} />
                        </button>
                        <AppBackButton fallbackHref="/admin" />
                        <h2 className="truncate font-bold text-gray-700 dark:text-gray-200">학원 관리</h2>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2 md:gap-4">
                        {/* 알림 벨 — 읽지 않은 알림 수 배지 + 드롭다운 */}
                        <LazyNotificationBell />
                    </div>
                </header>
                <div className="admin-table-scope w-full min-w-0 flex-1 p-4 md:p-6 xl:p-8">
                    {children}
                </div>
            </main>
        </AcademyTheme>
    );
}

// 메뉴는 기능을 유지하고 공통 심볼로 바꿔 작은 화면에서도 같은 굵기로 읽히게 한다.
const NAV_SYMBOLS: Record<string, string> = {"🏫": "school", "👤": "person", "🧑\u200d🏫": "sports", "📋": "assignment", "📅": "calendar_month", "📢": "campaign", "📸": "photo_library", "⚡": "bolt", "❓": "help", "⭐": "star", "📜": "description", "🔐": "lock", "📊": "dashboard", "📝": "edit_document", "🧑\u200d🎓": "groups", "✅": "fact_check", "🙅": "event_busy", "🔁": "swap_horiz", "🧾": "receipt_long", "💳": "payments", "👕": "checkroom", "🏀": "sports_basketball", "🚌": "directions_bus", "📩": "inbox", "💬": "chat", "📘": "menu_book", "🔔": "notifications", "🔄": "event_repeat", "📥": "download", "👥": "badge", "💵": "account_balance_wallet", "🧮": "calculate"};

function NavItem({ href, active, icon, label, badge, compact = false }: { href: string; active?: boolean; icon: string; label: string; badge?: number; compact?: boolean }) {
    return (
        <Link
            href={href}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 items-center gap-3 px-4 ${compact ? "py-2.5 text-sm" : "py-3"} rounded-lg transition-colors [@media(max-height:500px)]:min-h-11 ${active
                ? "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)] font-bold"
                : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                }`}
        >
            <span className="material-symbols-outlined text-xl leading-none" aria-hidden="true">{NAV_SYMBOLS[icon] ?? "folder"}</span>
            <span className="flex-1">{label}</span>
            {/* 배지 — 새 신청 건수 등 알림 표시 */}
            {badge != null && badge > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold bg-red-500 text-white">
                    {badge}
                </span>
            )}
        </Link>
    );
}
