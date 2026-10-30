import type { ReactNode } from "react";

/**
 * 관리자 상태 배지 — 게슈탈트 «유사성»: 같은 뜻의 상태는 화면이 달라도 같은 색.
 * 바탕은 옅은 학원 색(--color-academy-*-soft), 글씨는 같은 계열 진한 색이라 대비가 확보된다.
 * warning = 미납·대기 · success = 완료·승인 · danger = 연체·반려·결석 · neutral = 취소·환불·기타
 */
export type StatusTone = "warning" | "success" | "danger" | "neutral";

const TONE_CLASS: Record<StatusTone, string> = {
    warning: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
    success: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]",
    danger: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]",
    neutral: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
};

/** 기존 상태표의 color 칸에 그대로 끼울 수 있는 색 클래스 */
export function statusToneClass(tone: StatusTone): string {
    return TONE_CLASS[tone];
}

export default function StatusBadge({ tone, children, className = "" }: { tone: StatusTone; children: ReactNode; className?: string }) {
    return (
        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold ${TONE_CLASS[tone]} ${className}`}>
            {children}
        </span>
    );
}
