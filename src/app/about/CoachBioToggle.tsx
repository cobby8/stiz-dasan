'use client';

import { useState } from 'react';

/**
 * CoachBioToggle — 코치 이력을 1줄만 보여주고, 클릭하면 전체 펼치기
 *
 * 이력이 길어서 카드 높이가 들쭉날쭉해지는 문제를 해결.
 * 첫 줄만 보여주고 "더보기" 버튼으로 나머지를 펼칠 수 있음.
 */
export default function CoachBioToggle({ text }: { text: string }) {
    const [isOpen, setIsOpen] = useState(false);

    if (!text) return null;

    return (
        <div>
            <div className={isOpen ? '' : 'line-clamp-1'}>
                <p className="text-base text-[var(--color-public-muted)] dark:text-[var(--color-public-muted)] leading-relaxed whitespace-pre-line">
                    {text}
                </p>
            </div>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="text-sm text-[var(--color-public-accent)] dark:text-brand-neon-lime font-medium mt-1 hover:underline"
            >
                {isOpen ? '접기' : '더보기'}
            </button>
        </div>
    );
}
