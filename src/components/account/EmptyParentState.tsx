"use client";

import Link from "next/link";
import { useInstalledApp } from "@/components/pwa/useInstalledApp";
import { useEffect, useState } from "react";
import type { PendingSeasonalChild } from "@/lib/seasonal/pendingSeasonalChildren";
import { childLinkRequest, isChildLinkState, type ChildLinkState } from "./child-link-api";

export default function EmptyParentState({ pendingSeasonalChildren }: { pendingSeasonalChildren: PendingSeasonalChild[] }) {
  const installed = useInstalledApp();
  const [state, setState] = useState<ChildLinkState | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    childLinkRequest(undefined, controller.signal).then((data) => {
      if (!isChildLinkState(data)) throw new Error("연결 정보를 확인하지 못했습니다. 다시 시도해 주세요.");
      setState(data);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "연결 정보를 확인하지 못했습니다.");
    });
    return () => controller.abort();
  }, [attempt]);
  const pending = state?.outgoing.filter((row) => row.status === "PENDING").length ?? 0;
  const incoming = state?.incoming.filter((row) => row.status === "PENDING").length ?? 0;
  return (
    <div className="mx-auto grid max-w-2xl gap-4 py-3">
      <section className="academy-panel p-4 sm:p-5" aria-labelledby="parent-empty-title">
        <h1 id="parent-empty-title" className="academy-heading">우리 가족의 수업을 연결해 주세요</h1>
        <p className="mt-2 text-sm text-[var(--color-academy-muted)]">이미 다니고 있다면 등록된 보호자 번호로 본인인증해 주세요. 연결된 자녀의 수업·출결·납부 정보를 확인할 수 있습니다.</p>
        <Link href="/mypage/children" className="academy-button-primary mt-4">본인인증·자녀 연결</Link>
        {pending > 0 && <p role="status" className="mt-3 text-sm">가족 확인을 기다리는 요청 {pending}건이 있습니다. 승인 전에는 자녀 정보가 표시되지 않습니다.</p>}
        {incoming > 0 && <Link href="/mypage/children" className="mt-3 block text-sm font-bold underline">가족 연결 요청 {incoming}건 확인</Link>}
        {error && <div className="mt-3 text-sm"><p role="alert">{error}</p><button type="button" onClick={() => { setError(""); setAttempt((value) => value + 1); }} className="academy-button-secondary mt-2">다시 확인</button></div>}
      </section>
      {pendingSeasonalChildren.length > 0 && <section className="academy-panel p-4" aria-labelledby="seasonal-pending-title">
        <h2 id="seasonal-pending-title" className="academy-section-title">방학특강 신청 내역</h2>
        <ul className="mt-2 divide-y divide-[var(--color-academy-line)]">{pendingSeasonalChildren.map((child, index) => <li key={`${child.childName}-${index}`} className="py-2 text-sm"><b>{child.childName}</b><span className="ml-2 text-[var(--color-academy-muted)]">{child.offeringTitles.join(" · ")}</span><p className="mt-1 text-xs">학생 등록 대기 · 예정 수업 {child.upcomingCount}회</p></li>)}</ul>
        <Link href="/mypage/seasonal" className="academy-button-secondary mt-2">특강 내역 보기</Link>
      </section>}
      <section className="academy-panel p-4" aria-labelledby="new-enrollment-title">
        <h2 id="new-enrollment-title" className="academy-section-title">처음 오셨나요?</h2>
        <div className="mt-3 flex flex-wrap gap-2"><Link href="/apply/enroll" target={installed ? "_blank" : undefined} rel={installed ? "noopener" : undefined} className="academy-button-primary">수강 신청하기</Link><Link href="/apply/trial" target={installed ? "_blank" : undefined} rel={installed ? "noopener" : undefined} className="academy-button-secondary">체험 수업 신청</Link></div>
        {installed && <p className="mt-2 text-xs text-[var(--color-academy-muted)]">신청 화면은 브라우저에서 열립니다. 신청 후에는 스티즈 앱 아이콘을 눌러 돌아와 주세요.</p>}
        <p className="mt-3 text-xs text-[var(--color-academy-muted)]">등록 내용이 다르거나 연결에 어려움이 있으면 <a className="underline" href="tel:07088245712">학원에 문의해 주세요.</a></p>
      </section>
    </div>
  );
}
