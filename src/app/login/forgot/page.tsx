import Image from "next/image";
import Link from "next/link";
import type { Metadata } from "next";
import ParentPasswordResetClient from "@/components/auth/ParentPasswordResetClient";
import PublicSiteTheme from "@/components/PublicSiteTheme";

export const metadata: Metadata = {
  title: "아이디·비밀번호 찾기",
  robots: { index: false, follow: false },
};

// 학부모 아이디·비밀번호 찾기 — 회원가입 화면과 같은 틀(로고 + 카드)을 쓴다.
export default function ParentPasswordResetPage() {
  return (
    <PublicSiteTheme className="public-auth-page" publicScope>
      <main className="min-h-screen bg-surface-warm px-4 py-10 dark:bg-[var(--color-public-paper)]">
        <div className="mx-auto w-full max-w-md">
          <div className="mb-6 text-center">
            <Link href="/" aria-label="STIZ 홈">
              <Image src="/stiz-logo.png" alt="STIZ 농구교실" width={160} height={40} className="mx-auto h-10 w-auto object-contain" />
            </Link>
          </div>
          <section className="rounded-2xl border border-[var(--color-public-line)] bg-white p-6 text-[var(--color-public-ink)] shadow-sm dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)] dark:text-white sm:p-8">
            <ParentPasswordResetClient />
          </section>
          <p className="mt-6 text-center text-sm text-[var(--color-public-muted)]">
            <Link href="/login" className="font-medium text-[var(--color-public-accent)]">로그인</Link>
            <span className="mx-2" aria-hidden="true">·</span>
            <Link href="/signup/parent" className="font-medium text-[var(--color-public-accent)]">회원가입</Link>
          </p>
        </div>
      </main>
    </PublicSiteTheme>
  );
}
