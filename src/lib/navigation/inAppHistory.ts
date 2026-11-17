/**
 * 학부모 화면(/mypage) 안 이동 기록 — 탭(창)마다 짧게 남긴다(2026-11-14).
 * 2026-11-17: 같은 장치를 선생님·기사님(/staff)·관리자(/admin) 화면에서도 쓴다 — 범위마다 기록·표시를 따로 둔다(아래 «범위»).
 *
 * 왜 따로 남기나: Next.js App Router 는 history.state 에 순번(idx)을 넣지 않고,
 * document.referrer 는 화면 안 이동(SPA) 중에 바뀌지 않는다. 그래서 설치된 앱에서는
 * «되돌아갈 기록이 있나»를 늘 «없음»으로 읽어, 뒤로 버튼이 매번 홈(/mypage)으로 갔다.
 * → 화면이 바뀔 때마다 주소를 sessionStorage 에 쌓고(탭마다 따로), 그걸 보고 판단한다.
 *
 * 규칙(순수 함수 nextInAppHistory — 테스트로 실행 검증):
 *  1) 같은 주소면 그대로(새로고침·같은 화면 다시 그리기)
 *  2) 새 화면이 «바로 앞» 화면과 같은 경로면 = 뒤로 간 것 → 맨 끝 하나를 뺀다(pop)
 *  3) 경로는 같고 쿼리만 바뀌면(쪽 넘김·필터) = 같은 화면 → 맨 끝을 바꿔 끼운다(replace)
 *  4) 그 밖은 새 화면 → 쌓는다(push), 최대 30개(오래된 것부터 버림)
 * 판단이 애매하면 늘 «기록을 짧게» 보는 쪽으로 기운다 — 짧게 보면 고정 주소로 가는 옛 동작이고,
 * 길게 보면 첫 화면에서 router.back() 이 아무 일도 안 하는(죽은 버튼) 더 나쁜 결과가 난다.
 */

export const IN_APP_HISTORY_KEY = "stiz:parent-nav-history:v1";
export const IN_APP_HISTORY_MAX = 30;
/** 기록을 남기는 범위 — 학부모 화면 */
export const PARENT_HISTORY_SCOPE = "/mypage";

/** "/mypage/news?page=2" → "/mypage/news" (해시·쿼리 제외) */
export function pathOf(entry: string): string {
  const cut = entry.search(/[?#]/);
  return cut === -1 ? entry : entry.slice(0, cut);
}

/** 기록 한 칸 = 경로 + 쿼리(해시는 화면 이동이 아니라 뺀다) */
export function entryOf(pathname: string, search = ""): string {
  const q = search.replace(/^\?/, "");
  return q ? `${pathname}?${q}` : pathname;
}

/** 새 주소가 들어왔을 때 다음 기록(원본은 바꾸지 않는다) */
export function nextInAppHistory(
  stack: readonly string[],
  entry: string,
  max = IN_APP_HISTORY_MAX,
  /**
   * 이번 이동이 브라우저 «뒤로·앞으로»(popstate)였나. 모르면 undefined(예전 규칙: 바로 앞 화면과 같으면 돌아온 것).
   * 2026-11-17: 링크로 «앞으로» 같은 화면에 다시 들어간 것(아이 기록 → 수업 → «전체 기록»)까지 돌아온 것으로 읽어
   * 기록이 줄고 «←» 가 방금 있던 수업이 아니라 홈으로 갔다 → 기록 부품이 popstate 를 보고 알려 준다.
   */
  viaPop?: boolean,
): string[] {
  if (stack.length === 0) return [entry];
  const last = stack[stack.length - 1];
  if (last === entry) return [...stack]; // 1) 같은 주소
  const prev = stack.length >= 2 ? stack[stack.length - 2] : undefined;
  // 0) 링크·아래 탭·로고로 학부모 홈(앱의 첫 화면)에 왔다 → 새로 시작(2026-11-17 검수).
  //    홈은 맨 위 화면이라 «←» 가 없어야 한다(설치 앱 결정). 쌓으면 홈에 «←»(→ 방금 화면)가 새로 생긴다
  if (viaPop === false && pathOf(entry) === PARENT_HISTORY_SCOPE) return [entry];
  // 2) 바로 앞 화면으로 돌아옴 → pop (쿼리가 달라도 같은 화면이면 그 칸을 새 주소로). 링크로 들어간 것(viaPop=false)은 제외
  if (viaPop !== false && prev !== undefined && pathOf(prev) === pathOf(entry)) return [...stack.slice(0, -2), entry];
  // 3) 같은 화면에서 쿼리만 바뀜 → replace
  if (pathOf(last) === pathOf(entry)) return [...stack.slice(0, -1), entry];
  // 4) 새 화면 → push(최대 개수 유지)
  const next = [...stack, entry];
  return next.length > max ? next.slice(next.length - max) : next;
}

/**
 * 지금 화면에서 되돌아갈 기록이 있나.
 * - 기록의 맨 끝이 지금 경로가 아니면 null(= 아직 이 화면을 기록하지 못함 → 판단 보류, 옛 방식으로)
 * - 맨 끝이 지금 경로면 기록이 2칸 이상일 때만 true
 */
export function hasInAppHistory(stack: readonly string[], pathname: string): boolean | null {
  if (stack.length === 0) return null;
  if (pathOf(stack[stack.length - 1]) !== pathname) return null;
  return stack.length > 1;
}

/** 저장된 값 → 기록 배열. 깨진 값·이상한 값은 빈 기록으로(절대 throw 하지 않는다) */
export function parseInAppHistory(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string" && v.startsWith("/")).slice(-IN_APP_HISTORY_MAX);
  } catch {
    return [];
  }
}

// ── 범위(2026-11-17) — 역할 화면마다 기록을 따로 둔다 ─────────────────────────────
//
// 왜 따로인가: 한 사람이 한 탭에서 관리자 → 선생님 화면으로 «화면 전환»을 할 수 있다.
// 기록을 한 줄로 이어 두면 선생님 화면의 «←» 가 관리자 화면으로 돌아간다(다른 역할 화면으로 나감).
// 범위마다 저장 키·메모리 기록·«첫 기록» 판정·떠남·바꿔 끼우기·뒤로(pop) 표시를 따로 두면,
// 다른 범위에서 넘어온 첫 화면은 늘 [지금 화면] 한 칸으로 새로 시작한다.
// 학부모 범위의 규칙·저장 키는 예전 그대로다(학부모용 함수는 아래에서 /mypage 로 부르는 얇은 포장).

/** 이동 기록을 남기는 범위 — 학부모·선생님(기사님)·관리자 */
export const HISTORY_SCOPES = ["/mypage", "/staff", "/admin"] as const;
export type HistoryScope = (typeof HISTORY_SCOPES)[number];

/** 다음에 열리는 주소가 지금 칸을 «바꿔 끼우는»(location.replace) 이동이라는 표시 — 새 페이지의 첫 기록이 읽는다 */
export const IN_APP_REPLACE_KEY = "stiz:parent-nav-replace:v1";
/** 학부모 화면을 «화면 안 이동»으로 떠났다는 표시 — 아래 markLeftScope 설명 참고 */
export const IN_APP_LEFT_KEY = "stiz:parent-nav-left:v1";
/** popstate 뒤 이 시간 안에 화면이 바뀌어야 «뒤로 간 것» — 시트·사진 닫기용 popstate 가 다음 링크 이동까지 남지 않게 */
export const POP_FLAG_TTL_MS = 3000;

type ScopeState = {
  historyKey: string;
  replaceKey: string;
  leftKey: string;
  /** sessionStorage 가 막힌 브라우저에서도 그 탭이 살아 있는 동안은 기억한다 */
  memoryStack: string[];
  /** 이 페이지(문서)에서 이 범위의 첫 기록 전인가 — 전체 새로 불러오기마다 모듈이 새로 올라와 true 로 돌아온다 */
  firstRecordOfPage: boolean;
  replacePending: boolean;
  leftScopePending: boolean;
  /** 브라우저 «뒤로·앞으로»(popstate) 표시 — 기록 부품이 듣고 다음 기록이 읽는다 */
  popListening: boolean;
  popPending: boolean;
  popAt: number;
  /**
   * 선생님·관리자 규칙을 쓰는 범위인가(학부모는 false — 기존 규칙 그대로).
   * true 면: 문서를 범위 밖에서 불러왔을 때 새로 시작 · 문서 첫 기록에서도 떠남 표시 확인 ·
   *          새로고침은 navigation type 으로 확인 · 같은 경로가 기록에 있으면 거기까지 잘라냄(nextScopeHistory)
   */
  strict: boolean;
};

function newScopeState(keys: { historyKey: string; replaceKey: string; leftKey: string }, strict: boolean): ScopeState {
  return {
    ...keys,
    memoryStack: [],
    firstRecordOfPage: true,
    replacePending: false,
    leftScopePending: false,
    popListening: false,
    popPending: false,
    popAt: 0,
    strict,
  };
}

const SCOPE_STATES: Record<HistoryScope, ScopeState> = {
  // 학부모 저장 키는 예전 값 그대로 — 배포된 탭의 기록이 끊기지 않게
  "/mypage": newScopeState({ historyKey: IN_APP_HISTORY_KEY, replaceKey: IN_APP_REPLACE_KEY, leftKey: IN_APP_LEFT_KEY }, false),
  "/staff": newScopeState({ historyKey: "stiz:staff-nav-history:v1", replaceKey: "stiz:staff-nav-replace:v1", leftKey: "stiz:staff-nav-left:v1" }, true),
  "/admin": newScopeState({ historyKey: "stiz:admin-nav-history:v1", replaceKey: "stiz:admin-nav-replace:v1", leftKey: "stiz:admin-nav-left:v1" }, true),
};

/** 그 범위의 기록을 담는 sessionStorage 키(테스트·점검용) */
export function scopeHistoryKey(scope: HistoryScope): string {
  return SCOPE_STATES[scope].historyKey;
}

/** 경로가 그 범위 안인지 — "/staff" 는 "/staff", "/staff/..." 만("/staffx" 는 아님) */
export function isScopePath(pathname: string, scope: HistoryScope): boolean {
  return pathname === scope || pathname.startsWith(`${scope}/`);
}

/** 경로가 속한 범위. 세 범위 밖(공개 사이트·로그인·내 계정 등)이면 null */
export function scopeOfPath(pathname: string): HistoryScope | null {
  return HISTORY_SCOPES.find((scope) => isScopePath(pathname, scope)) ?? null;
}

/** 경로가 학부모 범위(/mypage, /mypage/...) 안인지 */
export function isParentScopePath(pathname: string): boolean {
  return isScopePath(pathname, PARENT_HISTORY_SCOPE);
}

/** 경로가 선생님·관리자 범위(새 규칙을 쓰는 범위)면 그 범위 — 학부모·그 밖은 null */
export function staffOrAdminScopeOf(pathname: string): HistoryScope | null {
  const scope = scopeOfPath(pathname);
  return scope && SCOPE_STATES[scope].strict ? scope : null;
}

/**
 * «거쳐 가는 화면» — 그리자마자 다른 주소로 바꿔 끼우는(replace·redirect) 화면이라 기록하지 않는다(2026-11-17 검수 M1).
 *  - /staff/driver   : 기사님 첫 화면. 곧바로 운행 화면(/staff/run 또는 /staff/run/open)으로 replace 한다
 *  - /staff/run/open : 화면 없이 서버가 운행 링크(/driver/열쇠)나 운행표로 보낸다
 * 기록하면 브라우저 기록엔 없는 칸이 우리 기록에만 남아, «←» 가 한 칸 더 물러나 로그인 화면으로 나갔다.
 */
export const SCOPE_PASS_THROUGH_PATHS: readonly string[] = ["/staff/driver", "/staff/run/open"];

export function isPassThroughPath(pathname: string): boolean {
  const p = pathname.replace(/\/+$/, "") || "/";
  return SCOPE_PASS_THROUGH_PATHS.includes(p);
}

/**
 * 선생님·관리자 범위의 다음 기록(순수 함수 — 원본은 바꾸지 않는다). 학부모 규칙(nextInAppHistory)과 다른 점:
 *  - 기록 «어디든» 같은 경로가 있으면 거기까지 잘라낸다(검수 R2). 수업 화면의 «나가기»(history.go(-2))·
 *    수업 종료 뒤 replace('/staff') 처럼 여러 칸을 한꺼번에 물러나는 이동을 한 칸씩 쌓으면
 *    기록이 실제보다 길어져, 첫 화면에서 «←» 가 범위 밖으로 back 한다. «애매하면 기록을 짧게».
 *  - 홈으로 링크 이동해도 새로 시작하지 않는다(홈이 기록에 있으면 위 규칙으로 잘리고, 없으면 쌓는다)
 */
export function nextScopeHistory(stack: readonly string[], entry: string, max = IN_APP_HISTORY_MAX): string[] {
  if (stack.length === 0) return [entry];
  const last = stack[stack.length - 1];
  if (last === entry) return [...stack]; // 같은 주소(새로고침·다시 그리기)
  if (pathOf(last) === pathOf(entry)) return [...stack.slice(0, -1), entry]; // 같은 화면에서 쿼리만 바뀜
  const path = pathOf(entry);
  for (let i = stack.length - 2; i >= 0; i -= 1) {
    if (pathOf(stack[i]) === path) return [...stack.slice(0, i), entry]; // 전에 있던 화면으로 돌아옴 → 거기까지 잘라냄
  }
  const next = [...stack, entry]; // 새 화면
  return next.length > max ? next.slice(next.length - max) : next;
}

// ── 브라우저 쪽(저장·구독) — 서버에서는 아무 일도 하지 않는다 ──────────────────────

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function sessionStore(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // 사생활 보호 모드 등에서 접근 자체가 막힌 경우
  }
}

let version = 0;
const listeners = new Set<() => void>();

/** 그 범위의 기록 읽기 */
export function readScopeHistory(scope: HistoryScope, storage: StorageLike | null = sessionStore()): string[] {
  const state = SCOPE_STATES[scope];
  if (!storage) return state.memoryStack;
  try {
    return parseInAppHistory(storage.getItem(state.historyKey));
  } catch {
    return state.memoryStack;
  }
}

/** 학부모 기록 읽기(기존 이름) */
export function readInAppHistory(storage: StorageLike | null = sessionStore()): string[] {
  return readScopeHistory(PARENT_HISTORY_SCOPE, storage);
}

/** 페이지를 «처음 불러온 직후»의 판단 재료(테스트에서 바꿔 넣을 수 있게 따로 받는다) */
export type PageLoadEnv = {
  /** document.referrer — 이 페이지를 불러오게 한 앞 주소(없으면 "") */
  referrer: string;
  /** window.location.origin */
  origin: string;
  /** window.history.length */
  historyLength: number;
  /** 이 문서를 처음 불러온 주소의 경로(화면 안 이동으로는 안 바뀐다). 못 읽으면 비워 둔다 — 그 판정만 건너뛴다(선생님·관리자 범위만 봄) */
  documentPath?: string | null;
  /** 이 문서를 불러온 방식 — "navigate"·"reload"·"back_forward" 등. 못 읽으면 비워 둔다(선생님·관리자 범위만 봄) */
  navigationType?: string | null;
};

/**
 * 페이지를 새로 불러온 직후의 첫 기록에서, 이어 오던 기록을 버리고 [지금 화면]으로 새로 시작할지.
 * 왜: sessionStorage 는 학부모 화면 «밖»(결제창 redirect·로그인·공개 홈페이지·카카오 등)을 거쳐 와도 남아 있다.
 *     그대로 이어 붙이면 «←» 가 history.back() 으로 그 바깥 화면(예: 결제창)에 돌아간다.
 * - 새로고침(기록 맨 끝 = 지금 주소)은 이어 간다 — 단, 브라우저 기록이 1칸뿐이면 새로 시작
 * - 브라우저 기록이 1칸뿐(앱을 막 열었거나 새 탭 — 새 탭은 sessionStorage 가 복사돼 올 수 있다) → 새로 시작
 * - 앞 주소가 없거나·다른 사이트거나·같은 사이트라도 범위(/mypage 등) 밖 → 새로 시작
 * - 앞 주소가 같은 범위 화면(/mypage/…) → 이어 간다(그 범위 안 전체 새로 불러오기)
 * scope 를 안 넘기면 학부모 범위(기존 호출 그대로).
 */
export function shouldRestartOnPageLoad(
  stack: readonly string[],
  entry: string,
  env: PageLoadEnv,
  scope: HistoryScope = PARENT_HISTORY_SCOPE,
): boolean {
  if (env.historyLength <= 1) return true;
  if (stack.length > 0 && stack[stack.length - 1] === entry) return false; // 새로고침
  if (!env.referrer) return true;
  try {
    const ref = new URL(env.referrer);
    if (ref.origin !== env.origin) return true;
    return !isScopePath(ref.pathname, scope);
  } catch {
    return true;
  }
}

/** 그 범위의 다음 이동은 지금 칸을 «바꿔 끼우는» 이동이라는 표시(router.replace·location.replace 직전에 부른다) */
export function markNextScopeNavigationAsReplace(scope: HistoryScope, storage: StorageLike | null = sessionStore()) {
  const state = SCOPE_STATES[scope];
  state.replacePending = true;
  try {
    storage?.setItem(state.replaceKey, "1");
  } catch {
    // 저장이 막히면 표시가 사라진다 — 그 경우 한 칸 더 쌓일 뿐(뒤로가 그 범위 안에 머문다)
  }
}

/**
 * location.replace 직전에 부른다(예: MyPageClient 의 옛 홈 칸 주소 넘기기).
 * 실제 브라우저 기록에서 지금 칸이 새 주소로 바뀌므로, 우리 기록도 쌓지 않고 맨 끝을 바꿔 끼운다.
 * (학부모 범위 — 기존 이름)
 */
export function markNextNavigationAsReplace(storage: StorageLike | null = sessionStore()) {
  markNextScopeNavigationAsReplace(PARENT_HISTORY_SCOPE, storage);
}

/**
 * 브라우저 «뒤로·앞으로»(popstate)가 일어났다는 표시 — 기록 부품(ParentHistoryTracker·ScopeHistoryTracker)이 듣고 다음 기록이 읽는다.
 * 듣기 시작한 뒤로는 표시가 없으면 «링크로 들어간 것»(viaPop=false)으로 본다.
 */
export function noteScopePopNavigation(scope: HistoryScope, now = Date.now()) {
  const state = SCOPE_STATES[scope];
  state.popPending = true;
  state.popAt = now;
}
export function startScopePopListening(scope: HistoryScope) {
  SCOPE_STATES[scope].popListening = true;
}
/** 학부모 범위(기존 이름) */
export function notePopNavigation(now = Date.now()) {
  noteScopePopNavigation(PARENT_HISTORY_SCOPE, now);
}
export function startPopListening() {
  startScopePopListening(PARENT_HISTORY_SCOPE);
}
function takePopFlag(state: ScopeState, now = Date.now()): boolean | undefined {
  if (!state.popListening) return undefined; // 듣지 않는 곳(테스트 등)은 예전 규칙
  const was = state.popPending && now - state.popAt <= POP_FLAG_TTL_MS;
  state.popPending = false;
  return was;
}

function currentEnv(): PageLoadEnv | null {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return null;
    return {
      referrer: document.referrer || "",
      origin: window.location.origin,
      historyLength: window.history.length,
      ...documentLoadInfo(),
    };
  } catch {
    return null;
  }
}

/** 이 문서를 처음 불러온 주소의 경로와 불러온 방식 — 못 읽으면 둘 다 null(그 판정만 건너뛴다) */
function documentLoadInfo(): { documentPath: string | null; navigationType: string | null } {
  try {
    if (typeof performance === "undefined") return { documentPath: null, navigationType: null };
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return {
      documentPath: nav?.name ? new URL(nav.name).pathname : null,
      navigationType: typeof nav?.type === "string" ? nav.type : null,
    };
  } catch {
    return { documentPath: null, navigationType: null };
  }
}

function takeReplaceFlag(state: ScopeState, storage: StorageLike | null): boolean {
  let flagged = state.replacePending;
  state.replacePending = false;
  try {
    if (storage?.getItem(state.replaceKey) === "1") flagged = true;
    storage?.setItem(state.replaceKey, "");
  } catch {
    // 읽기·쓰기 실패 — 메모리 표시로만 판단
  }
  return flagged;
}

/** 테스트 전용 — «페이지를 새로 불러온 직후» 상태로 되돌린다(모든 범위) */
export function resetPageLoadStateForTest() {
  for (const scope of HISTORY_SCOPES) {
    const state = SCOPE_STATES[scope];
    state.firstRecordOfPage = true;
    state.replacePending = false;
    state.leftScopePending = false;
    state.popListening = false;
    state.popPending = false;
    state.popAt = 0;
    state.memoryStack = [];
  }
}

/**
 * 그 범위를 «화면 안 이동»(새로 불러오기 없이)으로 떠났다는 표시(2026-11-14 재검수 권장).
 * 세션이 끝나 /login → 로그인 뒤 화면 안 이동으로 /mypage 에 돌아오면 첫 기록 판정(shouldRestartOnPageLoad)이
 * 돌지 않아 «←» 가 /login 으로 돌아갔다. 떠날 때 표시해 두고, 돌아온 첫 기록에서 [entry] 로 새로 시작한다.
 * 관리자 ↔ 선생님 «화면 전환»도 같은 길이다 — 돌아온 범위는 새 기록으로 시작한다.
 */
export function markLeftScope(scope: HistoryScope, storage: StorageLike | null = sessionStore()) {
  const state = SCOPE_STATES[scope];
  state.leftScopePending = true;
  try {
    storage?.setItem(state.leftKey, "1");
  } catch {
    // 저장이 막히면 메모리 표시로만
  }
}

/** 학부모 화면을 떠났다는 표시(기존 이름) */
export function markLeftParentScope(storage: StorageLike | null = sessionStore()) {
  markLeftScope(PARENT_HISTORY_SCOPE, storage);
}

function takeLeftFlag(state: ScopeState, storage: StorageLike | null): boolean {
  let flagged = state.leftScopePending;
  state.leftScopePending = false;
  try {
    if (storage?.getItem(state.leftKey) === "1") flagged = true;
    storage?.setItem(state.leftKey, "");
  } catch {
    // 메모리 표시로만 판단
  }
  return flagged;
}

/** 학부모 범위의 다음 기록 — 2026-11-17 학부모 세션이 정한 규칙 그대로(상태만 범위별 묶음에서 읽는다) */
function nextParentRecord(
  state: ScopeState,
  prev: string[],
  entry: string,
  storage: StorageLike | null,
  env: PageLoadEnv | null,
  leftScope: boolean,
  viaPop: boolean | undefined,
): string[] {
  if (state.firstRecordOfPage) {
    state.firstRecordOfPage = false;
    const replaced = takeReplaceFlag(state, storage);
    if (env && shouldRestartOnPageLoad(prev, entry, env)) return [entry]; // 학부모 화면 밖을 거쳐 왔다 → 바깥으로 돌아가는 «←» 를 만들지 않는다
    if (replaced && prev.length > 0) return [...prev.slice(0, -1), entry]; // location.replace — 지금 칸을 바꿔 끼움
    return nextInAppHistory(prev, entry);
  }
  if (leftScope) {
    takeReplaceFlag(state, storage); // 남은 «바꿔 끼우기» 표시는 버린다 — 다음 이동까지 남으면 엉뚱한 칸을 바꿔 끼운다(2026-11-17 검수)
    return [entry]; // 화면 안 이동으로 학부모 화면 밖(로그인·공개 홈)을 다녀왔다
  }
  if (takeReplaceFlag(state, storage) && prev.length > 0) {
    // 화면 안 이동인데 router.replace 였다(«←» 가 기록 없이 한 단계 위로 갈 때, 2026-11-17).
    // 브라우저 기록은 칸이 바뀌기만 했으니 우리 기록도 쌓지 않고 바꿔 끼운다 — 쌓으면 위 화면의 «←» 가 방금 화면으로 되돌아간다
    // 홈으로 바꿔 끼우면(완료 화면 «홈으로») 홈은 첫 화면 — 새로 시작
    return pathOf(entry) === PARENT_HISTORY_SCOPE ? [entry] : [...prev.slice(0, -1), entry];
  }
  return nextInAppHistory(prev, entry, IN_APP_HISTORY_MAX, viaPop);
}

/** 선생님·관리자 범위의 다음 기록(2026-11-17) */
function nextStaffOrAdminRecord(
  scope: HistoryScope,
  state: ScopeState,
  prev: string[],
  entry: string,
  storage: StorageLike | null,
  env: PageLoadEnv | null,
  leftScope: boolean,
): string[] {
  const first = state.firstRecordOfPage;
  state.firstRecordOfPage = false;
  // «바꿔 끼우기» 표시는 어느 갈래로 가든 이번 기록에서 한 번 꺼낸다(다음 이동까지 남으면 엉뚱한 칸을 바꿔 끼운다)
  const replaced = takeReplaceFlag(state, storage);
  // 이 범위를 떠났다 돌아왔다(로그인·공개 홈·다른 역할 화면) → 새로 시작.
  // 문서의 첫 기록에서도 본다(검수 R1): 떠난 뒤 «통째 이동»으로 같은 주소에 돌아오면 «새로고침»으로 읽혀 옛 기록을 이어 붙였다
  if (leftScope) return [entry];
  if (first && env) {
    // 문서를 이 범위 밖에서 불러온 뒤 화면 안 이동으로 들어온 첫 화면(예: 관리자 → «화면 전환» → 선생님).
    // 이때 document.referrer 는 «앞 문서»를 불러올 때 값이라 이 범위에 어떻게 들어왔는지 말해 주지 못한다
    if (env.documentPath != null && !isScopePath(env.documentPath, scope)) return [entry];
    // «새로고침이라 이어 간다»는 기록 맨 끝이 지금 주소인 것만으로 정하지 않고, 문서를 불러온 방식으로 확인한다(검수 R1).
    // 방식을 못 읽는 브라우저는 예전 규칙(맨 끝 = 지금 주소면 새로고침)
    const sameAsLast = prev.length > 0 && prev[prev.length - 1] === entry;
    const reloaded = sameAsLast && (env.navigationType == null || env.navigationType === "reload" || env.navigationType === "back_forward");
    if (shouldRestartOnPageLoad(reloaded ? prev : [], entry, env, scope)) return [entry]; // 범위 밖을 거쳐 왔다
  }
  // router.replace·location.replace — 지금 칸을 바꿔 끼운 이동(«←» 가 기록 없이 역할 홈으로 갈 때 등)
  return nextScopeHistory(replaced ? prev.slice(0, -1) : prev, entry);
}

/**
 * 화면이 바뀔 때 부른다(ScopeHistoryTracker·ParentHistoryTracker). 저장 실패는 조용히 메모리로만.
 * 범위마다 기록·첫 기록 판정·표시가 따로라서, 다른 범위의 이동은 이 범위 기록을 건드리지 않는다.
 */
export function recordScopeNavigation(
  scope: HistoryScope,
  entry: string,
  storage: StorageLike | null = sessionStore(),
  env: PageLoadEnv | null = currentEnv(),
): string[] {
  const state = SCOPE_STATES[scope];
  const prev = readScopeHistory(scope, storage);
  const leftScope = takeLeftFlag(state, storage);
  // «뒤로» 표시는 어느 갈래로 가든 이번 기록에서 한 번 꺼낸다 — 다른 갈래에서 남으면 다음 링크 이동을 «뒤로»로 읽는다(2026-11-17 검수)
  const viaPop = takePopFlag(state);
  const next = state.strict
    ? nextStaffOrAdminRecord(scope, state, prev, entry, storage, env, leftScope)
    : nextParentRecord(state, prev, entry, storage, env, leftScope, viaPop);
  state.memoryStack = next;
  try {
    storage?.setItem(state.historyKey, JSON.stringify(next));
  } catch {
    // 저장 공간이 가득 찼거나 막힘 — 메모리 기록으로 계속
  }
  version += 1;
  listeners.forEach((listener) => listener());
  return next;
}

/** 학부모 화면 기록(기존 이름·기존 인자 그대로) */
export function recordInAppNavigation(
  entry: string,
  storage: StorageLike | null = sessionStore(),
  env: PageLoadEnv | null = currentEnv(),
): string[] {
  return recordScopeNavigation(PARENT_HISTORY_SCOPE, entry, storage, env);
}

/** 기록이 바뀌면 뒤로 버튼이 다시 그려지게(useSyncExternalStore 용) — 모든 범위가 한 번호를 같이 쓴다 */
export function subscribeInAppHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function inAppHistoryVersion(): number {
  return version;
}

/**
 * 지금 화면에서 router.back() 해도 되나 — 경로가 속한 범위(학부모·선생님·관리자)의 기록으로 판단한다.
 * true = 이 탭 안에 그 범위 화면 기록이 있고 브라우저 기록도 2칸 이상(새 탭으로 열려 기록이 복사된 경우를 거른다)
 * false = 기록 없음 → 고정 주소로
 * null = 세 범위 밖이거나 아직 이 화면을 기록하지 못함
 */
export function scopeHistoryDecision(pathname: string): boolean | null {
  if (typeof window === "undefined") return null;
  const scope = scopeOfPath(pathname);
  if (!scope) return null;
  const decision = hasInAppHistory(readScopeHistory(scope), pathname);
  if (decision !== true) return decision;
  try {
    return window.history.length > 1;
  } catch {
    return false;
  }
}

/**
 * 학부모 화면에서 router.back() 해도 되나(기존 이름).
 * null = 학부모 화면이 아니거나 아직 이 화면을 기록하지 못함 → 부르는 쪽의 옛 방식으로
 */
export function parentHistoryDecision(pathname: string): boolean | null {
  return isParentScopePath(pathname) ? scopeHistoryDecision(pathname) : null;
}
