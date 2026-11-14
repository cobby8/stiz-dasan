// 아이콘 글꼴 실패·지연 대체 (2026-11-15).
// 글꼴 주소가 막히거나 늦으면 아이콘이 계속 투명이라, 종·톱니처럼 «아이콘만 있는 버튼»이 보이지 않는 44px 빈칸이 됐다.
//  ① 순수 판정: 일(글꼴 도착·CSS 실패·글꼴 실패·시간 초과) → 상태 → 루트 클래스
//  ② 공용 부품 UiIcon 은 아이콘 글자 옆에 대체 글자를 함께 그려 둔다(둘 다 aria-hidden — 이름은 버튼이 준다)
//  ③ 전환은 CSS(html 의 material-symbols-fallback) — JS 상태 없이
//  ④ 연결부(DeferredFontStyles)는 글꼴 «파일»이 준비된 뒤에 ready 를 붙이고, 실패·시간 초과를 알린다
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

function load(path) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => require(name);
  module._compile(compiled, absolute);
  return module.exports;
}

const rules = load("src/lib/ui/iconFontState.ts");
const icon = load("src/components/common/UiIcon.tsx");

test("① 판정: 글꼴이 도착하면 언제든 ready, 실패·시간 초과는 fallback, 한번 ready 면 내려가지 않는다", () => {
  const { nextIconFontState: next } = rules;
  assert.equal(next("pending", "font-loaded"), "ready");
  for (const event of ["css-error", "font-error", "timeout"]) {
    assert.equal(next("pending", event), "fallback", event);
    assert.equal(next("fallback", event), "fallback", `${event}: 이미 대체 상태면 그대로`);
    assert.equal(next("ready", event), "ready", `${event}: 글꼴을 이미 쓰고 있으면 늦게 울린 타이머가 아이콘을 치우지 않는다`);
  }
  // 시간 초과 뒤 늦게 도착 → 아이콘으로 되돌린다
  assert.equal(next(next("pending", "timeout"), "font-loaded"), "ready");
  assert.equal(next(next("pending", "css-error"), "font-loaded"), "ready");
  assert.equal(rules.ICON_FONT_TIMEOUT_MS, 4000);
});

test("① 상태 → 루트 클래스: ready 와 fallback 은 함께 붙지 않는다", () => {
  const { iconFontRootClasses: classes, ICON_FONT_READY_CLASS: READY, ICON_FONT_FALLBACK_CLASS: FALLBACK } = rules;
  assert.equal(READY, "material-symbols-ready");
  assert.equal(FALLBACK, "material-symbols-fallback");
  assert.deepEqual(classes("ready"), { add: [READY], remove: [FALLBACK] });
  assert.deepEqual(classes("fallback"), { add: [FALLBACK], remove: [READY] });
  assert.deepEqual(classes("pending"), { add: [], remove: [READY, FALLBACK] }, "첫 그리기는 지금처럼 폭 고정·투명");
  // 순서대로 적용해 본다: 시간 초과 → 늦게 도착
  const root = new Set();
  let state = "pending";
  for (const event of ["timeout", "font-loaded", "timeout"]) {
    state = rules.nextIconFontState(state, event);
    const { add, remove } = classes(state);
    remove.forEach((name) => root.delete(name));
    add.forEach((name) => root.add(name));
    assert.ok(!(root.has(READY) && root.has(FALLBACK)), `${event} 뒤 두 클래스가 함께 붙었다`);
  }
  assert.deepEqual([...root], [READY]);
});

test("② UiIcon: 아이콘 글자와 대체 글자를 함께 그리고, 전부 aria-hidden 안에 둔다", () => {
  const expected = { expand_more: "▾", expand_less: "▴", notifications: "알림", notifications_off: "알림 끔", settings: "설정" };
  assert.deepEqual(icon.UI_ICON_FALLBACK_TEXT, expected, "대체 글자는 허용 5종 전부에 있다");
  for (const [name, text] of Object.entries(expected)) {
    const html = renderToStaticMarkup(React.createElement(icon.default, { name }));
    assert.equal(html, `<span aria-hidden="true" class="ui-icon inline-flex shrink-0 items-center justify-center leading-none"><span class="material-symbols-outlined text-xl">${name}</span><span class="ui-icon-fallback">${text}</span></span>`);
    // 44px 버튼(size-11)에 들어가는 길이: 12px 글자 기준 한글 3자 + 띄어쓰기까지(약 40px)
    assert.ok([...text.replaceAll(" ", "")].length <= 3, `${name}: 대체 글자 «${text}» 가 44px 버튼에 넘친다`);
  }
  // 크기·회전 클래스: 회전은 바깥 칸에 — 대체 글자 ▾ 도 같이 돌아 뜻이 맞는다
  const big = renderToStaticMarkup(React.createElement(icon.default, { name: "settings", size: 24, className: "group-open:rotate-180" }));
  assert.match(big, /^<span aria-hidden="true" class="ui-icon [^"]*group-open:rotate-180"><span class="material-symbols-outlined text-2xl">settings<\/span>/);
  assert.equal((big.match(/aria-hidden/g) || []).length, 1, "바깥 칸 하나가 통째로 숨김 — 대체 글자가 화면 낭독에 두 번 읽히지 않는다");
});

test("③ CSS: 평소엔 대체 글자 숨김, fallback 클래스일 때만 아이콘을 치우고 12px 한 줄 글자를 보인다", () => {
  const css = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\n\.ui-icon-fallback \{\s*display: none;\s*\}/);
  assert.match(css, /\.material-symbols-fallback \.material-symbols-outlined \{\s*display: none;\s*\}/, "투명한 아이콘 자리를 치운다(⚡ 포함)");
  const shown = css.match(/\.material-symbols-fallback \.ui-icon-fallback \{([^}]*)\}/)?.[1] ?? "";
  assert.match(shown, /display: inline;/);
  assert.match(shown, /font-size: 12px;/, "글자 최소 크기 12px");
  assert.match(shown, /white-space: nowrap;/, "좁은 버튼에서 줄바꿈하지 않는다");
  // 첫 그리기는 그대로: 폭 고정·투명(깜빡임이 커지지 않게), ready 일 때만 글꼴·색
  const first = css.match(/\n\.material-symbols-outlined \{([^}]*)\}/)?.[1] ?? "";
  assert.match(first, /width: 1em;/);
  assert.match(first, /color: transparent;/);
  assert.match(css, /\.material-symbols-ready \.material-symbols-outlined \{[^}]*font-family: "Material Symbols Outlined";[^}]*color: currentColor;/);
});

test("④ 연결부: 글꼴 파일이 준비된 뒤 ready, CSS 실패·글꼴 실패·시간 초과는 대체로", () => {
  const source = read("src/components/DeferredFontStyles.tsx");
  assert.match(source, /link\.onerror = \(\) => onError\?\.\(\);/, "CSS 주소가 막힌 것을 알아챈다");
  assert.match(source, /\}, \(\) => applyIconEvent\("css-error"\)\);/);
  assert.match(source, /window\.setTimeout\(\(\) => applyIconEvent\("timeout"\), ICON_FONT_TIMEOUT_MS\)/);
  assert.match(source, /fonts\.load\(ICON_FONT_SPEC, "settings"\)\s*\.then\(\(faces\) => applyIconEvent\(faces\.length > 0 && fonts\.check\(ICON_FONT_SPEC, "settings"\) \? "font-loaded" : "font-error"\)\)\s*\.catch\(\(\) => applyIconEvent\("font-error"\)\);/);
  assert.match(source, /const ICON_FONT_SPEC = '24px "Material Symbols Outlined"';/);
  // 클래스는 순수 규칙이 정한 것만 붙이고 뗀다 — 여기서 클래스 이름을 직접 쓰지 않는다
  assert.match(source, /iconState = nextIconFontState\(iconState, event\);\s*const \{ add, remove \} = iconFontRootClasses\(iconState\);/);
  assert.doesNotMatch(source, /classList\.add\("material-symbols-ready"\)/, "CSS 로딩만으로 ready 를 붙이던 옛 코드가 돌아왔다");
});

test("⚡ 빠른작업 버튼도 글꼴을 못 받으면 글자 기호가 보인다", () => {
  const quick = read("src/components/admin/AdminQuickActionMenu.tsx");
  assert.match(quick, /<span className="material-symbols-outlined text-xl" aria-hidden="true">\{icon\}<\/span>\s*\{\/\*[^*]*\*\/\}\s*<span className="ui-icon-fallback" aria-hidden="true">\{icon === "more_horiz" \? "⋯" : "⚡"\}<\/span>/);
  assert.match(quick, /aria-label=\{label\}\s*title=\{label\}/, "이름은 aria-label 이 준다");
});
