// 아이콘 글꼴(Material Symbols) 상태 판정 — 순수 규칙 (2026-11-15).
// 왜: 글꼴 주소가 막히거나 늦으면 아이콘이 계속 투명이라, 종·톱니처럼 «아이콘만 있는 버튼»이 보이지 않는 빈칸이 된다.
// 그래서 상태를 셋으로 나누고, 루트(html)에 붙일 클래스를 여기 한 곳에서 정한다.
//   pending  = 아직 모름(첫 그리기) — 아이콘 자리는 폭만 잡고 투명
//   ready    = 글꼴 파일을 실제로 쓸 수 있음 — 아이콘을 그린다
//   fallback = 실패했거나 너무 늦음 — 아이콘을 숨기고 대체 글자(▾ · «알림» · «설정»)를 보인다
// 화면 쪽 연결은 src/components/DeferredFontStyles.tsx, 모양은 globals.css, 대체 글자는 UiIcon.

export type IconFontState = "pending" | "ready" | "fallback";
export type IconFontEvent =
    | "font-loaded" // 글꼴 파일까지 받아서 쓸 수 있다
    | "css-error" // 글꼴 CSS 주소가 막혔다
    | "font-error" // CSS 는 받았는데 글꼴 파일을 못 받았다
    | "timeout"; // 정한 시간 안에 못 받았다

export const ICON_FONT_READY_CLASS = "material-symbols-ready";
export const ICON_FONT_FALLBACK_CLASS = "material-symbols-fallback";
/** 이 시간이 지나도 글꼴이 없으면 대체 글자로 바꾼다 */
export const ICON_FONT_TIMEOUT_MS = 4000;

/** 일이 생겼을 때 다음 상태. 글꼴이 도착하면 언제든 ready(늦게 와도 되돌린다), 한번 ready 면 실패 신호로 내려가지 않는다 */
export function nextIconFontState(current: IconFontState, event: IconFontEvent): IconFontState {
    if (event === "font-loaded") return "ready";
    return current === "ready" ? "ready" : "fallback";
}

/** 상태 → 루트에 붙일 클래스와 뗄 클래스. 두 클래스가 함께 붙는 일은 없다 */
export function iconFontRootClasses(state: IconFontState): { add: string[]; remove: string[] } {
    if (state === "ready") return { add: [ICON_FONT_READY_CLASS], remove: [ICON_FONT_FALLBACK_CLASS] };
    if (state === "fallback") return { add: [ICON_FONT_FALLBACK_CLASS], remove: [ICON_FONT_READY_CLASS] };
    return { add: [], remove: [ICON_FONT_READY_CLASS, ICON_FONT_FALLBACK_CLASS] };
}
