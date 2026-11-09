"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const RichTextEditor = dynamic(() => import("@/components/RichTextEditor"), {
    ssr: false,
    loading: () => (
        <div className="border border-[var(--color-academy-line-input)] rounded-md p-4 min-h-[150px] bg-[var(--color-academy-soft)] flex items-center justify-center text-sm text-[var(--color-academy-faint)]">
            에디터 로딩중...
        </div>
    ),
});

export default function LazyRichTextEditor({
    value,
    onChange,
    placeholder,
}: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const [shouldLoad, setShouldLoad] = useState(false);

    useEffect(() => {
        if (shouldLoad) return;
        const node = rootRef.current;
        if (!node) return;

        if (typeof IntersectionObserver === "undefined") {
            const timeout = window.setTimeout(() => setShouldLoad(true), 800);
            return () => window.clearTimeout(timeout);
        }

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry.isIntersecting) {
                    setShouldLoad(true);
                    observer.disconnect();
                }
            },
            { rootMargin: "320px 0px" },
        );

        observer.observe(node);
        return () => observer.disconnect();
    }, [shouldLoad]);

    return (
        <div ref={rootRef} onMouseEnter={() => setShouldLoad(true)} onFocus={() => setShouldLoad(true)}>
            {shouldLoad ? (
                <RichTextEditor value={value} onChange={onChange} placeholder={placeholder} />
            ) : (
                <button
                    type="button"
                    onClick={() => setShouldLoad(true)}
                    className="w-full border border-[var(--color-academy-line-input)] rounded-md p-4 min-h-[150px] bg-[var(--color-academy-soft)] flex flex-col items-center justify-center gap-2 text-sm text-[var(--color-academy-muted)] hover:border-[var(--color-academy-primary)] transition"
                >
                    {/* 지연 로딩(성능 최적화)은 그대로 두고, 사용자에게는 "내용 편집"으로만 보이게 한다 */}
                    <span className="font-bold text-[var(--color-academy-muted)]">내용 편집</span>
                </button>
            )}
        </div>
    );
}
