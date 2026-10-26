import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth-guard";
import { getAccountViewAccess } from "@/lib/account-view-access";
import AcademyTheme from "@/components/academy/AcademyTheme";
import AccountViewSwitcher from "@/components/AccountViewSwitcher";
import ChildConnectionsClient from "@/app/mypage/children/ChildConnectionsClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "자녀·가족 연결 | 스티즈 농구교실" };

/** 가족 연결 전 직원 계정도 접근할 수 있다. 자녀 정보는 API가 계정 연결을 별도로 확인한다. */
export default async function AccountChildrenPage() {
  await requireAuth().catch(() => redirect("/login?next=/account/children"));
  const { views } = await getAccountViewAccess();
  const backHref = views[0]?.href ?? "/";
  return <AcademyTheme role="parent" className="min-h-screen">
    <header className="flex min-h-16 items-center justify-between gap-3 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4">
      <Link href={backHref} aria-label="내 화면으로"><Image src="/stiz-logo.png" alt="STIZ" width={120} height={52} className="h-10 w-auto object-contain" /></Link>
      <AccountViewSwitcher views={views} />
    </header>
    <main className="mx-auto max-w-3xl p-4 sm:p-6"><ChildConnectionsClient backHref={backHref} /></main>
  </AcademyTheme>;
}
