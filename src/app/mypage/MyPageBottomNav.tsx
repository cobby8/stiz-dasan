"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// 학부모 앱 메뉴 4개 — 홈 · 일정 · 청구 · 소식 (2026-11-09 원장 결정 D1 안 A).
// 휴대폰은 아래 탭, PC 는 헤더 가로 메뉴로 같은 4개를 쓴다(한 목록만 두어 둘이 어긋나지 않게).
// 방학특강 탭은 없앴다(D6) — 방학 기간에만 홈 «처리할 일»과 일정 탭에 나온다.
// also = 이 탭에 속하는 하위 화면. 그 화면에 있을 때도 탭이 켜져 «지금 어디 있는지» 알 수 있다.
export const PARENT_TABS = [
    { href: "/mypage", label: "홈", icon: "home", also: [] as string[] },
    {
        href: "/mypage/history",
        label: "일정",
        icon: "calendar_month",
        also: ["/mypage/regular-absence", "/mypage/makeup", "/mypage/seasonal", "/mypage/shuttle", "/mypage/enrollment-change"],
    },
    { href: "/mypage/payments", label: "청구", icon: "receipt_long", also: [] as string[] },
    { href: "/mypage/reports", label: "소식", icon: "campaign", also: ["/mypage/news"] },
] as const;

/** 현재 경로에서 이 탭이 켜져야 하는지. 홈은 정확히 /mypage 일 때만. */
export function isParentTabActive(tab: (typeof PARENT_TABS)[number], pathname: string): boolean {
    if (tab.href === "/mypage") return pathname === "/mypage";
    const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
    return under(tab.href) || tab.also.some(under);
}

// variant="bottom" = 휴대폰 아래 탭(기본) · variant="top" = PC 헤더 가로 메뉴
export default function MyPageBottomNav({ variant = "bottom" }: { variant?: "bottom" | "top" }) {
    // 현재 경로를 읽어 활성 탭을 강조한다(클라이언트 훅이므로 별도 컴포넌트로 분리).
    const pathname = usePathname() ?? "";

    if (variant === "top") {
        return (
            <nav aria-label="학부모 메뉴" className="flex items-center gap-1">
                {PARENT_TABS.map((tab) => {
                    const active = isParentTabActive(tab, pathname);
                    return (
                        <Link
                            key={tab.href}
                            href={tab.href}
                            aria-current={active ? "page" : undefined}
                            // PC 메뉴 — 켜진 탭은 연한 바탕 + 포인트색 글자(꽉 찬 색은 납부 버튼 몫)
                            className={`inline-flex min-h-11 items-center gap-1.5 rounded-xl px-3 text-sm font-bold transition-colors ${
                                active
                                    ? "bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]"
                                    : "text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)]"
                            }`}
                        >
                            <span className="material-symbols-outlined leading-none" style={{ fontSize: "20px" }} aria-hidden="true">{tab.icon}</span>
                            {tab.label}
                        </Link>
                    );
                })}
            </nav>
        );
    }

    return (
        <nav
            aria-label="마이페이지 주요 메뉴"
            className="md:hidden fixed bottom-0 inset-x-0 bg-[var(--color-academy-surface)] border-t border-[var(--color-academy-line)] flex justify-around items-center h-16 pb-safe z-50"
        >
            {PARENT_TABS.map((tab) => {
                const active = isParentTabActive(tab, pathname);
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        aria-current={active ? "page" : undefined}
                        className={`flex flex-col items-center justify-center w-full h-full gap-1 transition-colors ${
                            active ? "text-[var(--color-academy-primary)]" : "text-[var(--color-academy-muted)]"
                        }`}
                    >
                        <span
                            className={`material-symbols-outlined leading-none ${active ? "[font-variation-settings:'FILL'_1]" : ""}`}
                            style={{ fontSize: "24px" }}
                            aria-hidden="true"
                        >
                            {tab.icon}
                        </span>
                        <span className="text-xs font-bold">{tab.label}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
