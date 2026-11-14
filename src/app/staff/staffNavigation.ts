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

export type StaffNavigationPreparation = { ok: boolean; message?: string };

export function prepareStaffNavigation() {
  return new Promise<StaffNavigationPreparation>((resolve) => {
    const detail = { handled: false, complete: resolve };
    window.dispatchEvent(new CustomEvent("staff:prepare-navigation", { detail }));
    if (!detail.handled) resolve({ ok: true });
  });
}
