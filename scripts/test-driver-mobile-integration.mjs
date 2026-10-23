import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import net from 'node:net';
import pg from 'pg';
import ts from 'typescript';
import { PrismaClient } from '@prisma/client';

// URL 인자/운영 환경값을 읽지 않고 매번 직접 만든 loopback DB만 사용한다.
test('모바일 위치 세션 실제 라우트와 PostgreSQL 트랜잭션', { timeout: 120000 }, async t => {
  const bin = 'C:/Program Files/PostgreSQL/16/bin', port = 55434;
  const password = randomBytes(32).toString('hex'), user = 'driver_mobile_fixture';
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(PG|DATABASE_URL|DIRECT_URL)/i.test(k)));
  const command = (name, args) => promisify(execFile)(path.join(bin, `${name}.exe`), args, { env, windowsHide: true, shell: false, timeout: 45000 });
  const featureEnv = {};
  async function load(file, deps) {
    const code = ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const exports = {};
    vm.runInNewContext(code, { exports, Buffer, process: { env: featureEnv }, Date, console,
      require(id) { if (!Object.hasOwn(deps, id)) throw new Error(`허용하지 않은 의존성: ${id}`); return deps[id]; } }, { filename: file });
    return exports;
  }
  let started = false, pool, directory, prisma;
  try {
    assert.equal(process.platform, 'win32');
    await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(resolve)); });
    await mkdir('.tmp/driver-mobile-qa', { recursive: true });
    directory = await mkdtemp(path.resolve('.tmp/driver-mobile-pg-'));
    const data = path.join(directory, 'data'), pwfile = path.join(directory, 'pw');
    await writeFile(pwfile, password, { mode: 0o600, flag: 'wx' });
    try { await command('initdb', ['-D', data, '-U', user, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${pwfile}`, '--encoding=UTF8', '--no-locale']); }
    finally { await unlink(pwfile); }
    await command('pg_ctl', ['start', '-D', data, '-l', path.join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w']);
    started = true;
    pool = new pg.Pool({ host: '127.0.0.1', port, user, password, database: 'postgres', ssl: false });
    const { rows: [identity] } = await pool.query("SELECT host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS directory");
    assert.equal(identity.host, '127.0.0.1'); assert.equal(identity.port, port);
    assert.equal((await realpath(identity.directory)).toLowerCase(), (await realpath(data)).toLowerCase());
    prisma = new PrismaClient({ datasources: { db: { url: `postgresql://${user}:${password}@127.0.0.1:${port}/postgres?schema=public` } }, log: [] });
    const database = prisma;
    const helper = await load('src/lib/shuttle/mobileTracking.ts', { 'node:crypto': { createHash, timingSafeEqual } });
    const next = { NextResponse: { json(body, options = {}) { return new Response(JSON.stringify(body), { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); } } };
    const dependencies = { 'next/server': next, '@/lib/prisma': { prisma: database }, '@/lib/shuttle/mobileTracking': helper };
    const api = await load('src/app/api/driver/mobile/session/route.ts', dependencies);
    const legacy = await load('src/app/api/driver/location/route.ts', dependencies);
    const token = 'fixture-run-only', sessionId = randomUUID(), deviceId = randomUUID(), secret = randomBytes(32).toString('hex');
    const request = (body, credential = secret) => new Request('http://localhost/api/driver/mobile/session', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` }, body: JSON.stringify({ sessionId, ...body }) });
    const start = { action: 'start', token, sessionId, deviceId, secret };
    const location = (sequence = 1, extra = {}) => ({ action: 'location', sequence, capturedAt: new Date().toISOString(), lat: 37.6, lng: 127.1, accuracy: 8, ...extra });
    await t.test('기본 비활성은 DB 없이 503, no-store', async () => {
      const response = await api.POST(request(start)); assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store');
    });
    featureEnv.DRIVER_MOBILE_TRACKING_ENABLED = 'true';
    await t.test('미적용 스키마는 명시적 503', async () => assert.equal((await (await api.POST(request(start))).json()).error, 'MOBILE_TRACKING_SCHEMA_REQUIRED'));
    await pool.query(`CREATE TABLE "ShuttleRunLink"(id text PRIMARY KEY,token text UNIQUE); CREATE TABLE "DriverLocation"(token text PRIMARY KEY,label text,latitude float8,longitude float8,accuracy float8,speed float8,heading float8,sharing boolean,"updatedAt" timestamptz);`);
    await pool.query(await readFile('scripts/sql/driver-mobile-tracking-session.sql', 'utf8'));
    await pool.query('INSERT INTO "ShuttleRunLink" VALUES ($1,$2)', ['fixture-link', token]);
    await t.test('빈 운행에 두 장치 동시 시작 시 정확히 하나만 허용', async () => {
      await pool.query('INSERT INTO "ShuttleRunLink" VALUES ($1,$2)', ['race-link', 'race-fixture']);
      const results = await Promise.all(Array.from({ length: 2 }, () => api.POST(request({ ...start, token: 'race-fixture', sessionId: randomUUID(), deviceId: randomUUID(), secret: randomBytes(32).toString('hex') }))));
      assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
      await pool.query('DELETE FROM "ShuttleRunLink" WHERE token=$1', ['race-fixture']);
    });
    await t.test('시작 재시도 동일 세션, 비밀 원문 미저장', async () => {
      assert.equal((await api.POST(request(start))).status, 200); assert.equal((await api.POST(request(start))).status, 200);
      const { rows } = await pool.query('SELECT * FROM "DriverMobileTrackingSession"'); assert.equal(rows.length, 1); assert.notEqual(rows[0].secretHash, secret);
      assert.equal(new Date(rows[0].expiresAt).getTime() - new Date(rows[0].createdAt).getTime() <= 43201000, true);
    });
    await t.test('다른 장치 동시 시작은 409', async () => {
      const results = await Promise.all(Array.from({ length: 2 }, () => api.POST(request({ ...start, sessionId: randomUUID(), deviceId: randomUUID(), secret: randomBytes(32).toString('hex') }))));
      assert.deepEqual(results.map(r => r.status), [409, 409]);
    });
    await t.test('잘못된 비밀은 status/stop/location 거부', async () => {
      for (const action of ['status', 'stop', 'location']) assert.equal((await api.POST(request({ action }, 'a'.repeat(64)))).status, 403);
    });
    await t.test('신선한 위치는 최신 한 행과 서버 접수 시각 기록', async () => {
      assert.equal((await api.POST(request(location()))).status, 200);
      const result = await (await api.POST(request({ action: 'status' }))).json(); assert.equal(result.state, 'ACTIVE'); assert.equal(result.lastSequence, 1); assert.ok(result.lastSentAt); assert.equal(result.accuracy, 8);
      assert.equal((await (await api.POST(request(start))).json()).lastSequence, 1);
    });
    await t.test('과거/미래 위치와 잘못된 정확도 거부', async () => {
      for (const extra of [{ capturedAt: new Date(Date.now() - 31000).toISOString() }, { capturedAt: new Date(Date.now() + 10000).toISOString() }, { capturedAt: '10/19/2026' }, { accuracy: -1 }, { lat: 100 }, { sequence: 1.5 }]) assert.ok([400, 409].includes((await api.POST(request(location(2, extra)))).status));
    });
    await t.test('역순 시퀀스와 역순 측정 시각 거부', async () => {
      assert.equal((await api.POST(request(location(1)))).status, 409);
      assert.equal((await api.POST(request(location(2, { capturedAt: new Date(Date.now() - 1000).toISOString() })))).status, 409);
    });
    const legacyRequest = () => new Request('http://localhost/api/driver/location', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, lat: 37.5, lng: 127.2 }) });
    await t.test('앱 소유 운행은 웹 위치가 덮어쓰지 못함', async () => assert.equal((await legacy.POST(legacyRequest())).status, 409));
    await t.test('정지 반복 성공, 정지 후 위치/웹 지연 요청 차단', async () => {
      for (let n = 0; n < 2; n++) assert.equal((await api.POST(request({ action: 'stop' }))).status, 200);
      assert.equal((await api.POST(request(location(2)))).status, 409); assert.equal((await legacy.POST(legacyRequest())).status, 409);
      assert.equal((await pool.query('SELECT sharing FROM "DriverLocation"')).rows[0].sharing, false);
    });
    await t.test('새 운행 시작 후 옛 stop 재시도가 새 위치를 끄지 않음', async () => {
      const nextId = randomUUID(); assert.equal((await api.POST(request({ ...start, sessionId: nextId }))).status, 200);
      assert.equal((await api.POST(request({ ...location(1), sessionId: nextId }))).status, 200);
      const accepted = await (await api.POST(request({ ...location(2), sessionId: nextId }))).json();
      assert.ok(accepted.lastSentAt); assert.equal(accepted.lastSentAt, (await pool.query('SELECT "lastSentAt" FROM "DriverMobileTrackingSession" WHERE id=$1', [nextId])).rows[0].lastSentAt.toISOString());
      await api.POST(request({ action: 'stop' })); assert.equal((await pool.query('SELECT sharing FROM "DriverLocation"')).rows[0].sharing, true);
      await api.POST(request({ action: 'stop', sessionId: nextId }));
    });
    await t.test('위치 갱신과 정지 동시 요청 뒤 공유는 반드시 꺼짐', async () => {
      const nextId = randomUUID(); await api.POST(request({ ...start, sessionId: nextId }));
      const results = await Promise.all([api.POST(request({ ...location(1), sessionId: nextId })), api.POST(request({ action: 'stop', sessionId: nextId }))]);
      assert.ok([200, 409].includes(results[0].status)); assert.equal(results[1].status, 200);
      assert.equal((await pool.query('SELECT sharing FROM "DriverLocation" WHERE token=$1', [token])).rows[0].sharing, false);
    });
    await t.test('만료 세션은 쓰기 차단, status EXPIRED', async () => {
      await pool.query(`UPDATE "DriverMobileTrackingSession" SET state='ACTIVE',"expiresAt"=now()-interval '1 second' WHERE id=$1`, [sessionId]);
      assert.equal((await api.POST(request(location(3)))).status, 409);
      assert.equal((await (await api.POST(request({ action: 'status' }))).json()).state, 'EXPIRED');
    });
    await t.test('만료 직후 stop은 마지막 위치 공유도 끔', async () => {
      await pool.query(`UPDATE "DriverMobileTrackingSession" SET state='ACTIVE',"expiresAt"=now()-interval '1 second' WHERE id=$1`, [sessionId]);
      await pool.query(`UPDATE "DriverLocation" SET sharing=true,"updatedAt"=now() WHERE token=$1`, [token]);
      const response = await api.POST(request({ action: 'stop' })); assert.equal(response.status, 200);
      assert.equal((await response.json()).state, 'EXPIRED');
      assert.equal((await pool.query('SELECT sharing FROM "DriverLocation" WHERE token=$1', [token])).rows[0].sharing, false);
    });
    await t.test('만료된 옛 stop은 새 활성 운행 위치를 끄지 않음', async () => {
      const nextId = randomUUID(); assert.equal((await api.POST(request({ ...start, sessionId: nextId }))).status, 200);
      assert.equal((await api.POST(request({ ...location(1), sessionId: nextId }))).status, 200);
      assert.equal((await api.POST(request({ action: 'stop' }))).status, 200);
      assert.equal((await pool.query('SELECT sharing FROM "DriverLocation" WHERE token=$1', [token])).rows[0].sharing, true);
      await api.POST(request({ action: 'stop', sessionId: nextId }));
    });
    await t.test('운행 링크 삭제 시 기존 자격도 사용 불가', async () => {
      await pool.query('DELETE FROM "ShuttleRunLink" WHERE token=$1', [token]); assert.equal((await api.POST(request({ action: 'status' }))).status, 403);
    });
    await t.test('비활성 플래그에서는 기존 웹 위치 저장 유지', async () => {
      delete featureEnv.DRIVER_MOBILE_TRACKING_ENABLED;
      await pool.query('INSERT INTO "ShuttleRunLink" VALUES ($1,$2)', ['fixture-link', token]); assert.equal((await legacy.POST(legacyRequest())).status, 200);
    });
  } finally {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (started) await command('pg_ctl', ['stop', '-D', path.join(directory, 'data'), '-m', 'fast', '-w']);
  }
});
