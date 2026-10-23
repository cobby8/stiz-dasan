import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeDriverGps, nativeGpsTransport } from '../src/lib/shuttle/nativeDriverGps.ts';

function harness() {
  const target = new EventTarget();
  const calls = [];
  let snapshot;
  const controller = createNativeDriverGps({ target, transport: { postMessage(message) { calls.push(JSON.parse(message)); } },
    credentials: () => ({ token: 'synthetic-driver', label: '검증' }), publish(value) { snapshot = value; } });
  return { controller, calls, get snapshot() { return snapshot; }, emit(values) {
    target.dispatchEvent(new CustomEvent('stiz-driver-gps', { detail: { token: 'synthetic-driver', state: 'active', transmission: 'sent',
      lastSentAt: '2026-10-19T01:00:00Z', lastLocationAt: '2026-10-19T00:59:59Z', accuracy: 8, running: true, ...values } }));
  } };
}

test('네이티브 transport 없으면 웹 모드, 잘못된 형태는 사용하지 않는다', () => {
  assert.equal(nativeGpsTransport({}), null);
  assert.equal(nativeGpsTransport({ StizDriverGpsTransport: { postMessage: 'bad' } }), null);
  assert.ok(nativeGpsTransport({ StizDriverGpsTransport: { postMessage() {} } }));
});
test('화면 진입은 snapshot만 요청하고 이미 진행 중인 기기 상태를 복원', () => {
  const h = harness();
  assert.deepEqual(h.calls.map(x => x.action), ['snapshot']);
  h.emit({});
  assert.equal(h.snapshot.running, true);
  assert.equal(h.snapshot.lastSentAt.toISOString(), '2026-10-19T01:00:00.000Z');
  h.controller.dispose();
});
test('화면을 벗어나도 운행 중단 명령을 전송하지 않는다', () => {
  const h = harness(); h.controller.start(); h.emit({}); h.controller.dispose();
  assert.deepEqual(h.calls.map(x => x.action), ['snapshot', 'start']);
  h.emit({ running: false, state: 'off' });
  assert.equal(h.snapshot.running, true);
});
test('다른 운행 토큰·잘못된 상태 이벤트를 수용하지 않는다', () => {
  const h = harness(); h.emit({ token: 'other' }); assert.equal(h.snapshot, undefined);
  h.emit({ state: 'nonsense' }); assert.equal(h.snapshot, undefined);
  h.emit({ running: 'true' }); assert.equal(h.snapshot, undefined);
  h.emit({ accuracy: -1 }); assert.equal(h.snapshot.accuracy, null);
  h.controller.dispose();
});
test('중단은 기기 수집 중단과 서버 접수 확인 이벤트까지 대기', async () => {
  const h = harness(); h.emit({});
  const stop = h.controller.stop();
  assert.equal(h.calls.at(-1).action, 'stop');
  h.emit({ running: false, state: 'off', transmission: 'stopping' });
  h.emit({ running: false, state: 'off', transmission: 'stopped' });
  assert.equal(await stop, true); h.controller.dispose();
});
test('서버 종료 미확인은 false로 반환하고 상태를 숨기지 않는다', async () => {
  const h = harness(); const stop = h.controller.stop();
  h.emit({ running: false, state: 'off', transmission: 'stop-unknown' });
  assert.equal(await stop, false);
  assert.equal(h.snapshot.transmission, 'stop-unknown'); h.controller.dispose();
});
test('종료 대기 중 반복 종료·시작 명령을 차단하고 화면 해제는 대기를 취소', async () => {
  const h = harness(); const stop = h.controller.stop(); h.controller.start();
  assert.equal(await h.controller.stop(), false);
  assert.equal(h.calls.filter(x => x.action === 'stop').length, 1);
  assert.equal(h.calls.filter(x => x.action === 'start').length, 0);
  h.controller.dispose(); assert.equal(await stop, false);
});
