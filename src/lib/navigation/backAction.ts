/**
 * 뒤로가기 버튼이 무엇을 할지 정하는 규칙.
 *
 * 화면 컴포넌트에서 떼어낸 이유: 분기가 네 갈래라 눈으로 읽어서는 틀린 조합을
 * 못 찾는다. 실제로 "되돌아갈 곳이 지금 화면과 같으면 홈페이지로 보낸다"는
 * 한 줄 때문에 설치된 앱이 뒤로가기 한 번에 공개 홈페이지로 새어 나갔다.
 */

export type BackAction =
  | { type: "back" }
  | { type: "push"; href: string }
  | { type: "none" };

export type BackActionInput = {
  /** 이 브라우징 세션 안에서 되돌아갈 기록이 있는지 */
  hasHistory: boolean;
  /** 현재 경로 */
  pathname: string;
  /** 기록이 없을 때 갈 곳(브라우저용) */
  fallbackHref: string;
  /** 설치된 앱이 벗어나면 안 되는 범위. 없으면 범위 제한 없음 */
  scopeHref?: string;
  /** 설치된 앱(standalone)으로 열렸는지 */
  isInstalledApp: boolean;
};

/** 경로가 범위 안인지. "/mypage" 는 "/mypage", "/mypage/..." 를 포함한다. */
export function isWithinScope(pathname: string, scopeHref: string) {
  return pathname === scopeHref || pathname.startsWith(`${scopeHref}/`);
}

export function resolveBackAction({
  hasHistory,
  pathname,
  fallbackHref,
  scopeHref,
  isInstalledApp,
}: BackActionInput): BackAction {
  // 되돌아갈 기록이 있으면 언제나 이전 화면으로. 설치된 앱의 기록은 제 범위
  // 안에서만 쌓이므로(범위 밖 링크는 브라우저가 따로 연다) 이것만으로 안전하다.
  if (hasHistory) return { type: "back" };

  // 범위가 지정됐고 설치된 앱으로 열렸을 때만 가둔다.
  // 브라우저로 들어온 사람은 홈페이지에서 왔을 수 있어 막으면 오히려 불편하다.
  if (scopeHref && isInstalledApp) {
    // 앱의 첫 화면이면 돌아갈 곳이 없다. 아무 데도 보내지 않는다.
    if (pathname === scopeHref) return { type: "none" };
    // 범위 안의 «한 단계 위»(예: 탈퇴 → 설정)가 있으면 그리로, 없으면 앱의 첫 화면으로(2026-11-17)
    const up = fallbackHref.split(/[?#]/)[0];
    if (up !== pathname && isWithinScope(up, scopeHref)) return { type: "push", href: fallbackHref };
    return { type: "push", href: scopeHref };
  }

  // 되돌아갈 곳이 지금 화면과 같으면 제자리걸음이라 홈으로 보낸다(기존 동작).
  return { type: "push", href: fallbackHref === pathname ? "/" : fallbackHref };
}
