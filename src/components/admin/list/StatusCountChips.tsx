"use client";

export type StatusCountChipItem = {
    /** 상태 값(예: "PENDING") — 부모의 상태 필터 값과 같은 것을 쓴다 */
    value: string;
    label: string;
    count: number;
};

interface StatusCountChipsProps {
    items: StatusCountChipItem[];
    /** 지금 선택된 상태. 전체 보기면 allValue(기본 "ALL") */
    selected: string;
    /** 칩을 누르면 그 상태만 보기, 같은 칩을 다시 누르면 전체로 되돌린다 */
    onSelect: (value: string) => void;
    allValue?: string;
    ariaLabel?: string;
}

/**
 * 목록 위에 붙는 «상태별 건수 칩» 줄 (예: 대기 1 · 승인 18 · 반려 2).
 * 칩 상태는 부모의 기존 상태 필터(select)와 같은 값을 공유해서, 칩과 필터 모달이 항상 같은 상태를 가리킨다.
 * 0건인 상태는 화면을 어지럽히지 않게 숨기되, 선택돼 있으면(해제할 수 있도록) 보인다.
 */
export default function StatusCountChips({
    items,
    selected,
    onSelect,
    allValue = "ALL",
    ariaLabel = "상태별 건수",
}: StatusCountChipsProps) {
    const visible = items.filter((item) => item.count > 0 || item.value === selected);
    if (visible.length === 0) return null;

    return (
        <div role="group" aria-label={ariaLabel} className="flex min-w-0 flex-wrap items-center gap-1.5">
            {visible.map((item) => {
                const active = selected === item.value;
                return (
                    <button
                        key={item.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onSelect(active ? allValue : item.value)}
                        className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-sm font-bold transition ${
                            active
                                ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)]"
                                : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)] hover:border-[var(--color-academy-primary)]"
                        }`}
                    >
                        {item.label}
                        {/* 건수는 자릿수가 같은 폭으로 보이도록 tabular-nums */}
                        <span className={`tabular-nums ${active ? "" : "text-[var(--color-academy-muted)]"}`}>{item.count}</span>
                    </button>
                );
            })}
        </div>
    );
}
