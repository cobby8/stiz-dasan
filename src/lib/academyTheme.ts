/** 학원 업무 화면만 선택해 공개 홈페이지의 테마 설정을 보존한다. */
export function isAcademyPath(pathname: string | null | undefined): boolean {
  return /^\/(?:admin|mypage|staff|driver)(?:\/|$)/.test(pathname ?? "")
    || /^\/shuttle\/(?:run|regular)(?:\/|$)/.test(pathname ?? "");
}

export const ACADEMY_THEME_COLOR = "#7444a3";
