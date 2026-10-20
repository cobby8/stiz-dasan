/**
 * TrustBadges — 신뢰 지표 바 (Phase 2 메인 랜딩)
 *
 * 학원의 핵심 숫자 지표를 보여주는 섹션.
 * 학부모가 "여기 제대로 된 곳이다"라고 느끼게 하는 역할.
 * (김과외/Brightwheel 패턴 참고)
 *
 * 숫자는 현재 하드코딩이지만, props로 받으므로 향후 DB 연동 가능.
 * AnimateOnScroll로 스크롤 시 순차적으로 나타나는 효과 적용.
 */

import AnimateOnScroll from '@/components/ui/AnimateOnScroll';

// 각 지표 항목의 타입 정의
interface TrustItem {
  icon: string;    // 이모지 아이콘
  value: string;   // 숫자 값 (예: "3년+")
  label: string;   // 설명 라벨 (예: "운영 기간")
}

interface TrustBadgesProps {
  // 외부에서 지표 데이터를 전달할 수 있지만, 기본값도 제공
  items?: TrustItem[];
}

// 기본 신뢰 지표 데이터 — 하드코딩 (향후 DB 연동 시 props로 대체)
const defaultItems: TrustItem[] = [
  { icon: '🏀', value: 'Since 2021', label: '운영 기간' },
  { icon: '👨‍👩‍👧‍👦', value: '2,000+', label: '누적 수강생' },
  { icon: '⭐', value: '90% ↑', label: '체험수업 등록률' },
  { icon: '🏆', value: '5명+', label: '전문 코치진' },
];

export default function TrustBadges({ items = defaultItems }: TrustBadgesProps) {
  return (
    // 네이비 배경으로 신뢰감 있는 느낌, 메인 히어로 바로 아래에 위치
    <section className="bg-brand-navy-900 dark:bg-black py-10 md:py-14 transition-colors duration-300">
      <div className="max-w-6xl mx-auto px-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
          {items.map((item, index) => (
            // 각 지표마다 delay를 줘서 순차적으로 나타나는 효과
            <AnimateOnScroll key={index} delay={index * 100}>
              <div className="text-center">
                {/* 이모지 아이콘 — 큰 사이즈로 눈에 띄게 */}
                <div className="text-4xl mb-3">{item.icon}</div>
                {/* 숫자 값 — 크고 굵게, 오렌지 색상으로 강조 */}
                <div className="text-3xl md:text-4xl font-black text-white mb-1">
                  {item.value}
                </div>
                {/* 설명 라벨 — 회색 톤으로 보조 정보 */}
                <div className="text-sm text-blue-200 font-medium">
                  {item.label}
                </div>
              </div>
            </AnimateOnScroll>
          ))}
        </div>
      </div>
    </section>
  );
}
