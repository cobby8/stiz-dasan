"use client";

import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";
import { browserPreviousPath } from "@/lib/navigation/publicHistory";
import { readInAppHistory, isParentScopePath, pathOf } from "@/lib/navigation/inAppHistory";

/**
 * 목적지가 글자로 정해진 «돌아가기» 링크(«목록으로 돌아가기»·«← 클럽샵»·«취소» 등) — 2026-11-17 뒤로 가기 전수 조치.
 *
 * 왜: 예전엔 그냥 Link(push)라, 목록에서 들어온 사람도 «목록»을 누르면 목록이 한 칸 «앞으로» 쌓였다.
 *     그 목록의 «←»·휴대폰 뒤로가 방금 본 상세로 되돌아가는 고리가 생기고, 목록 스크롤 위치도 잃었다.
 * → 바로 앞 화면이 바로 그 목적지면 한 칸 뒤로(history.back), 아니면 예전처럼 그 주소로 간다.
 *   (글자가 «목록»이니 다른 곳에서 왔을 땐 목록으로 가는 게 맞다)
 * 바로 앞 화면은 브라우저 Navigation API, 학부모 화면은 우리 이동 기록(inAppHistory)으로 본다. 못 읽으면 예전 동작.
 */
export default function ReturnLink({ href, onClick, ...rest }: Omit<ComponentProps<typeof Link>, "href"> & { href: string }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    try {
      const target = pathOf(href);
      let previous = browserPreviousPath();
      if (previous === null && isParentScopePath(window.location.pathname)) {
        const stack = readInAppHistory();
        previous = stack.length >= 2 && pathOf(stack[stack.length - 1]) === window.location.pathname ? pathOf(stack[stack.length - 2]) : null;
      }
      if (previous !== null && previous === target && window.history.length > 1) {
        event.preventDefault();
        window.history.back();
      }
    } catch {
      // 판단 실패 — 예전처럼 그 주소로
    }
  };
  return <Link href={href} onClick={handleClick} {...rest} />;
}
