// 가입 안내 문자의 «앱 설치» 짧은 주소(/install) — 기기별로 Play 스토어/App Store 로 나눠 보낸다(2026-11-13 f10).
// 순수 모듈(app-install-links)과 기기 판별(installEnvironment)을 실제로 실행하고,
// 문자 문구·화면·기존 /app 짧은 주소가 서로 어긋나지 않는지 소스를 대조한다.
// ⚠️ 문자를 절대 보내지 않는다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
async function load(file) {
  const code = await readFile(file, "utf8");
  const out = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return import(toDataUrl(out));
}

const L = await load("src/lib/app-install-links.ts");
const ENV = await load("src/lib/pwa/installEnvironment.ts");
const T = await load("src/lib/customer-notice/templates.ts");

const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
  androidKakao: "Mozilla/5.0 (Linux; Android 13; SM-G991N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 KAKAOTALK 10.4.5",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  iphoneKakao: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 KAKAOTALK 10.4.5",
  pc: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
};
const targetFor = (ua, id) => L.resolveAppInstallTarget(ENV.detectInstallEnvironment({ userAgent: ua }).platform, id);

test("안드로이드(카카오톡 안 포함)는 Play 스토어 앱 상세로 바로 보낸다", () => {
  assert.equal(L.PLAY_STORE_URL, "https://play.google.com/store/apps/details?id=kr.co.upturnlabs.stizdasan");
  for (const ua of [UA.android, UA.androidKakao]) assert.deepEqual(targetFor(ua), { kind: "redirect", url: L.PLAY_STORE_URL });
});

test("아이폰: App Store 번호가 비어 있으면 «곧 출시» 화면, 숫자가 채워지면 App Store 로 바로", () => {
  assert.equal(L.IOS_APP_STORE_ID, "", "출시 전에는 비워 둔다 — 채우면 이 테스트도 같이 고친다");
  for (const ua of [UA.iphone, UA.iphoneKakao]) {
    assert.deepEqual(targetFor(ua), { kind: "ios-coming-soon" });
    assert.deepEqual(targetFor(ua, "6740000000"), { kind: "redirect", url: "https://apps.apple.com/kr/app/id6740000000" });
  }
  // 숫자가 아닌 값은 엉뚱한 곳으로 보내지 않는다
  for (const bad of ["abc", "id123", " ", "123/../evil"]) assert.deepEqual(targetFor(UA.iphone, bad), { kind: "ios-coming-soon" }, bad);
  assert.equal(L.appStoreUrl(""), null);
});

test("PC 등 기기를 모르면 고르는 화면", () => {
  assert.deepEqual(targetFor(UA.pc), { kind: "choose" });
  assert.deepEqual(targetFor(""), { kind: "choose" });
});

test("문자 문구의 앱 설치 주소 = 화면 경로(/install), 가입 안내 문자에 한 번 들어간다", () => {
  assert.equal(L.APP_INSTALL_PATH, "/install");
  assert.equal(T.PARENT_APP_INSTALL_URL, `https://www.stiz-dasan.kr${L.APP_INSTALL_PATH}`);
  const body = T.buildParentSignupGuideMessage();
  assert.equal(body.split(T.PARENT_APP_INSTALL_URL).length - 1, 1);
  assert.match(body, /▶ 앱 설치: https:\/\/www\.stiz-dasan\.kr\/install\n/);
  assert.ok(existsSync("src/app/install/page.tsx"), "짧은 주소의 화면이 있어야 한다");
});

test("설치 화면: 기기 판별 공용 모듈 → 스토어로 바로 이동, 요청마다 판단(미리 만들지 않음), 로그인 없이 열림", async () => {
  const page = await readFile("src/app/install/page.tsx", "utf8");
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /detectInstallEnvironment\(\{ userAgent: \(await headers\(\)\)\.get\("user-agent"\) \|\| "" \}\)/);
  assert.match(page, /resolveAppInstallTarget\(env\.platform\)/);
  assert.match(page, /if \(target\.kind === "redirect"\) redirect\(target\.url\)/);
  // 아이폰 출시 전 안내 + 웹으로 쓰기 버튼
  assert.match(page, /아이폰 앱은 곧 출시돼요/);
  assert.match(page, /href="\/mypage"/);
  // 하드코딩 색 금지 — 공개 홈페이지 토큰만
  assert.doesNotMatch(page, /#[0-9a-fA-F]{3,6}\b|bg-(?:white|black|gray|orange)-?/);
  const proxy = await readFile("src/proxy.ts", "utf8");
  assert.doesNotMatch(proxy, /"\/install/, "로그인 보호 대상이 아니어야 한다");
});

test("기존 /app 짧은 주소(홈 화면 바로가기)는 그대로 — 새 설치 주소가 덮지 않는다", async () => {
  const config = await readFile("next.config.ts", "utf8");
  assert.match(config, /source: "\/app",\s*destination: "\/mypage\/install"/);
  assert.equal(existsSync("src/app/app"), false);
});

test("App Store·Play 스토어 주소는 상수 한 곳에서만 만든다", async () => {
  const { readdirSync, statSync, readFileSync } = await import("node:fs");
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = `${dir}/${name}`;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name) && /apps\.apple\.com\/kr\/app|play\.google\.com\/store\/apps\/details/.test(readFileSync(path, "utf8"))) hits.push(path);
    }
  };
  walk("src");
  assert.deepEqual(hits, ["src/lib/app-install-links.ts"]);
});
