// 스토어 앱의 최신 버전(공개 정보) — 앱 안의 업데이트 안내 배너만 부른다(2026-11-15).
// 로그인 확인이 없고 입력도 받지 않는다. 돌려주는 것은 { android, ios } 두 글자뿐이다.
// 스토어를 못 읽어도 200 + 바닥값을 준다(배너는 그 값으로 판정한다).
import { STORE_APP_KNOWN_LATEST } from "@/lib/storeApp";
import { readStoreAppLatest } from "@/lib/storeApp/latestVersion";

// 두 스토어를 다 읽었을 때: CDN 이 6시간 기억하고, 그 뒤 하루는 옛 값을 바로 주면서 뒤에서 새로 읽는다 — 요청 대부분이 서버까지 오지 않는다
const CACHE_CONTROL = "public, s-maxage=21600, stale-while-revalidate=86400";
// 못 읽어서 바닥값이 섞였을 때: 10분만 — 바닥값 응답이 CDN 에 6시간 남아 새 버전 안내가 늦어지지 않게
const CACHE_CONTROL_FALLBACK = "public, s-maxage=600, stale-while-revalidate=600";

export async function GET() {
  let latest = STORE_APP_KNOWN_LATEST;
  let complete = false;
  try {
    ({ latest, complete } = await readStoreAppLatest());
  } catch {
    // 조회 함수는 던지지 않게 만들었지만, 만약을 위해 여기서도 바닥값으로 받는다
  }
  return Response.json(
    { android: latest.android, ios: latest.ios },
    { status: 200, headers: { "Cache-Control": complete ? CACHE_CONTROL : CACHE_CONTROL_FALLBACK } },
  );
}
