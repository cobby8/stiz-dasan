// 기사님 운행 화면 «명단 새로 읽기» 규칙(2026-11-20 원장 지시 «고쳐줘»).
//
// 왜 필요한가: 운행 화면을 열어 둔 채로 관리자가 학생을 추가하면(예: 체험 셔틀 줄) 화면을 다시 열기 전까지 안 보였다.
//   보기 전용(선생님 «셔틀» 탭)만 30초마다 새로 읽고, 운행 모드는 날짜가 바뀔 때만 새로 읽었기 때문이다.
//
// 여기에는 화면(React)과 무관한 «판단»만 둔다 — 테스트가 실행해서 확인한다.

/** 30초마다 새로 읽는다(보기 전용과 같은 간격). */
export const DRIVER_RUN_REFRESH_MS = 30_000;
/** 연결 확인을 기다리는 시간. 넘으면 «연결이 약하다»로 본다. */
export const DRIVER_RUN_PROBE_TIMEOUT_MS = 4_000;
/** 연결 확인에 쓰는 아주 가벼운 정적 파일(로그인·DB 와 무관). */
export const DRIVER_RUN_PROBE_URL = "/favicon-v2.ico";

/**
 * 새로 읽기 방식.
 *  - auto   : 30초마다 + 화면으로 돌아올 때 자동으로 새로 읽는다
 *  - manual : 자동으로 읽지 않고 «명단 새로 읽기» 버튼만 보인다
 *  - none   : 지금은 읽지 않는다(순서 편집·순서 저장 중)
 */
export type DriverRunRefreshMode = "auto" | "manual" | "none";

/**
 * 지금 어떤 방식으로 새로 읽을지 정한다.
 *
 * 순서 편집·순서 저장 중에는 읽지 않는다 — 편집 원본(스냅샷)과 화면이 어긋나면 저장 대조가 틀어진다.
 *
 * 웹 위치 공유로 «운행 중»이면 자동으로 읽지 않는다. 새로 읽기(router.refresh)는 서버 응답을 못 받으면
 * 브라우저가 페이지를 통째로 다시 연다. 그러면 이 화면이 직접 돌리던 위치 전송(watchPosition)과 «운행 중» 상태가 사라진다.
 * 달리는 차 안은 신호가 자주 끊기므로, 이때는 기사님이 누를 때만 읽는다.
 * 앱(네이티브) 운행은 위치 전송이 앱 쪽에서 돌고 화면이 다시 열려도 «운행 중»을 되찾으므로 자동으로 읽는다.
 */
export function driverRunRefreshMode(input: {
  readOnly: boolean;
  editing: boolean;
  savingOrder: boolean;
  running: boolean;
  gpsMode: string;
}): DriverRunRefreshMode {
  if (input.readOnly) return "auto";
  if (input.editing || input.savingOrder) return "none";
  if (input.running && input.gpsMode !== "native") return "manual";
  return "auto";
}

/**
 * 서버가 새로 읽어 준 탑승 기록을 화면의 기록과 합친다.
 *
 * keepKeys(이 화면에서 누른 줄 — 저장 중·저장됨·실패·확인 필요)는 화면 값을 그대로 둔다.
 *   저장이 아직 서버에 닿지 않았거나 결과를 확인 중인 체크를 서버의 옛 값이 덮어쓰면 안 된다.
 * 그 밖의 줄은 서버 값을 따른다(새로 나타난 줄의 기록, 다른 기기에서 찍은 체크, 서버에서 지워진 기록).
 *
 * 바뀐 것이 없으면 받은 local 을 그대로 돌려준다(쓸데없이 다시 그리지 않게).
 */
export function mergeServerBoarding<S>(
  local: Readonly<Record<string, S>>,
  server: Readonly<Record<string, S>>,
  keepKeys: Iterable<string>,
): Record<string, S> {
  const keep = new Set(keepKeys);
  const next: Record<string, S> = {};
  for (const key of Object.keys(local)) if (keep.has(key)) next[key] = local[key];
  for (const key of Object.keys(server)) if (!keep.has(key)) next[key] = server[key];
  const localKeys = Object.keys(local), nextKeys = Object.keys(next);
  if (localKeys.length === nextKeys.length && nextKeys.every((key) => Object.prototype.hasOwnProperty.call(local, key) && local[key] === next[key])) {
    return local as Record<string, S>;
  }
  return next;
}
