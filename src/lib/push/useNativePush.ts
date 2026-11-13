"use client";

import { useCallback, useEffect, useState } from "react";
import {
    NATIVE_PUSH_CHANGED_EVENT,
    askNativePush,
    hasNativePushBridge,
    nativePushView,
    syncNativePushToken,
    type NativePushView,
} from "@/lib/push/nativePushBridge";

/**
 * 스토어 앱 알림 상태(d2, 2026-11-14) — 설정 화면·직원 안내 줄이 함께 쓴다.
 * view: "checking"(확인 중) | unavailable | default | denied | granted (판정은 nativePushView 한 곳)
 * request(): 휴대폰 권한 창을 띄우고(아직 안 물어봤을 때만), 켜지면 바로 토큰을 등록한다.
 * 브라우저에서는 늘 "unavailable" — 화면은 브라우저 웹푸시 스위치(usePushSubscription)를 그대로 쓴다.
 */
export function useNativePush() {
    const [view, setView] = useState<NativePushView | "checking">("checking");
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        if (!hasNativePushBridge()) {
            setView("unavailable");
            return;
        }
        setView(nativePushView(await askNativePush("state")));
    }, []);

    useEffect(() => {
        void refresh();
        // 다른 부품(자동 등록기 등)이 상태를 바꾸면 따라간다
        const onChanged = (e: Event) => setView((e as CustomEvent<NativePushView>).detail);
        // 휴대폰 설정에서 알림을 켜고 돌아오면 다시 확인한다
        const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
        window.addEventListener(NATIVE_PUSH_CHANGED_EVENT, onChanged);
        document.addEventListener("visibilitychange", onVisible);
        return () => {
            window.removeEventListener(NATIVE_PUSH_CHANGED_EVENT, onChanged);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, [refresh]);

    async function request() {
        setBusy(true);
        try {
            const state = await askNativePush("request");
            const next = nativePushView(state);
            setView(next);
            await syncNativePushToken(state, true);
            window.dispatchEvent(new CustomEvent(NATIVE_PUSH_CHANGED_EVENT, { detail: next }));
        } finally {
            setBusy(false);
        }
    }

    return { view, busy, request };
}
