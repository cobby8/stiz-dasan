"use client";

import { useEffect } from "react";

export default function StaffError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("교사용 앱 화면 오류", error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[60dvh] max-w-lg items-center px-4 py-8">
      <section className="w-full rounded-2xl border border-[var(--color-academy-line)] bg-white p-6 text-center shadow-sm">
        <span aria-hidden="true" className="material-symbols-outlined text-5xl text-[var(--brand-accent)]">wifi_off</span>
        <h1 className="mt-3 text-xl font-black">화면을 불러오지 못했습니다</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--color-academy-muted)]">네트워크 연결을 확인한 뒤 다시 시도해 주세요. 작성 중인 수업 기록은 현재 화면을 닫기 전에 확인해 주세요.</p>
        <button type="button" onClick={reset} className="mt-5 min-h-12 w-full rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)]">다시 시도</button>
      </section>
    </main>
  );
}
