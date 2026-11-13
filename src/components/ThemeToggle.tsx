"use client";

import * as React from "react";
import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { resolvedTheme, setTheme, forcedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    // 글자 버튼(«어둡게») 폭만큼 자리를 잡아 둔다 — 켜지는 순간 머리줄이 출렁이지 않게
    return <div className="h-11 w-[58px] md:h-10" aria-hidden="true" />;
  }

  if (forcedTheme) return null;

  const isDark = resolvedTheme === "dark";
  const label = isDark ? "라이트 모드로 변경" : "다크 모드로 변경";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="flex h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-lg border px-2 text-sm font-medium md:h-10 border-[var(--color-public-line)] bg-white text-[var(--color-public-muted)] transition-colors hover:bg-[var(--color-public-tint)] dark:border-[var(--color-public-line)] dark:bg-[var(--color-public-paper)] dark:text-[var(--color-public-ink)] dark:hover:bg-[var(--color-public-tint)]"
      aria-label={label}
      title={label}
    >
      {/* 2026-11-14 아이콘 완전 제거: 달·해 아이콘 대신 «누르면 일어날 일»을 글자로 말한다 */}
      {isDark ? "밝게" : "어둡게"}
    </button>
  );
}
