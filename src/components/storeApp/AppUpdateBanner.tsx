"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { appUpdateSnoozeKey, isAppUpdateSnoozed, shouldHideAppUpdateBanner, type StoreAppLatest } from "@/lib/storeApp";
import { useAppUpdateNotice } from "@/components/storeApp/useAppUpdateNotice";
// 선생님 홈의 «수업 중» 표시(<html data-staff-live-lesson>) — 읽기만 한다
import { isStaffLiveLessonOpen, subscribeStaffLiveLesson } from "@/app/staff/staffNavigation";

/**
 * 스토어 앱 안에서 «새 버전이 나왔어요 [업데이트]» 한 줄(2026-11-15 원장 지시).
 *
 * - 서버(루트 레이아웃)는 아무것도 읽지 않는다. 화면이 뜬 뒤 «앱 안»일 때만 최신 버전을 한 번 물어본다(useAppUpdateNotice).
 *   그래서 서버가 그린 첫 화면에는 배너가 없고, 브라우저 사용자에게는 요청도 배너도 없다.
 * - 판정은 @/lib/storeApp 의 appUpdateNotice 한 곳(설정 «앱 정보»와 같은 훅).
 * - «업데이트»는 사용자가 직접 누르는 https 링크다 — 앱은 그런 링크만 바깥(스토어)으로 연다. 자동 이동은 하지 않는다.
 * - 화면 맨 위 «흐름 안» 한 줄이라(고정 띠 아님) 각 화면의 머리줄과 겹치지 않는다.
 * - 색은 학원 앱 토큰(.academy-app)으로 고정해 공개 화면(밝음·어두움) 위에서도 같은 모양으로 읽힌다.
 */
export default function AppUpdateBanner({ requiredMin = null }: { requiredMin?: Partial<StoreAppLatest> | null }) {
  const pathname = usePathname() || "/";
  // 선생님 홈에서 진행 중 수업 칸이 펼쳐져 있으면 숨긴다(서버 그림에서는 «아님»)
  const liveLesson = useSyncExternalStore(subscribeStaffLiveLesson, isStaffLiveLessonOpen, () => false);
  // 판정 전·브라우저는 null/none — 아무것도 그리지 않는다
  const notice = useAppUpdateNotice(requiredMin);
  // 판정이 나오기 전에는 «숨김»으로 시작해, «나중에»를 누른 사람에게 배너가 깜빡 보이지 않게 한다
  const [snoozed, setSnoozed] = useState(true);

  const latestVersion = notice?.latestVersion ?? "";
  useEffect(() => {
    if (!latestVersion) return;
    // «나중에»를 누른 지 3일이 안 됐으면 숨긴다(기기별 저장 — 못 읽으면 그냥 보인다)
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(appUpdateSnoozeKey(latestVersion));
    } catch {
      // 저장소를 못 쓰는 환경(사생활 보호 모드 등)
    }
    setSnoozed(isAppUpdateSnoozed(stored, Date.now()));
  }, [latestVersion]);

  const visible = notice !== null && notice.level !== "none"
    // 꼭 올려야 하는 업데이트(required)는 «나중에»가 없다
    && !(snoozed && notice.level !== "required")
    && !liveLesson && !shouldHideAppUpdateBanner(pathname);

  // 배너가 떠 있는 동안 <html> 에 표시를 단다 — 배너가 위쪽 안전영역(노치) 여백을 이미 먹었으므로,
  // 바로 아래 머리줄이 같은 여백을 또 먹지 않게 globals.css 가 이 표시를 보고 머리줄 여백을 줄인다.
  useEffect(() => {
    if (!visible) return;
    document.documentElement.dataset.appUpdateBanner = "1";
    return () => { delete document.documentElement.dataset.appUpdateBanner; };
  }, [visible]);

  if (!visible || !notice) return null;

  function later() {
    if (!notice) return;
    try {
      window.localStorage.setItem(appUpdateSnoozeKey(notice.latestVersion), String(Date.now()));
    } catch {
      // 저장하지 못해도 이번 화면에서는 숨긴다
    }
    setSnoozed(true);
  }

  const message =
    notice.level === "legacyApp"
      // 옛 앱(1.0)은 바깥 주소를 못 연다 — 눌러도 안 열리는 버튼 대신 글자로만 안내한다
      ? "스토어에서 앱을 업데이트해 주세요"
      : notice.level === "required"
        ? `새 버전(${notice.latestVersion})으로 업데이트해 주세요`
        : `새 버전(${notice.latestVersion})이 나왔어요`;

  return (
    <div className="academy-app" data-app-update-banner={notice.level}>
      <div
        role="status"
        className="border-b border-[var(--color-academy-line)] bg-[var(--color-academy-surface)] pt-[env(safe-area-inset-top)]"
      >
        <div className="mx-auto flex min-h-11 max-w-2xl items-center gap-1 pl-4 pr-1 text-sm">
          <p className="min-w-0 flex-1 truncate font-medium text-[var(--color-academy-ink)]">{message}</p>
          {notice.level !== "legacyApp" && notice.storeUrl ? (
            <a
              href={notice.storeUrl}
              className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-3 font-semibold text-[var(--color-academy-primary)] underline-offset-4 hover:underline"
            >
              업데이트
            </a>
          ) : null}
          {notice.level !== "required" ? (
            <button
              type="button"
              onClick={later}
              className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-3 font-medium text-[var(--color-academy-muted)]"
            >
              나중에
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
