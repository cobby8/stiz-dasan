// 스토어에 지금 올라와 있는 앱의 최신 버전을 서버가 스스로 알아낸다(2026-11-15 원장: «업데이트 나오면 알림»).
//
// 왜 서버가 읽나: 코드에 «최신 버전» 숫자를 적어 두면 앱을 낼 때마다 웹도 고쳐 배포해야 하고, 잊으면 안내가 안 뜬다.
// 두 스토어는 공개 시점도 다르다(심사). 그래서 스토어에 직접 물어보고, 못 읽으면 코드의 «바닥값»으로 떨어진다.
//
// ⚠️ 서버 전용 — 화면(클라이언트) 코드에서 import 하지 않는다. 부르는 곳은 공개 라우트 /api/app/latest-version 하나다.
//    (루트 레이아웃에서 부르지 않는다 — 스토어가 늦으면 모든 화면의 서버 그림이 같이 늦어진다. 앱 안의 배너만 그 라우트를 부른다)
// ⚠️ 바깥으로 보내는 요청에는 사용자 정보·쿠키·식별자를 붙이지 않는다(일반 User-Agent 만).
import { cache } from "react";
import { unstable_cache } from "next/cache";
import { IOS_APP_STORE_ID, PLAY_STORE_URL } from "@/lib/app-install-links";
import { STORE_APP_KNOWN_LATEST, isStoreVersion, resolveStoreAppLatest, resolveStoreVersion, type StoreAppLatest } from "@/lib/storeApp";

// 바닥값(STORE_APP_KNOWN_LATEST)과 «읽은 값 vs 바닥값» 고르기는 화면(배너)도 쓰므로 @/lib/storeApp 에 있다 — 여기서는 다시 내보내기만 한다
export { STORE_APP_KNOWN_LATEST, resolveStoreVersion, resolveStoreAppLatest };

/** 스토어 조회 결과를 다시 쓰는 시간 — 6시간(초) */
export const STORE_VERSION_REVALIDATE_SECONDS = 21600;
/** 스토어 한 곳을 기다리는 최대 시간 — 3초 */
export const STORE_VERSION_TIMEOUT_MS = 3000;
/** 읽기에 실패한 뒤 다시 시도하지 않고 바닥값을 쓰는 시간 — 10분(실패가 이어질 때 화면마다 3초씩 기다리지 않게) */
const FAILURE_COOLDOWN_MS = 10 * 60 * 1000;

const ITUNES_LOOKUP_URL = `https://itunes.apple.com/lookup?id=${IOS_APP_STORE_ID}&country=kr`;
// Play 주소는 주소 상수 한 곳(app-install-links)에서 받아 한국어·한국 스토어 표시만 덧붙인다(스토어 주소를 여기 다시 적지 않는다)
const PLAY_DETAILS_URL = `${PLAY_STORE_URL}&hl=ko&gl=KR`;
// 누구인지 드러나지 않는 일반 이름
const GENERIC_USER_AGENT = "Mozilla/5.0 (compatible; app-version-check)";

/**
 * Play 상세 페이지 HTML 에서 버전을 읽는다(순수). 페이지 안 자료에 `[[["1.0.3"]]` 모양으로 들어 있다.
 * 공식 조회 창구가 아니라 페이지 구조가 바뀌면 못 읽는다 → null(바닥값으로 떨어진다).
 * 같은 모양이 여러 개면 «가장 많이 나온 값», 횟수가 같으면 «먼저 나온 값»을 쓴다.
 * (엉뚱하게 높은 값은 resolveStoreVersion 의 상한이 한 번 더 거른다)
 */
export function parsePlayStoreVersion(html: unknown): string | null {
  if (typeof html !== "string") return null;
  const counts = new Map<string, number>(); // Map 은 넣은 순서를 기억한다 — 먼저 나온 값이 앞
  for (const match of html.matchAll(/\[\[\["(\d+(?:\.\d+){1,3})"\]\]/g)) {
    if (isStoreVersion(match[1])) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [version, count] of counts) {
    if (count > bestCount) { best = version; bestCount = count; }
  }
  return best;
}

/** App Store 공식 조회(itunes lookup) 응답에서 버전을 읽는다(순수). 글자(JSON)·객체 둘 다 받는다 */
export function parseItunesLookupVersion(body: unknown): string | null {
  try {
    const data = typeof body === "string" ? JSON.parse(body) : body;
    const version = (data as { results?: { version?: unknown }[] } | null)?.results?.[0]?.version;
    return isStoreVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/** 주소 하나를 3초 안에 글자로 읽는다. 실패(시간 초과·오류 응답·통신 오류)는 전부 null */
async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      // 응답 글자는 캐시에 넣지 않는다 — Play 페이지가 1MB 를 넘어 캐시 한 칸 한도(2MB)에 가깝다.
      // 대신 아래 unstable_cache 가 «읽어 낸 버전 글자»만 6시간 기억한다.
      cache: "no-store",
      credentials: "omit",
      headers: { "User-Agent": GENERIC_USER_AGENT, "Accept-Language": "ko" },
      signal: AbortSignal.timeout(STORE_VERSION_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

type StoreRead = { android: string | null; ios: string | null };

/** 한쪽이라도 못 읽으면 던진다 — 던지면 캐시에 저장되지 않아, 실패 결과를 6시간 붙들고 있지 않는다(읽은 쪽 값은 실어 보낸다) */
class StoreReadError extends Error {
  constructor(public partial: StoreRead) {
    super("store version read failed");
  }
}

// 두 스토어를 동시에 읽어 «버전 글자 두 개»만 6시간 기억한다.
// 기억한 값이 오래되면 화면은 옛 값을 바로 받고 뒤에서 다시 읽는다(화면이 스토어를 기다리지 않는다).
// 뒤에서 다시 읽다 실패하면 마지막으로 읽은 값이 그대로 남는다.
const readStoresCached = unstable_cache(
  async (): Promise<StoreRead> => {
    const [playHtml, itunesBody] = await Promise.all([fetchText(PLAY_DETAILS_URL), fetchText(ITUNES_LOOKUP_URL)]);
    const read: StoreRead = { android: parsePlayStoreVersion(playHtml), ios: parseItunesLookupVersion(itunesBody) };
    if (!read.android || !read.ios) throw new StoreReadError(read);
    return read;
  },
  ["store-app-latest-version-v1"],
  { revalidate: STORE_VERSION_REVALIDATE_SECONDS },
);

// 서버 인스턴스 안의 기억 — 마지막으로 쓴 값과 «실패 후 쉬는 시간»
let lastResolved: StoreAppLatest = STORE_APP_KNOWN_LATEST;
let retryAfterMs = 0;

/**
 * 스토어별 최신 버전 + «두 스토어를 다 읽었나»(complete). 절대 던지지 않고, 가장 나쁜 경우에도 약 3초 뒤 바닥값을 돌려준다.
 * complete 가 false 면 한쪽 이상이 바닥값이다 — 라우트가 그 응답을 CDN 에 짧게만 남긴다.
 * 같은 요청 안에서 여러 번 불러도 한 번만 읽는다(react cache).
 */
export const readStoreAppLatest = cache(async (): Promise<{ latest: StoreAppLatest; complete: boolean }> => {
  if (Date.now() < retryAfterMs) return { latest: lastResolved, complete: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 캐시 창구 자체가 늦는 경우까지 막는 바깥 시간 제한
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("store version timeout")), STORE_VERSION_TIMEOUT_MS + 500);
    });
    lastResolved = resolveStoreAppLatest(await Promise.race([readStoresCached(), timeout]));
    return { latest: lastResolved, complete: true };
  } catch (error) {
    // 읽은 쪽이 있으면 그 값은 쓰고, 못 읽은 쪽은 바닥값. 10분간은 다시 시도하지 않는다.
    retryAfterMs = Date.now() + FAILURE_COOLDOWN_MS;
    const partial = (error as { partial?: StoreRead } | null)?.partial;
    lastResolved = resolveStoreAppLatest(partial ?? null);
    return { latest: lastResolved, complete: false };
  } finally {
    if (timer) clearTimeout(timer);
  }
});

/** 스토어별 최신 버전만(던지지 않는다) */
export async function getStoreAppLatestVersions(): Promise<StoreAppLatest> {
  return (await readStoreAppLatest()).latest;
}
