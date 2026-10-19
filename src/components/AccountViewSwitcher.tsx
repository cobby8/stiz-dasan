"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { AccountViewOption } from "@/lib/account-views";
import { useInstalledApp } from "@/components/pwa/useInstalledApp";

type AccountViewSwitcherProps = {
  views: AccountViewOption[];
  variant?: "menu" | "list";
  placement?: "above" | "below";
  onNavigate?: (event: MouseEvent<HTMLAnchorElement>, view: AccountViewOption) => void;
};

/** 서버가 확인한 이용 화면만 보여준다. 화면 이동은 계정의 권한을 바꾸지 않는다. */
export default function AccountViewSwitcher({ views, variant = "menu", placement = "below", onNavigate }: AccountViewSwitcherProps) {
  const pathname = usePathname() || "/";
  const installed = useInstalledApp();
  const [open, setOpen] = useState(false);
  const [popupRight, setPopupRight] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const current = views.find(view => pathname === view.href || pathname.startsWith(`${view.href}/`));
  const scope = pathname.startsWith("/staff") ? "/staff" : pathname.startsWith("/mypage") ? "/mypage" : null;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    const onResize = () => setOpen(false);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  if (views.length < 2) return null;

  const options = (
    <nav aria-label="이용 화면 전환" className="space-y-1">
      <p className="px-3 pb-1 text-xs font-bold text-[var(--color-academy-muted)]">화면 전환</p>
      {views.map(view => {
        const active = view.key === current?.key;
        const outsideApp = installed && scope !== null && !(view.href === scope || view.href.startsWith(`${scope}/`));
        const className = "flex min-h-11 w-full items-center justify-between gap-3 rounded-xl px-3 py-2 text-sm font-bold text-[var(--color-academy-ink)]";
        return active ? (
          <span key={view.key} aria-current="page" className={`${className} bg-[var(--color-academy-primary-soft)] text-[var(--color-academy-primary)]`}>
            <span>{view.label}</span><span className="shrink-0 text-xs">현재 화면</span>
          </span>
        ) : (
          <Link key={view.key} href={view.href} prefetch={false} className={`${className} hover:bg-[var(--color-academy-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-academy-primary)]`}
            onClick={event => { onNavigate?.(event, view); setOpen(false); }}>
            <span className="min-w-0">
              <span className="block">{view.label}</span>
              {outsideApp && <span className="block text-xs font-medium text-[var(--color-academy-muted)]">앱 밖의 브라우저 화면으로 이동</span>}
            </span>
            <span className="material-symbols-outlined shrink-0 text-lg" aria-hidden="true">arrow_forward</span>
          </Link>
        );
      })}
    </nav>
  );

  if (variant === "list") return options;
  return (
    <div ref={containerRef} className={`relative min-w-0 shrink-0 ${placement === "above" ? "w-full" : ""}`}>
      <button ref={triggerRef} type="button" aria-label="화면 전환" aria-expanded={open} onClick={event => {
        const rect = event.currentTarget.parentElement!.getBoundingClientRect();
        const inset = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
        const width = Math.min(16 * inset, window.innerWidth - 2 * inset);
        const left = Math.max(inset, Math.min(rect.right - width, window.innerWidth - width - inset));
        setPopupRight(rect.right - left - width);
        setOpen(value => !value);
      }}
        className="inline-flex min-h-11 items-center justify-center gap-1 whitespace-nowrap rounded-xl px-2 text-xs font-bold text-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-soft)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-academy-primary)]">
        <span>{current?.label || "화면 전환"}</span>
        <span className="material-symbols-outlined shrink-0 text-lg" aria-hidden="true">expand_more</span>
      </button>
      {open && <div style={{ right: placement === "above" ? 0 : popupRight }} className={`absolute z-[70] max-w-[calc(100vw-2rem)] rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-2 shadow-xl ${placement === "above" ? "bottom-full mb-1 w-full" : "top-full mt-1 w-64"}`}>{options}</div>}
    </div>
  );
}
