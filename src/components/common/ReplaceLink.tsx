"use client";

import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";
import { isParentScopePath, markNextNavigationAsReplace } from "@/lib/navigation/inAppHistory";

/**
 * 지금 칸을 «바꿔 끼우며» 다른 화면으로 가는 링크(2026-11-17) — 완료 화면의 «홈으로·청구 목록·상세 보기» 등.
 *
 * 왜: 신청·결제 완료 화면은 기록에 남으면 안 된다(그 화면의 «←» 가 빈 신청서·결제 완료 확인으로 되돌아왔다).
 * 그냥 <Link replace> 만 쓰면 브라우저 기록은 바뀌는데 학부모 이동 기록(inAppHistory)은 한 칸 쌓여 둘이 어긋난다
 * → 지금 화면과 목적지가 둘 다 학부모 화면이면 «다음 이동은 바꿔 끼우기» 표시를 남긴다(ParentBackLink 와 같은 규칙).
 */
export default function ReplaceLink({ href, onClick, ...rest }: Omit<ComponentProps<typeof Link>, "replace" | "href"> & { href: string }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    try {
      if (isParentScopePath(window.location.pathname) && isParentScopePath(href.split(/[?#]/)[0])) markNextNavigationAsReplace();
    } catch {
      // 표시 실패 — 기록이 한 칸 더 쌓일 뿐
    }
  };
  return <Link href={href} replace onClick={handleClick} {...rest} />;
}
