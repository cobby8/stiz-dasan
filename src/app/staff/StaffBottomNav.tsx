"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

type StaffRole = "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER";

const teachingItems = [
  { href: "/staff", label: "수업", icon: "today", exact: true },
  { href: "/staff/students", label: "학생", icon: "groups", exact: false },
  { href: "/staff/billing", label: "청구", icon: "receipt_long", exact: false },
] as const;

const shuttleItem = { href: "/staff/shuttle", label: "셔틀", icon: "airport_shuttle", exact: false } as const;
const seasonalItem = { href: "/staff/seasonal", label: "특강", icon: "sports_basketball", exact: false } as const;

export default function StaffBottomNav({ staffRole }: { staffRole: StaffRole }) {
  const pathname = usePathname();
  // 수업 진행 화면은 종료 버튼 등 수업 조작에 집중할 수 있도록 메뉴를 숨깁니다.
  if (pathname.startsWith("/staff/sessions/")) return null;

  const items = staffRole === "DRIVER"
    ? [shuttleItem]
    : staffRole === "ADMIN" || staffRole === "VICE_ADMIN"
      ? [...teachingItems, seasonalItem, shuttleItem]
      : [...teachingItems, seasonalItem];
  const gridClass = items.length >= 5 ? "grid-cols-5" : items.length === 4 ? "grid-cols-4" : items.length === 1 ? "grid-cols-1" : "grid-cols-3";

  // 공통 표면을 사용하되 현재 메뉴의 접근성·이동 규칙은 유지합니다.
  return <nav aria-label="교사용 주요 메뉴" className="academy-staff-nav fixed inset-x-0 bottom-0 z-30 border-t px-3 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl">
    <div className={`mx-auto grid max-w-lg ${gridClass} gap-2`}>{items.map((item) => {
      const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
      return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={`relative flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-2xl text-xs font-bold transition-colors ${active ? "bg-[color-mix(in_srgb,var(--brand-accent)_12%,transparent)] text-[var(--brand-accent)]" : "text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-900"}`}><span className={`material-symbols-outlined text-[1.45rem] ${active ? "[font-variation-settings:'FILL'_1]" : ""}`} aria-hidden="true">{item.icon}</span>{item.label}<span className="sr-only">{active ? "현재 메뉴" : "메뉴로 이동"}</span></Link>;
    })}</div>
  </nav>;
}
