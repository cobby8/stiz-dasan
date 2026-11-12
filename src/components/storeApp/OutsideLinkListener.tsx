"use client";

import { useEffect } from "react";
import { OUTSIDE_LINK_AREA_ATTR, OUTSIDE_LINK_ATTR, interceptOutsideLinkClick } from "@/lib/outsideLink";

/**
 * `data-outside-link` 가 붙은 링크의 누름만 가로챈다(d2). 루트 레이아웃에 한 번 둔다.
 * 스토어 앱이 아니면 interceptOutsideLinkClick 가 아무것도 안 해서 링크가 평소대로 열린다.
 * 화면은 그리지 않는다.
 */
export default function OutsideLinkListener() {
  useEffect(() => {
    function onClick(event: MouseEvent) {
      const target = event.target as Element | null;
      // ① 링크에 직접 붙은 표시 ② 공지 본문처럼 «이 안의 링크 전부» 표시(data-outside-links) — 우리 주소는 isOutsideHref 가 걸러 앱 안에서 연다
      const anchor = target?.closest?.(`a[${OUTSIDE_LINK_ATTR}], [${OUTSIDE_LINK_AREA_ATTR}] a[href]`) as HTMLAnchorElement | null;
      if (!anchor) return;
      interceptOutsideLinkClick(event, anchor.href);
    }
    // 캡처 단계에서 먼저 듣는다 — 링크 쪽 onClick 이 새 창을 열기 전에 막으려고
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  return null;
}
