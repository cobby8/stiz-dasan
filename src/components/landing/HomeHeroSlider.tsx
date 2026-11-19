"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { optimizedImageProps } from "@/lib/ui/optimizedImage";

// 홈 첫 화면 사진 슬라이드 — 사진이 주인공(2026-11-06 원장 요청 «첫 화면도 지금보다 크게»).
// 첫 사진은 서버 화면에 바로 박혀 첫 화면이 늦게 뜨지 않고, 나머지는 브라우저에서 천천히 넘어간다.
const SLIDE_INTERVAL_MS = 6000;
const SWIPE_MIN_PX = 40;

export interface HeroSlide {
    url: string;
    alt: string;
}

export default function HomeHeroSlider({ slides, children }: { slides: HeroSlide[]; children: ReactNode }) {
    const [index, setIndex] = useState(0);
    const [paused, setPaused] = useState(false);
    // 2026-11-19 속도 7회차: 둘째 장부터는 «화면에 넣는 것» 자체를 미룬다.
    // 사진들이 같은 자리에 투명하게 겹쳐 있어 loading="lazy" 가 듣지 않았다 — 첫 화면이 뜨자마자 2·3번째 장(약 290KB)까지 받았다.
    // 이제: 처음엔 첫 장만 → 페이지가 다 뜬 뒤(load) 다음 장 하나 → 넘어갈 때마다 그다음 장. 한 번 넣은 장은 그대로 둔다.
    // 아직 다 받지 않은 장으로 건너뛰면(첫 장에서 «이전», 점 버튼) 그 사진이 다 받아질 때까지 지금 사진을 그대로 보인다(빈 화면 방지).
    const [pageLoaded, setPageLoaded] = useState(false);
    const [mounted, setMounted] = useState<ReadonlySet<number>>(() => new Set([0]));
    // 다 받은 장(첫 장은 서버 화면에 이미 있어 받은 것으로 친다 — 하이드레이션 전에 끝나 onLoad 를 놓칠 수 있다)
    const [ready, setReady] = useState<ReadonlySet<number>>(() => new Set([0]));
    // 실제로 보이는 장 — 고른 장(index)이 다 받아지면 그 장으로 바뀐다
    const [shown, setShown] = useState(0);
    const touchX = useRef<number | null>(null);
    const count = slides.length;

    useEffect(() => {
        if (document.readyState === "complete") { setPageLoaded(true); return; }
        const onLoad = () => setPageLoaded(true);
        window.addEventListener("load", onLoad, { once: true });
        return () => window.removeEventListener("load", onLoad);
    }, []);

    // 고른 장 + (페이지가 다 떴으면) 그다음 장을 화면에 넣는다
    useEffect(() => {
        if (count < 2) return;
        const want = [index, ...(pageLoaded ? [(index + 1) % count] : [])];
        setMounted((prev) => (want.every((i) => prev.has(i)) ? prev : new Set([...prev, ...want])));
    }, [index, pageLoaded, count]);

    useEffect(() => {
        if (ready.has(index)) setShown(index);
    }, [index, ready]);

    const markReady = (i: number) => setReady((prev) => (prev.has(i) ? prev : new Set([...prev, i])));

    // 자동 넘김: 사진이 2장 이상이고, 손을 대고 있지 않고, «움직임 줄이기» 를 켜지 않았을 때만
    useEffect(() => {
        if (count < 2 || paused) return;
        if (typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        const id = window.setInterval(() => {
            if (!document.hidden) setIndex((i) => (i + 1) % count);
        }, SLIDE_INTERVAL_MS);
        return () => window.clearInterval(id);
    }, [count, paused]);

    const go = (next: number) => setIndex(((next % count) + count) % count);

    return (
        <section
            className="public-home-hero public-home-hero--large"
            aria-labelledby="public-home-title"
            aria-roledescription="carousel"
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocusCapture={() => setPaused(true)}
            onBlurCapture={() => setPaused(false)}
            onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; setPaused(true); }}
            onTouchEnd={(e) => {
                const start = touchX.current;
                const end = e.changedTouches[0]?.clientX;
                touchX.current = null;
                if (start != null && end != null && Math.abs(end - start) >= SWIPE_MIN_PX && count > 1) go(index + (end < start ? 1 : -1));
            }}
        >
            {slides.map((slide, i) => !mounted.has(i) ? null : (
                <img
                    key={`${i}-${slide.url}`}
                    // 화면에 맞는 크기로 줄여 받는다. 휴대폰은 칸이 세로로 길어 가로 사진이 높이에 맞춰 약 2.2배로 확대돼 그려진다 —
                    // 그래서 휴대폰은 화면 폭의 2.2배 크기를 받는다(100vw 로 받으면 흐려진다). PC 는 가로를 꽉 채우는 100vw
                    {...optimizedImageProps(slide.url, "(max-width: 767px) 220vw, 100vw")}
                    alt={i === shown ? slide.alt : ""}
                    aria-hidden={i === shown ? undefined : true}
                    fetchPriority={i === 0 ? "high" : "low"}
                    // 넣는 시점을 코드가 정하므로 lazy 는 쓰지 않는다(넣으면 바로 받는다)
                    loading="eager"
                    decoding="async"
                    onLoad={i === 0 ? undefined : () => markReady(i)}
                    // 못 받아도 넘김이 멈추지 않게 «받은 것»으로 친다
                    onError={i === 0 ? undefined : () => markReady(i)}
                    className={`public-home-hero__image${i === shown ? " is-active" : ""}`}
                />
            ))}
            {children}
            {count > 1 && (
                <div className="public-home-hero__dots">
                    {slides.map((slide, i) => (
                        <button
                            key={`${i}-${slide.url}`}
                            type="button"
                            aria-label={`${i + 1}번째 사진 보기`}
                            aria-current={i === index ? "true" : undefined}
                            onClick={() => go(i)}
                        >
                            <span aria-hidden="true" />
                        </button>
                    ))}
                </div>
            )}
        </section>
    );
}
