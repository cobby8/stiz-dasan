/**
 * 스토어 앱(구글플레이·앱스토어에 올린 통합 앱)으로 열렸는지 — 브라우저 전용 판정.
 *
 * 왜 따로 알아야 하나: 기존 설치 앱(학부모·선생님·기사님 PWA)은 제 영역(/mypage·/staff·/driver)을
 * 벗어나면 브라우저로 새어 나가서, 그 밖으로 가는 링크를 막거나 숨긴다(useInstalledApp).
 * 스토어 앱은 **사이트 전체가 앱 영역**이라 이 제한이 필요 없고, 남겨 두면 「앱 밖으로 이동」 같은
 * 틀린 안내가 뜨거나 쓸 수 있는 링크가 사라진다.
 *
 * ⚠️ 표식은 sessionStorage 에 둔다. 안드로이드 스토어 앱(TWA)은 휴대폰의 크롬과 저장소를 공유한다.
 *    localStorage 에 두면 스토어 앱을 한 번 연 뒤 크롬·기존 설치 앱에서도 제한이 풀려, 2026-08 처럼
 *    설치 앱이 영역 밖으로 새는 사고가 다시 난다. sessionStorage 는 탭(앱 화면)마다 따로라 섞이지 않는다.
 *    스토어 앱은 실행할 때마다 시작 주소(/store-app)를 거치므로 그때 다시 찍힌다.
 */
export const STORE_APP_FLAG_KEY = "stiz-store-app";

export function markStoreApp() {
  try {
    window.sessionStorage.setItem(STORE_APP_FLAG_KEY, "1");
  } catch {
    // 저장소를 못 쓰면(사생활 보호 모드 등) 기존 설치 앱처럼 동작한다 — 링크가 덜 보일 뿐 새지는 않는다.
  }
}

/** 앱 1.0.1 부터 웹뷰 주소줄 대신 사용자 에이전트 끝에 붙는 표식 */
export const STORE_APP_USER_AGENT_MARK = " STIZApp/";

/**
 * 표식 없이도 스토어 앱임을 알아보는 순수 판정(2026-11-13 검수 보강) — 시작 주소(/store-app)를 거치지 않고
 * 열린 화면(알림 눌러 바로 열기 등)에서도 간편로그인이 다시 보이지 않게.
 * - 사용자 에이전트에 « STIZApp/» (앱 1.0.1+)
 * - 안드로이드 앱(TWA)이 연 첫 화면의 referrer 가 «android-app://»
 */
export function looksLikeStoreApp(input: { userAgent?: string | null; referrer?: string | null }): boolean {
  return String(input.userAgent ?? "").includes(STORE_APP_USER_AGENT_MARK)
    || String(input.referrer ?? "").startsWith("android-app://");
}

function hasStoreAppUserAgentMark(): boolean {
  try {
    return window.navigator.userAgent.includes(STORE_APP_USER_AGENT_MARK);
  } catch {
    return false;
  }
}

export function isStoreApp(): boolean {
  try {
    if (window.sessionStorage.getItem(STORE_APP_FLAG_KEY) === "1") return true;
  } catch {
    // 저장소를 못 써도 아래 사용자 에이전트·referrer 판정은 한다
  }
  try {
    if (looksLikeStoreApp({ userAgent: window.navigator.userAgent, referrer: document.referrer })) {
      markStoreApp(); // 같은 화면 묶음 안의 다음 이동에서도 바로 알아보게 표식을 찍는다
      return true;
    }
  } catch {
    // 브라우저 밖(서버) 등 — 브라우저로 본다
  }
  return false;
}

/**
 * 스토어 앱(현재 버전)이 아직 못 하는 일 — 출시 전 점검 d2(2026-11-13).
 *   push        앱 알림(웹푸시)
 *   links       바깥 주소(카카오채널·인스타·블로그·쇼핑몰·첨부파일 등) 열기
 *   geolocation 현재 위치 읽기
 *   voice       음성 입력(받아쓰기)
 *   install     «앱 설치» 안내(이미 앱이라 필요 없다)
 *   sms         문자 앱 열기(sms: 주소)
 *
 * 왜 «한 곳의 판정»인가: 앱 새 버전이 이 기능들을 지원하게 되면, 시작 주소에 `/store-app?caps=push,links`
 * 처럼 «할 수 있는 것»을 실어 보내기만 하면 화면 곳곳의 우회(버튼 숨김·주소 복사)가 자동으로 꺼진다.
 * 화면마다 따로 판정하면 앱이 바뀐 뒤에도 한쪽에만 우회가 남는다.
 */
export type StoreAppCapability = "push" | "links" | "geolocation" | "voice" | "install" | "sms";

export const STORE_APP_CAPS_KEY = "stiz-store-app-caps";

/** 앱이 시작 주소로 보낸 «할 수 있는 것» 목록을 기억한다(표식과 같은 sessionStorage — 이유는 맨 위 설명). */
export function recordStoreAppCapabilities(raw: string | null | undefined) {
  try {
    const caps = parseStoreAppCapabilities(raw);
    if (caps.length > 0) window.sessionStorage.setItem(STORE_APP_CAPS_KEY, caps.join(","));
  } catch {
    // 저장 실패 = 신호 없음 → 우회가 켜진 채로 남는다(안 되는 버튼이 보이는 것보다 낫다)
  }
}

/** "push, links ,foo" → ["push","links"] (모르는 값은 버린다) */
export function parseStoreAppCapabilities(raw: string | null | undefined): StoreAppCapability[] {
  const known: StoreAppCapability[] = ["push", "links", "geolocation", "voice", "install", "sms"];
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is StoreAppCapability => (known as string[]).includes(s));
}

/**
 * 판정 함수(유일): 지금 스토어 앱 안이고, 그 앱이 cap 을 못 한다고 봐야 하나.
 * - 브라우저·기존 설치 앱이면 항상 false(아무것도 숨기지 않는다)
 * - 스토어 앱인데 앱이 cap 을 할 수 있다고 알려 왔으면 false
 * ⚠️ 브라우저 전용(window). 화면에서는 useStoreAppLacks 훅으로 쓴다(첫 그림은 «브라우저»).
 */
export function storeAppLacks(cap: StoreAppCapability): boolean {
  if (!isStoreApp()) return false;
  // 앱 1.0.1+ (사용자 에이전트 표식) 은 바깥 링크·문자를 직접 연다 — 시작 주소를 안 거친 화면(문자 링크로 바로 열림)에서도
  if ((cap === "links" || cap === "sms") && hasStoreAppUserAgentMark()) return false;
  try {
    const caps = parseStoreAppCapabilities(window.sessionStorage.getItem(STORE_APP_CAPS_KEY));
    return !caps.includes(cap);
  } catch {
    return true;
  }
}
