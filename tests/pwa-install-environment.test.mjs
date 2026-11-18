import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 판별 모듈은 의존성이 없는 순수 함수라 실제로 실행해서 검증한다.
// (소스 문자열 매칭으로는 정규식 오류·분기 실수를 절대 못 잡는다)
const moduleSource = await readFile("src/lib/pwa/installEnvironment.ts", "utf8");
const transpiled = ts.transpileModule(moduleSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  detectInAppBrowser,
  detectInstallEnvironment,
  detectAndroidBrowser,
  buildKakaoExternalUrl,
  getInAppBrowserLabel,
  getInAppEscapeSteps,
  getAndroidInstallSteps,
  getAndroidInstallHint,
} = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);

const helpSource = await readFile("src/components/pwa/InstallHelp.tsx", "utf8");

/* ---------------- 실제 User-Agent 문자열 ---------------- */
const UA = {
  kakaoIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.5.5",
  kakaoAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-S926N Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36;KAKAOTALK 10.5.5",
  iosSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iosChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 14; SM-S926N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.71 Mobile Safari/537.36",
  // 삼성 인터넷(갤럭시 기본 브라우저) — UA에 Chrome 과 Safari 토큰이 둘 다 들어 있다.
  samsungInternet:
    "Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/21.0 Chrome/110.0.5481.154 Mobile Safari/537.36",
  desktopChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  naverIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 NAVER(inapp; search; 2000; 12.5.0)",
  instagramAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-G991N Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.6045.66 Mobile Safari/537.36 Instagram 302.0.0.23.113 Android",
  facebookIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/456.0.0.32.108;FBBV/1234]",
  lineIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1 Line/14.5.0",
  whaleDesktop:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Whale/3.24.223.18 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
};

/* ---------------- 인앱 브라우저 판별 ---------------- */

test("카카오톡 인앱 브라우저는 iOS·안드로이드 모두 인앱으로 판정한다", () => {
  assert.equal(detectInAppBrowser(UA.kakaoIos), "kakaotalk");
  assert.equal(detectInAppBrowser(UA.kakaoAndroid), "kakaotalk");

  const ios = detectInstallEnvironment({ userAgent: UA.kakaoIos });
  assert.equal(ios.platform, "ios");
  assert.equal(ios.inAppBrowser, "kakaotalk");
  assert.equal(ios.isIosSafari, false);
  assert.equal(ios.deviceState, "ios-browser");

  const android = detectInstallEnvironment({ userAgent: UA.kakaoAndroid });
  assert.equal(android.platform, "android");
  assert.equal(android.inAppBrowser, "kakaotalk");
  assert.equal(android.deviceState, "android");
});

test("네이버·인스타그램·페이스북·라인 인앱 브라우저를 각각 구분한다", () => {
  assert.equal(detectInAppBrowser(UA.naverIos), "naver");
  assert.equal(detectInAppBrowser(UA.instagramAndroid), "instagram");
  assert.equal(detectInAppBrowser(UA.facebookIos), "facebook");
  // 라인은 UA에 Safari 토큰이 있어도 Safari가 아니다 — 여기서 놓치면 3단계 안내가 헛돈다.
  assert.equal(detectInAppBrowser(UA.lineIos), "line");
  assert.equal(detectInstallEnvironment({ userAgent: UA.lineIos }).isIosSafari, false);
});

/* ---------------- 일반 브라우저(오탐 금지) ---------------- */

test("일반 iOS Safari는 인앱이 아니고 ios-safari로 판정한다", () => {
  const env = detectInstallEnvironment({ userAgent: UA.iosSafari });
  assert.equal(env.inAppBrowser, null);
  assert.equal(env.platform, "ios");
  assert.equal(env.isIosSafari, true);
  assert.equal(env.deviceState, "ios-safari");
});

test("iOS 크롬(CriOS)은 iOS지만 Safari가 아니다", () => {
  const env = detectInstallEnvironment({ userAgent: UA.iosChrome });
  assert.equal(env.platform, "ios");
  assert.equal(env.isIosSafari, false);
  assert.equal(env.inAppBrowser, null);
  assert.equal(env.deviceState, "ios-browser");
});

test("안드로이드 크롬은 안드로이드이고 인앱이 아니다", () => {
  const env = detectInstallEnvironment({ userAgent: UA.androidChrome });
  assert.equal(env.platform, "android");
  assert.equal(env.inAppBrowser, null);
  assert.equal(env.deviceState, "android");
});

/* ---------------- 삼성 인터넷 (갤럭시 기본 브라우저) ---------------- */

test("삼성 인터넷은 안드로이드·인앱 아님으로 보고 브라우저 종류를 samsung으로 판정한다", () => {
  const env = detectInstallEnvironment({ userAgent: UA.samsungInternet });
  assert.equal(env.platform, "android");
  // 삼성 인터넷은 정식 브라우저다. 인앱으로 오판하면 엉뚱한 탈출 안내가 뜬다.
  assert.equal(env.inAppBrowser, null);
  assert.equal(env.deviceState, "android");
  assert.equal(env.androidBrowser, "samsung");
  assert.equal(detectAndroidBrowser(UA.samsungInternet), "samsung");
});

test("안드로이드 크롬은 samsung으로 오판하지 않는다", () => {
  assert.equal(detectAndroidBrowser(UA.androidChrome), "other");
  assert.equal(detectInstallEnvironment({ userAgent: UA.androidChrome }).androidBrowser, "other");
  // 안드로이드가 아니면 브라우저 종류를 고를 필요가 없다.
  assert.equal(detectInstallEnvironment({ userAgent: UA.iosSafari }).androidBrowser, null);
});

test("삼성 인터넷 UA는 Safari·Chrome 토큰이 있어도 iOS로 오판하지 않는다", () => {
  const env = detectInstallEnvironment({ userAgent: UA.samsungInternet });
  assert.notEqual(env.platform, "ios");
  assert.equal(env.isIosSafari, false);
  assert.notEqual(env.deviceState, "ios-safari");
  assert.notEqual(env.deviceState, "ios-browser");
});

test("삼성 인터넷 안내는 실제 메뉴 이름(현재 페이지 추가)을 그대로 쓴다", () => {
  const samsung = getAndroidInstallSteps("samsung");
  assert.equal(samsung.length, 3);
  const samsungText = samsung.map((step) => step.label).join(" / ");
  // 어머님이 "앱 설치"를 찾다가 포기한 사고 재발 방지 — 삼성 메뉴 이름 그대로여야 한다.
  assert.match(samsungText, /우측 하단/);
  assert.match(samsungText, /현재 페이지 추가/);
  assert.match(samsungText, /홈 화면/);
  assert.match(getAndroidInstallHint("samsung"), /현재 페이지 추가/);

  const other = getAndroidInstallSteps("other");
  assert.equal(other.length, 3);
  const otherText = other.map((step) => step.label).join(" / ");
  assert.match(otherText, /우측 위/);
  assert.match(otherText, /앱 설치|홈 화면에 추가/);
  // 크롬은 버전마다 메뉴 이름이 다르다(최신 "설치 및 바로가기 만들기" / 예전 "앱 설치").
  // 한쪽만 적으면 실기기에서 그 항목을 못 찾고 막힌다 — 두 이름이 모두 있어야 한다.
  assert.match(otherText, /설치 및 바로가기 만들기/);
  assert.match(otherText, /앱 설치/);
  assert.match(getAndroidInstallHint("other"), /설치 및 바로가기 만들기/);
  assert.match(getAndroidInstallHint("other"), /앱 설치/);
  // 크롬 안내에 삼성 전용 메뉴 이름이 새어 나오면 안 된다.
  assert.doesNotMatch(otherText, /현재 페이지 추가/);

  // 한 손으로 보는 화면이라 단계 문구는 짧게 유지한다.
  for (const step of [...samsung, ...other]) {
    assert.ok(step.label.length <= 24, `너무 긴 안내: ${step.label}`);
    assert.ok(step.icon.length > 0, "Material Symbols 아이콘 이름이 필요합니다.");
  }
});

test("안드로이드 안내는 공용 컴포넌트가 메뉴 이름을 들고 있다", () => {
  assert.match(helpSource, /getAndroidInstallSteps/);
});

test("데스크톱 브라우저는 other이고 인앱으로 오탐하지 않는다", () => {
  for (const userAgent of [UA.desktopChrome, UA.whaleDesktop, UA.macSafari]) {
    const env = detectInstallEnvironment({ userAgent });
    assert.equal(env.deviceState, "other");
    assert.equal(env.inAppBrowser, null);
  }
});

test("iPadOS 데스크톱 모드(MacIntel + 터치)는 iOS Safari로 본다", () => {
  const env = detectInstallEnvironment({
    userAgent: UA.macSafari,
    platform: "MacIntel",
    maxTouchPoints: 5,
  });
  assert.equal(env.platform, "ios");
  assert.equal(env.deviceState, "ios-safari");
});

test("빈 UA는 안전하게 other로 떨어진다", () => {
  const env = detectInstallEnvironment({ userAgent: "" });
  assert.equal(env.deviceState, "other");
  assert.equal(env.inAppBrowser, null);
  assert.equal(detectInAppBrowser(undefined), null);
});

/* ---------------- 탈출 경로 ---------------- */

test("카카오톡 외부 브라우저 스킴은 현재 주소를 인코딩해 붙인다", () => {
  const url = "https://stiz.example.com/app?ref=kakao&x=1";
  assert.equal(
    buildKakaoExternalUrl(url),
    `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`,
  );
  assert.ok(buildKakaoExternalUrl(url).startsWith("kakaotalk://web/openExternal?url="));
  // 원본 주소의 & 가 그대로 새면 스킴 파라미터가 깨진다.
  assert.doesNotMatch(buildKakaoExternalUrl(url).slice("kakaotalk://web/openExternal?url=".length), /&/);
});

test("인앱 브라우저별 이름과 탈출 단계 안내가 있다", () => {
  assert.equal(getInAppBrowserLabel("kakaotalk"), "카카오톡");
  assert.equal(getInAppBrowserLabel("naver"), "네이버 앱");
  for (const kind of ["kakaotalk", "naver", "instagram", "facebook", "line", "generic"]) {
    for (const platform of ["ios", "android"]) {
      const steps = getInAppEscapeSteps(kind, platform);
      assert.ok(Array.isArray(steps) && steps.length >= 2, `${kind}/${platform} 단계 안내가 필요합니다.`);
      // 한 손으로 보는 화면이라 단계 문구는 짧게 유지한다.
      for (const step of steps) assert.ok(step.length <= 24, `너무 긴 안내: ${step}`);
    }
  }
});

/* 화면 연결 검사는 지웠다 — 옛 «홈 화면 바로가기» 설치 화면 두 개를 2026-11-18 원장 승인으로 지웠다 */

test("공유 버튼 그림은 인라인 SVG이고 색상은 토큰을 쓴다", () => {
  assert.match(helpSource, /<svg/);
  assert.doesNotMatch(helpSource, /<img/);
  assert.match(helpSource, /var\(--brand-accent\)/);
  // iOS 버전에 따라 툴바가 위에 있을 수 있으므로 두 경우를 다 커버하는 문구를 쓴다.
  assert.match(helpSource, /아래쪽\(또는 위쪽\)/);
});

test("주소 복사 결과는 성공·실패 모두 사용자에게 알린다", () => {
  assert.match(helpSource, /navigator\.clipboard\.writeText/);
  assert.match(helpSource, /aria-live="polite"/);
  assert.match(helpSource, /복사됐어요/);
  assert.match(helpSource, /복사가 막혔어요/);
});
