"use client";

import { useEffect, useState } from "react";

// 휴대폰 알림(웹푸시) 켜기·끄기 — 학부모 설정 화면과 직원(선생님·기사님) 머리줄이 함께 쓴다(2026-11-10).
// 동작은 예전 홈 알림 칸의 togglePush 그대로: 켜기 = 브라우저 구독 → /api/push POST, 끄기 = 구독 해제 → /api/push DELETE.
// /api/push 는 역할 제한이 없다(로그인 연결 계정으로 주인을 정한다).

// 같은 화면에 이 훅을 쓰는 부품이 둘(머리줄 토글 + 기사님 안내 줄)이어도 한쪽에서 켜면 다른 쪽도 바로 바뀌게 알리는 신호
const PUSH_CHANGED_EVENT = "stiz-push-changed";

export function usePushSubscription() {
    const [pushSupported, setPushSupported] = useState(false);
    const [pushEnabled, setPushEnabled] = useState(false);
    const [pushLoading, setPushLoading] = useState(false);
    // 지원 여부를 아직 모르는 첫 그림에서 «지원 안 함» 안내가 깜빡이지 않게
    const [checked, setChecked] = useState(false);

    // 브라우저 푸시 지원 여부 및 현재 구독 상태 확인
    useEffect(() => {
        if ("serviceWorker" in navigator && "PushManager" in window) {
            setPushSupported(true);
            navigator.serviceWorker.ready.then(reg => {
                reg.pushManager.getSubscription().then(sub => {
                    setPushEnabled(!!sub);
                });
            });
            // Service Worker 등록
            navigator.serviceWorker.register("/sw.js").catch(() => {});
        }
        setChecked(true);
        // 다른 부품이 켜고 끄면 같은 값으로 맞춘다
        const onChanged = (e: Event) => setPushEnabled(Boolean((e as CustomEvent<boolean>).detail));
        window.addEventListener(PUSH_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(PUSH_CHANGED_EVENT, onChanged);
    }, []);

    // 푸시 알림 구독/해제 토글
    async function togglePush() {
        setPushLoading(true);
        try {
            const reg = await navigator.serviceWorker.ready;
            const existing = await reg.pushManager.getSubscription();

            if (existing) {
                // 구독 해제
                await existing.unsubscribe();
                await fetch("/api/push", {
                    method: "DELETE",
                    body: JSON.stringify({ endpoint: existing.endpoint }),
                });
                setPushEnabled(false);
                window.dispatchEvent(new CustomEvent(PUSH_CHANGED_EVENT, { detail: false }));
            } else {
                // 구독 등록
                const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
                if (!vapidKey) throw new Error("VAPID 키 없음");
                const sub = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
                });
                await fetch("/api/push", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ subscription: sub.toJSON() }),
                });
                setPushEnabled(true);
                window.dispatchEvent(new CustomEvent(PUSH_CHANGED_EVENT, { detail: true }));
            }
        } catch (e) {
            console.error("Push toggle error:", e);
            alert("알림 설정에 실패했습니다. 브라우저 알림 권한을 확인해주세요.");
        }
        setPushLoading(false);
    }

    return { pushSupported, pushEnabled, pushLoading, checked, togglePush };
}

// VAPID 공개키를 Uint8Array로 변환 (Web Push API에 필요)
function urlBase64ToUint8Array(base64String: string): Uint8Array {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) {
        outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
}
