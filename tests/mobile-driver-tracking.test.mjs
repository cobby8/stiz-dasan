import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as crypto from 'node:crypto';
import ts from 'typescript';

function load(file, deps, env = {}, globals = {}) {
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, Buffer, Date, process: { env }, require(id) { if (!Object.hasOwn(deps, id)) throw new Error(`금지된 의존성: ${id}`); return deps[id]; }, ...globals });
  return exports;
}
const helper = load('src/lib/shuttle/mobileTracking.ts', { 'node:crypto': crypto });
test('기본 비활성은 DB 미접속 503과 no-store', async () => {
  const api = load('src/app/api/driver/mobile/session/route.ts', {
    'next/server': { NextResponse: { json: (body, options) => new Response(JSON.stringify(body), options) } },
    '@/lib/prisma': { prisma: new Proxy({}, { get() { throw new Error('DB 접근 금지'); } }) },
    '@/lib/shuttle/mobileTracking': helper,
  });
  const result = await api.POST(new Request('https://fixture.invalid', { method: 'POST' }));
  assert.equal(result.status, 503); assert.equal(result.headers.get('cache-control'), 'no-store');
});
test('비밀은 hash로 대조하고 틀린 원문은 거부', () => {
  const secret = 'a'.repeat(64), hash = helper.hashSecret(secret);
  assert.notEqual(hash, secret); assert.equal(helper.secretMatches(secret, hash), true);
  assert.equal(helper.secretMatches('b'.repeat(64), hash), false); assert.equal(helper.secretMatches('x', hash), false);
});
test('신선한 ISO 위치만 허용하고 오래됨/미래/잘못된 값 거부', () => {
  const now = Date.now(), body = { sequence: 1, capturedAt: new Date(now).toISOString(), lat: 37, lng: 127, accuracy: 8 };
  assert.equal(helper.locationInput(body, now).sequence, 1);
  for (const extra of [{ sequence: 0 }, { sequence: 1.5 }, { sequence: 2147483648 }, { lat: Infinity }, { lng: 181 }, { accuracy: -1 }, { speed: -1 }, { heading: 360 }, { capturedAt: '10/19/2026' }, { capturedAt: new Date(now - 30001).toISOString() }, { capturedAt: new Date(now + 5001).toISOString() }]) assert.throws(() => helper.locationInput({ ...body, ...extra }, now));
});
test('준비 안 된 스키마는 명시적 오류', async () => {
  await assert.rejects(helper.assertMobileSchema({ $queryRawUnsafe: async () => [{ ready: false }] }), error => error.status === 503 && error.code === 'MOBILE_TRACKING_SCHEMA_REQUIRED');
});
test('legacy 잠금은 transaction advisory lock 후 native 소유권 확인', async () => {
  const calls = [];
  const db = { $executeRawUnsafe: async sql => { calls.push(sql); }, $queryRawUnsafe: async sql => { calls.push(sql); return sql.includes('to_regclass') ? [{ ready: true }] : [{ id: 'fixture' }]; } };
  await assert.rejects(helper.assertLegacyTrackingAllowed(db, 'fixture'), error => error.status === 409);
  assert.match(calls[1], /pg_advisory_xact_lock/); assert.match(calls[2], /"expiresAt">now\(\)/);
});
test('SQL은 활성 한 세션 제약과 RLS를 포함하고 공개 역할 권한을 제거', () => {
  const sql = readFileSync('scripts/sql/driver-mobile-tracking-session.sql', 'utf8');
  assert.match(sql, /UNIQUE INDEX[\s\S]*WHERE state='ACTIVE'/); assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL[\s\S]*FROM PUBLIC/); assert.match(sql, /ON DELETE CASCADE/);
});
test('관리자 실제 렌더 함수는 조회 실패 중에도 시각이 경과하고 오류를 표시', async () => {
  let now = 100000, index = 0, fail = false;
  const slots = [], effects = [], timers = [];
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const react = {
    useState(initial) { const n = index++; if (!(n in slots)) slots[n] = initial; return [slots[n], value => { slots[n] = typeof value === 'function' ? value(slots[n]) : value; }]; },
    useRef(initial) { const n = index++; if (!(n in slots)) slots[n] = { current: initial }; return slots[n]; },
    useCallback(fn) { return fn; }, useEffect(fn) { effects.push(fn); },
  };
  const jsx = (type, props) => ({ type, props });
  const panel = load('src/components/admin/DriverLocationPanel.tsx', { react, 'react/jsx-runtime': { jsx, jsxs: jsx } }, {}, {
    Date: Clock, setInterval(fn, ms) { timers.push({ fn, ms }); return timers.length; }, clearInterval() {},
    async fetch() { return { ok: !fail, async json() { return { locations: [{ token: 'fixture', label: '검증 차량', sharing: true, secondsAgo: 10, latitude: 37, longitude: 127, accuracy: 8 }] }; } }; },
  }).default;
  const render = () => { index = 0; return panel({ onClose() {} }); };
  const text = tree => tree == null || tree === false ? '' : Array.isArray(tree) ? tree.map(text).join(' ') : typeof tree === 'object' ? text(tree.props?.children) : String(tree);
  render(); effects[0](); await new Promise(resolve => setImmediate(resolve));
  assert.match(text(render()), /마지막 서버 접수 10초 전/);
  fail = true; now += 130000;
  timers.find(timer => timer.ms === 30000).fn(); await new Promise(resolve => setImmediate(resolve));
  timers.find(timer => timer.ms === 1000).fn();
  const output = text(render()); assert.match(output, /위치 조회에 실패했습니다/); assert.match(output, /마지막 서버 접수 2분 전/); assert.match(output, /위치 확인 필요/); assert.match(output, /최근 2분 내 접수\s+0\s*대/);
});
