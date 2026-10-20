import Link from "next/link";
import FontFreeIcon from "@/components/ui/FontFreeIcon";

/** 출처 없는 숫자 대신 실제 이용 가능한 안내로 연결한다. */
export default function TrustBadges() {
  return <nav aria-label="수업 알아보기" className="grid grid-cols-3 divide-x divide-[var(--color-public-border)] rounded-xl border border-[var(--color-public-border)] bg-[var(--color-public-surface)]">
    {[
      { href: "/programs", title: "프로그램", icon: "sports_basketball" as const },
      { href: "/schedule", title: "수업시간표", icon: "calendar_today" as const },
      { href: "/about#location", title: "오시는 길", icon: "location_on" as const },
    ].map((item) => <Link key={item.href} href={item.href} className="flex min-h-12 items-center justify-center gap-1.5 px-2 py-3 text-sm font-bold text-[var(--color-public-text)] hover:bg-[var(--color-public-soft)] sm:gap-2"><FontFreeIcon name={item.icon} size={19} /><span>{item.title}</span></Link>)}
  </nav>;
}
