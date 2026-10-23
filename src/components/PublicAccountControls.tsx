"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { logout } from "@/app/actions/auth";
import { defaultPathForRole, type AppRole } from "@/lib/auth-routes";
import { createClient } from "@/lib/supabase/client";
import FontFreeIcon from "./ui/FontFreeIcon";
import AccountViewSwitcher from "./AccountViewSwitcher";
import type { AccountViewOption } from "@/lib/account-views";

const DESKTOP_ACCOUNT_CLASS = [
  "hidden md:inline-flex items-center rounded-xl border border-gray-200 px-3 py-2 text-sm font-bold",
  "text-gray-700 transition-colors hover:border-brand-orange-300 hover:bg-brand-orange-50 hover:text-brand-orange-600",
  "dark:border-gray-700 dark:text-gray-200 dark:hover:border-brand-neon-lime/40 dark:hover:bg-brand-neon-lime/10 dark:hover:text-brand-neon-lime",
].join(" ");

const DESKTOP_LOGOUT_CLASS = [
  "inline-flex items-center rounded-xl border border-gray-200 px-3 py-2 text-sm font-bold",
  "text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900",
  "dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white",
].join(" ");

const MOBILE_SECONDARY_ACTION_CLASS = [
  "flex min-h-11 items-center justify-center rounded-xl border border-gray-200 bg-white text-sm font-bold",
  "text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200",
].join(" ");

const HEADER_ICON_ACTION_CLASS = [
  "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gray-200",
  "bg-white text-gray-700 transition-colors hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900",
  "dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800 dark:hover:text-white",
].join(" ");

type AccountControlsProps = {
  initialRole?: AppRole | null;
};

function useAccountState(initialRole: AppRole | null = null) {
  const [appRole, setAppRole] = useState<AppRole | null>(initialRole);
  const [accountViews, setAccountViews] = useState<AccountViewOption[]>([]);

  useEffect(() => {
    setAppRole(initialRole);
  }, [initialRole]);

  const refreshAccountRole = useCallback(async () => {
    try {
      const response = await fetch("/api/auth/account-role", { cache: "no-store" });
      if (!response.ok) {
        setAppRole(null);
        setAccountViews([]);
        return;
      }

      const data = (await response.json().catch(() => ({}))) as { role?: AppRole | null; views?: AccountViewOption[] };
      setAppRole(data.role ?? null);
      setAccountViews(data.views ?? []);
    } catch {
      setAppRole(null);
      setAccountViews([]);
    }
  }, []);

  useEffect(() => {
    void refreshAccountRole();
  }, [refreshAccountRole]);

  useEffect(() => {
    const supabase = createClient();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") {
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

    return () => subscription.unsubscribe();
  }, [refreshAccountRole]);

  const accountHref = appRole ? defaultPathForRole(appRole) : "/login";
  const accountLabel =
    appRole === "ADMIN" || appRole === "VICE_ADMIN"
      ? "관리자"
      : appRole === "INSTRUCTOR"
        ? "선생님 앱"
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
        aria-label={isStaffPrimary ? "선생님 앱" : undefined}
        title={isStaffPrimary ? "선생님 앱" : undefined}
        className={DESKTOP_ACCOUNT_CLASS}
      >
        {isStaffPrimary ? (
          <>
            <FontFreeIcon name="school" size={19} />
            <span className="ml-1">선생님 앱</span>
          </>
        ) : (
          accountLabel
        )}
      </Link>}

      {canAccessAdmin && (
        <Link href="/staff/quick-post" aria-label="사진 올리기" title="사진 올리기" className={HEADER_ICON_ACTION_CLASS}>
          <FontFreeIcon name="camera_alt" size={19} />
          <span className="sr-only">사진 올리기</span>
        </Link>
      )}

      {isLoggedIn && (
        <form action={logout} className="hidden md:block">
          <button type="submit" className={DESKTOP_LOGOUT_CLASS}>
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

  return (
    <div className="grid grid-cols-2 gap-2 mb-3" data-account-controls="mobile">
      {accountViews.length > 1 ? (
        <div className="academy-app flex min-h-11 items-center justify-center rounded-xl"><AccountViewSwitcher views={accountViews} onNavigate={() => onNavigate?.()} /></div>
      ) : <Link
        href={accountHref}
        onClick={onNavigate}
        className="flex min-h-11 items-center justify-center rounded-xl border border-brand-orange-200 bg-white text-sm font-bold text-brand-orange-600 transition-colors hover:bg-brand-orange-50 dark:border-brand-neon-lime/30 dark:bg-gray-900 dark:text-brand-neon-lime"
        aria-label={isStaffPrimary ? "선생님 앱" : undefined}
        title={isStaffPrimary ? "선생님 앱" : undefined}
      >
        {isStaffPrimary ? (
          <>
            <FontFreeIcon name="school" size={20} />
            <span className="ml-1">선생님 앱</span>
          </>
        ) : (
          accountLabel
        )}
      </Link>}

      {canAccessAdmin ? (
        <Link
          href="/staff/quick-post"
          onClick={onNavigate}
          aria-label="사진 올리기"
          title="사진 올리기"
          className={MOBILE_SECONDARY_ACTION_CLASS}
        >
          <FontFreeIcon name="camera_alt" size={20} />
          <span className="sr-only">사진 올리기</span>
        </Link>
      ) : isLoggedIn ? (
        <form action={logout}>
          <button
            type="submit"
            className={`${MOBILE_SECONDARY_ACTION_CLASS} w-full`}
          >
            로그아웃
          </button>
        </form>
      ) : (
        <Link
          href="/staff/quick-post"
          onClick={onNavigate}
          aria-label="사진 올리기"
          title="사진 올리기"
          className={MOBILE_SECONDARY_ACTION_CLASS}
        >
          <FontFreeIcon name="camera_alt" size={20} />
          <span className="sr-only">사진 올리기</span>
        </Link>
      )}

      {canAccessAdmin && (
        <form action={logout} className="col-span-2">
          <button type="submit" className={`${MOBILE_SECONDARY_ACTION_CLASS} w-full`}>
            로그아웃
          </button>
        </form>
      )}
    </div>
  );
}
