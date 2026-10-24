'use client';

/**
 * AnimateOnScroll — 스크롤 진입 애니메이션 래퍼 (Phase 0 디자인 시스템)
 *
 * 화면에 요소가 보이면 아래에서 위로 20px 올라오며 나타나는 애니메이션.
 * Intersection Observer API를 직접 사용하여 외부 라이브러리 없이 구현.
 *
 * 사용법:
 *   <AnimateOnScroll>
 *     <Card>...</Card>
 *   </AnimateOnScroll>
 *
 *   <AnimateOnScroll delay={200}>
 *     <Card>...</Card>  // 200ms 뒤에 나타남 (연속 배치 시 순차 효과)
 *   </AnimateOnScroll>
 *
 * Client Component (useRef, useEffect 사용)
 */

import { useRef, useEffect, useState, type ReactNode } from 'react';

interface AnimateOnScrollProps {
  children: ReactNode;
  className?: string;
  delay?: number; // 애니메이션 지연 시간 (ms, 선택)
}

export default function AnimateOnScroll({
  children,
  className = '',
  delay = 0,
}: AnimateOnScrollProps) {
  // 요소가 화면에 보였는지 추적
  const [isVisible, setIsVisible] = useState(false);
  // 관찰 대상 DOM 요소 참조
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // 긴 약관도 일부가 화면에 들어오면 보인다. 전체 높이의 일정 비율을 요구하지 않는다.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsVisible(true);
          // 한 번 나타나면 더 이상 관찰할 필요 없음 (성능 최적화)
          observer.unobserve(element);
        }
      },
      {
        threshold: 0,
        rootMargin: '0px', // 뷰포트 기준
      }
    );

    observer.observe(element);

    // 컴포넌트 언마운트 시 관찰 해제
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={className}
      style={{
        // 보이기 전: 투명 + 아래로 20px 밀려있음
        // 보인 후: 불투명 + 원래 위치로 올라옴
        opacity: isVisible ? 1 : 0,
        transform: isVisible ? 'translateY(0)' : 'translateY(20px)',
        // 부드러운 전환: 500ms, ease-out
        transition: `opacity 500ms ease-out ${delay}ms, transform 500ms ease-out ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}
