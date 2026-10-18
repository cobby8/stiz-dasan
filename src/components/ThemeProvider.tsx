"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { usePathname } from "next/navigation";
import { isAcademyPath } from "@/lib/academyTheme";

type ThemeProviderProps = React.ComponentProps<typeof NextThemesProvider>;

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const academy = isAcademyPath(usePathname());
  return (
    <NextThemesProvider
      {...props}
      forcedTheme={academy ? "light" : props.forcedTheme}
    >
      {children}
    </NextThemesProvider>
  );
}
