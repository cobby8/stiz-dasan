/** 학원 업무 화면만 선택해 공개 홈페이지의 테마 설정을 보존한다. */
export function isAcademyPath(pathname: string | null | undefined): boolean {
  return pathname === "/account/children" || pathname === "/account/activate" || pathname === "/kakao-connect" || /^\/(?:admin|mypage|staff|driver|invite)(?:\/|$)/.test(pathname ?? "")
    || /^\/shuttle\/(?:run|regular|location)(?:\/|$)/.test(pathname ?? "")
    // 학부모 납부 화면(심사용 /payments/review 는 카드사 심사 중이라 그대로 둔다)
    || /^\/payments\/(?!review(?:\/|$))/.test(pathname ?? "");
}

export const ACADEMY_THEME_COLOR = "#b94118";
