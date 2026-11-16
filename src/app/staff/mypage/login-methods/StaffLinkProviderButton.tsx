"use client";

import { useStoreApp } from "@/hooks/useStoreApp";
import {
  STAFF_STORE_APP_LINK_NOTICE,
  staffLinkButtonVisible,
  staffLinkNoticeVisible,
} from "@/lib/account/login-methods-rules";

// 직원 «간편로그인 연결»의 «연결하기» 버튼(2026-11-17).
// 학부모 화면(LinkProviderButton)과 같은 앱 판정을 쓴다: 서버가 본 사용자 에이전트 표식(serverStoreApp) +
// 화면이 본 브라우저 저장소 표식(useStoreApp). 어느 쪽이든 스토어 앱이면 버튼을 그리지 않는다.
// 학부모와 다른 점: 앱에서 바깥 브라우저로 넘기는 1회용 표는 직원에게 만들지 않는다(보안 검수 결정) —
// 그래서 앱에서는 항상 숨기고 «휴대폰 브라우저에서 연결» 안내만 보인다.

export default function StaffLinkProviderButton({ provider, serverStoreApp }: { provider: string; serverStoreApp: boolean }) {
  const clientStoreApp = useStoreApp();
  if (!staffLinkButtonVisible({ serverStoreApp, clientStoreApp })) return null;
  return (
    // <Link> 금지 — 미리 불러오기가 시작 주소를 열면 로그인 열쇠(PKCE)가 덮어써진다(2026-10-26 사고).
    <a
      href={`/auth/oauth/${provider}?intent=link`}
      // 줄마다 반복되는 작업 → 옅은 바탕(tonal). 누르는 영역 44px 는 버튼 부품이 맡는다
      className="academy-button-tonal shrink-0"
    >
      연결하기
    </a>
  );
}

/** 스토어 앱 안에서만 보이는 한 줄 안내 */
export function StaffStoreAppLinkNotice({ serverStoreApp }: { serverStoreApp: boolean }) {
  const clientStoreApp = useStoreApp();
  if (!staffLinkNoticeVisible({ serverStoreApp, clientStoreApp })) return null;
  return (
    <p role="status" className="rounded-xl bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
      {STAFF_STORE_APP_LINK_NOTICE}
    </p>
  );
}
