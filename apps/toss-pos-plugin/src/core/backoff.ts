// 폴링 간격·재시도(지수 백오프) 계산 — 순수 함수.
// 근거: https://docs.tossplace.com/reference/plugin-sdk/pos/rateLimit.html
//   «이벤트를 제외한 모든 요청» 이 60초 100번 · 30분 200번(둘 다 동시 적용)으로 제한된다. http 호출도 포함이다.
//
// 2026-11-08 롱폴링으로 전환(원장 요청 «사이트에서 누르면 POS 결제창이 바로»):
//   워커가 «최대 20초 기다려 줘»(?wait=20) 하고 물으면 서버가 새 요청이 생기는 즉시 답한다 → 보통 1~2초 안에 결제창.
//   정상일 때: 20초마다 1번 = 30분 90번 · 60초 3번. 남은 110번을 결제 처리(건당 SDK 호출 약 13번)에 쓴다.
//   서버가 계속 «일찍» 답하는 이상 상황(새 요청이 연달아 오거나 버그)에는 다음 대기 전 쉬는 시간을
//   0초 → 1초 → 2초 → 4초 → 8초 → 14초로 늘린다 → 최악에도 30분 133번(결제 처리 몫 67번 = 약 5건 남음).
//   서버가 wait 를 모르는 옛 서버면(응답에 waitSec 없음) 예전처럼 14초(±10%) 간격으로 묻는다.
//   탭 화면은 별도 플러그인이라 한도를 따로 쓴다.

/** 롱폴링 한 번에 서버에 기다려 달라는 초(서버 상한 20초와 같다) */
export const LONG_POLL_WAIT_SEC = 20;
/** 서버가 이보다 일찍 답하면 «일찍 돌아옴»(새 요청이 있었다)으로 센다 — 대기 20초에서 2초 여유 */
export const EARLY_RETURN_MS = (LONG_POLL_WAIT_SEC - 2) * 1000;

/** 옛 서버(롱폴링 모름)일 때의 간격, 그리고 «일찍 돌아옴»이 계속될 때 쉬는 시간의 상한 */
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

/**
 * 롱폴링 성공 뒤 다음 대기를 걸기까지 쉬는 시간과 «연속 일찍 돌아옴» 횟수.
 * - 옛 서버(longPoll=false) → 예전 간격(14초 ±10%)
 * - 서버가 대기를 다 채우고 답함(새 요청 없음) → 0초, 횟수 초기화
 * - 일찍 답함(새 요청) → 1번째 0초, 2번째 1초, 3번째 2초 … 최대 14초
 */
export function nextAfterLongPoll(
  p: { longPoll: boolean; elapsedMs: number; earlyStreak: number },
  opts: { random?: number } = {},
): { delayMs: number; earlyStreak: number } {
  if (!p.longPoll) return { delayMs: nextPollDelay(0, { random: opts.random }), earlyStreak: 0 };
  if (p.elapsedMs >= EARLY_RETURN_MS) return { delayMs: 0, earlyStreak: 0 };
  const streak = Math.max(0, Math.floor(p.earlyStreak)) + 1;
  const delayMs = streak === 1 ? 0 : Math.min(POLL_BASE_MS, 1000 * 2 ** (streak - 2));
  return { delayMs, earlyStreak: streak };
}

/**
 * 요청 한도 검산용 — windowMs 동안 롱폴링을 최대 몇 번 하는지.
 * 정상(매번 대기를 다 채움)이면 20초에 1번, 최악(계속 일찍 돌아옴)이면 쉬는 시간 0·1·2·4·8·14·14… 만큼만 벌어진다.
 */
export function maxLongPollsIn(windowMs: number, mode: "normal" | "worst"): number {
  if (mode === "normal") return Math.ceil(windowMs / (LONG_POLL_WAIT_SEC * 1000));
  let t = 0;
  let n = 0;
  let streak = 0;
  while (t <= windowMs) {
    n += 1; // 이번 요청(응답 시간 0 으로 가정 = 가장 촘촘한 경우)
    const next = nextAfterLongPoll({ longPoll: true, elapsedMs: 0, earlyStreak: streak });
    streak = next.earlyStreak;
    t += next.delayMs;
    if (next.delayMs === 0 && n > 1000) break; // 안전장치(일어나지 않음)
  }
  return n;
}
