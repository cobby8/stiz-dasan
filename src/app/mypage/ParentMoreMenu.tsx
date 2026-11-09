"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// 학부모 헤더 «⋯» 메뉴 (2026-11-09 원장 결정 D8).
// 로그아웃은 자주 쓰지 않는 버튼이라 헤더 일등석 자리에서 이 메뉴 안으로 옮겼다.
// 로그아웃 폼(서버 동작)은 layout 이 children 으로 넣어 준다 — 이 부품은 «열고 닫기»만 맡는다.
const MENU_LINKS = [
    { href: "/mypage#mypage-notifications", icon: "notifications", label: "알림·휴대폰 알림 설정" },
    { href: "/mypage/children", icon: "family_restroom", label: "자녀·가족 연결" },
    { href: "/mypage/consult", icon: "support_agent", label: "형제·자매 상담 신청" }, // 2026-11-10 상담 신청 신설(원장 k1·m4)
    // «수강 변경 신청»은 2026-11-10 «수업» 탭 반 카드의 [반 변경·휴원 ▾]로 옮겼다(원장 결정 d5) — 여기서 뺐다.
    { href: "/mypage/login-methods", icon: "key", label: "간편로그인 연결" },
] as const;

export default function ParentMoreMenu({ children }: { children: React.ReactNode }) {
    const [open, setOpen] = useState(false);
    const boxRef = useRef<HTMLDivElement>(null);
    const pathname = usePathname();

    // 다른 화면으로 옮겨 가면 메뉴를 닫는다(레이아웃은 그대로 남아 있어 저절로 안 닫힌다)
    useEffect(() => { setOpen(false); }, [pathname]);

    // 바깥을 누르거나 Esc 를 누르면 닫는다
    useEffect(() => {
        if (!open) return;
        const onDown = (e: PointerEvent) => {
            if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("pointerdown", onDown);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    return (
        <div ref={boxRef} className="relative">
            <button
                type="button"
                aria-label="더보기 메뉴"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                // 누르는 영역 44×44(터치 최소 크기)
                className="inline-flex size-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] transition-colors hover:bg-[var(--color-academy-soft)] hover:text-[var(--color-academy-ink)]"
            >
                <span className="material-symbols-outlined leading-none" style={{ fontSize: "24px" }} aria-hidden="true">more_horiz</span>
            </button>
            {open && (
                <div
                    role="menu"
                    className="absolute right-0 top-12 z-[60] w-60 overflow-hidden rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] py-1 shadow-lg"
                >
                    {MENU_LINKS.map((item) => {
                        const className = "flex min-h-11 items-center gap-2 px-3 text-sm font-bold text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]";
                        const body = (
                            <>
                                <span className="material-symbols-outlined leading-none text-[var(--color-academy-muted)]" style={{ fontSize: "18px" }} aria-hidden="true">{item.icon}</span>
                                {item.label}
                            </>
                        );
                        // «#» 이 붙은 주소는 일반 링크(a)로 — 홈에 있을 때도 브라우저가 hashchange 를 내서
                        // 홈 화면이 알림 칸을 펼친다(Next 의 Link 는 주소만 바꾸고 이 신호를 안 낸다).
                        return item.href.includes("#") ? (
                            <a key={item.href} href={item.href} role="menuitem" onClick={() => setOpen(false)} className={className}>{body}</a>
                        ) : (
                            <Link key={item.href} href={item.href} role="menuitem" onClick={() => setOpen(false)} className={className}>{body}</Link>
                        );
                    })}
                    {/* 구분선 아래 = 로그아웃(위험도는 낮지만 자주 안 쓰는 동작이라 맨 끝) */}
                    <div className="mt-1 border-t border-[var(--color-academy-line)] px-2 pt-1">{children}</div>
                </div>
            )}
        </div>
    );
}
