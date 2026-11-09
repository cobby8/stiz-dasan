import type { ReactNode } from "react";
import { TONE_BADGE_CLASS, type StatusTone } from "@/lib/ui/statusTones";

/**
 * 상태 배지 — 게슈탈트 «유사성»: 같은 뜻의 상태는 화면이 달라도 같은 색.
 * 색 지도는 src/lib/ui/statusTones.ts 한 곳(2026-11-09 색상 정리). 바탕은 연한 상태색, 글씨는 같은 계열 진한 색.
 * success = 출석·납부·승인 · warning = 지각·미납·대기 · danger = 결석·연체·반려 · info = 보강·입금 확인 중 · neutral = 취소·환불·기타
 * 모양: 상태 «표시»는 모서리 4px(rounded) — 누르는 칩(알약)과 구분한다(교과서 6장 «상태 표시 4px · 누르는 칩 알약»).
 */
export type { StatusTone };

/** 기존 상태표의 color 칸에 그대로 끼울 수 있는 색 클래스 */
export function statusToneClass(tone: StatusTone): string {
    return TONE_BADGE_CLASS[tone];
}

export default function StatusBadge({ tone, children, className = "" }: { tone: StatusTone; children: ReactNode; className?: string }) {
    return (
        <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-bold ${TONE_BADGE_CLASS[tone]} ${className}`}>
            {children}
        </span>
    );
}
