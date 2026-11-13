// 직원(선생님·기사님) 휴대폰 알림 켜기 (2026-11-10).
// 기사님·코치 웹푸시 구독 0건의 원인 = 켜는 버튼이 학부모 설정 화면에만 있었다 → 직원 머리줄 토글 + 기사님 상단 한 줄.
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
  module.require = (name) => (name in mocks ? mocks[name] : require(name));
  module._compile(compiled, absolute);
  return module.exports;
}

/** 훅 상태를 정해 두고 그려 본다 */
function render(name, state, { storeAppLacksPush = false, appView = "unavailable" } = {}) {
  const mod = load("src/components/push/StaffPushControls.tsx", {
    "@/lib/push/usePushSubscription": { usePushSubscription: () => ({ pushLoading: false, checked: true, togglePush() {}, ...state }) },
    // 스토어 앱 판정(d2) — 기본은 브라우저
    "@/components/storeApp/useStoreAppLacks": { useStoreAppLacks: () => storeAppLacksPush },
    // 앱 알림 상태(e2) — 브라우저에서는 늘 unavailable
    "@/lib/push/useNativePush": { useNativePush: () => ({ view: appView, busy: false, request: async () => {} }) },
    "@/lib/push/nativePushBridge": load("src/lib/push/nativePushBridge.ts"),
  });
  return renderToStaticMarkup(React.createElement(mod[name]));
}

test("머리줄 토글: 켜짐/꺼짐이 글자로 보이고 높이 44, 웹푸시 못 받는 기기·확인 전에는 안 그린다", () => {
  const off = render("StaffPushToggle", { pushSupported: true, pushEnabled: false });
  assert.match(off, /role="switch" aria-checked="false" aria-label="휴대폰 알림 켜기"/);
  // 2026-11-14 아이콘 완전 제거: 종 아이콘 → 글자 «알림 꺼짐/켜짐»(높이 44px 유지)
  assert.match(off, /inline-flex min-h-11/);
  assert.match(off, />알림 꺼짐</);
  assert.doesNotMatch(off, /material-symbols/);
  const on = render("StaffPushToggle", { pushSupported: true, pushEnabled: true });
  assert.match(on, /aria-checked="true" aria-label="휴대폰 알림 켜짐"/);
  assert.equal(render("StaffPushToggle", { pushSupported: false, pushEnabled: false }), "");
  assert.equal(render("StaffPushToggle", { pushSupported: true, pushEnabled: false, checked: false }), "");
});

test("기사님 상단 한 줄: 꺼져 있으면 «켜기», 켜면 사라짐, 못 받는 기기는 홈 화면 추가 안내만", () => {
  const off = render("StaffPushBanner", { pushSupported: true, pushEnabled: false });
  assert.match(off, /알림을 켜면 명단 변경을 바로 받아요/);
  assert.match(off, /class="academy-button-primary min-h-11 shrink-0">켜기</);
  assert.equal(render("StaffPushBanner", { pushSupported: true, pushEnabled: true }), "", "켜면 사라진다");
  const ios = render("StaffPushBanner", { pushSupported: false, pushEnabled: false });
  assert.match(ios, /아이폰은 홈 화면에 추가한 앱에서 알림을 켤 수 있어요/);
  assert.doesNotMatch(ios, /<button/);
});

test("직원 layout: 토글은 선생님·기사님 공통 머리줄, 상단 한 줄은 기사님 역할만 · 같은 훅을 학부모와 함께 쓴다", () => {
  const layout = read("src/app/staff/layout.tsx");
  assert.match(layout, /<StaffPushToggle \/>\s*<StaffProfileMenu/);
  assert.match(layout, /\{staff\.roles\.driver && <StaffPushBanner \/>\}/);
  assert.match(read("src/components/push/StaffPushControls.tsx"), /from "@\/lib\/push\/usePushSubscription"/);
  assert.match(read("src/app/mypage/settings/SettingsClient.tsx"), /from "@\/lib\/push\/usePushSubscription"/);
  // 구독 동작은 한 곳(/api/push) — 켜고 끄면 같은 화면의 다른 부품도 맞춘다
  const hook = read("src/lib/push/usePushSubscription.ts");
  assert.match(hook, /fetch\("\/api\/push", \{\s*method: "POST"/);
  assert.match(hook, /fetch\("\/api\/push", \{\s*method: "DELETE"/);
  assert.equal((hook.match(/window\.dispatchEvent\(new CustomEvent\(PUSH_CHANGED_EVENT/g) || []).length, 2);
});

test("스토어 앱: 토글은 숨기고, 상단 한 줄은 앱 알림의 실제 상태대로 — d2·e2", () => {
  const inApp = (appView) => render("StaffPushBanner", { pushSupported: true, pushEnabled: false }, { storeAppLacksPush: true, appView });
  assert.equal(render("StaffPushToggle", { pushSupported: true, pushEnabled: false }, { storeAppLacksPush: true, appView: "default" }), "");
  // 못 받는 앱(옛 앱·Firebase 설정 없음): 문자·카카오톡 안내, 켜기 버튼 없음
  assert.match(inApp("unavailable"), /중요한 안내는 문자·카카오톡으로 보내드려요/);
  assert.doesNotMatch(inApp("unavailable"), /켜기/);
  // 권한을 거절함: 휴대폰 설정으로 안내
  assert.match(inApp("denied"), /휴대폰 설정에서 알림을 켜 주세요/);
  assert.doesNotMatch(inApp("denied"), /<button/);
  // 아직 안 물어봄: 켜기(누르면 휴대폰이 권한을 묻는다)
  assert.match(inApp("default"), /class="academy-button-primary min-h-11 shrink-0">켜기</);
  // 켜짐·확인 중: 안 그림
  assert.equal(inApp("granted"), "");
  assert.equal(inApp("checking"), "");
});
