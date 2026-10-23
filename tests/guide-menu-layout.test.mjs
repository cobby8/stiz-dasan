import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

function harness() {
  const events = new EventTarget();
  const targets = new Map();
  const observers = [];
  const timers = [];
  const instances = [];
  const element = (name, overrides = {}) => ({
    getAttribute: () => name,
    getClientRects: () => [1],
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 110, bottom: 50 }),
    closest: () => null,
    visibility: "visible",
    ...overrides,
  });
  const window = Object.assign(events, { innerWidth: 1440, innerHeight: 900, setTimeout: (fn) => timers.push(fn) });
  const driver = (initialConfig) => {
    let config = initialConfig;
    const instance = {
      active: undefined,
      step: undefined,
      destroyed: 0,
      getActiveElement: () => instance.active,
      getActiveStep: () => instance.step,
      getConfig: () => config,
      getState: () => ({}),
      setConfig: (value) => { config = value; },
      destroy: () => { instance.destroyed += 1; config.onDestroyed?.(); },
      highlight: (target, step = {}) => { instance.active = target; instance.step = step; config.onHighlighted?.(); },
    };
    instances.push(instance);
    return instance;
  };
  const context = vm.createContext({
    window, Event, document: { documentElement: {}, querySelector: (selector) => targets.get(selector) },
    getComputedStyle: (node) => ({ visibility: node.visibility }),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; this.targets = new Map(); observers.push(this); }
      observe(target, options) { this.connected = true; this.targets.set(target, options); }
      disconnect() { this.connected = false; this.targets.clear(); }
      mutate(target, attributeName) {
        if (this.targets.get(target)?.attributeFilter.includes(attributeName)) this.callback();
      }
    },
    module: { exports: {} },
    require: (name) => name === "driver.js" ? { driver } : {},
  });
  const source = readFileSync(new URL("../src/components/guide-tour/GuideTourTrigger.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  context.exports = context.module.exports;
  vm.runInContext(`${compiled}\nmodule.exports.testing = { loadDriver, isHiddenTourMenuTarget, waitForOpenedTourMenu };`, context);
  return { ...context.module.exports.testing, window, element, targets, observers, timers, instances };
}

test("보이는 메뉴는 유지하고 숨겨진 메뉴만 실제 닫기와 정리 후 재시작한다", async () => {
  const h = harness();
  const create = await h.loadDriver();
  let closed = 0;
  let cleaned = 0;
  let restarted = 0;
  h.window.addEventListener("stiz:tour-menu-layout-change", () => { restarted += 1; });
  const d = create({ onDestroyed: () => { cleaned += 1; } });
  const target = h.element("nav-programs");
  d.highlight(target, { popover: { onCloseClick: () => { closed += 1; d.destroy(); } } });
  h.window.dispatchEvent(new Event("resize"));
  assert.equal(closed, 0);
  target.getClientRects = () => [];
  h.window.dispatchEvent(new Event("resize"));
  assert.deepEqual([closed, cleaned, restarted], [1, 1, 1]);
  assert.equal(h.observers[0].connected, false);
  h.window.dispatchEvent(new Event("resize"));
  assert.equal(closed, 1);
});

test("큰 글씨 클래스 변경과 화면 밖·inert 서랍 메뉴를 감지한다", async () => {
  for (const overrides of [
    { visibility: "hidden" },
    { closest: () => ({ inert: true }) },
    { getBoundingClientRect: () => ({ left: 1440, right: 1700, top: 10, bottom: 50 }) },
  ]) {
    const h = harness();
    h.targets.set('[data-tour-target="hamburger"]', h.element("hamburger"));
    const create = await h.loadDriver();
    const d = create({});
    d.highlight(h.element("mobile-nav-schedule", overrides));
    h.observers[0].callback();
    assert.equal(d.destroyed, 1);
  }
});

test("정보 카드와 입력 단계에는 메뉴 변경 중단을 적용하지 않는다", async () => {
  const h = harness();
  const create = await h.loadDriver();
  const d = create({});
  d.highlight(h.element("program-cards", { getClientRects: () => [] }));
  h.window.dispatchEvent(new Event("resize"));
  h.observers[0].callback();
  assert.equal(d.destroyed, 0);
});

test("안내 종료 시 이전 햄버거 클릭 감지를 제거한다", async () => {
  const h = harness();
  const button = new EventTarget();
  h.targets.set('[data-tour-target="hamburger"]', button);
  const create = await h.loadDriver();
  const d = create({});
  h.waitForOpenedTourMenu(d, '[data-tour-target="mobile-nav-programs"]', () => assert.fail("종료한 안내 실행"));
  d.destroy();
  button.dispatchEvent(new Event("click"));
  assert.equal(h.timers.length, 0);
});

test("늦은 서랍 안내 콜백은 새 안내를 덮지 않는다", async () => {
  const h = harness();
  const button = new EventTarget();
  h.targets.set('[data-tour-target="hamburger"]', button);
  const create = await h.loadDriver();
  const d = create({});
  h.waitForOpenedTourMenu(d, '[data-tour-target="mobile-nav-programs"]', () => assert.fail("이전 콜백 실행"));
  button.dispatchEvent(new Event("click"));
  create({});
  h.timers[0]();
  assert.equal(h.instances.length, 2);
});

test("서랍 닫힘 반영 전에도 PC 메뉴로 바뀌면 재시작한다", async () => {
  const h = harness();
  const trigger = h.element("hamburger");
  h.targets.set('[data-tour-target="hamburger"]', trigger);
  const create = await h.loadDriver();
  const d = create({});
  d.highlight(h.element("mobile-nav-programs"));
  h.observers[0].callback();
  assert.equal(d.destroyed, 0);
  trigger.getClientRects = () => [];
  h.observers[0].callback();
  assert.equal(d.destroyed, 1);
});

test("400ms 대기 뒤에도 실제 서랍 메뉴가 보일 때만 이어간다", async () => {
  for (const visible of [true, false]) {
    const h = harness();
    const button = Object.assign(new EventTarget(), h.element("hamburger"));
    h.targets.set('[data-tour-target="hamburger"]', button);
    const target = h.element("mobile-nav-programs", visible ? {} : { closest: () => ({ inert: true }) });
    h.targets.set('[data-tour-target="mobile-nav-programs"]', target);
    const create = await h.loadDriver();
    const d = create({});
    let shown = 0;
    let restarted = 0;
    h.window.addEventListener("stiz:tour-menu-layout-change", () => { restarted += 1; });
    h.waitForOpenedTourMenu(d, '[data-tour-target="mobile-nav-programs"]', () => { shown += 1; });
    button.dispatchEvent(new Event("click"));
    h.timers[0]();
    assert.equal(shown, visible ? 1 : 0);
    assert.equal(restarted, visible ? 0 : 1);
  }
});

test("헤더 모드 속성만 바뀌어도 실제 숨은 메뉴 안내를 양방향 재시작한다", async () => {
  for (const fromDrawer of [false, true]) {
    const h = harness();
    const header = {};
    const trigger = h.element("hamburger");
    h.targets.set("header.public-site-header[data-menu-layout]", header);
    h.targets.set('[data-tour-target="hamburger"]', trigger);
    const create = await h.loadDriver();
    let restarted = 0;
    h.window.addEventListener("stiz:tour-menu-layout-change", () => { restarted += 1; });
    const d = create({});
    const target = h.element(fromDrawer ? "mobile-nav-programs" : "nav-programs");
    d.highlight(target);
    h.observers[0].mutate(header, "data-menu-layout");
    assert.equal(d.destroyed, 0);
    if (fromDrawer) trigger.getClientRects = () => [];
    else target.getClientRects = () => [];
    h.observers[0].mutate(header, "data-menu-layout");
    assert.deepEqual([d.destroyed, restarted], [1, 1]);
  }
});

test("안내 종료 후에는 헤더 모드 변경 감시도 함께 해제한다", async () => {
  const h = harness();
  const header = {};
  h.targets.set("header.public-site-header[data-menu-layout]", header);
  const create = await h.loadDriver();
  const d = create({});
  const target = h.element("nav-programs");
  d.highlight(target);
  assert.equal(h.observers[0].targets.has(header), true);
  d.destroy();
  target.getClientRects = () => [];
  h.observers[0].mutate(header, "data-menu-layout");
  assert.equal(d.destroyed, 1);
  assert.equal(h.observers[0].targets.size, 0);
});

test("헤더 모드 변경만으로 정보 카드 안내를 중단하거나 다음 단계로 넘기지 않는다", async () => {
  const h = harness();
  const header = {};
  h.targets.set("header.public-site-header[data-menu-layout]", header);
  const create = await h.loadDriver();
  let progressed = 0;
  const d = create({ onDestroyed: () => { progressed += 1; } });
  d.highlight(h.element("program-cards", { getClientRects: () => [] }));
  h.observers[0].mutate(header, "data-menu-layout");
  assert.deepEqual([d.destroyed, progressed], [0, 0]);
});
