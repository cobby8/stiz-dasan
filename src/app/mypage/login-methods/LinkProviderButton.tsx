"use client";

import { useStoreApp, STORE_APP_PASSWORD_LOGIN_NOTICE } from "@/hooks/useStoreApp";

// 간편로그인 «연결하기» 버튼 — 스토어 앱에서는 숨긴다(2026-11-13 a1).
// 앱 안에서 누르면 앱 밖 브라우저로 나갔다가 연결 결과가 앱으로 돌아오지 않는다.
// 판정은 브라우저 저장소(sessionStorage)라 서버에서 알 수 없다 — 모르는 동안(null)은 그리지 않는다.

export default function LinkProviderButton({ provider }: { provider: string }) {
  const storeApp = useStoreApp();
  if (storeApp !== false) return null;
  return (
    // <Link> 금지 — 미리 불러오기가 시작 주소를 열면 로그인 열쇠(PKCE)가 덮어써진다(2026-10-26 사고).
    <a
      href={`/auth/oauth/${provider}?intent=link`}
      // 줄마다 반복되는 작업 → 옅은 바탕(tonal). 꽉 찬 주 색은 화면에 하나뿐인 주 버튼 몫(2026-11-13 UI 통일)
      className="academy-button-tonal shrink-0"
    >
      연결하기
    </a>
  );
}

/** 스토어 앱에서만 보이는 한 줄 안내 */
export function StoreAppLinkNotice() {
  const storeApp = useStoreApp();
  if (storeApp !== true) return null;
  return (
    <p role="status" className="mb-3 rounded-xl bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
      {STORE_APP_PASSWORD_LOGIN_NOTICE} 간편로그인 연결은 휴대폰 브라우저에서 할 수 있어요.
    </p>
  );
}
