import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import http from 'node:http';
import { allowPreviewRequest, allowPreviewRedirect, createPreviewProxy, LOCAL_DRIVER_TOKEN } from '../scripts/lib/real-preview-proxy.mjs';
const require = createRequire(import.meta.url);
const { isAllowedDestination } = require('../scripts/lib/real-preview-guard.cjs');

test('로컬 기사 링크는 실제 화면의 토큰 형식을 지킨다', () => {
  assert.match(LOCAL_DRIVER_TOKEN, /^[a-f0-9]{16,64}$/);
});

test('미리보기는 지정된 로컬 포트만 허용한다', () => {
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.equal(isAllowedDestination(host, 55476, [55476, 4091]), true);
  for (const [host, port] of [['db.example.invalid', 55476], ['127.0.0.1', 5432], ['localhost.evil.invalid', 4091]]) assert.equal(isAllowedDestination(host, port, [55476, 4091]), false);
});
test('화면 조회는 허용하고 저장·운영 경로는 차단한다', () => {
  for (const pathname of ['/admin', '/admin/students', '/staff', '/mypage', '/driver/local', '/_next/static/app.js', '/api/admin/apply', '/api/admin/regular/dispatch/saved']) assert.equal(allowPreviewRequest({ method: 'GET', pathname }), true, pathname);
  for (const pathname of ['/api/cron/push-outbox', '/api/auth/login', '/auth/callback', '/api/admin/send-notice', '/api/unknown', '/sw.js', '/manifest.json']) assert.equal(allowPreviewRequest({ method: 'GET', pathname }), false, pathname);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(allowPreviewRequest({ method, pathname: '/api/admin/apply' }), false);
});
test('두 수강료 조회 액션만 허용한다', () => {
  const actions = { read: 'loadStaffSessionMonthlyFees', write: 'sendMessage' };
  assert.equal(allowPreviewRequest({ method: 'POST', pathname: '/staff/sessions/local', actionId: 'read', actions }), true);
  for (const actionId of ['write', 'unknown', undefined]) assert.equal(allowPreviewRequest({ method: 'POST', pathname: '/staff/sessions/local', actionId, actions }), false);
  assert.equal(allowPreviewRequest({ method: 'POST', pathname: '/admin', actionId: 'read', actions }), false);
});
test('외부·다른 포트·프로토콜 생략 리다이렉트를 차단한다', () => {
  const origin = 'http://127.0.0.1:4090';
  for (const location of ['/admin', '/staff?view=today', origin + '/mypage']) assert.equal(allowPreviewRedirect(location, origin), true);
  for (const location of ['//example.invalid', '/\\example.invalid/path', 'https://example.invalid', 'http://127.0.0.1:4000', 'javascript:alert(1)', 'tel:01000000000']) assert.equal(allowPreviewRedirect(location, origin), false);
});
test('프록시가 저장 차단과 한국어·외부 링크 보호를 실제 응답에 적용한다', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => { upstreamRequests++; res.setHeader('content-type', 'text/html; charset=utf-8'); const data = Buffer.from('<html><head><title>학원</title></head><body>원생 확인</body></html>'); for (let i = 0; i < data.length; i += 7) res.write(data.subarray(i, i + 7)); res.end(); });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await listen(upstream);
  const proxy = createPreviewProxy({ upstreamPort: upstream.address().port, accounts: { admin: {} } });
  await listen(proxy);
  const base = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const blocked = await fetch(base + '/api/admin/apply', { method: 'POST', body: '{}' }); assert.equal(blocked.status, 403); assert.equal(upstreamRequests, 0);
    const response = await fetch(base + '/admin'); assert.equal(response.status, 200); const text = await response.text(); assert.ok(text.includes('학원')); assert.ok(text.includes('원생 확인')); assert.ok(!text.includes('\ufffd')); assert.ok(text.includes('stopImmediatePropagation'));
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.ok(response.headers.get('content-security-policy').includes("worker-src 'none'"));
  } finally { proxy.closeAllConnections(); upstream.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => upstream.close(resolve)); }
});
