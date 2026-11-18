"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { logoutStaff } from "@/app/actions/auth";
import { isStaffLiveLessonOpen, prepareStaffNavigation, shouldConfirmStaffLeave, subscribeStaffLiveLesson } from "./staffNavigation";
import AccountViewSwitcher from "@/components/AccountViewSwitcher";
import type { AccountViewOption } from "@/lib/account-views";
import { useStoreAppLacks } from "@/components/storeApp/useStoreAppLacks";
import { parseLastViewKey, rememberLastView, type LastViewKey } from "@/lib/auth/last-view";
// 2026-11-18 뒤로 가기: 메뉴·확인 창은 휴대폰 «뒤로»로 창만 닫힌다
import { useBackToClose } from "@/components/common/useBackToClose";
import { releaseActiveLessonGuard } from "./lessonBackGuard";

// 공개 홈페이지 링크(홈·공지·프로그램·시간표·갤러리)는 두지 않는다.
// 선생님 앱은 manifest scope 가 /staff 라, 홈페이지로 나가면 설치된 앱을 벗어나
// 브라우저로 튕긴다. 홈페이지가 필요하면 휴대폰 브라우저로 보면 된다.

const focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function StaffProfileMenu({ staffName, staffRole, accountViews = [] }: { staffName: string; staffRole: "ADMIN" | "VICE_ADMIN" | "INSTRUCTOR" | "DRIVER"; accountViews?: AccountViewOption[] }) {
  const pathname = usePathname();
  const router = useRouter();
  // 수업 주소(/staff/sessions/…) — «수업 종료 후 로그아웃» 잠금은 예전처럼 이 주소에서만 건다.
  const isSessionInProgress = pathname.startsWith("/staff/sessions/");
  // 2026-11-17: 수업은 선생님 홈(/staff)의 줄 안에서도 진행한다(11-15~). 홈이 <html> 에 다는 «수업 중» 표시를 같이 봐서
  // 홈에서 진행 중일 때도 «저장 후 이동» 확인을 거친다. 진행 중 수업이 없으면 false 라 지금처럼 바로 이동한다.
  const liveLessonOpen = useSyncExternalStore(subscribeStaffLiveLesson, isStaffLiveLessonOpen, () => false);
  const needsLeaveConfirm = shouldConfirmStaffLeave(pathname, liveLessonOpen);
  const [isOpen, setIsOpen] = useState(false);
  // 스토어 앱 안이면 «설치 안내»가 필요 없다(이미 앱) — 판정은 @/lib/storeApp 한 곳(d2)
  const hideInstallGuide = useStoreAppLacks("install");
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  // 확인 창을 거치는 이동이 «화면 전환»이면 그 화면 키를 같이 들고 있다가, 이동이 확정될 때 «마지막 화면»으로 기억한다.
  const [pendingViewKey, setPendingViewKey] = useState<LastViewKey | null>(null);
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
        setPendingViewKey(null);
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
    // 취소하면 화면 키도 버린다 — 고르지 않은 화면이 «마지막 화면»으로 남으면 안 된다
    setPendingViewKey(null);
    setLeaving(false);
    setLeaveError("");
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  // 휴대폰 «뒤로» = 열린 창만 닫는다(화면째 나가지 않는다). 메뉴와 확인 창은 동시에 뜨지 않는다.
  // 확인 창은 «저장 확인 중»(leaving)에는 뒤로를 눌러도 닫히지 않는다.
  const menuBack = useBackToClose(isOpen, closeAndRestoreFocus);
  const confirmBack = useBackToClose(pendingHref !== null, closeAndRestoreFocus, { blocked: leaving });

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
    // 확인 창을 거친 화면 전환도 «마지막에 쓰던 화면»으로 기억한다(2026-11-17).
    // 확인 없이 바로 이동할 때는 AccountViewSwitcher 가 같은 키로 적는데, 확인 창을 거치면 그쪽은
    // «아직 고른 것이 아니라» 적지 않는다 — 그래서 저장이 끝나 이동이 확정된 이 자리에서 적는다.
    if (pendingViewKey) rememberLastView(pendingViewKey);
    // 확인 창이 넣은 기록 칸(그리고 선생님 홈이면 수업 가드 칸)을 먼저 되돌린 뒤 이동한다 — 안 그러면 그 칸이 새 화면 뒤에 남아 뒤로가 헛돈다
    confirmBack.leaveTo(pendingHref, (to) => void releaseActiveLessonGuard().then(() => window.location.assign(to)));
    // 화면이 실제로 떠나지 않는 경우가 있다(설치 안내가 스토어 앱으로 넘어가 이 탭은 그대로 남을 때 등).
    // 그대로 두면 «저장 확인 중…»으로 굳어 두 버튼·Esc·바깥 누르기가 모두 막힌다 — 잠시 뒤에도 남아 있으면 잠금만 푼다.
    window.setTimeout(() => setLeaving(false), 4000);
  };

  // 다른 화면에 갔다가 «뒤로»로 화면이 통째 복원(bfcache)됐을 때도 같은 잠금을 푼다.
  useEffect(() => {
    const release = (event: PageTransitionEvent) => {
      if (event.persisted) setLeaving(false);
    };
    window.addEventListener("pageshow", release);
    return () => window.removeEventListener("pageshow", release);
  }, []);

  // viewKey: 화면 전환 목록의 항목이면 그 화면 키(admin·teacher·driver·parent). 마이페이지·설치 안내처럼 화면 전환이 아닌 이동은 넘기지 않는다.
  // 목록 밖 키(가족 연결·내 계정)는 parseLastViewKey 가 null 로 걸러 기억하지 않는다.
  const requestPublicNavigation = (event: React.MouseEvent<HTMLAnchorElement>, href: string, viewKey?: string) => {
    // 새 탭·새 창으로 여는 누름은 지금 화면을 떠나지 않는다 — 메뉴만 닫고 그대로 둔다
    const newTab = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0;
    if (!needsLeaveConfirm) {
      setIsOpen(false);
      if (newTab) return;
      // 메뉴가 넣은 기록 칸을 먼저 되돌린 뒤 이동한다(2026-11-18) — 링크가 먼저 이동하면 그 칸이 새 화면 뒤에 남는다.
      // 링크 기본 동작을 막았으므로 «마지막 화면» 기억(화면 전환 항목)도 여기서 한다.
      event.preventDefault();
      const directKey = parseLastViewKey(viewKey);
      if (directKey) rememberLastView(directKey);
      // /install 은 기기를 보고 스토어(바깥 주소)로 넘기는 보통 링크 — 통째 이동. 나머지는 화면 안 이동(Link 와 같다)
      menuBack.leaveTo(href, (to) => (to === "/install" ? window.location.assign(to) : router.push(to)));
      return;
    }
    event.preventDefault();
    setIsOpen(false);
    // 메뉴의 기록 칸이 빠진 «뒤»에 확인 창을 연다(두 창의 칸이 엇갈리지 않게)
    menuBack.closeThen(() => {
      setPendingHref(href);
      setPendingViewKey(parseLastViewKey(viewKey));
    });
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

            {needsLeaveConfirm && (
              <p className="mb-3 rounded-2xl bg-[var(--color-academy-neutral-soft)] p-3 text-sm text-[var(--color-academy-ink)]">
                수업이 진행 중입니다. 다른 화면으로 이동하면 먼저 확인합니다.
              </p>
            )}

            {/* 기사님+학부모 계정도 돌아갈 화면이 있다(2026-11-17 전수 점검 — 예전에는 기사님이면 전환 목록을 숨겨 돌아오는 버튼이 없었다) */}
            {accountViews.length > 0 && <div className="mb-3">
              <AccountViewSwitcher views={accountViews} variant="list" onNavigate={(event, view) => requestPublicNavigation(event, view.href, view.key)} />
            </div>}

            {/* 마이페이지(내 정보·담당 반·이번 달 수업·알림·앱 정보) — 예전 «내 계정» 자리(2026-11-16 원장 지시). 계정 화면은 마이페이지 «계정 관리»로 간다.
                청구 링크는 메뉴에서 뺐다(원장 「청구는 필요 없어」) — 화면은 주소로 계속 열린다 */}
            <Link href="/staff/mypage" onClick={(event) => requestPublicNavigation(event, "/staff/mypage")} className="academy-button-secondary mb-3 w-full">
              마이페이지
            </Link>
            <div className={`grid gap-2 ${hideInstallGuide ? "grid-cols-1" : "grid-cols-2"}`}>
              {/* 2026-11-17: 옛 선생님 앱 설치 안내(/staff/install) 대신 스토어 앱 설치 안내(/install) 하나로 간다.
                  /install 은 기기를 보고 스토어(바깥 주소)로 바로 넘기므로 화면 안 이동(Link)이 아니라 보통 링크(a)로 연다 */}
              {!hideInstallGuide && <a href="/install" onClick={(event) => requestPublicNavigation(event, "/install")} className="academy-button-secondary w-full">
                앱 설치 안내
              </a>}
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
