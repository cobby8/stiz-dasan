"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import Script from "next/script";
import {
    APP_PATH_PREFIXES,
    TOKEN_PATH_PREFIXES,
    TOKEN_QUERY_KEYS,
    isTrackingBlockedLocation,
    isTrackingBlockedPath,
} from "@/lib/privacy/trackingExclusion";

// 인라인 스크립트에 넣을 «토큰 쿼리 이름» — trackingExclusion.ts 의 같은 상수를 그대로 직렬화(기준 한 곳)
const TOKEN_QUERY_KEYS_JSON = JSON.stringify(TOKEN_QUERY_KEYS);
// 인라인 스크립트에 넣을 «추적 안 하는 경로» — 같은 상수 그대로(픽셀이 늦게 붙는 사이 그 화면으로 옮겨 갔을 때 대비)
const BLOCKED_PATH_PREFIXES_JSON = JSON.stringify([...TOKEN_PATH_PREFIXES, ...APP_PATH_PREFIXES]);

const META_PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID || "537084849778028";
// 픽셀은 화면이 다 뜬 뒤(lazyOnload) 붙는다 — 느린 휴대폰에서 첫 PageView 가 빠지지 않게 넉넉히 기다린다
// (0.6·1.2·…·6초 간격 10번 = 최대 약 33초. 재시도마다 지금 주소를 다시 판정한다)
const TRACK_RETRY_LIMIT = 10;
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

export function trackMetaEvent(eventName: string, params?: MetaEventParams, retryCount = 0, startPath?: string) {
    if (typeof window === "undefined" || !META_PIXEL_ID) return;
    // 주소에 열쇠(토큰)가 있는 화면에서는 아무 이벤트도 보내지 않는다 — 픽셀은 주소 전체(dl)를 facebook.com 으로 보낸다.
    // 재시도(setTimeout)로 다시 불릴 때도 매번 지금 주소로 다시 판정한다(그 사이 화면이 바뀔 수 있다).
    if (isTrackingBlockedLocation(window.location.pathname, window.location.search)) return;
    // PageView 는 «그 화면» 몫이다 — 기다리는 사이 다른 화면으로 옮겼으면 그만둔다(새 화면 PageView 는 새 화면이 보낸다).
    // 안 그러면 픽셀이 붙는 순간 마지막 화면 PageView 가 여러 번 나간다(검수 2026-11-19).
    const firstPath = startPath ?? window.location.pathname;
    if (eventName === "PageView" && window.location.pathname !== firstPath) return;

    if (!window.fbq) {
        if (retryCount < TRACK_RETRY_LIMIT) {
            window.setTimeout(
                () => trackMetaEvent(eventName, params, retryCount + 1, firstPath),
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

    // ① 맨 앞: 주소 쿼리에 토큰 이름(token·t·access·enrollmentHandoff·handoff)이 있으면 픽셀을 싣지도 init 하지도 않고 끝낸다.
    //    (경로는 서버 렌더에서 이미 걸렀고, 쿼리는 서버 렌더 시점에 모르므로 브라우저에서 한 번 더 — isTrackingBlockedLocation 과 같은 목록)
    // ② disablePushState: 픽셀이 화면 이동(history.pushState)마다 스스로 PageView 를 보내는 기능을 끈다.
    //    PageView 는 위 useEffect 가 판정을 거쳐 직접 보낸다 — 그래야 앱 안 이동으로 토큰 화면에 들어가도 새지 않는다.
    // ③ autoConfig=false: 버튼 클릭 등 «자동 이벤트»를 끈다(앱 안 이동으로 토큰 화면에 간 뒤 클릭이 주소째 나가지 않게). init 보다 앞이어야 한다.
    // ④ lazyOnload(2026-11-19 속도 6회차, 원장 승인): 화면이 다 뜨고 브라우저가 한가할 때 싣는다 — 첫 몇 초 조작 막힘 약 0.3초 감소.
    //    그 사이 앱 안 이동으로 «추적 안 하는 경로»에 가 있을 수 있어, 경로도 한 번 더 본다(isTrackingBlockedPath 와 같은 규칙).
    return (
        <>
            <Script id="meta-pixel" strategy="lazyOnload">
                {`
                    (function(){
                    var keys=${TOKEN_QUERY_KEYS_JSON};
                    var q=new URLSearchParams(window.location.search);
                    for(var i=0;i<keys.length;i++){if(q.has(keys[i]))return;}
                    var paths=${BLOCKED_PATH_PREFIXES_JSON};
                    var p=String(window.location.pathname||'');
                    for(var j=0;j<paths.length;j++){var b=paths[j].replace(/\\/$/,'');if(p===b||p.indexOf(b+'/')===0)return;}
                    !function(f,b,e,v,n,t,s)
                    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
                    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
                    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
                    n.queue=[];t=b.createElement(e);t.async=!0;
                    t.src=v;s=b.getElementsByTagName(e)[0];
                    s.parentNode.insertBefore(t,s)}(window, document,'script',
                    'https://connect.facebook.net/en_US/fbevents.js');
                    fbq.disablePushState = true;
                    fbq('set', 'autoConfig', false, '${META_PIXEL_ID}');
                    fbq('init', '${META_PIXEL_ID}');
                    })();
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
