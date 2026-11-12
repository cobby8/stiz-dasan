"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * 학부모 화면 오류 안내(d1, 2026-11-13).
 *
 * 왜: 이 파일이 없으면 마이페이지 안에서 오류가 나면 사이트 전체 오류 화면으로 바뀌어
 * 하단 탭·머리줄까지 사라지고, 학부모가 어디로 돌아가야 할지 모른다.
 * error.tsx 는 /mypage 레이아웃 «안쪽»에 그려지므로 하단 탭·알림 종은 그대로 남는다.
 */
export default function MyPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[mypage] 화면을 불러오지 못했습니다.", error);
  }, [error]);

  return (
    <section
      role="alert"
      aria-labelledby="mypage-error-title"
      className="mx-auto my-6 max-w-md rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-5 text-center shadow-sm"
    >
      <span className="material-symbols-outlined leading-none text-[var(--color-academy-warning)]" style={{ fontSize: "32px" }} aria-hidden="true">
        wifi_off
      </span>
      <h1 id="mypage-error-title" className="mt-2 text-lg font-bold text-[var(--color-academy-ink)]">
        화면을 불러오지 못했어요
      </h1>
      <p className="mt-1 text-sm leading-6 text-[var(--color-academy-muted)]">
        인터넷 연결이 잠시 불안정했을 수 있어요. 다시 시도해 주세요.
      </p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
        <button type="button" onClick={reset} className="academy-button-primary min-h-11 px-5">
          <span className="material-symbols-outlined leading-none" style={{ fontSize: "18px" }} aria-hidden="true">refresh</span>
          다시 시도
        </button>
        <Link href="/mypage" className="academy-button-secondary min-h-11 px-5">
          홈으로
        </Link>
      </div>
      {error.digest && (
        <p className="mt-3 text-xs text-[var(--color-academy-faint)]">확인 번호: {error.digest}</p>
      )}
    </section>
  );
}
