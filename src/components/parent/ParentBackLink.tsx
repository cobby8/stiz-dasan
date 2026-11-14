"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { parentHistoryDecision } from "@/lib/navigation/inAppHistory";

type ParentBackLinkProps = {
  /** 기록이 없을 때 갈 고정 주소(예전 Link 의 href 그대로) */
  fallbackHref: string;
  className?: string;
  ariaLabel?: string;
  /** 안 넘기면 글자 기호 «←» 하나 */
  children?: ReactNode;
};

/**
 * 학부모 화면의 페이지 안 «←» 링크(2026-11-14).
 *
 * 왜: 예전엔 고정 주소 Link 라, 어디서 들어왔든 늘 같은 곳(대개 홈)으로 갔다.
 * 이제 이 탭 안에 학부모 화면 기록이 있으면 «방금 있던 화면»으로(브라우저 기록 한 칸 뒤로),
 * 없으면(앱을 이 화면으로 바로 열었을 때 등) 예전 고정 주소로 간다.
 * 겉은 그대로 Link 라서 새 탭 열기(Ctrl·가운데 클릭)·자바스크립트 실패 때도 고정 주소로 동작한다.
 */
export default function ParentBackLink({
  fallbackHref,
  className = "academy-back-link",
  ariaLabel,
  children,
}: ParentBackLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // 새 탭·새 창으로 여는 클릭은 브라우저 기본 동작 그대로(고정 주소)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // 지금 경로는 누르는 순간 주소창에서 읽는다(훅 없이 — 서버 화면 안에 그대로 넣을 수 있게).
    // router.back() 도 결국 브라우저 기록 한 칸 뒤로(history.back)라 같은 동작이다.
    if (parentHistoryDecision(window.location.pathname) === true) {
      event.preventDefault();
      window.history.back();
    }
    // 기록이 없으면 Link 가 fallbackHref 로 이동한다(예전 동작)
  };

  return (
    <Link href={fallbackHref} aria-label={ariaLabel} className={className} onClick={handleClick}>
      {children ?? <span aria-hidden="true">←</span>}
    </Link>
  );
}
