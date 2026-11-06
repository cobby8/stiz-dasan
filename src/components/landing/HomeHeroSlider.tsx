"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

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
    const touchX = useRef<number | null>(null);
    const count = slides.length;

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
            {slides.map((slide, i) => (
                <img
                    key={slide.url}
                    src={slide.url}
                    alt={i === index ? slide.alt : ""}
                    aria-hidden={i === index ? undefined : true}
                    fetchPriority={i === 0 ? "high" : "low"}
                    loading={i === 0 ? "eager" : "lazy"}
                    decoding="async"
                    className={`public-home-hero__image${i === index ? " is-active" : ""}`}
                />
            ))}
            {children}
            {count > 1 && (
                <div className="public-home-hero__dots">
                    {slides.map((slide, i) => (
                        <button
                            key={slide.url}
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
