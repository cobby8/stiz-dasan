import type { ReactNode } from "react";

/**
 * 현장 «상태 버튼» 공용 부품 — 출석부(선생님)·탑승 체크(선생님·기사님)가 같은 약속을 쓴다.
 * (게슈탈트 «유사성»: 같은 뜻 = 같은 색·같은 아이콘·같은 글자)
 *
 * - success = 출석 / 탑승·하차, warning = 지각 / 대기, danger = 결석 / 미탑승
 * - 눌린 상태 = 그 의미색으로 꽉 채움 + 아이콘 + 글자
 * - 안 눌린 상태 = 그 의미색 테두리(바탕은 흰색) — 무엇을 누르면 어떤 색이 되는지 미리 보인다
 * - 높이 44px 이상(수업 중·운전 중 손가락 실수 방지)
 *
 * ⚠️ Tailwind 가 클래스를 찾을 수 있게 색 클래스는 아래 표에 «글자 그대로» 적는다(문자열 조립 금지).
 */
export type StatusTone = "success" | "warning" | "danger" | "neutral";

const FILLED: Record<StatusTone, string> = {
  success: "border-[var(--color-academy-success)] bg-[var(--color-academy-success)] text-[var(--color-academy-on-primary)]",
  warning: "border-[var(--color-academy-warning)] bg-[var(--color-academy-warning)] text-[var(--color-academy-on-primary)]",
  danger: "border-[var(--color-academy-danger)] bg-[var(--color-academy-danger)] text-[var(--color-academy-on-primary)]",
  neutral: "border-[var(--color-academy-muted)] bg-[var(--color-academy-muted)] text-[var(--color-academy-on-primary)]",
};

const OUTLINED: Record<StatusTone, string> = {
  success: "border-[var(--color-academy-success)] bg-[var(--color-academy-surface)] text-[var(--color-academy-success)]",
  warning: "border-[var(--color-academy-warning)] bg-[var(--color-academy-surface)] text-[var(--color-academy-warning)]",
  danger: "border-[var(--color-academy-danger)] bg-[var(--color-academy-surface)] text-[var(--color-academy-danger)]",
  neutral: "border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] text-[var(--color-academy-muted)]",
};

// 이름 옆 «상태 알약»은 옅은 바탕 + 진한 글자(버튼보다 한 단계 약하게 → 버튼이 주인공)
const PILL: Record<StatusTone, string> = {
  success: "bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)]",
  warning: "bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]",
  danger: "bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)]",
  neutral: "bg-[var(--color-academy-soft)] text-[var(--color-academy-muted)]",
};

export function StatusChoiceButton({
  tone,
  icon,
  active,
  disabled = false,
  onClick,
  ariaLabel,
  ariaExpanded,
  className = "",
  children,
}: {
  tone: StatusTone;
  /** Material Symbols 아이콘 이름 (check / schedule / close 등) */
  icon: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  ariaLabel?: string;
  ariaExpanded?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={active}
      aria-expanded={ariaExpanded}
      className={`inline-flex min-h-11 items-center justify-center gap-1 rounded-xl border-2 px-2 text-sm font-black disabled:opacity-55 ${active ? FILLED[tone] : OUTLINED[tone]} ${className}`}
    >
      <span aria-hidden="true" className="material-symbols-outlined text-[18px] leading-none">{icon}</span>
      {children}
    </button>
  );
}

/** 이름 옆 현재 상태 알약 — 버튼과 같은 색·아이콘으로 «지금 어떤 상태인지»를 보여준다. */
export function StatusPill({ tone, icon, children, className = "" }: { tone: StatusTone; icon?: string; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-black ${PILL[tone]} ${className}`}>
      {icon && <span aria-hidden="true" className="material-symbols-outlined text-[14px] leading-none">{icon}</span>}
      {children}
    </span>
  );
}

/** «되돌리기(대기로)» — 상태 버튼과 섞이지 않게 작은 글자 버튼으로 따로 둔다. 터치 영역은 44px 유지. */
export function StatusUndoButton({ disabled = false, onClick, children = "대기로 되돌리기", ariaLabel }: { disabled?: boolean; onClick: () => void; children?: ReactNode; ariaLabel?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className="inline-flex min-h-11 items-center gap-1 px-1 text-xs font-bold text-[var(--color-academy-muted)] underline underline-offset-2 disabled:opacity-55"
    >
      <span aria-hidden="true" className="material-symbols-outlined text-[16px] leading-none no-underline">undo</span>
      {children}
    </button>
  );
}
