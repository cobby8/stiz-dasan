/**
 * SectionLayout — 공통 섹션 래퍼 컴포넌트 (Phase 0 디자인 시스템)
 *
 * 모든 공개 페이지의 섹션을 감싸는 레이아웃.
 * 일관된 여백, 최대 너비, 제목 패턴을 제공한다.
 *
 * 제목 패턴 (위에서 아래로):
 *   1. 라벨 — 작은 대문자 텍스트 (예: "ABOUT US", "PROGRAMS")
 *   2. 제목 — 크고 굵은 섹션 타이틀
 *   3. 설명 — 회색 보조 텍스트
 *
 * 배경색 3종:
 *   - white: 기본 흰 배경
 *   - section: 따뜻한 크림색 배경 (#faf5f0)
 *   - warm: 살짝 따뜻한 흰색 (#fffbf5)
 *
 * Server Component 가능 (상태/이벤트 없음)
 */

// 배경색 타입 — 섹션별로 교차 사용하여 시각적 구분을 준다
type BgColor = 'white' | 'section' | 'warm';

interface SectionLayoutProps {
  id?: string;          // 앵커 링크용 id (선택) — 예: id="faq"로 /apply#faq 스크롤 가능
  label?: string;       // 상단 작은 라벨 (선택)
  title?: string;       // 섹션 제목 (선택)
  description?: string; // 설명문 (선택)
  bgColor?: BgColor;    // 배경색 (기본: white)
  children: React.ReactNode;
  className?: string;
  /** 홈 화면용 — 왼쪽 정렬 22px 제목 하나만(라벨·설명은 그려지지 않음). 게슈탈트 P-06 */
  compactHeading?: boolean;
}

// 배경색별 Tailwind 클래스 매핑
const bgColorStyles: Record<BgColor, string> = {
  white: 'bg-white dark:bg-gray-950',
  section: 'bg-surface-section dark:bg-gray-900', // #faf5f0 — 교차 섹션용
  warm: 'bg-surface-warm dark:bg-gray-900',      // #fffbf5 — 메인 배경용
};

export default function SectionLayout({
  id,
  label,
  title,
  description,
  bgColor = 'white',
  children,
  className = '',
  compactHeading = false,
}: SectionLayoutProps) {
  return (
    <section id={id} className={`${bgColorStyles[bgColor]} ${className} transition-colors duration-300`}>
      {/*
        py-16 md:py-24: 모바일 64px / 데스크탑 96px 세로 여백
        max-w-6xl: 최대 1152px로 콘텐츠 가독성 유지
        mx-auto px-4: 중앙 정렬 + 좌우 패딩
      */}
      <div className="max-w-6xl mx-auto px-4 py-16 md:py-24">
        {/* 홈 컴팩트 제목: 왼쪽 정렬 22px 하나. 다른 페이지(/programs 등)는 아래 기존 모양 그대로 */}
        {compactHeading && title && (
          <h2 className="mb-4 text-left text-[22px] font-extrabold leading-snug text-gray-900 dark:text-white">{title}</h2>
        )}

        {/* 제목 영역: 라벨 + 제목 + 설명이 있을 때만 렌더링 */}
        {!compactHeading && (label || title || description) && (
          <div className="text-center mb-12 md:mb-16">
            {/* 라벨: 작은 대문자 텍스트 — "ABOUT US" 같은 섹션 구분자 */}
            {label && (
              <p className="text-sm tracking-widest uppercase text-brand-orange-500 dark:text-brand-neon-lime font-bold mb-3">
                {label}
              </p>
            )}

            {/* 제목: 크고 굵은 메인 타이틀 */}
            {title && (
              <h2 className="text-3xl md:text-4xl font-extrabold text-gray-900 dark:text-white mb-4">
                {title}
              </h2>
            )}

            {/* 설명: 회색 보조 텍스트 */}
            {description && (
              <p className="text-lg text-gray-500 dark:text-gray-400 max-w-2xl mx-auto">
                {description}
              </p>
            )}
          </div>
        )}

        {/* 섹션 본문 (children) */}
        {children}
      </div>
    </section>
  );
}
