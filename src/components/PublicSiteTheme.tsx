"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isPublicSitePath } from "@/lib/public-site-path";
import "./public-sport.css";

export default function PublicSiteTheme({ children, className = "", publicScope }: {
  children: ReactNode;
  className?: string;
  publicScope?: boolean;
}) {
  const pathname = usePathname();
  // 서버가 공개 페이지임을 아는 경우, 첫 HTML을 브라우저 주소 초기화에 의존시키지 않는다.
  const isPublic = publicScope ?? isPublicSitePath(pathname);

  return <div className={`${isPublic ? "stiz-public-sport " : ""}${className}`.trim()}>{children}</div>;
}
