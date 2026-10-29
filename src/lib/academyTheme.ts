/** 학원 업무 화면만 선택해 공개 홈페이지의 테마 설정을 보존한다. */
export function isAcademyPath(pathname: string | null | undefined): boolean {
  const path = pathname ?? "";
  // 내 계정(/account/*)·카카오 학부모 인증·카카오 요청 링크도 학부모 화면이라 함께 라이트로 고정한다.
  return /^\/account(?:\/|$)/.test(path) || path === "/kakao-connect"
    || /^\/(?:admin|mypage|staff|driver|invite|request)(?:\/|$)/.test(path)
    || /^\/shuttle\/(?:run|regular|location)(?:\/|$)/.test(path)
    // 학부모 납부 화면(심사용 /payments/review 는 카드사 심사 중이라 그대로 둔다)
    || /^\/payments\/(?!review(?:\/|$))/.test(path);
}

export const ACADEMY_THEME_COLOR = "#b94118";
