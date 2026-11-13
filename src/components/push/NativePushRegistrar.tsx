"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
    NATIVE_PUSH_ASKED_KEY,
    NATIVE_PUSH_CHANGED_EVENT,
    askNativePush,
    clearNativePushSync,
    fetchServerPushConfigured,
    hasNativePushBridge,
    isLoginPath,
    nativePushView,
    syncNativePushToken,
} from "@/lib/push/nativePushBridge";

/** 지금 이 웹뷰에 로그인한 사람의 Auth id — 저장된 세션만 읽는다(네트워크 없음). 없으면 null */
async function sessionUserId(): Promise<string | null> {
    try {
        const { data } = await createClient().auth.getSession();
        return data.session?.user?.id ?? null;
    } catch {
        return null;
    }
}

/**
 * 스토어 앱 알림 토큰 자동 등록(e2, 2026-11-14). 루트 레이아웃에 한 번 둔다. 화면은 그리지 않는다.
 *
 * 화면이 바뀔 때마다(같은 토큰·같은 사람이면 6시간에 한 번만 보냄):
 *  1) 앱 알림 창구가 없으면(브라우저·옛 앱) 아무것도 안 한다.
 *  2) 로그인 화면이거나 로그인한 사람이 없으면 «방금 보냄» 기록을 지운다 — 다른 계정으로 로그인하면 바로 다시 등록되게
 *     (logout() 을 거치지 않는 로그아웃 경로에서도 다음 로그인 때 토큰 주인이 새 계정으로 옮겨진다).
 *  3) 알림이 켜져 있으면 토큰을 서버에 등록한다(주인은 서버가 로그인 쿠키로 정한다).
 *  4) 아직 한 번도 안 물어봤고 로그인돼 있고 서버 발송 키가 있으면, 이 기기에서 딱 한 번 휴대폰 권한 창을 띄운다.
 *     거절하면 다시 조르지 않는다(설정 화면에 «휴대폰 설정에서 알림을 켜 주세요»).
 */
export default function NativePushRegistrar() {
    const pathname = usePathname();

    useEffect(() => {
        if (!hasNativePushBridge()) return;
        let cancelled = false;
        void (async () => {
            if (isLoginPath(pathname)) {
                clearNativePushSync();
                return;
            }
            const userId = await sessionUserId();
            if (!userId) {
                clearNativePushSync();
                return;
            }
            const state = await askNativePush("state");
            if (cancelled || !state?.supported) return;
            if (state.permission === "granted") {
                await syncNativePushToken(state, { userId });
                return;
            }
            if (state.permission !== "default") return;
            try {
                if (window.localStorage.getItem(NATIVE_PUSH_ASKED_KEY) === "1") return;
            } catch {
                return; // 기억할 수 없으면 자동으로 묻지 않는다(설정 화면 «켜기»로만)
            }
            // 서버가 실제로 보낼 수 있을 때만 묻는다(키가 없으면 허용해도 알림이 안 온다)
            const configured = await fetchServerPushConfigured();
            if (cancelled || configured !== true) return;
            try {
                window.localStorage.setItem(NATIVE_PUSH_ASKED_KEY, "1");
            } catch {
                return;
            }
            const asked = await askNativePush("request");
            await syncNativePushToken(asked, { force: true, userId });
            window.dispatchEvent(new CustomEvent(NATIVE_PUSH_CHANGED_EVENT, { detail: nativePushView(asked, configured) }));
        })();
        return () => {
            cancelled = true;
        };
    }, [pathname]);

    return null;
}
