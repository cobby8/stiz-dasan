"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { markNextScopeNavigationAsReplace, scopeHistoryDecision, staffOrAdminScopeOf } from "@/lib/navigation/inAppHistory";

type ScopeBackLinkProps = {
  /** 기록이 없을 때 갈 고정 주소(예전 Link 의 href 그대로) */
  fallbackHref: string;
  className?: string;
  ariaLabel?: string;
  /** 예전 Link 에 prefetch={false} 가 있었으면 그대로 넘긴다 */
  prefetch?: boolean;
  /** 안 넘기면 글자 기호 «←» 하나 */
  children?: ReactNode;
};

const pathOnly = (href: string) => href.split(/[?#]/)[0];

/**
 * 선생님·관리자 화면의 페이지 안 뒤로 링크(2026-11-17) — 학부모 ParentBackLink 와 같은 동작.
 *
 * 왜: «← 목록» 같은 링크가 고정 주소라, 어디서 들어왔든 늘 같은 곳으로 갔다
 * (통계에서 원생 상세로 왔는데 «← 목록» 은 원생 목록으로). 그리고 Link 는 기록을 한 칸 더 쌓아
 * «목록 → 상세 → ←목록 → 기기 뒤로 = 다시 상세» 고리가 생겼다.
 * 이제 이 탭 안에 그 범위(/admin·/staff) 화면 기록이 있으면 «방금 있던 화면»으로(브라우저 기록 한 칸 뒤로),
 * 없으면(이 화면을 바로 열었을 때 등) 예전 고정 주소로 «바꿔 끼우며» 간다.
 * 겉은 그대로 Link 라서 새 탭 열기(Ctrl·가운데 클릭)·자바스크립트 실패 때도 고정 주소로 동작한다.
 */
export default function ScopeBackLink({ fallbackHref, className, ariaLabel, prefetch, children }: ScopeBackLinkProps) {
  // 도착지가 선생님·관리자 화면이면 쌓지 않고 바꿔 끼운다 — 쌓으면 위 화면의 «←»·기기 뒤로가 방금 화면으로 되돌아가는 고리가 생긴다
  const targetScope = staffOrAdminScopeOf(pathOnly(fallbackHref));

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // 새 탭·새 창으로 여는 클릭은 브라우저 기본 동작 그대로(고정 주소)
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // 지금 경로는 누르는 순간 주소창에서 읽는다(훅 없이 — 서버 화면 안에 그대로 넣을 수 있게).
    // 지금 화면이 속한 범위의 기록만 본다 — 다른 역할 화면·로그인으로는 돌아가지 않는다(기록 전·범위 밖은 «없음»)
    const current = window.location.pathname;
    const currentScope = staffOrAdminScopeOf(current);
    if (currentScope && scopeHistoryDecision(current) === true) {
      event.preventDefault();
      window.history.back();
      return;
    }
    // 기록이 없으면 Link 가 fallbackHref 로 바꿔 끼우며 이동한다 — 우리 기록도 쌓지 않게 표시(같은 범위 안 이동일 때만)
    if (targetScope && targetScope === currentScope) markNextScopeNavigationAsReplace(targetScope);
  };

  return (
    <Link href={fallbackHref} replace={targetScope !== null} prefetch={prefetch} aria-label={ariaLabel} className={className} onClick={handleClick}>
      {children ?? <span aria-hidden="true">←</span>}
    </Link>
  );
}
