"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import FontFreeIcon from "../ui/FontFreeIcon";

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
      // 위치(bottom)는 public-floating-btn--guide(챗봇 버튼 바로 위 88px + 하단 고정 바 높이)
      className="public-floating-btn public-floating-btn--guide fixed right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full border-2 border-brand-orange-500 bg-white text-brand-orange-500 shadow-lg transition-all duration-200 hover:scale-105 hover:shadow-xl dark:border-brand-neon-lime dark:bg-black dark:text-brand-neon-lime"
      aria-label="입학 가이드 시작"
      title="입학 가이드"
    >
      <FontFreeIcon name="school" size={26} />
    </button>
  );
}
