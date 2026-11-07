// 폴링 간격·재시도(지수 백오프) 계산 — 순수 함수.
// 근거: https://docs.tossplace.com/reference/plugin-sdk/pos/rateLimit.html
//   «이벤트를 제외한 모든 요청» 이 60초 100번 · 30분 200번(둘 다 동시 적용)으로 제한된다.
//   http 호출도 포함이다. 2026-11-08 원장 요청(«사이트에서 누르면 POS 결제창이 바로»)으로
//   30초 → 14초(±10%)로 줄였다: 가장 짧게 흔들려도 12.6초 = 30분 143번, 남은 57번을 결제 처리
//   (선점·주문 담기·결제 화면·보고, 건당 약 8번)에 쓴다. 탭 화면은 별도 플러그인이라 한도를 따로 쓴다.

export const POLL_BASE_MS = 14_000;
/** 흔들기 폭(±10%). 넓히면 가장 짧은 간격이 줄어 요청 한도를 넘을 수 있다 */
export const POLL_JITTER = 0.1;
/** 실패가 이어져도 최대 10분에 한 번은 다시 시도한다 */
export const POLL_MAX_MS = 10 * 60_000;
/** 요청 제한에 걸리면 최소 2분은 쉰다 */
export const RATE_LIMIT_MIN_MS = 2 * 60_000;

export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  /** 0~1 사이 난수. 테스트에서는 고정값을 넣는다 */
  random?: number;
  rateLimited?: boolean;
};

/**
 * 다음 폴링까지 기다릴 시간(ms).
 * failures = 연속 실패 횟수(0 = 정상). 실패할수록 2배씩 늘고 상한에서 멈춘다.
 * ±10% 흔들기(jitter)로 여러 기기가 같은 순간에 몰리지 않게 한다.
 */
export function nextPollDelay(failures: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? POLL_BASE_MS;
  const max = opts.maxMs ?? POLL_MAX_MS;
  const r = opts.random ?? Math.random();
  const n = Math.max(0, Math.min(30, Math.floor(failures)));
  let delay = Math.min(max, base * 2 ** n);
  if (opts.rateLimited) delay = Math.max(delay, RATE_LIMIT_MIN_MS);
  const jitter = 1 - POLL_JITTER + 2 * POLL_JITTER * Math.min(1, Math.max(0, r));
  // 흔들어도 상한을 넘지 않게, 그리고 기본 간격의 90% 밑으로는 내려가지 않게
  return Math.round(Math.min(max, delay * jitter));
}

/** 정해진 시간 동안 최대 몇 번 폴링하는지(가장 짧게 흔들린 경우) — 요청 제한 검산용 */
export function maxPollsIn(windowMs: number, baseMs = POLL_BASE_MS): number {
  return Math.ceil(windowMs / (baseMs * (1 - POLL_JITTER)));
}
