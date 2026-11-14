"use client";

import { useEffect } from "react";

// 확인 화면 첫 진입 때 주소창의 1회용 표(t)를 지운다(검수 반영).
// 방문 기록·공유·화면 캡처에 표가 남지 않게 — 폼의 hidden 값은 그대로라 [계속]은 그대로 동작한다.
export default function StripHandoffToken() {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("t")) return;
    url.searchParams.delete("t");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  }, []);
  return null;
}
