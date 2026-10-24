"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isPublicSitePath } from "@/lib/public-site-path";
import "./public-sport.css";

export default function PublicSiteTheme({ children, className = "" }: {
  children: ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const isPublic = isPublicSitePath(pathname);

  return <div className={`${isPublic ? "stiz-public-sport " : ""}${className}`.trim()}>{children}</div>;
}
