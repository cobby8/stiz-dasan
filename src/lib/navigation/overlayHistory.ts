/**
 * 열린 창(하단 시트·메뉴·크게 보기·확인 창)을 휴대폰 «뒤로»로 닫기 — 공용 규칙(2026-11-17 원장 지시 «뒤로 가기 전수 조치»).
 *
 * 왜: 창이 열린 채 안드로이드 뒤로 버튼·밀어서 뒤로를 누르면, 창이 아니라 화면째 앞 화면으로 나갔다(입력하던 값도 사라짐).
 * 방법(사진 크게 보기 photoLightboxHistory 와 같은 방식 + 청구 시트 sheetHistory 의 «창 안 링크로 떠나기»):
 *  - 열 때 같은 주소로 기록 한 칸을 넣는다(표시 OVERLAY_HISTORY_MARK). 주소가 안 바뀌어 학부모 이동 기록(inAppHistory)엔 안 쌓인다.
 *  - «뒤로» = 그 칸이 빠지며 popstate → 창만 닫는다.
 *  - 닫기 버튼·Esc·바탕 누르기 = 맨 위가 아직 우리 칸이면 history.back() 으로 한 번 되돌린다(기록이 남지 않게).
 *  - 창 안 링크로 떠날 때(leaveTo) = 칸을 먼저 되돌린 뒤 이동한다. 되돌리기 전에 이동하면 back() 이 새 화면을 되돌려 버린다.
 *  - 맨 위가 우리 칸이 아니면(그사이 다른 화면으로 감) 되돌리지 않는다 — 남의 기록을 지우지 않는다.
 *  - 저장 중(isBlocked)인 창은 «뒤로»로 닫히지 않는다(2026-11-18 원장 결정 ②) — 빠진 칸을 같은 표시·같은 깊이로 다시 넣어
 *    창이 그대로 열려 있게 한다. 저장이 끝나면(isBlocked 가 false) 평소처럼 닫힌다. 닫기 버튼(release)은 막지 않는다.
 *    막힌 «뒤로»가 눌렸음을 알리는 onBlockedBack 으로 «닫기 전 확인»을 띄울 수 있다(확인을 거절해도 칸이 남아 있다).
 *  - 표시 다시 찍기(2026-11-18 검수 N-1): Next 는 router.refresh()·재검증 서버 액션 뒤 «지금 칸»의 state 를 표시 없이 덮어쓴다.
 *    표시가 지워진 칸을 떠나기 직전(위에 새 창이 칸을 넣기 직전 · 닫으며 back 하기 직전)에 주소가 같으면 표시를 다시 찍는다.
 *    안 찍으면 그 칸으로 돌아왔을 때 아래 창이 «내 칸이 빠졌다»로 잘못 알고 같이 닫힌다(지금 칸만 덮어쓰이므로 떠날 때만 찍으면 된다).
 *
 * ★ 이 파일은 다른 모듈을 import 하지 않는다(테스트가 가짜 window 로 그대로 실행한다).
 */

export const OVERLAY_HISTORY_MARK = "stizOverlay";

/** 그 기록 칸이 창이 넣은 칸이면 그 창의 깊이(1부터), 아니면 0 */
export function overlayDepthOf(state: unknown): number {
  if (!state || typeof state !== "object") return 0;
  const value = (state as Record<string, unknown>)[OVERLAY_HISTORY_MARK];
  return typeof value === "number" && value > 0 ? value : value === true ? 1 : 0;
}

export function isOverlayHistoryState(state: unknown): boolean {
  return overlayDepthOf(state) > 0;
}

export type OverlayHistoryWindow = {
  history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string): void;
    /** 표시 다시 찍기에만 쓴다 — 없으면(옛 대역) 건너뛴다 */
    replaceState?(data: unknown, unused: string): void;
    back(): void;
  };
  location: { readonly href: string };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
};

export type OverlayHistoryHandle = {
  /** 창이 닫혔다(어떤 길이든) — 남은 칸을 정리한다. 여러 번 불러도 한 번만 동작 */
  release(): void;
  /** 창 안 링크로 떠난다 — 칸을 먼저 되돌리고 navigate(href) */
  leaveTo(href: string, navigate: (href: string) => void): void;
};

/** 지금 열려 있는 창들(연 순서) — 겹친 창은 깊이로 구분한다(위 창부터 닫히게). 각 창의 깊이와 칸을 넣은 주소를 든다 */
type OpenOverlay = { depth: number; href: () => string };
const openOverlays: OpenOverlay[] = [];

/** 테스트용 */
export function resetOverlayHistoryForTest() {
  openOverlays.length = 0;
}

export type OverlayHistoryOptions = {
  /** true 를 돌려주는 동안(저장 중)엔 «뒤로»를 눌러도 닫지 않고 칸을 다시 넣는다 */
  isBlocked?: () => boolean;
  /** 막힌 «뒤로»가 눌렸다(칸은 이미 다시 넣었다) — «닫기 전 확인»을 띄우는 데 쓴다 */
  onBlockedBack?: () => void;
};

/** 지금 칸의 표시가 지워졌고(Next 가 덮어씀) 주소가 그 창이 칸을 넣은 주소 그대로면 표시를 다시 찍는다 */
function restampOverlayMark(win: OverlayHistoryWindow, depth: number, href: string) {
  try {
    const current = win.history.state;
    if (overlayDepthOf(current) > 0) return; // 표시가 살아 있다
    if (!href || win.location.href !== href) return; // 다른 화면의 칸 — 남의 칸에 찍지 않는다
    if (typeof win.history.replaceState !== "function") return;
    const state = current && typeof current === "object" ? (current as Record<string, unknown>) : {};
    win.history.replaceState({ ...state, [OVERLAY_HISTORY_MARK]: depth }, "");
  } catch {
    // 못 찍으면 예전 동작 그대로
  }
}

/** 창을 열 때 부른다. onBack = «뒤로»로 닫혔을 때 부를 함수(부르는 쪽이 닫힘 상태로 바꾼다) */
export function bindOverlayToHistory(
  win: OverlayHistoryWindow,
  onBack: () => void,
  options?: OverlayHistoryOptions,
): OverlayHistoryHandle {
  let pushed = false;
  let counted = false;
  let leaving: string | null = null;
  const depth = openOverlays.length + 1;
  // 아래 창의 칸(지금 칸)을 떠나기 직전 — 표시가 지워졌으면 다시 찍어 둔다(돌아왔을 때 아래 창이 닫히지 않게)
  const below = openOverlays[openOverlays.length - 1];
  if (below) restampOverlayMark(win, below.depth, below.href());
  const record: OpenOverlay = { depth, href: () => pushedHref };
  // 칸을 넣을 때의 주소 — 창이 열린 동안 router.refresh()·서버 액션이 칸을 표시 없이 덮어써도(Next 의 replaceState)
  // 주소가 그대로면 아직 우리 칸으로 본다(2026-11-17 검수: 저장 뒤 «닫기»로 닫으면 칸이 남아 뒤로가 한 번 헛돌았다)
  let pushedHref = "";
  try {
    const state = win.history.state && typeof win.history.state === "object" ? (win.history.state as Record<string, unknown>) : {};
    win.history.pushState({ ...state, [OVERLAY_HISTORY_MARK]: depth }, "");
    pushed = true;
    pushedHref = win.location.href;
    openOverlays.push(record);
    counted = true;
  } catch {
    pushed = false; // 기록을 못 넣으면 옛 동작(버튼으로만 닫기)
  }
  const uncount = () => {
    if (!counted) return;
    counted = false;
    const at = openOverlays.indexOf(record);
    if (at >= 0) openOverlays.splice(at, 1);
  };
  /** 맨 위 칸이 아직 우리 칸인가 */
  const ownsTop = () => {
    if (!pushed) return false;
    const top = overlayDepthOf(win.history.state);
    if (top > 0) return top >= depth;
    try {
      return win.location.href === pushedHref;
    } catch {
      return false;
    }
  };
  let navigateAfter: (href: string) => void = () => {};
  const onPop = () => {
    if (!pushed) return;
    // 돌아온 칸이 나와 같거나 더 깊은 창의 칸이면 아직 내 칸이 남아 있다(개발 모드 이중 실행·위 창만 닫힘)
    if (overlayDepthOf(win.history.state) >= depth) return;
    // 저장 중 — 닫지 않는다. 방금 빠진 칸을 같은 표시·같은 깊이로 다시 넣어 창·열린 창 수·감시를 그대로 둔다
    if (!leaving && options?.isBlocked?.()) {
      let repushed = false;
      try {
        const state = win.history.state && typeof win.history.state === "object" ? (win.history.state as Record<string, unknown>) : {};
        win.history.pushState({ ...state, [OVERLAY_HISTORY_MARK]: depth }, "");
        pushedHref = win.location.href;
        repushed = true;
      } catch {
        // 칸을 다시 못 넣으면 아래로 내려가 평소처럼 닫는다(칸 없이 열린 창이 남는 것보다 낫다)
      }
      if (repushed) {
        try {
          options.onBlockedBack?.(); // 막힌 «뒤로»가 눌렸음을 알린다(닫기 전 확인 띄우기)
        } catch {
          // 알림 콜백 오류가 기록 관리를 깨지 않게
        }
        return;
      }
    }
    pushed = false;
    uncount();
    win.removeEventListener("popstate", onPop);
    if (leaving) {
      const href = leaving;
      leaving = null;
      // popstate 처리(라우터 복원)가 끝난 다음 순간에 이동
      win.setTimeout(() => navigateAfter(href), 0);
      return;
    }
    onBack();
  };
  win.addEventListener("popstate", onPop);
  return {
    release() {
      if (leaving) return; // 떠나는 중 — popstate 에서 정리한다
      win.removeEventListener("popstate", onPop);
      uncount();
      if (!pushed) return;
      const mine = ownsTop();
      pushed = false;
      try {
        if (mine) {
          // 표시가 지워진 칸을 떠나기 직전에 다시 찍는다 — 닫는 순간 다른 창이 열려도(같은 순간 A 닫고 B 열기)
          // 되돌아온 이 칸을 B 가 «아직 내 칸»으로 알아본다
          restampOverlayMark(win, depth, pushedHref);
          win.history.back();
        }
      } catch {
        // 되돌리기 실패 — 같은 주소 칸 하나가 남을 뿐
      }
    },
    leaveTo(href, navigate) {
      if (leaving) return; // 두 번 빠르게 누름
      if (!ownsTop()) {
        pushed = false;
        uncount();
        win.removeEventListener("popstate", onPop);
        navigate(href);
        return;
      }
      leaving = href;
      navigateAfter = navigate;
      win.history.back();
      // 안전장치: 일부 웹뷰에서 popstate 가 안 오면 0.4초 뒤 그대로 이동
      win.setTimeout(() => {
        if (leaving !== href) return;
        leaving = null;
        pushed = false;
        uncount();
        win.removeEventListener("popstate", onPop);
        navigate(href);
      }, 400);
    },
  };
}
