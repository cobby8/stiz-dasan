// 학부모 설정 화면 손보기(2026-11-14 원장 아이폰 캡처).
//  ① «자주 쓰는 결제 방법» 이름이 한 글자씩 세로로 접히고 선택 상자가 칸 밖으로 넘침
//  ② 알림 창구 없는 옛 앱 → «업데이트하면 켤 수 있어요» + 업데이트 버튼(바깥 주소를 열 수 있는 앱만)
//  ③ «버전 0.1.0 (1ac85e2)» → «앱 1.0.2 · 화면 1ac85e2»
//  ④ 아이폰 아래 탭 아래 빈 공간 — 탭 64→48px, 정의 없던 pb-safe 대신 env(safe-area-inset-bottom)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/")) throw new Error(`대역 없는 의존: ${name}`);
    return require(name);
  };
  module._compile(compiled, absolute);
  return module.exports;
}

const storeApp = load("src/lib/storeApp.ts");
const bridge = load("src/lib/push/nativePushBridge.ts");
const installLinks = load("src/lib/app-install-links.ts");

const IOS_102 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 STIZApp/1.0.2 (ios) STIZNativeLogin/1";
const IOS_10 = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const AND_101 = "Mozilla/5.0 (Linux; Android 14; SM-S918N; wv) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 STIZApp/1.0.1 (android)";
const PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36";

test("③ 앱 버전 글자: 스토어 앱 «앱 1.0.2» + 작게 «화면 1ac85e2», 브라우저·옛 앱은 화면 번호만, 0.1.0 은 안 쓴다", () => {
  assert.deepEqual(storeApp.storeAppVersionOf(IOS_102), { version: "1.0.2", platform: "ios" });
  assert.deepEqual(storeApp.storeAppVersionOf(AND_101), { version: "1.0.1", platform: "android" });
  assert.equal(storeApp.storeAppVersionOf(IOS_10), null, "아이폰 1.0 은 표식이 없다");
  assert.equal(storeApp.storeAppVersionOf(`${PC} STIZApp/<script> (ios)`), null, "숫자 아닌 버전은 버린다");
  assert.deepEqual(storeApp.appVersionLabels({ userAgent: IOS_102, build: "1ac85e2deadbeef" }), { app: "앱 1.0.2", web: "화면 1ac85e2" });
  assert.deepEqual(storeApp.appVersionLabels({ userAgent: PC, build: "1ac85e2deadbeef" }), { app: null, web: "화면 1ac85e2" });
  assert.deepEqual(storeApp.appVersionLabels({ userAgent: null, build: undefined }), { app: null, web: "화면 개발판" });
  const page = read("src/app/mypage/settings/page.tsx");
  assert.doesNotMatch(page, /pkg\.version|from "[^"]*package\.json"/, "개발 틀 버전(0.1.0)은 화면에 쓰지 않는다");
  assert.match(page, /appVersionLabels\(\{ userAgent: headerStore\.get\("user-agent"\), build: process\.env\.VERCEL_GIT_COMMIT_SHA \}\)/);
});

test("② 버전 비교·«이 빌드에 알림 창구가 있나»(1.0.2 부터)", () => {
  assert.equal(storeApp.isAppVersionBelow("1.0.1", "1.0.2"), true);
  assert.equal(storeApp.isAppVersionBelow("1.0.2", "1.0.2"), false);
  assert.equal(storeApp.isAppVersionBelow("1.0.10", "1.0.2"), false, "글자 비교가 아니라 숫자 비교");
  assert.equal(storeApp.isAppVersionBelow("1.1", "1.0.2"), false);
  assert.equal(storeApp.isAppVersionBelow("1.0", "1.0.2"), true);
  assert.equal(storeApp.appBuildHasPush(IOS_102), true);
  assert.equal(storeApp.appBuildHasPush(AND_101), false);
  assert.equal(storeApp.appBuildHasPush(IOS_10), false);
  assert.equal(storeApp.appBuildHasPush(PC), false);
});

test("② 알림 안내 판정: 창구 없는 옛 앱 = update, 창구 있으면 지금 판정 그대로, 1.0.2 인데 창구 없음 = unavailable", () => {
  const n = (view, b, buildHasPush = false) => bridge.nativePushNotice({ view, bridge: b, buildHasPush });
  assert.equal(n("checking", false), null, "확인 중엔 아무것도");
  assert.equal(n("unavailable", null), null, "창구 확인 전엔 아무것도");
  assert.equal(n("unavailable", false), "update", "옛 앱(아이폰 1.0·1.0.1)");
  assert.equal(n("unavailable", false, true), "unavailable", "1.0.2 이상인데 창구 없음 — 업데이트로 안 풀린다");
  assert.equal(n("unavailable", true), "unavailable", "서버 미설정·Firebase 없는 앱 — 기존 문구");
  assert.equal(n("denied", true), "denied");
  assert.equal(n("default", true), null, "«켜기» 스위치가 대신한다");
  assert.equal(n("granted", true), null);
  assert.equal(bridge.NATIVE_PUSH_UPDATE_NOTE, "앱을 업데이트하면 휴대폰 알림을 켤 수 있어요");
});

test("② 업데이트 주소: 바깥 주소를 여는 앱(1.0.1+)만 스토어 주소, 아이폰 1.0 은 버튼 없이 글만", () => {
  assert.deepEqual(installLinks.appUpdateTarget(IOS_102), { platform: "ios", storeName: "App Store", url: "https://apps.apple.com/kr/app/id6832261596" });
  assert.deepEqual(installLinks.appUpdateTarget(AND_101), { platform: "android", storeName: "Play 스토어", url: "https://play.google.com/store/apps/details?id=kr.co.upturnlabs.stizdasan" });
  assert.deepEqual(installLinks.appUpdateTarget(IOS_10), { platform: "ios", storeName: "App Store", url: null }, "1.0 은 바깥 주소를 «열 수 없습니다»로 막는다");
  assert.equal(installLinks.appUpdateTarget(PC).url, null);
  // import 없는 모듈이라 표식 글자를 따로 적었다 — storeApp 의 표식과 같아야 한다
  assert.equal(storeApp.STORE_APP_USER_AGENT_MARK, " STIZApp/");
  assert.match(read("src/lib/app-install-links.ts"), /ua\.includes\(" STIZApp\/"\)/);
});

/** 설정 화면 부품을 훅 상태를 정해 두고 그린다 */
function loadSettings({ appLacksPush = true, view = "unavailable", bridge: hasBridge = false, update = { platform: "ios", storeName: "App Store", url: null } } = {}) {
  return load("src/app/mypage/settings/SettingsClient.tsx", {
    "next/link": { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) },
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    // «내 사진» 칸(2026-11-15) — 이 검사와 무관해 비워 둔다(부품은 profile-photo.test.mjs 가 그려 본다)
    "@/components/parent/ProfilePhotoEditor": { __esModule: true, default: () => null },
    "@/app/actions/parent-settings": { updateMyName: async () => ({ ok: true }), changeMyPassword: async () => ({ ok: true }), saveMyPushPrefs: async () => ({ ok: true }), saveMyPreferredPaymentMethod: async () => ({ ok: true }) },
    "@/lib/payments/preferredMethod": load("src/lib/payments/preferredMethod.ts"),
    "@/app/actions/admin": { createParentRequest: async () => ({}) },
    "@/lib/push/usePushSubscription": { usePushSubscription: () => ({ pushSupported: false, pushEnabled: false, pushLoading: false, checked: true, togglePush() {} }) },
    "@/components/storeApp/useStoreAppLacks": { useStoreAppLacks: () => appLacksPush },
    "@/lib/push/useNativePush": { useNativePush: () => ({ view, busy: false, request: async () => {}, bridge: hasBridge }) },
    "@/lib/push/nativePushBridge": bridge,
    "@/lib/storeApp": storeApp,
    "@/lib/app-install-links": { appUpdateTarget: () => update },
    "@/lib/mypage/parentSettings": load("src/lib/mypage/parentSettings.ts"),
    // 2026-11-15 아이콘 예외(화살표·종·톱니): 공용 아이콘 부품은 실제 코드를 그대로 쓴다
    "@/components/common/UiIcon": load("src/components/common/UiIcon.tsx"),
  });
}

test("① 결제 방법 줄: 이름은 한 줄 고정, 선택 상자는 남은 폭 칸(최대 10rem) 안 — 공용 입력칸 width:100% 와 싸우지 않는다", () => {
  const client = loadSettings();
  const html = renderToStaticMarkup(React.createElement(client.PaymentMethodRow, { current: "KAKAOPAY" }));
  assert.match(html, /<label for="preferred-payment-method" class="shrink-0 whitespace-nowrap /);
  assert.match(html, /<span class="ml-auto flex min-w-0 max-w-40 flex-1 justify-end"><select id="preferred-payment-method"/);
  assert.doesNotMatch(html, /w-32/, "공용 입력칸의 width:100% 에 지는 고정 폭을 쓰지 않는다");
  assert.match(html, /정하지 않음/);
  // 원인 못박기: .academy-input 은 레이어 밖 CSS 의 width:100% — Tailwind 폭 글자(w-32 등)를 이긴다
  assert.match(read("src/app/academy-theme.css"), /\.academy-app \.academy-input \{\s*min-height: 2\.75rem;\s*width: 100%;/);
  // 글자 크기 줄 이름도 좁은 폭에서 세로로 접히지 않게
  const font = renderToStaticMarkup(React.createElement(client.FontScaleRow, { current: "md" }));
  assert.match(font, /class="flex-1 whitespace-nowrap font-medium[^"]*">글자 크기</);
});

test("② 휴대폰 알림 줄: 옛 아이폰 1.0 은 업데이트 안내(버튼 없음), 1.0.1+ 옛 앱은 업데이트 버튼, 창구 있는 앱은 기존 문구", () => {
  const prefs = { attendance: true, billing: true, notice: true, shuttle: true };
  const render = (opts) => renderToStaticMarkup(React.createElement(loadSettings(opts).NotificationRows, { initialPrefs: prefs, prefsAvailable: true }));

  const old10 = render({ view: "unavailable", bridge: false });
  assert.match(old10, /앱을 업데이트하면 휴대폰 알림을 켤 수 있어요\. App Store에서 «STIZ 농구교실»을 업데이트해 주세요\./);
  assert.doesNotMatch(old10, />업데이트</, "열 수 없는 주소의 버튼은 두지 않는다");
  assert.doesNotMatch(old10, /문자·카카오톡/);

  const old101 = render({ view: "unavailable", bridge: false, update: { platform: "android", storeName: "Play 스토어", url: "https://play.google.com/store/apps/details?id=kr.co.upturnlabs.stizdasan" } });
  assert.match(old101, /<a href="https:\/\/play\.google\.com\/store\/apps\/details\?id=kr\.co\.upturnlabs\.stizdasan" class="academy-button-secondary academy-button-sm shrink-0 whitespace-nowrap">업데이트<\/a>/);
  assert.match(old101, /앱을 업데이트하면 휴대폰 알림을 켤 수 있어요\.<\/p>/);

  const noServer = render({ view: "unavailable", bridge: true });
  assert.match(noServer, /중요한 안내는 문자·카카오톡으로 보내드려요\./, "창구는 있는데 서버 미설정 — 기존 문구 유지");
  assert.doesNotMatch(noServer, /업데이트/);

  const denied = render({ view: "denied", bridge: true });
  assert.match(denied, /휴대폰 설정에서 알림을 켜 주세요\./);

  const browser = render({ appLacksPush: false, view: "unavailable", bridge: false });
  assert.doesNotMatch(browser, /업데이트|문자·카카오톡/, "브라우저는 앱 안내를 안 본다");
  assert.match(browser, /앱에서 켤 수 있어요/);
});

test("④ 아래 탭: 48px(h-12)·안전영역 env() — 정의 없는 pb-safe·64px 고정 높이 제거, 내용·알림 패널 여백도 맞춤", () => {
  const nav = load("src/app/mypage/MyPageBottomNav.tsx", {
    "next/link": { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) },
    "next/navigation": { usePathname: () => "/mypage/settings" },
  });
  const html = renderToStaticMarkup(React.createElement(nav.default));
  assert.match(html, /pb-\[env\(safe-area-inset-bottom\)\]/);
  assert.doesNotMatch(html, /pb-safe|\bh-16\b/);
  assert.equal((html.match(/class="flex h-12 w-full/g) || []).length, 4, "탭 4개 모두 48px(누르는 영역 44px 이상)");
  assert.match(read("src/app/mypage/layout.tsx"), /pb-\[calc\(4rem\+env\(safe-area-inset-bottom\)\)\] md:pb-0/);
  assert.match(read("src/app/mypage/ParentNotificationBell.tsx"), /bottom-\[calc\(3rem\+env\(safe-area-inset-bottom\)\)\]/);
  // 원인 못박기: 아이폰 앱은 웹 화면을 안전영역 위까지만 그린다(그 아래 34pt 는 앱 몫)
  assert.match(read("apps/stiz-ios/STIZ/WebViewController.swift"), /webView\.bottomAnchor\.constraint\(equalTo: view\.safeAreaLayoutGuide\.bottomAnchor\)/);
});
