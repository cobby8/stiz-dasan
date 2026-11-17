"use client";

import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { bindOverlayToHistory, type OverlayHistoryHandle } from "@/lib/navigation/overlayHistory";

/**
 * 열린 창을 휴대폰 «뒤로»로 닫게 하는 훅(2026-11-17 — 규칙은 overlayHistory.ts).
 *
 * 쓰는 법: const { leaveTo } = useBackToClose(open, () => setOpen(false));
 *  - 닫기 버튼·Esc·바탕은 예전처럼 setOpen(false) 만 하면 된다(남은 기록 칸은 이 훅이 정리).
 *  - 창 안에서 다른 화면으로 갈 때는 leaveTo(href, (to) => router.push(to)) — 칸을 먼저 되돌린 뒤 이동한다.
 */
export function useBackToClose(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  const handle = useRef<OverlayHistoryHandle | null>(null);

  useEffect(() => {
    if (!open) return;
    const bound = bindOverlayToHistory(window, () => {
      handle.current = null;
      closeRef.current();
    });
    handle.current = bound;
    return () => {
      if (handle.current === bound) handle.current = null;
      bound.release();
    };
  }, [open]);

  const leaveTo = useCallback((href: string, navigate: (href: string) => void) => {
    const bound = handle.current;
    if (bound) bound.leaveTo(href, navigate);
    else navigate(href);
  }, []);

  /**
   * 창 안의 같은 사이트 링크 클릭을 가로채 leaveTo 로 보낸다(창을 감싼 요소의 onClickCapture 에 단다).
   * 왜: 링크가 먼저 이동하고 창이 닫히며 기록 칸을 되돌리면, 그 «되돌리기»가 방금 연 새 화면을 되돌려 버린다.
   * 새 창·다운로드·바깥 주소·전화·#칸 이동은 그대로 둔다. Next Link 는 막힌 클릭이면 스스로 이동하지 않는다.
   */
  const captureLinks = useCallback(
    (navigate: (href: string) => void) => (event: MouseEvent<HTMLElement>) => {
      if (!handle.current) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//")) return;
      event.preventDefault();
      leaveTo(href, navigate);
    },
    [leaveTo],
  );

  return { leaveTo, captureLinks };
}
