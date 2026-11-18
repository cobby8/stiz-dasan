/**
 * 사진 크게 보기를 휴대폰 «뒤로»(안드로이드 뒤로 버튼·밀어서 뒤로)로 닫기 — 2026-11-17 검수 반영.
 *
 * 왜: 크게 보기는 화면 전체를 덮는데, 학부모는 닫을 때 습관대로 «뒤로»를 누른다. 기록이 없으면 그 «뒤로»가
 *     크게 보기가 아니라 «앞 화면»으로 가 버린다(보던 소식에서 튕겨 나감).
 *
 * 방법: 열 때 브라우저 기록에 «같은 주소» 한 칸을 더 넣는다(pushState — 주소 인자 없이).
 *  - «뒤로» = 그 칸이 빠지며 popstate → 크게 보기만 닫는다(화면은 그대로).
 *  - 닫기 버튼·Esc·바탕 누르기·화면이 사라짐 = 그 칸이 아직 맨 위면 history.back() 으로 한 번 되돌린다(기록이 쌓이지 않게).
 *
 * 학부모 «뒤로» 규칙(inAppHistory·ParentBackLink·AppBackButton)과 부딪히지 않는 이유:
 *  - 그 규칙은 화면의 경로·쿼리가 바뀔 때만 기록한다(ParentHistoryTracker = usePathname·useSearchParams).
 *    주소 인자 없이 pushState 하면 Next.js 는 내부 상태만 복사하고 경로·쿼리를 바꾸지 않는다 → 이동 기록에 아무것도 안 쌓인다.
 *  - 되돌릴 때도 같은 주소로 돌아오므로 기록 규칙 1)«같은 주소면 그대로»에 걸린다.
 *  - 넣는 칸에는 표시(LIGHTBOX_HISTORY_MARK)를 단다 — 되돌리기 전에 «지금 맨 위가 우리 칸인가»를 보고,
 *    아니면(그사이 다른 화면으로 이동함) 되돌리지 않는다. 남의 기록을 지우지 않는다.
 *  - 크게 보기가 열려 있는 동안 화면 전체를 덮어 머리줄 «←»(AppBackButton)·페이지 «←»(ParentBackLink)는 누를 수 없다.
 *
 * ★ 이 파일은 다른 모듈을 import 하지 않는다(테스트가 가짜 window 로 그대로 실행한다).
 */

/** 크게 보기가 넣은 기록 칸의 표시 */
export const LIGHTBOX_HISTORY_MARK = "stizPhotoLightbox";

/** 그 기록 칸이 크게 보기가 넣은 칸인가 */
export function isLightboxHistoryState(state: unknown): boolean {
  return Boolean(state && typeof state === "object" && (state as Record<string, unknown>)[LIGHTBOX_HISTORY_MARK] === true);
}

/** 필요한 만큼만 받는 window 모양(테스트에서 가짜를 넣는다) */
export type LightboxHistoryWindow = {
  history: { readonly state: unknown; pushState(data: unknown, unused: string): void; back(): void };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
};

/**
 * 크게 보기를 열 때 부른다. onBack = «뒤로»로 닫혔을 때 부를 함수(부르는 쪽이 닫힘 상태로 바꾼다).
 * 돌려준 함수 = 크게 보기가 닫히거나 사라질 때 부른다(버튼·Esc·바탕으로 닫은 경우 기록 한 칸을 되돌린다).
 * 기록을 못 넣는 환경(막힘·오류)이면 조용히 옛 동작(버튼으로만 닫기)으로 남는다.
 */
export function bindLightboxToHistory(win: LightboxHistoryWindow, onBack: () => void): () => void {
  // 우리 칸이 아직 기록 맨 위에 있다고 믿는가
  let pushed = false;
  try {
    win.history.pushState({ [LIGHTBOX_HISTORY_MARK]: true }, "");
    pushed = true;
  } catch {
    pushed = false;
  }
  const onPop = () => {
    if (!pushed) return;
    // 돌아온 칸도 크게 보기 칸이면 닫지 않는다 — 개발 모드(Strict Mode)는 묶기→풀기→다시 묶기를 해서
    // 첫 풀기의 history.back() 이 다시 묶은 뒤에 도착한다. 그 칸도 우리 표시가 있어 닫을 때 한 번 되돌리면 깨끗해진다
    if (isLightboxHistoryState(win.history.state)) return;
    pushed = false; // «뒤로»로 우리 칸이 빠졌다 — 닫을 때 다시 되돌리지 않는다
    onBack();
  };
  win.addEventListener("popstate", onPop);
  return () => {
    win.removeEventListener("popstate", onPop);
    if (!pushed) return;
    pushed = false;
    // 맨 위가 아직 우리 칸일 때만 되돌린다(그사이 다른 화면으로 갔으면 그 화면의 기록을 건드리지 않는다)
    try {
      if (isLightboxHistoryState(win.history.state)) win.history.back();
    } catch {
      // 되돌리기 실패 — 기록 한 칸이 남을 뿐(뒤로 한 번 더 누르면 같은 화면)
    }
  };
}
