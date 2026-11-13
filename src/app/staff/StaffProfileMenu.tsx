"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { logoutStaff } from "@/app/actions/auth";
import { prepareStaffNavigation } from "./staffNavigation";
import AccountViewSwitcher from "@/components/AccountViewSwitcher";
import type { AccountViewOption } from "@/lib/account-views";
import { useStoreAppLacks } from "@/components/storeApp/useStoreAppLacks";

// 공개 홈페이지 링크(홈·공지·프로그램·시간표·갤러리)는 두지 않는다.
// 선생님 앱은 manifest scope 가 /staff 라, 홈페이지로 나가면 설치된 앱을 벗어나
// 브라우저로 튕긴다. 홈페이지가 필요하면 휴대폰 브라우저로 보면 된다.

const focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function StaffProfileMenu({ staffName, staffRole, accountViews = [] }: { staffName: string; staffRole: "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER"; accountViews?: AccountViewOption[] }) {
  const pathname = usePathname();
  const isSessionInProgress = pathname.startsWith("/staff/sessions/");
  const [isOpen, setIsOpen] = useState(false);
  // 스토어 앱 안이면 «설치 안내»가 필요 없다(이미 앱) — 판정은 @/lib/storeApp 한 곳(d2)
  const hideInstallGuide = useStoreAppLacks("install");
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
        className="flex min-h-12 min-w-0 max-w-[11rem] flex-1 items-center rounded-full bg-[var(--color-academy-soft)] px-3 text-left transition-colors hover:bg-[var(--color-academy-line)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-[var(--color-academy-ink)]">{staffName} {staffRole === "DRIVER" ? "기사님" : "선생님"}</span>
          <span className="block whitespace-nowrap text-xs text-[var(--color-academy-muted)]">메뉴 열기</span>
        </span>
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 p-3 sm:items-center" onMouseDown={(event) => event.target === event.currentTarget && closeAndRestoreFocus()}>
          <div ref={dialogRef} id="staff-profile-menu" role="dialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-3xl bg-white p-4 shadow-2xl">
            <div className="mb-3 flex min-h-12 items-center justify-between gap-3">
              <div>
                <h2 id={titleId} className="text-lg font-bold text-[var(--color-academy-ink)]">선생님 메뉴</h2>
              </div>
              <button type="button" onClick={closeAndRestoreFocus} aria-label="선생님 메뉴 닫기" className="academy-button-text academy-button-sm shrink-0">
                닫기
              </button>
            </div>

            {isSessionInProgress && (
              <p className="mb-3 rounded-2xl bg-[var(--color-academy-neutral-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
                수업이 진행 중입니다. 다른 화면으로 이동하면 먼저 확인합니다.
              </p>
            )}

            {staffRole !== "DRIVER" && accountViews.length > 0 && <div className="mb-3">
              <AccountViewSwitcher views={accountViews} variant="list" onNavigate={(event, view) => requestPublicNavigation(event, view.href)} />
            </div>}

            <Link href="/account" onClick={event=>requestPublicNavigation(event,"/account")} className="academy-button-secondary mb-3 w-full">
              내 계정
            </Link>
            <div className={`grid gap-2 ${hideInstallGuide ? "grid-cols-1" : "grid-cols-2"}`}>
              {!hideInstallGuide && <Link href="/staff/install" onClick={(event) => requestPublicNavigation(event, "/staff/install")} className="academy-button-secondary w-full">
                설치 안내
              </Link>}
              {isSessionInProgress ? (
                <button type="button" disabled title="수업 종료 후 로그아웃할 수 있습니다" className="academy-button-secondary w-full">
                  수업 종료 후 로그아웃
                </button>
              ) : (
                <form action={logoutStaff}>
                  <button type="submit" className="academy-button-secondary w-full">
                    로그아웃
                  </button>
                </form>
              )}
            </div>
          </div>
        </div>
      )}

      {pendingHref && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-3 sm:items-center" onMouseDown={(event) => !leaving && event.target === event.currentTarget && closeAndRestoreFocus()}>
          <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby={titleId} className="max-h-[calc(100dvh-1.5rem)] min-h-0 w-full max-w-sm overflow-y-auto rounded-3xl bg-white p-5 shadow-2xl">
            <h2 id={titleId} className="text-lg font-bold text-[var(--color-academy-ink)]">수업 중 다른 화면으로 이동할까요?</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--color-academy-muted)]">이동하기 전에 작성한 수업 내용을 저장합니다. 저장이 완료되지 않으면 현재 화면에 머무릅니다.</p>
            {leaveError && <p role="alert" className="mt-3 rounded-xl bg-[var(--color-academy-danger-soft)] p-3 text-sm text-[var(--color-academy-danger)]">{leaveError}</p>}
            <div className="mt-5 grid grid-cols-2 gap-2">
              <button type="button" disabled={leaving} onClick={closeAndRestoreFocus} className="academy-button-secondary">계속 수업하기</button>
              <button type="button" disabled={leaving} aria-busy={leaving} onClick={() => void leaveSession()} className="academy-button-primary">{leaving ? "저장 확인 중…" : "저장 후 이동"}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
