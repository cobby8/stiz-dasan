/**
 * 학부모 화면(/mypage) 안 이동 기록 — 탭(창)마다 짧게 남긴다(2026-11-14).
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
export function nextInAppHistory(stack: readonly string[], entry: string, max = IN_APP_HISTORY_MAX): string[] {
  if (stack.length === 0) return [entry];
  const last = stack[stack.length - 1];
  if (last === entry) return [...stack]; // 1) 같은 주소
  const prev = stack.length >= 2 ? stack[stack.length - 2] : undefined;
  // 2) 바로 앞 화면으로 돌아옴 → pop (쿼리가 달라도 같은 화면이면 그 칸을 새 주소로)
  if (prev !== undefined && pathOf(prev) === pathOf(entry)) return [...stack.slice(0, -2), entry];
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

// ── 브라우저 쪽(저장·구독) — 서버에서는 아무 일도 하지 않는다 ──────────────────────

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function sessionStore(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null; // 사생활 보호 모드 등에서 접근 자체가 막힌 경우
  }
}

/** sessionStorage 가 막힌 브라우저에서도 그 탭이 살아 있는 동안은 기억한다 */
let memoryStack: string[] = [];
let version = 0;
const listeners = new Set<() => void>();

export function readInAppHistory(storage: StorageLike | null = sessionStore()): string[] {
  if (!storage) return memoryStack;
  try {
    return parseInAppHistory(storage.getItem(IN_APP_HISTORY_KEY));
  } catch {
    return memoryStack;
  }
}

/** 페이지를 «처음 불러온 직후»의 판단 재료(테스트에서 바꿔 넣을 수 있게 따로 받는다) */
export type PageLoadEnv = {
  /** document.referrer — 이 페이지를 불러오게 한 앞 주소(없으면 "") */
  referrer: string;
  /** window.location.origin */
  origin: string;
  /** window.history.length */
  historyLength: number;
};

/**
 * 페이지를 새로 불러온 직후의 첫 기록에서, 이어 오던 기록을 버리고 [지금 화면]으로 새로 시작할지.
 * 왜: sessionStorage 는 학부모 화면 «밖»(결제창 redirect·로그인·공개 홈페이지·카카오 등)을 거쳐 와도 남아 있다.
 *     그대로 이어 붙이면 «←» 가 history.back() 으로 그 바깥 화면(예: 결제창)에 돌아간다.
 * - 새로고침(기록 맨 끝 = 지금 주소)은 이어 간다 — 단, 브라우저 기록이 1칸뿐이면 새로 시작
 * - 브라우저 기록이 1칸뿐(앱을 막 열었거나 새 탭 — 새 탭은 sessionStorage 가 복사돼 올 수 있다) → 새로 시작
 * - 앞 주소가 없거나·다른 사이트거나·같은 사이트라도 /mypage 밖 → 새로 시작
 * - 앞 주소가 학부모 화면(/mypage/…) → 이어 간다(학부모 화면 안 전체 새로 불러오기)
 */
export function shouldRestartOnPageLoad(stack: readonly string[], entry: string, env: PageLoadEnv): boolean {
  if (env.historyLength <= 1) return true;
  if (stack.length > 0 && stack[stack.length - 1] === entry) return false; // 새로고침
  if (!env.referrer) return true;
  try {
    const ref = new URL(env.referrer);
    if (ref.origin !== env.origin) return true;
    return ref.pathname !== PARENT_HISTORY_SCOPE && !ref.pathname.startsWith(`${PARENT_HISTORY_SCOPE}/`);
  } catch {
    return true;
  }
}

/** 다음에 열리는 주소가 지금 칸을 «바꿔 끼우는»(location.replace) 이동이라는 표시 — 새 페이지의 첫 기록이 읽는다 */
export const IN_APP_REPLACE_KEY = "stiz:parent-nav-replace:v1";

/**
 * location.replace 직전에 부른다(예: MyPageClient 의 옛 홈 칸 주소 넘기기).
 * 실제 브라우저 기록에서 지금 칸이 새 주소로 바뀌므로, 우리 기록도 쌓지 않고 맨 끝을 바꿔 끼운다.
 */
export function markNextNavigationAsReplace(storage: StorageLike | null = sessionStore()) {
  replacePending = true;
  try {
    storage?.setItem(IN_APP_REPLACE_KEY, "1");
  } catch {
    // 저장이 막히면 표시가 사라진다 — 그 경우 한 칸 더 쌓일 뿐(뒤로가 학부모 화면 안에 머문다)
  }
}

/** 이 페이지(문서)에서 아직 첫 기록 전인가 — 전체 새로 불러오기마다 모듈이 새로 올라와 true 로 돌아온다 */
let firstRecordOfPage = true;
let replacePending = false;

function currentEnv(): PageLoadEnv | null {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return null;
    return { referrer: document.referrer || "", origin: window.location.origin, historyLength: window.history.length };
  } catch {
    return null;
  }
}

function takeReplaceFlag(storage: StorageLike | null): boolean {
  let flagged = replacePending;
  replacePending = false;
  try {
    if (storage?.getItem(IN_APP_REPLACE_KEY) === "1") flagged = true;
    storage?.setItem(IN_APP_REPLACE_KEY, "");
  } catch {
    // 읽기·쓰기 실패 — 메모리 표시로만 판단
  }
  return flagged;
}

/** 테스트 전용 — «페이지를 새로 불러온 직후» 상태로 되돌린다 */
export function resetPageLoadStateForTest() {
  firstRecordOfPage = true;
  replacePending = false;
  memoryStack = [];
}

/** 화면이 바뀔 때 부른다(ParentHistoryTracker). 저장 실패는 조용히 메모리로만 */
export function recordInAppNavigation(
  entry: string,
  storage: StorageLike | null = sessionStore(),
  env: PageLoadEnv | null = currentEnv(),
): string[] {
  const prev = readInAppHistory(storage);
  let next: string[];
  if (firstRecordOfPage) {
    firstRecordOfPage = false;
    const replaced = takeReplaceFlag(storage);
    if (env && shouldRestartOnPageLoad(prev, entry, env)) {
      next = [entry]; // 학부모 화면 밖을 거쳐 왔다 → 바깥으로 돌아가는 «←» 를 만들지 않는다
    } else if (replaced && prev.length > 0) {
      next = [...prev.slice(0, -1), entry]; // location.replace — 지금 칸을 바꿔 끼움
    } else {
      next = nextInAppHistory(prev, entry);
    }
  } else {
    next = nextInAppHistory(prev, entry);
  }
  memoryStack = next;
  try {
    storage?.setItem(IN_APP_HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 저장 공간이 가득 찼거나 막힘 — 메모리 기록으로 계속
  }
  version += 1;
  listeners.forEach((listener) => listener());
  return next;
}

/** 기록이 바뀌면 뒤로 버튼이 다시 그려지게(useSyncExternalStore 용) */
export function subscribeInAppHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function inAppHistoryVersion(): number {
  return version;
}

/**
 * 학부모 화면에서 router.back() 해도 되나.
 * true = 이 탭 안에 학부모 화면 기록이 있고 브라우저 기록도 2칸 이상(새 탭으로 열려 기록이 복사된 경우를 거른다)
 * false = 기록 없음 → 고정 주소로
 * null = 학부모 화면이 아니거나 아직 이 화면을 기록하지 못함 → 부르는 쪽의 옛 방식으로
 */
export function parentHistoryDecision(pathname: string): boolean | null {
  if (typeof window === "undefined") return null;
  if (pathname !== PARENT_HISTORY_SCOPE && !pathname.startsWith(`${PARENT_HISTORY_SCOPE}/`)) return null;
  const decision = hasInAppHistory(readInAppHistory(), pathname);
  if (decision !== true) return decision;
  try {
    return window.history.length > 1;
  } catch {
    return false;
  }
}
