"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { entryOf, isParentScopePath, markLeftParentScope, notePopNavigation, readInAppHistory, recordInAppNavigation, startPopListening } from "@/lib/navigation/inAppHistory";

/**
 * 학부모 화면 안 이동 기록을 남기는 보이지 않는 부품(mypage layout 에 한 번 마운트).
 * 화면(경로·쿼리)이 바뀔 때마다 기록 규칙(nextInAppHistory)에 넘긴다.
 * 이 기록을 보고 머리줄 «←»(AppBackButton)와 페이지 안 «←»(ParentBackLink)가
 * «이전 화면으로 돌아갈지, 고정 주소로 갈지»를 정한다.
 */
export default function ParentHistoryTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";

  // 브라우저 «뒤로·앞으로»(기기 뒤로 가기·«←» 의 history.back 포함)를 듣는다 — 링크로 같은 화면에 다시 들어간 것과 구분(2026-11-17).
  // 화면 기록(아래 효과)보다 먼저 붙어야 해서 첫 효과로 둔다
  useEffect(() => {
    startPopListening();
    const onPop = () => {
      // 창(시트·크게 보기)을 «뒤로»로 닫은 popstate 는 주소가 그대로다 — 화면 이동이 아니니 표시하지 않는다
      try {
        const stack = readInAppHistory();
        if (stack.length > 0 && stack[stack.length - 1] === entryOf(window.location.pathname, window.location.search)) return;
      } catch {
        // 읽기 실패 — 표시는 짧게만 유효해 큰일 없다
      }
      notePopNavigation();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!pathname) return;
    try {
      recordInAppNavigation(entryOf(pathname, search));
    } catch {
      // 기록은 편의 기능이다 — 실패해도 화면은 그대로(뒤로 버튼은 고정 주소로 간다)
    }
  }, [pathname, search]);

  // 학부모 레이아웃을 떠날 때(화면 안 이동으로 /login·공개 홈 등) «다음 기록은 새로 시작» 표시.
  // 정리 함수는 이동이 끝나기 전에 돌 수 있어 한 박자 뒤 실제 주소로 판단한다(개발 모드 이중 실행에서도 /mypage 라 표시 안 함).
  useEffect(() => () => {
    setTimeout(() => {
      try {
        if (!isParentScopePath(window.location.pathname)) markLeftParentScope();
      } catch {
        // 표시 실패 — 뒤로 버튼이 한 칸 더 이어질 뿐
      }
    }, 0);
  }, []);

  return null;
}
