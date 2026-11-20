// 기사님 운행 화면 «명단 새로 읽기»(2026-11-20 원장 지시) — 화면을 열어 둔 사이 추가된 학생이 보이게.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/shuttle/driverRunRefresh.ts");
const client = readFileSync(new URL("../src/components/shuttle/UnifiedDriverClient.tsx", import.meta.url), "utf8");
const sw = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");

const base = { readOnly: false, editing: false, savingOrder: false, running: false, gpsMode: "web" };

test("운행 모드도 평소에는 자동으로 새로 읽는다", () => {
  assert.equal(rules.driverRunRefreshMode(base), "auto");
  assert.equal(rules.driverRunRefreshMode({ ...base, gpsMode: "native" }), "auto");
  assert.equal(rules.DRIVER_RUN_REFRESH_MS, 30_000);
});

test("순서 편집·순서 저장 중에는 새로 읽지 않는다", () => {
  assert.equal(rules.driverRunRefreshMode({ ...base, editing: true }), "none");
  assert.equal(rules.driverRunRefreshMode({ ...base, savingOrder: true }), "none");
  assert.equal(rules.driverRunRefreshMode({ ...base, editing: true, running: true, gpsMode: "native" }), "none");
});

test("웹 위치 공유로 운행 중이면 버튼으로만, 앱(네이티브) 운행 중이면 자동으로 읽는다", () => {
  assert.equal(rules.driverRunRefreshMode({ ...base, running: true, gpsMode: "web" }), "manual");
  assert.equal(rules.driverRunRefreshMode({ ...base, running: true, gpsMode: "native" }), "auto");
});

test("보기 전용(선생님 셔틀 탭)은 예전처럼 늘 자동으로 읽는다", () => {
  assert.equal(rules.driverRunRefreshMode({ ...base, readOnly: true }), "auto");
  assert.equal(rules.driverRunRefreshMode({ ...base, readOnly: true, running: true, editing: true }), "auto");
});

test("서버 기록을 합칠 때 이 화면에서 누른 줄은 그대로 둔다", () => {
  const local = { a: "BOARDED", b: "NOSHOW" };
  const server = { a: "NOSHOW", c: "BOARDED" };
  // a 는 이 화면에서 누른 줄(저장 중) — 서버의 옛 값(NOSHOW)이 덮어쓰지 않는다
  assert.deepEqual(rules.mergeServerBoarding(local, server, ["a"]), { a: "BOARDED", c: "BOARDED" });
});

test("누르지 않은 줄은 서버 값을 따른다 — 새 줄의 기록·다른 기기의 체크·지워진 기록", () => {
  const merged = rules.mergeServerBoarding({ old: "BOARDED", same: "SELF" }, { same: "SELF", fresh: "BOARDED" }, []);
  assert.deepEqual(merged, { same: "SELF", fresh: "BOARDED" });
});

test("누른 줄을 «대기로 되돌린» 것(기록 없음)도 서버 값으로 되살아나지 않는다", () => {
  // 화면에서 되돌려 local 에 키가 없고, 서버에는 아직 옛 기록이 있는 순간
  assert.deepEqual(rules.mergeServerBoarding({}, { a: "BOARDED" }, ["a"]), {});
});

test("바뀐 것이 없으면 받은 객체를 그대로 돌려준다(다시 그리지 않게)", () => {
  const local = { a: "BOARDED", b: "SELF" };
  assert.equal(rules.mergeServerBoarding(local, { b: "SELF", a: "BOARDED" }, []), local);
  assert.equal(rules.mergeServerBoarding(local, {}, ["a", "b"]), local);
  assert.notEqual(rules.mergeServerBoarding(local, { a: "BOARDED" }, []), local);
});

test("화면 — 자동 읽기는 30초 간격 + 화면 복귀(visibilitychange·focus)에 걸려 있다", () => {
  assert.match(client, /driverRunRefreshMode\(\{ readOnly, editing, savingOrder, running: runState === "running", gpsMode \}\)/);
  const effect = client.slice(client.indexOf('if (refreshMode !== "auto") return;'));
  assert.match(effect.slice(0, 700), /window\.setInterval\(tick, DRIVER_RUN_REFRESH_MS\)/);
  assert.match(effect.slice(0, 700), /document\.addEventListener\("visibilitychange", tick\)/);
  assert.match(effect.slice(0, 700), /window\.addEventListener\("focus", tick\)/);
  // 보기 전용만 새로 읽던 예전 조건은 남기지 않는다
  assert.doesNotMatch(client, /if \(!readOnly\) return;\s*const timer = window\.setInterval/);
});

test("화면 — 새로 읽기 전에 연결을 확인하고, 확인 뒤에도 방식을 다시 본다", () => {
  const fn = client.slice(client.indexOf("const refreshRoster = useCallback"), client.indexOf('if (refreshMode !== "auto") return;'));
  const probeAt = fn.indexOf("fetch(DRIVER_RUN_PROBE_URL");
  const refreshAt = fn.indexOf("router.refresh()");
  assert.ok(probeAt > 0 && refreshAt > probeAt, "연결 확인이 새로 읽기보다 먼저");
  assert.match(fn, /method: "HEAD", cache: "no-store"/);
  assert.match(fn, /if \(!online\) \{[^}]*return; \}/);
  assert.match(fn, /mode === "none" \|\| \(!manual && mode !== "auto"\)/);
  assert.match(fn, /document\.visibilityState !== "visible"/);
});

test("연결 확인(HEAD)은 서비스워커 캐시를 거치지 않는다 — 꺼진 연결을 켜진 것으로 보지 않게", () => {
  assert.match(sw, /if \(request\.method !== "GET"\) return;/);
});

test("화면 — 서버 기록은 합치기 규칙으로만 들어오고, 기록을 못 읽은 응답은 합치지 않는다", () => {
  assert.match(client, /if \(readOnly \|\| !initialBoardingReliable\) return;\s*setBoarding\(\(local\) => mergeServerBoarding\(local, initialBoarding, \[\.\.\.Object\.keys\(saveStatesRef\.current\), \.\.\.locks\.current, /);
});

test("연결 확인에 쓰는 파일이 실제로 있다 — 없어지면 자동 읽기가 조용히 멈춘다", () => {
  assert.ok(existsSync(new URL("../public" + rules.DRIVER_RUN_PROBE_URL, import.meta.url)));
});

test("화면 — 누른 줄 표시(ref)를 합치기보다 먼저 갱신한다", () => {
  const refAt = client.indexOf("saveStatesRef.current = saveStates;");
  const mergeAt = client.indexOf("mergeServerBoarding(local, initialBoarding");
  assert.ok(refAt > 0 && mergeAt > refAt);
});

test("화면 — 한 번 기록을 읽은 뒤에는 새로 읽기 한 번의 실패로 체크 버튼을 잠그지 않는다", () => {
  assert.ok(client.includes("const boardingReliable = readOnly ? initialBoardingReliable : initialBoardingReliable || everReliable;"));
  assert.ok(client.includes("if (initialBoardingReliable) setEverReliable(true);"));
  // 잠금·요약·경고는 모두 합친 판정(boardingReliable)을 본다
  const after = client.slice(client.indexOf("const boardingReliable ="));
  assert.equal(after.split(/\r?\n/).slice(1).filter((line) => line.includes("initialBoardingReliable")).length, 0);
});

test("화면 — 체험 줄(T:) 기록은 서버 응답에 없다고 지우지 않는다", () => {
  assert.ok(client.includes('Object.keys(local).filter((key) => key.startsWith("T:") && !(key in initialBoarding))'));
});

test("화면 — 웹 운행 중 «기록 다시 불러오기»·날짜 바뀜 새로 읽기도 페이지를 통째로 다시 열지 않는다", () => {
  assert.ok(client.includes('if (refreshMode === "manual") void refreshRoster(true); else window.location.reload();'));
  assert.ok(client.includes("if (todayKst() !== today) void refreshRoster(false);"));
  assert.equal(client.split("router.refresh()").length - 1, 2, "router.refresh 는 명단 새로 읽기·순서 저장 뒤 두 곳뿐");
});

test("화면 — 웹 운행 중에는 «명단 새로 읽기» 글자 버튼이 보인다(터치 44px)", () => {
  const block = client.slice(client.indexOf('{refreshMode === "manual" && ('));
  assert.match(block.slice(0, 700), /min-h-11[^>]*>명단 새로 읽기<\/button>/);
  assert.match(block.slice(0, 700), /refreshRoster\(true\)/);
});
