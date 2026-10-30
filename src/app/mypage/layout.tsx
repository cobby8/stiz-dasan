import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { logout } from "@/app/actions/auth";
import { requireVerifiedParent } from "@/lib/auth-guard";
import AppBackButton from "@/components/AppBackButton";
import HideInInstalledApp from "@/components/pwa/HideInInstalledApp";
import MyPageBottomNav from "./MyPageBottomNav";
import AcademyTheme from "@/components/academy/AcademyTheme";
import AccountLinks from "@/components/account/AccountLinks";
import AccountViewSwitcher from "@/components/AccountViewSwitcher";
import { getAccountViewAccess } from "@/lib/account-view-access";

// 학부모 앱의 시작 주소가 /mypage 다. 여기서 공용 manifest(id "/")를 내려주면
// 브라우저가 "이 앱은 공식 앱이었나?" 하고 신원을 헷갈린다. 교사용(/staff)과 같은 구조로
// 자기 manifest 를 명시한다.
export const metadata: Metadata = {
  title: "스티즈 학부모",
  description: "자녀의 출결과 셔틀 시각, 결석 신고와 청구를 확인하는 스티즈 학부모 화면",
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
    await requireVerifiedParent().catch(() => redirect("/mypage/continue?bounced=1"));
    const { views } = await getAccountViewAccess();

    return (
        // 학부모 앱은 밝은 스포츠 스타일을 적용하고 역할 경계를 유지한다.
        <AcademyTheme role="parent" className="min-h-screen flex flex-col pb-20 md:pb-0">
            {/* 모바일 상단 헤더 — 기존 구조 유지, 그림자/보더 디자인 토큰 통일 */}
            <header className="bg-[var(--color-academy-surface)] sticky top-0 z-50 border-b border-[var(--color-academy-line)] grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-1 px-3 py-3 md:hidden">
                {/* 설치된 학부모 앱에서는 /mypage 밖으로 나가지 않는다.
                    브라우저로 들어온 사람은 홈페이지에서 왔을 수 있어 기존대로 둔다. */}
                <AppBackButton fallbackHref="/" scopeHref="/mypage" size="sm" />
                {/* 로고는 앱의 홈(/mypage)으로. 공개 홈페이지로 보내면 설치된 앱이
                    제 범위를 벗어나 주소표시줄이 뜨고 돌아올 길이 없어진다.
                    (선생님 앱의 로고가 /staff 로 가는 것과 같은 구조) */}
                <Link href="/mypage" className="flex items-center gap-2">
                    <Image src="/stiz-logo.png" alt="STIZ" width={120} height={52} className="h-10 w-20 shrink-0 object-contain" />
                </Link>
                {views.length > 1 ? <AccountViewSwitcher views={views} /> : <span className="text-center font-bold text-[var(--color-academy-ink)] text-sm">학부모</span>}
                <form action={logout}>
                    <button
                        type="submit"
                        // 휴대폰 헤더 로그아웃 — 누르는 높이 44px(min-h-11), 색은 토큰
                        className="inline-flex min-h-11 items-center rounded-lg border border-[var(--color-academy-line)] px-2.5 text-xs font-bold text-[var(--color-academy-muted)] transition-colors hover:bg-[var(--color-academy-soft)]"
                    >
                        로그아웃
                    </button>
                </form>
            </header>

            {/* 데스크탑 헤더 — 기존 구조 유지, 호버 트랜지션 통일 */}
            <header className="bg-[var(--color-academy-surface)] sticky top-0 z-50 border-b border-[var(--color-academy-line)] hidden md:flex items-center justify-between px-8 py-4">
                <div className="flex min-w-0 items-center gap-3">
                    <AppBackButton fallbackHref="/" scopeHref="/mypage" />
                    <Link href="/mypage" className="flex min-w-0 items-center gap-2">
                        <Image src="/stiz-logo.png" alt="STIZ" width={140} height={61} className="h-12 w-auto object-contain" />
                        <span className="hidden lg:inline font-extrabold text-lg text-[var(--color-academy-ink)]">
                            스티즈농구교실 <span className="text-[var(--color-academy-primary)]">다산2호점</span>
                        </span>
                    </Link>
                </div>
                <nav className="flex shrink-0 items-center gap-4 text-sm font-bold text-[var(--color-academy-muted)]">
                    <AccountViewSwitcher views={views} />
                    <Link href="/mypage" className="text-[var(--color-academy-primary)] transition-colors">마이페이지</Link>
                    {/* 브라우저로 들어온 학부모에게는 홈페이지로 가는 길이 필요하지만,
                        설치된 앱에서는 나가면 돌아올 길이 없어 감춘다. */}
                    <HideInInstalledApp>
                        <Link href="/" className="hover:text-[var(--color-academy-primary)] transition-colors">홈으로</Link>
                    </HideInInstalledApp>
                    <form action={logout}>
                        <button
                            type="submit"
                            className="font-bold text-gray-600 transition-colors hover:text-brand-orange-500 dark:text-gray-300 dark:hover:text-brand-neon-lime"
                        >
                            로그아웃
                        </button>
                    </form>
                </nav>
            </header>

            {/* 메인 콘텐츠 영역 */}
            <main className="flex-1 max-w-5xl w-full mx-auto p-4 md:p-8">
                {children}
                <AccountLinks />
            </main>

            {/* 모바일 하단 네비게이션 — 자녀 핵심 기능(리포트·스킬·방학특강) 중심으로 재구성.
                활성 경로 하이라이트를 위해 클라이언트 컴포넌트(MyPageBottomNav)로 분리. */}
            <MyPageBottomNav />
        </AcademyTheme>
    );
}
