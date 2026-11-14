"use client";

import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { entryOf, recordInAppNavigation } from "@/lib/navigation/inAppHistory";

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

  useEffect(() => {
    if (!pathname) return;
    try {
      recordInAppNavigation(entryOf(pathname, search));
    } catch {
      // 기록은 편의 기능이다 — 실패해도 화면은 그대로(뒤로 버튼은 고정 주소로 간다)
    }
  }, [pathname, search]);

  return null;
}
