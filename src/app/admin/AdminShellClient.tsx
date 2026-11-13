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
import SectionTabs from "@/components/admin/SectionTabs";
import type { AccountViewOption } from "@/lib/account-views";
import { findAdminSection, isInAdminSection, type AdminSectionKey } from "@/lib/admin-sections";

const LazyBackupButtons = dynamic(() => import("./AdminBackupButtons"), {
    ssr: false,
    loading: () => <div className="px-8 py-3 text-xs text-[var(--color-academy-muted)]">도구 준비 중...</div>,
});

const LazyNotificationBell = dynamic(() => import("./AdminNotificationBell"), {
    ssr: false,
    loading: () => (
        <div className="h-10 w-10 rounded-lg bg-[var(--color-academy-soft)]" aria-hidden="true" />
    ),
});

// 접두사가 같은 다른 메뉴까지 활성화하지 않도록 경로 경계를 확인한다.
function matchesNavPath(pathname: string, path: string): boolean {
    return pathname === path || pathname.startsWith(`${path}/`);
}

function isShuttlePath(pathname: string): boolean {
    return pathname.startsWith("/admin/shuttle") || pathname.startsWith("/admin/seasonal/shuttle") || pathname.startsWith("/admin/seasonal/dispatch");
}

// 게슈탈트 A-11: 15개를 한 묶음에 쌓지 않고 «수업 운영 / 돈·수납 …» 묶음으로(주소·이름은 그대로)
// 2026-11-10 신청함 통합(원장 결정 d2): 옛 «요청·신청함» 묶음(학부모 요청·수강 변경·탈퇴·직원 역할·카카오·대관)은
// 메뉴에서 빼고 최상위 «신청함»(/admin/inbox) 하나로 모았다. 옛 주소는 그대로 살아 있다(신청함 상세 칸 «기존 화면에서 열기»).
// 신청함을 거치는 옛 화면 목록 — 그 화면에 들어가 있으면 «신청함» 메뉴를 켜 둔다(길 잃지 않게)
// 2026-11-10 원장 결정 k4: «신청·상담»(/admin/apply) 메뉴도 신청함 체험·수강 탭과 ⚙ 신청 설정으로 옮겼다(주소는 산다)
const INBOX_LEGACY_PATHS = ["/admin/requests", "/admin/enrollment-changes", "/admin/withdrawals", "/admin/role-requests", "/admin/kakao-requests", "/admin/rental", "/admin/apply"] as const;
// 2026-11-13 관리자 메뉴 정리(원장 점검표 승인): 비슷한 화면은 메뉴 하나 + 화면 위 탭 줄로 묶었다.
//   - section 이 있는 메뉴 = 그 묶음(src/lib/admin-sections.ts)의 어느 화면에 있어도 켜진다
//   - 메뉴에서만 뺀 화면(주소·화면은 산다): 유니폼 주문(/admin/uniform) · 사진 빠른 업로드(/staff/quick-post → 갤러리 «빠른 업로드» 버튼)
//   - 수강생 이관(/admin/import)은 원장 지시로 화면·API 를 삭제했다(가져온 자료는 DB 에 그대로)
type ExtraNavItem = { href: string; label: string; icon: string; section?: AdminSectionKey };
const EXTRA_GROUPS: ReadonlyArray<{ label: string; icon: string; items: readonly ExtraNavItem[] }> = [
    { label: "수업", icon: "event_note", items: [
        { href: "/admin/schedule", label: "수업시간표 관리", icon: "📅" },
        { href: "/admin/seasonal", label: "방학특강", icon: "🏀" },
    ] },
    { label: "홈페이지", icon: "web", items: [
        { href: "/admin/notices", label: "공지사항 관리", icon: "📢" },
        // 학원 소개·코치·프로그램·갤러리·사진 공개 회수·FAQ·후기 탭
        { href: "/admin/settings", label: "홈페이지 관리", icon: "🏫", section: "homepage" },
    ] },
    { label: "설정", icon: "settings", items: [
        { href: "/admin/staff", label: "스태프", icon: "👥" },
        // 문자/템플릿·담당자 전달 장부·카카오 정책 답변 탭
        { href: "/admin/sms", label: "문자·알림", icon: "💬", section: "messaging" },
        // 이용약관·개인정보처리방침 탭
        { href: "/admin/terms", label: "약관·방침", icon: "📜", section: "policy" },
        { href: "/admin/pos-plugin", label: "POS 연결", icon: "🔌" },
    ] },
];

// 메뉴 한 칸이 켜졌는가 — 묶음 메뉴는 묶음 안 어느 화면이든, 나머지는 그 주소(하위 포함)일 때.
// 방학특강 셔틀 화면(/admin/seasonal/shuttle 등)은 «셔틀» 메뉴가 켜지므로 «방학특강»은 끈다.
function isExtraItemActive(pathname: string, item: ExtraNavItem): boolean {
    if (item.section) return isInAdminSection(pathname, item.section);
    return matchesNavPath(pathname, item.href) && !(item.href === "/admin/seasonal" && isShuttlePath(pathname));
}

export default function AdminShellClient({
    children,
    initialUserName,
    initialUserEmail,
    sheetRetired = false,
    accountViews = [],
    inboxCount = null,
}: {
    children: React.ReactNode;
    initialUserName: string;
    initialUserEmail: string;
    // 구글 시트 원장 은퇴 여부 — 백업 버튼 묶음의 「시트 동기화」 표시 여부로만 쓴다
    sheetRetired?: boolean;
    accountViews?: AccountViewOption[];
    /** 신청함 «처리 필요» 건수(getInboxCounts) — 읽지 못했으면 null(배지만 숨긴다) */
    inboxCount?: number | null;
}) {
    const pathname = usePathname() || "/admin";
    const userName = initialUserName;
    const userEmail = initialUserEmail;
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const [systemToolsOpen, setSystemToolsOpen] = useState(false);
    // 지금 화면이 속한 탭 묶음(없으면 null → 탭 줄 없음)
    const activeSection = findAdminSection(pathname);
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
                            alt="STIZ 관리자"
                            width={124}
                            height={44}
                            className="h-[44px] w-[124px] shrink-0 object-contain [@media(max-height:500px)]:h-8 [@media(max-height:500px)]:w-20"
                        />
                    </div>
                    <span className="text-xs font-bold text-[var(--color-academy-muted)] tracking-tight">학원 운영</span>
                </div>
                <nav aria-label="관리자 업무 메뉴" className="min-h-0 p-3 space-y-1 flex-1 overflow-y-auto [@media(max-height:500px)]:p-2">
                    {/* 2026-11-13 «오늘 업무» → «대시보드»(원장 점검표) */}
                    <NavItem href="/admin" active={pathname === "/admin"} icon="📊" label="대시보드" />
                    {/* 2026-11-13 통계 개편(원장 결정표): «통계»는 설정 묶음에서 빼 대시보드 바로 아래로 — 카드 «자세히 →»가 가는 곳 */}
                    <NavItem href="/admin/stats" active={matchesNavPath(pathname, "/admin/stats")} icon="📈" label="통계" />
                    {/* 신청함 — 체험·수강·상담·대관·변경·기타 6탭. 배지 = 처리 필요 건수 */}
                    <NavItem href="/admin/inbox" active={matchesNavPath(pathname, "/admin/inbox") || INBOX_LEGACY_PATHS.some((path) => matchesNavPath(pathname, path))} icon="📨" label="신청함" badge={inboxCount ?? undefined} />
                    <NavItem href="/admin/students" active={matchesNavPath(pathname, "/admin/students")} icon="🧑‍🎓" label="원생" />
                    {/* 출결·정규 결석 신고·보강·수업 리포트 탭 묶음 어디서든 켜진다 */}
                    <NavItem href="/admin/attendance" active={isInAdminSection(pathname, "attendance")} icon="✅" label="수업·출결" />
                    {/* 청구·수납·입금 확인·현장 수납 승인·POS 결제 대사 탭 묶음 */}
                    <NavItem href="/admin/finance" active={isInAdminSection(pathname, "finance")} icon="💳" label="청구·수납" />
                    <NavItem href="/admin/shuttle/regular-dispatch" active={isShuttlePath(pathname)} icon="🚌" label="셔틀" />
                    {EXTRA_GROUPS.map((group) => (
                        <details key={`${group.label}-${pathname}`} className="group border-t border-[var(--color-academy-line)] pt-1" open={group.items.some((item) => isExtraItemActive(pathname, item))}>
                            {/* 묶음 이름 — 아이콘 없이 글자만. 펼침 화살표는 «열고 닫는다»는 조작 표시라 남긴다 */}
                            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-lg px-4 py-2 text-xs font-medium text-[var(--color-academy-faint)] hover:bg-[var(--color-academy-soft)]">
                                <span className="min-w-0 flex-1">{group.label}</span>
                                <FontFreeIcon name="expand_more" size={18} className="transition-transform group-open:rotate-180" />
                            </summary>
                            <div className="space-y-1 border-l border-[var(--color-academy-line)] pl-2">
                                {group.items.map((item) => (
                                    <NavItem key={item.href} href={item.href} label={item.label} icon={item.icon} compact active={isExtraItemActive(pathname, item)} />
                                ))}
                                {group.label === "설정" && <>
                                    <button type="button" aria-controls="admin-system-tools" aria-expanded={systemToolsOpen} onClick={() => setSystemToolsOpen((current) => !current)} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-4 py-2 text-left text-sm text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]">
                                        <span className="flex-1">시스템 도구</span><FontFreeIcon name="expand_more" size={18} />
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
                            <p className="text-xs text-[var(--color-academy-faint)] truncate">{userEmail}</p>
                        </div>
                        <form action={logout} className="flex-shrink-0">
                            {/* 누르는 영역 44px(A-12) */}
                            <button
                                type="submit"
                                title="로그아웃"
                                aria-label="로그아웃"
                                className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] transition-colors hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)]"
                            >
                                <FontFreeIcon name="logout" size={18} />
                            </button>
                        </form>
                    </div>
                    {/* 2026-11-13 «홈페이지 보기»는 메뉴 묶음에서 빼고 맨 아래 작은 링크로(가끔 쓰는 바깥 이동) */}
                    <Link
                        href="/"
                        prefetch={false}
                        className="mt-1 flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs font-medium text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-primary)] [@media(max-height:500px)]:mt-0 [@media(max-height:500px)]:shrink-0"
                    >
                        홈페이지 보기
                    </Link>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex min-h-screen w-full min-w-0 flex-1 flex-col md:ml-64">
                <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-[var(--color-academy-line)] bg-white px-4 md:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                        <button
                            type="button"
                            aria-label="관리자 메뉴 열기"
                            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-[var(--color-academy-line)] text-[var(--color-academy-muted)] transition-colors hover:bg-[var(--color-academy-line)] md:hidden"
                            onClick={() => setMobileMenuOpen(true)}
                        >
                            <FontFreeIcon name="menu" size={22} />
                        </button>
                        <AppBackButton fallbackHref="/admin" />
                        <h2 className="truncate font-bold text-[var(--color-academy-muted)]">학원 관리</h2>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2 md:gap-4">
                        {/* 알림 벨 — 읽지 않은 알림 수 배지 + 드롭다운 */}
                        <LazyNotificationBell />
                    </div>
                </header>
                <div className="admin-table-scope w-full min-w-0 flex-1 p-4 md:p-6 xl:p-8">
                    {/* 묶인 화면이면 맨 위에 탭 줄(같은 묶음의 다른 화면으로 바로 이동). 화면 파일은 건드리지 않는다 */}
                    {activeSection && <SectionTabs label={activeSection.section.label} tabs={activeSection.section.tabs} activeHref={activeSection.activeHref} />}
                    {children}
                </div>
            </main>
        </AcademyTheme>
    );
}

// 메뉴는 아이콘 없이 글자만 쓴다(2026-11-13 원장 «아이콘이 어설퍼 보인다 — 빼고 글자 깔끔하게»).
// icon 값은 메뉴 정의(EXTRA_GROUPS)와 테스트가 아직 들고 있어 받기만 하고 그리지 않는다.
// 지금 있는 메뉴 = 보조 색(하늘색) 바탕 + 강조 굵기. 주 색(네이비)은 누르는 주 버튼 몫이다.
function NavItem({ href, active, label, badge, compact = false }: { href: string; active?: boolean; icon?: string; label: string; badge?: number; compact?: boolean }) {
    return (
        <Link
            href={href}
            prefetch={false}
            aria-current={active ? "page" : undefined}
            className={`flex min-h-11 items-center gap-3 px-4 ${compact ? "py-2.5 text-sm" : "py-3"} rounded-lg transition-colors [@media(max-height:500px)]:min-h-11 ${active
                ? "bg-[var(--color-academy-secondary-soft)] text-[var(--color-academy-secondary-ink)] font-semibold"
                : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)]"
                }`}
        >
            <span className="flex-1">{label}</span>
            {/* 배지 — 새 신청 건수 등 알림 표시 */}
            {badge != null && badge > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-bold bg-[var(--color-academy-danger)] text-white">
                    {badge}
                </span>
            )}
        </Link>
    );
}
