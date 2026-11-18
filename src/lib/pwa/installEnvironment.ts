/**
 * PWA 설치 안내에 쓰는 "지금 어떤 환경인가" 판별 순수 모듈.
 *
 * 왜 분리하나:
 *  - 학부모 앱(/app)과 선생님 앱(/staff/install) 두 화면이 같은 판별을 각자 갖고 있으면
 *    한쪽만 고쳐지는 사고가 난다. 판별은 여기 한 곳에서만 한다.
 *  - 외부 의존성이 전혀 없는 순수 함수라서 테스트에서 실제 UA 문자열로 실행 검증할 수 있다.
 *    (소스 문자열 매칭만으로는 판별 로직의 오류를 못 잡는다)
 */

/** 홈 화면 추가가 막히는 인앱 브라우저 종류 */
export type InAppBrowserKind = "kakaotalk" | "naver" | "instagram" | "facebook" | "line" | "generic";

export type InstallPlatform = "ios" | "android" | "other";

/**
 * 안드로이드에서 쓰는 브라우저 종류.
 * 왜 나누나: 삼성 인터넷은 갤럭시 기본 브라우저인데 설치 메뉴 이름이 크롬과 완전히 다르다.
 * ("앱 설치"가 아니라 "현재 페이지 추가 → 홈 화면") 이름이 다르면 학부모가 못 찾고 포기한다.
 */
export type AndroidBrowserKind = "samsung" | "other";

/** 안내 문구를 고르는 기준값 (설치 가능 여부와는 별개로 관리한다) */
export type InstallDeviceState = "ios-safari" | "ios-browser" | "android" | "other";

export type InstallEnvironment = {
  platform: InstallPlatform;
  /** iOS이면서 진짜 Safari(인앱 아님) — 홈 화면 추가가 가능한 유일한 경우 */
  isIosSafari: boolean;
  inAppBrowser: InAppBrowserKind | null;
  /** 안드로이드일 때만 값이 있다. 안드로이드가 아니면 null (안내 문구를 고를 필요가 없다) */
  androidBrowser: AndroidBrowserKind | null;
  deviceState: InstallDeviceState;
};

type DetectInput = {
  userAgent: string;
  /** navigator.platform (iPadOS 데스크톱 모드 판별용) */
  platform?: string;
  /** navigator.maxTouchPoints (iPadOS 데스크톱 모드 판별용) */
  maxTouchPoints?: number;
};

const safe = (value: unknown): string => (typeof value === "string" ? value : "");

/** UA만으로 판단하는 iOS 여부 (iPadOS 데스크톱 모드는 여기서 안 잡힌다) */
function hasIosToken(userAgent: string): boolean {
  return /iphone|ipad|ipod/i.test(userAgent);
}

/** Safari가 아닌 iOS 브라우저(크롬·파폭·엣지·오페라)의 표식 */
function hasNonSafariIosBrowserToken(userAgent: string): boolean {
  return /crios|fxios|edgios|opios/i.test(userAgent);
}

/**
 * 인앱 브라우저 판별.
 * 원칙: **확실한 표식만 잡는다.** 애매하면 일반 브라우저로 둔다(오탐이 미탐보다 나쁘다).
 */
export function detectInAppBrowser(userAgent: string): InAppBrowserKind | null {
  const ua = safe(userAgent);
  if (!ua) return null;

  // 카카오톡: iOS/안드로이드 모두 UA 끝에 "KAKAOTALK <버전>"이 붙는다.
  if (/kakaotalk/i.test(ua)) return "kakaotalk";
  // 네이버 앱: "NAVER(inapp; search; ...)" 형태. Whale 브라우저 UA에는 NAVER 토큰이 없다.
  if (/naver\(inapp/i.test(ua) || /\bnaver\b/i.test(ua)) return "naver";
  if (/instagram/i.test(ua)) return "instagram";
  // 페이스북/메신저: [FBAN/FBIOS;FBAV/...] 형태
  if (/\bfban\b|\bfbav\b|fb_iab/i.test(ua)) return "facebook";
  // 라인: "Line/14.5.0" (앞이 공백·세미콜론·괄호일 때만 — Inline 같은 단어 오탐 방지)
  if (/(^|[\s;(])line\//i.test(ua)) return "line";

  // 이름을 모르는 웹뷰는 "확실한 신호"만 인정한다.
  // 1) 안드로이드 웹뷰는 UA에 "; wv)" 가 들어간다.
  if (/;\s*wv[);]/i.test(ua)) return "generic";
  // 2) iOS 브라우저는 모두 UA에 Safari 토큰을 달고 다닌다. 없으면 WKWebView(=인앱)다.
  if (hasIosToken(ua) && !/safari/i.test(ua)) return "generic";

  return null;
}

/**
 * 안드로이드 브라우저 종류 판별.
 *
 * ⚠️ 순서가 핵심이다. 삼성 인터넷 UA에는 Chrome 토큰과 Safari 토큰이 **둘 다** 들어 있다.
 *   예) ... SamsungBrowser/21.0 Chrome/110.0.5481.154 Mobile Safari/537.36
 * 그래서 SamsungBrowser를 **가장 먼저** 확인한다. Chrome을 먼저 보면 크롬으로 오판한다.
 * 인앱 브라우저 판별과는 무관하다 — 삼성 인터넷은 인앱 브라우저가 아니라 정식 브라우저다.
 */
export function detectAndroidBrowser(userAgent: string): AndroidBrowserKind {
  const ua = safe(userAgent);
  if (/samsungbrowser/i.test(ua)) return "samsung";
  return "other";
}

/** 기기 + 브라우저 환경을 한 번에 판별한다. */
export function detectInstallEnvironment(input: DetectInput): InstallEnvironment {
  const ua = safe(input?.userAgent);
  // iPadOS는 기본이 데스크톱 모드라 UA에 iPad가 없다. 터치 지원 Mac으로 위장하므로 이렇게 잡는다.
  const isIpadOs = safe(input?.platform) === "MacIntel" && (input?.maxTouchPoints ?? 0) > 1;
  const isIos = hasIosToken(ua) || isIpadOs;
  const isAndroid = /android/i.test(ua);

  const inAppBrowser = detectInAppBrowser(ua);
  // 인앱 브라우저는 UA에 Safari가 있어도(라인 등) Safari가 아니다. 반드시 제외한다.
  const isIosSafari =
    isIos && inAppBrowser === null && /safari/i.test(ua) && !hasNonSafariIosBrowserToken(ua);

  const platform: InstallPlatform = isIos ? "ios" : isAndroid ? "android" : "other";
  const deviceState: InstallDeviceState = isIos
    ? isIosSafari
      ? "ios-safari"
      : "ios-browser"
    : isAndroid
      ? "android"
      : "other";

  // 안드로이드일 때만 브라우저 종류를 본다. (iOS는 어차피 Safari 경로 하나뿐이라 의미가 없다)
  const androidBrowser: AndroidBrowserKind | null = isAndroid ? detectAndroidBrowser(ua) : null;

  return { platform, isIosSafari, inAppBrowser, androidBrowser, deviceState };
}

/** 사용자에게 보여줄 인앱 브라우저 이름 */
export function getInAppBrowserLabel(kind: InAppBrowserKind): string {
  switch (kind) {
    case "kakaotalk":
      return "카카오톡";
    case "naver":
      return "네이버 앱";
    case "instagram":
      return "인스타그램";
    case "facebook":
      return "페이스북";
    case "line":
      return "라인";
    default:
      return "앱 안의 브라우저";
  }
}

/**
 * 카카오톡만 외부 브라우저를 여는 스킴을 공개해 두었다.
 * 이 주소로 이동하면 기본 브라우저(아이폰=Safari)에서 같은 페이지가 다시 열린다.
 */
export function buildKakaoExternalUrl(currentUrl: string): string {
  return `kakaotalk://web/openExternal?url=${encodeURIComponent(safe(currentUrl))}`;
}

/**
 * 안드로이드 전용 — 크롬으로 같은 주소를 다시 여는 intent 주소를 만든다.
 *
 * 왜 필요한가 (현장에서 확인된 두 가지):
 *  1) 카카오톡 인앱 브라우저는 홈 화면 추가가 아예 막혀 있다. 안드로이드는 메뉴 안내만으로는 대부분 포기한다.
 *  2) 삼성 인터넷으로 설치하면 Google Play 프로텍트가 "안전하지 않은 앱"으로 막는다.
 *     삼성 인터넷이 만든 앱 파일(WebAPK)이 낡은 기준이라 그렇고, 브라우저가 만드는 것이라 우리가 못 고친다.
 *     크롬은 구글 서버에서 앱을 받아오므로 이 경고가 없다.
 * → 두 경우 모두 "크롬으로 열기" 하나로 풀린다.
 *
 * ⚠️ S.browser_fallback_url 은 필수다. 크롬이 없는 기기에서 인텐트가 실패하면
 *    돌아갈 주소가 없어 빈 화면이 된다.
 * ⚠️ intent 스킴은 iOS에서 동작하지 않는다. 호출하는 쪽에서 안드로이드일 때만 쓴다.
 *
 * @returns https 주소가 아니면 null (잘못된 인텐트를 만들지 않는다)
 */
export function buildChromeIntentUrl(currentUrl: string): string | null {
  const raw = safe(currentUrl);
  if (!raw) return null;

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    // 주소 형식이 아니면 인텐트를 만들지 않는다.
    return null;
  }
  // https가 아니면(개발용 http·기타 스킴) 인텐트를 만들지 않는다.
  if (parsed.protocol !== "https:") return null;

  // 인텐트 본문에는 스킴을 뺀 주소만 넣는다. (#Intent 뒤가 파라미터라서 해시는 못 싣는다)
  const pathPart = `${parsed.host}${parsed.pathname}${parsed.search}`;
  // 되돌아갈 원래 주소도 같은 범위로 맞춘다.
  const fallback = `${parsed.origin}${parsed.pathname}${parsed.search}`;

  return `intent://${pathPart}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(fallback)};end`;
}

/**
 * "크롬으로 열기" 버튼을 보여줄지 판단한다.
 * iOS에서는 intent 스킴이 동작하지 않으므로 **버튼 자체를 렌더하지 않는다**
 * (눌러도 아무 일이 없는 버튼은 사용자를 더 헤매게 만든다).
 */
export function shouldOfferChromeIntent(platform: InstallPlatform): boolean {
  return platform === "android";
}

// (2026-11-18 안드로이드 수동 설치 단계·요약 안내·브라우저 이름 함수 삭제 — 옛 설치 화면만 썼다)

/** 스킴이 없는 인앱 브라우저용 — 메뉴로 빠져나가는 짧은 단계 안내 */
export function getInAppEscapeSteps(kind: InAppBrowserKind, platform: InstallPlatform): string[] {
  if (kind === "kakaotalk") {
    return platform === "ios"
      ? ["오른쪽 아래 ⋯ 누르기", "‘다른 브라우저로 열기’ 선택"]
      : ["오른쪽 위 ⋮ 누르기", "‘다른 브라우저로 열기’ 선택"];
  }
  return platform === "ios"
    ? ["오른쪽 아래(또는 위) ⋯ 누르기", "‘Safari로 열기’ 선택"]
    : ["오른쪽 위 ⋮ 누르기", "‘다른 브라우저로 열기’ 선택"];
}
