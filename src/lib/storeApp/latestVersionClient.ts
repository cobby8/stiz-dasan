// 앱 안의 화면이 «스토어 최신 버전»을 알아 오는 방법(2026-11-15) — 브라우저 쪽 코드. React 를 쓰지 않아 테스트가 그대로 실행한다.
//
// 왜 화면이 물어보나: 루트 레이아웃(서버)이 스토어를 읽으면 스토어가 늦을 때 «모든 화면»이 같이 늦어진다.
// 업데이트 안내는 앱 사용자에게만 필요하므로, 앱 안일 때만 공개 라우트를 한 번 부른다.
//   - 브라우저 사용자: 요청을 아예 보내지 않는다(null).
//   - 같은 앱 실행 안에서는 6시간 동안 다시 부르지 않는다(sessionStorage).
//   - 요청 실패·시간 초과: 코드의 바닥값으로 판정한다(기억하지 않아 다음 화면에서 다시 시도).
import { STORE_APP_KNOWN_LATEST, isStoreVersion, resolveStoreAppLatest, type StoreAppLatest } from "@/lib/storeApp";

/** 최신 버전을 돌려주는 공개 라우트(src/app/api/app/latest-version/route.ts) */
export const APP_LATEST_VERSION_PATH = "/api/app/latest-version";
/** 기억 열쇠 — 앱 표식과 같은 sessionStorage(안드로이드 앱은 크롬과 저장소를 나눠 써서 localStorage 는 피한다) */
export const APP_LATEST_SESSION_KEY = "stiz-app-latest-version";
/** 기억하는 시간 — 6시간 */
export const APP_LATEST_SESSION_MS = 6 * 60 * 60 * 1000;
/** 라우트를 기다리는 최대 시간 — 4초 */
export const APP_LATEST_FETCH_TIMEOUT_MS = 4000;

type StorageLike = { getItem(key: string): string | null; setItem(key: string, value: string): void };
type FetchLike = (url: string, init: { signal?: AbortSignal; credentials: "omit"; headers: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** 기억해 둔 글자에서 아직 쓸 수 있는 값을 꺼낸다(순수 — 시각은 인자). 6시간이 지났거나 모양이 이상하면 null */
export function readRememberedLatest(raw: string | null | undefined, nowMs: number): StoreAppLatest | null {
  try {
    const saved = JSON.parse(String(raw ?? "")) as { at?: unknown; android?: unknown; ios?: unknown } | null;
    if (!saved || typeof saved.at !== "number") return null;
    const elapsed = nowMs - saved.at;
    if (!(elapsed >= 0 && elapsed < APP_LATEST_SESSION_MS)) return null;
    if (!isStoreVersion(saved.android) || !isStoreVersion(saved.ios)) return null;
    return resolveStoreAppLatest(saved);
  } catch {
    return null;
  }
}

/**
 * 스토어 최신 버전을 알아 온다.
 *   - 앱 안이 아니면 null — 요청도 저장소 읽기도 하지 않는다.
 *   - 기억한 값이 있으면 그 값(요청 없음).
 *   - 라우트를 한 번 부르고, 실패하면 바닥값.
 * 던지지 않는다. 요청에는 쿠키를 붙이지 않는다(공개 정보 — CDN 캐시가 그대로 답하게).
 */
export async function loadStoreAppLatest(input: {
  inApp: boolean;
  fetchImpl: FetchLike;
  storage: StorageLike | null;
  nowMs: number;
}): Promise<StoreAppLatest | null> {
  if (!input.inApp) return null;

  let remembered: StoreAppLatest | null = null;
  try {
    remembered = readRememberedLatest(input.storage?.getItem(APP_LATEST_SESSION_KEY), input.nowMs);
  } catch {
    // 저장소를 못 쓰는 환경 — 그냥 물어본다
  }
  if (remembered) return remembered;

  try {
    // 오래된 웹뷰에는 AbortSignal.timeout 이 없을 수 있다 — 없으면 시간 제한 없이 부른다(화면은 기다리지 않는다)
    const signal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(APP_LATEST_FETCH_TIMEOUT_MS) : undefined;
    const response = await input.fetchImpl(APP_LATEST_VERSION_PATH, { signal, credentials: "omit", headers: { Accept: "application/json" } });
    if (!response.ok) return STORE_APP_KNOWN_LATEST;
    // 값이 이상하거나 바닥보다 낮으면(오래된 캐시) 바닥값으로 올린다
    const latest = resolveStoreAppLatest(await response.json() as { android?: unknown; ios?: unknown } | null);
    try {
      input.storage?.setItem(APP_LATEST_SESSION_KEY, JSON.stringify({ at: input.nowMs, ...latest }));
    } catch {
      // 기억하지 못해도 이번 판정은 한다
    }
    return latest;
  } catch {
    return STORE_APP_KNOWN_LATEST;
  }
}
