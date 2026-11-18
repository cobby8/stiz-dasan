/**
 * AnimateOnScroll — 스크롤 진입 애니메이션 래퍼 (Phase 0 디자인 시스템)
 *
 * 화면에 요소가 들어오면 아래에서 위로 20px 올라오며 나타난다.
 *
 * 2026-11-19 속도 개선(전 화면 속도 1회차): 예전에는 브라우저 스크립트(IntersectionObserver)가
 * 실행될 때까지 내용을 투명(opacity 0)으로 숨겼다. 휴대폰에서는 스크립트가 끝나기까지 4~5초가 걸려,
 * 글이 이미 도착했는데도 그동안 빈 화면이었다(Lighthouse 모바일 LCP 5.4~5.9초, 그 중 92%가 «그리기 지연»).
 * 지금은 내용은 처음부터 보이고, 올라오는 효과는 CSS 스크롤 연동 애니메이션(globals.css .aos-reveal)이 맡는다.
 * 그 기능이 없는 브라우저는 효과 없이 바로 보인다. 스크립트가 필요 없어 서버 부품이 됐다.
 *
 * 사용법(기존과 같다):
 *   <AnimateOnScroll>
 *     <Card>...</Card>
 *   </AnimateOnScroll>
 *
 * delay 는 예전 화면 코드가 넘기는 값이라 받기만 한다 — 스크롤 연동 효과에서는 «몇 ms 뒤»가 뜻이 없다.
 */

import type { ReactNode } from 'react';

interface AnimateOnScrollProps {
  children: ReactNode;
  className?: string;
  delay?: number; // 예전 호환용(쓰지 않음)
}

export default function AnimateOnScroll({ children, className = '' }: AnimateOnScrollProps) {
  return <div className={className ? `aos-reveal ${className}` : 'aos-reveal'}>{children}</div>;
}
