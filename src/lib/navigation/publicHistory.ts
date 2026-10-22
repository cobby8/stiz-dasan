export type PublicNavigation = {
  currentEntry?: { key: string } | null;
  entries: () => Array<{ key: string; url?: string | null }>;
};

/** 브라우저가 제공하는 이전 항목만 읽는다. 기록을 덧붙이거나 저장하지 않는다. */
export function hasSameOriginPreviousEntry(navigation: PublicNavigation | undefined, origin: string) {
  try {
    const entries = navigation?.entries() ?? [];
    const index = entries.findIndex((entry) => entry.key === navigation?.currentEntry?.key);
    const previous = index > 0 ? entries[index - 1]?.url : null;
    return Boolean(previous) && new URL(previous!).origin === origin;
  } catch {
    return false;
  }
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
