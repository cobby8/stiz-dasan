/**
 * 스티즈 농구교실 폰트 설정
 * 관리자 페이지에서 선택 가능한 한국어 웹폰트 목록
 */

export interface FontOption {
    key: string;
    name: string;         // 한글 이름
    nameEn: string;       // 영문 이름
    css: string;          // font-family CSS 값
    tag?: string;         // 추천 태그
    sample: string;       // 미리보기 텍스트
}

export const BODY_FONT_OPTIONS: FontOption[] = [
    {
        key: "pretendard",
        name: "Pretendard",
        nameEn: "Pretendard",
        css: "'Pretendard Variable', 'Pretendard', -apple-system, sans-serif",
        tag: "추천",
        sample: "스티즈 농구교실 다산2호점 — 아이들의 가능성을 이끌어 드립니다.",
    },
    {
        key: "noto-sans-kr",
        name: "Noto Sans KR",
        nameEn: "Noto Sans KR",
        css: "'Noto Sans KR', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        sample: "스티즈 농구교실 다산2호점 — 아이들의 가능성을 이끌어 드립니다.",
    },
    {
        key: "nanum-gothic",
        name: "나눔고딕",
        nameEn: "Nanum Gothic",
        css: "'Nanum Gothic', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        sample: "스티즈 농구교실 다산2호점 — 아이들의 가능성을 이끌어 드립니다.",
    },
    {
        key: "ibm-plex-kr",
        name: "IBM Plex Sans KR",
        nameEn: "IBM Plex Sans KR",
        css: "'IBM Plex Sans KR', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        sample: "스티즈 농구교실 다산2호점 — 아이들의 가능성을 이끌어 드립니다.",
    },
    {
        key: "system",
        name: "시스템 기본",
        nameEn: "System Default",
        css: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        sample: "스티즈 농구교실 다산2호점 — 아이들의 가능성을 이끌어 드립니다.",
    },
];

export const HEADING_FONT_OPTIONS: FontOption[] = [
    {
        key: "black-han-sans",
        name: "블랙 한산스",
        nameEn: "Black Han Sans",
        css: "'Black Han Sans', 'Arial Black', -apple-system, BlinkMacSystemFont, sans-serif",
        tag: "추천 · 스포티",
        sample: "STIZ 농구교실",
    },
    {
        key: "jua",
        name: "주아",
        nameEn: "Jua",
        css: "'Jua', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        tag: "활기차고 귀여운",
        sample: "STIZ 농구교실",
    },
    {
        key: "pretendard",
        name: "Pretendard",
        nameEn: "Pretendard",
        css: "'Pretendard Variable', 'Pretendard', -apple-system, sans-serif",
        sample: "STIZ 농구교실",
    },
    {
        key: "nanum-gothic",
        name: "나눔고딕",
        nameEn: "Nanum Gothic",
        css: "'Nanum Gothic', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        sample: "STIZ 농구교실",
    },
    {
        key: "same-as-body",
        name: "본문과 동일",
        nameEn: "Same as body",
        css: "inherit",
        sample: "STIZ 농구교실",
    },
];

/** font key → CSS font-family 값 변환 */
export function getFontCss(key: string | null | undefined, options: FontOption[]): string {
    if (!key || key === "same-as-body") return "inherit";
    return options.find((f) => f.key === key)?.css ?? options[options.length - 1].css;
}
