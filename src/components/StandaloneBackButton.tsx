"use client";

import { usePathname } from "next/navigation";
import AppBackButton from "@/components/AppBackButton";

// 자체 머리줄이 없는 단독 화면 — 떠 있는 «←» 로 돌아갈 길을 준다.
// 2026-11-17: 옛 설치 안내 주소(/teacher-app·/staff/install·/mypage/install 등)는 전부 /install 로 넘어간다(next.config redirects).
// /teacher-app 은 이제 화면이 열리지 않아 목록에서 빼고, 머리줄이 없는 /install 을 넣었다.
// ⚠️ 여기에 넣는 주소는 업데이트 안내 배너 숨김 목록(@/lib/storeApp APP_UPDATE_HIDDEN_PREFIXES)에도 넣는다 — 겹치지 않게(테스트가 대조).
const STANDALONE_PREFIXES = [
  "/account/activate",
  "/auth/continue",
  "/install",
  "/invite",
  "/login",
  "/payments",
  "/setup",
  "/signup/parent",
];

function fallbackFor(pathname: string) {
  // 청구서·결제 결과 화면의 한 단계 위 = 학부모 청구 목록(2026-11-17 — 예전엔 학부모 홈이라 목록에서 와도 홈으로 갔다)
  if (pathname.startsWith("/payments")) return "/mypage/payments";
  // /install 은 로그인 없이 보는 공개 화면이라 돌아갈 기록이 없으면 공개 홈(/)이 맞다(예전 /teacher-app → /staff 는 없앴다).
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
