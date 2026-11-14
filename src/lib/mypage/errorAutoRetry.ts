/**
 * 학부모 화면 오류 직후 «자동으로 한 번만» 다시 불러오기 규칙(2026-11-14).
 *
 * 왜: 서버 요청 하나가 순간 끊겨(연결 직후 끊김) 화면이 통째로 오류 안내가 된 일이 있었다.
 * 이런 오류는 대개 바로 다시 불러오면 된다 → 1초 뒤 자동으로 한 번 다시 시도한다.
 * 무한 반복 금지: 같은 화면(경로)은 1분 안에 한 번만. 그래도 실패하면 지금 안내(다시 시도·홈으로) 그대로.
 * 기억은 sessionStorage(탭마다) — 오류 화면이 다시 그려져도(부품이 새로 만들어져도) 횟수가 유지된다.
 */

export const AUTO_RETRY_KEY_PREFIX = "stiz:mypage-error-autoretry:";
/** 같은 화면에서 자동 재시도를 다시 허락하기까지의 시간 */
export const AUTO_RETRY_WINDOW_MS = 60_000;
/** 오류 직후 자동 재시도까지 기다리는 시간 */
export const AUTO_RETRY_DELAY_MS = 1_000;

type StorageLike = Pick<Storage, "getItem" | "setItem">;

/** sessionStorage 가 막힌 브라우저용 — 이 탭이 살아 있는 동안만 기억 */
const memory = new Map<string, number>();

function lastAutoRetryAt(storage: StorageLike | null, key: string): number {
  let last = memory.get(key) ?? 0;
  try {
    const stored = Number(storage?.getItem(key) ?? 0);
    if (Number.isFinite(stored) && stored > last) last = stored;
  } catch {
    // 읽기 실패 — 메모리 값으로 판단
  }
  return last;
}

/** 자동 재시도를 할 수 있는 상태인가 — 기록은 남기지 않는다(첫 그림을 판정 결과대로 그리는 데 쓴다) */
export function canAutoRetry(storage: StorageLike | null, pathname: string, nowMs: number): boolean {
  const last = lastAutoRetryAt(storage, `${AUTO_RETRY_KEY_PREFIX}${pathname}`);
  return !(last > 0 && nowMs - last < AUTO_RETRY_WINDOW_MS);
}

/**
 * 이번 오류에 자동 재시도를 해도 되나 — 된다면 그 사실을 바로 기록한다(두 번째부터는 false).
 * storage 접근이 실패해도 메모리 기록으로 1회 제한은 지킨다.
 */
export function claimAutoRetry(storage: StorageLike | null, pathname: string, nowMs: number): boolean {
  const key = `${AUTO_RETRY_KEY_PREFIX}${pathname}`;
  const last = lastAutoRetryAt(storage, key);
  if (last > 0 && nowMs - last < AUTO_RETRY_WINDOW_MS) return false;
  memory.set(key, nowMs);
  try {
    storage?.setItem(key, String(nowMs));
  } catch {
    // 쓰기 실패 — 메모리 기록만으로도 이 탭에서는 1회 제한
  }
  return true;
}
