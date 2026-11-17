// 스토어 앱 안에서는 서비스 워커를 쓰지 않는다(2026-11-17 원장 신고: 안드로이드 앱 선생님 마이페이지 버전이 «웹으로 보는 중»)
// 원인: 안드로이드 웹뷰에서 서비스 워커가 대신 보낸 요청에는 앱 이름표(« STIZApp/1.0.5 (android)»)가 빠져 서버가 앱인 줄 모른다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const { serviceWorkerAllowed } = await import("../src/lib/storeApp.ts");

const ANDROID_APP = "Mozilla/5.0 (Linux; Android 14; SM-S918N; wv) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 STIZApp/1.0.5 (android) STIZNativeLogin/1 STIZVoice/1";
const IOS_APP = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 STIZApp/1.0.5 (ios)";
const CHROME = "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36";

test("스토어 앱(안드로이드·아이폰)이면 서비스 워커를 쓰지 않는다", () => {
  assert.equal(serviceWorkerAllowed(ANDROID_APP), false);
  assert.equal(serviceWorkerAllowed(IOS_APP), false);
});

test("일반 브라우저·홈 화면 바로가기·빈 값이면 지금처럼 쓴다", () => {
  assert.equal(serviceWorkerAllowed(CHROME), true);
  assert.equal(serviceWorkerAllowed(""), true);
  assert.equal(serviceWorkerAllowed(null), true);
  assert.equal(serviceWorkerAllowed(undefined), true);
});

test("서비스 워커를 등록하는 두 곳 모두 앱이면 등록하지 않는다", () => {
  const updater = read("src/components/PwaUpdater.tsx");
  assert.match(updater, /if \(!serviceWorkerAllowed\(navigator\.userAgent\)\) \{[\s\S]*?getRegistrations\(\)[\s\S]*?unregister\(\)[\s\S]*?return;\s*\}/);
  // 워커 아래 있던 화면은 지운 뒤 «한 번만» 다시 불러온다(sessionStorage 표시로 반복 방지)
  assert.match(updater, /stiz-app-sw-removed[\s\S]*?wasControlled[\s\S]*?getItem\(RELOAD_KEY\) === "1"\) return;[\s\S]*?setItem\(RELOAD_KEY, "1"\)[\s\S]*?location\.reload\(\)/);
  // 앱 판정이 등록(register)보다 앞에 있어야 한다
  assert.ok(updater.indexOf("serviceWorkerAllowed(navigator.userAgent)") < updater.indexOf("navigator.serviceWorker.register("));

  const push = read("src/lib/push/usePushSubscription.ts");
  assert.match(push, /"PushManager" in window && serviceWorkerAllowed\(navigator\.userAgent\)\) \{/);
  // 등록 줄은 그 조건 안에만 있다
  assert.equal(push.split('navigator.serviceWorker.register("/sw.js")').length - 1, 1);
});

test("서비스 워커를 등록하는 곳은 이 두 곳뿐이다(새로 생기면 같은 판정을 넣을 것)", async () => {
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && readFileSync(full, "utf8").includes("serviceWorker.register(")) found.push(full.replace(/\\/g, "/"));
    }
  };
  walk(root);
  assert.deepEqual(
    found.map((f) => f.slice(f.indexOf("/src/") + 1)).sort(),
    ["src/components/PwaUpdater.tsx", "src/lib/push/usePushSubscription.ts"],
  );
});
