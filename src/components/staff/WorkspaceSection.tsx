"use client";

import type { ReactNode } from "react";
import UiIcon from "@/components/common/UiIcon";

/**
 * 접었다 펴는 칸(2026-11-15 원장 지시 «모두 접었다가 펼치는 형태로 한 화면에서»).
 *
 * - 머리줄 전체가 버튼(48px). 펼침 표시는 글자·기호 대신 공용 화살표 아이콘이고,
 *   칸 제목이 버튼 이름이라 아이콘은 보여 주기만 한다(aria-hidden). 상태는 aria-expanded 로 알린다.
 * - 접어도 안의 내용은 화면에서만 숨긴다(hidden) — 입력 중인 글, 저장 중·실패 표시, 올리는 중인 사진이 사라지지 않게.
 * - summary = 접혀 있을 때도 보이는 요약 한 줄, badge = 접혀 있어도 꼭 보여야 하는 경고(저장 실패 등).
 */
export function WorkspaceSection({
  id,
  title,
  summary,
  badge,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  summary?: ReactNode;
  badge?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 overflow-hidden rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        className="flex min-h-12 w-full items-center gap-2 px-4 py-2 text-left text-[var(--color-academy-ink)]"
      >
        <span className="shrink-0 text-sm font-semibold">{title}</span>
        <span className="min-w-0 flex-1 break-keep text-xs text-[var(--color-academy-muted)]">{summary}</span>
        {badge}
        <span className="flex shrink-0 text-[var(--color-academy-muted)]">
          <UiIcon name={open ? "expand_less" : "expand_more"} />
        </span>
      </button>
      <div id={`${id}-panel`} hidden={!open} className="border-t border-[var(--color-academy-line)] px-4 py-3">
        {children}
      </div>
    </section>
  );
}
