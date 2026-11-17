"use client";

import { useStoreAppLacks } from "@/components/storeApp/useStoreAppLacks";

/**
 * 마이페이지 «설치 안내» 줄 — 스토어 앱 안이면 그리지 않는다(이미 앱).
 * 조건은 이름 버튼 메뉴(StaffProfileMenu)와 같은 useStoreAppLacks("install") 하나다.
 * 앱인지는 화면이 뜬 뒤에야 알 수 있어 이 줄만 클라이언트 부품이다.
 */
export default function StaffInstallGuideRow() {
  const hideInstallGuide = useStoreAppLacks("install");
  if (hideInstallGuide) return null;
  return (
    <li>
      {/* 2026-11-17: 스토어 앱 설치 안내(/install) 하나로 — 기기를 보고 스토어로 바로 넘기는 주소라 보통 링크(a)로 연다 */}
      <a href="/install" className="flex min-h-12 w-full items-center gap-3 px-4 py-1.5 text-sm hover:bg-[var(--color-academy-soft)]">
        <span className="flex-1 font-medium text-[var(--color-academy-ink)]">앱 설치 안내</span>
        <span aria-hidden="true" className="shrink-0 text-[var(--color-academy-faint)]">›</span>
      </a>
    </li>
  );
}
