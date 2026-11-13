"use client";

import { useEffect, useState } from "react";
import { PARENT_OAUTH_PROVIDERS, type ParentOAuthProvider } from "@/lib/parent-oauth";

/** 서버가 알려 준 간편로그인 상태. providers = 켜진 제공자, nativeApp = 앱 안 간편로그인 스위치(a1) */
export type OAuthAvailability = { providers: ParentOAuthProvider[]; nativeApp: boolean };

/**
 * 지금 켜진 간편로그인 목록 + 앱 안 간편로그인 스위치. 아직 모르면 null.
 * 모르는 동안에는 버튼을 그리지 않는다 — 먼저 그렸다가 꺼진 것을 지우면,
 * 그 사이에 누른 학부모는 Supabase 오류 화면을 본다.
 */
export function useOAuthAvailability(): OAuthAvailability | null {
  const [providers, setProviders] = useState<ParentOAuthProvider[] | null>(null);
  const [nativeApp, setNativeApp] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/providers")
      .then((response) => (response.ok ? response.json() : { providers: [] }))
      .then((data: { providers?: unknown; nativeApp?: unknown }) => {
        if (!alive) return;
        // 서버가 아는 이름만 받는다(엉뚱한 /auth/oauth/<값> 링크를 만들지 않게).
        const list = Array.isArray(data?.providers) ? data.providers : [];
        // 앱 스위치는 정확히 true 일 때만 켠다(애매하면 끈다)
        setNativeApp(data?.nativeApp === true);
        setProviders(PARENT_OAUTH_PROVIDERS.filter((provider) => list.includes(provider)));
      })
      .catch(() => {
        if (alive) setProviders([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  return providers === null ? null : { providers, nativeApp };
}

/** 지금 켜진 간편로그인 목록. 아직 모르면 null. */
export function useEnabledOAuthProviders(): ParentOAuthProvider[] | null {
  return useOAuthAvailability()?.providers ?? null;
}
