"use client";

import { usePushSubscription } from "@/lib/push/usePushSubscription";
import { useStoreAppLacks } from "@/components/storeApp/useStoreAppLacks";

// 스토어 앱(현재 버전)은 앱 알림을 못 받는다(d2) — 안 되는 켜기 버튼 대신 안내. 판정은 @/lib/storeApp 한 곳
const STORE_APP_PUSH_NOTE = "앱 알림은 준비 중이에요. 중요한 안내는 문자·카카오톡으로 보내드려요";

// 직원(선생님·기사님) 화면의 휴대폰 알림 켜기 (2026-11-10).
// 기사님·코치 웹푸시 구독이 0건이었던 원인 = 켜는 버튼이 학부모 설정 화면에만 있었다.
// 동작은 학부모와 같은 훅(usePushSubscription → /api/push, 역할 제한 없음).

/** 머리줄 🔔 토글 — 켜짐/꺼짐 한눈에, 누르는 영역 44×44. 이 기기가 웹푸시를 못 받으면 아무것도 안 그린다 */
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
            className={`inline-flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--color-academy-soft)] disabled:opacity-60 ${pushEnabled ? "text-[var(--color-academy-success)]" : "text-[var(--color-academy-muted)]"}`}
        >
            <span className="material-symbols-outlined leading-none" style={{ fontSize: "24px" }} aria-hidden="true">
                {pushEnabled ? "notifications_active" : "notifications_off"}
            </span>
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
    const row = "mx-auto flex min-h-11 max-w-lg items-center gap-2 px-4 text-sm";
    if (appLacksPush) {
        return (
            <div role="note" className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)]">
                <p className={`${row} text-[var(--color-academy-ink)]`}>
                    <span className="material-symbols-outlined shrink-0 leading-none text-[var(--color-academy-info)]" style={{ fontSize: "18px" }} aria-hidden="true">sms</span>
                    {STORE_APP_PUSH_NOTE}
                </p>
            </div>
        );
    }
    if (!checked || pushEnabled) return null;
    if (!pushSupported) {
        return (
            <div role="note" className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)]">
                <p className={`${row} text-[var(--color-academy-ink)]`}>
                    <span className="material-symbols-outlined shrink-0 leading-none text-[var(--color-academy-info)]" style={{ fontSize: "18px" }} aria-hidden="true">ios_share</span>
                    아이폰은 홈 화면에 추가한 앱에서 알림을 켤 수 있어요
                </p>
            </div>
        );
    }
    return (
        <div role="note" className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-info-soft)]">
            <div className={row}>
                <span className="material-symbols-outlined shrink-0 leading-none text-[var(--color-academy-info)]" style={{ fontSize: "18px" }} aria-hidden="true">notifications</span>
                <span className="min-w-0 flex-1 text-[var(--color-academy-ink)]">알림을 켜면 명단 변경을 바로 받아요</span>
                <button type="button" onClick={togglePush} disabled={pushLoading} className="academy-button-primary min-h-11 shrink-0">
                    {pushLoading ? "켜는 중" : "켜기"}
                </button>
            </div>
        </div>
    );
}
