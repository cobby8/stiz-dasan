import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const layoutSource = await readFile("src/app/layout.tsx", "utf8");

// 루트 레이아웃 <head>에 넣은 인라인 캡처 스크립트 원문을 꺼낸다.
const capturedScript = layoutSource.match(/__html:\s*`([\s\S]*?)`,/)?.[1];

test("루트 레이아웃 head에 설치 이벤트 캡처 스크립트가 있다", () => {
  assert.ok(capturedScript, "layout.tsx <head>에 인라인 캡처 스크립트가 있어야 합니다.");
  assert.match(capturedScript, /beforeinstallprompt/);
  assert.match(capturedScript, /window\.__stizInstallPrompt/);
  // 하이드레이션 전에 실행돼야 의미가 있으므로 </head> 앞에 위치해야 한다.
  assert.ok(
    layoutSource.indexOf("__stizInstallPrompt") < layoutSource.indexOf("</head>"),
    "캡처 스크립트는 <head> 안에 있어야 합니다.",
  );
});

test("캡처 스크립트는 이벤트를 전역에 보관하고 커스텀 이벤트로 알린다", () => {
  // 가짜 window(EventTarget)에 스크립트를 실제로 실행시켜 동작을 확인한다.
  const fakeWindow = new EventTarget();
  const fired = [];
  fakeWindow.addEventListener("stiz:installprompt", () => fired.push("stiz:installprompt"));
  fakeWindow.addEventListener("stiz:installed", () => fired.push("stiz:installed"));

  new Function("window", capturedScript)(fakeWindow);

  // 1) 설치 프롬프트가 오면 전역에 보관되고 stiz:installprompt 가 발신된다.
  const promptEvent = new Event("beforeinstallprompt", { cancelable: true });
  fakeWindow.dispatchEvent(promptEvent);
  assert.equal(fakeWindow.__stizInstallPrompt, promptEvent);
  assert.equal(promptEvent.defaultPrevented, true);
  assert.deepEqual(fired, ["stiz:installprompt"]);

  // 2) 설치가 끝나면 보관값을 비우고 stiz:installed 가 발신된다.
  fakeWindow.dispatchEvent(new Event("appinstalled"));
  assert.equal(fakeWindow.__stizInstallPrompt, null);
  assert.deepEqual(fired, ["stiz:installprompt", "stiz:installed"]);
});

test("캡처 스크립트가 두 번 실행돼도 리스너가 중복 등록되지 않는다", () => {
  const fakeWindow = new EventTarget();
  let count = 0;
  fakeWindow.addEventListener("stiz:installprompt", () => {
    count += 1;
  });

  new Function("window", capturedScript)(fakeWindow);
  new Function("window", capturedScript)(fakeWindow);
  fakeWindow.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true }));

  assert.equal(count, 1);
});

// 화면별 검사는 지웠다 — 옛 «홈 화면 바로가기» 설치 화면 두 개를 2026-11-18 원장 승인으로 지웠다(루트 레이아웃 캡처 스크립트는 그대로)
