"use client";

/**
 * 공개 홈페이지 플로팅 버튼(상담 챗봇·입학 가이드) 위치 조절 도우미 — 게슈탈트 C-P3·P-03
 *
 * 왜 필요한가:
 * - 시즌 특강 상세·신청 화면의 «하단 고정 바»가 우하단 플로팅 버튼을 덮어 «신청하기»가 가려졌다.
 * - 모달·하단 시트가 열려도 플로팅 버튼이 그 위에 떠 있어 닫기 버튼과 겹쳤다.
 *
 * 방법(둘 다 아주 단순하게):
 * 1) 고정 바가 자기 높이를 <html> 의 CSS 변수 --public-bottom-bar 에 적는다.
 *    플로팅 버튼은 public-sport.css 에서 bottom = 기본 여백 + 이 변수 로 계산한다.
 * 2) 모달이 열리면 <body data-public-overlay="개수"> 를 달고, CSS 가 플로팅 버튼을 숨긴다.
 *    모달이 여러 개 겹쳐도 개수로 세어 마지막 것이 닫힐 때만 지운다.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useBackToClose } from "@/components/common/useBackToClose";

/**
 * «둘러보기» 알약의 아래 여백 — «상담» 알약(아래 24px + 높이 44px) 바로 위 8px.
 * public-sport.css 의 --guide 기본값은 옛 원 버튼(56px) 기준 88px 이라, 44px 알약에 그대로 쓰면
 * 홈 첫 화면 버튼 줄을 살짝 덮는다. 변수만 덮어쓰므로 하단 고정 바 높이 계산은 CSS 그대로다.
 */
export const GUIDE_FLOATING_STYLE = { "--public-floating-offset": "76px" } as CSSProperties;

/**
 * 모달·하단 시트가 열려 있는 동안 플로팅 버튼을 숨긴다.
 * onBack 을 넘기면 휴대폰 «뒤로» = 이 창 닫기(2026-11-17 — 예전엔 창이 열린 채 뒤로를 누르면 화면째 나갔다).
 * 창 안에 같은 사이트 링크가 있으면 돌려준 captureLinks 를 창 감싼 요소의 onClickCapture 에 단다(useBackToClose 참고).
 */
export function usePublicOverlayOpen(open: boolean, onBack?: () => void, options?: { blocked?: boolean }) {
  // options.blocked = 저장·처리 중 — 그동안은 «뒤로»를 눌러도 창이 닫히지 않는다(2026-11-18)
  const { captureLinks } = useBackToClose(open && Boolean(onBack), () => onBack?.(), options);
  useEffect(() => {
    if (!open) return;
    const body = document.body;
    body.dataset.publicOverlay = String(Number(body.dataset.publicOverlay || "0") + 1);
    return () => {
      const next = Number(body.dataset.publicOverlay || "1") - 1;
      if (next > 0) body.dataset.publicOverlay = String(next);
      else delete body.dataset.publicOverlay;
    };
  }, [open]);
  return { captureLinks };
}

/** 하단 고정 바의 실제 높이를 --public-bottom-bar 변수로 알린다(줄바꿈으로 높이가 변해도 따라간다). */
export function usePublicBottomBar(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const apply = () => root.style.setProperty("--public-bottom-bar", `${Math.ceil(element.getBoundingClientRect().height)}px`);
    apply();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(apply);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      // 화면을 떠나면 원래 위치로 돌아가도록 변수를 지운다.
      root.style.removeProperty("--public-bottom-bar");
    };
  }, [ref]);
}

/**
 * 하단 고정 바 감싸개 — 화면이 불러와진 뒤에야 바가 나타나도 높이를 바로 알리도록
 * ref 와 측정을 이 컴포넌트 안에 묶었다. 모양(className)은 부르는 쪽이 그대로 정한다.
 */
export function PublicBottomBar({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  usePublicBottomBar(ref);
  return <div ref={ref} data-public-bottom-bar="" className={className}>{children}</div>;
}
