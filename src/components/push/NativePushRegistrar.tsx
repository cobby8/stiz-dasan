"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
    NATIVE_PUSH_ASKED_KEY,
    NATIVE_PUSH_CHANGED_EVENT,
    askNativePush,
    hasNativePushBridge,
    nativePushView,
    syncNativePushToken,
} from "@/lib/push/nativePushBridge";

/**
 * 스토어 앱 알림 토큰 자동 등록(e2, 2026-11-14). 루트 레이아웃에 한 번 둔다. 화면은 그리지 않는다.
 *
 * 화면이 바뀔 때마다(같은 토큰은 6시간에 한 번만 보냄):
 *  1) 앱 알림 창구가 없으면(브라우저·옛 앱) 아무것도 안 한다.
 *  2) 알림이 켜져 있으면 토큰을 서버에 등록한다(로그인한 사람 기준 — 로그인 전이면 서버가 401, 다음 화면에서 다시).
 *  3) 아직 한 번도 안 물어봤고 로그인돼 있으면, 이 기기에서 딱 한 번 휴대폰 권한 창을 띄운다.
 *     거절하면 다시 조르지 않는다(설정 화면에 «휴대폰 설정에서 알림을 켜 주세요»).
 */
export default function NativePushRegistrar() {
    const pathname = usePathname();

    useEffect(() => {
        if (!hasNativePushBridge()) return;
        let cancelled = false;
        void (async () => {
            const state = await askNativePush("state");
            if (cancelled || !state?.supported) return;
            if (state.permission === "granted") {
                await syncNativePushToken(state);
                return;
            }
            if (state.permission !== "default") return;
            try {
                if (window.localStorage.getItem(NATIVE_PUSH_ASKED_KEY) === "1") return;
            } catch {
                return; // 기억할 수 없으면 자동으로 묻지 않는다(설정 화면 «켜기»로만)
            }
            // 로그인한 사람에게만 묻는다 — 첫 화면(로그인 전)에서 알림부터 묻지 않게
            const me = await fetch("/api/push/native", { method: "GET" }).catch(() => null);
            if (cancelled || !me?.ok) return;
            try {
                window.localStorage.setItem(NATIVE_PUSH_ASKED_KEY, "1");
            } catch {
                return;
            }
            const asked = await askNativePush("request");
            await syncNativePushToken(asked, true);
            window.dispatchEvent(new CustomEvent(NATIVE_PUSH_CHANGED_EVENT, { detail: nativePushView(asked) }));
        })();
        return () => {
            cancelled = true;
        };
    }, [pathname]);

    return null;
}
