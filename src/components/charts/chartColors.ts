/**
 * 차트 색 — 한 곳 (2026-11-09 색상 정리 6단계)
 *
 * 왜 한 곳인가: 차트(SVG)는 Tailwind 클래스 대신 fill·stroke 속성에 색을 직접 넣어서,
 * 파일마다 hex 와 팔레트 이름(violet·indigo·blue 500)이 흩어져 있었다.
 * 여기서 «역할 이름 → 토큰»만 정하고 실제 색 값은 academy-theme.css 토큰이 정한다.
 *
 * ⚠️ 값은 hex 가 아니라 var(--color-academy-*) 다 — 하드코딩 색 가드(tests/color-hardcode-guard.test.mjs)가 hex 를 센다.
 * ⚠️ 계열 색은 «뜻»으로 고른다: 좋은 흐름 success · 나쁜 흐름 danger · 그 외(장식) series/bar.
 *    (.academy-app 안에서 blue 는 회색, violet·indigo 는 적갈색으로 보이던 장식이라 bar(중립)로 옮겼다.)
 */
export const CHART_COLORS = {
    /** 가로 눈금선 */
    grid: "var(--color-academy-line)",
    /** 막대 뒤 «정원» 칸·도넛 빈 고리 */
    track: "var(--color-academy-soft)",
    /** 도넛 가운데 큰 숫자 */
    value: "var(--color-academy-ink)",
    /** 축 글자·보조 숫자(흐린 글자 한도 = 흰 바탕 4.5:1) */
    axis: "var(--color-academy-faint)",
    /** 마우스를 올렸을 때 뜨는 값 상자 바탕(글자는 흰색) */
    tooltip: "var(--color-academy-ink)",
    /** 뜻 없는 기본 계열(매출·체험 전환) — 주 색(네이비) */
    series: "var(--color-academy-primary)",
    /** 막대·보조 선(반별 등록·코치별·신규 등록) — 중간 회색 */
    bar: "var(--color-academy-neutral)",
    /** 좋은 흐름(출석률·수납률) */
    success: "var(--color-academy-success)",
    /** 나쁜 흐름(퇴원) */
    danger: "var(--color-academy-danger)",
} as const;
