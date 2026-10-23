"use client";

import { usePathname, useRouter } from "next/navigation";
import FontFreeIcon from "@/components/ui/FontFreeIcon";
// 어디로 갈지 정하는 규칙은 순수 모듈 한 곳에서만 판단한다(분기가 네 갈래라 눈으로 못 잡는다).
import { resolveBackAction } from "@/lib/navigation/backAction";
import { useInstalledApp } from "@/components/pwa/useInstalledApp";
import { isPublicSitePath } from "@/lib/public-site-path";
import { hasSameOriginPreviousEntry, publicParentPath, type PublicNavigation } from "@/lib/navigation/publicHistory";

type AppBackButtonProps = {
  fallbackHref?: string;
  /**
   * 설치된 앱 안에서 벗어나면 안 되는 범위(manifest scope). 예: "/mypage".
   * 지정하면 **설치된 앱으로 열렸을 때만** 이 범위 밖으로 나가지 않는다.
   * 브라우저에서는 홈페이지에서 들어온 사람도 있으므로 기존대로 동작한다.
   */
  scopeHref?: string;
  className?: string;
  size?: "sm" | "md";
  variant?: "header" | "floating";
  ariaLabel?: string;
};


function canGoBackWithinApp(pathname: string) {
  if (typeof window === "undefined") return false;

  if (isPublicSitePath(pathname) && hasSameOriginPreviousEntry(
    (window as Window & { navigation?: PublicNavigation }).navigation,
    window.location.origin,
  )) return true;

  const historyIndex = Number(window.history.state?.idx ?? 0);
  if (historyIndex > 0) return true;

  try {
    return Boolean(document.referrer) && new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

export default function AppBackButton({
  fallbackHref = "/",
  scopeHref,
  className = "",
  size = "md",
  variant = "header",
  ariaLabel = "이전 화면으로 돌아가기",
}: AppBackButtonProps) {
  const router = useRouter();
  const pathname = usePathname() || "/";
  const isInstalledApp = useInstalledApp();
  const backFallback = isPublicSitePath(pathname) ? publicParentPath(pathname, fallbackHref) : fallbackHref;

  // 앱의 첫 화면이라 돌아갈 곳이 없다. 죽은 버튼을 두느니 자리만 남긴다
  // (헤더가 격자 배치라 그냥 지우면 로고·제목이 밀린다).
  const nothingToGoBackTo =
    resolveBackAction({
      hasHistory: canGoBackWithinApp(pathname),
      pathname,
      fallbackHref: backFallback,
      scopeHref,
      isInstalledApp,
    }).type === "none";
  const sizeClass = size === "sm" ? "h-9 w-9 rounded-lg" : "h-10 w-10 rounded-xl";
  const variantClass =
    variant === "floating"
      ? "border-gray-200 bg-white/95 text-gray-800 shadow-lg backdrop-blur hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900/95 dark:text-gray-100 dark:hover:bg-gray-800"
      : "border-gray-200 bg-white text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800";

  const handleClick = () => {
    const action = resolveBackAction({
      hasHistory: canGoBackWithinApp(pathname),
      pathname,
      fallbackHref: backFallback,
      scopeHref,
      isInstalledApp,
    });
    if (action.type === "back") router.back();
    else if (action.type === "push") router.push(action.href);
  };

  if (nothingToGoBackTo) {
    return <span aria-hidden="true" className={[sizeClass, "inline-block shrink-0", className].join(" ")} />;
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={handleClick}
      className={[
        "inline-flex shrink-0 items-center justify-center border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-accent)]",
        sizeClass,
        variantClass,
        className,
      ].join(" ")}
    >
      <FontFreeIcon name="arrow_back" size={size === "sm" ? 18 : 20} />
    </button>
  );
}
