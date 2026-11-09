"use client";

import Link from "next/link";
import { useEffect } from "react";
import FontFreeIcon from "@/components/ui/FontFreeIcon";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin] 화면을 불러오지 못했습니다.", error);
  }, [error]);

  return (
    <main className="flex min-h-[70vh] items-center justify-center px-4 py-12">
      <section
        className="w-full max-w-lg rounded-3xl border border-[var(--color-academy-line)] bg-white p-6 text-center shadow-sm sm:p-8"
        aria-labelledby="admin-error-title"
        role="alert"
      >
        <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--color-academy-warning-soft)] text-[var(--color-academy-warning)]">
          <FontFreeIcon name="error" size={30} />
        </span>
        <h1 id="admin-error-title" className="mt-5 text-2xl font-black text-[var(--color-academy-ink)]">
          관리자 화면을 불러오지 못했습니다
        </h1>
        <p className="mt-3 text-sm leading-6 text-[var(--color-academy-muted)]">
          잠시 연결이 불안정하거나 접근 권한을 확인하지 못했습니다. 입력하던 내용이 있다면
          그대로 둔 뒤 다시 시도해 주세요.
        </p>
        <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--color-academy-primary)] px-5 font-black text-[var(--color-academy-on-primary)]"
          >
            <FontFreeIcon name="sync" size={19} />
            다시 시도
          </button>
          <Link
            href="/admin"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--color-academy-line-input)] px-5 font-bold text-[var(--color-academy-muted)] hover:bg-[var(--color-academy-soft)]"
          >
            <FontFreeIcon name="home" size={19} />
            대시보드로 이동
          </Link>
        </div>
        {error.digest && (
          <p className="mt-5 text-xs text-[var(--color-academy-faint)]" aria-label="오류 확인 번호">
            확인 번호: {error.digest}
          </p>
        )}
      </section>
    </main>
  );
}
