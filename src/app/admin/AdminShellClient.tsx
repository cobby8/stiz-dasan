"use client";

import Image from "next/image";
import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
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

// "학원운영" 탭에 속하는 경로 목록 — 이 경로로 시작하면 학원운영 탭 활성화
const OPS_PATHS = [
    "/admin/classes",
    "/admin/students",
    "/admin/attendance",
    "/admin/finance",
    "/admin/requests",
    "/admin/kakao-requests",
    "/admin/kakao-policy",
    "/admin/notification-deliveries",
    "/admin/feedback",
    "/admin/seasonal",
    "/admin/waitlist",
    "/admin/makeup",
    "/admin/stats",
    "/admin/sms",
    "/admin/import",
    "/admin/staff",
    "/admin/apply",
    "/admin/shuttle",
    "/admin/payment-confirmations",
    "/admin/payment-requests",
    "/admin/pos-reconcile",
    "/admin/enrollment-changes",
    "/admin/media-revocations",
    "/admin/uniform",
];

// 자주 쓰는 여섯 메뉴 밖의 기능은 업무 의미별로 묶되 직접 주소는 그대로 유지한다.
const CLASS_WORK_PATHS = [
    "/admin/absence", "/admin/enrollment-changes", "/admin/payment-requests",
    "/admin/seasonal", "/admin/uniform", "/admin/requests", "/admin/makeup",
    "/admin/attendance/report",
];
const OPERATING_PATHS = [
    "/admin/kakao-requests", "/admin/kakao-policy", "/admin/notification-deliveries",
    "/admin/feedback", "/admin/waitlist", "/admin/stats", "/admin/sms", "/admin/import",
    "/admin/staff", "/admin/payment-confirmations", "/admin/pos-reconcile",
    "/admin/media-revocations",
];

// 접두사가 비슷한 다른 화면까지 활성 메뉴로 표시하지 않도록 경로 경계를 확인한다.
function matchesNavPath(pathname: string, path: string): boolean {
    return pathname === path || pathname.startsWith(`${path}/`);
}

// 셔틀 관리 메뉴에 속하는 경로 판정 — 방학특강 배차/명단은 /admin/seasonal 하위지만
// 사이드바에서는 "셔틀 관리"로 묶어 표시하므로, 방학특강 메뉴와 겹치지 않게 여기서 걸러낸다.
function isShuttlePath(pathname: string): boolean {
    return (
        pathname.startsWith("/admin/shuttle") ||
        pathname.startsWith("/admin/seasonal/shuttle") ||
        pathname.startsWith("/admin/seasonal/dispatch")
    );
}

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
    const classWorkActive = CLASS_WORK_PATHS.some((path) => matchesNavPath(pathname, path)) && !isShuttlePath(pathname);
    const operatingActive = OPERATING_PATHS.some((path) => matchesNavPath(pathname, path));
    // 현재 URL 경로를 기반으로 활성 탭을 자동 결정
    // 첫 화면에서도 학원 업무 메뉴를 바로 찾을 수 있도록 운영 탭을 기본으로 둔다.
    const autoTab = useMemo(() => {
        if (pathname === "/admin") return "ops" as const;
        // 접힌 그룹의 주소로 직접 들어와도 사이트 탭으로 잘못 이동하지 않는다.
        if ([...OPS_PATHS, ...CLASS_WORK_PATHS, ...OPERATING_PATHS].some((path) => matchesNavPath(pathname, path))) return "ops" as const;
        return "site" as const;
    }, [pathname]);

    // 탭 상태 — URL 변경 시 자동으로 따라감
    const [activeTab, setActiveTab] = useState<"site" | "ops">(autoTab);

    // URL이 바뀌면 탭도 자동 전환 (다른 탭의 메뉴를 직접 URL로 접근했을 때)
    useEffect(() => {
        setActiveTab(autoTab);
        setMobileMenuOpen(false);
        setSystemToolsOpen(false);
    }, [autoTab, pathname]);

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
                <div className="px-5 py-5 border-b border-[var(--color-academy-line)] flex items-center gap-3 flex-shrink-0 [@media(max-height:450px)]:min-h-11 [@media(max-height:450px)]:px-3 [@media(max-height:450px)]:py-0">
                    <div className="bg-white rounded-md flex items-center justify-center">
                        <Image
                            src="/stiz-logo.png"
                            alt="STIZ Admin"
                            width={124}
                            height={54}
                            className="h-[54px] w-[124px] shrink-0 object-contain [@media(max-height:450px)]:h-8 [@media(max-height:450px)]:w-20"
                        />
                    </div>
                    <span className="text-xs font-bold text-[var(--color-academy-muted)] tracking-tight">학원 운영</span>
                </div>
                {/* 탭 전환 버튼 — 로고 바로 아래, 메뉴 목록 위 */}
                <div className="px-4 pt-4 pb-2 flex gap-1 flex-shrink-0 [@media(max-height:450px)]:px-2 [@media(max-height:450px)]:py-0">
                    <button
                        onClick={() => setActiveTab("site")}
                        className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-colors [@media(max-height:450px)]:min-h-11 [@media(max-height:450px)]:py-0 ${
                            activeTab === "site"
                                ? "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)] "
                                : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                        }`}
                    >
                        사이트
                    </button>
                    <button
                        onClick={() => setActiveTab("ops")}
                        className={`flex-1 py-2 text-sm font-semibold rounded-lg transition-colors [@media(max-height:450px)]:min-h-11 [@media(max-height:450px)]:py-0 ${
                            activeTab === "ops"
                                ? "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)] "
                                : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                        }`}
                    >
                        학원운영
                    </button>
                </div>

                <nav className="min-h-0 p-4 space-y-1 flex-1 overflow-y-auto [@media(max-height:450px)]:p-2">
                    {/* ===== 사이트 탭 메뉴 ===== */}
                    {activeTab === "site" && (
                        <>
                            {/* 학원 소개 */}
                            <p className="text-gray-500 text-xs font-bold uppercase px-4 py-2 mt-1">학원 소개</p>
                            <NavItem href="/admin/settings" active={pathname.startsWith("/admin/settings")} icon="🏫" label="학원 소개 관리" />
                            <NavItem href="/admin/coaches" active={pathname.startsWith("/admin/coaches")} icon="👤" label="코치/강사진 관리" />

                            {/* 수업 안내 */}
                            <p className="text-gray-500 text-xs font-bold uppercase px-4 py-2 mt-3">수업 안내</p>
                            {/* 선생님(수업 진행) 화면으로 바로 가기 — 관리자도 오늘 수업을 시작·출결할 수 있다. */}
                            <NavItem href="/staff" active={false} icon="🧑‍🏫" label="선생님 수업 화면" />
                            <NavItem href="/admin/programs" active={pathname.startsWith("/admin/programs")} icon="📋" label="프로그램 관리" />
                            <NavItem href="/admin/schedule" active={pathname.startsWith("/admin/schedule")} icon="📅" label="수업시간표 관리" />

                            {/* 소식/안내 */}
                            <p className="text-gray-500 text-xs font-bold uppercase px-4 py-2 mt-3">소식/안내</p>
                            <NavItem href="/admin/notices" active={pathname.startsWith("/admin/notices")} icon="📢" label="공지사항 관리" />
                            <NavItem href="/admin/gallery" active={pathname.startsWith("/admin/gallery")} icon="📸" label="사진/영상 갤러리" />
                            <NavItem href="/staff/quick-post" active={pathname.startsWith("/staff/quick-post")} icon="⚡" label="사진 빠른 업로드" />
                            <NavItem href="/admin/faq" active={pathname.startsWith("/admin/faq")} icon="❓" label="FAQ 관리" />
                            <NavItem href="/admin/testimonials" active={pathname.startsWith("/admin/testimonials")} icon="⭐" label="학부모 후기" />
                            <NavItem href="/admin/terms" active={pathname.startsWith("/admin/terms")} icon="📜" label="이용약관 관리" />
                            <NavItem href="/admin/privacy" active={pathname.startsWith("/admin/privacy")} icon="🔐" label="개인정보처리방침" />

                            <div className="mt-4 border-t border-[var(--color-academy-line)] pt-4">
                                <Link
                                    href="/"
                                    prefetch={false}
                                    className="flex items-center justify-center gap-2 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-soft)] px-4 py-3 text-sm font-bold text-[var(--color-academy-ink)] transition-colors hover:bg-white hover:text-brand-navy-900"
                                >
                                    <FontFreeIcon name="home" size={18} />
                                    <span>홈페이지 보기</span>
                                </Link>
                            </div>

                        </>
                    )}

                    {/* ===== 학원운영 탭 메뉴 ===== */}
                    {activeTab === "ops" && (
                        <>
                            <p className="text-gray-500 text-xs font-bold uppercase px-4 py-2">주요 업무</p>
                            <NavItem href="/admin" active={pathname === "/admin"} icon="📊" label="오늘 업무" />
                            <NavItem href="/admin/apply" active={matchesNavPath(pathname, "/admin/apply")} icon="📝" label="신청 관리" />
                            <NavItem href="/admin/students" active={matchesNavPath(pathname, "/admin/students")} icon="🧑‍🎓" label="원생 관리" />
                            <NavItem href="/admin/attendance" active={matchesNavPath(pathname, "/admin/attendance") && !matchesNavPath(pathname, "/admin/attendance/report")} icon="✅" label="수업·출결" />
                            <NavItem href="/admin/finance" active={matchesNavPath(pathname, "/admin/finance")} icon="💳" label="수납·청구" />
                            <NavItem href="/admin/seasonal/dispatch" active={isShuttlePath(pathname)} icon="🚌" label="셔틀 관리" />

                            {/* 경로마다 새로 열림 상태를 계산하여 내부 화면 직접 방문도 놓치지 않는다. */}
                            <details key={`class-work-${pathname}`} className="group mt-4" open={classWorkActive}>
                                <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-3 text-[var(--color-academy-muted)] transition-colors hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]">
                                    <span className="material-symbols-outlined text-xl leading-none" aria-hidden="true">assignment</span>
                                    <span className="flex-1 truncate text-sm font-bold">신청·수업 업무</span>
                                    <FontFreeIcon name="expand_more" size={18} className="transition-transform group-open:rotate-180" />
                                </summary>
                                <div className="mt-1 space-y-1 border-l border-[var(--color-academy-line)] pl-2">
                                    <NavItem href="/admin/absence" active={matchesNavPath(pathname, "/admin/absence")} icon="🙅" label="정규 결석 신고" compact />
                                    <NavItem href="/admin/enrollment-changes" active={matchesNavPath(pathname, "/admin/enrollment-changes")} icon="🔁" label="수강 변경 신청" compact />
                                    <NavItem href="/admin/payment-requests" active={matchesNavPath(pathname, "/admin/payment-requests")} icon="🧾" label="입금 확인·영수증" compact />
                                    <NavItem href="/admin/seasonal" active={matchesNavPath(pathname, "/admin/seasonal") && !isShuttlePath(pathname)} icon="🏀" label="방학특강" compact />
                                    <NavItem href="/admin/uniform" active={matchesNavPath(pathname, "/admin/uniform")} icon="👕" label="유니폼 주문" compact />
                                    <NavItem href="/admin/requests" active={matchesNavPath(pathname, "/admin/requests")} icon="📩" label="학부모 요청" compact />
                                    <NavItem href="/admin/makeup" active={matchesNavPath(pathname, "/admin/makeup")} icon="🔄" label="보강" compact />
                                    <NavItem href="/admin/attendance/report" active={matchesNavPath(pathname, "/admin/attendance/report")} icon="📝" label="수업 리포트" compact />
                                </div>
                            </details>

                            <details key={`operating-${pathname}`} className="group mt-2" open={operatingActive}>
                                <summary className="flex cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-3 text-[var(--color-academy-muted)] transition-colors hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]">
                                    <span className="material-symbols-outlined text-xl leading-none" aria-hidden="true">settings</span>
                                    <span className="flex-1 truncate text-sm font-bold">학원 운영 설정</span>
                                    <FontFreeIcon name="expand_more" size={18} className="transition-transform group-open:rotate-180" />
                                </summary>
                                <div className="mt-1 space-y-1 border-l border-[var(--color-academy-line)] pl-2">
                                    <NavItem href="/admin/kakao-requests" active={pathname.startsWith("/admin/kakao-requests")} icon="💬" label="카카오 접수함" compact />
                                    {/* 카카오 채널 정책 질문에 문서 기반으로 답하는 기능 — 정책 문서 편집·켜기/끄기·답변 기록 */}
                                    <NavItem href="/admin/kakao-policy" active={pathname.startsWith("/admin/kakao-policy")} icon="📘" label="카카오 정책 답변" compact />
                                    <NavItem href="/admin/notification-deliveries" active={pathname.startsWith("/admin/notification-deliveries")} icon="🔔" label="담당자 전달 장부" compact />
                                    <NavItem href="/admin/stats" active={pathname.startsWith("/admin/stats")} icon="📊" label="상세 통계" compact />
                                    <NavItem href="/admin/sms" active={pathname.startsWith("/admin/sms")} icon="💬" label="문자/템플릿" compact />
                                    <NavItem href="/admin/import" active={pathname.startsWith("/admin/import")} icon="📥" label="수강생 이관" compact />
                                    <NavItem href="/admin/staff" active={pathname.startsWith("/admin/staff")} icon="👥" label="스태프" compact />
                                    <NavItem href="/admin/payment-confirmations" active={pathname.startsWith("/admin/payment-confirmations")} icon="💵" label="현장 수납 승인" compact />
                                    {/* 토스 단말기(POS) 결제와 사이트 기록을 맞춰 보는 화면 — 매일 새벽 자동 대조 결과를 읽는다 */}
                                    <NavItem href="/admin/pos-reconcile" active={pathname.startsWith("/admin/pos-reconcile")} icon="🧮" label="POS 결제 대사" compact />
                                    {/* 사진 사용 동의 철회 처리 화면 — 링크가 없어 URL 직접 입력으로만 접근되던 문제를 해결 */}
                                    <NavItem href="/admin/media-revocations" active={pathname.startsWith("/admin/media-revocations")} icon="🔐" label="사진 공개 회수" compact />
                                    <div className="pt-1">
                                        <button
                                            type="button"
                                            aria-controls="admin-system-tools"
                                            aria-expanded={systemToolsOpen}
                                            onClick={() => setSystemToolsOpen((current) => !current)}
                                            className="flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-left text-sm text-[var(--color-academy-muted)] transition-colors hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                                        >
                                            <FontFreeIcon name="sync" size={18} />
                                            <span className="flex-1 truncate">시스템 도구</span>
                                            <FontFreeIcon
                                                name="expand_more"
                                                size={18}
                                                className={`transition-transform ${systemToolsOpen ? "rotate-180" : ""}`}
                                            />
                                        </button>
                                        {systemToolsOpen && (
                                            <div id="admin-system-tools" className="mt-1">
                                                <LazyBackupButtons sheetRetired={sheetRetired} />
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </details>
                        </>
                    )}
                </nav>

                {/* 사용자 정보 + 로그아웃 */}
                <div className="p-4 border-t border-[var(--color-academy-line)] flex-shrink-0 [@media(max-height:450px)]:flex [@media(max-height:450px)]:items-center [@media(max-height:450px)]:gap-2 [@media(max-height:450px)]:p-2">
                    {accountViews.length > 1 && <div className="mb-1 flex justify-end [@media(max-height:450px)]:mb-0 [@media(max-height:450px)]:min-w-0 [@media(max-height:450px)]:flex-1">
                        <AccountViewSwitcher views={accountViews} placement="above" />
                    </div>}
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 bg-[var(--color-academy-primary-soft)] rounded-full flex items-center justify-center text-[var(--color-academy-ink)] font-bold text-sm flex-shrink-0 [@media(max-height:450px)]:hidden">
                            {userName.charAt(0) || "A"}
                        </div>
                        <div className="flex-1 min-w-0 [@media(max-height:450px)]:hidden">
                            <p className="text-sm font-medium text-[var(--color-academy-ink)] truncate">{userName}</p>
                            <p className="text-xs text-gray-400 truncate">{userEmail}</p>
                        </div>
                        <form action={logout} className="flex-shrink-0">
                            <button
                                type="submit"
                                title="로그아웃"
                                className="p-1.5 text-gray-400 hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)] rounded-lg transition-colors [@media(max-height:450px)]:inline-flex [@media(max-height:450px)]:h-11 [@media(max-height:450px)]:w-11 [@media(max-height:450px)]:items-center [@media(max-height:450px)]:justify-center"
                            >
                                <FontFreeIcon name="logout" size={18} />
                            </button>
                        </form>
                    </div>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex min-h-screen w-full min-w-0 flex-1 flex-col md:ml-64">
                <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-gray-200 bg-white px-4 dark:bg-gray-800 dark:border-gray-700 md:h-16 md:px-8">
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
            className={`flex items-center gap-3 px-4 ${compact ? "py-2.5 text-sm" : "py-3"} rounded-lg transition-colors [@media(max-height:450px)]:min-h-11 ${active
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
