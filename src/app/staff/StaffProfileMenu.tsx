"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { logoutStaff } from "@/app/actions/auth";
import { prepareStaffNavigation } from "./staffNavigation";
import AccountViewSwitcher from "@/components/AccountViewSwitcher";
import type { AccountViewOption } from "@/lib/account-views";

// 공개 홈페이지 링크(홈·공지·프로그램·시간표·갤러리)는 두지 않는다.
// 선생님 앱은 manifest scope 가 /staff 라, 홈페이지로 나가면 설치된 앱을 벗어나
// 브라우저로 튕긴다. 홈페이지가 필요하면 휴대폰 브라우저로 보면 된다.

const focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function StaffProfileMenu({ staffName, staffRole, accountViews = [] }: { staffName: string; staffRole: "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER"; accountViews?: AccountViewOption[] }) {
  const pathname = usePathname();
  const isSessionInProgress = pathname.startsWith("/staff/sessions/");
  const [isOpen, setIsOpen] = useState(false);
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!isOpen && !pendingHref) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (leaving) return;
        setIsOpen(false);
        setPendingHref(null);
        setLeaveError("");
        window.requestAnimationFrame(() => triggerRef.current?.focus());
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, pendingHref, leaving]);

  const closeAndRestoreFocus = () => {
    setIsOpen(false);
    setPendingHref(null);
    setLeaving(false);
    setLeaveError("");
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const leaveSession = async () => {
    if (!pendingHref || leaving) return;
    setLeaving(true);
    setLeaveError("");
    const result = await prepareStaffNavigation();
    if (!result.ok) {
      setLeaving(false);
      setLeaveError(result.message || "수업 기록을 저장하지 못해 이동을 중단했습니다.");
      return;
    }
    window.location.assign(pendingHref);
  };

  const requestPublicNavigation = (event: React.MouseEvent<HTMLAnchorElement>, href: string) => {
    if (!isSessionInProgress) {
      setIsOpen(false);
      return;
    }
    event.preventDefault();
    setIsOpen(false);
    setPendingHref(href);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? "staff-profile-menu" : undefined}
        aria-label={`${staffName} ${staffRole === "DRIVER" ? "기사님" : "선생님"} 메뉴 열기`}
        title={`${staffName} ${staffRole === "DRIVER" ? "기사님" : "선생님"}`}
        className="flex min-h-12 min-w-0 max-w-[11rem] flex-1 items-center gap-1.5 rounded-full bg-gray-100 px-2 text-left transition-colors hover:bg-gray-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)] sm:gap-2 sm:px-3 dark:bg-gray-900 dark:hover:bg-gray-800"
      >
        <span className="material-symbols-outlined shrink-0 text-xl text-[var(--brand-accent)]" aria-hidden="true">account_circle</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-gray-700 dark:text-gray-200">{staffName} {staffRole === "DRIVER" ? "기사님" : "선생님"}</span>
          <span className="block whitespace-nowrap text-[0.65rem] font-bold text-gray-500 dark:text-gray-400">메뉴 열기</span>
        </span>
        <span className="hidden shrink-0 sm:block" aria-hidden="true">
          <span className="material-symbols-outlined text-lg text-gray-500">expand_more</span>
        </span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-3 sm:items-center" onMouseDown={(event) => event.target === event.currentTarget && closeAndRestoreFocus()}>
          <div ref={dialogRef} id="staff-profile-menu" role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-2xl dark:bg-gray-900">
            <div className="mb-3 flex min-h-12 items-center justify-between gap-3">
              <div>
                <h2 id={titleId} className="text-lg font-black text-gray-900 dark:text-white">선생님 메뉴</h2>
              </div>
              <button type="button" onClick={closeAndRestoreFocus} aria-label="선생님 메뉴 닫기" className="grid size-12 shrink-0 place-items-center rounded-full bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
                <span className="material-symbols-outlined" aria-hidden="true">close</span>
              </button>
            </div>

            {isSessionInProgress && (
              <p className="mb-3 rounded-2xl bg-[color-mix(in_srgb,var(--brand-accent)_10%,transparent)] p-3 text-sm font-bold text-gray-700 dark:text-gray-200">
                수업이 진행 중입니다. 다른 화면으로 이동하면 먼저 확인합니다.
              </p>
            )}

            {staffRole !== "DRIVER" && accountViews.length > 0 && <div className="mb-3">
              <AccountViewSwitcher views={accountViews} variant="list" onNavigate={(event, view) => requestPublicNavigation(event, view.href)} />
            </div>}

            <Link href="/account" onClick={event=>requestPublicNavigation(event,"/account")} className="mb-3 flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-gray-100 text-sm font-bold text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200">
              <span className="material-symbols-outlined" aria-hidden="true">manage_accounts</span>내 계정
            </Link>
            <div className="grid grid-cols-2 gap-2">
              <Link href="/staff/install" onClick={(event) => requestPublicNavigation(event, "/staff/install")} className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-gray-100 text-sm font-bold text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
                <span className="material-symbols-outlined" aria-hidden="true">install_mobile</span>설치 안내
              </Link>
              {isSessionInProgress ? (
                <button type="button" disabled title="수업 종료 후 로그아웃할 수 있습니다" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gray-100 text-sm font-bold text-gray-400 disabled:cursor-not-allowed dark:bg-gray-800 dark:text-gray-500">
                  <span className="material-symbols-outlined" aria-hidden="true">lock_clock</span>수업 종료 후 로그아웃
                </button>
              ) : (
                <form action={logoutStaff}>
                  <button type="submit" className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gray-100 text-sm font-bold text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700">
                    <span className="material-symbols-outlined" aria-hidden="true">logout</span>로그아웃
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {pendingHref && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-3 sm:items-center" onMouseDown={(event) => !leaving && event.target === event.currentTarget && closeAndRestoreFocus()}>
          <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[calc(100dvh-1.5rem)] min-h-0 w-full max-w-sm overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl dark:bg-gray-900">
            <span className="material-symbols-outlined mb-3 text-3xl text-[var(--brand-accent)]" aria-hidden="true">timer</span>
            <h2 id={titleId} className="text-lg font-black text-gray-900 dark:text-white">수업 중 다른 화면으로 이동할까요?</h2>
            <p className="mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300">이동하기 전에 작성한 수업 내용을 저장합니다. 저장이 완료되지 않으면 현재 화면에 머무릅니다.</p>
            {leaveError && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-sm font-bold text-red-700 dark:bg-red-950/40 dark:text-red-300">{leaveError}</p>}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" disabled={leaving} onClick={closeAndRestoreFocus} className="min-h-12 rounded-2xl bg-gray-100 text-sm font-bold text-gray-700 hover:bg-gray-200 disabled:opacity-50 dark:bg-gray-800 dark:text-gray-200">계속 수업하기</button>
              <button type="button" disabled={leaving} aria-busy={leaving} onClick={() => void leaveSession()} className="min-h-12 rounded-2xl bg-[var(--brand-accent)] text-sm font-black text-[var(--brand-accent-contrast)] disabled:opacity-60">{leaving ? "저장 확인 중…" : "저장 후 이동"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
