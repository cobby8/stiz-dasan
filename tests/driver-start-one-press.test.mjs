// «운행 시작 한 번»(2026-11-20 원장 지시) — 앱의 셔틀 명단에서 «운행 시작»을 누르면 운행 화면에 도착하자마자 위치 공유 동의 창까지 간다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/staff-session-rules.ts");
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const openPage = read("src/app/staff/run/open/page.tsx");
const tokenPage = read("src/app/driver/[token]/page.tsx");
const runPage = read("src/components/shuttle/UnifiedDriverRunPage.tsx");
const client = read("src/components/shuttle/UnifiedDriverClient.tsx");
const hook = read("src/hooks/useGpsShare.ts");
const policy = read("apps/driver-android/app/src/main/java/kr/stiz/driver/AppNavigationPolicy.java");

const ready = { autoStart: true, alreadyTried: false, gpsMode: "native", nativeReady: true, nativeRunning: false, gpsState: "off", transmission: "idle" };

test("앱 길의 운행 화면 주소에는 «눌러 왔다» 표시가 붙는다", () => {
  assert.equal(rules.driverAppRunHref("abc123"), "/driver/abc123?start=1");
  assert.match(openPage, /redirect\(driverAppRunHref\(token\)\);/);
  // 권한 확인이 주소를 만드는 것보다 먼저
  assert.ok(openPage.indexOf('if (shuttleScope(staff.roles) === "NONE") redirect("/staff");') < openPage.indexOf("driverAppRunHref(token)"));
});

test("앱은 표시가 붙은 주소도 운행 화면으로 본다(경로만 본다)", () => {
  assert.match(policy, /getRawPath\(\)\.matches\("\/driver\/\[A-Za-z0-9_-\]\+\/\?"\)/);
});

test("도착하자마자 시작 요청 — 앱 위치 공유이고, 앱이 상태를 알려 줬고, 운행 중이 아닐 때만", () => {
  assert.equal(rules.shouldAutoStartRun(ready), true);
  assert.equal(rules.shouldAutoStartRun({ ...ready, autoStart: false }), false);
  assert.equal(rules.shouldAutoStartRun({ ...ready, alreadyTried: true }), false);
  assert.equal(rules.shouldAutoStartRun({ ...ready, gpsMode: "web" }), false, "브라우저에서는 자동으로 시작하지 않는다");
  assert.equal(rules.shouldAutoStartRun({ ...ready, nativeReady: false }), false, "앱 상태를 받기 전에는 기다린다");
  assert.equal(rules.shouldAutoStartRun({ ...ready, nativeRunning: true }), false, "이미 운행 중이면 동의 창을 또 띄우지 않는다");
});

test("어제 정상 종료한 휴대폰(상태 «종료됨»)도 오늘은 자동으로 시작을 요청한다", () => {
  assert.equal(rules.shouldAutoStartRun({ ...ready, transmission: "stopped" }), true);
  assert.equal(rules.shouldAutoStartRun({ ...ready, gpsState: "error", transmission: "error" }), true, "지난 오류 표시가 남아 있어도 다시 시도한다");
});

test("서버 연결 중·종료 처리 중·종료 확인 대기에는 요청하지 않는다", () => {
  assert.equal(rules.shouldAutoStartRun({ ...ready, gpsState: "requesting" }), false);
  assert.equal(rules.shouldAutoStartRun({ ...ready, transmission: "stopping" }), false);
  assert.equal(rules.shouldAutoStartRun({ ...ready, transmission: "stop-unknown" }), false);
});

test("화면 — 직접 «운행 시작»을 누르면 도착 자동 요청은 끝난 것으로 본다(동의 창이 두 번 뜨지 않게)", () => {
  assert.ok(client.includes('function handleRunStart() { autoStartTried.current = true; stripStartMark(); if (gpsMode === "web") setRunState("running"); gpsStart(); }'));
});

test("표시는 정해진 값(1)이고 오늘 운행표일 때만 통한다", () => {
  assert.ok(tokenPage.includes('const autoStart = !searchDate && sp?.start === "1";'));
  assert.ok(runPage.includes("autoStart={autoStart && viewDate === today}"));
});

test("화면 — 한 번만 요청하고, 요청 전에 주소의 표시를 지운다", () => {
  const whole = client.slice(client.indexOf("const autoStartTried = useRef(false);"), client.indexOf("async function handleRunEnd()"));
  assert.ok(whole.includes("url.searchParams.delete(DRIVER_START_PARAM);"));
  const block = whole.slice(whole.indexOf("useEffect(() => {"));
  assert.ok(block.includes("if (!autoStart || autoStartTried.current) return;"));
  // 판단은 앱이 알려 준 상태(gpsState·transmission)로 — 화면이 따로 계산한 runState 로 하지 않는다
  assert.ok(block.includes("if (!shouldAutoStartRun({ autoStart, alreadyTried: autoStartTried.current, gpsMode, nativeReady, nativeRunning, gpsState, transmission })) return;"));
  assert.ok(block.includes("}, [autoStart, gpsMode, nativeReady, nativeRunning, gpsState, transmission, gpsStart, stripStartMark]);"));
  const triedAt = block.lastIndexOf("autoStartTried.current = true;");
  const stripAt = block.lastIndexOf("stripStartMark();");
  const startAt = block.lastIndexOf("gpsStart();");
  assert.ok(triedAt > 0 && stripAt > triedAt && startAt > stripAt);
  // 이미 운행 중이면 요청하지 않고 주소의 표시만 지운다
  assert.ok(block.includes('if (gpsMode === "native" && nativeReady && nativeRunning) { autoStartTried.current = true; stripStartMark(); return; }'));
});

test("앱이 상태를 알려 줬는지(nativeReady)는 같은 운행 열쇠의 상태일 때만 참", () => {
  assert.ok(hook.includes("nativeReady: nativeStatus?.token === token,"));
});

// ── 앱(안드로이드 1.0.7) — 권한 거절·위치 꺼짐일 때 휴대폰 설정 화면으로 바로 ──
const activity = read("apps/driver-android/app/src/main/java/kr/stiz/driver/MainActivity.java");

test("앱 — 위치·알림 권한을 거절하면 «설정 열기» 안내가 앱 설정 화면으로 보낸다", () => {
  const result = activity.slice(activity.indexOf("public void onRequestPermissionsResult"), activity.indexOf("private void snapshot()"));
  assert.equal(result.split("showSettingsHelp(").length - 1, 2);
  assert.equal(result.split("appSettingsIntent()").length - 1, 2);
  assert.ok(activity.includes('new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null))'));
  assert.ok(activity.includes('.setPositiveButton("설정 열기"'));
});

test("앱 — 휴대폰 위치가 꺼져 있으면 운행을 시작하지 않고 위치 설정 화면으로 보낸다", () => {
  const start = activity.slice(activity.indexOf("else if (step == PendingRunStart.Step.START) {"), activity.indexOf('pendingStart.cancel(); error("권한 요청을 시작하지 못했습니다.'));
  assert.ok(start.indexOf("if (!deviceLocationOn()) {") > 0 && start.indexOf("} else launchRun(token);") > start.indexOf("if (!deviceLocationOn()) {"));
  assert.ok(start.includes("new Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)"));
  // 확인하지 못하면 시작을 막지 않는다
  assert.ok(activity.includes("} catch (RuntimeException failure) { return true; }"));
});

test("앱 — 설정 화면은 기사님이 버튼을 눌렀을 때만 열고, 운행을 대신 시작하지 않는다", () => {
  const help = activity.slice(activity.indexOf("private void showSettingsHelp("), activity.indexOf("private void launchRun(String token)"));
  assert.ok(help.includes("startActivity(settings);"));
  assert.ok(!help.includes("launchRun(") && !help.includes("requestPermissionsAndStart("));
  assert.ok(help.includes("if (isFinishing() || isDestroyed() || settingsHelpOpen) return;"));
});
