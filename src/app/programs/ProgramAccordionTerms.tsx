"use client";

import Card from "@/components/ui/Card";

/**
 * ProgramAccordionTerms — 이용약관 표시 컴포넌트
 *
 * 항상 펼쳐진 상태로 표시. 환불, 보강 등 중요 키워드가 포함된 줄은
 * 자동으로 강조 표시하여 가독성을 높인다.
 */

// 중요 표시할 키워드 목록 — 이 키워드가 포함된 줄은 강조됨
const IMPORTANT_KEYWORDS = [
  "환불",
  "환급",
  "취소",
  "보강",
  "보충",
  "위약금",
  "손해배상",
  "개인정보",
  "안전",
  "사고",
  "부상",
  "보험",
  "책임",
];

/**
 * 텍스트 한 줄이 중요 키워드를 포함하는지 확인
 */
function isImportantLine(line: string): boolean {
  return IMPORTANT_KEYWORDS.some((keyword) => line.includes(keyword));
}

export default function ProgramAccordionTerms({
  termsText,
  hideHeader = false,
}: {
  termsText: string | null;
  // hideHeader — true이면 "이용약관" 헤더(아이콘+제목)를 숨긴다. 독립 페이지에서는 히어로가 제목 역할을 하므로 중복 방지용.
  hideHeader?: boolean;
}) {
  if (!termsText) return null;

  // 줄 단위로 분리하여 중요 여부를 판별
  const lines = termsText.split("\n");

  return (
    <Card variant="default" className="!p-0 overflow-hidden [&>div]:p-0">
      {/* 헤더 — hideHeader가 false일 때만 표시 */}
      {!hideHeader && (
        <div className="py-5 px-6 border-b border-gray-100 dark:border-gray-800 flex items-center gap-3">
          <h3 className="font-bold text-gray-900 dark:text-white text-xl">이용약관</h3>
        </div>
      )}

      {/* 약관 본문 — 항상 표시, 줄별 중요 강조 */}
      <div className="px-6 py-6">
        <div className="space-y-1">
          {lines.map((line, i) => {
            const trimmed = line.trim();

            // 빈 줄은 여백으로 처리
            if (!trimmed) {
              return <div key={i} className="h-3" />;
            }

            const important = isImportantLine(trimmed);

            // 중요 줄: 강조 배경 + 아이콘
            if (important) {
              return (
                <div
                  key={i}
                  className="flex items-start gap-2 bg-amber-50 dark:bg-brand-neon-lime/10 border-l-4 border-amber-400 dark:border-brand-neon-lime rounded-r-lg px-4 py-2.5 -mx-1 transition-colors"
                >
                  <span
                    aria-hidden="true"
                    className="text-amber-500 dark:text-brand-neon-lime shrink-0 mt-0.5 font-bold"
                  >
                    !
                  </span>
                  <p className="text-gray-800 dark:text-gray-100 text-base leading-relaxed font-medium">
                    {trimmed}
                  </p>
                </div>
              );
            }

            // 일반 줄
            return (
              <p
                key={i}
                className="text-gray-600 dark:text-gray-300 text-base leading-relaxed pl-1"
              >
                {trimmed}
              </p>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
