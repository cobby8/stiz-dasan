"use client";

import { useEffect, useState } from "react";

export type ListViewOption<T extends string> = {
    value: T;
    // 2026-11-14 아이콘 완전 제거: icon 값은 부르는 곳이 없어 타입에서도 뺐다
    label: string;
};

interface ListViewToggleProps<T extends string> {
    value: T;
    options: ReadonlyArray<ListViewOption<T>>;
    onChange: (value: T) => void;
    ariaLabel?: string;
}

/**
 * «목록 | 상태별» 처럼 보기 방식을 고르는 2칸 전환 버튼.
 * 원생 관리 화면의 «목록 | 반별» 버튼과 같은 모양(aria-pressed, 44px 높이)을 공용 부품으로 뺀 것.
 */
export default function ListViewToggle<T extends string>({
    value,
    options,
    onChange,
    ariaLabel = "보기 방식",
}: ListViewToggleProps<T>) {
    return (
        <div
            role="group"
            aria-label={ariaLabel}
            className="inline-flex shrink-0 rounded-lg border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-0.5"
        >
            {options.map((item) => {
                const selected = value === item.value;
                return (
                    <button
                        key={item.value}
                        type="button"
                        aria-pressed={selected}
                        onClick={() => onChange(item.value)}
                        // 고른 보기 = 보조 색(하늘색). 아이콘 없이 글자만(2026-11-13 원장 «아이콘 빼고 글자 깔끔하게»)
                        className={`inline-flex min-h-11 items-center gap-1 rounded-md px-3 text-sm transition ${
                            selected
                                ? "bg-[var(--color-academy-secondary-soft)] font-semibold text-[var(--color-academy-secondary-ink)] ring-1 ring-inset ring-[var(--color-academy-secondary-strong)]"
                                : "font-medium text-[var(--color-academy-muted)] hover:text-[var(--color-academy-ink)]"
                        }`}
                    >
                        {item.label}
                    </button>
                );
            })}
        </div>
    );
}

/**
 * 보기 방식을 브라우저(localStorage)에 기억하는 상태 훅.
 * 서버 화면과 첫 화면을 맞추려고(hydration) 처음엔 기본값으로 그린 뒤, 저장된 값을 읽어 바꾼다.
 */
export function useRememberedListView<T extends string>(storageKey: string, allowed: readonly T[], fallback: T) {
    const [view, setView] = useState<T>(fallback);
    // 저장값을 읽었는지(세 번째 반환값). 무거운 보기를 저장값 확인 전에 헛그리지 않게 쓸 수 있다
    const [ready, setReady] = useState(false);

    useEffect(() => {
        try {
            const saved = window.localStorage.getItem(storageKey);
            // 저장값이 허용 목록에 있을 때만 쓴다(옛 값·오타가 화면을 깨지 않게)
            if (saved && (allowed as readonly string[]).includes(saved)) setView(saved as T);
        } catch {
            // 사생활 보호 모드 등에서 저장소 접근이 막혀도 기본 보기로 동작
        }
        setReady(true);
        // allowed 는 보통 상수 배열이라 처음 한 번만 읽으면 된다
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [storageKey]);

    const changeView = (next: T) => {
        setView(next);
        try {
            window.localStorage.setItem(storageKey, next);
        } catch {
            // 저장 실패는 무시(다음 방문 때 기본 보기)
        }
    };

    return [view, changeView, ready] as const;
}
