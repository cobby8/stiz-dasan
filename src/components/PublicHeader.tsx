"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import Image from "next/image";
import type { AppRole } from "@/lib/auth-routes";
import AppBackButton from "./AppBackButton";
import { useInstalledApp } from "./pwa/useInstalledApp";
import FontFreeIcon from "./ui/FontFreeIcon";

const DesktopAccountControls = dynamic(() => import("./PublicAccountControls").then(m => m.DesktopAccountControls), { ssr: false, loading: () => <Link href="/login" className="public-nav-link">로그인</Link> });
const MobileAccountControls = dynamic(() => import("./PublicAccountControls").then(m => m.MobileAccountControls), { ssr: false, loading: () => <Link href="/login" className="public-nav-link">로그인</Link> });
const groups = [
  { label: "수업 안내", items: [{ href: "/programs", label: "프로그램·수강료" }, { href: "/schedule", label: "수업시간표" }, { href: "/simulator", label: "우리 아이 수업 찾기" }, { href: "/annual", label: "연간일정표" }, { href: "/seasonal", label: "방학특강" }] },
  { label: "학원 소식", items: [{ href: "/notices", label: "공지사항" }, { href: "/gallery", label: "수업 사진" }, { href: "/faq", label: "자주 묻는 질문" }] },
];
interface PublicHeaderProps { phone: string; address: string; operatingHours?: string; accountRole?: AppRole | null }

const fontSnapshot = () => { try { return localStorage.getItem("fontSize") === "large"; } catch { return document.documentElement.classList.contains("text-large"); } };
const fontSubscribe = (listener: () => void) => { window.addEventListener("storage", listener); window.addEventListener("stiz:font-size", listener); return () => { window.removeEventListener("storage", listener); window.removeEventListener("stiz:font-size", listener); }; };

function HeaderContent({ phone, operatingHours, accountRole }: PublicHeaderProps) {
  const [open, setOpen] = useState(false);
  const large = useSyncExternalStore(fontSubscribe, fontSnapshot, () => false);
  const installed = useInstalledApp();
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { document.documentElement.classList.toggle("text-large", large); }, [large]);
  useEffect(() => {
    if (!open) return;
    const oldOverflow = document.body.style.overflow;
    const openerElement = opener.current;
    document.body.style.overflow = "hidden";
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keyboard = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
      if (e.key !== "Tab") return;
      // 닫힌 하위 메뉴 안의 링크는 이동 대상에서 제외합니다.
      const elements = [...(panel.current?.querySelectorAll<HTMLElement>('a[href],button,summary,input,select,[tabindex="0"]') ?? [])].filter(el => el.getClientRects().length > 0 && !el.hasAttribute("disabled"));
      const first = elements[0], last = elements.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keyboard);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener("keydown", keyboard); openerElement?.focus(); };
  }, [open]);

  const toggleFont = () => {
    const next = !large; document.documentElement.classList.toggle("text-large", next);
    try { localStorage.setItem("fontSize", next ? "large" : "normal"); } catch { /* 현재 화면에는 즉시 적용합니다. */ }
    window.dispatchEvent(new Event("stiz:font-size"));
  };
  const close = () => setOpen(false);
  const menuGroups = (mobile = false) => groups.map(group => <details key={group.label} className={mobile ? undefined : "public-nav-group"}>
    <summary>{group.label}<FontFreeIcon name="expand_more" size={18} /></summary>
    <div className={mobile ? undefined : "public-nav-dropdown"}>{group.items.map(item => <Link key={item.href} href={item.href} onClick={mobile ? close : e => e.currentTarget.closest("details")?.removeAttribute("open")} data-tour-target={`nav-${item.href.slice(1)}`}>{item.label}</Link>)}</div>
  </details>);

  return <>
    <header className="public-header">
      <div className="public-container public-header-row" data-installed={installed}>
        <div className="flex items-center gap-2">{installed && <AppBackButton fallbackHref="/" size="sm" className="!h-11 !w-11" />}<Link href="/" className="public-brand" aria-label="STIZ 다산2호점"><Image src="/stiz-logo.png" alt="STIZ 농구교실" width={180} height={45} priority /><span>다산2호점</span></Link></div>
        <nav className="public-desktop-nav" aria-label="홈페이지 주요 메뉴">
          <Link href="/about" className="public-nav-link" data-tour-target="nav-about">학원 소개</Link>{menuGroups()}<Link href="/about#location" className="public-nav-link">오시는 길</Link>
        </nav>
        <div className="public-header-actions">
          <div className="public-desktop-account"><DesktopAccountControls initialRole={accountRole} /></div>
          <Link href="/apply/trial" className="public-button">체험 신청</Link>
          <button ref={opener} type="button" className="public-icon-button" aria-label="메뉴 열기" aria-expanded={open} aria-controls="public-menu" data-tour-target="hamburger" onClick={() => setOpen(true)}><FontFreeIcon name="menu" size={22} /></button>
        </div>
      </div>
    </header>
    {open && <>
      <div className="public-menu-backdrop" aria-hidden="true" onClick={close} />
      <div ref={panel} id="public-menu" className="public-mobile-menu" role="dialog" aria-modal="true" aria-label="홈페이지 메뉴">
        <div className="public-mobile-menu-top"><strong>메뉴</strong><button className="public-icon-button" type="button" onClick={close} aria-label="메뉴 닫기"><FontFreeIcon name="close" size={22} /></button></div>
        <nav aria-label="홈페이지 전체 메뉴"><Link className="public-nav-link" href="/about" onClick={close}>학원 소개</Link>{menuGroups(true)}<Link className="public-nav-link" href="/about#location" onClick={close}>오시는 길</Link><Link className="public-nav-link" href="/apply" onClick={close}>체험·수강신청</Link></nav>
        <div className="public-mobile-menu-tools">
          <MobileAccountControls initialRole={accountRole} onNavigate={close} />
          <div className="flex flex-wrap gap-4"><Link href="/shop" onClick={close} className="public-link">클럽샵</Link><Link href="/apply/uniform" onClick={close} className="public-link">유니폼 주문</Link></div>
          <button className="public-button-secondary" type="button" onClick={toggleFont} aria-pressed={large}>{large ? "기본 글씨로 보기" : "큰 글씨로 보기"}</button>
          <a href={`tel:${phone.replace(/[^\d+]/g, "")}`} className="public-link">상담 {phone}</a>
          {operatingHours && <p className="text-sm">{operatingHours}</p>}
        </div>
      </div>
    </>}
  </>;
}

export default function PublicHeader(props: PublicHeaderProps) {
  const pathname = usePathname();
  return <HeaderContent key={pathname} {...props} />;
}
