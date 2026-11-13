/**
 * «수업 중»·«운행 중» 진행 알약 — 선생님 홈·수업 진행 화면·기사님 헤더가 같은 모양을 쓴다.
 * 보조 색(하늘색) 바탕 + 테두리 + 깜빡이는 점(진행 표시)으로 «지금 진행 중»을 한눈에 구분한다.
 * (2026-11-13 UI 통일: 꽉 찬 주 색은 누르는 주 버튼만 — «지금 있는 곳·진행 중»은 보조 색)
 * 점의 깜빡임은 «동작 줄이기» 설정이면 멈춘다(motion-reduce).
 */
export function LiveStatusPill({ children, className = "" }: { children: string; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--color-academy-secondary-soft)] px-3 py-1 text-xs font-semibold text-[var(--color-academy-secondary-ink)] ring-1 ring-inset ring-[var(--color-academy-secondary-strong)] ${className}`}>
      <span aria-hidden="true" className="size-2 rounded-full bg-[var(--color-academy-secondary-strong)] animate-pulse motion-reduce:animate-none" />
      {children}
    </span>
  );
}
