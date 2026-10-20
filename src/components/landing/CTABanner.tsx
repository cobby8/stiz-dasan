/**
 * CTABanner — CTA 배너 컴포넌트 (Phase 2 메인 랜딩)
 *
 * 페이지 하단에 배치되는 행동 유도(Call-To-Action) 배너.
 * 재사용 가능하도록 props로 제목/설명/CTA 버튼을 받는다.
 * (ClassDojo의 gradient 히어로 배경 패턴 참고)
 *
 * 그라데이션 배경(navy-900 → navy-800) + 장식 도형으로 시각적 임팩트.
 * 듀얼 CTA: "체험 신청"(Primary) + "전화 상담"(White)
 *
 * contactPhone은 부모 컴포넌트에서 settings에서 꺼내 전달한다.
 */

import Link from 'next/link';
import AnimateOnScroll from '@/components/ui/AnimateOnScroll';

interface CTABannerProps {
  title?: string;
  subtitle?: string;
  phone?: string;             // 전화번호 (settings.contactPhone에서 전달)
  primaryLabel?: string;      // 주요 CTA 버튼 텍스트
  primaryHref?: string;       // 주요 CTA 링크
  secondaryLabel?: string;    // 보조 CTA 버튼 텍스트 (전화)
  showSecondary?: boolean;    // 보조 CTA 표시 여부
}

export default function CTABanner({
  title = '우리 아이, 농구로 성장시켜 보세요',
  subtitle = '아이에게 딱 맞는 클래스를 찾아드립니다. 지금 바로 문의해 주세요.',
  phone = '010-0000-0000',
  primaryLabel = '체험 수업 신청',
  primaryHref = '/apply',
  secondaryLabel = '전화 상담',
  showSecondary = true,
}: CTABannerProps) {
  return (
    // 그라데이션 배경 + 장식 도형으로 시각적 임팩트
    <section className="relative overflow-hidden bg-gradient-to-br from-brand-navy-900 via-brand-navy-800 to-brand-navy-900 dark:from-black dark:via-gray-900 dark:to-black py-16 md:py-20 transition-colors duration-300">
      {/* 장식 도형들 — 반투명 원과 농구공 패턴으로 배경에 깊이감 */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute right-0 top-0 w-64 h-64 border-[20px] border-white/5 dark:border-brand-neon-cobalt/10 rounded-full translate-x-1/3 -translate-y-1/3" />
        <div className="absolute left-0 bottom-0 w-48 h-48 border-[15px] border-brand-orange-500/10 dark:border-brand-neon-lime/10 rounded-full -translate-x-1/4 translate-y-1/4" />
        <div className="absolute right-1/4 top-1/2 w-24 h-24 bg-brand-orange-500/5 dark:bg-brand-neon-cobalt/10 rounded-full blur-xl" />
      </div>

      <div className="max-w-4xl mx-auto px-6 md:px-4 text-center relative">
        <AnimateOnScroll>
          {/* 제목 */}
          <h2 className="text-3xl md:text-4xl font-black text-white mb-4">
            {title}
          </h2>

          {/* 부제목 */}
          <p className="text-blue-200 mb-10 text-lg max-w-xl mx-auto">
            {subtitle}
          </p>

          {/* 듀얼 CTA 버튼 */}
          <div className="flex flex-col sm:flex-row gap-4 justify-center items-center">
            {/* 주요 CTA: 체험 신청 — 오렌지 배경으로 가장 눈에 띄게 */}
            <Link
              href={primaryHref}
              className="inline-flex items-center justify-center bg-brand-orange-500 dark:bg-brand-neon-lime hover:bg-brand-orange-600 dark:hover:bg-lime-400 text-white dark:text-brand-navy-900 font-bold text-lg px-10 py-4 rounded-2xl transition-all duration-200 hover:scale-[1.03] hover:shadow-xl dark:shadow-brand-neon-lime/30 shadow-lg"
            >
              {primaryLabel}
            </Link>

            {/* 보조 CTA: 전화 상담 — 흰 배경으로 보조 역할 */}
            {showSecondary && (
              <a
                href={`tel:${phone.replace(/-/g, '')}`}
                className="inline-flex items-center justify-center bg-white dark:bg-gray-800 text-brand-navy-900 dark:text-white font-bold text-lg px-10 py-4 rounded-2xl transition-all duration-200 hover:bg-gray-50 dark:hover:bg-gray-700 hover:shadow-md shadow-lg"
              >
                {secondaryLabel} {phone}
              </a>
            )}
          </div>
        </AnimateOnScroll>
      </div>
    </section>
  );
}
