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
  /**
   * 벗어나면 안 되는 범위. 없으면 범위 제한 없음.
   * "/staff"·"/admin" 은 설치 여부와 상관없이 늘 지키고, 그 밖("/mypage")은 설치된 앱일 때만 지킨다
   */
  scopeHref?: string;
  /** 설치된 앱(standalone)으로 열렸는지 */
  isInstalledApp: boolean;
};

/** 경로가 범위 안인지. "/mypage" 는 "/mypage", "/mypage/..." 를 포함한다. */
export function isWithinScope(pathname: string, scopeHref: string) {
  return pathname === scopeHref || pathname.startsWith(`${scopeHref}/`);
}

/**
 * 설치 여부와 상관없이 늘 범위를 지키는 역할 화면 — 선생님·기사님, 관리자.
 * ★ 이 파일은 다른 모듈을 import 하지 않는다(테스트가 그대로 실행한다) — 그래서 값을 여기에 직접 둔다.
 */
const ALWAYS_SCOPED: readonly string[] = ["/staff", "/admin"];

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

  // 선생님·관리자 화면은 설치 앱·스토어 앱·브라우저 모두 제 범위를 지킨다(2026-11-17).
  // 예전엔 «설치된 앱일 때만» 가둬서, 브라우저·스토어 앱에서는 역할 홈의 «←» 가 공개 홈(/)으로 나갔다.
  // (학부모 범위는 아래 기존 규칙 그대로 — 학부모 홈의 «←» = 공개 홈은 2026-11-15 원장 결정)
  if (scopeHref && ALWAYS_SCOPED.includes(scopeHref)) {
    // 그 역할의 홈 = fallbackHref 가 범위 안이면 그 주소, 아니면 범위 주소.
    // 기사님 전용 계정은 /staff 가 운행 화면으로 넘겨 버려서 홈을 /staff/shuttle 로 받는다
    const up = fallbackHref.split(/[?#]/)[0];
    const home = isWithinScope(up, scopeHref) ? fallbackHref : scopeHref;
    // 역할 홈이면 돌아갈 곳이 없다 — 아무 데도 보내지 않는다(버튼 자리만 남긴다)
    if (pathname === scopeHref || pathname === home.split(/[?#]/)[0]) return { type: "none" };
    return { type: "push", href: home };
  }

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
