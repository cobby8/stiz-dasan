"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { browserPreviousPath } from "@/lib/navigation/publicHistory";
import { isParentScopePath, markNextNavigationAsReplace, parentHistoryDecision } from "@/lib/navigation/inAppHistory";

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
    // 학부모 화면은 우리 기록, 그 밖(내 계정·청구서·공개 화면)은 브라우저가 알려 주는 «바로 앞 같은 사이트 화면»(2026-11-17)
    const decision = parentHistoryDecision(window.location.pathname);
    if (decision === true || (decision === null && browserPreviousPath() !== null && window.history.length > 1)) {
      event.preventDefault();
      window.history.back();
      return;
    }
    // 기록이 없으면 Link 가 fallbackHref 로 «바꿔 끼우며»(replace) 이동한다(2026-11-17).
    // 쌓으면(push) 위 화면의 «←»·기기 뒤로 가기가 방금 화면으로 되돌아가는 고리가 생긴다
    if (isParentScopePath(fallbackHref.split(/[?#]/)[0])) markNextNavigationAsReplace();
  };

  return (
    // replace 는 학부모 화면 안에서만 — /account 등 기록을 남기지 않는 화면에선 예전처럼 쌓는다(같은 주소 칸 두 개가 생겨 기기 뒤로가 제자리걸음, 2026-11-17 검수)
    <Link href={fallbackHref} replace={isParentScopePath(fallbackHref.split(/[?#]/)[0])} aria-label={ariaLabel} className={className} onClick={handleClick}>
      {children ?? <span aria-hidden="true">←</span>}
    </Link>
  );
}
