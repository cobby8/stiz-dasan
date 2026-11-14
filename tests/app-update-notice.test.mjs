// 스토어 앱 업데이트 안내(2026-11-15 원장: «업데이트 나오면 알림 뜨고 업데이트하러 스토어로 이동»).
//  - 스토어의 최신 버전은 서버가 읽는다(src/lib/storeApp/latestVersion.ts) — 못 읽으면 코드의 바닥값
//  - 판정은 src/lib/storeApp.ts 의 appUpdateNotice 한 곳(맨 위 배너 + 설정 «앱 정보»)
//  - 배너는 src/components/storeApp/AppUpdateBanner.tsx — 서버 그림에는 없고 앱 안에서만 나타난다
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
const links = load("src/lib/app-install-links.ts");
// 서버 전용 모듈 — 캐시 도구만 «그대로 통과»하는 대역으로 바꿔 순수 함수들을 실행한다
const latestModule = load("src/lib/storeApp/latestVersion.ts", {
  "next/cache": { unstable_cache: (fn) => fn },
  "@/lib/app-install-links": links,
  "@/lib/storeApp": storeApp,
});
// 앱 안의 화면이 최신 버전을 알아 오는 코드(React 없음 — 그대로 실행한다)
const client = load("src/lib/storeApp/latestVersionClient.ts", { "@/lib/storeApp": storeApp });

const AND =(v) => `Mozilla/5.0 (Linux; Android 14; SM-S918N; wv) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36 STIZApp/${v} (android)`;
const IOS = (v) => `Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 STIZApp/${v} (ios) STIZNativeLogin/1`;
const IOS_UNMARKED = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const AND_UNMARKED = "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36";
const UNKNOWN_DEVICE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const PC = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36";

/** 화면이 하는 것과 같은 순서로 판정한다 */
function notice(userAgent, latest, { inApp = true, requiredMin = null } = {}) {
  return storeApp.appUpdateNotice({ inApp, app: storeApp.storeAppVersionOf(userAgent), target: links.appUpdateTarget(userAgent), latest, requiredMin });
}

const NOW = { android: "1.0.3", ios: "1.0" }; // 2026-11-15 공개 상태(Play 1.0.3 · App Store 1.0)
const BOTH = { android: "1.0.3", ios: "1.0.3" }; // 아이폰 1.0.3 공개 뒤
const PLAY_URL = "https://play.google.com/store/apps/details?id=kr.co.upturnlabs.stizdasan";
const APP_STORE_URL = "https://apps.apple.com/kr/app/id6832261596";

test("버전 비교: 숫자끼리 비교(1.0.9 < 1.0.10), 같은 버전·빈 값·이상한 값", () => {
  const below = storeApp.isAppVersionBelow;
  assert.equal(below("1.0.9", "1.0.10"), true, "글자 비교면 거꾸로 나온다");
  assert.equal(below("1.0.10", "1.0.9"), false);
  assert.equal(below("1.0.3", "1.0.3"), false, "같은 버전은 «낮다»가 아니다");
  assert.equal(below("1.0", "1.0.0"), false, "자릿수가 달라도 같은 값");
  assert.equal(below("1.0", "1.0.3"), true);
  assert.equal(below("2.0", "1.9.9"), false);
  assert.equal(below("1.0.2-beta", "1.0.2"), false, "꼬리표는 무시");
  // 스토어 버전으로 인정하는 모양
  for (const ok of ["1.0", "1.0.3", "12.4.0", "2.1.0.4"]) assert.equal(storeApp.isStoreVersion(ok), true, ok);
  for (const bad of ["", " ", "1", "1.", "v1.0.3", "1.0.3-beta", "1.0.3.4.5", "기기에 따라 다름", "<script>", null, undefined, 1.0, {}]) {
    assert.equal(storeApp.isStoreVersion(bad), false, String(bad));
  }
  // 최신 버전이 빈 값·이상한 값이면 안내하지 않는다(틀린 안내보다 낫다)
  assert.equal(notice(AND("1.0.2"), { android: "", ios: "" }).level, "none");
  assert.equal(notice(AND("1.0.2"), { android: "최신", ios: "1.0" }).level, "none");
  assert.equal(notice(IOS_UNMARKED, { android: "1.0.3", ios: "abc" }).level, "none");
});

test("판정 표: 브라우저 / 안드로이드 1.0.2·1.0.3 / 아이폰 표식 없음(최신 1.0·1.0.3) / 아이폰 1.0.3", () => {
  // 브라우저(앱 아님) — 어떤 사용자 에이전트든 none
  for (const ua of [PC, AND_UNMARKED, IOS_UNMARKED, AND("1.0.1")]) {
    assert.deepEqual(notice(ua, BOTH, { inApp: false }), { level: "none", storeUrl: null, latestVersion: "" });
  }
  // 안드로이드 1.0.2 vs 최신 1.0.3 → 권고 + Play 주소
  assert.deepEqual(notice(AND("1.0.2"), NOW), { level: "recommended", storeUrl: PLAY_URL, latestVersion: "1.0.3" });
  assert.deepEqual(notice(AND("1.0.1"), NOW), { level: "recommended", storeUrl: PLAY_URL, latestVersion: "1.0.3" });
  // 안드로이드 1.0.3 → 최신
  assert.deepEqual(notice(AND("1.0.3"), NOW), { level: "none", storeUrl: null, latestVersion: "1.0.3" });
  assert.equal(notice(AND("1.0.4"), NOW).level, "none", "스토어보다 높은 시험판에도 띄우지 않는다");
  // 아이폰 표식 없음(1.0) vs 최신 1.0 → 안 띄운다(심사 중인 버전을 권하지 않는다)
  assert.deepEqual(notice(IOS_UNMARKED, NOW), { level: "none", storeUrl: null, latestVersion: "" });
  // 아이폰 표식 없음(1.0) vs 최신 1.0.3 → 글자만(버튼 없음 — 이 앱은 바깥 주소를 못 연다)
  assert.deepEqual(notice(IOS_UNMARKED, BOTH), { level: "legacyApp", storeUrl: null, latestVersion: "1.0.3" });
  // 아이폰 1.0.3 → 최신 / 아이폰 1.0.2(시험판) vs 최신 1.0 → 안 띄운다 / 1.0.3 공개 뒤 → 권고 + App Store 주소
  assert.equal(notice(IOS("1.0.3"), BOTH).level, "none");
  assert.equal(notice(IOS("1.0.2"), NOW).level, "none");
  assert.deepEqual(notice(IOS("1.0.2"), BOTH), { level: "recommended", storeUrl: APP_STORE_URL, latestVersion: "1.0.3" });
  // 안드로이드 표식 없음(1.0) → 글자만
  assert.deepEqual(notice(AND_UNMARKED, NOW), { level: "legacyApp", storeUrl: null, latestVersion: "1.0.3" });
  // 기기를 모르는 옛 앱 → 두 스토어 중 하나라도 1.0 보다 높으면 글자 안내, 둘 다 1.0 이면 안 띄운다
  assert.equal(notice(UNKNOWN_DEVICE, NOW).level, "legacyApp");
  assert.equal(notice(UNKNOWN_DEVICE, { android: "1.0.3", ios: "1.0.5" }).latestVersion, "1.0.5", "더 높은 쪽을 적는다");
  assert.equal(notice(UNKNOWN_DEVICE, { android: "1.0", ios: "1.0" }).level, "none");
});

test("꼭 업데이트(required): requiredMin 보다 낮을 때만 — 지금은 정하지 않아 나오지 않는다", () => {
  assert.equal(notice(AND("1.0.1"), NOW, { requiredMin: { android: "1.0.2" } }).level, "required");
  assert.equal(notice(AND("1.0.2"), NOW, { requiredMin: { android: "1.0.2" } }).level, "recommended");
  assert.equal(notice(AND("1.0.3"), NOW, { requiredMin: { android: "1.0.2" } }).level, "none");
  assert.equal(notice(IOS("1.0.2"), BOTH, { requiredMin: { android: "1.0.3" } }).level, "recommended", "기기별로 따로 본다");
  assert.equal(notice(AND("1.0.1"), NOW, { requiredMin: { android: "아무 글자" } }).level, "recommended", "이상한 값은 무시");
  // 루트 레이아웃은 requiredMin 을 넘기지 않는다
  assert.match(read("src/app/layout.tsx"), /<AppUpdateBanner \/>/);
});

test("스토어 주소: https 만 — market:·itms-apps:·intent: 는 앱이 막는다", () => {
  for (const ua of [AND("1.0.1"), AND("1.0.2"), IOS("1.0.1"), IOS("1.0.2")]) {
    const { storeUrl, level } = notice(ua, BOTH);
    assert.equal(level, "recommended");
    assert.match(storeUrl, /^https:\/\//);
    assert.doesNotMatch(storeUrl, /market:|itms-apps:|intent:/);
  }
  // 주소 함수가 https 가 아닌 값을 주더라도 내보내지 않는다
  for (const url of ["market://details?id=kr.co.upturnlabs.stizdasan", "itms-apps://apps.apple.com/app/id6832261596", "http://play.google.com/x", "javascript:alert(1)"]) {
    const result = storeApp.appUpdateNotice({ inApp: true, app: { version: "1.0.2", platform: "android" }, target: { platform: "android", url }, latest: NOW });
    assert.deepEqual(result, { level: "recommended", storeUrl: null, latestVersion: "1.0.3" });
  }
  // 배너·설정 화면 어디에도 앱 전용 주소를 직접 적지 않는다
  for (const file of ["src/components/storeApp/AppUpdateBanner.tsx", "src/components/storeApp/AppVersionRow.tsx", "src/components/storeApp/useAppUpdateNotice.ts", "src/lib/storeApp/latestVersionClient.ts", "src/lib/storeApp/latestVersion.ts"]) {
    assert.doesNotMatch(read(file), /market:\/\/|itms-apps:|intent:\/\//, file);
  }
});

test("Play 페이지·App Store 조회 응답 해석: 정상 / 못 찾음 / 이상한 값", () => {
  const { parsePlayStoreVersion: play, parseItunesLookupVersion: itunes } = latestModule;
  // 2026-11-15 실제 Play 페이지의 조각
  const html = `"데이터 삭제를 요청할 수 있음"]],1],"141":[[["1.0.3"]],[[[36]],[[[26,"8.0"]]]]],"145":[null,[null,"휴대폰 알림 지원`;
  assert.equal(play(html), "1.0.3");
  assert.equal(play(`x[[["2.10.0"]],y`), "2.10.0");
  // 후보가 여러 개: 가장 많이 나온 값, 횟수가 같으면 먼저 나온 값
  assert.equal(play(`[[["1.0.3"]] [[["8.0"]] [[["1.0.3"]]`), "1.0.3");
  assert.equal(play(`[[["8.0"]] [[["1.0.3"]] [[["1.0.3"]]`), "1.0.3", "먼저 나왔어도 적게 나온 값은 아니다");
  assert.equal(play(`[[["1.0.3"]] [[["8.0"]]`), "1.0.3", "횟수가 같으면 먼저 나온 값");
  assert.equal(play("<html><body>페이지 구조가 바뀜</body></html>"), null);
  assert.equal(play(`[[["기기에 따라 다름"]]`), null);
  assert.equal(play(`[[["1"]]`), null, "점 없는 숫자는 버전으로 보지 않는다");
  assert.equal(play(`[[["1.0.3.4.5"]]`), null);
  assert.equal(play(""), null);
  assert.equal(play(null), null);

  assert.equal(itunes(JSON.stringify({ resultCount: 1, results: [{ version: "1.0.3", trackId: 6832261596 }] })), "1.0.3");
  assert.equal(itunes({ resultCount: 1, results: [{ version: "1.0" }] }), "1.0");
  assert.equal(itunes(JSON.stringify({ resultCount: 0, results: [] })), null, "앱을 못 찾음");
  assert.equal(itunes(JSON.stringify({ results: [{ version: 103 }] })), null);
  assert.equal(itunes(JSON.stringify({ results: [{ version: "1.0.3 (beta)" }] })), null);
  assert.equal(itunes("<html>오류 페이지</html>"), null, "JSON 이 아니어도 던지지 않는다");
  assert.equal(itunes(null), null);
});

test("바닥값: 못 읽음·이상한 값 → 바닥값, 읽은 값이 바닥보다 낮으면 바닥값, 높으면 읽은 값", () => {
  const { resolveStoreVersion: one, resolveStoreAppLatest: both, STORE_APP_KNOWN_LATEST: floor } = latestModule;
  // 2026-11-15: App Store 공식 조회가 1.0.3 을 돌려줘 아이폰 바닥값도 1.0.3
  assert.deepEqual(floor, { android: "1.0.3", ios: "1.0.3" });
  assert.equal(floor, storeApp.STORE_APP_KNOWN_LATEST, "바닥값은 한 곳(storeApp)에만 있다");
  // 바닥값만으로도(조회가 실패해도) 안드로이드 1.0.2 이하·아이폰 1.0 에게 안내가 뜬다
  assert.equal(notice(AND("1.0.2"), floor).level, "recommended");
  assert.equal(notice(IOS_UNMARKED, floor).level, "legacyApp");
  assert.equal(notice(AND("1.0.3"), floor).level, "none");
  assert.equal(notice(IOS("1.0.3"), floor).level, "none");
  assert.equal(one(null, "1.0.3"), "1.0.3");
  assert.equal(one(undefined, "1.0.3"), "1.0.3");
  assert.equal(one("", "1.0.3"), "1.0.3");
  assert.equal(one("abc", "1.0.3"), "1.0.3");
  assert.equal(one("1.0.2", "1.0.3"), "1.0.3", "스토어가 옛 값을 주면 바닥값");
  assert.equal(one("1.0.3", "1.0.3"), "1.0.3");
  assert.equal(one("1.0.10", "1.0.3"), "1.0.10");
  // 상한: 주 번호가 다르거나 부 번호가 20 이상 뛰면 «잘못 읽은 값» → 바닥값(업데이트해도 안 사라지는 배너 방지)
  assert.equal(one("2.0.0", "1.0.3"), "1.0.3", "주 번호가 다름");
  assert.equal(one("36.0", "1.0.3"), "1.0.3");
  assert.equal(one("1.20.0", "1.0.3"), "1.0.3", "부 번호가 20 이상 큼");
  assert.equal(one("1.19.9", "1.0.3"), "1.19.9", "19 까지는 받는다");
  assert.equal(one("1.0.99", "1.0.3"), "1.0.99", "셋째 번호는 상한을 두지 않는다");
  assert.equal(one("1.25.0", "1.6.0"), "1.25.0", "바닥값 기준으로 잰다");
  assert.equal(storeApp.STORE_VERSION_MAX_MINOR_JUMP, 20);
  assert.deepEqual(both({ android: "8.0", ios: "1.0.4" }), { android: "1.0.3", ios: "1.0.4" });
  assert.deepEqual(both(null), floor);
  assert.deepEqual(both({ android: null, ios: "1.0.3" }), { android: "1.0.3", ios: "1.0.3" }, "한쪽만 읽어도 그쪽은 쓴다");
  assert.deepEqual(both({ android: "1.1.0", ios: null }), { android: "1.1.0", ios: "1.0.3" });
  assert.deepEqual(both({ android: "1.1.0", ios: null }, { android: "1.0.3", ios: "1.0" }), { android: "1.1.0", ios: "1.0" }, "바닥값을 따로 줄 수 있다");
  assert.deepEqual(both({ android: "0.9", ios: "0.1" }), floor);
});

test("최신 버전 조회: 실패해도 던지지 않고 바닥값 — 바깥 요청에 쿠키·식별자를 붙이지 않는다", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  try {
    // 통신이 전부 실패
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); throw new Error("network down"); };
    const failed = load("src/lib/storeApp/latestVersion.ts", { "next/cache": { unstable_cache: (fn) => fn }, "@/lib/app-install-links": links, "@/lib/storeApp": storeApp });
    assert.deepEqual(await failed.getStoreAppLatestVersions(), { android: "1.0.3", ios: "1.0.3" });
    assert.equal(calls.length, 2, "두 스토어를 한 번씩");
    assert.ok(calls.some((c) => c.url === "https://play.google.com/store/apps/details?id=kr.co.upturnlabs.stizdasan&hl=ko&gl=KR"));
    assert.ok(calls.some((c) => c.url === "https://itunes.apple.com/lookup?id=6832261596&country=kr"));
    for (const { init } of calls) {
      assert.equal(init.credentials, "omit");
      assert.deepEqual(Object.keys(init.headers).sort(), ["Accept-Language", "User-Agent"], "쿠키·인증·식별자 머리말 없음");
      assert.ok(init.signal, "시간 제한이 걸려 있다");
    }
    // 실패 직후에는 다시 시도하지 않고 바로 바닥값(화면마다 3초씩 기다리지 않게)
    assert.deepEqual(await failed.getStoreAppLatestVersions(), { android: "1.0.3", ios: "1.0.3" });
    assert.equal(calls.length, 2, "쉬는 시간에는 스토어를 다시 부르지 않는다");

    // 한쪽만 성공(App Store 1.0.4 · Play 오류 응답) → 읽은 쪽은 쓰고 못 읽은 쪽은 바닥값
    globalThis.fetch = async (url) => String(url).includes("itunes")
      ? { ok: true, text: async () => JSON.stringify({ results: [{ version: "1.0.4" }] }) }
      : { ok: false, text: async () => "" };
    const partial = load("src/lib/storeApp/latestVersion.ts", { "next/cache": { unstable_cache: (fn) => fn }, "@/lib/app-install-links": links, "@/lib/storeApp": storeApp });
    assert.deepEqual(await partial.getStoreAppLatestVersions(), { android: "1.0.3", ios: "1.0.4" });

    // 둘 다 성공
    globalThis.fetch = async (url) => String(url).includes("itunes")
      ? { ok: true, text: async () => JSON.stringify({ results: [{ version: "1.0.4" }] }) }
      : { ok: true, text: async () => `"141":[[["1.0.5"]],[[[36]]` };
    const ok = load("src/lib/storeApp/latestVersion.ts", { "next/cache": { unstable_cache: (fn) => fn }, "@/lib/app-install-links": links, "@/lib/storeApp": storeApp });
    assert.deepEqual(await ok.getStoreAppLatestVersions(), { android: "1.0.5", ios: "1.0.4" });
  } finally {
    globalThis.fetch = realFetch;
  }
  const source = read("src/lib/storeApp/latestVersion.ts");
  assert.match(source, /STORE_VERSION_REVALIDATE_SECONDS = 21600/, "6시간 기억");
  assert.match(source, /STORE_VERSION_TIMEOUT_MS = 3000/, "3초 제한");
  assert.match(source, /\{ revalidate: STORE_VERSION_REVALIDATE_SECONDS \}/);
  assert.doesNotMatch(source, /cookies\(|headers\(\)|userId|appUserId/, "사용자 정보를 읽지 않는다");
});

test("바닥값은 앱 소스의 버전보다 높지 않다(아직 없는 버전으로 업데이트를 권하지 않게)", () => {
  const floor = latestModule.STORE_APP_KNOWN_LATEST;
  const gradle = /versionName '([^']+)'/.exec(read("apps/driver-android/app/build.gradle"));
  assert.ok(gradle, "안드로이드 앱 버전을 못 찾았다 — 검사식을 고친다");
  assert.equal(storeApp.isAppVersionBelow(gradle[1], floor.android), false, `안드로이드 바닥값 ${floor.android} > 앱 소스 ${gradle[1]}`);
  // 아이폰: 프로젝트 설정의 출시 버전들 중 가장 높은 값
  const ios = [...read("apps/stiz-ios/STIZ.xcodeproj/project.pbxproj").matchAll(/MARKETING_VERSION = ([0-9.]+);/g)].map((m) => m[1]);
  assert.ok(ios.length > 0, "아이폰 앱 버전을 못 찾았다 — 검사식을 고친다");
  const iosSource = ios.reduce((a, b) => (storeApp.isAppVersionBelow(a, b) ? b : a));
  assert.equal(storeApp.isAppVersionBelow(iosSource, floor.ios), false, `아이폰 바닥값 ${floor.ios} > 앱 소스 ${iosSource}`);
  assert.equal(storeApp.isStoreVersion(floor.android) && storeApp.isStoreVersion(floor.ios), true);
});

test("배너를 띄우지 않는 화면: 결제·로그인/본인인증·운행 중·수업 화면", () => {
  const hide = storeApp.shouldHideAppUpdateBanner;
  const hidden = [
    "/pay/abc123", "/payments/inv_1", "/payments/success", "/payments/fail", "/mypage/payments/checkout", "/mypage/payments/checkout/inv_1", "/mypage/payments/done", "/apply/trial/pay", "/apply/trial/pay/abc",
    "/login", "/auth/continue", "/auth/oauth/kakao", "/auth/callback", "/signup/parent", "/account/activate", "/setup", "/invite/tok", "/teacher-app", "/store-app",
    "/staff/run", "/staff/run/route-1", "/driver/tok123", "/shuttle/run/tok",
    "/staff/sessions/abc",
  ];
  for (const path of hidden) assert.equal(hide(path), true, path);
  const shown = [
    "/", "/mypage", "/mypage/settings", "/mypage/payments", "/mypage/record", "/staff", "/staff/students", "/staff/billing", "/staff/shuttle", "/staff/driver",
    "/driver", "/admin", "/schedule", "/notices/1",
    // 앞머리만 닮은 다른 주소는 숨기지 않는다
    "/payroll", "/authors", "/loginhelp", "/mypage/payments-history", "/apply/trial", "/apply/trial/payment-guide",
  ];
  for (const path of shown) assert.equal(hide(path), false, path);
  assert.equal(hide(null), false);
  assert.equal(hide(undefined), false);
  // 토스 결제창을 여는 화면은 전부 숨김 목록에 있다 — 새 결제 화면이 생기면 여기서 걸린다
  const payScreens = [];
  const walkPay = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`;
      if (statSync(path).isDirectory()) walkPay(path);
      else if (/\.tsx?$/.test(name) && /tosspayments|loadTossPayments|requestPayment/.test(read(path))) payScreens.push(path);
    }
  };
  walkPay("src/app");
  assert.ok(payScreens.length >= 3, "결제 화면을 못 찾았다 — 검사식을 고친다");
  for (const file of payScreens) {
    // src/app/payments/[invoiceId]/X.tsx → /payments/x (대괄호 칸은 아무 글자로)
    const route = file.replace(/^src\/app/, "").replace(/\/[^/]+$/, "").replace(/\[[^\]]+\]/g, "x");
    assert.equal(hide(route), true, `결제창을 여는 화면이 숨김 목록에 없다: ${file}`);
  }
  // 떠 있는 «뒤로» 버튼이 있는 화면(StandaloneBackButton)에는 배너를 두지 않는다 — 겹치지 않게
  const standalone = /const STANDALONE_PREFIXES = \[([\s\S]*?)\];/.exec(read("src/components/StandaloneBackButton.tsx"));
  for (const [, prefix] of standalone[1].matchAll(/"([^"]+)"/g)) assert.equal(hide(prefix), true, `떠 있는 뒤로 버튼 화면: ${prefix}`);
});

test("«나중에»: 3일 동안 숨김(경계) — 열쇠에 최신 버전이 들어가 더 새 버전이 나오면 다시 보인다", () => {
  const { isAppUpdateSnoozed: snoozed, appUpdateSnoozeKey: key, APP_UPDATE_SNOOZE_MS: span } = storeApp;
  const at = 1_800_000_000_000;
  assert.equal(span, 3 * 24 * 60 * 60 * 1000);
  assert.equal(snoozed(String(at), at), true, "누른 직후");
  assert.equal(snoozed(String(at), at + span - 1), true, "3일이 되기 1ms 전");
  assert.equal(snoozed(String(at), at + span), false, "딱 3일");
  assert.equal(snoozed(String(at), at + span + 1), false);
  assert.equal(snoozed(String(at), at - 1), false, "미래 시각(휴대폰 시계를 바꿈)은 숨기지 않는다");
  for (const bad of [null, undefined, "", "abc", "1e9", "-5", "12.5", " "]) assert.equal(snoozed(bad, at), false, String(bad));
  assert.notEqual(key("1.0.3"), key("1.0.4"));
  assert.match(key("1.0.3"), /1\.0\.3$/);
});

test("앱 안에서만 최신 버전을 물어본다: 브라우저는 요청 없음 · 6시간 기억 · 실패하면 바닥값", async () => {
  const { loadStoreAppLatest: loadLatest, readRememberedLatest, APP_LATEST_SESSION_KEY: KEY, APP_LATEST_SESSION_MS: span, APP_LATEST_VERSION_PATH } = client;
  const floor = storeApp.STORE_APP_KNOWN_LATEST;
  const at = 1_800_000_000_000;
  const makeStorage = (entries = {}) => {
    const map = new Map(Object.entries(entries));
    return { map, reads: 0, getItem(k) { this.reads += 1; return map.get(k) ?? null; }, setItem(k, v) { map.set(k, String(v)); } };
  };
  const makeFetch = (answer) => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init }); return answer(); };
    return { calls, fetchImpl };
  };
  const ok = (body) => () => ({ ok: true, json: async () => body });

  assert.equal(APP_LATEST_VERSION_PATH, "/api/app/latest-version");
  assert.equal(span, 6 * 60 * 60 * 1000);

  // ① 브라우저(앱 아님): 요청도 저장소 읽기도 하지 않는다
  {
    const f = makeFetch(ok({ android: "9.9.9", ios: "9.9.9" }));
    const storage = makeStorage();
    assert.equal(await loadLatest({ inApp: false, fetchImpl: f.fetchImpl, storage, nowMs: at }), null);
    assert.equal(f.calls.length, 0, "브라우저 사용자는 요청 자체를 보내지 않는다");
    assert.equal(storage.reads, 0);
  }
  // ② 앱 안: 한 번 부르고 기억한다 → 같은 실행 안에서는 다시 부르지 않는다(6시간)
  {
    const f = makeFetch(ok({ android: "1.0.4", ios: "1.0.3" }));
    const storage = makeStorage();
    assert.deepEqual(await loadLatest({ inApp: true, fetchImpl: f.fetchImpl, storage, nowMs: at }), { android: "1.0.4", ios: "1.0.3" });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "/api/app/latest-version");
    assert.equal(f.calls[0].init.credentials, "omit", "공개 정보 — 쿠키를 붙이지 않는다");
    assert.ok(f.calls[0].init.signal, "시간 제한이 걸려 있다");
    assert.deepEqual(JSON.parse(storage.map.get(KEY)), { at, android: "1.0.4", ios: "1.0.3" });
    assert.deepEqual(await loadLatest({ inApp: true, fetchImpl: f.fetchImpl, storage, nowMs: at + span - 1 }), { android: "1.0.4", ios: "1.0.3" });
    assert.equal(f.calls.length, 1, "기억한 동안에는 다시 부르지 않는다");
    await loadLatest({ inApp: true, fetchImpl: f.fetchImpl, storage, nowMs: at + span });
    assert.equal(f.calls.length, 2, "6시간이 지나면 다시 부른다");
  }
  // ③ 요청 실패·시간 초과·오류 응답: 바닥값 — 기억하지 않아 다음 화면에서 다시 시도한다
  for (const answer of [() => { throw new Error("timeout"); }, () => ({ ok: false, json: async () => ({}) }), () => ({ ok: true, json: async () => { throw new Error("not json"); } })]) {
    const f = makeFetch(answer);
    const storage = makeStorage();
    assert.deepEqual(await loadLatest({ inApp: true, fetchImpl: f.fetchImpl, storage, nowMs: at }), floor);
    assert.equal(storage.map.has(KEY), false, "실패는 기억하지 않는다");
  }
  // ④ 이상한 값·바닥보다 낮은 값(오래된 캐시)은 바닥값으로 올린다
  {
    const f = makeFetch(ok({ android: "1.0.1", ios: "<b>" }));
    assert.deepEqual(await loadLatest({ inApp: true, fetchImpl: f.fetchImpl, storage: makeStorage(), nowMs: at }), floor);
    const g = makeFetch(ok(null));
    assert.deepEqual(await loadLatest({ inApp: true, fetchImpl: g.fetchImpl, storage: makeStorage(), nowMs: at }), floor);
  }
  // ⑤ 저장소를 못 써도(없음·던짐) 판정은 한다
  {
    const f = makeFetch(ok({ android: "1.0.4", ios: "1.0.4" }));
    assert.deepEqual(await loadLatest({ inApp: true, fetchImpl: f.fetchImpl, storage: null, nowMs: at }), { android: "1.0.4", ios: "1.0.4" });
    const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
    assert.deepEqual(await loadLatest({ inApp: true, fetchImpl: f.fetchImpl, storage: broken, nowMs: at }), { android: "1.0.4", ios: "1.0.4" });
  }
  // 기억 읽기(순수): 모양이 이상하거나 미래 시각이면 버린다
  const saved = JSON.stringify({ at, android: "1.0.4", ios: "1.0.3" });
  assert.deepEqual(readRememberedLatest(saved, at), { android: "1.0.4", ios: "1.0.3" });
  assert.equal(readRememberedLatest(saved, at - 1), null);
  for (const bad of [null, "", "abc", "{}", JSON.stringify({ at, android: "x", ios: "1.0" }), JSON.stringify({ at: "1", android: "1.0", ios: "1.0" })]) {
    assert.equal(readRememberedLatest(bad, at), null, String(bad));
  }
  // 바닥값만으로도 안드로이드 1.0.2 이하에게 배너가 뜬다(요청이 실패한 경우)
  assert.equal(notice(AND("1.0.2"), floor).level, "recommended");

  // 훅: 판정 전 = null, 요청은 loadStoreAppLatest 한 곳을 통해서만(isStoreApp 결과를 그대로 넘긴다)
  const hook = read("src/components/storeApp/useAppUpdateNotice.ts");
  assert.match(hook, /const inApp = isInStoreAppForUpdateNotice\(\{ userAgent, referrer: document\.referrer, startFlag, packageName: STORE_APP_PACKAGE \}\);/);
  assert.doesNotMatch(hook, /isStoreApp\(|looksLikeStoreApp/, "넓은 판정(다른 앱이 연 브라우저도 앱으로 봄)을 쓰지 않는다");
  assert.match(hook, /loadStoreAppLatest\(\{ inApp, fetchImpl: \(url, init\) => window\.fetch\(url, init\), storage, nowMs: Date\.now\(\) \}\)/);
  assert.equal((hook.match(/fetch\(/g) || []).length, 1, "훅이 라우트를 직접 부르는 다른 길은 없다");
  assert.match(hook, /target: appUpdateTarget\(userAgent\)/, "스토어 주소는 기존 주소 함수 재사용");
  assert.match(hook, /appUpdateNotice\(\{/, "판정은 storeApp 한 곳");
});

test("라우트 /api/app/latest-version: { android, ios } 만 · CDN 캐시 머리말(실패 땐 짧게) · 조회가 실패해도 200 + 바닥값 · 입력 없음", async () => {
  const floor = storeApp.STORE_APP_KNOWN_LATEST;
  const LONG = "public, s-maxage=21600, stale-while-revalidate=86400";
  const SHORT = "public, s-maxage=600, stale-while-revalidate=600";
  const routeWith = (readStoreAppLatest) => load("src/app/api/app/latest-version/route.ts", {
    "@/lib/storeApp": storeApp,
    "@/lib/storeApp/latestVersion": { readStoreAppLatest },
  });
  // 정상(두 스토어를 다 읽음) → 6시간
  const good = await routeWith(async () => ({ latest: { android: "1.0.4", ios: "1.0.3", extra: "새어 나가면 안 되는 값" }, complete: true })).GET();
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { android: "1.0.4", ios: "1.0.3" });
  assert.equal(good.headers.get("cache-control"), LONG);
  // 한쪽을 못 읽어 바닥값이 섞임 → 10분만(바닥값 응답이 CDN 에 6시간 남지 않게)
  const partial = await routeWith(async () => ({ latest: { android: floor.android, ios: "1.0.4" }, complete: false })).GET();
  assert.equal(partial.status, 200);
  assert.deepEqual(await partial.json(), { android: floor.android, ios: "1.0.4" });
  assert.equal(partial.headers.get("cache-control"), SHORT);
  // 조회가 던져도 200 + 바닥값 + 짧은 캐시
  const bad = await routeWith(async () => { throw new Error("store down"); }).GET();
  assert.equal(bad.status, 200);
  assert.deepEqual(await bad.json(), { android: floor.android, ios: floor.ios });
  assert.equal(bad.headers.get("cache-control"), SHORT);
  // 실제 조회 모듈과 이어 붙여서: 통신 전부 실패 → 바닥값·짧게 / 쉬는 시간(재시도 안 함)에도 짧게 / 둘 다 성공 → 길게
  const realFetch = globalThis.fetch;
  const real = () => load("src/lib/storeApp/latestVersion.ts", { "next/cache": { unstable_cache: (fn) => fn }, "@/lib/app-install-links": links, "@/lib/storeApp": storeApp });
  try {
    globalThis.fetch = async () => { throw new Error("network down"); };
    const down = real();
    for (let i = 0; i < 2; i += 1) {
      const response = await routeWith(down.readStoreAppLatest).GET();
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { android: floor.android, ios: floor.ios });
      assert.equal(response.headers.get("cache-control"), SHORT);
    }
    globalThis.fetch = async (url) => String(url).includes("itunes")
      ? { ok: true, text: async () => JSON.stringify({ results: [{ version: "1.0.4" }] }) }
      : { ok: true, text: async () => `"141":[[["1.0.5"]],[[[36]]` };
    const up = await routeWith(real().readStoreAppLatest).GET();
    assert.deepEqual(await up.json(), { android: "1.0.5", ios: "1.0.4" });
    assert.equal(up.headers.get("cache-control"), LONG);
  } finally {
    globalThis.fetch = realFetch;
  }
  const source = read("src/app/api/app/latest-version/route.ts");
  assert.match(source, /export async function GET\(\) \{/, "요청을 받지 않는다(입력 없음)");
  assert.doesNotMatch(source, /searchParams|request\.|cookies\(|headers\(\)|requireAdmin|requireVerified/, "입력·로그인 정보를 읽지 않는다");
  assert.deepEqual([...source.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map((m) => m[1]), ["GET"], "라우트 파일은 GET 만 내보낸다");
  // 로그인 보호(프록시) 대상이 아니다 — 세션 쿠키가 붙으면 CDN 이 기억하지 못한다
  assert.doesNotMatch(read("src/proxy.ts"), /"\/api/);
});

test("안내용 «앱 안» 판정은 좁게: 다른 앱이 연 브라우저(Gmail 등)는 앱이 아니다 — 배너 없음·요청 없음", async () => {
  const PKG = links.STORE_APP_PACKAGE;
  assert.equal(PKG, "kr.co.upturnlabs.stizdasan");
  const inApp = (input) => storeApp.isInStoreAppForUpdateNotice({ packageName: PKG, ...input });
  const floor = storeApp.STORE_APP_KNOWN_LATEST;
  // 화면이 하는 순서 그대로: 좁은 판정 → (앱이면) 라우트 요청 → 안내 판정
  async function flow({ userAgent, referrer = "", startFlag = null }) {
    const calls = [];
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => floor }; };
    const within = inApp({ userAgent, referrer, startFlag });
    const latest = await client.loadStoreAppLatest({ inApp: within, fetchImpl, storage: null, nowMs: 1_800_000_000_000 });
    const level = latest
      ? storeApp.appUpdateNotice({ inApp: within, app: storeApp.storeAppVersionOf(userAgent), target: links.appUpdateTarget(userAgent), latest }).level
      : "none";
    return { level, requests: calls.length };
  }
  // 안드로이드 크롬 — Gmail·구글 앱·카카오톡에서 연 링크(다른 앱의 referrer): 기존 넓은 판정은 «앱»으로 본다
  for (const referrer of ["android-app://com.google.android.gm", "android-app://com.google.android.gm/", "android-app://com.google.android.googlequicksearchbox", "android-app://com.kakao.talk"]) {
    assert.equal(storeApp.looksLikeStoreApp({ userAgent: AND_UNMARKED, referrer }), true, "기존 판정은 그대로 둔다(다른 기능이 쓴다)");
    assert.deepEqual(await flow({ userAgent: AND_UNMARKED, referrer }), { level: "none", requests: 0 }, referrer);
  }
  // 패키지 이름이 앞부분만 같은 다른 앱
  assert.equal(inApp({ userAgent: AND_UNMARKED, referrer: `android-app://${PKG}.other` }), false);
  assert.equal(inApp({ userAgent: AND_UNMARKED, referrer: `android-app://${PKG}x/` }), false);
  assert.equal(inApp({ userAgent: AND_UNMARKED, referrer: `https://example.com/?r=android-app://${PKG}` }), false);
  // 넓은 판정이 찍은 기존 표식(stiz-store-app)만 있는 브라우저 — 안내용 표식이 아니라 앱이 아니다
  assert.deepEqual(await flow({ userAgent: AND_UNMARKED, startFlag: null }), { level: "none", requests: 0 });
  assert.deepEqual(await flow({ userAgent: PC }), { level: "none", requests: 0 });
  assert.equal(inApp({ userAgent: AND_UNMARKED, startFlag: "0" }), false);
  // 우리 앱(패키지 이름까지 일치)이 연 첫 화면 → 옛 앱 안내
  assert.deepEqual(await flow({ userAgent: AND_UNMARKED, referrer: `android-app://${PKG}` }), { level: "legacyApp", requests: 1 });
  assert.deepEqual(await flow({ userAgent: AND_UNMARKED, referrer: `android-app://${PKG}/` }), { level: "legacyApp", requests: 1 });
  // 앱 시작 주소(/store-app)를 거친 표식 → 옛 앱(아이폰 1.0 포함)
  assert.deepEqual(await flow({ userAgent: IOS_UNMARKED, startFlag: "1" }), { level: "legacyApp", requests: 1 });
  // 사용자 에이전트 표식(1.0.1+) → referrer·표식이 없어도 앱
  assert.deepEqual(await flow({ userAgent: AND("1.0.2") }), { level: "recommended", requests: 1 });
  assert.deepEqual(await flow({ userAgent: AND("1.0.3"), referrer: "android-app://com.google.android.gm" }), { level: "none", requests: 1 });

  // 안내용 표식은 앱 시작 주소에서만 찍는다 — 넓은 판정(isStoreApp)이 찍는 표식과 열쇠가 다르다
  assert.notEqual(storeApp.STORE_APP_START_FLAG_KEY, storeApp.STORE_APP_FLAG_KEY);
  assert.match(read("src/app/store-app/StoreAppStart.tsx"), /markStoreApp\(\);\s*(?:\/\/[^\n]*\n\s*)?markStoreAppStart\(\);/);
  const markers = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && /markStoreAppStart\(\)/.test(read(path))) markers.push(path);
    }
  };
  walk("src");
  assert.deepEqual(markers.sort(), ["src/app/store-app/StoreAppStart.tsx", "src/lib/storeApp.ts"]);
  // 기존 넓은 판정은 건드리지 않았다
  assert.match(read("src/lib/storeApp.ts"), /\|\| String\(input\.referrer \?\? ""\)\.startsWith\("android-app:\/\/"\);/);
});

test("배너가 떠 있는 동안 <html> 표시 → 아래 머리줄이 위쪽 안전영역 여백을 또 먹지 않는다", () => {
  const source = read("src/components/storeApp/AppUpdateBanner.tsx");
  assert.match(source, /if \(!visible\) return;\s*document\.documentElement\.dataset\.appUpdateBanner = "1";\s*return \(\) => \{ delete document\.documentElement\.dataset\.appUpdateBanner; \};/, "보일 때만 달고, 사라지면 뗀다");
  assert.match(source, /pt-\[env\(safe-area-inset-top\)\]/, "배너가 위쪽 안전영역을 먹는다");
  const css = read("src/app/globals.css");
  assert.match(css, /html\[data-app-update-banner\] \.academy-app > header\.academy-staff-header \{\s*padding-top: 0\.75rem;\s*\}/);
  // 그 선택자가 가리키는 머리줄이 실제로 그 모양이다(화면 틀 바로 아래 header · 기본 여백 0.75rem)
  assert.match(read("src/app/staff/layout.tsx"), /<AcademyTheme [^>]*>\s*<header className="academy-staff-header [^"]*pt-\[max\(0\.75rem,env\(safe-area-inset-top\)\)\]">/);
});

test("배너 부품: 서버 그림에는 없다 · 사용자가 누르는 링크 · 글자만 · 저장소는 try/catch", () => {
  const mocks = (level) => ({
    "next/navigation": { usePathname: () => "/mypage" },
    "@/lib/storeApp": storeApp,
    "@/components/storeApp/useAppUpdateNotice": { useAppUpdateNotice: () => level },
    "@/app/staff/staffNavigation": { isStaffLiveLessonOpen: () => false, subscribeStaffLiveLesson: () => () => {} },
  });
  const render = (notice) => renderToStaticMarkup(React.createElement(load("src/components/storeApp/AppUpdateBanner.tsx", mocks(notice)).default));
  // 서버(첫 그림)·판정 전·브라우저 → 아무것도 그리지 않는다(브라우저 사용자에게 깜빡임·밀림 없음)
  assert.equal(render(null), "");
  assert.equal(render({ level: "none", storeUrl: null, latestVersion: "" }), "");
  // «나중에» 확인이 끝나기 전에도 그리지 않는다(누른 사람에게 깜빡 보이지 않게) — 꼭 업데이트만 바로 보인다
  assert.equal(render({ level: "recommended", storeUrl: "https://play.google.com/x", latestVersion: "1.0.3" }), "");
  const required = render({ level: "required", storeUrl: "https://play.google.com/store/x", latestVersion: "1.0.3" });
  assert.match(required, /새 버전\(1\.0\.3\)으로 업데이트해 주세요/);
  assert.match(required, /<a href="https:\/\/play\.google\.com\/store\/x"[^>]*>업데이트<\/a>/);
  assert.doesNotMatch(required, /나중에/, "꼭 업데이트에는 «나중에»가 없다");
  assert.doesNotMatch(required, /target=|<svg|material-symbols/);

  const source = read("src/components/storeApp/AppUpdateBanner.tsx");
  assert.match(source, /^"use client";/);
  assert.match(source, /const notice = useAppUpdateNotice\(requiredMin\);/, "판정·요청은 훅 한 곳(설정 화면과 같다)");
  assert.doesNotMatch(source, /fetch\(|latestVersion"/, "배너가 직접 요청하지 않고, 서버 전용 조회 모듈도 가져오지 않는다");
  assert.match(source, /<a\s+href=\{notice\.storeUrl\}/, "사용자가 직접 누르는 링크");
  assert.doesNotMatch(source, /location\.(href|assign|replace)|window\.open|router\.(push|replace)/, "자동 이동은 하지 않는다(앱이 막는다)");
  assert.doesNotMatch(source, /target="_blank"/, "기존 업데이트 버튼과 같게 target 을 붙이지 않는다");
  assert.match(source, /notice\.level !== "legacyApp" && notice\.storeUrl \?/, "옛 앱에는 눌러도 안 열리는 버튼을 두지 않는다");
  assert.match(source, /notice\.level !== "required" \?/, "꼭 업데이트에는 «나중에»가 없다");
  assert.match(source, /shouldHideAppUpdateBanner\(pathname\)/);
  assert.match(source, /useSyncExternalStore\(subscribeStaffLiveLesson, isStaffLiveLessonOpen, \(\) => false\)/, "선생님 홈 «수업 중» 표시를 읽는다");
  assert.equal((source.match(/try \{/g) || []).length, 2, "저장소 읽기·쓰기 둘 다 try/catch");
  // 화면 규칙: 아이콘·이모지 없이 글자, 굵기 네 단계, 색은 토큰, 누르는 영역 44px, 고정 띠 아님
  assert.doesNotMatch(source, /UiIcon|material-symbols|lucide|<svg/);
  assert.doesNotMatch(source, /font-(bold|extrabold|black)\b/);
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|\b(bg|text|border)-(white|black|gray|slate|blue|red)-?/, "색은 토큰만");
  assert.equal((source.match(/min-h-11/g) || []).length, 3, "줄·업데이트·나중에 모두 44px");
  assert.doesNotMatch(source, /\b(fixed|sticky)\b/, "흐름 안 한 줄 — 머리줄과 겹치지 않는다");
  assert.match(source, /className="academy-app"/, "공개 화면 위에서도 학원 앱 토큰으로 읽힌다");
  // 선생님 «수업 중» 신호 파일은 읽기만 — 표시 이름이 바뀌면 여기서 알아챈다
  assert.match(read("src/app/staff/staffNavigation.ts"), /export function isStaffLiveLessonOpen\(\)/);
});

test("루트 레이아웃은 스토어를 읽지 않는다 — 배너 부품 한 줄만(모든 화면의 서버 그림이 스토어를 기다리지 않게)", () => {
  const layout = read("src/app/layout.tsx");
  assert.equal((layout.match(/<AppUpdateBanner \/>/g) || []).length, 1, "prop 없이 한 번만 연결");
  assert.ok(layout.indexOf("<AppUpdateBanner />") < layout.indexOf("{children}"), "화면 내용 위(맨 위)에 둔다");
  assert.doesNotMatch(layout, /storeApp\/latestVersion|getStoreAppLatestVersions|storeAppLatest|unstable_cache|fetch\(/, "서버 조회·그 import 가 없다");
  // 레이아웃의 await 는 예전부터 있던 «글꼴 설정 읽기» 하나뿐이다
  assert.deepEqual(layout.match(/await [\w.]+\(/g), ["await getAcademySettings("]);
  // 서버 전용 조회 모듈을 가져오는 곳은 공개 라우트 하나뿐이다
  const importers = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && /from "@\/lib\/storeApp\/latestVersion"/.test(read(path))) importers.push(path);
    }
  };
  walk("src");
  assert.deepEqual(importers, ["src/app/api/app/latest-version/route.ts"]);
});

test("설정 «앱 정보» 버전 줄: 같은 훅·같은 판정 — «최신 버전입니다» / «새 버전 + 업데이트»", () => {
  const settings = read("src/app/mypage/settings/page.tsx");
  assert.match(settings, /\{version\.app && \(\s*<AppVersionRow appLabel=\{version\.app\} \/>\s*\)\}/, "브라우저·표식 없는 옛 앱은 줄째 숨김(기존대로)");
  assert.doesNotMatch(settings, /latestVersion|getStoreAppLatestVersions/, "설정 화면 서버 그림도 스토어를 기다리지 않는다");

  const row = (notice) => renderToStaticMarkup(React.createElement(load("src/components/storeApp/AppVersionRow.tsx", {
    "@/components/storeApp/useAppUpdateNotice": { useAppUpdateNotice: () => notice },
  }).default, { appLabel: "앱 1.0.2" }));
  // 판정 전(서버 그림): 버전만
  const before = row(null);
  assert.match(before, />버전<\/span>/);
  assert.match(before, />앱 1\.0\.2<\/span>/);
  assert.doesNotMatch(before, /최신 버전입니다|업데이트|새 버전/);
  // 최신
  assert.match(row({ level: "none", storeUrl: null, latestVersion: "1.0.2" }), />앱 1\.0\.2 · 최신 버전입니다<\/span>/);
  // 더 새 버전이 있다
  const update = row({ level: "recommended", storeUrl: "https://apps.apple.com/kr/app/id1", latestVersion: "1.0.3" });
  assert.match(update, />새 버전 1\.0\.3<\/span>/);
  assert.match(update, /<a href="https:\/\/apps\.apple\.com\/kr\/app\/id1" class="academy-button-secondary academy-button-sm shrink-0 whitespace-nowrap">업데이트<\/a>/);
  assert.doesNotMatch(update, /최신 버전입니다/);
  // 주소가 없으면 버튼 없이 글자만
  assert.doesNotMatch(row({ level: "recommended", storeUrl: null, latestVersion: "1.0.3" }), /<a /);
});
