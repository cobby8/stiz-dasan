"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

// 학부모 마이페이지 전용 하단 탭.
// 자녀 핵심 기능(리포트·스킬·방학특강)으로 바로 갈 수 있도록 구성한다.
// exact=true 인 홈만 정확히 일치할 때, 나머지는 하위 경로 포함으로 활성 판정.
const items = [
    { href: "/mypage", label: "홈", icon: "home", exact: true },
    { href: "/mypage/reports", label: "리포트", icon: "assignment", exact: false },
    { href: "/mypage/seasonal", label: "방학특강", icon: "sports_basketball", exact: false },
] as const;

export default function MyPageBottomNav() {
    // 선택한 메뉴는 공통 브랜드 포인트색으로 구분한다.
    // 현재 경로를 읽어 활성 탭을 강조한다(클라이언트 훅이므로 별도 컴포넌트로 분리).
    const pathname = usePathname();

    return (
        <nav
            aria-label="마이페이지 주요 메뉴"
            className="md:hidden fixed bottom-0 inset-x-0 bg-[var(--color-academy-surface)] border-t border-[var(--color-academy-line)] flex justify-around items-center h-16 pb-safe z-50"
        >
            {items.map((item) => {
                // 홈은 정확히 일치, 하위 페이지는 startsWith 로 활성 판정
                const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
                return (
                    <Link
                        key={item.href}
                        href={item.href}
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
                            {item.icon}
                        </span>
                        <span className="text-xs font-bold">{item.label}</span>
                    </Link>
                );
            })}
        </nav>
    );
}
