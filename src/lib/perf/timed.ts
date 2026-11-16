// 조회 묶음의 «함수별 소요 시간»을 재는 작은 순수 도우미(2026-11-16 속도 개선).
//
// 왜 있나: 화면이 느릴 때 «병렬 묶음 중 어느 조회가 느린지»를 서버 로그로 보려는 것이다.
// 화면 동작·조회 순서는 바꾸지 않는다 — 이미 출발한 약속(promise)에 시계만 붙인다.
// 기록에는 이름과 숫자(ms)만 남긴다. 개인정보·id 를 넣지 않는다.
//
// 쓰는 법:
//   const timing = startTiming();
//   const [a, b] = await Promise.all([timed("a", readA(), timing), timed("b", readB(), timing)]);
//   reportTiming("[mypage timing]", timing, 300);   // 전체가 300ms 를 넘을 때만 한 줄

/** 경과 시간을 모으는 그릇 — startedAt 은 묶음이 출발한 때, parts 는 이름별 ms */
export type TimingSink = { startedAt: number; parts: Record<string, number> };

type Clock = () => number;

// 경과 시간만 재므로 시간대와 무관하다(달력 값이 아니다)
const defaultClock: Clock = () => performance.now();

/** 묶음 출발 시각을 찍은 빈 그릇을 만든다 */
export function startTiming(now: Clock = defaultClock): TimingSink {
  return { startedAt: now(), parts: {} };
}

/**
 * 약속이 끝날 때까지 걸린 시간을 sink.parts[name] 에 남기고, 결과는 그대로 돌려준다.
 * 실패해도 시간은 남기고 예외는 그대로 던진다(동작을 바꾸지 않는다).
 * 시작 시각은 그릇의 출발 시각이다 — 약속은 부르는 순간 이미 출발해 있기 때문이다.
 */
export async function timed<T>(name: string, promise: Promise<T>, sink: TimingSink, now: Clock = defaultClock): Promise<T> {
  try {
    return await promise;
  } finally {
    sink.parts[name] = Math.round(now() - sink.startedAt);
  }
}

/**
 * 전체 시간이 임계값(ms)을 «넘을 때만» 한 줄 기록한다. 기록했으면 true.
 * 기록 자체가 실패해도 화면은 죽지 않게 삼킨다.
 */
export function reportTiming(
  label: string,
  sink: TimingSink,
  thresholdMs: number,
  now: Clock = defaultClock,
  log: (label: string, detail: { total: number; parts: Record<string, number> }) => void = console.info,
): boolean {
  const total = Math.round(now() - sink.startedAt);
  if (!(total > thresholdMs)) return false;
  try {
    log(label, { total, parts: { ...sink.parts } });
  } catch {
    // 기록 실패는 무시한다
  }
  return true;
}
