import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import ParentSignupClient from "@/components/auth/ParentSignupClient";
import ParentLoginLink from "@/components/auth/ParentLoginLink";
import PublicSiteTheme from "@/components/PublicSiteTheme";

export default function ParentSignupPage() {
  return (
    <PublicSiteTheme className="public-auth-page">
    <main className="min-h-screen bg-surface-warm px-4 py-10 dark:bg-[var(--color-public-paper)]">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 text-center">
          <Link href="/" aria-label="STIZ 홈">
            <Image src="/stiz-logo.png" alt="STIZ 농구교실" width={160} height={40} className="mx-auto h-10 w-auto object-contain" />
          </Link>
        </div>
        <section className="rounded-2xl border border-[var(--color-public-line)] bg-white p-6 text-[var(--color-public-ink)] shadow-sm dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-tint)] dark:text-white sm:p-8">
          <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-[var(--color-public-tint)] dark:bg-[var(--color-public-paper)]" />}>
            <ParentSignupClient />
          </Suspense>
        </section>
        <p className="mt-6 text-center text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">이미 계정이 있나요? <Suspense fallback={<span>로그인</span>}><ParentLoginLink /></Suspense></p>
      </div>
    </main>
    </PublicSiteTheme>
  );
}
