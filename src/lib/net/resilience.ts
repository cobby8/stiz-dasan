/**
 * 바깥 요청·보조 조회가 한 번 흔들려도 화면이 통째로 오류가 되지 않게 하는 작은 도구(2026-11-14).
 *
 * 계기: 학부모 리포트 화면이 서버 요청 하나의 «fetch failed / other side closed»(연결 직후 끊김)로
 * 오류 화면이 됐다. 이런 끊김은 대개 한 번 더 시도하면 붙고, 응답을 무한정 기다리면 화면이 멈춘다.
 * → (1) 바깥 요청에 시간 제한 + 짧은 재시도 1회, (2) 화면에 꼭 필요하지 않은 조회는 실패해도 기본값.
 *
 * 순수 모듈(외부 의존 없음) — 테스트가 실제로 실행해서 확인한다(tests/parent-back-nav.test.mjs).
 */

type FetchInit = RequestInit & { next?: { revalidate?: number | false; tags?: string[] } };
type FetchFn = (input: string, init?: FetchInit) => Promise<Response>;

export type RetryFetchOptions = {
  /** 한 번 시도에 기다리는 최대 시간(기본 5초) */
  timeoutMs?: number;
  /** 연결 실패·시간 초과 때 다시 시도하는 횟수(기본 1회) */
  retries?: number;
  /** 다시 시도 전 잠깐 쉬는 시간(기본 300ms) */
  retryDelayMs?: number;
  /** 테스트용 — 기본은 전역 fetch */
  fetchImpl?: FetchFn;
};

export const DEFAULT_FETCH_TIMEOUT_MS = 5_000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 시간 제한 + 재시도 fetch.
 * - 다시 시도하는 경우: 응답을 아예 못 받은 경우(연결 끊김·DNS·시간 초과) 만.
 * - 다시 시도하지 않는 경우: 응답을 받은 경우(404·500 포함) — 상태 처리는 부르는 쪽 몫 그대로.
 * - 마지막 시도까지 실패하면 그 오류를 그대로 던진다(부르는 쪽의 기존 catch·기본값 처리가 그대로 동작).
 * ⚠️ 같은 요청이 두 번 가도 괜찮은 요청(조회·토큰 발급)에만 쓴다. 문자·알림 «발송»에는 쓰지 않는다(중복 발송).
 */
export async function fetchWithRetry(input: string, init: FetchInit = {}, options: RetryFetchOptions = {}): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const retries = Math.max(0, options.retries ?? 1);
  const retryDelayMs = options.retryDelayMs ?? 300;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchFn);
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // 시도마다 새 시간 제한(앞 시도의 제한 시간이 다음 시도를 끊지 않게)
      return await fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      lastError = error;
      if (attempt < retries) await delay(retryDelayMs);
    }
  }
  throw lastError;
}

export type FallbackHooks = {
  /** Next.js 의 이동 신호(redirect·notFound 등)는 삼키지 않고 다시 던진다 — 서버 쪽에서 unstable_rethrow 를 넘긴다 */
  rethrow?: (error: unknown) => void;
  /** 어느 단계가 실패했는지 남긴다(기본 console.error) */
  log?: (message: string, error: unknown) => void;
};

/**
 * 화면에 꼭 필요하지 않은 조회 — 실패하면 기본값으로 그리고 «어느 단계»인지 기록만 남긴다.
 * ⚠️ 로그인 확인·«볼 수 있는가»(권한) 판정에는 쓰지 않는다. 그건 실패하면 막혀야 한다.
 */
export async function withFallback<T>(stage: string, load: () => Promise<T>, fallback: T, hooks: FallbackHooks = {}): Promise<T> {
  try {
    return await load();
  } catch (error) {
    hooks.rethrow?.(error);
    (hooks.log ?? ((message, e) => console.error(message, e)))(`[보조 조회 실패 — 기본값으로 계속] ${stage}`, error);
    return fallback;
  }
}
