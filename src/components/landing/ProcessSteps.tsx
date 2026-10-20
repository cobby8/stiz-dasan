/**
 * ProcessSteps — 수강 과정 4단계 시각화 (Phase 2 메인 랜딩)
 *
 * 상담 → 체험 → 등록 → 수업 4단계를 시각적으로 보여주는 섹션.
 * 학부모가 "어떻게 시작하면 되는지" 한눈에 파악할 수 있게 한다.
 * (클래스팅의 단계별 플로우 다이어그램 패턴 참고)
 *
 * 모바일: 세로 타임라인
 * 데스크탑: 가로 4열 배치 + 단계 사이 화살표
 *
 * SectionLayout + AnimateOnScroll 적용.
 */

import SectionLayout from '@/components/ui/SectionLayout';
import AnimateOnScroll from '@/components/ui/AnimateOnScroll';

// 각 단계 데이터 타입
interface Step {
  number: number;
  icon: string;
  title: string;
  description: string;
}

// 4단계 과정 데이터
const steps: Step[] = [
  {
    number: 1,
    icon: '📞',
    title: '전화 상담',
    description: '전화 또는 카카오톡으로 궁금한 점을 편하게 물어보세요',
  },
  {
    number: 2,
    icon: '🏃',
    title: '체험 수업',
    description: '실제 수업에 참여하여 분위기와 수업 방식을 직접 느껴보세요',
  },
  {
    number: 3,
    icon: '📝',
    title: '수강 등록',
    description: '아이에게 맞는 반과 시간을 선택하고 등록을 완료하세요',
  },
  {
    number: 4,
    icon: '🏀',
    title: '수업 시작',
    description: '전문 코치진과 함께 즐거운 농구 수업이 시작됩니다',
  },
];

export default function ProcessSteps() {
  return (
    <SectionLayout
      label="PROCESS"
      title="수강 시작은 이렇게 쉬워요"
      description="4단계만 거치면 우리 아이도 농구교실 학생이 됩니다"
      bgColor="white"
    >
      {/* 데스크탑: 가로 4열 배치 */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6 md:gap-4 relative">
        {steps.map((step, index) => (
          <AnimateOnScroll key={step.number} delay={index * 150}>
            <div className="flex flex-col items-center text-center relative">
              {/* 모바일 세로 연결선: 마지막 단계 제외 */}
              {index < steps.length - 1 && (
                <div className="absolute left-1/2 top-full w-px h-6 bg-gray-200 dark:bg-gray-700 md:hidden" />
              )}

              {/* 단계 번호 원 — 오렌지 배경으로 눈에 띄게 */}
              <div className="relative mb-4">
                <div className="w-16 h-16 rounded-full bg-brand-orange-500 dark:bg-brand-neon-lime text-white dark:text-brand-navy-900 flex items-center justify-center text-2xl font-black shadow-lg dark:shadow-brand-neon-lime/20">
                  {step.number}
                </div>
                {/* 아이콘 — 원의 오른쪽 상단에 작게 배치 */}
                <span className="absolute -top-1 -right-1 text-xl">
                  {step.icon}
                </span>
              </div>

              {/* 단계 제목 */}
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
                {step.title}
              </h3>

              {/* 단계 설명 */}
              <p className="text-base text-gray-500 dark:text-gray-400 leading-relaxed max-w-[220px]">
                {step.description}
              </p>

              {/* 데스크탑 가로 화살표: 마지막 단계 제외 */}
              {index < steps.length - 1 && (
                <div className="hidden md:block absolute top-8 -right-4 text-gray-300 dark:text-gray-500">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </div>
              )}
            </div>
          </AnimateOnScroll>
        ))}
      </div>
    </SectionLayout>
  );
}
