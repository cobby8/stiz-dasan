"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { usePathname } from "next/navigation";
import { isAcademyPath } from "@/lib/academyTheme";
import { isPublicSitePath } from "@/lib/public-site-path";

type ThemeProviderProps = React.ComponentProps<typeof NextThemesProvider>;

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const pathname = usePathname();
  const academy = isAcademyPath(pathname);
  const publicSite = isPublicSitePath(pathname);
  return (
    <NextThemesProvider
      key={publicSite ? "public-site" : "application"}
      {...props}
      storageKey={publicSite ? "stiz-public-theme" : props.storageKey}
      defaultTheme={publicSite ? "light" : props.defaultTheme}
      enableSystem={publicSite ? false : props.enableSystem}
      forcedTheme={academy ? "light" : props.forcedTheme}
    >
      {children}
    </NextThemesProvider>
  );
}
