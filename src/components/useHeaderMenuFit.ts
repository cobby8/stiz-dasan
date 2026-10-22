"use client";

import { useEffect, useRef, useState } from "react";
import { shouldCollapseHeader } from "@/lib/navigation/headerFit";

/** 기존 요소를 그대로 측정하며 메뉴·계정 복제나 추가 조회는 하지 않는다. */
export function useHeaderMenuFit() {
  const rowRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const accountsRef = useRef<HTMLDivElement>(null);
  const collapsedRef = useRef(true);
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    let frame = 0;
    let disposed = false;
    const measure = () => {
      frame = 0;
      const row = rowRef.current;
      const brand = brandRef.current;
      const nav = navRef.current;
      const actions = actionsRef.current;
      if (!row || !brand || !nav || !actions) return;
      const rowStyle = getComputedStyle(row);
      const actionStyle = getComputedStyle(actions);
      // 접힌 메뉴·계정도 크기를 유지하며 숨긴다. 메뉴 버튼은 펼친 상태의 합계에서 제외한다.
      const controls = Array.from(actions.children).filter((child) =>
        !child.classList.contains("public-menu-trigger") && getComputedStyle(child).display !== "none");
      const actionWidth = controls.reduce((sum, child) => sum + (child as HTMLElement).offsetWidth, 0)
        + Math.max(0, controls.length - 1) * (parseFloat(actionStyle.columnGap) || 0);
      const next = shouldCollapseHeader({
        available: row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight),
        brand: brand.offsetWidth,
        navigation: nav.offsetWidth,
        actions: actionWidth,
        gap: parseFloat(rowStyle.columnGap) || 0,
      }, collapsedRef.current);
      if (next !== collapsedRef.current) {
        collapsedRef.current = next;
        setCollapsed(next);
      }
    };
    const schedule = () => {
      if (!disposed && !frame) frame = requestAnimationFrame(measure);
    };
    const resizeObserver = new ResizeObserver(schedule);
    for (const element of [rowRef.current, brandRef.current, navRef.current, actionsRef.current, accountsRef.current]) {
      if (element) resizeObserver.observe(element);
    }
    const fontObserver = new MutationObserver(schedule);
    fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    void document.fonts?.ready.then(schedule);
    schedule();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      fontObserver.disconnect();
      window.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, []);

  return { collapsed, rowRef, brandRef, navRef, actionsRef, accountsRef };
}
