"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type AdminQuickAction = {
    key: string;
    label: string;
    icon: string;
    tone?: "default" | "primary" | "danger";
    disabled?: boolean;
    onSelect: () => void | Promise<void>;
};

type AdminQuickActionMenuProps = {
    label: string;
    actions: AdminQuickAction[];
    icon?: string;
    className?: string;
};

type MenuPosition = {
    top: number;
    left: number;
};

const MENU_WIDTH = 200;
const MENU_MARGIN = 12;
// 위치 계산용 높이(px) — 항목 44px + 간격 4px, 맨 위 대상 이름 줄, 위험 구분선, 안쪽 여백
const ACTION_HEIGHT = 48;
const HEADER_HEIGHT = 28;
const DIVIDER_HEIGHT = 13;
const MENU_PADDING = 16;

/**
 * 게슈탈트 «근접성»: 위험 작업(tone: "danger")은 호출하는 쪽 순서와 상관없이 맨 아래 구분선 밑으로 모은다.
 * 일반 작업 사이에 «삭제»가 끼어 있으면 손이 미끄러져 누르기 쉽다.
 */
export function splitQuickActions(actions: AdminQuickAction[]) {
    return {
        safe: actions.filter((action) => action.tone !== "danger"),
        danger: actions.filter((action) => action.tone === "danger"),
    };
}

function getActionClass(tone: AdminQuickAction["tone"]) {
    // 누르는 영역 44px(min-h-11), 글자 12px 이상
    const base =
        "flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50";

    if (tone === "primary") {
        // 주인공 작업 — 꽉 찬 주황 + 흰 글씨(대비 확보)
        return `${base} border-[var(--color-academy-primary)] bg-[var(--color-academy-primary)] text-[var(--color-academy-on-primary)] hover:bg-[var(--color-academy-primary-hover)]`;
    }

    if (tone === "danger") {
        // 위험 작업 — 빨간 글씨 + 빨간 테두리(최종 확정은 확인 창에서)
        return `${base} border-[var(--color-academy-danger)] bg-[var(--color-academy-surface)] text-[var(--color-academy-danger)] hover:bg-[var(--color-academy-danger-soft)]`;
    }

    // 보조 작업 — 테두리만
    return `${base} border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-ink)] hover:bg-[var(--color-academy-soft)]`;
}

export default function AdminQuickActionMenu({
    label,
    actions,
    icon = "flash_on",
    className = "",
}: AdminQuickActionMenuProps) {
    const [open, setOpen] = useState(false);
    const [position, setPosition] = useState<MenuPosition | null>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const { safe, danger } = splitQuickActions(actions);
    const actionCount = actions.length;
    const dangerCount = danger.length;

    const placeMenu = useCallback(() => {
        const button = buttonRef.current;
        if (!button) return;

        const rect = button.getBoundingClientRect();
        // 실제로 그려지는 줄(대상 이름 + 일반 + 구분선 + 위험)과 같은 높이로 계산해야 화면 밖으로 안 나간다
        const hasDivider = dangerCount > 0 && dangerCount < actionCount;
        const menuHeight = Math.max(
            64,
            HEADER_HEIGHT + actionCount * ACTION_HEIGHT + (hasDivider ? DIVIDER_HEIGHT : 0) + MENU_PADDING,
        );
        const preferredLeft = rect.left - MENU_WIDTH - 10;
        const fallbackRight = rect.right + 10;
        const maxLeft = window.innerWidth - MENU_WIDTH - MENU_MARGIN;
        const left = preferredLeft >= MENU_MARGIN
            ? Math.min(preferredLeft, maxLeft)
            : Math.min(Math.max(fallbackRight, MENU_MARGIN), maxLeft);
        const top = Math.min(
            Math.max(rect.top + rect.height / 2, MENU_MARGIN + menuHeight / 2),
            window.innerHeight - MENU_MARGIN - menuHeight / 2,
        );

        setPosition({
            top,
            left: Math.max(MENU_MARGIN, left),
        });
    }, [actionCount, dangerCount]);

    useEffect(() => {
        if (!open) return;

        placeMenu();

        // 메뉴가 열린 동안 «어느 행의 메뉴인지» 보이게 그 행을 옅게 강조한다(닫히면 원래대로).
        const row = buttonRef.current?.closest<HTMLElement>("tr, [role='row'], li, [data-admin-row]") ?? null;
        const previousRowBackground = row?.style.backgroundColor ?? "";
        if (row) row.style.backgroundColor = "var(--color-academy-primary-soft)";

        function handlePointerDown(event: PointerEvent) {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
            setOpen(false);
        }

        function handleKeyDown(event: KeyboardEvent) {
            if (event.key === "Escape") {
                setOpen(false);
            }
        }

        window.addEventListener("resize", placeMenu);
        window.addEventListener("scroll", placeMenu, true);
        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            if (row) row.style.backgroundColor = previousRowBackground;
            window.removeEventListener("resize", placeMenu);
            window.removeEventListener("scroll", placeMenu, true);
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [open, placeMenu]);

    function renderAction(action: AdminQuickAction) {
        return (
            <button
                key={action.key}
                type="button"
                disabled={action.disabled}
                onClick={() => {
                    if (action.disabled) return;
                    setOpen(false);
                    void action.onSelect();
                }}
                className={getActionClass(action.tone)}
            >
                <span className="truncate">{action.label}</span>
                <span className="material-symbols-outlined text-[18px]" aria-hidden="true">{action.icon}</span>
            </button>
        );
    }

    return (
        <div className={`relative inline-flex justify-center ${className}`}>
            {/* 겉모습은 36px 빨간 원(원장 결정 유지), 누르는 영역은 before 로 사방 4px 넓혀 44px */}
            <button
                ref={buttonRef}
                type="button"
                aria-label={label}
                title={label}
                aria-expanded={open}
                onClick={() => {
                    if (!open) placeMenu();
                    setOpen((current) => !current);
                }}
                className="relative inline-flex h-9 w-9 items-center justify-center rounded-full bg-red-500 text-white shadow-sm transition before:absolute before:-inset-1 before:content-[''] hover:bg-red-600 dark:bg-brand-neon-lime dark:text-brand-navy-900 dark:hover:brightness-95"
            >
                <span className="material-symbols-outlined text-[20px]" aria-hidden="true">{icon}</span>
            </button>

            {open && (
                <div
                    ref={menuRef}
                    aria-label={label}
                    style={{
                        top: position?.top ?? 0,
                        left: position?.left ?? 0,
                    }}
                    className="fixed z-[90] flex w-[200px] -translate-y-1/2 flex-col gap-1 rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-2 shadow-2xl"
                >
                    {/* 맨 위 대상 이름 — 어느 행의 메뉴인지 확인하고 누르게 */}
                    <p className="truncate px-1 pb-1 text-xs font-bold text-[var(--color-academy-muted)]" title={label}>{label}</p>
                    {safe.map(renderAction)}
                    {safe.length > 0 && danger.length > 0 && (
                        <div className="my-1 border-t border-[var(--color-academy-line)]" role="separator" />
                    )}
                    {danger.map(renderAction)}
                </div>
            )}
        </div>
    );
}
