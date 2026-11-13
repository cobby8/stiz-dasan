import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 판별·주소 생성 모듈은 의존성이 없는 순수 함수라 실제로 실행해서 검증한다.
// (문자열 매칭만으로는 인텐트 주소 형식이 깨진 것을 못 잡는다 — 잘못된 인텐트는 빈 화면이 된다)
const moduleSource = await readFile("src/lib/pwa/installEnvironment.ts", "utf8");
const transpiled = ts.transpileModule(moduleSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildChromeIntentUrl, shouldOfferChromeIntent } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const helpSource = await readFile("src/components/pwa/InstallHelp.tsx", "utf8");

/* ---------------- intent 주소 형식 ---------------- */

test("https 주소는 크롬을 지정한 intent 주소로 바뀐다", () => {
  const url = "https://stiz.example.com/app";
  const intent = buildChromeIntentUrl(url);

  assert.equal(
    intent,
    `intent://stiz.example.com/app#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`,
  );
  // 스킴을 빼먹으면 크롬이 주소를 해석하지 못한다.
  assert.match(intent, /;scheme=https;/);
  // 크롬을 콕 집어야 한다. 없으면 다시 삼성 인터넷으로 열릴 수 있다.
  assert.match(intent, /;package=com\.android\.chrome;/);
  assert.match(intent, /;end$/);
});

test("크롬이 없는 기기를 위한 fallback 주소가 반드시 들어가고, 인코딩돼 있다", () => {
  const url = "https://stiz.example.com/app?ref=kakao&x=1";
  const intent = buildChromeIntentUrl(url);

  // fallback 이 없으면 인텐트 실패 시 빈 화면이 된다. 필수 항목이다.
  assert.match(intent, /S\.browser_fallback_url=/);
  const fallback = intent.split("S.browser_fallback_url=")[1].replace(/;end$/, "");
  // 인코딩이 안 되면 원본의 & 나 : / 가 인텐트 파라미터 구분자와 충돌해 주소가 깨진다.
  assert.equal(fallback, encodeURIComponent(url));
  assert.equal(decodeURIComponent(fallback), url);
  assert.doesNotMatch(fallback, /[&;:/?]/);
});

test("쿼리스트링이 있는 주소도 인텐트 본문에 그대로 보존된다", () => {
  const intent = buildChromeIntentUrl("https://stiz.example.com/app?ref=kakao&x=1");
  assert.ok(intent.startsWith("intent://stiz.example.com/app?ref=kakao&x=1#Intent;"));
});

test("포트·한글 경로가 있는 https 주소도 정상 처리한다", () => {
  const intent = buildChromeIntentUrl("https://stiz.example.com:8443/app");
  assert.ok(intent.startsWith("intent://stiz.example.com:8443/app#Intent;"));
  assert.equal(typeof buildChromeIntentUrl("https://stiz.example.com/앱"), "string");
});

test("https가 아니거나 비정상 입력이면 null을 돌려준다", () => {
  // 잘못된 인텐트를 만들면 눌렀을 때 빈 화면이 된다. 만들지 않는 편이 낫다.
  assert.equal(buildChromeIntentUrl("http://stiz.example.com/app"), null);
  assert.equal(buildChromeIntentUrl("http://localhost:4000/app"), null);
  assert.equal(buildChromeIntentUrl("javascript:alert(1)"), null);
  assert.equal(buildChromeIntentUrl("/app"), null);
  assert.equal(buildChromeIntentUrl(""), null);
  assert.equal(buildChromeIntentUrl(undefined), null);
  assert.equal(buildChromeIntentUrl(null), null);
});

/* ---------------- iOS에서는 버튼이 없어야 한다 ---------------- */

test("intent 버튼은 안드로이드에서만 제공한다 (iOS에서는 동작하지 않는다)", () => {
  assert.equal(shouldOfferChromeIntent("android"), true);
  assert.equal(shouldOfferChromeIntent("ios"), false);
  assert.equal(shouldOfferChromeIntent("other"), false);
});

test("‘크롬으로 열기’ 버튼은 안드로이드가 아니면 렌더 자체를 하지 않는다", () => {
  // 공용 컴포넌트가 판단을 순수 함수에 위임하고, 아니면 즉시 null 을 반환해야 한다.
  assert.match(helpSource, /export function OpenInChromeButton/);
  assert.match(helpSource, /if \(!shouldOfferChromeIntent\(platform\)\) return null;/);
  assert.match(helpSource, /크롬으로 열기/);
  // 인앱 탈출 카드에서 안드로이드일 때만 이 버튼을 건다.
  assert.match(helpSource, /platform === "android" \? \([\s\S]{0,200}OpenInChromeButton/);
  // iOS 전용 카카오톡 스킴 버튼은 안드로이드에서 중복 노출되지 않는다.
  assert.match(helpSource, /inAppBrowser === "kakaotalk" && platform !== "android"/);
});

/* ---------------- 인앱 탈출 카드의 보조 안내 유지 ---------------- */

test("인텐트가 막히는 기기를 위해 메뉴 안내와 주소 복사는 그대로 남긴다", () => {
  assert.match(helpSource, /getInAppEscapeSteps/);
  assert.match(helpSource, /CopyAddressButton/);
  // 카카오톡 외부 브라우저 스킴(iOS 경로)도 유지돼야 한다.
  assert.match(helpSource, /buildKakaoExternalUrl/);
});

/* ---------------- 삼성 인터넷 권유 ---------------- */

test("삼성 인터넷에는 크롬 권유를 붙이되 3단계 안내는 그대로 유지한다", () => {
  assert.match(helpSource, /androidBrowser === "samsung"/);
  assert.match(helpSource, /안전하지 않은 앱/);
  assert.match(helpSource, /경고 없이 설치/);
  // 기존 수동 3단계 안내는 계속 그린다(크롬이 없는 분도 있다).
  assert.match(helpSource, /getAndroidInstallSteps/);
  // 🚫 보안 경고를 무시하라고 가르치면 진짜 악성 앱도 그렇게 설치하게 된다.
  assert.doesNotMatch(helpSource, /무시하고/);
  assert.doesNotMatch(helpSource, /무시한 뒤|그냥 설치/);
});

test("새 UI도 하드코딩 색상 없이 토큰·다크모드 클래스를 쓴다", () => {
  const chromeButtonBlock = helpSource.slice(
    helpSource.indexOf("export function OpenInChromeButton"),
    helpSource.indexOf("type AndroidInstallStepsProps"),
  );
  assert.ok(chromeButtonBlock.length > 0);
  assert.match(chromeButtonBlock, /var\(--brand-accent\)/);
  assert.match(chromeButtonBlock, /dark:/);
  // #rrggbb 같은 하드코딩 색상 금지
  assert.doesNotMatch(chromeButtonBlock, /#[0-9a-fA-F]{3,8}\b/);
  // 2026-11-13 UI 통일: 버튼은 아이콘 없이 글자(«크롬으로 열기»)로 말한다 — 옛 «아이콘 글꼴을 쓴다» 단언을 뒤집었다.
  assert.doesNotMatch(chromeButtonBlock, /material-symbols-outlined/);
  assert.match(chromeButtonBlock, /\{label\}/);
});
