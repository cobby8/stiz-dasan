import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 대기 로직은 의존성이 없는 순수 함수라 실제로 실행해서 검증한다.
// (소스 문자열 매칭으로는 분기 실수를 절대 못 잡는다)
const moduleSource = await readFile("src/lib/pwa/installReadiness.ts", "utf8");
const transpiled = ts.transpileModule(moduleSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { INSTALL_PROMPT_WAIT_MS, resolveInstallScreenView, shouldWaitForInstallPrompt } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

/** 기본값 위에 필요한 것만 덮어써서 읽기 쉽게 만든다. */
const view = (overrides) =>
  resolveInstallScreenView({
    deviceState: "android",
    hasPrompt: false,
    isInAppBrowser: false,
    waitElapsed: false,
    ...overrides,
  });

/* ---------------- 대기 여부 ---------------- */

test("대기 창은 1.5초 안팎으로 짧게 둔다", () => {
  // 너무 짧으면 크롬 신호를 못 기다리고, 너무 길면 안내를 못 본 사람이 그냥 닫는다.
  assert.ok(INSTALL_PROMPT_WAIT_MS >= 1000 && INSTALL_PROMPT_WAIT_MS <= 2000);
});

test("iOS는 기다리지 않는다 — 애플은 설치 이벤트를 아예 보내지 않는다", () => {
  for (const deviceState of ["ios-safari", "ios-browser"]) {
    assert.equal(shouldWaitForInstallPrompt({ deviceState, isInAppBrowser: false }), false);
  }
});

test("안드로이드·PC는 잠깐 기다린다", () => {
  for (const deviceState of ["android", "other"]) {
    assert.equal(shouldWaitForInstallPrompt({ deviceState, isInAppBrowser: false }), true);
  }
});

test("인앱 브라우저와 설치 완료 상태는 기다리지 않는다", () => {
  // 카카오톡 등 인앱은 홈 화면 추가 자체가 막혀 프롬프트가 오지 않는다.
  assert.equal(shouldWaitForInstallPrompt({ deviceState: "android", isInAppBrowser: true }), false);
  assert.equal(shouldWaitForInstallPrompt({ deviceState: "installed", isInAppBrowser: false }), false);
});

/* ---------------- 첫 화면에 무엇이 보이는가 ---------------- */

test("iOS는 대기 없이 즉시 안내를 보여준다", () => {
  for (const deviceState of ["ios-safari", "ios-browser"]) {
    const result = view({ deviceState, waitElapsed: false });
    assert.equal(result.phase, "guide");
    assert.equal(result.showWaitingNotice, false);
    assert.equal(result.showManualGuide, true);
  }
});

test("iOS 인앱 브라우저는 대기 없이 즉시 탈출 안내를 보여준다", () => {
  const result = view({ deviceState: "ios-browser", isInAppBrowser: true, waitElapsed: false });
  assert.equal(result.showWaitingNotice, false);
  assert.equal(result.showInAppEscape, true);
  // 인앱에서는 일반 설치 안내로 헷갈리게 하지 않는다.
  assert.equal(result.showManualGuide, false);
});

test("안드로이드·PC는 대기 창 동안 수동 안내를 감춘다", () => {
  for (const deviceState of ["android", "other"]) {
    const result = view({ deviceState, waitElapsed: false });
    assert.equal(result.phase, "waiting");
    assert.equal(result.showWaitingNotice, true);
    assert.equal(result.showManualGuide, false, "대기 중에는 '설치 버튼이 나타나지 않습니다' 안내가 보이면 안 됩니다.");
    assert.equal(result.showInstallButton, false);
  }
});

test("기기 판별 전(checking)에도 수동 안내를 보여주지 않는다", () => {
  const result = view({ deviceState: "checking", waitElapsed: true });
  assert.equal(result.phase, "waiting");
  assert.equal(result.showManualGuide, false);
});

test("대기 중에 프롬프트가 오면 즉시 설치 버튼으로 전환된다", () => {
  const result = view({ deviceState: "android", hasPrompt: true, waitElapsed: false });
  assert.equal(result.phase, "guide");
  assert.equal(result.showInstallButton, true);
  // 대기 표시는 곧바로 사라져야 한다.
  assert.equal(result.showWaitingNotice, false);
});

test("대기가 끝나고 프롬프트가 없으면 그때 수동 안내를 보여준다", () => {
  for (const deviceState of ["android", "other"]) {
    const result = view({ deviceState, hasPrompt: false, waitElapsed: true });
    assert.equal(result.phase, "guide");
    assert.equal(result.showWaitingNotice, false);
    assert.equal(result.showManualGuide, true);
    assert.equal(result.showInstallButton, false);
  }
});

test("이미 설치된 상태면 대기하지 않고 바로 완료 표시로 간다", () => {
  const result = view({ deviceState: "installed", waitElapsed: false });
  assert.equal(result.phase, "installed");
  assert.equal(result.showWaitingNotice, false);
  assert.equal(result.showInstallButton, false);
  assert.equal(result.showManualGuide, false);
  assert.equal(result.showInAppEscape, false);
});

/* 화면 연결 검사는 지웠다 — 옛 «홈 화면 바로가기» 설치 화면 두 개(ParentAppInstallClient·StaffAppInstallClient)를 2026-11-18 원장 승인으로 지웠다 */
