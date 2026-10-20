"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { ACADEMY_THEME_COLOR, isAcademyPath } from "@/lib/academyTheme";

export default function ThemeColorUpdater() {
  const pathname = usePathname();
  useEffect(() => {
    const update = () => {
      const site = document.querySelector<HTMLElement>(".public-site");
      const color = !isAcademyPath(pathname) && site ? getComputedStyle(site).getPropertyValue("--color-public-accent").trim() : ACADEMY_THEME_COLOR;
      let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
      if (!meta) { meta = document.createElement("meta"); meta.name = "theme-color"; document.head.append(meta); }
      meta.content = color || ACADEMY_THEME_COLOR;
    };
    update();
    const site = document.querySelector(".public-site");
    const observer = new MutationObserver(update);
    if (site) observer.observe(site, { attributes: true, attributeFilter: ["data-public-theme"] });
    return () => observer.disconnect();
  }, [pathname]);
  return null;
}
