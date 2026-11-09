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
function render(name, state) {
  const mod = load("src/components/push/StaffPushControls.tsx", {
    "@/lib/push/usePushSubscription": { usePushSubscription: () => ({ pushLoading: false, checked: true, togglePush() {}, ...state }) },
  });
  return renderToStaticMarkup(React.createElement(mod[name]));
}

test("머리줄 토글: 켜짐/꺼짐이 보이고 44×44, 웹푸시 못 받는 기기·확인 전에는 안 그린다", () => {
  const off = render("StaffPushToggle", { pushSupported: true, pushEnabled: false });
  assert.match(off, /role="switch" aria-checked="false" aria-label="휴대폰 알림 켜기"/);
  assert.match(off, /inline-flex size-11/);
  assert.match(off, /notifications_off/);
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
