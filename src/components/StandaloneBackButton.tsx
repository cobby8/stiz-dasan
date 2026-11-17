"use client";

import { usePathname } from "next/navigation";
import AppBackButton from "@/components/AppBackButton";

const STANDALONE_PREFIXES = [
  "/account/activate",
  "/auth/continue",
  "/invite",
  "/login",
  "/payments",
  "/setup",
  "/signup/parent",
  "/teacher-app",
];

function fallbackFor(pathname: string) {
  // 청구서·결제 결과 화면의 한 단계 위 = 학부모 청구 목록(2026-11-17 — 예전엔 학부모 홈이라 목록에서 와도 홈으로 갔다)
  if (pathname.startsWith("/payments")) return "/mypage/payments";
  if (pathname.startsWith("/teacher-app")) return "/staff";
  return "/";
}

export default function StandaloneBackButton() {
  const pathname = usePathname() || "/";
  const shouldShow = STANDALONE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  if (!shouldShow) return null;

  return (
    <div className="fixed left-3 top-[max(0.75rem,env(safe-area-inset-top))] z-[90]">
      <AppBackButton fallbackHref={fallbackFor(pathname)} variant="floating" />
    </div>
  );
}
