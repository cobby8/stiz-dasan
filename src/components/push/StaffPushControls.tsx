"use client";

import { usePushSubscription } from "@/lib/push/usePushSubscription";
import { useStoreAppLacks } from "@/components/storeApp/useStoreAppLacks";
// 스토어 앱 안에서는 브라우저 웹푸시 대신 앱 알림(FCM) 상태로 안내한다(d2, 2026-11-14). 문구는 한 곳(NATIVE_PUSH_NOTES)
import { useNativePush } from "@/lib/push/useNativePush";
import { NATIVE_PUSH_NOTES } from "@/lib/push/nativePushBridge";

// 직원(선생님·기사님) 화면의 휴대폰 알림 켜기 (2026-11-10).
// 기사님·코치 웹푸시 구독이 0건이었던 원인 = 켜는 버튼이 학부모 설정 화면에만 있었다.
// 동작은 학부모와 같은 훅(usePushSubscription → /api/push, 역할 제한 없음).

/** 머리줄 알림 토글 — 글자 «알림 켜짐/꺼짐»(2026-11-14 아이콘 완전 제거), 누르는 높이 44. 이 기기가 웹푸시를 못 받으면 아무것도 안 그린다 */
export function StaffPushToggle() {
    const { pushSupported, pushEnabled, pushLoading, checked, togglePush } = usePushSubscription();
    const appLacksPush = useStoreAppLacks("push");
    if (appLacksPush || !checked || !pushSupported) return null;
    return (
        <button
            type="button"
            role="switch"
            aria-checked={pushEnabled}
            aria-label={pushEnabled ? "휴대폰 알림 켜짐" : "휴대폰 알림 켜기"}
            disabled={pushLoading}
            onClick={togglePush}
            className={`inline-flex min-h-11 shrink-0 items-center justify-center whitespace-nowrap rounded-lg px-2 text-sm font-medium transition-colors hover:bg-[var(--color-academy-soft)] disabled:opacity-60 ${pushEnabled ? "text-[var(--color-academy-success)]" : "text-[var(--color-academy-muted)]"}`}
        >
            {pushEnabled ? "알림 켜짐" : "알림 꺼짐"}
        </button>
    );
}

/**
 * 기사님 상단 한 줄 — 알림이 꺼져 있을 때만. 켜면 사라진다.
 * 이 기기가 웹푸시를 못 받으면(아이폰 사파리 등) 홈 화면 추가 안내 한 줄.
 */
export function StaffPushBanner() {
    const { pushSupported, pushEnabled, pushLoading, checked, togglePush } = usePushSubscription();
    const appLacksPush = useStoreAppLacks("push");
    const app = useNativePush();
    const row = "mx-auto flex min-h-11 max-w-lg items-center gap-2 px-4 text-sm";
    if (appLacksPush) {
        // 앱 안: 켜짐·확인 중이면 안 그림 / 아직 안 물어봤으면 «켜기» / 거절했으면 휴대폰 설정 / 못 받는 앱이면 문자·카카오톡
        if (app.view === "granted" || app.view === "checking") return null;
        if (app.view === "default") {
            return (
                <div role="note" className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)]">
                    <div className={row}>
                        <span className="min-w-0 flex-1 text-[var(--color-academy-ink)]">알림을 켜면 명단 변경을 바로 받아요</span>
                        <button type="button" onClick={() => void app.request()} disabled={app.busy} className="academy-button-primary min-h-11 shrink-0">
                            {app.busy ? "켜는 중" : "켜기"}
                        </button>
                    </div>
                </div>
            );
        }
        return (
            <div role="note" className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)]">
                <p className={`${row} text-[var(--color-academy-ink)]`}>
                    {app.view === "denied" ? NATIVE_PUSH_NOTES.denied : NATIVE_PUSH_NOTES.unavailable}
                </p>
            </div>
        );
    }
    if (!checked || pushEnabled) return null;
    if (!pushSupported) {
        return (
            <div role="note" className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)]">
                <p className={`${row} text-[var(--color-academy-ink)]`}>
                    아이폰은 홈 화면에 추가한 앱에서 알림을 켤 수 있어요
                </p>
            </div>
        );
    }
    return (
        <div role="note" className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)]">
            <div className={row}>
                <span className="min-w-0 flex-1 text-[var(--color-academy-ink)]">알림을 켜면 명단 변경을 바로 받아요</span>
                <button type="button" onClick={togglePush} disabled={pushLoading} className="academy-button-primary min-h-11 shrink-0">
                    {pushLoading ? "켜는 중" : "켜기"}
                </button>
            </div>
        </div>
    );
}
