import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { requireVerifiedParent } from "@/lib/auth-guard";
import AppBackButton from "@/components/AppBackButton";
import HideInInstalledApp from "@/components/pwa/HideInInstalledApp";
import MyPageBottomNav from "./MyPageBottomNav";
import ParentNotificationBell from "./ParentNotificationBell";
import { getNotifications, getUnreadNotificationCount } from "@/lib/queries";
import { FONT_SCALE_COOKIE, fontScalePercent, parseFontScale } from "@/lib/mypage/parentSettings";
import AcademyTheme from "@/components/academy/AcademyTheme";
import UiIcon from "@/components/common/UiIcon";
import AccountViewSwitcher from "@/components/AccountViewSwitcher";
import { getAccountViewAccess } from "@/lib/account-view-access";
import { Suspense } from "react";
import ParentHistoryTracker from "@/components/parent/ParentHistoryTracker";

// 학부모 앱의 시작 주소가 /mypage 다. 여기서 공용 manifest(id "/")를 내려주면
// 브라우저가 "이 앱은 공식 앱이었나?" 하고 신원을 헷갈린다. 교사용(/staff)과 같은 구조로
// 자기 manifest 를 명시한다.
export const metadata: Metadata = {
  title: "스티즈 학부모",
  description: "자녀의 출결과 셔틀 시각, 결석 알리기와 청구를 확인하는 스티즈 학부모 화면",
  manifest: "/manifest-parent.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    // 아이폰 홈 화면에 찍히는 이름. manifest 와 어긋나면 기기마다 다른 이름이 뜬다.
    title: "스티즈 학부모",
  },
};

export default async function MyPageLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    // bounced=1: "여기가 방금 이 사용자를 거절했다"는 표시.
    // 이게 없으면 /auth/continue 가 다시 /mypage 로 보내고, 여기서 또 거절해 무한
    // 리다이렉트가 된다(실제 발생: ERR_TOO_MANY_REDIRECTS).
    // /mypage/continue 로 가는 이유: /auth/continue 는 학부모 앱의 영역(/mypage) 밖이라
    // 설치된 앱이 주소표시줄을 띄우며 브라우저로 새어 나간다.
    const parent = await requireVerifiedParent().catch(() => redirect("/mypage/continue?bounced=1"));
    // 머리줄 «알림»(모든 /mypage 화면 공통, 2026-11-10 원장 결정 k7) — 대상은 로그인한 본인 알림만
    const [{ views }, notifications, unreadCount, cookieStore] = await Promise.all([
        getAccountViewAccess(),
        getNotifications(parent.appUserId),
        getUnreadNotificationCount(parent.appUserId),
        cookies(),
    ]);
    // 글자 크기(설정 화면) — 쿠키로 서버가 처음부터 그 크기로 그린다(깜빡임 없음). 학부모 화면 안에서만 적용된다.
    const fontPercent = fontScalePercent(parseFontScale(cookieStore.get(FONT_SCALE_COOKIE)?.value));
    const bellItems = notifications.map((n) => ({
        id: n.id, type: n.type, title: n.title, message: n.message, linkUrl: n.linkUrl, isRead: n.isRead, createdAt: n.createdAt,
    }));
    // «설정» 버튼 — 예전 «⋯» 메뉴 자리. 2026-11-15 아이콘 예외(설정 = 톱니): 글자 → 톱니. 이름은 aria-label, 누르는 영역 44×44
    const settingsLink = (
        <Link
            href="/mypage/settings"
            aria-label="설정"
            title="설정"
            className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-[var(--color-academy-muted)] transition-colors hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)]"
        >
            <UiIcon name="settings" size={24} />
        </Link>
    );

    return (
        // 학부모 앱은 밝은 스포츠 스타일을 적용하고 역할 경계를 유지한다.
        // 아래 여백 = 아래 탭 48px + 숨 쉴 틈 16px + 안전영역(2026-11-14 탭 64→48px 와 맞춤)
        <AcademyTheme role="parent" className="min-h-screen flex flex-col pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
            {/* 글자 크기 «크게·아주 크게» — html 글자 배율. 학부모 화면을 떠나면 이 줄도 사라져 다른 화면엔 영향 없음 */}
            {fontPercent !== 100 && <style>{`html{font-size:${fontPercent}%}`}</style>}
            {/* 학부모 화면 안 이동 기록(탭마다) — «←» 가 방금 있던 화면으로 돌아가게. 보이지 않는 부품
                (쿼리 읽기 부품이라 Suspense 로 감싼다 — 감싸지 않으면 화면 전체가 클라이언트 렌더로 밀린다) */}
            <Suspense fallback={null}>
                <ParentHistoryTracker />
            </Suspense>
            {/* 모바일 상단 헤더 — [뒤로 · 로고 · 학부모] …… [알림 N] [설정] (2026-11-10 원장 결정 k7) */}
            <header className="bg-[var(--color-academy-surface)] sticky top-0 z-50 border-b border-[var(--color-academy-line)] grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] items-center gap-1 px-3 py-2 md:hidden">
                {/* 돌아갈 기록이 없으면 학부모 홈(/mypage)으로 — 설치 앱·스토어 앱·브라우저 모두(2026-11-15 원장 결정).
                    예전엔 브라우저에서 공개 홈 «/» 로 나갔다. 학부모 홈 자체에서는 기존 규칙대로 «/». */}
                <AppBackButton fallbackHref="/mypage" scopeHref="/mypage" size="sm" />
                {/* 로고는 앱의 홈(/mypage)으로. 공개 홈페이지로 보내면 설치된 앱이
                    제 범위를 벗어나 주소표시줄이 뜨고 돌아올 길이 없어진다.
                    (선생님 앱의 로고가 /staff 로 가는 것과 같은 구조) */}
                <Link href="/mypage" className="flex items-center gap-2">
                    <Image src="/stiz-logo.png" alt="STIZ" width={120} height={52} className="h-10 w-20 shrink-0 object-contain" />
                </Link>
                {/* «학부모» 글자는 로고 바로 오른쪽(역할이 둘 이상이면 화면 전환 단추) */}
                <div className="min-w-0 justify-self-start">
                    {views.length > 1 ? <AccountViewSwitcher views={views} /> : <span className="font-medium text-[var(--color-academy-ink)] text-sm">학부모</span>}
                </div>
                {/* 알림 — 안 읽은 수 배지, 누르면 알림 목록(아래 «알림 설정») */}
                <ParentNotificationBell notifications={bellItems} unreadCount={unreadCount} />
                {/* 설정 — 계정·비밀번호·가족·알림·글자 크기·앱 정보·문의·로그아웃(예전 «⋯» 메뉴를 대신함) */}
                {settingsLink}
            </header>

            {/* 데스크탑 헤더 — 기존 구조 유지, 호버 트랜지션 통일 */}
            <header className="bg-[var(--color-academy-surface)] sticky top-0 z-50 border-b border-[var(--color-academy-line)] hidden md:flex items-center justify-between px-8 py-4">
                <div className="flex min-w-0 items-center gap-3">
                    <AppBackButton fallbackHref="/mypage" scopeHref="/mypage" />
                    <Link href="/mypage" className="flex min-w-0 items-center gap-2">
                        <Image src="/stiz-logo.png" alt="STIZ" width={140} height={61} className="h-12 w-auto object-contain" />
                        <span className="hidden lg:inline font-bold text-lg text-[var(--color-academy-ink)]">
                            스티즈농구교실 <span className="text-[var(--color-academy-ink)]">다산2호점</span>
                        </span>
                    </Link>
                </div>
                {/* PC 메뉴 — 휴대폰 아래 탭과 같은 4개(홈·수업·청구·소식). 예전엔 PC 에 메뉴가 없어
                    하위 화면 사이를 «뒤로 → 홈 → 타일»로만 오갔다. */}
                <MyPageBottomNav variant="top" />
                <div className="flex shrink-0 items-center gap-3 text-sm font-medium text-[var(--color-academy-muted)]">
                    <AccountViewSwitcher views={views} />
                    {/* 브라우저로 들어온 학부모에게는 홈페이지로 가는 길이 필요하지만,
                        설치된 앱에서는 나가면 돌아올 길이 없어 감춘다. */}
                    <HideInInstalledApp>
                        <Link href="/" className="hover:text-[var(--color-academy-ink)] transition-colors">홈페이지</Link>
                    </HideInInstalledApp>
                    <ParentNotificationBell notifications={bellItems} unreadCount={unreadCount} />
                    {settingsLink}
                </div>
            </header>

            {/* 메인 콘텐츠 영역 */}
            <main className="flex-1 max-w-5xl w-full mx-auto p-4 md:p-8">
                {/* 맨 아래 계정 링크 줄은 없앴다(2026-11-14 원장 결정 d3) — 계정·가족·탈퇴는 머리줄 «설정» 화면 안에 있다 */}
                {children}
            </main>

            {/* 모바일 하단 탭 — 홈·수업·청구·소식(2026-11-10 원장 결정 d5).
                활성 경로 하이라이트를 위해 클라이언트 컴포넌트(MyPageBottomNav)로 분리. */}
            <MyPageBottomNav />
        </AcademyTheme>
    );
}
