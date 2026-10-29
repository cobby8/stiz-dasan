'use client';

// Next.js 전역 에러 바운더리 — 예상치 못한 오류 발생 시 사용자에게 보여주는 페이지
// 'use client' 필수: Next.js error boundary는 클라이언트 컴포넌트여야 한다

import Link from 'next/link';
import { useEffect } from 'react';
import PublicSiteTheme from '@/components/PublicSiteTheme';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void; // Next.js가 제공하는 에러 초기화 함수
}) {
  // 에러 발생 시 콘솔에 기록 (디버깅용)
  useEffect(() => {
    console.error('[GlobalError]', error);
  }, [error]);

  return (
    // 공개 홈페이지와 같은 스포츠 색으로 맞춘다(옛 주황·형광 연두가 그대로 보이던 화면).
    <PublicSiteTheme publicScope>
    <div className="min-h-screen bg-[var(--color-public-paper)] flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        {/* 농구 아이콘 — 큰 원형 배경 */}
        <div className="mx-auto w-24 h-24 rounded-full bg-brand-orange-50 flex items-center justify-center mb-6">
          <span className="text-5xl" role="img" aria-label="농구공">
            🏀
          </span>
        </div>

        {/* 제목 + 설명 */}
        <h1 className="text-2xl font-black text-gray-900 dark:text-white mb-2 break-keep">
          일시적인 문제가 발생했습니다
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mb-2 break-keep">
          페이지를 불러오는 중 오류가 발생했습니다.
        </p>
        <p className="text-gray-500 dark:text-gray-400 mb-8 break-keep">
          문제가 계속되면 학원으로 문의해 주세요.
        </p>

        {/* 액션 버튼 2개: 다시 시도 + 홈으로 */}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          {/* 다시 시도 — reset() 호출로 에러 바운더리 초기화 */}
          <button
            onClick={() => reset()}
            className="px-6 py-3 bg-brand-orange-500 dark:bg-brand-neon-lime dark:text-brand-navy-900 hover:bg-brand-orange-600 dark:hover:opacity-90 text-white font-bold rounded-xl transition-colors"
          >
            다시 시도
          </button>

          {/* 홈으로 돌아가기 */}
          <Link
            href="/"
            className="px-6 py-3 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 text-gray-700 dark:text-gray-200 font-bold rounded-xl transition-colors"
          >
            홈으로 돌아가기
          </Link>
        </div>
      </div>
    </div>
    </PublicSiteTheme>
  );
}
