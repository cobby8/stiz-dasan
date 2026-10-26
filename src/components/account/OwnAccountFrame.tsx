import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import type { AccountViewOption } from "@/lib/account-views";
import AcademyTheme from "@/components/academy/AcademyTheme";
import AccountViewSwitcher from "@/components/AccountViewSwitcher";

export default function OwnAccountFrame({
  children,
  views,
}: {
  children: ReactNode;
  views: AccountViewOption[];
}) {
  return (
    <AcademyTheme role="parent" className="min-h-screen">
      <header className="flex min-h-16 items-center justify-between gap-3 border-b border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-4">
        <Link
          href={views[0]?.href || "/auth/continue"}
          aria-label="내 화면으로"
        >
          <Image
            src="/stiz-logo.png"
            alt="STIZ"
            width={120}
            height={52}
            className="h-10 w-auto object-contain"
          />
        </Link>
        <AccountViewSwitcher views={views} />
      </header>
      <main>{children}</main>
    </AcademyTheme>
  );
}
