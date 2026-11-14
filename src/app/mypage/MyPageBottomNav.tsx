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
    // 아이 기록(/mypage/record)은 홈 소속 — 홈 히어로 아래 한 줄에서 들어간다(2026-11-14 원장 결정 w1, 탭은 4개 그대로)
    // 보낸 문의(/mypage/requests)·신청 메뉴(/mypage/apply)·체육관 대관(/mypage/rental)·방학특강 신청(/mypage/seasonal/apply)도 홈 소속 — 홈의 한 줄 행에서 들어간다(2026-11-14 c3·c9)
    { href: "/mypage", label: "홈", also: ["/mypage/record", "/mypage/requests", "/mypage/apply", "/mypage/rental", "/mypage/seasonal/apply"] as string[] },
    {
        href: "/mypage/classes",
        label: "수업",
        also: ["/mypage/history", "/mypage/regular-absence", "/mypage/makeup", "/mypage/seasonal", "/mypage/shuttle", "/mypage/enrollment-change", "/mypage/annual"],
    },
    { href: "/mypage/payments", label: "청구", also: [] as string[] },
    { href: "/mypage/reports", label: "소식", also: ["/mypage/news"] },
] as const;

/**
 * 현재 경로에서 이 탭이 켜져야 하는지. 홈은 정확히 /mypage 이거나 홈 소속 화면(also)일 때만(모든 /mypage/* 를 먹지 않게).
 * 여러 탭의 주소가 겹치면 «더 긴 주소»가 이긴다 — 방학특강 신청(/mypage/seasonal/apply, 홈 «신청» 메뉴 소속)이
 * 수업 탭의 /mypage/seasonal(결석·보강)에 먹히지 않게(코드 리뷰 F9). 탭은 언제나 하나만 켜진다.
 */
export function isParentTabActive(tab: (typeof PARENT_TABS)[number], pathname: string): boolean {
    const under = (base: string) => pathname === base || pathname.startsWith(`${base}/`);
    if (pathname === "/mypage") return tab.href === "/mypage";
    // 탭마다 이 경로와 맞는 가장 긴 주소 길이(홈의 /mypage 자체는 정확히 일치할 때만이라 여기서는 뺀다)
    const best = (t: (typeof PARENT_TABS)[number]) =>
        Math.max(0, ...[...(t.href === "/mypage" ? [] : [t.href]), ...t.also].filter(under).map((base) => base.length));
    const mine = best(tab);
    return mine > 0 && PARENT_TABS.every((other) => other === tab || best(other) < mine);
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

    // 아래 탭 높이(2026-11-14 원장 «아이폰 하단 메뉴 아래 빈 공간이 넓다»):
    //  - 아이폰 앱은 웹 화면을 홈 인디케이터 위(안전영역)까지만 그린다(WebViewController 의 safeAreaLayoutGuide).
    //    그 아래 34pt 는 앱이 비워 두는 자리라 웹이 줄일 수 없다.
    //  - 그 위에 글자만 있는 탭이 64px(h-16, 아이콘을 뺀 뒤에도 높이를 그대로 뒀다)이라 합쳐 98pt — 아이폰 기본 탭(49+34)보다 크게 비어 보였다.
    //  - 그래서 탭을 48px(h-12, 누르는 영역 44px 이상)로 줄여 48+34 = 82pt(기본 탭과 같은 크기).
    //  - 예전 «pb-safe» 는 정의가 없는 글자(아무 효과 없음)였다. 브라우저·앞으로 앱이 화면을 끝까지 그리게 될 때를 위해
    //    안전영역 여백은 env(safe-area-inset-bottom) 으로 탭 «아래»에 붙인다(지금 앱·viewport-fit 없는 브라우저에선 0).
    return (
        <nav
            aria-label="마이페이지 주요 메뉴"
            className="md:hidden fixed bottom-0 inset-x-0 bg-[var(--color-academy-surface)] border-t border-[var(--color-academy-line)] flex justify-around items-stretch pb-[env(safe-area-inset-bottom)] z-50"
        >
            {PARENT_TABS.map((tab) => {
                const active = isParentTabActive(tab, pathname);
                return (
                    <Link
                        key={tab.href}
                        href={tab.href}
                        aria-current={active ? "page" : undefined}
                        // 글자만 — 지금 있는 탭은 위쪽 2px 띠 + 보조 색 글자 + 굵기(색만으로 알리지 않는다). 탭 높이 48px(h-12)
                        className={`flex h-12 w-full items-center justify-center border-t-2 text-sm transition-colors ${
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
