"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { GUIDE_FLOATING_STYLE } from "../public-floating";

const LazyGuideTourTrigger = dynamic(() => import("./GuideTourTrigger"), {
  ssr: false,
  loading: () => null,
});

const STORAGE_KEY = "stiz_tour_completed";

function shouldWarmTour() {
  if (typeof window === "undefined") return false;
  if (window.location.pathname !== "/") return false;
  if (window.location.search.includes("tour=")) return false;

  try {
    return localStorage.getItem(STORAGE_KEY) !== "true";
  } catch {
    return false;
  }
}

export default function GuideTourLazyTrigger() {
  const [loadMode, setLoadMode] = useState<"button" | "loaded" | "autoStart">("button");

  useEffect(() => {
    if (window.location.search.includes("tour=")) {
      setLoadMode("loaded");
      return;
    }

    const timer = window.setTimeout(() => {
      if (shouldWarmTour()) setLoadMode("loaded");
    }, 2500);

    return () => window.clearTimeout(timer);
  }, []);

  if (loadMode !== "button") {
    return <LazyGuideTourTrigger autoStart={loadMode === "autoStart"} />;
  }

  return (
    <button
      onClick={() => setLoadMode("autoStart")}
      // 위치(bottom)는 public-floating-btn--guide(«상담» 버튼 바로 위 + 하단 고정 바 높이)
      // 2026-11-14 아이콘 완전 제거: 학사모 원 → 글자 알약 «둘러보기»(높이 44px·좌우 14px, GuideTourTrigger 의 같은 버튼과 모양을 맞춘다).
      // 알약이 44px 로 낮아져 «상담»(아래 24px + 44px) 바로 위 8px 에 오도록 76px 로 내린다 — 88px 그대로면 홈 첫 화면 버튼 줄 아래쪽을 4px 덮는다.
      style={GUIDE_FLOATING_STYLE}
      className="public-floating-btn public-floating-btn--guide fixed right-4 z-50 flex h-11 items-center justify-center whitespace-nowrap rounded-full border-2 px-[14px] text-sm font-medium border-[var(--color-public-accent)] bg-[var(--color-public-paper)] text-[var(--color-public-accent)] shadow-lg transition-all duration-200 hover:scale-105 hover:shadow-xl dark:border-brand-neon-lime dark:bg-black dark:text-brand-neon-lime sm:right-6"
      aria-label="입학 가이드 시작"
      title="입학 가이드"
    >
      둘러보기
    </button>
  );
}
