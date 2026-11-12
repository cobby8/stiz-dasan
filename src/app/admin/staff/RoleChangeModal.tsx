"use client";

/**
 * 역할 변경 창(2026-11-12 원장 지시) — 예전 표 안 선택칸 대신 [역할 변경] 버튼 → 이 창.
 * PC 는 가운데 창, 휴대폰은 아래에서 올라오는 시트(공용 AdminModal 기본 모양).
 * 역할을 큰 버튼으로 고르면 같은 창 안에 «바뀌는 것»이 보이고 [변경하기]로 확정한다(한 번 더 묻는 창 없음).
 * 실제 변경은 부모(StaffClient)의 onConfirm → 서버 updateUserRole(원장 전용·자기 자신 불가)이 한다.
 */

import { useState } from "react";
import AdminModal from "@/components/admin/AdminModal";
import { ROLE_CHANGE_OPTIONS, roleChangePreview, type RoleChangeValue } from "@/lib/staff/roleChange";

export default function RoleChangeModal({
    user,
    hasPendingLink,
    pending,
    onClose,
    onConfirm,
}: {
    user: { id: string; name: string; role: string; coachName: string | null };
    /** 이 사람을 향한 대기 가입 링크(초대로 전환·로그인 연결)가 있는가 — 역할을 바꾸면 서버가 취소한다 */
    hasPendingLink: boolean;
    pending: boolean;
    onClose: () => void;
    onConfirm: (nextRole: RoleChangeValue) => void;
}) {
    // 고른 역할(아직 안 바꿈). 지금 역할은 고를 수 없다.
    const [selected, setSelected] = useState<RoleChangeValue | null>(null);
    const preview = selected
        ? roleChangePreview({ currentRole: user.role, nextRole: selected, coachName: user.coachName, hasPendingLink })
        : null;

    return (
        <AdminModal onClose={onClose} titleId="staff-role-change-title" panelClassName="max-w-md">
            <div className="flex items-center gap-2 border-b border-[var(--color-academy-line)] px-4 py-2">
                <h2 id="staff-role-change-title" className="min-w-0 break-keep text-base font-black text-[var(--color-academy-ink)]">
                    {user.name} 역할 변경
                </h2>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label="닫기"
                    className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                >
                    <span className="material-symbols-outlined" aria-hidden="true">close</span>
                </button>
            </div>

            {/* 역할 버튼 — 한 줄에 아이콘 · 이름 · 한 줄 설명. 지금 역할은 «지금» 표시 + 누를 수 없음 */}
            <div role="radiogroup" aria-label="바꿀 역할" className="grid gap-1.5 p-3">
                {ROLE_CHANGE_OPTIONS.map((option) => {
                    const isCurrent = option.value === user.role;
                    const isSelected = option.value === selected;
                    return (
                        <button
                            key={option.value}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            disabled={isCurrent || pending}
                            onClick={() => setSelected(option.value)}
                            className={`flex min-h-12 w-full items-center gap-3 rounded-lg border px-3 py-1.5 text-left transition-colors ${
                                isSelected
                                    ? "border-[var(--color-academy-primary)] bg-[var(--color-academy-primary-soft)]"
                                    : isCurrent
                                        ? "cursor-default border-[var(--color-academy-line)] bg-[var(--color-academy-soft)]"
                                        : "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] hover:border-[var(--color-academy-primary)]"
                            }`}
                        >
                            <span
                                className={`material-symbols-outlined text-[22px] ${isSelected ? "text-[var(--color-academy-primary)]" : "text-[var(--color-academy-muted)]"}`}
                                aria-hidden="true"
                            >
                                {option.icon}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-bold text-[var(--color-academy-ink)]">{option.label}</span>
                                <span className="block text-xs text-[var(--color-academy-muted)]">{option.description}</span>
                            </span>
                            {isCurrent && (
                                <span className="whitespace-nowrap rounded-full bg-[var(--color-academy-line)] px-2 py-0.5 text-xs font-bold text-[var(--color-academy-muted)]">지금</span>
                            )}
                            {isSelected && (
                                <span className="material-symbols-outlined text-[20px] text-[var(--color-academy-primary)]" aria-hidden="true">check_circle</span>
                            )}
                        </button>
                    );
                })}
            </div>

            {/* 고르면 «바뀌는 것» + [취소]·[변경하기] — 같은 창 안에서 확정 */}
            {preview && selected && (
                <div className="border-t border-[var(--color-academy-line)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
                    <p className="text-xs font-black text-[var(--color-academy-muted)]">바뀌는 것</p>
                    <ul
                        className={`mt-1 space-y-0.5 text-sm ${preview.danger ? "text-[var(--color-academy-danger)]" : "text-[var(--color-academy-ink)]"}`}
                        aria-live="polite"
                    >
                        {preview.lines.map((line) => <li key={line}>· {line}</li>)}
                    </ul>
                    <div className="mt-3 flex justify-end gap-2">
                        <button
                            type="button"
                            onClick={onClose}
                            className="min-h-11 rounded-lg px-4 text-sm font-bold text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
                        >
                            취소
                        </button>
                        <button
                            type="button"
                            disabled={pending}
                            onClick={() => onConfirm(selected)}
                            className={`min-h-11 rounded-lg px-4 text-sm font-bold text-[var(--color-academy-on-primary)] disabled:opacity-50 ${
                                preview.danger
                                    ? "bg-[var(--color-academy-danger)]"
                                    : "bg-[var(--color-academy-primary)] hover:bg-[var(--color-academy-primary-hover)]"
                            }`}
                        >
                            {pending ? "바꾸는 중…" : "변경하기"}
                        </button>
                    </div>
                </div>
            )}
        </AdminModal>
    );
}
