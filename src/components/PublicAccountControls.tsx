"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { logout } from "@/app/actions/auth";
import { usePathname } from "next/navigation";
import { defaultPathForRole, loginHrefFrom, type AppRole } from "@/lib/auth-routes";
import AccountViewSwitcher from "./AccountViewSwitcher";
import type { AccountViewOption } from "@/lib/account-views";

const DESKTOP_ACCOUNT_CLASS = [
  "hidden md:inline-flex items-center rounded-xl border border-[var(--color-public-line)] px-3 py-2 text-sm font-medium",
  "text-[var(--color-public-muted)] transition-colors hover:border-[var(--color-public-muted)] hover:bg-[var(--color-public-tint)] hover:text-[var(--color-public-strong)]",
  "dark:border-[var(--color-public-line)] dark:text-[var(--color-public-ink)] dark:hover:border-brand-neon-lime/40 dark:hover:bg-brand-neon-lime/10 dark:hover:text-brand-neon-lime",
].join(" ");

const DESKTOP_LOGOUT_CLASS = [
  "inline-flex items-center rounded-xl border border-[var(--color-public-line)] px-3 py-2 text-sm font-medium",
  "text-[var(--color-public-muted)] transition-colors hover:border-gray-300 hover:bg-[var(--color-public-tint)] hover:text-[var(--color-public-ink)]",
  "dark:border-[var(--color-public-line)] dark:text-[var(--color-public-muted)] dark:hover:bg-[var(--color-public-tint)] dark:hover:text-white",
].join(" ");

const MOBILE_SECONDARY_ACTION_CLASS = [
  "flex min-h-11 items-center justify-center rounded-xl border border-[var(--color-public-line)] bg-white text-sm font-medium",
  "text-[var(--color-public-muted)] transition-colors hover:bg-[var(--color-public-tint)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-ink)]",
].join(" ");

const HEADER_ICON_ACTION_CLASS = [
  "inline-flex h-10 shrink-0 items-center justify-center whitespace-nowrap rounded-xl border border-[var(--color-public-line)] px-3 text-sm font-medium",
  "bg-white text-[var(--color-public-muted)] transition-colors hover:border-gray-300 hover:bg-[var(--color-public-tint)] hover:text-[var(--color-public-ink)]",
  "dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-ink)] dark:hover:bg-[var(--color-public-tint)] dark:hover:text-white",
].join(" ");

type AccountControlsProps = {
  initialRole?: AppRole | null;
};

type AccountRoleAnswer = { role: AppRole | null; views: AccountViewOption[] };

// 머리줄에는 PC용·모바일용 계정 버튼이 함께 놓이고, 둘 다 «화면이 뜰 때»와 «로그인 알림이 올 때» 같은 질문을 한다.
// 그대로 두면 화면 하나에 같은 요청이 3~4번 나간다(2026-11-17 측정) → 한 번만 묻고 답을 같이 쓴다.
// - 묻는 중이면 그 요청을 같이 기다린다.
// - 방금(2초 안) 받은 «로그인됨» 답은 다시 쓴다. «로그인 안 됨» 답은 다시 쓰지 않는다 — 방금 로그인한 사람에게 옛 답을 주지 않게.
const ACCOUNT_ROLE_REUSE_MS = 2000;
let sharedAccountRole: { at: number; settled: boolean; role: AppRole | null; promise: Promise<AccountRoleAnswer> } | null = null;

function forgetSharedAccountRole() {
  sharedAccountRole = null;
}

function loadAccountRoleOnce(): Promise<AccountRoleAnswer> {
  const now = Date.now();
  const current = sharedAccountRole;
  if (current && (!current.settled || (current.role !== null && now - current.at < ACCOUNT_ROLE_REUSE_MS))) {
    return current.promise;
  }

  const entry: NonNullable<typeof sharedAccountRole> = {
    at: now,
    settled: false,
    role: null,
    promise: (async () => {
      const signedOut: AccountRoleAnswer = { role: null, views: [] };
      try {
        const response = await fetch("/api/auth/account-role", { cache: "no-store" });
        if (!response.ok) return signedOut;
        const data = (await response.json().catch(() => ({}))) as { role?: AppRole | null; views?: AccountViewOption[] };
        return { role: data.role ?? null, views: data.views ?? [] };
      } catch {
        return signedOut;
      }
    })(),
  };
  sharedAccountRole = entry;
  void entry.promise.then((answer) => {
    entry.settled = true;
    entry.role = answer.role;
    entry.at = Date.now();
  });
  return entry.promise;
}

function useAccountState(initialRole: AppRole | null = null) {
  const [appRole, setAppRole] = useState<AppRole | null>(initialRole);
  const [accountViews, setAccountViews] = useState<AccountViewOption[]>([]);

  useEffect(() => {
    setAppRole(initialRole);
  }, [initialRole]);

  const refreshAccountRole = useCallback(async () => {
    // 실패·로그인 안 됨은 loadAccountRoleOnce 가 { role: null, views: [] } 로 돌려준다(던지지 않는다).
    const answer = await loadAccountRoleOnce();
    setAppRole(answer.role);
    setAccountViews(answer.views);
  }, []);

  useEffect(() => {
    void refreshAccountRole();
  }, [refreshAccountRole]);

  useEffect(() => {
    // 로그인 서비스(Supabase) 부품(약 200KB)은 화면이 뜬 뒤에 받는다(2026-11-18 속도 조치) — 로그인·로그아웃을 지켜보는 용도라
    // 첫 그림에는 필요 없다. 받기 전에 이 부품이 사라지면(다른 화면으로 이동) 구독하지 않는다.
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    void import("@/lib/supabase/client").then(({ createClient }) => {
      if (cancelled) return;
      const {
        data: { subscription },
      } = createClient().auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") {
          forgetSharedAccountRole(); // 로그아웃 뒤에는 방금 받은 «로그인됨» 답을 다시 쓰지 않는다
          setAppRole(null);
          setAccountViews([]);
          return;
        }

        // 로그인 또는 계정 갱신 시 metadata를 쓰지 않고 Server Component를
        // 새로 고쳐 DB에서 확인한 역할을 다시 전달받는다.
        if (event === "SIGNED_IN" || event === "USER_UPDATED") {
          void refreshAccountRole();
        }
      });
      unsubscribe = () => subscription.unsubscribe();
    }).catch(() => { /* 부품을 못 받으면 지켜보지 않을 뿐 — 역할은 위 refreshAccountRole 이 이미 읽었다 */ });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [refreshAccountRole]);

  // 로그인 전이면 보던 화면 주소를 넘긴다 — 로그인 뒤 그 화면으로 돌아온다(2026-11-17)
  const pathname = usePathname();
  const accountHref = appRole ? defaultPathForRole(appRole) : loginHrefFrom(pathname);
  const accountLabel =
    appRole === "ADMIN" || appRole === "VICE_ADMIN"
      ? "관리자"
      : appRole === "INSTRUCTOR"
        ? "선생님 화면"
        : appRole === "PARENT"
          ? "마이페이지"
          : "로그인";
  const canAccessAdmin = appRole === "ADMIN" || appRole === "VICE_ADMIN";
  const isStaffPrimary = appRole === "INSTRUCTOR";

  return { accountHref, accountLabel, canAccessAdmin, isLoggedIn: appRole !== null, isStaffPrimary, accountViews };
}

export function DesktopAccountControls({ initialRole = null }: AccountControlsProps) {
  const { accountHref, accountLabel, canAccessAdmin, isLoggedIn, isStaffPrimary, accountViews } =
    useAccountState(initialRole);

  return (
    <>
      {accountViews.length > 1 ? (
        <div className="academy-app hidden rounded-xl md:block"><AccountViewSwitcher views={accountViews} /></div>
      ) : <Link
        href={accountHref}
        aria-label={isStaffPrimary ? "선생님 화면" : undefined}
        title={isStaffPrimary ? "선생님 화면" : undefined}
        className={DESKTOP_ACCOUNT_CLASS}
      >
        {isStaffPrimary ? (
          <>
            <span>선생님 화면</span>
          </>
        ) : (
          accountLabel
        )}
      </Link>}

      {canAccessAdmin && (
        <Link href="/staff/quick-post" prefetch={false} aria-label="사진 올리기" title="사진 올리기" className={HEADER_ICON_ACTION_CLASS}>
          사진 올리기
        </Link>
      )}

      {isLoggedIn && (
        <form action={logout} className="hidden md:block">
          <button type="submit" onClick={forgetSharedAccountRole} className={DESKTOP_LOGOUT_CLASS}>
            로그아웃
          </button>
        </form>
      )}
    </>
  );
}

export function MobileAccountControls({
  onNavigate,
  initialRole = null,
}: AccountControlsProps & { onNavigate?: () => void }) {
  const { accountHref, accountLabel, canAccessAdmin, isLoggedIn, isStaffPrimary, accountViews } =
    useAccountState(initialRole);

  // 게슈탈트 P-10: 로그아웃은 위 버튼 묶음과 떼어 «맨 아래 회색 글자 링크»로 둔다(실수로 누르지 않게).
  // 로그인한 일반 계정은 둘째 칸(로그아웃)이 빠지므로 계정 버튼이 두 칸을 채운다.
  const accountSpan = isLoggedIn && !canAccessAdmin ? " col-span-2" : "";

  return (
    <>
    <div className="grid grid-cols-2 gap-2 mb-3" data-account-controls="mobile">
      {accountViews.length > 1 ? (
        <div className={`academy-app flex min-h-11 items-center justify-center rounded-xl${accountSpan}`}><AccountViewSwitcher views={accountViews} onNavigate={() => onNavigate?.()} /></div>
      ) : <Link
        href={accountHref}
        onClick={onNavigate}
        className={`flex min-h-11 items-center justify-center rounded-xl border border-[var(--color-public-line)] bg-white text-sm font-bold text-[var(--color-public-strong)] transition-colors hover:bg-[var(--color-public-tint)] dark:border-brand-neon-lime/30 dark:bg-[var(--color-public-paper)] dark:text-brand-neon-lime${accountSpan}`}
        aria-label={isStaffPrimary ? "선생님 화면" : undefined}
        title={isStaffPrimary ? "선생님 화면" : undefined}
      >
        {isStaffPrimary ? (
          <>
            <span>선생님 화면</span>
          </>
        ) : (
          accountLabel
        )}
      </Link>}

      {canAccessAdmin ? (
        <Link
          href="/staff/quick-post" prefetch={false}
          onClick={onNavigate}
          aria-label="사진 올리기"
          title="사진 올리기"
          className={MOBILE_SECONDARY_ACTION_CLASS}
        >
          사진 올리기
        </Link>
      ) : isLoggedIn ? null : (
        <Link
          href="/staff/quick-post" prefetch={false}
          onClick={onNavigate}
          aria-label="사진 올리기"
          title="사진 올리기"
          className={MOBILE_SECONDARY_ACTION_CLASS}
        >
          사진 올리기
        </Link>
      )}

    </div>

      {/* 로그아웃 — 부모(모바일 메뉴 하단, flex 세로)에서 order-last 로 맨 아래에 놓이고, 위와 16px 이상 띄운다 */}
      {isLoggedIn && (
        <form action={logout} className="order-last mt-4 border-t border-[var(--color-public-line)] pt-2 text-center dark:border-[var(--color-public-line)]" data-account-logout="mobile">
          <button type="submit" onClick={forgetSharedAccountRole} className="inline-flex min-h-11 items-center px-3 text-sm text-[var(--color-public-muted)] underline-offset-2 transition-colors hover:text-[var(--color-public-ink)] hover:underline dark:text-[var(--color-public-muted)] dark:hover:text-[var(--color-public-ink)]">
            로그아웃
          </button>
        </form>
      )}
    </>
  );
}
