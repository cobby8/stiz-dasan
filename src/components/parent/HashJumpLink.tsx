"use client";

import type { MouseEvent, ReactNode } from "react";

/**
 * 같은 화면 안 칸으로 내려가는 칩(예: 소식 탭 «공지·리포트·사진»)(2026-11-17).
 *
 * 왜: 그냥 <a href="#칸"> 은 누를 때마다 브라우저 기록이 한 칸씩 쌓인다.
 *     그래서 칩을 두세 번 누른 뒤 «←»·기기 뒤로 가기를 누르면 같은 화면에서 스크롤만 움직여 «뒤로가 안 먹는» 것처럼 보였다.
 * → 기록을 쌓지 않고(replaceState) 그 칸으로 스크롤만 한다. 자바스크립트가 없으면 예전 <a href="#칸"> 그대로.
 */
export default function HashJumpLink({ targetId, className, children }: { targetId: string; className?: string; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(targetId);
    if (!target) return; // 칸이 없으면 브라우저 기본 동작
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    try {
      // Next.js 가 history.state 에 넣어 둔 값은 그대로 두고 주소의 #만 바꾼다(기록 칸 수는 그대로)
      window.history.replaceState(window.history.state, "", `#${targetId}`);
    } catch {
      // 주소를 못 바꿔도 스크롤은 됐다
    }
  };
  return (
    <a href={`#${targetId}`} className={className} onClick={onClick}>
      {children}
    </a>
  );
}
