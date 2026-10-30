"use client";

import { splitQuickActions, type AdminQuickAction } from "@/components/admin/AdminQuickActionMenu";

type AdminPanelActionsProps = {
    /** ⚡ 메뉴와 같은 작업 목록을 그대로 넘긴다(같은 함수·같은 인자) */
    actions: AdminQuickAction[];
    /** 버튼을 누르기 직전에 할 일(보통 상세 패널 닫기) */
    onBeforeSelect?: () => void;
    className?: string;
};

// ⚡ 메뉴와 같은 색 규칙: 주인공 primary(꽉 찬) · 보조 secondary(테두리) · 위험 danger(빨간 테두리)
function buttonClass(tone: AdminQuickAction["tone"]) {
    if (tone === "primary") return "academy-button-primary";
    if (tone === "danger") return "academy-button-danger";
    return "academy-button-secondary";
}

/**
 * 상세 패널 아래 작업 버튼 줄 — 화면마다 복사해 쓰던 버튼 줄을 한 곳으로 모은 것.
 * 게슈탈트 «근접성»: 위험 작업은 오른쪽 끝으로 떼어 두고(좁으면 구분선 아래 줄),
 * 자주 누르는 안전한 작업과 손이 닿는 자리가 겹치지 않게 한다.
 */
export default function AdminPanelActions({ actions, onBeforeSelect, className = "mt-5" }: AdminPanelActionsProps) {
    const { safe, danger } = splitQuickActions(actions);
    if (actions.length === 0) return null;

    function renderButton(action: AdminQuickAction) {
        return (
            <button
                key={action.key}
                type="button"
                disabled={action.disabled}
                onClick={() => {
                    if (action.disabled) return;
                    onBeforeSelect?.();
                    void action.onSelect();
                }}
                className={buttonClass(action.tone)}
            >
                <span className="material-symbols-outlined text-lg" aria-hidden="true">{action.icon}</span>
                {action.label}
            </button>
        );
    }

    return (
        <div className={`flex flex-wrap items-center gap-2 ${className}`}>
            {safe.map(renderButton)}
            {danger.length > 0 && (
                // ml-auto 로 오른쪽 끝, 줄이 넘치면 구분선(위 테두리) 아래로 떨어진다
                <div className={`ml-auto flex flex-wrap gap-2 ${safe.length > 0 ? "max-sm:w-full max-sm:justify-end max-sm:border-t max-sm:border-[var(--color-academy-line)] max-sm:pt-2" : ""}`}>
                    {danger.map(renderButton)}
                </div>
            )}
        </div>
    );
}
