"use client";

import Link from "next/link";
import { useEffect } from "react";
import { classifyStaffFailure, staffReloginHref } from "@/lib/staff-session-rules";

// 오류 종류마다 문구·버튼을 다르게 보인다(2026-11-13 b5).
// 예전엔 무엇이든 «네트워크 연결을 확인» 한 가지라, 로그인이 풀린 선생님이 와이파이만 껐다 켰다 했다.
const COPY = {
  login: {
    icon: "lock",
    title: "로그인이 풀렸습니다",
    body: "다시 로그인하면 보던 화면으로 돌아옵니다.",
  },
  forbidden: {
    icon: "block",
    title: "이 화면을 볼 수 있는 권한이 없습니다",
    body: "담당 수업이 아니거나 계정 권한이 바뀌었을 수 있습니다. 원장님께 문의해 주세요.",
  },
  network: {
    icon: "wifi_off",
    title: "인터넷 연결이 끊겼습니다",
    body: "연결을 확인한 뒤 다시 시도해 주세요. 작성 중인 수업 기록은 현재 화면을 닫기 전에 확인해 주세요.",
  },
  other: {
    icon: "error",
    title: "화면을 불러오지 못했습니다",
    body: "잠시 후 다시 시도해 주세요. 계속되면 원장님께 알려 주세요.",
  },
} as const;

export default function StaffError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("교사용 앱 화면 오류", error);
  }, [error]);

  // 운영 빌드에서는 서버 오류 문구가 가려져 올 수 있다 — 그때 휴대폰이 오프라인이면 연결 문제로 본다.
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  const kind = offline ? "network" : classifyStaffFailure(error?.message);
  const copy = COPY[kind];

  function relogin() {
    window.location.assign(staffReloginHref(`${window.location.pathname}${window.location.search}`));
  }

  return (
    <main className="mx-auto flex min-h-[60dvh] max-w-lg items-center px-4 py-8">
      <section className="w-full rounded-2xl border border-[var(--color-academy-line)] bg-white p-6 text-center shadow-sm">
        <span aria-hidden="true" className="material-symbols-outlined text-5xl text-[var(--brand-accent)]">{copy.icon}</span>
        <h1 className="mt-3 text-xl font-black">{copy.title}</h1>
        <p className="mt-2 text-sm leading-6 text-[var(--color-academy-muted)]">{copy.body}</p>
        {kind === "login" ? (
          <button type="button" onClick={relogin} className="mt-5 min-h-12 w-full rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)]">다시 로그인</button>
        ) : kind === "forbidden" ? (
          <Link href="/staff" className="mt-5 flex min-h-12 w-full items-center justify-center rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)]">처음 화면으로</Link>
        ) : (
          <button type="button" onClick={reset} className="mt-5 min-h-12 w-full rounded-xl bg-[var(--brand-accent)] font-black text-[var(--brand-accent-contrast)]">다시 시도</button>
        )}
      </section>
    </main>
  );
}
