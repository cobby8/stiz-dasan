/**
 * «수업 중»·«운행 중» 진행 알약 — 선생님 홈·수업 진행 화면·기사님 헤더가 같은 모양을 쓴다.
 * 주황(브랜드) 채움 + 깜빡이는 점(진행 표시)으로 «지금 진행 중»을 한눈에 구분한다.
 * 점의 깜빡임은 «동작 줄이기» 설정이면 멈춘다(motion-reduce).
 */
export function LiveStatusPill({ children, className = "" }: { children: string; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[var(--brand-accent)] px-3 py-1 text-xs font-black text-[var(--brand-accent-contrast)] ${className}`}>
      <span aria-hidden="true" className="size-2 rounded-full bg-[var(--brand-accent-contrast)] animate-pulse motion-reduce:animate-none" />
      {children}
    </span>
  );
}
