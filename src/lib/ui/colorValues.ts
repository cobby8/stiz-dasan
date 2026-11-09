/**
 * CSS 변수(var(--color-*))를 쓸 수 없는 곳의 색 값 한 곳 (2026-11-09 색상 정리 7단계).
 *
 * 왜 따로 두나: OG 이미지(서버에서 그림으로 굽는다)·<meta name="theme-color">(브라우저 주소창 색)·
 * SVG 차트 속성(fill/stroke)은 CSS 변수를 읽지 못해 hex 를 직접 줘야 한다.
 * 이런 값이 파일마다 흩어지면 토큰을 바꿀 때 한쪽만 고쳐지므로 여기 한 곳에 모은다.
 * 값은 토큰 정본(src/app/academy-theme.css · src/components/public-sport.css)과 같게 맞춘다.
 * 하드코딩 색 가드(tests/color-hardcode-guard.test.mjs)는 이 파일을 «색 정의 파일»로 보고 세지 않는다.
 */

/** 브라우저 주소창 색(theme-color) */
export const THEME_COLORS = {
  publicLight: "#ffffff", // 공개 홈페이지 밝은 모드 바탕(--color-public-paper)
  publicDark: "#15181c", // 공개 홈페이지 다크 차콜(--color-public-dark)
  academy: "#b94118", // 학원 앱 화면 주소창 색
} as const;

/** 공유 미리보기 그림(opengraph-image) — 공개 토큰과 같은 값 */
export const OG_COLORS = {
  background: "#15181c", // --color-public-dark
  trial: "#b94118", // --color-public-trial (체험 신청 주황)
  orange: "#f4753a", // --color-public-orange (어두운 바탕 위 강조 글자)
  onOrange: "#15181c", // 밝은 주황 위 글자
  subText: "#c8d2e3", // 어두운 바탕 위 보조 글자
} as const;

/** 관리자 통계 SVG 차트 */
export const CHART_COLORS = {
  bar: "#3b82f6", // 막대 기본색
  grid: "#e5e7eb", // 눈금선(--color-academy-line)
  track: "#f3f4f6", // 빈 막대·도넛 바탕(--color-academy-soft)
  label: "#1f2937", // 값 글자
  center: "#111827", // 도넛 가운데 숫자(--color-academy-ink)
  axis: "#6b7280", // 축 글자(--color-academy-faint) — 흰 바탕 4.5:1 이상(옛 #9ca3af 는 2.5:1)
} as const;
