import test from "node:test";
import assert from "node:assert/strict";
import { readBoardingResult, saveAndVerifyBoarding } from "../src/lib/shuttle/driverStatusClient.ts";
import { createDriverGpsController } from "../src/lib/shuttle/driverGpsController.ts";

const response = (body, ok = true) => ({ ok, json: async () => body });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function gpsHarness(request = async () => response({ ok: true })) {
  let success, error, interval, state, now = 100_000, watches = 0, clears = 0;
  const calls = [];
  const gps = createDriverGpsController({
    geolocation: { watchPosition(s, e) { watches++; success = s; error = e; return watches; }, clearWatch() { clears++; } },
    publish: (value) => { state = value; }, credentials: () => ({ token: "test-only" }),
    request: async (...args) => { calls.push(JSON.parse(args[1].body)); return request(...args); },
    now: () => now, every(callback) { interval = callback; return 1; }, clear() { interval = null; },
  });
  return { gps, calls, position() { success({ coords: { latitude: 0, longitude: 0, accuracy: 8, speed: null, heading: null } }); }, error(code) { error({ code }); }, tick() { interval?.(); }, advance(ms) { now += ms; }, get state() { return state; }, get watches() { return watches; }, get clears() { return clears; } };
}

test("응답 유실 뒤 서버 목표값 확인: POST는 정확히 1번", async () => {
  let writes = 0;
  const result = await saveAndVerifyBoarding("/fake", { status: "BOARDED" }, async () => ({ status: "BOARDED", checkedAt: null }), async () => { writes++; throw new Error("lost"); });
  assert.equal(result.matched, true); assert.equal(writes, 1);
});
test("성공 응답이어도 최종값 불일치는 반영 실패", async () => {
  const result = await saveAndVerifyBoarding("/fake", { status: "SELF" }, async () => ({ status: "NOSHOW", checkedAt: null }), async () => response({ ok: true }));
  assert.equal(result.matched, false); assert.equal(result.status, "NOSHOW");
});
test("조회도 실패하면 확인 필요로 전파", async () => {
  await assert.rejects(saveAndVerifyBoarding("/fake", { status: null }, async () => { throw new Error("read failed"); }, async () => response({ ok: true })));
});
test("잘못된 조회 body는 전체 미체크로 해석하지 않음", async () => {
  for (const body of [{}, { ok: true }, { ok: true, boarding: [] }, { ok: true, boarding: { row: "INVALID" } }]) {
    await assert.rejects(readBoardingResult("/fake", "test-only", "2026-10-19", "row", undefined, async () => response(body)));
  }
});
test("정규·특강 조회 응답과 기존 checkedAt 해석", async () => {
  for (const direction of [undefined, "DROPOFF"]) {
    const boarding = { row: "SELF" }, checkedAt = { row: "2026-10-19T01:00:00Z" };
    const result = await readBoardingResult("/fake", "test-only", "2026-10-19", "row", direction, async () => response({ ok: true, boarding: direction ? { [direction]: boarding } : boarding, checkedAt: direction ? { [direction]: checkedAt } : checkedAt }));
    assert.deepEqual(result, { status: "SELF", checkedAt: checkedAt.row });
  }
});
test("GPS 중복 시작 차단·첫 위치 즉시 전송·정상 body 후 시각 갱신", async () => {
  const h = gpsHarness(); h.gps.start(); h.gps.start();
  assert.equal(h.watches, 1); assert.equal(h.calls.length, 0);
  h.position(); assert.equal(h.calls.length, 1); assert.equal(h.state.lastSentAt, null);
  await flush(); assert.equal(h.state.transmission, "sent"); assert.equal(h.state.lastSentAt.getTime(), 100_000); h.gps.dispose();
});
test("HTTP 오류·잘못된 body·네트워크 오류에 전송 성공 시각 불변", async () => {
  for (const request of [async () => response({ ok: true }, false), async () => response({}), async () => { throw new Error("offline"); }]) {
    const h = gpsHarness(request); h.gps.start(); h.position(); await flush();
    assert.equal(h.state.transmission, "error"); assert.equal(h.state.lastSentAt, null); h.gps.dispose();
  }
});
test("GPS 중단은 전송 중 요청 뒤 직렬 처리·늦은 성공이 active로 돌아가지 않음", async () => {
  let resolve; let count = 0;
  const h = gpsHarness(async () => ++count === 1 ? new Promise((done) => { resolve = done; }) : response({ ok: true }));
  h.gps.start(); h.position(); const stopping = h.gps.stop(); h.gps.start();
  assert.equal(h.calls.length, 1); assert.equal(h.state.state, "off"); assert.equal(h.watches, 1);
  resolve(response({ ok: true })); await stopping; await flush();
  assert.equal(h.calls.length, 2); assert.equal(h.calls[1].sharing, false); assert.equal(h.state.lastSentAt, null); assert.equal(h.state.transmission, "stopped"); h.gps.dispose();
});
test("중단 접수 실패는 기기 중단과 별개로 확인 필요 표시", async () => {
  let count = 0; const h = gpsHarness(async () => response({ ok: ++count === 1 }));
  h.gps.start(); h.position(); await flush(); await h.gps.stop();
  assert.equal(h.state.state, "off"); assert.equal(h.state.transmission, "stop-unknown"); assert.equal(h.clears, 1); h.gps.dispose();
});

test("위치를 받기 전 종료해 서버 요청이 없으면 서버 중단 완료를 표시하지 않는다", async () => {
  const h = gpsHarness(); h.gps.start();
  const confirmed = await h.gps.stop();
  assert.equal(confirmed, false); assert.equal(h.calls.length, 0);
  assert.equal(h.state.transmission, "stop-unknown"); h.gps.dispose();
});
test("오래된 좌표는 새 위치처럼 전송하지 않음", async () => {
  const h = gpsHarness(); h.gps.start(); h.position(); await flush(); h.advance(31_000); h.tick();
  assert.equal(h.calls.length, 1); assert.equal(h.state.state, "error"); h.gps.dispose();
});
test("GPS 거부와 dispose 이후 늦은 응답 격리", async () => {
  let resolve; const h = gpsHarness(async () => new Promise((done) => { resolve = done; }));
  h.gps.start(); h.error(1); assert.equal(h.state.state, "denied");
  h.gps.start(); assert.equal(h.watches, 2);
  h.position(); h.gps.dispose(); const previous = h.state; resolve(response({ ok: true })); await flush();
  assert.equal(h.state, previous); assert.equal(h.clears, 2);
});
test("watchPosition 동기 예외는 오류 상태이며 다시 시도 가능", () => {
  let snapshot, attempts = 0;
  const gps = createDriverGpsController({ geolocation: { watchPosition() { attempts++; throw new Error("blocked"); }, clearWatch() {} }, credentials: () => ({ token: "test-only" }), publish(value) { snapshot = value; } });
  gps.start(); assert.equal(snapshot.state, "error"); gps.start(); assert.equal(attempts, 2); gps.dispose();
});
