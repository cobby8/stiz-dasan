// 404 페이지 — 존재하지 않는 URL 접근 시 표시
// Next.js의 not-found.tsx는 서버 컴포넌트로 작동 가능

import Link from 'next/link';
import PublicSiteTheme from '@/components/PublicSiteTheme';

export const metadata = {
  title: '페이지를 찾을 수 없습니다 | STIZ 농구교실 다산2호점',
};

export default function NotFound() {
  return (
    // 공개 홈페이지와 같은 스포츠 색으로 맞춘다(옛 주황·형광 연두가 그대로 보이던 화면).
    <PublicSiteTheme publicScope>
    <div className="min-h-screen bg-[var(--color-public-paper)] flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        {/* 404 숫자 — 큰 글씨로 시각적 임팩트 */}
        <p className="text-8xl font-black text-brand-orange-500 dark:text-brand-neon-lime mb-2">404</p>

        {/* 농구 아이콘 */}
        <div className="mx-auto w-16 h-16 rounded-full bg-brand-orange-50 flex items-center justify-center mb-6">
          <span className="text-3xl" role="img" aria-label="농구공">
            🏀
          </span>
        </div>

        {/* 제목 + 설명 */}
        <h1 className="text-2xl font-black text-gray-900 dark:text-white mb-2 break-keep">
          페이지를 찾을 수 없습니다
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mb-8 break-keep">
          요청하신 페이지가 존재하지 않거나 이동되었습니다.
        </p>

        {/* 홈으로 돌아가기 — 이 화면의 유일한 행동이라 주인공 버튼(게슈탈트 C-P1) */}
        <Link
          href="/"
          className="public-btn-primary px-6"
        >
          홈으로 돌아가기
        </Link>
      </div>
    </div>
    </PublicSiteTheme>
  );
}
