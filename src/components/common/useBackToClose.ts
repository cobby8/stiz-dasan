"use client";

import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { bindOverlayToHistory, type OverlayHistoryHandle } from "@/lib/navigation/overlayHistory";

/**
 * 손가락으로 쓰는 기기인가(휴대폰·태블릿) — 화면을 덮지 않는 작은 펼침 메뉴(⚡·알림 종·표 머리 필터)는 이때만 «뒤로 = 닫기»를 건다.
 * 왜: 마우스 휠로 뒤 화면을 굴린 채 메뉴를 닫으면, 기록 칸을 되돌리며 브라우저가 «열 때의 스크롤 위치»로 화면을 되돌려 버린다.
 * 화면을 덮는 창(스크롤이 잠기는 모달·시트)은 해당 없어 항상 건다.
 */
export function isTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

/**
 * 열린 창을 휴대폰 «뒤로»로 닫게 하는 훅(2026-11-17 — 규칙은 overlayHistory.ts).
 *
 * 쓰는 법: const { leaveTo } = useBackToClose(open, () => setOpen(false));
 *  - 닫기 버튼·Esc·바탕은 예전처럼 setOpen(false) 만 하면 된다(남은 기록 칸은 이 훅이 정리).
 *  - 창 안에서 다른 화면으로 갈 때는 leaveTo(href, (to) => router.push(to)) — 칸을 먼저 되돌린 뒤 이동한다.
 *  - 닫자마자 다른 일(다른 화면으로 이동·다른 창 열기·확인 결과 돌려주기)을 하는 버튼은 closeThen(다음 일) 을 부르고 닫는다
 *    — 칸을 먼저 되돌린 «뒤»에 다음 일을 한다(먼저 이동하면 되돌리기가 새 화면을 되돌린다).
 *  - 저장 중엔 닫히면 안 되는 창은 { blocked: 저장중 } — 그동안 «뒤로»를 눌러도 창이 그대로 열려 있다(2026-11-18).
 *  - 닫기 전에 확인을 묻는 창(저장 안 한 입력)은 { blocked: 고친것있음, onBlockedBack: 닫기요청 } — 확인을 거절해도 기록 칸이 남아
 *    다음 «뒤로»가 화면을 떠나지 않는다.
 */
export function useBackToClose(open: boolean, close: () => void, options?: { blocked?: boolean; onBlockedBack?: () => void }) {
  const closeRef = useRef(close);
  // 저장 중 여부는 «뒤로»가 눌린 순간의 값을 본다 — 값이 바뀔 때마다 기록 칸을 다시 넣지 않게 ref 로 든다
  const blockedRef = useRef(false);
  const blocked = options?.blocked === true;
  // 막힌 «뒤로»가 눌렸을 때 부를 함수(닫기 전 확인 띄우기) — 칸은 이미 다시 들어가 있다
  const blockedBackRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    closeRef.current = close;
    blockedRef.current = blocked;
    blockedBackRef.current = options?.onBlockedBack;
  });
  const handle = useRef<OverlayHistoryHandle | null>(null);

  useEffect(() => {
    if (!open) return;
    const bound = bindOverlayToHistory(window, () => {
      handle.current = null;
      closeRef.current();
    }, { isBlocked: () => blockedRef.current, onBlockedBack: () => blockedBackRef.current?.() });
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

  /** 창을 닫으면서 이어서 할 일 — 넣어 둔 기록 칸을 먼저 되돌린 뒤에 next 를 부른다(부른 쪽은 평소처럼 닫힘 상태로 바꾼다) */
  const closeThen = useCallback((next: () => void) => leaveTo("(close)", () => next()), [leaveTo]);

  return { leaveTo, captureLinks, closeThen };
}
