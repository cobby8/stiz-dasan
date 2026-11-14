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

/**
 * 앱 간편로그인(a1, 2026-11-13) — 앱이 «시스템 브라우저 로그인 → 1회용 code 로 복귀»를 할 줄 아는지.
 * 그 기능이 들어간 앱 빌드만 사용자 에이전트 끝에 이 표식을 붙인다(안드로이드 MainActivity·아이폰 WebViewController).
 * 표식이 없는 옛 앱(1.0.1 이하)에서 간편로그인 버튼을 누르면 «준비 중» 안내만 뜨므로 버튼을 보이지 않는다.
 */
export const NATIVE_LOGIN_USER_AGENT_MARK = " STIZNativeLogin/1";

export function appSupportsNativeLogin(userAgent: string | null | undefined): boolean {
  return String(userAgent ?? "").includes(NATIVE_LOGIN_USER_AGENT_MARK);
}

/**
 * 스토어 앱 로그인 화면의 간편로그인 표시 방법(순수 판정 — 테스트로 못박는다).
 * - "unknown"      : 아직 서버 답을 모름 → 아무것도 그리지 않는다(눌러도 안 되는 버튼 방지)
 * - "buttons"      : 앱이 기능을 갖췄고 + 서버 스위치가 켜졌고 + Supabase 에서 켜진 제공자가 있음
 * - "password-only": 그 밖 전부 → 버튼 숨김, 아이디·비밀번호 로그인 안내 + 문자 인증으로 비밀번호 만들기 연결
 * 아이폰 앱은 Apple 로그인이 켜져 있을 때만 간편로그인을 보인다 — 앱스토어 심사지침 4.8(다른 간편로그인을
 * 앱에서 제공하면 Apple 로그인도 함께 제공해야 한다). 카카오·구글만 켜고 Apple 을 빠뜨려 심사에서 거절되는 일을 막는다.
 */
export type StoreAppSocialLogin = "unknown" | "buttons" | "password-only";

export function storeAppSocialLogin(input: { userAgent: string | null | undefined; nativeApp: boolean | null | undefined; providers: readonly string[] | null | undefined }): StoreAppSocialLogin {
  if (input.nativeApp === null || input.nativeApp === undefined || !input.providers) return "unknown";
  const userAgent = String(input.userAgent ?? "");
  if (input.nativeApp !== true || input.providers.length === 0 || !appSupportsNativeLogin(userAgent)) return "password-only";
  const iosApp = userAgent.includes(" (ios)");
  if (iosApp && !input.providers.includes("apple")) return "password-only";
  return "buttons";
}

/** 앱 안 간편로그인 링크 — 앱이 정확히 «/auth/oauth/<제공자>?intent=login» 만 가로채므로 다른 값을 붙이지 않는다. */
export function storeAppSocialLoginHref(provider: string): string {
  return `/auth/oauth/${provider}?intent=login`;
}

/**
 * 사용자 에이전트의 « STIZApp/1.0.2 (ios)» 에서 앱 버전·기기를 꺼낸다(2026-11-14 설정 화면 «앱 정보»).
 * 표식이 없으면 null — 브라우저이거나 표식을 붙이기 전 옛 앱(아이폰 1.0).
 * 버전 글자는 숫자·점·짧은 꼬리표만 받는다(엉뚱한 긴 글자를 화면에 그대로 찍지 않게).
 */
export function storeAppVersionOf(userAgent: string | null | undefined): { version: string; platform: "ios" | "android" } | null {
  const match = /\bSTIZApp\/(\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.]{1,12})?) \((ios|android)\)/.exec(String(userAgent ?? ""));
  return match ? { version: match[1], platform: match[2] as "ios" | "android" } : null;
}

/** "1.0.2" < "1.0.10" 처럼 점으로 나눈 숫자끼리 비교(a 가 b 보다 낮으면 true). 꼬리표(-beta)는 무시 */
export function isAppVersionBelow(a: string, b: string): boolean {
  const parts = (v: string) => v.split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

/** 앱 알림 창구(stizPush·StizPushTransport)가 들어간 첫 앱 버전(아이폰·안드로이드 1.0.2) */
export const NATIVE_PUSH_MIN_APP_VERSION = "1.0.2";

/**
 * 사용자 에이전트로 본 «이 앱 빌드에는 알림 창구가 들어 있나».
 * 표식 없음(아이폰 1.0)·1.0.1 이하 → false = 업데이트하면 알림을 켤 수 있다.
 * 1.0.2 이상인데 창구가 안 보이면 업데이트로 풀리지 않는 문제(휴대폰 웹뷰가 오래됨 등)라 «업데이트» 안내를 하지 않는다.
 */
export function appBuildHasPush(userAgent: string | null | undefined): boolean {
  const app = storeAppVersionOf(userAgent);
  return Boolean(app) && !isAppVersionBelow(app!.version, NATIVE_PUSH_MIN_APP_VERSION);
}

/** «영상 촬영»을 누르면 동영상 카메라가 바로 열리는 첫 안드로이드 앱 버전(WebFileChooser 의 ACTION_VIDEO_CAPTURE) */
export const NATIVE_VIDEO_CAPTURE_MIN_ANDROID_VERSION = "1.0.3";

/**
 * «영상 촬영»이 촬영 화면 대신 파일 선택으로 떨어지는 옛 안드로이드 앱인가(순수 — 테스트로 못박는다).
 * - 안드로이드 앱 1.0.3 미만 → true (촬영 요청을 사진으로만 알아들어 영상은 파일 선택 화면이 뜬다)
 * - 표식이 없는 안드로이드 스토어 앱(1.0) → true
 * - 아이폰 앱·일반 브라우저 → false (브라우저·WKWebView 가 capture 를 직접 처리한다)
 */
export function needsAppUpdateForVideoCapture(input: { userAgent: string | null | undefined; storeApp?: boolean }): boolean {
  const app = storeAppVersionOf(input.userAgent);
  if (app) return app.platform === "android" && isAppVersionBelow(app.version, NATIVE_VIDEO_CAPTURE_MIN_ANDROID_VERSION);
  return input.storeApp === true && /\bAndroid\b/.test(String(input.userAgent ?? ""));
}

/**
 * 설정 화면 «앱 정보 → 버전» 글자(순수 — 테스트로 못박는다).
 * 학부모에게 package.json 의 «0.1.0» 은 틀린 정보처럼 보여서(원장 11-14) 빼고,
 *   - 스토어 앱(표식 있음): app = «앱 1.0.2», web = «화면 1ac85e2»(작게)
 *   - 브라우저·표식 없는 옛 앱: app = null, web = «화면 1ac85e2»
 * build(배포 커밋 앞 7자리)가 없으면(내 컴퓨터 개발 서버) web = «화면 개발판».
 */
export function appVersionLabels(input: { userAgent: string | null | undefined; build: string | null | undefined }): { app: string | null; web: string } {
  const app = storeAppVersionOf(input.userAgent);
  const build = String(input.build ?? "").trim().slice(0, 7);
  return { app: app ? `앱 ${app.version}` : null, web: build ? `화면 ${build}` : "화면 개발판" };
}

// ── 앱 업데이트 안내(2026-11-15 원장: «업데이트 나오면 알림 뜨고 스토어로 이동») ─────────────────────────
// 앱은 웹사이트를 감싼 웹뷰라, 웹이 «스토어에 더 새 버전이 있다»를 알아보고 화면 맨 위 한 줄로 알린다.
// 스토어의 최신 버전은 서버 라우트(/api/app/latest-version)가 읽고, 앱 안의 화면만 그 라우트를 부른다(@/lib/storeApp/latestVersionClient).
// 여기는 그 값으로 하는 «판정»만 — 전부 순수 함수.

/** 스토어별 최신 버전(안드로이드 = Play, 아이폰 = App Store). 두 스토어의 공개 시점이 달라 따로 든다 */
export type StoreAppLatest = { android: string; ios: string };

/** 사용자 에이전트 표식이 없는 옛 앱의 버전(표식은 1.0.1 부터 붙는다) */
export const STORE_APP_UNMARKED_VERSION = "1.0";

/** 스토어 버전으로 인정하는 모양 — «1.0» «1.0.3» «2.1.0.4». 그 밖(빈 값·글자·꼬리표)은 버린다 */
export function isStoreVersion(value: unknown): value is string {
  return typeof value === "string" && /^\d+(\.\d+){1,3}$/.test(value);
}

/**
 * 바닥값 — 스토어를 못 읽었을 때 쓰는 «적어도 이 버전은 공개돼 있다»(2026-11-15 확인: Play 1.0.3 · App Store 1.0.3).
 * 읽은 값이 이보다 낮으면(스토어·CDN 캐시가 옛 값을 줌) 이 값을 쓴다.
 * ⚠️ 실제 공개된 버전보다 높게 적지 마라 — 아직 못 받는 버전으로 «업데이트»를 권하게 된다.
 *    (tests/app-update-notice.test.mjs 가 앱 소스의 버전보다 높지 않은지 지킨다)
 */
export const STORE_APP_KNOWN_LATEST: StoreAppLatest = { android: "1.0.3", ios: "1.0.3" };

/** 읽은 값의 부(둘째) 번호가 바닥값보다 이만큼 이상 크면 «잘못 읽었다»로 본다 */
export const STORE_VERSION_MAX_MINOR_JUMP = 20;

/**
 * 읽은 값과 바닥값 중 쓸 값(순수): 못 읽었거나 이상한 값·바닥보다 낮은 값이면 바닥값.
 * 상한도 본다 — Play 페이지에서 엉뚱한 «더 높은 숫자»를 버전으로 잘못 읽으면, 업데이트해도 사라지지 않는 배너가 계속 뜬다.
 *   주(첫째) 번호가 바닥값과 다르거나, 부(둘째) 번호가 바닥값보다 20 이상 크면 바닥값을 쓴다.
 * ⚠️ 그래서 주 번호를 올린 앱(예: 2.0)을 낼 때는 바닥 상수(STORE_APP_KNOWN_LATEST)도 같이 올려야 안내가 뜬다.
 */
export function resolveStoreVersion(read: unknown, floor: string): string {
  if (!isStoreVersion(read)) return floor;
  if (isAppVersionBelow(read, floor)) return floor;
  const [readMajor, readMinor] = read.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const [floorMajor, floorMinor] = floor.split(".").map((n) => Number.parseInt(n, 10) || 0);
  if (readMajor !== floorMajor || readMinor - floorMinor >= STORE_VERSION_MAX_MINOR_JUMP) return floor;
  return read;
}

/** 두 스토어에서 읽은 값(못 읽은 쪽은 null)을 판정에 쓸 최신 버전으로(순수) */
export function resolveStoreAppLatest(read: { android?: unknown; ios?: unknown } | null | undefined, floor: StoreAppLatest = STORE_APP_KNOWN_LATEST): StoreAppLatest {
  return {
    android: resolveStoreVersion(read?.android, floor.android),
    ios: resolveStoreVersion(read?.ios, floor.ios),
  };
}

/**
 * 안내 단계
 *   none        안 띄운다(브라우저 · 이미 최신)
 *   recommended «새 버전이 나왔어요 [업데이트] 나중에»
 *   required    꼭 올려야 하는 버전보다 낮다 — 닫기 없음(지금은 requiredMin 을 정하지 않아 나오지 않는다)
 *   legacyApp   표식 없는 옛 앱(1.0) — 이 앱은 바깥 주소를 못 열어서 버튼 없이 글자만
 */
export type AppUpdateLevel = "none" | "recommended" | "required" | "legacyApp";

export type AppUpdateNotice = { level: AppUpdateLevel; storeUrl: string | null; latestVersion: string };

/**
 * 업데이트 안내 판정(유일) — 배너와 설정 «앱 정보»가 같이 쓴다.
 *   inApp       스토어 앱 안인가(isStoreApp)
 *   app         사용자 에이전트의 앱 버전·기기(storeAppVersionOf) — 표식 없는 옛 앱이면 null
 *   target      스토어 주소·기기(@/lib/app-install-links 의 appUpdateTarget(userAgent) 결과를 그대로 넘긴다.
 *               이 파일은 import 가 없어야 테스트가 그대로 실행하므로 주소 함수를 여기서 부르지 않는다)
 *   latest      스토어별 최신 버전
 *   requiredMin 이 버전보다 낮으면 «꼭 업데이트»(기기별, 없으면 null)
 * 스토어 주소는 https 만 내보낸다 — 앱은 사용자가 직접 누른 https 링크만 바깥으로 연다(market:·itms-apps: 는 막힌다).
 */
export function appUpdateNotice(input: {
  inApp: boolean;
  app: { version: string; platform: "ios" | "android" } | null;
  target: { platform: "ios" | "android" | "other"; url: string | null };
  latest: StoreAppLatest;
  requiredMin?: Partial<StoreAppLatest> | null;
}): AppUpdateNotice {
  const none: AppUpdateNotice = { level: "none", storeUrl: null, latestVersion: "" };
  if (!input.inApp) return none; // 브라우저에는 아무것도 띄우지 않는다
  const latestOf = (platform: "ios" | "android") => (isStoreVersion(input.latest?.[platform]) ? input.latest[platform] : null);

  if (input.app) {
    const latest = latestOf(input.app.platform);
    if (!latest) return none; // 최신 버전을 모르면 안내하지 않는다(틀린 안내보다 낫다)
    const storeUrl = typeof input.target.url === "string" && input.target.url.startsWith("https://") ? input.target.url : null;
    const required = input.requiredMin?.[input.app.platform];
    if (isStoreVersion(required) && isAppVersionBelow(input.app.version, required)) return { level: "required", storeUrl, latestVersion: latest };
    if (isAppVersionBelow(input.app.version, latest)) return { level: "recommended", storeUrl, latestVersion: latest };
    return { ...none, latestVersion: latest };
  }

  // 표식 없는 옛 앱(1.0): 그 기기의 스토어에 1.0 보다 높은 버전이 올라와 있을 때만 알린다.
  // 기기를 모르면(사용자 에이전트로 못 가림) 두 스토어 중 하나라도 높으면 알린다.
  const candidates = input.target.platform === "other" ? [latestOf("android"), latestOf("ios")] : [latestOf(input.target.platform)];
  const newer = candidates.filter((v): v is string => Boolean(v) && isAppVersionBelow(STORE_APP_UNMARKED_VERSION, v as string));
  if (newer.length === 0) return none;
  // 둘 다 높으면 더 높은 쪽을 적는다
  const latestVersion = newer.reduce((a, b) => (isAppVersionBelow(a, b) ? b : a));
  return { level: "legacyApp", storeUrl: null, latestVersion };
}

/**
 * /store-app(앱 시작 주소)을 거쳤다는 표식 — 업데이트 안내 전용(2026-11-15 검수).
 * 왜 기존 표식(STORE_APP_FLAG_KEY)을 안 쓰나: isStoreApp() 은 referrer 가 «android-app://» 로 시작만 해도 그 표식을 찍는다.
 * 안드로이드 크롬은 Gmail·구글 앱에서 연 링크의 referrer 가 «android-app://com.google.android.gm» 이라,
 * 일반 브라우저에 «앱을 업데이트해 주세요»가 뜬다. 그 판정은 다른 기능이 쓰고 있어 그대로 두고, 안내만 좁게 본다.
 */
export const STORE_APP_START_FLAG_KEY = "stiz-store-app-start";

/** 앱 시작 주소(/store-app)에서만 부른다 */
export function markStoreAppStart() {
  try {
    window.sessionStorage.setItem(STORE_APP_START_FLAG_KEY, "1");
  } catch {
    // 저장소를 못 쓰면 표식 없는 옛 앱에는 안내가 안 뜬다(브라우저에 잘못 뜨는 것보다 낫다)
  }
}

/**
 * 업데이트 안내용 «앱 안» 판정(순수) — 셋 중 하나일 때만 앱으로 본다.
 *   ① 사용자 에이전트에 앱 표식(« STIZApp/») — 앱 1.0.1 이상
 *   ② 앱 시작 주소(/store-app)를 거친 표식(startFlag = sessionStorage 의 STORE_APP_START_FLAG_KEY 값)
 *   ③ referrer 가 «android-app://우리 패키지» — 패키지 이름까지 정확히 같을 때만(다른 앱이 연 브라우저는 아니다)
 * packageName 은 @/lib/app-install-links 의 STORE_APP_PACKAGE 를 넘긴다(이 파일은 import 가 없다).
 */
export function isInStoreAppForUpdateNotice(input: { userAgent?: string | null; referrer?: string | null; startFlag?: string | null; packageName: string }): boolean {
  if (String(input.userAgent ?? "").includes(STORE_APP_USER_AGENT_MARK)) return true;
  if (input.startFlag === "1") return true;
  const own = `android-app://${input.packageName}`;
  const referrer = String(input.referrer ?? "");
  // 뒤에 글자가 더 붙은 다른 패키지(…stizdasan.other)는 아니다
  return Boolean(input.packageName) && (referrer === own || referrer.startsWith(`${own}/`));
}

/**
 * 업데이트 안내를 띄우지 않는 화면(순수) — 하던 일을 끊으면 안 되는 곳.
 *   결제 진행 · 로그인/본인인증/가입 흐름 · 기사님 운행 중 · 선생님 수업 화면
 * («오늘 수업» 홈에서 진행 중 수업 칸이 펼쳐진 경우는 주소로 알 수 없어 배너가 <html> 의 «수업 중» 표시를 따로 본다)
 */
const APP_UPDATE_HIDDEN_PREFIXES = [
  // 결제
  // (토스 결제창을 여는 화면 전부 — grep "tosspayments|loadTossPayments|requestPayment" src/app 로 확인: /payments/<청구>, /mypage/payments/checkout, /apply/trial/pay)
  "/pay", "/payments", "/mypage/payments/checkout", "/mypage/payments/done", "/apply/trial/pay",
  // 로그인·본인인증·가입·앱 시작 주소(떠 있는 «뒤로» 버튼이 있는 화면들과 겹치지 않게 그 목록도 포함)
  "/login", "/auth", "/signup", "/account/activate", "/setup", "/invite", "/teacher-app", "/store-app",
  // 기사님 운행 화면
  "/staff/run", "/shuttle/run",
  // 선생님 수업 화면
  "/staff/sessions",
];

export function shouldHideAppUpdateBanner(pathname: string | null | undefined): boolean {
  const path = String(pathname ?? "");
  // 기사님 링크 운행 화면(/driver/<토큰>) — 기사님 첫 화면(/driver)에는 띄운다
  if (path.startsWith("/driver/")) return true;
  return APP_UPDATE_HIDDEN_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** «나중에»를 누르면 숨기는 기간 — 3일 */
export const APP_UPDATE_SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;

/** 기기 저장소(localStorage) 열쇠 — 최신 버전을 넣어, 더 새 버전이 나오면 다시 보이게 한다 */
export function appUpdateSnoozeKey(latestVersion: string): string {
  return `stiz-app-update-later:${latestVersion}`;
}

/**
 * «나중에»를 누른 시각(저장된 글자)과 지금 시각으로 아직 숨길 때인지(순수 — 시각은 인자로 받는다).
 * 저장값이 없거나 숫자가 아니거나, 미래 시각(휴대폰 시계를 바꿈)이면 숨기지 않는다.
 */
export function isAppUpdateSnoozed(stored: string | null | undefined, nowMs: number): boolean {
  if (!/^\d{1,16}$/.test(String(stored ?? ""))) return false;
  const elapsed = nowMs - Number(stored);
  return elapsed >= 0 && elapsed < APP_UPDATE_SNOOZE_MS;
}
