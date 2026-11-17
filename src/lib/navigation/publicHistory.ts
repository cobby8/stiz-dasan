export type PublicNavigation = {
  currentEntry?: { key: string } | null;
  entries: () => Array<{ key: string; url?: string | null }>;
};

/**
 * 바로 앞 기록 칸의 경로(같은 사이트일 때만). 브라우저가 제공하는 이전 항목만 읽는다 — 기록을 덧붙이거나 저장하지 않는다.
 * 로그인·인증 화면(/login·/auth)은 «돌아갈 화면»이 아니라 null(2026-11-17 — 로그인 뒤 ← 가 로그인 화면으로 가지 않게).
 */
export function previousSameOriginPath(navigation: PublicNavigation | undefined, origin: string): string | null {
  const prev = previousEntryState(navigation, origin);
  return prev.kind === "ok" ? prev.path : null;
}

/**
 * «돌아가면 안 되는» 앞 칸 — 로그인·인증 화면, 결제·신청 결과 화면(2026-11-17 검수).
 * 결과 화면으로 돌아가면 결제 확인 요청이 다시 나가거나 다 끝난 화면이 다시 뜬다.
 */
export function isNoReturnPath(pathname: string) {
  return (
    pathname === "/login" || pathname.startsWith("/login/") || pathname.startsWith("/auth/") ||
    pathname === "/payments/success" || pathname === "/payments/fail" || pathname.startsWith("/payments/review/") ||
    pathname === "/payments/cafe24/success" || pathname === "/mypage/payments/done" || pathname === "/apply/trial/pay/done" ||
    /^\/pay\/[^/]+\/success$/.test(pathname)
  );
}

/** 결제·신청 «결과» 화면 — 여기선 바로 앞 칸(결제 직전 청구서·결제창)으로 돌아가지 않고 한 단계 위로 간다 */
export function isResultPath(pathname: string) {
  return isNoReturnPath(pathname) && !pathname.startsWith("/login") && !pathname.startsWith("/auth/");
}

/**
 * 바로 앞 칸의 상태 — ok(같은 사이트, 돌아가도 됨) / blocked(같은 사이트지만 돌아가면 안 됨) / none(없음·다른 사이트·못 읽음).
 * blocked 와 none 을 나누는 이유: none 이면 부르는 쪽이 다른 단서(referrer)를 보지만, blocked 면 거기서 «돌아갈 곳 없음»으로 끝내야 한다.
 */
export function previousEntryState(
  navigation: PublicNavigation | undefined,
  origin: string,
): { kind: "ok"; path: string } | { kind: "blocked" } | { kind: "none" } {
  try {
    const entries = navigation?.entries() ?? [];
    const index = entries.findIndex((entry) => entry.key === navigation?.currentEntry?.key);
    const previous = index > 0 ? entries[index - 1]?.url : null;
    if (!previous) return { kind: "none" };
    const url = new URL(previous);
    if (url.origin !== origin) return { kind: "none" };
    if (isNoReturnPath(url.pathname)) return { kind: "blocked" };
    return { kind: "ok", path: url.pathname };
  } catch {
    return { kind: "none" };
  }
}

export function hasSameOriginPreviousEntry(navigation: PublicNavigation | undefined, origin: string) {
  return previousSameOriginPath(navigation, origin) !== null;
}

/** 지금 창의 «바로 앞 같은 사이트 화면» 경로(브라우저가 Navigation API 를 못 주면 null) */
export function browserPreviousPath(): string | null {
  if (typeof window === "undefined") return null;
  return previousSameOriginPath((window as Window & { navigation?: PublicNavigation }).navigation, window.location.origin);
}

/** 기록을 읽을 수 없는 브라우저에서도 상세 화면은 부모 목록으로 돌아간다. */
export function publicParentPath(pathname: string, fallback: string) {
  if (pathname.startsWith("/notices/")) return "/notices";
  if (pathname.startsWith("/seasonal/") && pathname.endsWith("/apply")) return pathname.slice(0, -6);
  if (pathname.startsWith("/seasonal/")) return "/seasonal";
  if (pathname.startsWith("/apply/")) return "/apply";
  if (pathname.startsWith("/shop/product/")) return "/shop";
  if (pathname === "/programs/order") return "/programs";
  return fallback;
}
