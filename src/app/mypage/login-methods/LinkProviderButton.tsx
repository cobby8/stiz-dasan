"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useStoreApp, STORE_APP_PASSWORD_LOGIN_NOTICE } from "@/hooks/useStoreApp";
import { LINK_HANDOFF_BUTTON_NOTICE } from "@/lib/account-link-handoff/rules";

// 간편로그인 «연결하기» 버튼.
// - handoffHref 가 있으면(서버가 앱 표식 + 앱 로그인 스위치 켜짐을 확인, 2026-11-15 A안) → 1회용 표를 붙인
//   바깥 브라우저 주소를 일반 링크로 그린다. 앱은 www 가 아닌 주소를 «누르면» 휴대폰 기본 브라우저로 연다.
//   ⚠️ 자바스크립트로 주소를 바꾸면(누른 동작이 아니면) 앱이 막는다 — 반드시 미리 만든 <a> 를 한 번 눌러 연다.
// - 없으면 지금처럼: 브라우저 → 기존 연결 링크, 스토어 앱(표식 전 옛 앱·스위치 꺼짐) → 숨김(2026-11-13 a1).
//   판정은 브라우저 저장소(sessionStorage)라 서버에서 알 수 없다 — 모르는 동안(null)은 그리지 않는다.

export default function LinkProviderButton({ provider, handoffHref }: { provider: string; handoffHref?: string }) {
  const storeApp = useStoreApp();
  if (handoffHref) {
    return (
      <span className="flex shrink-0 flex-col items-end gap-1">
        {/* <Link> 금지 — 미리 불러오기가 주소를 열면 안 된다. noreferrer: 이 화면 주소를 바깥으로 넘기지 않는다 */}
        <a href={handoffHref} rel="noreferrer noopener" className="academy-button-tonal shrink-0">
          연결하기
        </a>
        <span className="max-w-[11rem] text-right text-xs text-[var(--color-academy-muted)]">{LINK_HANDOFF_BUTTON_NOTICE}</span>
      </span>
    );
  }
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

/** 스토어 앱에서 연결할 수 없을 때만 보이는 한 줄 안내(앱 연결 버튼이 보이는 화면에서는 page 가 그리지 않는다) */
export function StoreAppLinkNotice() {
  const storeApp = useStoreApp();
  if (storeApp !== true) return null;
  return (
    <p role="status" className="mb-3 rounded-xl bg-[var(--color-academy-soft)] px-3 py-2 text-sm text-[var(--color-academy-ink)]">
      {STORE_APP_PASSWORD_LOGIN_NOTICE} 간편로그인 연결은 휴대폰 브라우저에서 할 수 있어요.
    </p>
  );
}

/**
 * 바깥 브라우저에서 연결을 마치고 앱으로 돌아오면(화면이 다시 보이면) 서버 화면을 새로 받는다 —
 * «연결됨» 표시와 새 1회용 표(쓴 표는 다시 못 쓴다)를 반영하려고.
 */
export function LinkHandoffRefresher() {
  const router = useRouter();
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === "visible") router.refresh();
    }
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [router]);
  return null;
}
