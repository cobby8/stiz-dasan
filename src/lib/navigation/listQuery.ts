/**
 * 목록 화면의 «보던 상태»(검색어·필터·날짜·달)를 주소 쿼리에 실어 두는 도우미(2026-11-18 원장 결정 D).
 *
 * 왜: 원생 목록에서 검색·필터를 걸고 상세에 다녀오면 목록이 처음 상태로 돌아왔다(출결의 날짜, 청구·수납의 달도 같다).
 * 화면 상태는 화면을 떠나면 사라지지만, 주소는 브라우저 기록에 남는다 — 상태를 지금 칸의 주소에 적어 두면
 * «뒤로»로 돌아올 때 그 주소가 그대로 복원되고, 화면은 첫 그림에서 주소를 읽어 같은 상태로 시작한다.
 *
 * 원칙:
 *  - 기록을 쌓지 않는다(history.replaceState — 지금 칸의 주소만 바꾼다). 필터를 바꿀 때마다 «뒤로»가 한 칸씩 늘면 안 된다
 *  - 서버를 다시 부르지 않는다(router.replace 가 아니다 — 신청함 탭과 같은 방식). 단 Next 에는 바뀐 주소를 알린다(replaceUrlSyncingNext)
 *  - 기본값은 주소에 적지 않는다(주소가 깨끗하게 남고, 쿼리 없는 주소 = 처음 상태)
 *  - 다른 쿼리(?studentId= 등)는 건드리지 않는다
 *
 * 앞부분은 순수 함수(테스트로 실행 검증), 맨 아래 둘만 브라우저 쪽이다.
 */

/** 값이 비었으면(null·undefined·"") 그 쿼리를 지우고, 있으면 넣는다. 나머지 쿼리와 순서는 그대로. 돌려주는 값에 «?» 는 없다 */
export function mergeListQuery(search: string, patch: Readonly<Record<string, string | null | undefined>>): string {
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  for (const [key, value] of Object.entries(patch)) {
    if (value == null || value === "") params.delete(key);
    else params.set(key, value);
  }
  return params.toString();
}

/** 경로 + 쿼리 → 주소("/admin/students?q=김") */
export function listHref(pathname: string, query: string): string {
  return query ? `${pathname}?${query}` : pathname;
}

/** 주소에서 읽은 값이 허용 목록에 있을 때만 쓴다(없거나 모르는 값이면 기본값) */
export function pickListValue<T extends string>(raw: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** 검색어처럼 자유 입력인 값 — 너무 길면 자른다(주소가 끝없이 길어지지 않게) */
export function readListText(raw: string | null | undefined, maxLength = 100): string {
  return typeof raw === "string" ? raw.slice(0, maxLength) : "";
}

const YEAR_MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** "2026-11" → { year: 2026, month: 11 }. 모양이 틀리거나 2020~2035 밖이면 null(달력 계산 없음 — 글자만 본다) */
export function parseYearMonth(raw: string | null | undefined): { year: number; month: number } | null {
  const m = typeof raw === "string" ? YEAR_MONTH_RE.exec(raw) : null;
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 2020 && year <= 2035 ? { year, month: Number(m[2]) } : null;
}

/** { 2026, 3 } → "2026-03" */
export function formatYearMonth(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Next.js 가 history.state 에 넣어 두는 내부 키 — 우리가 넘기는 state 에서는 뺀다(아래 설명) */
export const NEXT_INTERNAL_STATE_KEYS: readonly string[] = ["__NA", "__PRIVATE_NEXTJS_INTERNALS_TREE", "_N"];

/**
 * history.state 에서 Next 내부 키만 뺀 사본(순수 함수 — 원본은 바꾸지 않는다). 우리 키(창 표시 stizOverlay·수업 가드 표시 등)는 그대로 남는다.
 * 객체가 아니면(null·문자열 등) 빈 객체.
 */
export function withoutNextInternalState(state: unknown): Record<string, unknown> {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return {};
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state as Record<string, unknown>)) {
    if (!NEXT_INTERNAL_STATE_KEYS.includes(key)) copy[key] = value;
  }
  return copy;
}

/**
 * 지금 칸의 주소를 바꾸고(기록은 안 쌓는다) **Next.js 에도 알린다**(2026-11-18 검수 N-2). 주소를 손으로 바꿀 때는 이 함수만 쓴다.
 *
 * 왜 history.state 를 그대로 넘기면 안 되나: Next 가 덧씌운 replaceState 는 넘어온 state 에 __NA(또는 _N)가 있으면
 * «Next 자신이 부른 것»으로 보고 그대로 통과시킨다(next/dist/client/components/app-router.js — 16.2.12 확인).
 * 그러면 주소창만 바뀌고 Next 가 아는 주소(canonicalUrl)는 옛 주소로 남아, 이후 서버 액션·router.refresh() 가
 * 옛 주소로 요청한 뒤 지금 칸을 옛 주소로 되돌려 놓는다(적어 둔 쿼리가 사라지고, 지운 쿼리가 되살아난다).
 * 내부 키를 빼고 넘기면 Next 가 자기 내부 값을 지금 state 에서 다시 붙이고(copyNextJsInternalHistoryState),
 * 주소를 자기 상태에 반영한다(ACTION_RESTORE — 지금 화면 트리를 그대로 써서 서버를 다시 부르지 않는다).
 */
export function replaceUrlSyncingNext(url: string): void {
  window.history.replaceState(withoutNextInternalState(window.history.state), "", url);
}

/**
 * 지금 칸의 주소 쿼리만 바꾼다(브라우저). 바뀐 것이 없으면 아무 일도 하지 않는다.
 * expectedPath 를 주면 지금 주소가 그 경로일 때만 쓴다 — 화면을 떠나는 순간 늦게 돈 호출이 다른 화면의 주소를 고치지 않게.
 */
export function replaceListQuery(patch: Readonly<Record<string, string | null | undefined>>, expectedPath?: string): void {
  if (typeof window === "undefined") return;
  try {
    const { pathname, search, hash } = window.location;
    if (expectedPath && pathname !== expectedPath) return;
    const query = mergeListQuery(search, patch);
    if (query === search.replace(/^\?/, "")) return;
    replaceUrlSyncingNext(`${listHref(pathname, query)}${hash}`);
  } catch {
    // 주소를 못 고쳐도 화면은 그대로다(돌아왔을 때 처음 상태로 보일 뿐)
  }
}
