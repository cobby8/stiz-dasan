"use client";

import { useAppUpdateNotice } from "@/components/storeApp/useAppUpdateNotice";

/**
 * 학부모 설정 «앱 정보 → 버전» 줄(2026-11-15). 버전 글자(«앱 1.0.2»)는 서버가 사용자 에이전트에서 읽어 넘긴다.
 * 스토어 최신 버전과 견준 결과는 화면이 뜬 뒤 붙는다(맨 위 배너와 같은 판정·같은 값):
 *   최신이면 «앱 1.0.3 · 최신 버전입니다», 더 새 버전이 있으면 «새 버전 1.0.3» + «업데이트» 버튼.
 * 서버가 스토어를 기다리지 않게 하려고 이 줄만 클라이언트 부품이다.
 */
export default function AppVersionRow({ appLabel }: { appLabel: string }) {
  const notice = useAppUpdateNotice();
  const needsUpdate = notice?.level === "recommended" || notice?.level === "required";
  const upToDate = notice?.level === "none" && notice.latestVersion !== "";

  return (
    <li className="flex min-h-12 w-full items-center gap-3 px-4 py-1.5 text-left text-sm">
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-[var(--color-academy-ink)]">버전</span>
        {/* 스토어에 더 새 버전이 있을 때만 한 줄 더 */}
        {needsUpdate && <span className="block text-xs tabular-nums text-[var(--color-academy-muted)]">새 버전 {notice.latestVersion}</span>}
      </span>
      <span className="shrink-0 tabular-nums text-[var(--color-academy-muted)]">{appLabel}{upToDate ? " · 최신 버전입니다" : ""}</span>
      {/* 사용자가 직접 누르는 https 스토어 링크 — 앱이 바깥(스토어)으로 연다. «휴대폰 알림» 줄의 업데이트 버튼과 같은 모양 */}
      {needsUpdate && notice.storeUrl && (
        <a href={notice.storeUrl} className="academy-button-secondary academy-button-sm shrink-0 whitespace-nowrap">업데이트</a>
      )}
    </li>
  );
}
