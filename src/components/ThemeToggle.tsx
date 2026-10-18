"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import FontFreeIcon from "./ui/FontFreeIcon";

export function ThemeToggle() {
  const { resolvedTheme, setTheme, forcedTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return <div className="h-10 w-10" aria-hidden="true" />;
  }

  if (forcedTheme) return null;

  const isDark = resolvedTheme === "dark";
  const label = isDark ? "라이트 모드로 변경" : "다크 모드로 변경";

  return (
    <button
      type="button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="flex h-10 w-10 items-center justify-center rounded-lg border border-gray-200 bg-white text-gray-700 transition-colors hover:bg-gray-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-800"
      aria-label={label}
      title={label}
    >
      <FontFreeIcon name={isDark ? "light_mode" : "dark_mode"} size={22} />
    </button>
  );
}
