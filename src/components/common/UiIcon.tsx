// 사이트에서 허용한 아이콘만 그리는 공용 부품 (2026-11-15 원장 지정 예외).
// 이 사이트는 «아이콘 없이 글자»가 원칙이다. 예외는 넷뿐이다:
//   ① 펼침·접힘 = 화살표(expand_more / expand_less)  ② 알림 = 종(notifications / notifications_off)
//   ③ 설정 = 톱니(settings)  ④ 관리자 «빠른작업» ⚡(AdminQuickActionMenu — 이 부품 밖의 유일한 아이콘)
// 닫기·뒤로·삭제·로그아웃·메뉴 등은 지금처럼 글자다. 이름을 늘리려면 원장 결정이 먼저다
// (tests/ui-unify-guard.test.mjs 가 이름 5종과 «이 파일 밖에서 아이콘 글꼴을 직접 쓰지 않는다»를 막는다).
//
// 쓰는 법
//   · 아이콘은 뜻을 «보여 주기만» 한다(aria-hidden). 버튼 이름은 보이는 글자나 aria-label 로 따로 준다.
//   · 색은 «부모 글자색»을 따른다(currentColor). 글꼴이 늦게 실리는 동안 글자가 비치지 않게
//     globals.css 가 아이콘 글자의 색을 직접 정하므로, 이 부품에 text-[색] 클래스를 줘도 먹지 않는다 — 색은 부모에 준다.
//   · 글꼴은 루트 레이아웃의 DeferredFontStyles 가 화면에 아이콘이 있을 때만 불러온다(공개·학원 앱 테마 공통).
//   · 글꼴을 못 받으면(주소 막힘·4초 초과) 아이콘 대신 «대체 글자»가 보인다 — 아이콘만 있는 버튼이 빈칸이 되지 않게.
//     전환은 CSS 가 한다(html 의 material-symbols-fallback 클래스, globals.css). 여기서는 둘 다 그려 두기만 한다.

/** 허용된 아이콘 이름 — 펼침 화살표 2 · 알림 종 2 · 설정 톱니 1 */
export type UiIconName = "expand_more" | "expand_less" | "notifications" | "notifications_off" | "settings";

/** 글꼴을 못 받았을 때 보일 글자. 44px 버튼 안에 들어가게 짧게(12px 기준 세 글자 안팎) */
export const UI_ICON_FALLBACK_TEXT: Record<UiIconName, string> = {
    expand_more: "▾",
    expand_less: "▴",
    notifications: "알림",
    notifications_off: "알림 끔",
    settings: "설정",
};

export default function UiIcon({ name, size = 20, className = "" }: {
    name: UiIconName;
    /** 그리는 크기(px). 줄 안의 펼침 화살표는 20, 아이콘만 있는 머리줄 버튼은 24 */
    size?: 20 | 24;
    /** 배치·회전용 클래스(예: group-open:rotate-180). 색은 부모에 준다 */
    className?: string;
}) {
    return (
        // 바깥 칸: 회전·배치 클래스는 여기에 — 대체 글자(▾)도 같이 돌아 뜻이 맞는다
        <span aria-hidden="true" className={`ui-icon inline-flex shrink-0 items-center justify-center leading-none ${className}`.trim()}>
            <span className={`material-symbols-outlined ${size === 24 ? "text-2xl" : "text-xl"}`}>{name}</span>
            {/* 평소엔 숨김. 글꼴 실패·지연 때만 보인다(globals.css) */}
            <span className="ui-icon-fallback">{UI_ICON_FALLBACK_TEXT[name]}</span>
        </span>
    );
}
