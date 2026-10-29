"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";
import { usePathname } from "next/navigation";
import { ACADEMY_THEME_COLOR, isAcademyPath } from "@/lib/academyTheme";

const LIGHT_THEME_COLOR = "#ffffff"; // 공개 홈페이지 흰 바탕(스포츠 스타일)
const DARK_THEME_COLOR = "#15181c"; // 다크 차콜

export default function ThemeColorUpdater() {
  const { resolvedTheme } = useTheme();
  const pathname = usePathname();

  useEffect(() => {
    const themeColor = isAcademyPath(pathname) ? ACADEMY_THEME_COLOR : resolvedTheme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

    if (meta) {
      meta.content = themeColor;
      return;
    }

    const nextMeta = document.createElement("meta");
    nextMeta.name = "theme-color";
    nextMeta.content = themeColor;
    document.head.append(nextMeta);
  }, [resolvedTheme, pathname]);

  return null;
}
