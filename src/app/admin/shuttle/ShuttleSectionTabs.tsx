"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// 셔틀 관리 전용 탭 바 — 방학특강 셔틀(배차·명단) + 정규 셔틀 + 차량 관리를 한 곳에 모은다.
// (방학특강 운영 탭바 SeasonalSectionTabs와 분리)

// 2026-11-13 UI 통일: 탭은 아이콘 없이 글자만, 지금 있는 탭은 보조 색(하늘색)으로 표시한다.
const ITEMS: Array<{ key: string; href: string; label: string }> = [
  // 「신규 셔틀 신청」 탭은 2026-11-05 정규 배차 화면(신규 배차 학생 줄)으로 합쳤다. 옛 주소는 정규 배차로 넘어간다.
  // 매달 사용하는 정규 수업 메뉴를 앞에 두고, 계절성 방학특강 메뉴는 뒤로 배치한다.
  { key: "regular-dispatch", href: "/admin/shuttle/regular-dispatch", label: "정규 배차" },
  { key: "regular", href: "/admin/shuttle/regular", label: "셔틀 명단" },
  { key: "vehicle", href: "/admin/shuttle", label: "차량 관리" },
  { key: "notice", href: "/admin/seasonal/shuttle-notice", label: "등원시간 안내" },
  { key: "dispatch", href: "/admin/seasonal/dispatch", label: "방학특강 배차" },
  { key: "roster", href: "/admin/seasonal/shuttle", label: "방학특강 명단" },
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
      <nav className="flex gap-1 overflow-x-auto rounded-2xl border border-[var(--color-academy-line)] bg-white p-1.5" aria-label="셔틀 관리 메뉴">
        {ITEMS.map((it) => {
          const on = it.key === active;
          return (
            <Link key={it.key} href={it.href} aria-current={on ? "page" : undefined}
              className={`flex min-h-11 shrink-0 items-center gap-2 rounded-xl px-4 text-sm ${on ? "bg-[var(--color-academy-secondary-soft)] font-semibold text-[var(--color-academy-secondary-ink)] ring-1 ring-inset ring-[var(--color-academy-secondary-strong)]" : "font-medium text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"}`}>
              {it.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
