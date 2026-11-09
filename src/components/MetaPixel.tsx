"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import Script from "next/script";
import { isTrackingBlockedLocation, isTrackingBlockedPath } from "@/lib/privacy/trackingExclusion";

const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID || "537084849778028";
const TRACK_RETRY_LIMIT = 3;
const TRACK_RETRY_DELAY_MS = 600;

type MetaEventParams = Record<string, string | number | boolean | undefined>;

declare global {
    interface Window {
        fbq?: (...args: unknown[]) => void;
    }
}

function getTestEventCode() {
    if (typeof window === "undefined") return undefined;
    return new URLSearchParams(window.location.search).get("test_event_code")?.trim() || undefined;
}

function withTestEventCode(params?: MetaEventParams) {
    const testEventCode = getTestEventCode();
    return testEventCode ? { ...(params ?? {}), test_event_code: testEventCode } : params ?? {};
}

export function trackMetaEvent(eventName: string, params?: MetaEventParams, retryCount = 0) {
    if (typeof window === "undefined" || !META_PIXEL_ID) return;
    // 주소에 열쇠(토큰)가 있는 화면에서는 아무 이벤트도 보내지 않는다 — 픽셀은 주소 전체(dl)를 facebook.com 으로 보낸다.
    // 재시도(setTimeout)로 다시 불릴 때도 매번 지금 주소로 다시 판정한다(그 사이 화면이 바뀔 수 있다).
    if (isTrackingBlockedLocation(window.location.pathname, window.location.search)) return;

    if (!window.fbq) {
        if (retryCount < TRACK_RETRY_LIMIT) {
            window.setTimeout(
                () => trackMetaEvent(eventName, params, retryCount + 1),
                TRACK_RETRY_DELAY_MS * (retryCount + 1),
            );
        }
        return;
    }

    window.fbq("track", eventName, withTestEventCode(params));
}

export default function MetaPixel() {
    const pathname = usePathname();
    // 토큰 경로에서는 픽셀 스크립트·초기화·noscript 이미지 자체를 싣지 않는다(서버 렌더와 같은 판정 — 경로만 본다)
    const pathBlocked = isTrackingBlockedPath(pathname);

    useEffect(() => {
        trackMetaEvent("PageView");
    }, [pathname]);

    if (!META_PIXEL_ID || pathBlocked) return null;

    // disablePushState: 픽셀이 화면 이동(history.pushState)마다 스스로 PageView 를 보내는 기능을 끈다.
    // PageView 는 위 useEffect 가 판정을 거쳐 직접 보낸다 — 그래야 앱 안 이동으로 토큰 화면에 들어가도 새지 않는다.
    return (
        <>
            <Script id="meta-pixel" strategy="afterInteractive">
                {`
                    !function(f,b,e,v,n,t,s)
                    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
                    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
                    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
                    n.queue=[];t=b.createElement(e);t.async=!0;
                    t.src=v;s=b.getElementsByTagName(e)[0];
                    s.parentNode.insertBefore(t,s)}(window, document,'script',
                    'https://connect.facebook.net/en_US/fbevents.js');
                    fbq.disablePushState = true;
                    fbq('init', '${META_PIXEL_ID}');
                `}
            </Script>
            <noscript>
                <img
                    height="1"
                    width="1"
                    style={{ display: "none" }}
                    src={`https://www.facebook.com/tr?id=${META_PIXEL_ID}&ev=PageView&noscript=1`}
                    alt=""
                />
            </noscript>
        </>
    );
}
