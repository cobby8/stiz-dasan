"use client";

/**
 * PublicHeader — 통합 공개 페이지 헤더
 *
 * 카테고리 드롭다운 방식:
 * - 넓은 PC: 같은 헤더 안의 드롭다운 메뉴
 * - 공간이 좁은 화면·큰 글씨: 같은 헤더의 전체 메뉴 버튼
 *
 * 메뉴 구조:
 *   학원 소개 | 수업 안내 v | 소식/안내 v | SHOP | 수업찾기 | [신청하기]
 *   + FAQ, 이용약관은 "소식/안내" 드롭다운 하위에 배치
 */

import UiIcon from "@/components/common/UiIcon";
import { useState, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import Image from "next/image";
import { ThemeToggle } from "./ThemeToggle";
import type { AppRole } from "@/lib/auth-routes";
import AppBackButton from "@/components/AppBackButton";
import { useHeaderMenuFit } from "./useHeaderMenuFit";
import { usePublicOverlayOpen } from "./public-floating";

const MOBILE_ACCOUNT_FALLBACK_ACTION_CLASS = [
  "flex min-h-11 items-center justify-center rounded-xl border border-[var(--color-public-line)] bg-white text-sm font-bold",
  "text-[var(--color-public-muted)] transition-colors hover:bg-[var(--color-public-tint)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-ink)]",
].join(" ");

const DesktopAccountControls = dynamic<{ initialRole?: AppRole | null }>(
  () => import("./PublicAccountControls").then((mod) => mod.DesktopAccountControls),
  {
    ssr: false,
    loading: () => <DesktopAccountFallback />,
  }
);

const MobileAccountControls = dynamic<{ onNavigate?: () => void; initialRole?: AppRole | null }>(
  () => import("./PublicAccountControls").then((mod) => mod.MobileAccountControls),
  {
    ssr: false,
    loading: () => <MobileAccountFallback />,
  }
);

// 부모(Server Component)에서 전달받을 props 타입
interface PublicHeaderProps {
  phone: string;
  address: string;
  operatingHours?: string;
  accountRole?: AppRole | null;
}

// ---------- 메뉴 데이터 구조 ----------

// 카테고리 드롭다운 그룹 — 각 그룹은 hover 시 하위 메뉴가 펼쳐진다
const NAV_GROUPS = [
  {
    label: "수업 안내",
    items: [
      { href: "/programs", label: "프로그램안내" },
      { href: "/seasonal", label: "방학특강" },
      { href: "/schedule", label: "수업시간표" },
      { href: "/annual", label: "연간일정표" },
      { href: "/rental", label: "체육관 대관" },
    ],
  },
  {
    label: "소식/안내",
    items: [
      { href: "/notices", label: "공지사항" },
      { href: "/gallery", label: "포토갤러리" },
      { href: "/faq", label: "자주 묻는 질문" },
      { href: "/terms", label: "이용약관" },
    ],
  },
];

// 독립 메뉴 — 드롭다운 없이 바로 링크
const NAV_STANDALONE = [
  { href: "/about", label: "학원 소개" },
  { href: "/shop", label: "SHOP" },
  { href: "/simulator", label: "수업찾기" },
];

const DEFAULT_OPERATING_HOURS = "평일 13:00~21:00 / 토 09:00~18:00 (일요일·공휴일 휴무)";

function DesktopAccountFallback() {
  return (
    <Link
      href="/login"
      className={[
        "hidden md:inline-flex items-center rounded-xl border border-[var(--color-public-line)] px-3 py-2 text-sm font-bold",
        "text-[var(--color-public-muted)] transition-colors hover:border-[var(--color-public-muted)] hover:bg-[var(--color-public-tint)] hover:text-[var(--color-public-strong)]",
        "dark:border-[var(--color-public-line)] dark:text-[var(--color-public-ink)] dark:hover:border-brand-neon-lime/40 dark:hover:bg-brand-neon-lime/10 dark:hover:text-brand-neon-lime",
      ].join(" ")}
    >
      로그인
    </Link>
  );
}

function MobileAccountFallback() {
  return (
    <div className="grid grid-cols-2 gap-2 mb-3">
      <Link
        href="/login"
        className="flex min-h-11 items-center justify-center rounded-xl border border-[var(--color-public-line)] bg-white text-sm font-bold text-[var(--color-public-strong)] transition-colors hover:bg-[var(--color-public-tint)] dark:border-brand-neon-lime/30 dark:bg-[var(--color-public-paper)] dark:text-brand-neon-lime"
      >
        로그인
      </Link>
      <Link
        href="/staff/quick-post"
        aria-label="사진 올리기"
        title="사진 올리기"
        className={MOBILE_ACCOUNT_FALLBACK_ACTION_CLASS}
      >
        사진 올리기
      </Link>
    </div>
  );
}

export default function PublicHeader({
  phone,
  address,
  operatingHours,
  accountRole = null,
}: PublicHeaderProps) {
  // 모바일 사이드바 열림/닫힘 상태
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  // 모바일 메뉴(서랍)가 열린 동안 챗봇·입학 가이드 플로팅 버튼을 숨긴다(게슈탈트 C-P3)
  usePublicOverlayOpen(isMobileMenuOpen);
  const mobileMenuRef = useRef<HTMLDivElement>(null);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMenuCloseRef = useRef<HTMLButtonElement>(null);
  const { collapsed, rowRef, brandRef, navRef, actionsRef, accountsRef } = useHeaderMenuFit();

  // 스크롤 위치 추적 — 스크롤하면 헤더 배경을 불투명하게 만든다 (glassmorphism)
  const [isScrolled, setIsScrolled] = useState(false);

  // 큰글씨 모드 상태 — localStorage에 저장하여 새로고침 후에도 유지
  const [isLargeFont, setIsLargeFont] = useState(false);
  const displayOperatingHours = operatingHours?.trim() || DEFAULT_OPERATING_HOURS;

  useEffect(() => {
    const handleScroll = () => {
      // 50px 이상 스크롤하면 배경 변경
      setIsScrolled(window.scrollY > 50);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    // 초기 상태도 확인 (페이지 중간에서 새로고침할 수 있으므로)
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // 큰글씨 모드: localStorage에서 초기값 로드 (SSR 호환을 위해 useEffect 안에서 실행)
  useEffect(() => {
    const saved = localStorage.getItem("fontSize");
    if (saved === "large") {
      setIsLargeFont(true);
      document.documentElement.classList.add("text-large");
    }
  }, []);

  // 큰글씨 모드 토글 핸들러
  const toggleFontSize = () => {
    const nextIsLarge = !isLargeFont;
    setIsLargeFont(nextIsLarge);
    if (nextIsLarge) {
      document.documentElement.classList.add("text-large");
      localStorage.setItem("fontSize", "large");
    } else {
      document.documentElement.classList.remove("text-large");
      localStorage.setItem("fontSize", "normal");
    }
  };

  // 메뉴가 열린 동안만 스크롤과 키보드 포커스를 메뉴 안에 유지한다.
  useEffect(() => {
    if (!isMobileMenuOpen) return;
    const previousOverflow = document.body.style.overflow;
    const returnFocus = mobileMenuTriggerRef.current;
    document.body.style.overflow = "hidden";
    const focusFrame = requestAnimationFrame(() => mobileMenuCloseRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsMobileMenuOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const menu = mobileMenuRef.current;
      const controls = Array.from(menu?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0 && !element.closest("[inert]"));
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (!menu?.contains(active) || (event.shiftKey ? active === first : active === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (returnFocus?.isConnected) returnFocus.focus();
    };
  }, [isMobileMenuOpen]);

  // 서랍을 연 채 넓은 화면으로 바꾸면 가려진 메뉴와 스크롤 잠금을 해제한다.
  useEffect(() => {
    if (collapsed) return;
    const frame = requestAnimationFrame(() => setIsMobileMenuOpen(false));
    return () => cancelAnimationFrame(frame);
  }, [collapsed]);

  return (
    <>
      {/* 유틸리티 바 — 운영시간 + 전화번호 (데스크탑만 표시) */}
      <div className="public-utility-bar bg-[var(--color-public-dark)] dark:bg-black text-white text-xs py-2 hidden md:block border-b border-white/10 dark:border-white/5">
        <div className="max-w-6xl mx-auto px-4 flex justify-between items-center">
          <span className="text-[var(--color-public-dark-muted)]">{displayOperatingHours}</span>
          <div className="flex items-center gap-3">
            <span>상담문의: {phone}</span>
            {/* 큰글씨 모드 토글 — 학부모 편의를 위한 글씨 크기 변경 버튼 */}
            <button
              onClick={toggleFontSize}
              className={[
                "flex items-center gap-1 px-2 py-0.5 rounded text-xs font-bold transition-colors",
                isLargeFont
                  ? "bg-[var(--color-public-dark)] dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white"
                  : "bg-gray-700 text-[var(--color-public-dark-muted)] hover:bg-gray-600",
              ].join(" ")}
              aria-label={isLargeFont ? "기본 글씨 크기로 변경" : "큰 글씨 모드로 변경"}
              title={isLargeFont ? "기본 글씨" : "큰 글씨"}
            >
              <span className="text-sm font-bold leading-none">가</span>
              <span className="leading-none">{isLargeFont ? "크게" : "보통"}</span>
            </button>
          </div>
        </div>
      </div>

      {/* 메인 헤더 — 스크롤 시 glassmorphism 효과 적용 */}
      <header
        data-menu-layout={collapsed ? "drawer" : "expanded"}
        className={[
          "public-site-header sticky top-0 z-50 transition-all duration-300",
          isScrolled
            ? "bg-white/95 dark:bg-[var(--color-public-paper)]/95 backdrop-blur-md shadow-md border-b border-[var(--color-public-line)] dark:border-[var(--color-public-line)]"
            : "bg-white dark:bg-[var(--color-public-paper)] shadow-sm border-b border-[var(--color-public-line)] dark:border-[var(--color-public-line)]",
        ].join(" ")}
      >
        <div ref={rowRef} className="public-header-row max-w-6xl mx-auto px-4 py-3 md:py-4 flex items-center justify-between">
          {/* 로고 + 지점명 */}
          <div ref={brandRef} className="flex min-w-0 items-center gap-2 sm:gap-3">
            <AppBackButton fallbackHref="/" size="sm" />
            <Link href="/" className="flex min-w-0 items-center gap-2 sm:gap-3">
              <Image
                src="/stiz-logo.png"
                alt="STIZ"
                width={180}
                height={45}
                className="h-10 sm:h-12 w-auto object-contain dark:brightness-0 dark:invert"
                priority
              />
              <span className="hidden font-bold text-lg text-[var(--color-public-ink)] dark:text-white sm:inline sm:text-xl">
                다산2호점
              </span>
            </Link>
          </div>

          {/* ===== 데스크탑 네비게이션 ===== */}
          {/* 순서: 학원 소개 | 수업 안내 v | 소식/안내 v | SHOP | 수업찾기 | [신청하기] */}
          <nav ref={navRef} inert={collapsed} aria-hidden={collapsed} aria-label="주요 메뉴" className="public-desktop-nav hidden md:flex items-center gap-1 font-medium text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
            {/* 학원 소개 — 독립 링크, 맨 앞 배치 */}
            <Link
              href="/about"
              data-tour-target="nav-about"
              className="relative px-3 py-2 rounded-lg hover:text-[var(--color-public-accent)] dark:hover:text-brand-neon-lime hover:bg-[var(--color-public-tint)] dark:hover:bg-brand-neon-lime/10  dark:hover:bg-brand-neon-lime/10 transition-colors"
            >
              학원 소개
            </Link>

            {/* 카테고리 드롭다운 그룹 — group/group-hover CSS로 구현 (JS 상태 불필요) */}
            {NAV_GROUPS.map((group) => (
              <div key={group.label} className="public-nav-group relative group">
                {/* 카테고리 라벨 버튼 — hover 시 드롭다운이 열린다 */}
                <button
                  className="flex items-center gap-1 px-3 py-2 rounded-lg hover:text-[var(--color-public-accent)] dark:hover:text-brand-neon-lime hover:bg-[var(--color-public-tint)] dark:hover:bg-brand-neon-lime/10  dark:hover:bg-brand-neon-lime/10 transition-colors"
                >
                  {group.label}
                  {/* 화살표 — hover 시 회전 */}
                  <UiIcon name="expand_more" className="transition-transform duration-200 group-hover:rotate-180 group-focus-within:rotate-180" />
                </button>

                {/* 드롭다운 패널 — group-hover로 보이기/숨기기 */}
                <div className="public-nav-panel absolute top-full left-0 pt-1 invisible opacity-0 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100 transition-all duration-200">
                  <div className="bg-white dark:bg-[var(--color-public-tint)] rounded-lg shadow-lg border border-[var(--color-public-line)] dark:border-[var(--color-public-line)] py-2 min-w-[180px]">
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        // data-tour-target: href에서 슬래시 제거 + 해시는 하이픈으로 변환
                        data-tour-target={`nav-${item.href.slice(1).replace("#", "-")}`}
                        className="block px-4 py-2.5 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] hover:text-[var(--color-public-accent)] dark:hover:text-brand-neon-lime hover:bg-[var(--color-public-tint)] dark:hover:bg-[var(--color-public-line)] transition-colors text-sm font-medium"
                      >
                        {item.label}
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            ))}

            <Link
              href="/shop"
              data-tour-target="nav-shop"
              className="relative px-3 py-2 rounded-lg hover:text-[var(--color-public-accent)] dark:hover:text-brand-neon-lime hover:bg-[var(--color-public-tint)] dark:hover:bg-brand-neon-lime/10  dark:hover:bg-brand-neon-lime/10 transition-colors"
            >
              SHOP
            </Link>

            {/* 수업찾기 — 독립 링크, 드롭다운 뒤 배치 */}
            <Link
              href="/simulator"
              data-tour-target="nav-simulator"
              className="relative px-3 py-2 rounded-lg hover:text-[var(--color-public-accent)] dark:hover:text-brand-neon-lime hover:bg-[var(--color-public-tint)] dark:hover:bg-brand-neon-lime/10  dark:hover:bg-brand-neon-lime/10 transition-colors"
            >
              수업찾기
            </Link>
          </nav>

          <div ref={actionsRef} className="public-header-actions flex items-center gap-1 sm:gap-2 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]">
            <ThemeToggle />
            {/* 큰글씨 모드 토글 (모바일 전용) — 유틸리티 바가 안 보이는 모바일에서도 접근 가능 */}
            <button
              onClick={toggleFontSize}
              className={[
                // 게슈탈트 P-13: 터치 영역 44px(h-11 w-11)
                "public-mobile-font md:hidden flex h-11 w-11 items-center justify-center rounded-lg text-xs font-bold transition-colors",
                isLargeFont
                  ? "bg-[var(--color-public-accent)] dark:bg-brand-neon-lime dark:text-brand-navy-900 text-white"
                  : "bg-[var(--color-public-tint)] dark:bg-[var(--color-public-tint)] text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] hover:bg-[var(--color-public-line)] dark:hover:bg-[var(--color-public-line)]",
              ].join(" ")}
              aria-label={isLargeFont ? "기본 글씨 크기로 변경" : "큰 글씨 모드로 변경"}
            >
              <span className="text-sm font-bold leading-none">가</span>
            </button>

            <div ref={accountsRef} className="public-desktop-accounts flex items-center gap-1 sm:gap-2" inert={collapsed} aria-hidden={collapsed}>
              <DesktopAccountControls initialRole={accountRole} />
            </div>

            {/* CTA 버튼 — "신청하기"로 변경 */}
            <Link
              href="/apply"
              className={[
                "bg-[var(--color-public-accent)] dark:bg-brand-neon-lime hover:bg-[var(--color-public-strong)] dark:hover:bg-lime-400 text-white dark:text-brand-navy-900 font-bold",
                "px-4 py-2 rounded-xl text-sm transition-all duration-200",
                "hover:scale-[1.02] hover:shadow-lg dark:shadow-brand-neon-lime/20 active:scale-[0.98]",
                "hidden sm:inline-flex items-center",
              ].join(" ")}
            >
              신청하기
            </Link>

            {/* 모바일 햄버거 버튼 */}
            <button
              ref={mobileMenuTriggerRef}
              data-tour-target="hamburger"
              onClick={() => setIsMobileMenuOpen(true)}
              className="public-menu-trigger md:hidden p-2 rounded-lg hover:bg-[var(--color-public-tint)] dark:hover:bg-[var(--color-public-tint)] transition-colors text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]"
              aria-label="메뉴 열기"
              aria-expanded={isMobileMenuOpen}
            >
              <span className="public-menu-label text-sm font-medium"><span className="public-menu-prefix">전체 </span>메뉴</span>
            </button>
          </div>
        </div>
      </header>

      {/* 모바일 사이드바 오버레이 — 배경 딤 처리 */}
      {isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-[60] bg-black/50 transition-opacity"
          onClick={() => setIsMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ===== 모바일 사이드바 — 카테고리 라벨 + 구분선으로 그룹핑 ===== */}
      <div
        ref={mobileMenuRef}
        role="dialog"
        aria-label="전체 메뉴"
        aria-modal={isMobileMenuOpen ? true : undefined}
        aria-hidden={!isMobileMenuOpen}
        inert={!isMobileMenuOpen}
        className={[
          "public-mobile-menu fixed top-0 right-0 z-[70] flex h-full w-72 flex-col bg-white dark:bg-[var(--color-public-paper)] shadow-2xl",
          "transform transition-transform duration-300 ease-in-out",
          isMobileMenuOpen ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {/* 사이드바 상단 — 닫기 버튼 */}
        <div className="flex shrink-0 items-center justify-between p-4 border-b border-[var(--color-public-line)] dark:border-[var(--color-public-line)]">
          <span className="font-bold text-[var(--color-public-ink)] dark:text-white">메뉴</span>
          <button
            ref={mobileMenuCloseRef}
            onClick={() => setIsMobileMenuOpen(false)}
            className="flex min-h-11 items-center justify-center px-3 text-sm font-medium rounded-lg hover:bg-[var(--color-public-tint)] dark:hover:bg-[var(--color-public-tint)] transition-colors text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)]"
            aria-label="메뉴 닫기"
          >
            닫기
          </button>
        </div>

        {/* 사이드바 메뉴 — 순서: 학원 소개 → 수업 안내 → 소식/안내 → SHOP → 수업찾기 */}
        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-2">
          {/* 학원 소개 — 독립 링크, 맨 앞 배치 */}
          <Link
            href="/about"
            data-tour-target="mobile-nav-about"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-6 py-3 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] font-semibold hover:bg-[var(--color-public-tint)] dark:hover:bg-brand-neon-lime/10 hover:text-[var(--color-public-accent)] dark:hover:text-brand-neon-lime transition-colors"
          >
            학원 소개
          </Link>

          <div className="mx-4 my-2 border-t border-[var(--color-public-line)] dark:border-[var(--color-public-line)]" />

          {/* 카테고리 그룹들 */}
          {NAV_GROUPS.map((group, groupIdx) => (
            <div key={group.label}>
              {/* 카테고리 라벨 — 작은 회색 텍스트로 그룹 구분 */}
              <div className="px-6 pt-4 pb-1">
                <span className="text-xs font-bold text-[var(--color-public-muted)] uppercase tracking-wider">
                  {group.label}
                </span>
              </div>
              {/* 하위 메뉴 링크들 */}
              {group.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  data-tour-target={`mobile-nav-${item.href.slice(1).replace("#", "-")}`}
                  onClick={() => setIsMobileMenuOpen(false)}
                  className="block px-6 py-2.5 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] font-medium hover:bg-[var(--color-public-tint)] dark:hover:bg-brand-neon-lime/10 hover:text-[var(--color-public-accent)] dark:hover:text-brand-neon-lime transition-colors"
                >
                  {item.label}
                </Link>
              ))}
              {/* 그룹 사이 구분선 */}
              {groupIdx < NAV_GROUPS.length - 1 && (
                <div className="mx-4 my-2 border-t border-[var(--color-public-line)] dark:border-[var(--color-public-line)]" />
              )}
            </div>
          ))}

          <div className="mx-4 my-2 border-t border-[var(--color-public-line)] dark:border-[var(--color-public-line)]" />
          <Link
            href="/shop"
            data-tour-target="mobile-nav-shop"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-6 py-3 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] font-semibold hover:bg-[var(--color-public-tint)] dark:hover:bg-brand-neon-lime/10 hover:text-[var(--color-public-accent)] dark:hover:text-brand-neon-lime transition-colors"
          >
            SHOP
          </Link>

          {/* 수업찾기 — 독립 링크, 맨 뒤 배치 */}
          <div className="mx-4 my-2 border-t border-[var(--color-public-line)] dark:border-[var(--color-public-line)]" />
          <Link
            href="/simulator"
            data-tour-target="mobile-nav-simulator"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block px-6 py-3 text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] font-semibold hover:bg-[var(--color-public-tint)] dark:hover:bg-brand-neon-lime/10 hover:text-[var(--color-public-accent)] dark:hover:text-brand-neon-lime transition-colors"
          >
            수업찾기
          </Link>
        </nav>

        {/* 사이드바 하단 — 연락처 + CTA. flex 세로라서 로그아웃(order-last)이 맨 아래로 간다(게슈탈트 P-10) */}
        <div className="shrink-0 flex flex-col p-4 border-t border-[var(--color-public-line)] dark:border-[var(--color-public-line)] bg-[var(--color-public-tint)] dark:bg-[var(--color-public-paper)]">
          <MobileAccountControls
            initialRole={accountRole}
            onNavigate={() => setIsMobileMenuOpen(false)}
          />
          <Link
            href="/apply"
            onClick={() => setIsMobileMenuOpen(false)}
            className="block w-full bg-[var(--color-public-accent)] dark:bg-brand-neon-lime hover:bg-[var(--color-public-strong)] dark:hover:bg-lime-400 text-white dark:text-brand-navy-900 font-bold py-3 rounded-xl text-center transition-colors mb-3"
          >
            신청하기
          </Link>
          <a
            href={`tel:${phone.replace(/-/g, "")}`}
            className="block text-center text-sm text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] hover:text-[var(--color-public-ink)] dark:hover:text-white transition-colors"
          >
            상담전화: {phone}
          </a>
          {/* 모바일 사이드바 내 큰글씨 모드 토글 */}
          <button
            onClick={toggleFontSize}
            className={[
              "w-full mt-2 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-bold transition-colors",
              isLargeFont
                ? "bg-[var(--color-public-tint)] dark:bg-brand-neon-lime/20 text-[var(--color-public-strong)] dark:text-brand-neon-lime border border-[var(--color-public-line)] dark:border-brand-neon-lime/30"
                : "bg-[var(--color-public-tint)] dark:bg-[var(--color-public-tint)] text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] border border-[var(--color-public-line)] dark:border-[var(--color-public-line)]",
            ].join(" ")}
          >
            <span className="text-base font-bold">가</span>
            <span>{isLargeFont ? "큰글씨 모드 켜짐" : "큰글씨 모드"}</span>
          </button>
        </div>
      </div>
    </>
  );
}
