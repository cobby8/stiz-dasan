import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireWorkspace, controlAllowed, HOST, HTTPS_PORT, maskedSummary, ownedPath, PG_PORT, RUN_PATH, WORKSPACE } from '../scripts/driver-device-test-server.mjs';

test('서버는 loopback HTTPS와 별도 임시 PG만 사용한다', () => {
  assert.equal(HOST, '127.0.0.1'); assert.equal(HTTPS_PORT, 8443); assert.equal(PG_PORT, 55435); assert.equal(RUN_PATH, '/driver/device-test-only');
});
test('삭제 대상은 지정 소유 하위 경로에 한정한다', () => {
  assert.equal(ownedPath(path.join(WORKSPACE, 'pg-fixture')), path.join(WORKSPACE, 'pg-fixture'));
  for (const candidate of [WORKSPACE, path.dirname(WORKSPACE), path.join(WORKSPACE, '..', 'unrelated')]) assert.throws(() => ownedPath(candidate));
});
test('PC 제어는 loopback과 정확한 관리키를 모두 요구한다', () => {
  const key = 'a'.repeat(64);
  assert.equal(controlAllowed('127.0.0.1', key, key), true);
  for (const [host, value] of [['192.168.0.1', key], ['127.0.0.1', 'b'.repeat(64)], ['127.0.0.1', undefined], ['127.0.0.1', '가'.repeat(64)]]) assert.equal(controlAllowed(host, value, key), false);
});
test('마스킹 상태는 좌표·토큰·비밀·기기 ID를 내보내지 않는다', () => {
  const now = Date.now(), result = maskedSummary([{ state: 'ACTIVE', expiresAt: new Date(now + 10000), lastSentAt: new Date(now - 1000), capturedAt: new Date(now - 2000), accuracy: 9, token: 'NEVER_TOKEN', secretHash: 'NEVER_SECRET', deviceId: 'NEVER_DEVICE', latitude: 37.123456, longitude: 127.123456 }], { sharing: true, latitude: 37.123456 }, { start: 1, location: 2, secret: 'NEVER_COUNTER' }, now);
  assert.equal(result.activeSessions, 1); assert.equal(result.transmissionDelayMs, 1000); assert.equal(result.secondsSinceReceipt, 1);
  assert.doesNotMatch(JSON.stringify(result), /NEVER|latitude|longitude|37\.123456|127\.123456|token|secret|deviceId/);
});
test('마스킹 상태는 만료·미시작을 활성으로 꾸미지 않는다', () => {
  const now = Date.now(); assert.equal(maskedSummary([], null, {}, now).state, 'NONE');
  const result = maskedSummary([{ state: 'ACTIVE', expiresAt: new Date(now - 1) }], null, {}, now);
  assert.equal(result.activeSessions, 0); assert.equal(result.state, 'EXPIRED');
});
test('작업공간 소유권은 중복 서버·prepare가 기존 비밀을 건드리기 전에 거부한다', async () => {
  let release;
  try { release = await acquireWorkspace(); } catch (error) { if (error.code === 'EEXIST') return; throw error; }
  try { await assert.rejects(acquireWorkspace(), error => error.code === 'EEXIST'); }
  finally { await release(); }
});
test('준비와 실제 실행을 분리하고 정상 TLS 검증·원본 UI/API를 유지한다', async () => {
  const source = await readFile('scripts/driver-device-test-server.mjs', 'utf8');
  assert.match(source, /UnifiedDriverClient/); assert.match(source, /src\/app\/api\/driver\/mobile\/session\/route\.ts/);
  assert.match(source, /new PrismaClient/); assert.match(source, /await requireFreePort\(HTTPS_PORT\); await requireFreePort\(PG_PORT\)/);
  assert.match(source, /await Promise\.allSettled\(\[\.\.\.inFlight\]\)/); assert.match(source, /await verifiedOwnedPath\(path\.dirname\(dataDir\)\)/);
  assert.match(source, /log_min_error_statement=panic/); assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED|adb\s+/);
});
