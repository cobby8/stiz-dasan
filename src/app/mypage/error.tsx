"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { AUTO_RETRY_DELAY_MS, claimAutoRetry } from "@/lib/mypage/errorAutoRetry";

/**
 * 학부모 화면 오류 안내(d1, 2026-11-13).
 *
 * 왜: 이 파일이 없으면 마이페이지 안에서 오류가 나면 사이트 전체 오류 화면으로 바뀌어
 * 하단 탭·머리줄까지 사라지고, 학부모가 어디로 돌아가야 할지 모른다.
 * error.tsx 는 /mypage 레이아웃 «안쪽»에 그려지므로 하단 탭·알림 종은 그대로 남는다.
 *
 * 2026-11-14: 순간 끊김 하나로 오류 안내가 뜬 일이 있어, 오류 직후 1초 뒤 «자동으로 한 번» 다시 불러온다.
 * 같은 화면은 1분 안에 한 번만(claimAutoRetry — 무한 반복 금지). 그래도 실패하면 아래 안내 그대로.
 * 오류 원문은 화면에 띄우지 않는다(확인 번호만).
 */
export default function MyPageError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname() || "/mypage";
  const [retrying, startTransition] = useTransition();
  // 처음엔 «다시 불러오는 중» 한 줄 — 자동 재시도를 할지 화면에 붙은 뒤(sessionStorage) 정한다
  const [autoRetrying, setAutoRetrying] = useState(true);

  // 최신 router·reset 을 담아 둔다 — 효과(useEffect)가 이 둘의 바뀜으로 다시 돌면 1회 판정이 두 번 소모된다
  const latest = useRef({ router, reset });
  useEffect(() => {
    latest.current = { router, reset };
  });
  // 이 오류에 대해 내린 판정(같은 오류로 효과가 다시 돌아도 — 개발 모드 이중 실행 등 — 판정을 다시 소모하지 않게)
  const decided = useRef<{ error: unknown; retry: boolean } | null>(null);

  useEffect(() => {
    if (decided.current?.error !== error) {
      console.error("[mypage] 화면을 불러오지 못했습니다.", error);
      let storage: Storage | null = null;
      try {
        storage = window.sessionStorage;
      } catch {
        storage = null;
      }
      decided.current = { error, retry: claimAutoRetry(storage, pathname, Date.now()) };
    }
    const retry = decided.current.retry;
    // 상태 변경은 타이머 안에서만 한다(효과 안에서 바로 setState 하면 화면이 한 번 더 그려진다)
    const timer = window.setTimeout(() => {
      if (!retry) {
        // 이미 한 번 자동으로 다시 해 봤다 → 안내(다시 시도·홈으로)를 보인다
        setAutoRetrying(false);
        return;
      }
      // reset() 만 부르면 서버에서 실패한 화면은 같은 오류를 다시 그린다 → 서버 데이터를 새로 받고(refresh) 같이 다시 그린다
      startTransition(() => { latest.current.router.refresh(); latest.current.reset(); });
    }, retry ? AUTO_RETRY_DELAY_MS : 0);
    return () => window.clearTimeout(timer);
  }, [error, pathname]);

  if (autoRetrying) {
    return (
      <p role="status" className="my-6 text-center text-sm text-[var(--color-academy-muted)]">
        다시 불러오는 중
      </p>
    );
  }

  return (
    <section
      role="alert"
      aria-labelledby="mypage-error-title"
      className="mx-auto my-6 max-w-md rounded-2xl border border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] p-5 text-center shadow-sm"
    >
      <h1 id="mypage-error-title" className="academy-heading">
        화면을 불러오지 못했어요
      </h1>
      <p className="mt-1 text-sm leading-6 text-[var(--color-academy-muted)]">
        인터넷 연결이 잠시 불안정했을 수 있어요. 다시 시도해 주세요.
      </p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-center">
        {/* reset() 만 부르면 서버에서 실패한 화면은 같은 오류를 다시 그린다 → 서버 데이터를 새로 받고(refresh) 같이 다시 그린다 */}
        <button
          type="button"
          disabled={retrying}
          onClick={() => startTransition(() => { router.refresh(); reset(); })}
          className="academy-button-primary"
        >
          {retrying ? "다시 불러오는 중" : "다시 시도"}
        </button>
        <Link href="/mypage" className="academy-button-secondary">
          홈으로
        </Link>
      </div>
      {error.digest && (
        <p className="mt-3 text-xs text-[var(--color-academy-faint)]">확인 번호: {error.digest}</p>
      )}
    </section>
  );
}
