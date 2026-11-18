/**
 * 2026-11-15 원장 점검: 오늘 수업 홈에서 «진행 중 수업 칸»이 펼쳐져 있는 동안 아래 탭을 숨긴다(수업 주소에서 숨던 것과 같게).
 * 홈이 <html> 에 표시를 달고 신호를 보내면 아래 탭(StaffBottomNav)이 듣는다. 줄을 접거나·수업이 끝나거나·다른 화면으로 가면 푼다.
 */
export const STAFF_LIVE_LESSON_EVENT = "staff:live-lesson";

export function setStaffLiveLessonOpen(open: boolean) {
  if (open) document.documentElement.dataset.staffLiveLesson = "1";
  else delete document.documentElement.dataset.staffLiveLesson;
  window.dispatchEvent(new Event(STAFF_LIVE_LESSON_EVENT));
}

export function isStaffLiveLessonOpen() {
  return document.documentElement.dataset.staffLiveLesson === "1";
}

/** 아래 탭이 표시가 바뀔 때마다 다시 그리게 듣는다(useSyncExternalStore 용) */
export function subscribeStaffLiveLesson(onChange: () => void) {
  window.addEventListener(STAFF_LIVE_LESSON_EVENT, onChange);
  return () => window.removeEventListener(STAFF_LIVE_LESSON_EVENT, onChange);
}

/**
 * 메뉴에서 다른 화면으로 갈 때 «저장 후 이동» 확인을 거쳐야 하는가(순수 판단 — 2026-11-17 화면 이동 전수 조사).
 *
 * 왜: 2026-11-15 부터 수업은 선생님 홈(/staff)의 줄 안에서 진행한다. 예전 판정은 수업 주소(/staff/sessions/…)만 봐서
 * 홈에서 수업 중에 메뉴로 나가면 쓰던 메모를 저장하지 않고 그냥 떠났다.
 *  - 수업 주소: 늘 확인한다(예전과 같다).
 *  - 선생님 홈: 진행 중 수업 칸이 펼쳐져 있을 때만(<html> 의 «수업 중» 표시). 수업이 없으면 확인 창 없이 바로 간다.
 *  - 그 밖의 화면: 표시가 남아 있더라도 확인하지 않는다(저장할 수업 화면이 없다).
 */
export function shouldConfirmStaffLeave(pathname: string | null | undefined, liveLessonOpen: boolean): boolean {
  const path = String(pathname ?? "");
  if (path.startsWith("/staff/sessions/")) return true;
  return path === "/staff" && liveLessonOpen;
}

export type StaffNavigationPreparation = { ok: boolean; message?: string };

export function prepareStaffNavigation() {
  return new Promise<StaffNavigationPreparation>((resolve) => {
    const detail = { handled: false, complete: resolve };
    window.dispatchEvent(new CustomEvent("staff:prepare-navigation", { detail }));
    if (!detail.handled) resolve({ ok: true });
  });
}
