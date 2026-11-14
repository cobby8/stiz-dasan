/**
 * 시간 제한이 있는 조회(2026-11-15 검수 — 체육관처럼 통신이 느린 곳에서 목록 조회가 답 없이 멈추면
 * 화면이 영원히 «준비 중…»에 머물렀다). 제한 시간이 지나면 요청을 끊고 «실패»로 떨어뜨려 «다시 시도»가 나오게 한다.
 *
 * - AbortSignal.timeout 이 없는 옛 웹뷰도 있어 AbortController + setTimeout 으로 직접 끊는다.
 * - signal(바깥 신호)을 넘기면 화면이 사라질 때 함께 끊을 수 있다.
 * 다른 모듈을 import 하지 않는다(테스트가 그대로 실행한다).
 */
export const LIST_FETCH_TIMEOUT_MS = 10_000;
export const FETCH_TIMEOUT_MESSAGE = "연결이 느려 불러오지 못했습니다. 다시 시도해 주세요.";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  options: { timeoutMs?: number; signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? LIST_FETCH_TIMEOUT_MS);
  // 바깥 신호(화면이 사라짐)가 끊기면 이 요청도 끊는다
  const outer = options.signal;
  const onOuterAbort = () => controller.abort();
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener("abort", onOuterAbort);
  try {
    return await (options.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
  } catch (error) {
    // 시간 초과로 우리가 끊은 것이면 알아볼 수 있는 한국어 문구로 바꾼다(그 밖의 오류는 그대로)
    if (timedOut) throw new Error(FETCH_TIMEOUT_MESSAGE);
    throw error;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}

/** 올리기가 이만큼(ms) 한 바이트도 나아가지 않으면 멈춘 것으로 보고 끊는다 — 큰 영상이라 «전체 시간»이 아니라 «무진행 시간»으로 잰다 */
export const UPLOAD_STALL_TIMEOUT_MS = 60_000;
export const UPLOAD_STALLED_MESSAGE = "영상 올리기가 멈췄습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.";

/**
 * 무진행 감시 — touch() 를 부를 때마다 시간을 다시 재고, 제한 시간 동안 touch 가 없으면 onStall 을 한 번 부른다.
 * stop() 으로 끝낸다(성공·실패·취소 뒤).
 */
export function createStallWatch(onStall: () => void, timeoutMs: number = UPLOAD_STALL_TIMEOUT_MS) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const touch = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { if (!stopped) { stopped = true; onStall(); } }, timeoutMs);
  };
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
  return { touch, stop };
}
