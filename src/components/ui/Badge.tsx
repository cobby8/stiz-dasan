/**
 * Badge — 공통 뱃지 컴포넌트 (Phase 0 디자인 시스템)
 *
 * 상태나 카테고리를 표시하는 작은 라벨. 누르는 칩(알약)과 구분되게 모서리 4px(rounded).
 * 색은 상태 토큰(academy-theme.css :root)만 쓴다 — 2026-11-09 색상 정리(같은 뜻 = 같은 색).
 *
 * 5종 variant:
 * - default: 중립 회색 (직책·분류 같은 일반 꼬리표)
 * - success: 정상(초록) — 여석 있음, 성공
 * - warning: 주의(호박) — 마감 임박
 * - error: 위험(빨강) — 마감, 에러
 * - info: 정보(보라) — 안내
 *
 * Server Component 가능 (상태/이벤트 없음)
 */

type BadgeVariant = 'default' | 'success' | 'warning' | 'error' | 'info';
type BadgeSize = 'sm' | 'md';

interface BadgeProps {
  variant?: BadgeVariant;
  size?: BadgeSize;
  children: React.ReactNode;
  className?: string;
}

// 각 variant별 배경색 + 텍스트색
// 밝은 화면 = 상태 토큰. 어두운 화면(dark:)은 다크모드를 따로 정할 때까지 예전 모양 그대로 둔다(원장 결정 5).
const variantStyles: Record<BadgeVariant, string> = {
  default: 'bg-[var(--color-academy-neutral-soft)] text-[var(--color-academy-neutral)] dark:bg-brand-neon-lime/10 dark:text-brand-neon-lime',
  success: 'bg-[var(--color-academy-success-soft)] text-[var(--color-academy-success)] dark:bg-emerald-900/30 dark:text-emerald-400',
  warning: 'bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)] dark:bg-amber-900/30 dark:text-amber-400',
  error: 'bg-[var(--color-academy-danger-soft)] text-[var(--color-academy-danger)] dark:bg-red-900/30 dark:text-red-400',
  info: 'bg-[var(--color-academy-info-soft)] text-[var(--color-academy-info)] dark:bg-brand-sky-500/10 dark:text-brand-sky-400',
};

// 크기별 패딩/폰트
const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1 text-sm',
};

export default function Badge({
  variant = 'default',
  size = 'sm',
  children,
  className = '',
}: BadgeProps) {
  return (
    <span
      className={[
        // 상태 표시 모양(모서리 4px) + 굵은 폰트 + 인라인 정렬
        'inline-flex items-center rounded font-medium',
        variantStyles[variant],
        sizeStyles[size],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </span>
  );
}
