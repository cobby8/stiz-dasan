"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// 학부모 앱 메뉴 4개 — 홈 · 수업 · 청구 · 소식 (2026-11-10 원장 결정 d5, 11-09 안 A 의 «일정» 자리를 «수업»으로).
// 휴대폰은 아래 탭, PC 는 헤더 가로 메뉴로 같은 4개를 쓴다(한 목록만 두어 둘이 어긋나지 않게).
// 방학특강 탭은 없앴다(D6) — 방학 기간에만 홈 «처리할 일»과 신청 화면에 나온다.
// 2026-11-13 UI 통일: 탭 아이콘을 빼고 글자만 둔다. 지금 있는 탭은 보조 색(하늘색) — 주 색(네이비)은 누르는 주 버튼 몫.
// 일정 달력(/mypage/history)은 주소를 그대로 두고 «수업» 탭 안 «달력 ▸»로 들어간다 — 그래서 수업 탭에 속한다.
// also = 이 탭에 속하는 하위 화면. 그 화면에 있을 때도 탭이 켜져 «지금 어디 있는지» 알 수 있다.
export const PARENT_TABS = [
    { href: "/mypage", label: "홈", also: [] as string[] },
    {
        href: "/mypage/classes",
        label: "수업",
        also: ["/mypage/history", "/mypage/regular-absence", "/mypage/makeup", "/mypage/seasonal", "/mypage/shuttle", "/mypage/enrollment-change"],
    },
    { href: "/mypage/payments", label: "청구", also: [] as string[] },
    { href: "/mypage/reports", label: "소식", also: ["/mypage/news"] },
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
                            // PC 메뉴 — 켜진 탭은 보조 색 연한 바탕 + 테두리 + 보조 색 글자(꽉 찬 색은 납부 버튼 몫)
                            className={`inline-flex min-h-11 items-center rounded-xl px-3 text-sm transition-colors ${
                                active
                                    ? "bg-[var(--color-academy-secondary-soft)] font-semibold text-[var(--color-academy-secondary-ink)] ring-1 ring-inset ring-[var(--color-academy-secondary-strong)]"
                                    : "font-medium text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)]"
                            }`}
                        >
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
                        // 글자만 — 지금 있는 탭은 위쪽 2px 띠 + 보조 색 글자 + 굵기(색만으로 알리지 않는다). 탭 높이(h-16)는 그대로
                        className={`flex h-full w-full items-center justify-center border-t-2 text-sm transition-colors ${
                            active
                                ? "border-[var(--color-academy-secondary-strong)] font-semibold text-[var(--color-academy-secondary-ink)]"
                                : "border-transparent font-medium text-[var(--color-academy-muted)]"
                        }`}
                    >
                        {tab.label}
                    </Link>
                );
            })}
        </nav>
    );
}
