/**
 * «마지막에 쓰던 화면 기억»(2026-11-17 원장 승인) — 순수 규칙.
 *
 * 왜 필요한가: 계정 하나가 여러 화면(관리자·선생님·기사님·학부모)을 쓸 수 있는데, 앱을 켤 때마다
 * «대표 역할 기본 화면»으로만 가서 화면 전환을 매번 다시 눌러야 했다. 화면 전환 목록에서 고른 화면을
 * 쿠키에 적어 두고, 다음에 목적지를 정할 때 그 화면을 먼저 본다.
 *
 * 지키는 것:
 *  - 쿠키에는 «화면 키» 한 단어만 싣는다(계정 ID·이메일·토큰 금지). 그래서 로그아웃해도 남겨 둔다.
 *  - 쿠키는 «바람»일 뿐 권한이 아니다. 서버가 그 계정이 지금 쓸 수 있는 화면 목록과 맞춰 본 뒤에만 따른다.
 *  - 이 파일은 import 없이 단독으로 읽힌다(화면·서버·테스트가 같이 쓴다). DB·시계·next 를 읽지 않는다.
 */

/** 쿠키 이름 */
export const LAST_VIEW_COOKIE = "stiz-last-view";

/** 수명 180일(초) */
export const LAST_VIEW_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

/** 기억할 수 있는 화면 키 — 화면 전환 목록(resolveAccountViews)의 key 와 같은 집합이어야 한다(테스트가 대조) */
export const LAST_VIEW_KEYS = ["admin", "teacher", "driver", "parent"] as const;
export type LastViewKey = (typeof LAST_VIEW_KEYS)[number];

/** 쿠키 값 → 화면 키. 목록에 있는 단어와 «정확히» 같을 때만 인정한다(공백·대문자·덧붙은 글자는 전부 무시). */
export function parseLastViewKey(raw: unknown): LastViewKey | null {
  if (typeof raw !== "string") return null;
  return (LAST_VIEW_KEYS as readonly string[]).includes(raw) ? (raw as LastViewKey) : null;
}

/**
 * 브라우저에 구울 쿠키 문자열. 값은 화면 키뿐이다.
 * 목록 밖 값이면 null — 아무것도 굽지 않는다.
 */
export function buildLastViewCookie(key: unknown): string | null {
  const safe = parseLastViewKey(key);
  if (!safe) return null;
  return `${LAST_VIEW_COOKIE}=${safe}; path=/; max-age=${LAST_VIEW_MAX_AGE_SECONDS}; samesite=lax; secure`;
}

/** 화면 전환 목록에서 화면을 골랐을 때 부른다(브라우저 전용). 못 구워도 화면 이동을 막지 않는다. */
export function rememberLastView(key: unknown): void {
  const cookie = buildLastViewCookie(key);
  if (!cookie || typeof document === "undefined") return;
  try {
    document.cookie = cookie;
  } catch {
    // 쿠키를 못 쓰는 환경이면 기억만 안 될 뿐이다.
  }
}

/**
 * 쿠키가 가리킨 화면의 주소를 돌려준다. 따르면 안 되는 경우는 null(= 지금처럼 대표 역할 기본 화면).
 *
 * views 는 반드시 «서버가 방금 확인한» 이 계정의 화면 목록이어야 한다.
 */
export function resolveLastViewDestination(input: {
  /** 쿠키에서 읽은 값 그대로 */
  cookieValue?: unknown;
  /** 이 계정이 지금 쓸 수 있는 화면 목록 */
  views: ReadonlyArray<{ key: string; href: string }>;
  /** 원래 가려던 주소 — 있으면 그것이 먼저다 */
  requestedPath?: string | null;
  /** 로그인 맥락("staff"·"staff-app") — 있으면 그 처리를 덮어쓰지 않는다 */
  context?: string | null;
  /** 보호 화면이 방금 거절해 되돌아온 경우 — 쿠키를 다시 따르면 거절 → 판별 → 거절이 반복된다 */
  bounced?: boolean;
}): string | null {
  if (input.bounced) return null;
  if (input.requestedPath) return null;
  if (input.context) return null;
  const key = parseLastViewKey(input.cookieValue);
  if (!key) return null;
  const view = input.views.find((candidate) => candidate.key === key);
  return view ? view.href : null;
}
