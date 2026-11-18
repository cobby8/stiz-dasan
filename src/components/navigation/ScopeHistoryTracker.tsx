"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import {
  entryOf,
  isPassThroughPath,
  isScopePath,
  markLeftScope,
  noteScopePopNavigation,
  readScopeHistory,
  recordScopeNavigation,
  startScopePopListening,
  type HistoryScope,
} from "@/lib/navigation/inAppHistory";

/**
 * 역할 화면(선생님·기사님 /staff, 관리자 /admin) 안 이동 기록을 남기는 보이지 않는 부품(2026-11-17).
 * 그 역할의 틀(layout)에 한 번 놓는다. 학부모 화면의 ParentHistoryTracker 와 같은 방식이다.
 *
 * 왜: 이 기록이 없으면 머리줄 «←»(AppBackButton)가 «돌아갈 화면이 있나»를 문서를 처음 연 방식으로만
 * 판단해, 어느 화면에서든 늘 홈으로 가거나 첫 화면에서도 범위 밖(로그인·다른 역할 화면)으로 나갔다.
 * 기록은 범위마다 따로라, 관리자 → 선생님 «화면 전환» 뒤의 첫 화면은 새 기록으로 시작한다.
 *
 * 쿼리를 읽는 부품이라 놓는 쪽에서 <Suspense fallback={null}> 로 감싼다(mypage layout 과 같은 이유).
 */
export default function ScopeHistoryTracker({ scope }: { scope: HistoryScope }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";

  // 브라우저 «뒤로·앞으로»(기기 뒤로 가기·«←» 의 history.back 포함)를 듣는다.
  // 화면 기록(아래 효과)보다 먼저 붙어야 해서 첫 효과로 둔다(학부모 부품과 같은 순서)
  useEffect(() => {
    startScopePopListening(scope);
    const onPop = () => {
      // 창(시트·크게 보기·수업 화면의 나가기 확인 칸)을 «뒤로»로 닫은 popstate 는 주소가 그대로다 — 화면 이동이 아니니 표시하지 않는다
      try {
        const stack = readScopeHistory(scope);
        if (stack.length > 0 && stack[stack.length - 1] === entryOf(window.location.pathname, window.location.search)) return;
      } catch {
        // 읽기 실패 — 표시는 짧게만 유효해 큰일 없다
      }
      noteScopePopNavigation(scope);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [scope]);

  useEffect(() => {
    // 범위 밖 주소는 기록하지 않는다(떠나는 순간 한 번 더 그려져도 다른 역할 화면 주소가 섞이지 않게).
    // «거쳐 가는 화면»(기사님 첫 화면 등)도 기록하지 않는다 — 곧 다른 주소로 바뀌어 브라우저 기록엔 남지 않는 칸이다
    if (!pathname || !isScopePath(pathname, scope) || isPassThroughPath(pathname)) return;
    try {
      recordScopeNavigation(scope, entryOf(pathname, search));
    } catch {
      // 기록은 편의 기능이다 — 실패해도 화면은 그대로(뒤로 버튼은 그 역할의 홈으로 간다)
    }
  }, [scope, pathname, search]);

  // 이 범위를 «화면 안 이동»으로 떠날 때(로그인·공개 홈·내 계정·다른 역할 화면) «다음 기록은 새로 시작» 표시.
  // 정리 함수는 이동이 끝나기 전에 돌 수 있어 한 박자 뒤 실제 주소로 판단한다(개발 모드 이중 실행에서는 범위 안이라 표시 안 함).
  useEffect(() => () => {
    setTimeout(() => {
      try {
        if (!isScopePath(window.location.pathname, scope)) markLeftScope(scope);
      } catch {
        // 표시 실패 — 뒤로 버튼이 한 칸 더 이어질 뿐
      }
    }, 0);
  }, [scope]);

  return null;
}
