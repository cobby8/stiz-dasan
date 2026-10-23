"use client";

import { useId, useState, type ReactNode } from "react";

type CompactListFiltersProps = {
  activeCount: number;
  summary: string;
  onReset: () => void;
  children: ReactNode;
  className?: string;
  resultCount?: string | number;
  label?: string;
  search?: ReactNode;
  actions?: ReactNode;
};

/** 조건 값과 조회 방식은 부모가 유지하고, 조작 영역만 한 곳에 모읍니다. */
export default function CompactListFilters({ activeCount, summary, onReset, children, className = "", resultCount, label = "필터", search, actions }: CompactListFiltersProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <section aria-label="목록 검색과 필터" className={`min-w-0 space-y-2 [&_select]:h-11 ${className}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {search && <div className="min-w-0 flex-1 basis-32">{search}</div>}
        <button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] px-3 text-sm font-bold text-[var(--color-academy-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-academy-primary)]">
          <span className="material-symbols-outlined text-lg" aria-hidden="true">tune</span>
          {label}{activeCount > 0 && <span aria-label={`${activeCount}개 조건 선택`} className="rounded-md bg-[var(--color-academy-primary-soft)] px-1.5 text-xs">{activeCount}</span>}
        </button>
        {actions}
      </div>
      <div id={panelId} hidden={!open} className={open ? "grid min-w-0 gap-3 rounded-xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-3 sm:grid-cols-2 xl:grid-cols-3" : "hidden"}>{children}</div>
      <div aria-live="polite" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-academy-muted)]">
        <p className="min-w-0 flex-1 break-words">{resultCount !== undefined && <strong className="mr-2 font-bold text-[var(--color-academy-ink)]">{resultCount}</strong>}{summary}</p>
        {activeCount > 0 && <button type="button" onClick={onReset} className="min-h-11 shrink-0 px-1 font-bold text-[var(--color-academy-primary)] underline underline-offset-2">필터 초기화</button>}
      </div>
    </section>
  );
}
