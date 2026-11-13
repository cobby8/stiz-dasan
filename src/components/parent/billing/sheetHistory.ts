// 청구 세부 시트의 «뒤로가기 = 닫기» 기록 칸 관리 — React·DOM 없이 실행 테스트할 수 있게 떼어 냈다
// (tests/parent-month-bills.test.mjs 가 가짜 history 로 돌린다)
//
// 규칙: 시트를 열면 같은 주소로 기록 한 칸을 넣고, 어떤 길로 닫히든 그 칸을 «정확히 한 번» 되돌린다.
//  - 닫기·Esc·바깥 누르기 → history.back() → popstate 에서 닫힘
//  - 휴대폰 뒤로가기 → popstate 에서 닫힘(칸은 이미 빠짐)
//  - 시트 안 링크(결제하기 등) → 칸을 먼저 되돌린 뒤 그 주소로 이동(돌아왔을 때 헛걸음 칸이 없게)
//  - 시트가 저절로 사라짐(열린 달이 목록에서 없어짐 등) → 정리 단계에서 남은 칸을 되돌림
// ★ 칸이 남았는지는 history.state 표시가 아니라 이 함수가 기억한다 — Next 16 router.refresh() 가 기록 상태를 갈아 끼워
//   표시(billSheet)가 지워지기 때문(2026-11-14 검수).

export type SheetHistoryWindow = {
  history: { state: unknown; pushState: (data: unknown, unused: string, url?: string) => void; back: () => void };
  location: { href: string };
  addEventListener: (type: "popstate", listener: () => void) => void;
  removeEventListener: (type: "popstate", listener: () => void) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
};

// 정리 단계에서 남긴 칸 — 개발 모드(StrictMode)는 붙였다 떼었다 다시 붙이므로, 곧바로 되돌리지 않고
// 다음 순간까지 기다렸다가 아무도 다시 쓰지 않으면 그때 되돌린다(다시 붙으면 그 칸을 그대로 이어 쓴다).
let leftoverEntry = false;

export function attachSheetHistory(win: SheetHistoryWindow, handlers: { onClose: () => void; navigate: (href: string) => void }) {
  let pushed = true;
  if (leftoverEntry) {
    leftoverEntry = false; // 방금 떼어 낸 시트의 칸을 이어 쓴다(새 칸을 또 넣지 않는다)
  } else {
    const state = typeof win.history.state === "object" && win.history.state ? win.history.state : {};
    win.history.pushState({ ...(state as Record<string, unknown>), billSheet: true }, "", win.location.href);
  }
  let pendingHref: string | null = null;

  const onPop = () => {
    if (!pushed) return;
    pushed = false;
    const href = pendingHref;
    pendingHref = null;
    handlers.onClose();
    if (href) handlers.navigate(href);
  };
  win.addEventListener("popstate", onPop);

  return {
    /** 닫기 버튼·Esc·바깥 누르기 */
    requestClose() {
      if (pushed) win.history.back();
      else handlers.onClose();
    },
    /** 시트 안 링크로 떠날 때 — 칸을 먼저 되돌리고 이동 */
    leaveTo(href: string) {
      if (pendingHref) return; // 결제하기 두 번 빠르게 누름 — back() 이 두 번 돌아 학부모 화면 밖으로 나가지 않게
      if (!pushed) {
        handlers.navigate(href);
        return;
      }
      pendingHref = href;
      win.history.back();
      // 안전장치(토스 심사 중 — «결제하기»가 멈추면 안 된다): 일부 웹뷰에서 popstate 가 안 오면 0.4초 뒤 그대로 이동
      win.setTimeout(() => {
        if (pendingHref !== href) return; // popstate 에서 이미 이동함
        pendingHref = null;
        pushed = false;
        handlers.onClose();
        handlers.navigate(href);
      }, 400);
    },
    /** 시트가 사라질 때(정리 단계) */
    detach() {
      win.removeEventListener("popstate", onPop);
      if (!pushed) return;
      pushed = false;
      leftoverEntry = true;
      win.setTimeout(() => {
        if (!leftoverEntry) return; // 다시 붙은 시트가 이어 쓰는 중
        leftoverEntry = false;
        win.history.back();
      }, 0);
    },
  };
}

/** 테스트용 — 모듈 상태 초기화 */
export function resetSheetHistoryForTest() {
  leftoverEntry = false;
}
