"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 셔틀 관리 전용 탭 바 — 방학특강 셔틀(배차·명단) + 정규 셔틀 + 차량 관리를 한 곳에 모은다.
// (방학특강 운영 탭바 SeasonalSectionTabs와 분리)

const ITEMS: Array<{ key: string; href: string; label: string; icon: string }> = [
  // 매달 사용하는 정규 수업 메뉴를 앞에 두고, 계절성 방학특강 메뉴는 뒤로 배치한다.
  { key: "regular-dispatch", href: "/admin/shuttle/regular-dispatch", label: "정규 배차", icon: "route" },
  { key: "regular", href: "/admin/shuttle/regular", label: "셔틀 명단", icon: "groups" },
  { key: "vehicle", href: "/admin/shuttle", label: "차량 관리", icon: "directions_bus" },
  { key: "notice", href: "/admin/seasonal/shuttle-notice", label: "등원시간 안내", icon: "sms" },
  { key: "dispatch", href: "/admin/seasonal/dispatch", label: "방학특강 배차", icon: "route" },
  { key: "roster", href: "/admin/seasonal/shuttle", label: "방학특강 명단", icon: "list_alt" },
];

function resolveActiveKey(pathname: string): string {
  if (pathname.startsWith("/admin/seasonal/dispatch")) return "dispatch";
  // 접두 충돌 주의: shuttle-notice 를 shuttle 보다 먼저 판정한다(아래 regular 쌍과 같은 이유).
  if (pathname.startsWith("/admin/seasonal/shuttle-notice")) return "notice";
  if (pathname.startsWith("/admin/seasonal/shuttle")) return "roster";
  // 접두 충돌 주의: regular-dispatch 를 regular 보다 먼저 판정한다.
  if (pathname.startsWith("/admin/shuttle/regular-dispatch")) return "regular-dispatch";
  if (pathname.startsWith("/admin/shuttle/regular")) return "regular";
  if (pathname.startsWith("/admin/shuttle")) return "vehicle";
  return "";
}

export default function ShuttleSectionTabs() {
  const pathname = usePathname();
  const active = resolveActiveKey(pathname);
  return (
    <div className="mx-auto max-w-6xl px-4 pt-4">
      <nav className="flex gap-1 overflow-x-auto rounded-2xl border border-gray-200 bg-white p-1.5 dark:border-gray-700 dark:bg-gray-900" aria-label="셔틀 관리 메뉴">
        {ITEMS.map((it) => {
          const on = it.key === active;
          return (
            <Link key={it.key} href={it.href}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-sm font-bold ${on ? "bg-[var(--brand-accent-soft)] text-[var(--brand-accent)]" : "text-gray-500 hover:bg-gray-50 dark:hover:bg-gray-800"}`}>
              <span className="material-symbols-outlined text-xl">{it.icon}</span>
              {it.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
