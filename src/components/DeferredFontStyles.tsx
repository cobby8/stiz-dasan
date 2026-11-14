"use client";

import { useEffect } from "react";
import { ICON_FONT_TIMEOUT_MS, iconFontRootClasses, nextIconFontState, type IconFontEvent, type IconFontState } from "@/lib/ui/iconFontState";

// document.fonts 에 물어볼 글꼴 이름(크기는 형식상 필요)
const ICON_FONT_SPEC = '24px "Material Symbols Outlined"';

const MATERIAL_SYMBOLS_URL =
    "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0";
const PRETENDARD_URL =
    "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css";

type IdleWindow = Window &
    typeof globalThis & {
        requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
        cancelIdleCallback?: (handle: number) => void;
    };

function appendStylesheet(id: string, href: string, onLoad?: () => void, onError?: () => void) {
    if (document.getElementById(id)) {
        onLoad?.();
        return;
    }

    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => onLoad?.();
    // 주소가 막히면(사내망·광고 차단 등) 알려 준다 — 안 그러면 아이콘이 영영 투명으로 남는다
    link.onerror = () => onError?.();
    document.head.appendChild(link);
}

export default function DeferredFontStyles() {
    useEffect(() => {
        let iconObserver: MutationObserver | null = null;
        let iconTimer: number | null = null;
        // 아이콘 글꼴 상태(pending → ready | fallback). 판정과 클래스 이름은 순수 규칙(iconFontState) 한 곳에서
        let iconState: IconFontState = "pending";

        const applyIconEvent = (event: IconFontEvent) => {
            iconState = nextIconFontState(iconState, event);
            const { add, remove } = iconFontRootClasses(iconState);
            const root = document.documentElement.classList;
            if (remove.length) root.remove(...remove);
            if (add.length) root.add(...add);
        };

        const loadIcons = () => {
            // 너무 늦으면 대체 글자로 바꾼다. 그 뒤에 글꼴이 도착하면 아래 font-loaded 가 다시 아이콘으로 되돌린다
            if (iconTimer === null) iconTimer = window.setTimeout(() => applyIconEvent("timeout"), ICON_FONT_TIMEOUT_MS);
            appendStylesheet("material-symbols-css", MATERIAL_SYMBOLS_URL, () => {
                // CSS 만 받았다고 ready 가 아니다 — 글꼴 «파일»을 실제로 쓸 수 있을 때 붙인다
                const fonts = document.fonts;
                if (!fonts?.load) { applyIconEvent("font-loaded"); return; } // 아주 옛 브라우저: 예전 동작 그대로
                fonts.load(ICON_FONT_SPEC, "settings")
                    .then((faces) => applyIconEvent(faces.length > 0 && fonts.check(ICON_FONT_SPEC, "settings") ? "font-loaded" : "font-error"))
                    .catch(() => applyIconEvent("font-error"));
            }, () => applyIconEvent("css-error"));
        };

        const loadIconsIfPresent = () => {
            if (!document.querySelector(".material-symbols-outlined")) return false;
            loadIcons();
            return true;
        };

        const watchForIconUse = () => {
            if (loadIconsIfPresent()) return;
            iconObserver = new MutationObserver(() => {
                if (!loadIconsIfPresent()) return;
                iconObserver?.disconnect();
                iconObserver = null;
            });
            iconObserver.observe(document.body, { childList: true, subtree: true });
        };

        const loadPretendard = () => {
            appendStylesheet("pretendard-css", PRETENDARD_URL);
        };

        const idleWindow = window as IdleWindow;
        const iconFrame = window.requestAnimationFrame(watchForIconUse);
        const idleId = idleWindow.requestIdleCallback
            ? idleWindow.requestIdleCallback(loadPretendard, { timeout: 2500 })
            : window.setTimeout(loadPretendard, 1500);

        return () => {
            window.cancelAnimationFrame(iconFrame);
            iconObserver?.disconnect();
            if (iconTimer !== null) window.clearTimeout(iconTimer);
            if (idleWindow.cancelIdleCallback) {
                idleWindow.cancelIdleCallback(idleId);
            } else {
                window.clearTimeout(idleId);
            }
        };
    }, []);

    return null;
}
