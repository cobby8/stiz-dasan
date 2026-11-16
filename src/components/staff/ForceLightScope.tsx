"use client";

import { useLayoutEffect } from "react";

/**
 * 이 부품이 화면에 있는 동안 사이트의 «어두운 모드» 표시(<html class="dark">)를 잠시 뗀다(2026-11-16).
 *
 * 왜: 선생님 앱은 늘 밝은 화면인데, 사이트 연간일정 부품(AnnualEventsClient)은 사이트의 어두운 모드를 따라간다
 * (사이트 기본값이 어두운 모드). 그대로 끼우면 밝은 앱 한가운데 달력만 검게 나온다.
 * 사이트 부품의 모양을 건드리지 않고(사이트와 같은 부품 그대로) 이 화면에서만 밝게 보이게 한다.
 * - 저장된 사용자의 보기 설정은 바꾸지 않는다(표시만 뗀다).
 * - 떠날 때 되돌리지 않는다: 선생님 앱(/staff)은 원래 밝은 화면으로 고정이고(ThemeProvider), 앱 밖으로 나가면
 *   보기 설정이 스스로 다시 붙는다. 여기서 되돌리면 오히려 선생님 앱의 다른 화면이 어두워질 수 있다(검수 2026-11-16).
 * - 그리기 전에 떼어(useLayoutEffect) 탭으로 들어올 때 검게 번쩍이지 않는다.
 */
export default function ForceLightScope() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const strip = () => {
      if (root.classList.contains("dark")) root.classList.remove("dark");
    };
    strip();
    // 다른 코드가 표시를 다시 붙여도(보기 설정 동기화 등) 이 화면에서는 밝게 유지한다
    const observer = new MutationObserver(strip);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return null;
}
