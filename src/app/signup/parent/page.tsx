import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import ParentSignupClient from "@/components/auth/ParentSignupClient";

export default function ParentSignupPage() {
  return (
    <main className="min-h-screen bg-surface-warm px-4 py-10 dark:bg-gray-950">
      <div className="mx-auto w-full max-w-md">
        <div className="mb-6 text-center">
          <Link href="/" aria-label="STIZ 홈">
            <Image src="/stiz-logo.png" alt="STIZ 축구교실" width={160} height={40} className="mx-auto h-10 w-auto object-contain" />
          </Link>
        </div>
        <section className="rounded-2xl border border-gray-200 bg-white p-6 text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-white sm:p-8">
          <Suspense fallback={<div className="h-64 animate-pulse rounded-xl bg-gray-100 dark:bg-gray-900" />}>
            <ParentSignupClient />
          </Suspense>
        </section>
        <p className="mt-6 text-center text-sm text-gray-600 dark:text-gray-300">이미 계정이 있나요? <Link href="/login" className="font-bold text-brand-orange-500">로그인</Link></p>
      </div>
    </main>
  );
}
