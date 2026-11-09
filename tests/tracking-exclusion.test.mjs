// 보안 검수 HIGH(2026-11-10): 주소에 열쇠(토큰)가 있는 화면에서 Meta 픽셀이 주소 전체(dl)를 facebook.com 으로 보내던 문제.
// 1) 한 곳 목록(trackingExclusion.ts)을 실제로 실행 — 토큰 경로·쿼리는 막고 일반 경로는 그대로.
// 2) src/app 의 [token]·[code] 동적 경로가 목록에 빠짐없이 있는지(새 토큰 화면이 생기면 여기서 걸린다).
// 3) MetaPixel 을 실제로 렌더·실행 — 토큰 경로에서 스크립트·noscript 이미지·이벤트가 없고, 일반 경로는 예전대로.
// 4) next.config 헤더 — /apply/trial/pay 아래는 no-referrer·noindex 한 벌만(일반 규칙과 중복 없음).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

const exclusion = await loadTsModule("src/lib/privacy/trackingExclusion.ts");
const require = createRequire(import.meta.url);

const BLOCKED = [
  ["/apply/trial/pay/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde", ""],
  ["/apply/trial/pay/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde", "?failed=1&code=USER_CANCEL"],
  ["/apply/trial/pay/done", "?t=AbCdEf&paymentKey=pk&orderId=TRIAL-abc123&amount=10000"],
  ["/apply/trial/pay", ""],
  ["/apply/uniform/free/tok", ""],
  ["/driver/tok", ""],
  ["/driver/tok/", ""],
  ["/shuttle/run/tok", ""],
  ["/shuttle/regular/tok", ""],
  ["/shuttle/location/tok", ""],
  ["/invite/tok", ""],
  ["/request/tok", ""],
  ["/request/reconfirm/tok", ""],
  ["/e/code1", ""],
  ["/account/activate", "?token=abc"],
  ["/kakao-connect", "?token=abc"],
  ["/mypage/kakao-connect", "?token=abc"],
  ["/apply/enroll", "?access=CODE123"], // 짧은 링크(/e/[code])가 넘기는 접근 코드
  ["/anything", "?token=abc"],
];
const ALLOWED = [
  ["/", ""],
  ["/apply", ""],
  ["/apply/trial", "?utm_source=naver&utm_medium=cpc"],
  ["/apply/enroll", ""],
  ["/apply/trial/payment", ""],
  ["/driverish/tok", ""],
  ["/programs", "?test_event_code=TEST123"],
  ["/schedule", ""],
  ["/mypage", ""],
];

test("토큰 주소(경로·쿼리)는 추적 금지, 일반 주소는 그대로", () => {
  for (const [p, q] of BLOCKED) assert.equal(exclusion.isTrackingBlockedLocation(p, q), true, `${p}${q}`);
  for (const [p, q] of ALLOWED) assert.equal(exclusion.isTrackingBlockedLocation(p, q), false, `${p}${q}`);
  assert.equal(exclusion.isTrackingBlockedPath("/apply/trial/pay/done"), true);
  assert.equal(exclusion.isTrackingBlockedPath("/account/activate"), true, "쿼리 토큰 화면은 경로로도 막아 스크립트를 싣지 않는다");
});

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? [p, ...walk(p)] : [];
  });
}

test("가드: src/app 의 [token]·[code] 동적 경로는 전부 목록에 있다(새 토큰 화면은 목록에 추가할 것)", () => {
  const dirs = walk("src/app").map((d) => d.replace(/\\/g, "/")).filter((d) => /\/\[(?:token|code)\]$/.test(d) && !d.startsWith("src/app/api/"));
  assert.ok(dirs.length >= 9, `토큰 경로를 찾았다: ${dirs.length}`);
  for (const dir of dirs) {
    const route = dir.replace(/^src\/app/, "").replace(/\[(?:token|code)\]$/, "synthetic-token");
    assert.equal(exclusion.isTrackingBlockedPath(route), true, `${dir} 를 TOKEN_PATH_PREFIXES 에 넣어야 한다`);
  }
  // 쿼리로 토큰을 받는 화면도 목록에 있다(링크를 만드는 코드 기준)
  for (const [file, pathname] of [
    ["src/lib/parent-account-claim.ts", "/account/activate"],
    ["src/lib/kakao-parent-chatbot.ts", "/mypage/kakao-connect"],
    ["src/lib/trial-fee/trialFeePaymentService.ts", "/apply/trial/pay/done"],
  ]) {
    assert.ok(readFileSync(file, "utf8").includes(pathname), file);
    assert.equal(exclusion.isTrackingBlockedPath(pathname), true, pathname);
  }
});

/** MetaPixel 을 실제로 불러온다(next 모듈은 가짜) */
function loadPixel(pathname) {
  const code = ts.transpileModule(readFileSync("src/components/MetaPixel.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports = {};
  const deps = {
    react: React,
    "next/navigation": { usePathname: () => pathname },
    "next/script": { default: ({ id, children }) => React.createElement("script", { "data-id": id }, children) },
    "@/lib/privacy/trackingExclusion": exclusion,
  };
  new Function("require", "exports", code)((id) => (id in deps ? deps[id] : require(id)), exports);
  return exports;
}

test("픽셀 렌더: 토큰 경로는 스크립트·noscript 이미지를 아예 싣지 않고, 일반 경로는 예전대로", () => {
  for (const [p] of BLOCKED.filter(([p]) => exclusion.isTrackingBlockedPath(p))) {
    const { default: MetaPixel } = loadPixel(p);
    assert.equal(renderToStaticMarkup(React.createElement(MetaPixel)), "", p);
  }
  const { default: MetaPixel } = loadPixel("/");
  const html = renderToStaticMarkup(React.createElement(MetaPixel));
  assert.match(html, /fbq\('init'/);
  assert.match(html, /fbq\.disablePushState = true;/, "앱 안 이동 때 픽셀이 스스로 PageView 를 보내지 않게");
  assert.match(html, /facebook\.com\/tr\?id=/);
});

test("픽셀 이벤트: 토큰 주소에서는 fbq 를 부르지 않고(PageView·Lead 모두), 일반 주소는 그대로 보낸다", () => {
  const { trackMetaEvent } = loadPixel("/");
  const calls = [];
  const original = globalThis.window;
  try {
    for (const [p, q] of BLOCKED) {
      globalThis.window = { location: { pathname: p, search: q }, fbq: (...args) => calls.push(args), setTimeout: () => { throw new Error("재시도도 하면 안 된다"); } };
      trackMetaEvent("PageView");
      trackMetaEvent("Lead", { content_name: "x" });
    }
    assert.deepEqual(calls, []);
    for (const [p, q] of ALLOWED) {
      globalThis.window = { location: { pathname: p, search: q }, fbq: (...args) => calls.push(args) };
      trackMetaEvent("PageView");
    }
    assert.equal(calls.length, ALLOWED.length);
    assert.deepEqual(calls[0], ["track", "PageView", {}]);
  } finally {
    globalThis.window = original;
  }
  // PageView 는 화면 이동마다 판정을 거치는 trackMetaEvent 로만 보낸다
  const src = readFileSync("src/components/MetaPixel.tsx", "utf8");
  assert.match(src, /useEffect\(\(\) => \{\s*trackMetaEvent\("PageView"\);/);
  assert.match(src, /if \(isTrackingBlockedLocation\(window\.location\.pathname, window\.location\.search\)\) return;/);
});

// ── next.config 헤더(driver-permissions-policy 와 같은 방식으로 실제 규칙을 맞춰 본다) ──
const { getPathMatch } = require("next/dist/shared/lib/router/utils/path-match");
const configSrc = readFileSync("next.config.ts", "utf8");
const sandbox = { exports: {} };
vm.runInNewContext(ts.transpileModule(configSrc, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
const rules = JSON.parse(JSON.stringify(await sandbox.exports.default.headers()));
const headersOf = (pathname) => rules.filter((rule) => getPathMatch(rule.source)(pathname) !== false).flatMap((rule) => rule.headers);

test("헤더: /apply/trial/pay 아래는 no-referrer·noindex 한 벌만(일반 규칙과 겹치지 않음)", () => {
  for (const pathname of ["/apply/trial/pay/synthetic-token", "/apply/trial/pay/done", "/apply/trial/pay"]) {
    const list = headersOf(pathname);
    const keys = list.map((h) => h.key);
    assert.equal(new Set(keys).size, keys.length, `${pathname} 헤더 중복 없음: ${keys.join(",")}`);
    const map = Object.fromEntries(list.map((h) => [h.key, h.value]));
    assert.equal(map["Referrer-Policy"], "no-referrer", pathname);
    assert.equal(map["X-Robots-Tag"], "noindex, nofollow, noarchive", pathname);
    assert.equal(map["X-Frame-Options"], "DENY");
    assert.equal(map["Permissions-Policy"], "camera=(), microphone=(), geolocation=()");
  }
  for (const pathname of ["/apply/trial", "/apply", "/apply/trial/payment"]) {
    const map = Object.fromEntries(headersOf(pathname).map((h) => [h.key, h.value]));
    assert.equal(map["Referrer-Policy"], "strict-origin-when-cross-origin", pathname);
    assert.equal(map["X-Robots-Tag"], undefined, pathname);
  }
});
