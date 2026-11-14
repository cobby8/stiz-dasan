"use client";

import { useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
// 어디로 갈지 정하는 규칙은 순수 모듈 한 곳에서만 판단한다(분기가 네 갈래라 눈으로 못 잡는다).
import { resolveBackAction } from "@/lib/navigation/backAction";
import { useInstalledApp } from "@/components/pwa/useInstalledApp";
import { isPublicSitePath } from "@/lib/public-site-path";
import { hasSameOriginPreviousEntry, publicParentPath, type PublicNavigation } from "@/lib/navigation/publicHistory";
// 학부모 화면(/mypage) 안 이동 기록 — Next.js 는 history.state.idx 를 안 넣고 referrer 도 화면 안 이동에선 안 바뀌어서 따로 남긴다
import { inAppHistoryVersion, parentHistoryDecision, subscribeInAppHistory } from "@/lib/navigation/inAppHistory";

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

  // 학부모 화면은 우리가 남긴 이동 기록을 먼저 본다(2026-11-14). null = 학부모 화면이 아니거나
  // 아직 이 화면을 기록하기 전 → 아래 옛 판단 그대로(공개 사이트·선생님 화면 동작은 바뀌지 않는다)
  // false = 기록 없음 → 설치 앱·스토어 앱·브라우저 모두 고정 주소로(referrer·idx 로 넘어가지 않는다 —
  // referrer 는 결제창·로그인 등 학부모 화면 밖 주소일 수 있어, back 하면 그 바깥으로 돌아간다)
  const parentDecision = parentHistoryDecision(pathname);
  if (parentDecision !== null) return parentDecision;

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
  // 이동 기록이 바뀌면(화면 이동 직후) 다시 그려 «돌아갈 곳 없음» 판단을 새로 한다. 서버에선 0 고정
  useSyncExternalStore(subscribeInAppHistory, inAppHistoryVersion, () => 0);
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
  // 2026-11-14 아이콘 완전 제거: 화살표 아이콘 → 글자 기호 «←». 누르는 영역은 두 크기 모두 44px(글자 크기만 다르다).
  const sizeClass = size === "sm" ? "h-11 w-11 rounded-lg text-lg" : "h-11 w-11 rounded-xl text-xl";
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
      <span aria-hidden="true" className="leading-none">←</span>
    </button>
  );
}
