'use client';

/**
 * TestimonialCarousel — 학부모 후기 캐러셀 (DB 연동)
 *
 * DB에서 조회한 후기를 props로 받아 좌우 스크롤 캐러셀로 표시.
 * 외부 라이브러리 없이 CSS scroll-snap으로 구현 (번들 사이즈 절약).
 * 후기가 없으면 안내 메시지 표시.
 * naverPlaceUrl이 있으면 하단에 "네이버 플레이스에서 더 많은 후기 보기" 버튼 표시.
 */

import { useRef } from 'react';
import SectionLayout from '@/components/ui/SectionLayout';
import AnimateOnScroll from '@/components/ui/AnimateOnScroll';
import FontFreeIcon from '@/components/ui/FontFreeIcon';

// 후기 데이터 타입
interface Testimonial {
  name: string;        // 학부모 이름 (익명 처리)
  info: string;        // 학생 정보 (예: "초3 학부모")
  text: string;        // 후기 내용
  rating: number;      // 별점 (1~5)
}

interface TestimonialCarouselProps {
  testimonials?: Testimonial[];   // DB에서 조회한 공개 후기 목록
  naverPlaceUrl?: string;         // 네이버 플레이스 리뷰 URL (없으면 버튼 숨김)
}

export default function TestimonialCarousel({
  testimonials = [],
  naverPlaceUrl,
}: TestimonialCarouselProps) {
  // 캐러셀 스크롤 컨테이너 참조
  const scrollRef = useRef<HTMLDivElement>(null);

  // 좌우 스크롤 함수 — 카드 하나 너비(320px)만큼 이동
  const scroll = (direction: 'left' | 'right') => {
    if (!scrollRef.current) return;
    const scrollAmount = 320;
    scrollRef.current.scrollBy({
      left: direction === 'left' ? -scrollAmount : scrollAmount,
      behavior: 'smooth',
    });
  };

  // 별점 렌더링 — 채워진 별과 빈 별을 구분
  const renderStars = (rating: number) => {
    return Array.from({ length: 5 }, (_, i) => (
      <span
        key={i}
        className={i < rating ? 'text-yellow-400' : 'text-gray-200 dark:text-gray-600'}
      >
        &#9733;
      </span>
    ));
  };

  return (
    <SectionLayout
      label="REVIEWS"
      title="학부모님들의 생생한 후기"
      description="스티즈 농구교실을 경험한 학부모님들의 이야기입니다"
      bgColor="section"
    >
      {/* 후기가 없으면 안내 메시지 */}
      {testimonials.length === 0 ? (
        <div className="text-center py-12 text-gray-400 dark:text-gray-400">
          <FontFreeIcon name="rate_review" size={48} className="mx-auto mb-3" />
          <p className="font-medium">아직 등록된 후기가 없습니다</p>
        </div>
      ) : (
        <AnimateOnScroll>
          <div className="relative">
            {/* 좌측 스크롤 버튼 */}
            <button
              onClick={() => scroll('left')}
              className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-3 z-10 w-10 h-10 bg-white dark:bg-gray-800 rounded-full shadow-md flex items-center justify-center hover:shadow-lg dark:hover:bg-gray-700 dark:border dark:border-gray-700 transition-all cursor-pointer hidden md:flex"
              aria-label="이전 후기"
            >
              <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>

            {/* 캐러셀 스크롤 컨테이너 — CSS scroll-snap으로 카드 정렬 */}
            <div
              ref={scrollRef}
              className="flex gap-5 overflow-x-auto scroll-smooth snap-x snap-mandatory pb-4 scrollbar-hide"
              style={{
                // 스크롤바 숨기기 (크로스 브라우저)
                scrollbarWidth: 'none',
                msOverflowStyle: 'none',
              }}
            >
              {testimonials.map((item, index) => (
                <div
                  key={index}
                  className="flex-shrink-0 w-[280px] md:w-[320px] snap-start bg-white dark:bg-gray-800 rounded-2xl p-6 shadow-sm border border-gray-100 dark:border-gray-700 transition-colors"
                >
                  {/* 별점 */}
                  <div className="text-lg mb-3">{renderStars(item.rating)}</div>

                  {/* 후기 내용 — 따옴표로 감싸서 후기 느낌 강조 */}
                  <p className="text-gray-600 dark:text-gray-300 text-base leading-relaxed mb-4 min-h-[80px]">
                    &ldquo;{item.text}&rdquo;
                  </p>

                  {/* 학부모 정보 */}
                  <div className="border-t border-gray-100 dark:border-gray-700 pt-3">
                    <p className="font-bold text-gray-900 dark:text-white text-base">{item.name}</p>
                    <p className="text-sm text-gray-400 dark:text-gray-400">{item.info}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* 우측 스크롤 버튼 */}
            <button
              onClick={() => scroll('right')}
              className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-3 z-10 w-10 h-10 bg-white dark:bg-gray-800 rounded-full shadow-md flex items-center justify-center hover:shadow-lg dark:hover:bg-gray-700 dark:border dark:border-gray-700 transition-all cursor-pointer hidden md:flex"
              aria-label="다음 후기"
            >
              <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        </AnimateOnScroll>
      )}

      {/* 모바일 스크롤 안내 — 후기가 있을 때만 표시 */}
      {testimonials.length > 0 && (
        <p className="text-center text-sm text-gray-400 mt-4 md:hidden">
          좌우로 밀어서 더 많은 후기를 확인하세요
        </p>
      )}

      {/* 네이버 플레이스 리뷰 링크 — URL이 있을 때만 표시 */}
      {naverPlaceUrl && (
        <div className="text-center mt-6">
          <a
            href={naverPlaceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-green-500 text-white px-6 py-3 rounded-xl font-bold hover:bg-green-600 transition text-sm"
          >
            <FontFreeIcon name="open_in_new" size={18} />
            네이버 플레이스에서 더 많은 후기 보기
          </a>
        </div>
      )}
    </SectionLayout>
  );
}
