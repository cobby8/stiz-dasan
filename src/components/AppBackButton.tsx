"use client";

import { useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
// 어디로 갈지 정하는 규칙은 순수 모듈 한 곳에서만 판단한다(분기가 네 갈래라 눈으로 못 잡는다).
import { resolveBackAction } from "@/lib/navigation/backAction";
import { useInstalledApp } from "@/components/pwa/useInstalledApp";
import { isPublicSitePath } from "@/lib/public-site-path";
import { parentUpPath } from "@/lib/navigation/parentUpPath";
import { isResultPath, previousEntryState, publicParentPath, type PublicNavigation } from "@/lib/navigation/publicHistory";
// 학부모 화면(/mypage) 안 이동 기록 — Next.js 는 history.state.idx 를 안 넣고 referrer 도 화면 안 이동에선 안 바뀌어서 따로 남긴다
import { inAppHistoryVersion, isParentScopePath, markNextNavigationAsReplace, parentHistoryDecision, subscribeInAppHistory } from "@/lib/navigation/inAppHistory";
// 선생님·관리자 화면(/staff·/admin)도 같은 기록 장치를 쓴다 — 범위마다 기록이 따로라 다른 역할 화면으로 돌아가지 않는다(2026-11-17)
import { isPassThroughPath, isScopePath, markNextScopeNavigationAsReplace, scopeHistoryDecision, staffOrAdminScopeOf, type HistoryScope } from "@/lib/navigation/inAppHistory";

type AppBackButtonProps = {
  fallbackHref?: string;
  /**
   * 설치된 앱 안에서 벗어나면 안 되는 범위(manifest scope). 예: "/mypage".
   * 지정하면 **설치된 앱으로 열렸을 때만** 이 범위 밖으로 나가지 않는다.
   * 브라우저에서는 홈페이지에서 들어온 사람도 있으므로 기존대로 동작한다.
   * 단 "/staff"·"/admin" 은 설치 여부와 상관없이 늘 지킨다(2026-11-17): 기록이 없으면 하위 화면은
   * fallbackHref(그 역할의 홈)로, 역할 홈에서는 버튼 자리만 남긴다.
   */
  scopeHref?: string;
  className?: string;
  size?: "sm" | "md";
  variant?: "header" | "floating";
  ariaLabel?: string;
};


/** 머리줄 버튼이 받은 scopeHref 가 선생님·관리자 범위이고 지금 화면이 그 안이면 그 범위(기록 부품이 놓인 틀 안이라는 뜻) */
function staffOrAdminScope(pathname: string, scopeHref: string | undefined): HistoryScope | null {
  const scope = scopeHref ? staffOrAdminScopeOf(scopeHref) : null;
  return scope && scope === scopeHref && isScopePath(pathname, scope) ? scope : null;
}

function canGoBackWithinApp(pathname: string, scopeHref?: string) {
  if (typeof window === "undefined") return false;

  // 선생님·관리자 화면(2026-11-17): 그 범위의 이동 기록만 본다. 기록 없음(false)·아직 기록 전(null) 모두 «없음»이다 —
  // 옛 판단(referrer·idx)으로 넘어가면 첫 화면에서도 back 해 로그인·다른 역할 화면으로 나간다(검수 R4)
  if (staffOrAdminScope(pathname, scopeHref)) return scopeHistoryDecision(pathname) === true;

  // 학부모 화면은 우리가 남긴 이동 기록을 먼저 본다(2026-11-14). null = 학부모 화면이 아니거나
  // 아직 이 화면을 기록하기 전 → 아래 옛 판단 그대로(공개 사이트·선생님 화면 동작은 바뀌지 않는다)
  // false = 기록 없음 → 설치 앱·스토어 앱·브라우저 모두 고정 주소로(referrer·idx 로 넘어가지 않는다 —
  // referrer 는 결제창·로그인 등 학부모 화면 밖 주소일 수 있어, back 하면 그 바깥으로 돌아간다)
  const parentDecision = parentHistoryDecision(pathname);
  if (parentDecision !== null) return parentDecision;

  // 브라우저가 «바로 앞 같은 사이트 화면»을 알려 주면 그걸 믿는다 — 공개 화면 + 결제·계정·가입처럼 학부모 기록 밖 화면(2026-11-17).
  // 예전엔 공개 화면만 봐서 청구서(/payments)·내 계정에서 «←» 가 방금 화면이 아니라 고정 주소로 갔다.
  // 선생님·관리자 화면은 그쪽 세션의 기록 규칙을 따른다(여기선 건드리지 않음)
  if (!pathname.startsWith("/staff") && !pathname.startsWith("/admin")) {
    // 결제·신청 결과 화면은 바로 앞 칸(결제 직전 청구서·결제창)으로 돌아가지 않고 한 단계 위로(2026-11-17 검수)
    if (isResultPath(pathname)) return false;
    const previous = previousEntryState((window as Window & { navigation?: PublicNavigation }).navigation, window.location.origin);
    if (previous.kind === "ok") return true;
    // 앞 칸이 로그인·결과 화면 — 돌아가면 안 된다. referrer 로 넘어가 다시 «있음»이 되지 않게 여기서 끝낸다
    if (previous.kind === "blocked") return false;
  }

  const historyIndex = Number(window.history.state?.idx ?? 0);
  if (historyIndex > 0) return true;

  try {
    return Boolean(document.referrer) && new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** 바뀔 일이 없는 값(«브라우저에서 그리는 중인가»)용 — 구독할 것이 없다 */
const subscribeNever = () => () => {};

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
  // 기록이 없을 때 갈 «한 단계 위» — 공개 화면은 publicParentPath, 학부모 화면은 parentUpPath(2026-11-17).
  // 학부모 머리줄 fallbackHref(/mypage)는 학부모 홈에서만 그대로 쓰인다(홈의 위는 기존 규칙대로)
  const strictScope = staffOrAdminScope(pathname, scopeHref);
  // 서버가 그린 첫 화면과 브라우저의 첫 그림을 맞춘다(선생님·관리자): 서버는 기록을 못 읽어 «기록 없음»으로 그리는데
  // (역할 홈이면 빈 자리), 브라우저가 첫 그림부터 기록을 읽으면 버튼을 그려 둘이 어긋난다. 첫 그림은 서버와 같게, 그 직후 실제 기록으로
  const hydrated = useSyncExternalStore(subscribeNever, () => true, () => false);
  const backFallback = isPublicSitePath(pathname)
    ? publicParentPath(pathname, fallbackHref)
    : isParentScopePath(pathname) && pathname !== "/mypage"
      ? parentUpPath(pathname)
      : strictScope === "/staff" && pathname.startsWith("/staff/mypage/")
        ? "/staff/mypage" // 선생님 마이페이지 아래 화면(간편로그인 연결)의 한 단계 위 = 마이페이지(연결을 마치고 돌아오면 기록이 없다)
        : fallbackHref;

  // 앱의 첫 화면이라 돌아갈 곳이 없다. 죽은 버튼을 두느니 자리만 남긴다
  // (헤더가 격자 배치라 그냥 지우면 로고·제목이 밀린다).
  // «거쳐 가는 화면»(기사님 첫 화면 등)도 곧 다른 주소로 바뀌므로 버튼을 두지 않는다
  const nothingToGoBackTo =
    (strictScope !== null && isPassThroughPath(pathname)) ||
    resolveBackAction({
      hasHistory: (strictScope === null || hydrated) && canGoBackWithinApp(pathname, scopeHref),
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
      hasHistory: canGoBackWithinApp(pathname, scopeHref),
      pathname,
      fallbackHref: backFallback,
      scopeHref,
      isInstalledApp,
    });
    if (action.type === "back") router.back();
    else if (action.type === "push") {
      // 돌아갈 기록이 없어 한 단계 위로 갈 때는 «바꿔 끼우기»(replace) — 2026-11-17 운영 재현:
      // 상세에 바로 들어옴 → «←» 로 목록(push 로 쌓임) → 목록에서 «←» 가 history.back 으로 방금 상세로 되돌아갔다.
      // 바꿔 끼우면 상세 칸이 목록으로 바뀌어, 기기 뒤로 가기·다음 «←» 모두 그 위로 올라간다.
      // 선생님·관리자 화면도 같은 표시를 그 범위에 남긴다 — 안 남기면 역할 홈에 «←»(→ 이미 바뀐 칸의 앞 = 범위 밖)가 새로 생긴다
      const strictTarget = staffOrAdminScopeOf(action.href.split(/[?#]/)[0]);
      if (strictTarget && strictTarget === staffOrAdminScope(pathname, scopeHref)) markNextScopeNavigationAsReplace(strictTarget);
      // 학부모 기록 표시는 도착지가 학부모 화면일 때만(공개·선생님 화면에 남으면 나중 학부모 기록을 잘못 바꿔 끼운다)
      if (isParentScopePath(action.href)) markNextNavigationAsReplace();
      router.replace(action.href);
    }
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
