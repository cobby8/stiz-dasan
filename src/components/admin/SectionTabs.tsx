import Link from "next/link";
import type { AdminSectionTab } from "@/lib/admin-sections";

/**
 * 관리자 화면 위 «탭 줄» 공용 부품 — 2026-11-13 관리자 메뉴 정리.
 *
 * 셔틀(ShuttleSectionTabs)·방학특강(SeasonalSectionTabs) 탭 줄과 같은 모양을 따른다.
 * 상태(hook)를 갖지 않는 그리기 전용 부품이다 — 어느 탭이 켜질지는 부르는 쪽이
 * `findAdminSection()`(src/lib/admin-sections.ts)으로 정해 넘긴다.
 *
 * - 탭이 화면 폭보다 많으면 줄바꿈 대신 가로로 밀어 본다(overflow-x-auto). 모바일에서도 한 줄 유지.
 * - 누르는 영역은 44px(min-h-11) 이상.
 * - 색은 학원 테마 토큰만 쓴다(하드코딩 색 금지).
 */
export default function SectionTabs({
    label,
    tabs,
    activeHref,
}: {
    /** 화면 낭독기가 읽는 탭 줄 이름(예: "청구·수납") */
    label: string;
    tabs: readonly AdminSectionTab[];
    /** 켜진 탭의 href */
    activeHref: string;
}) {
    return (
        <nav
            aria-label={`${label} 화면 이동`}
            className="mb-4 flex gap-1 overflow-x-auto rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-1"
        >
            {tabs.map((tab) => {
                const on = tab.href === activeHref;
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        prefetch={false}
                        aria-current={on ? "page" : undefined}
                        className={`flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-sm font-bold transition-colors ${on
                            ? "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]"
                            : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)]"
                            }`}
                    >
                        <span className="material-symbols-outlined text-lg leading-none" aria-hidden="true">{tab.icon}</span>
                        {tab.label}
                    </Link>
                );
            })}
        </nav>
    );
}
