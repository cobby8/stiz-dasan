import type { ReactNode } from "react";

// 방학특강 섹션 공통 상단 헤더.
// 상태(useState)나 훅을 전혀 쓰지 않는 "순수 표시용" 컴포넌트라서
// "use client"를 붙이지 않았다. 그래야 서버 페이지(attendance/shuttle)에서도,
// 클라이언트 컴포넌트(SeasonalAdminClient) 안에서도 그대로 끼워 쓸 수 있다.
//
// action = 우측에 붙일 버튼 슬롯. 신청·반 관리 페이지에서만 "새 시즌 만들기"를 넘긴다.
// eyebrow/title/subtitle을 넘기면 그 값으로 표시한다. 안 넘기면 기존 '방학특강 운영' 그대로.
// (셔틀 관리 메뉴처럼 방학특강과 분리된 섹션은 자기 제목을 넘겨 쓴다.)
export default function SeasonalHeader({ action, eyebrow = "SEASONAL PROGRAM", title = "방학특강 운영", subtitle }: {
  action?: ReactNode; eyebrow?: string; title?: string; subtitle?: string;
}) {
  return (
    // 컨테이너 폭은 바로 아래 탭 바(SeasonalSectionTabs)와 동일하게 맞춘다 → 좌우 정렬이 어긋나지 않는다.
    <div className="mx-auto max-w-6xl px-4">
      {/* 모바일은 세로 쌓기(flex-col), 640px 이상에서만 제목/버튼을 좌우로 배치 → 좁은 화면에서 겹치거나 잘리지 않는다. */}
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div className="min-w-0">
          {/* 브랜드 오렌지는 하드코딩하지 않고 CSS 변수 사용 → 다크모드에서 자동으로 네온 라임으로 바뀐다. */}
          <p className="text-sm font-bold uppercase tracking-wide text-[var(--brand-accent)]">{eyebrow}</p>
          <h1 className="mt-1 text-2xl font-black text-gray-950 dark:text-white sm:text-3xl">{title}</h1>
          {subtitle && <p className="mt-2 break-keep text-sm text-gray-500 dark:text-gray-400">
            {subtitle}
          </p>}
        </div>
        {/* action이 없으면 빈 div도 만들지 않는다(불필요한 여백 방지). */}
        {action ? <div className="flex shrink-0 flex-wrap gap-2">{action}</div> : null}
      </header>
    </div>
  );
}
