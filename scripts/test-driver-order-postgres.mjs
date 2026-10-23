import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { PrismaClient } from '@prisma/client';
import pg from 'pg';
import ts from 'typescript';

// 외부 URL·환경파일을 받지 않고 이 실행기가 만든 임시 DB에만 접속한다.
const root = process.cwd(), bin = 'C:/Program Files/PostgreSQL/16/bin';
const host = '127.0.0.1', port = 55436, user = 'driver_order_fixture';
const password = randomBytes(32).toString('hex');
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|DIRECT_URL$|TEST_DATABASE_URL$|NODE_OPTIONS$)/i.test(key)));
const exec = promisify(execFile), cases = [];
let owned, pool, prisma, started = false;
const cleanup = { prismaDisconnected: false, poolClosed: false, databaseStopped: false, databaseDeleted: false, passwordFileDeleted: false };
async function command(name, args) {
  try { return await exec(path.join(bin, `${name}.exe`), args, { env: safeEnv, windowsHide: true, shell: false, timeout: 45000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error(`격리 PostgreSQL ${name} 명령 실패`); }
}
async function load(file, dependencies = {}) {
  const compiled = ts.transpileModule(await readFile(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Date, Intl, Request, Response, console, require(id) {
    if (!Object.hasOwn(dependencies, id)) throw new Error('격리 로더 허용 범위 밖 의존성');
    return dependencies[id];
  } }, { filename: file });
  return exports;
}
async function run(name, work) {
  try { await work(); cases.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, pass: false, errorType: error.name, code: error.code ?? null }); console.log(`FAIL ${name} (${error.name})`); }
}
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const baseline = [{ rowIds: [id(1)], sortOrder: 0, arriveTime: '14:38' }, { rowIds: [id(2)], sortOrder: 1, arriveTime: '14:45' }];
const updates = [{ rowIds: [id(2)], sortOrder: 0, arriveTime: '14:38' }, { rowIds: [id(1)], sortOrder: 1, arriveTime: '14:45' }];
const payload = { custom: 'keep-route', vehicles: [{ vehicleName: '합성 차량', tripLabel: '1회', custom: 'keep-vehicle', stops: [
  { label: '합성 차고지', lat: 37, lng: 127, students: [] },
  { label: '합성 정류장1', lat: 37.01, lng: 127.01, etaLabel: '14:38 승차', students: [{ requestId: 'student1', custom: 'keep-student' }] },
  { label: '합성 정류장2', lat: 37.02, lng: 127.02, etaLabel: '14:45 승차', students: [{ requestId: 'student2' }] },
] }] };

try {
  assert.equal(process.platform, 'win32'); assert.equal(process.argv.length, 2, '추가 URL·인자를 허용하지 않습니다.');
  await access(path.join(bin, 'initdb.exe'));
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, host, () => probe.close(resolve)); });
  await mkdir(path.join(root, '.tmp'), { recursive: true });
  owned = await mkdtemp(path.join(root, '.tmp', 'driver-order-pg-'));
  const data = path.join(owned, 'data'), pwfile = path.join(owned, 'init-password');
  await writeFile(pwfile, password, { mode: 0o600, flag: 'wx' });
  try { await command('initdb', ['-D', data, '-U', user, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${pwfile}`, '--encoding=UTF8', '--no-locale']); }
  finally { await unlink(pwfile); cleanup.passwordFileDeleted = true; }
  started = true;
  await command('pg_ctl', ['start', '-D', data, '-l', path.join(owned, 'postgres.log'), '-o', `-h ${host} -p ${port} -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0`, '-w', '-t', '30']);
  pool = new pg.Pool({ host, port, user, password, database: 'postgres', ssl: false, connectionTimeoutMillis: 5000 });
  pool.on('error', () => { console.error('격리 DB 연결 오류'); });
  const { rows: [identity] } = await pool.query("SELECT host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS directory");
  assert.equal(identity.host, host); assert.equal(identity.port, port);
  assert.equal((await realpath(identity.directory)).toLowerCase(), (await realpath(data)).toLowerCase());
  prisma = new PrismaClient({ datasources: { db: { url: `postgresql://${user}:${password}@${host}:${port}/postgres?schema=public` } }, log: [] });
  await pool.query(`CREATE TABLE "RegularShuttleStop" (id text PRIMARY KEY,"serviceMonth" text,weekday int,"weekdayLabel" text,"classTime" text,"arriveTime" text,"stopName" text,direction text,"studentName" text,"studentId" text,"studentPhone" text,"parentPhone" text,note text,"sortOrder" int,latitude float8,longitude float8);
    CREATE TABLE "RegularDispatchRoute" (id text PRIMARY KEY,"serviceMonth" text,"dayOfWeek" text,direction text,payload jsonb,"updatedAt" timestamptz DEFAULT now());
    CREATE TABLE "User" (id text PRIMARY KEY,phone text);
    CREATE TABLE "Student" (id text PRIMARY KEY,name text,grade text,phone text,"parentId" text,"mergedIntoStudentId" text,"createdAt" timestamptz DEFAULT now());
    CREATE TABLE "Guardian" ("studentId" text,phone text);`);
  const logic = await load('src/lib/shuttle/regularDriverRouteLogic.ts');
  const unified = await load('src/lib/shuttle/unifiedDriverRunLogic.ts');
  const rosterLogic = await load('src/lib/regular/shuttleRosterLogic.ts');
  const roster = await load('src/lib/regular/shuttleRoster.ts', { '@/lib/prisma': { prisma }, './shuttleRosterLogic': rosterLogic });
  const plan = await load('src/lib/shuttle/driverOrderPlan.ts', { './regularDriverRouteLogic': logic, './unifiedDriverRunLogic': unified });
  const kst = await load('src/lib/datetime/kst.ts');
  const api = await load('src/app/api/shuttle/regular-order/route.ts', {
    'next/server': { NextResponse: { json: (body, options = {}) => new Response(JSON.stringify(body), options) } },
    '@/lib/shuttle/driverToken': { isAnyDriverRunToken: async token => token === 'synthetic-owned-token' },
    '@/lib/prisma': { prisma }, '@/lib/datetime/kst': kst, '@/lib/regular/shuttleRosterLogic': rosterLogic,
    '@/lib/regular/shuttleRoster': roster, '@/lib/shuttle/driverOrderPlan': plan,
  });
  async function reset({ fallback = false } = {}) {
    await pool.query('TRUNCATE "RegularShuttleStop","RegularDispatchRoute","Student","User","Guardian"');
    for (const n of [1, 2]) {
      await pool.query('INSERT INTO "User"(id) VALUES($1)', [`parent${n}`]);
      await pool.query('INSERT INTO "Student"(id,name,grade,"parentId") VALUES($1,$2,$3,$4)', [`student${n}`, `합성 학생${n}`, '초4', `parent${n}`]);
      // 첫 학생은 확정 ID, 둘째는 이름 연결을 사용해 실제 lateral 매칭 SQL도 확인한다.
      await pool.query('INSERT INTO "RegularShuttleStop"(id,"serviceMonth",weekday,"weekdayLabel","classTime","arriveTime","stopName",direction,"studentName","studentId","sortOrder",latitude,longitude) VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)', [id(n), '2026-10', '월', '15:00~16:00', n === 1 ? '14:38' : '14:45', `합성 정류장${n}`, 'BOARD', `합성 학생${n}`, n === 1 ? 'student1' : null, n - 1, 37 + n / 100, 127 + n / 100]);
    }
    if (!fallback) await pool.query('INSERT INTO "RegularDispatchRoute"(id,"serviceMonth","dayOfWeek",direction,payload) VALUES($1,$2,$3,$4,$5::jsonb)', ['synthetic-route', '2026-10', 'Mon', 'PICKUP', JSON.stringify(payload)]);
  }
  const post = (extra = {}) => api.POST(new Request('http://isolated.invalid/api/shuttle/regular-order', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'synthetic-owned-token', date: '2026-10-19', baseline, updates, ...extra }) }));
  async function snapshot() {
    return { rows: (await pool.query('SELECT * FROM "RegularShuttleStop" ORDER BY id')).rows, routes: (await pool.query('SELECT id,payload FROM "RegularDispatchRoute" ORDER BY id')).rows };
  }
  async function reassemble() {
    const rows = await prisma.$queryRawUnsafe('SELECT * FROM "RegularShuttleStop" WHERE weekday=1 ORDER BY "sortOrder",id');
    const saved = (await prisma.$queryRawUnsafe('SELECT payload FROM "RegularDispatchRoute" WHERE direction=\'PICKUP\''))[0]?.payload ?? null;
    const result = await roster.getRegularShuttleRiders({ serviceMonth: '2026-10', dayOfWeek: 'Mon', direction: 'PICKUP' });
    const maps = new Map();
    for (const rider of [...result.riders, ...result.unassigned]) maps.set(rider.studentId, [...(maps.get(rider.studentId) ?? []), rider.stopRowId]);
    return { roster: result, classes: logic.assembleRegularDriverClasses({ dayRows: rows, saved: { PICKUP: saved, DROPOFF: null }, rowIdsByStudentId: { PICKUP: maps, DROPOFF: new Map() }, isAbsent: () => false }), saved };
  }
  await run('실제 명단 SQL은 확정 학생 ID와 이름 연결을 모두 유지한다', async () => {
    await reset(); const result = await roster.getRegularShuttleRiders({ serviceMonth: '2026-10', dayOfWeek: 'Mon', direction: 'PICKUP' });
    assert.deepEqual(Array.from(result.riders, rider => [rider.studentId, rider.stopRowId]).sort(), [['student1', id(1)], ['student2', id(2)]]);
  });
  await run('실제 Prisma 트랜잭션 저장 후 실제 SQL·기사 조립 재조회가 순서·시각·경유·메타를 보존한다', async () => {
    await reset(); const response = await post(); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true, verified: true, updated: 2 });
    const actual = await reassemble();
    assert.deepEqual(Array.from(actual.classes[0].board, stop => stop.rows[0].rowId), [id(2), id(1)]);
    assert.deepEqual(Array.from(actual.classes[0].board, stop => stop.arriveTime), ['14:38', '14:45']);
    assert.equal(actual.saved.custom, 'keep-route'); assert.equal(actual.saved.vehicles[0].custom, 'keep-vehicle');
    assert.equal(actual.saved.vehicles[0].stops[0].label, '합성 차고지'); assert.equal(actual.saved.vehicles[0].stops[2].students[0].custom, 'keep-student');
    assert.equal(actual.classes[0].board[1].lat, 37.01);
  });
  await run('첫 저장 후 오래된 두 번째 화면은 409이며 실제 DB가 바뀌지 않는다', async () => {
    await reset(); assert.equal((await post()).status, 200); const before = await snapshot(); assert.equal((await post()).status, 409); assert.deepEqual(await snapshot(), before);
  });
  await run('명단 수정 후 확정 노선 UPDATE의 DB 강제 오류는 전체 롤백한다', async () => {
    await reset(); const before = await snapshot();
    await pool.query(`CREATE FUNCTION fail_driver_order_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'SYNTHETIC_WRITE_FAILURE'; END $$; CREATE TRIGGER fail_driver_order_fixture BEFORE UPDATE ON "RegularDispatchRoute" FOR EACH ROW EXECUTE FUNCTION fail_driver_order_fixture()`);
    try { const response = await post(); assert.equal(response.status, 409); assert.doesNotMatch(await response.text(), /SYNTHETIC_WRITE_FAILURE/); assert.deepEqual(await snapshot(), before); }
    finally { await pool.query('DROP TRIGGER fail_driver_order_fixture ON "RegularDispatchRoute"; DROP FUNCTION fail_driver_order_fixture()'); }
  });
  for (const [name, date] of [['다른 월의 월요일', '2026-11-02'], ['다른 요일', '2026-10-20']]) await run(`${name} 요청은 409이며 실제 DB가 바뀌지 않는다`, async () => {
    await reset(); const before = await snapshot(); assert.equal((await post({ date })).status, 409); assert.deepEqual(await snapshot(), before);
  });
  await run('동일 월·요일의 다른 날짜는 월별 공통 노선을 사용한다는 현재 동작을 명시한다', async () => {
    await reset(); assert.equal((await post({ date: '2026-10-26' })).status, 200);
    assert.deepEqual(Array.from((await reassemble()).classes[0].board, stop => stop.rows[0].rowId), [id(2), id(1)]);
  });
  await run('확정 노선 없는 명단 폴백도 실제 DB 저장·조립 재조회가 일치한다', async () => {
    await reset({ fallback: true }); assert.equal((await post()).status, 200);
    const actual = await reassemble(); assert.equal(actual.saved, null);
    assert.deepEqual(Array.from(actual.classes[0].board, stop => stop.rows[0].rowId), [id(2), id(1)]);
    assert.deepEqual(Array.from(actual.classes[0].board, stop => stop.arriveTime), ['14:38', '14:45']);
  });
} catch (error) {
  cases.push({ name: '격리 준비 또는 실행', pass: false, errorType: error.name, code: error.code ?? null });
  console.error(`격리 검증 중단 (${error.name})`);
} finally {
  if (prisma) { await prisma.$disconnect(); cleanup.prismaDisconnected = true; }
  if (pool) { await pool.end(); cleanup.poolClosed = true; }
  if (started && owned) {
    try { await command('pg_ctl', ['stop', '-D', path.join(owned, 'data'), '-m', 'fast', '-w']); cleanup.databaseStopped = true; }
    catch { console.error('HELD: 소유 임시 DB 종료 재확인 필요'); }
  }
  if (owned && cleanup.databaseStopped) {
    const target = path.join(owned, 'data');
    const expectedRoot = path.join(await realpath(path.join(root, '.tmp')), path.basename(owned));
    assert.equal((await realpath(owned)).toLowerCase(), expectedRoot.toLowerCase());
    assert.equal((await realpath(target)).toLowerCase(), path.join(expectedRoot, 'data').toLowerCase());
    await rm(target, { recursive: true, force: true }); cleanup.databaseDeleted = true;
  }
  if (owned) {
    const evidence = { isolated: true, database: '새 소유 loopback PostgreSQL만 사용', realPrisma: true, syntheticTokenGuard: true, cases, cleanup,
      limits: ['최소 합성 테이블이며 전체 운영 스키마·인증·실데이터·HTTP 서버·브라우저·실기기 검증 아님', '정규 노선은 날짜별이 아니라 적용 월·요일 공통이며 같은 월의 다른 월요일도 공유함'] };
    await writeFile(path.join(owned, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(`증거: ${path.relative(root, path.join(owned, 'evidence.json'))}`);
  }
  console.log(`통과 ${cases.filter(item => item.pass).length}/${cases.length}; 정리 ${JSON.stringify(cleanup)}`);
  if (cases.some(item => !item.pass) || !cleanup.databaseStopped || !cleanup.databaseDeleted || !cleanup.passwordFileDeleted) process.exitCode = 1;
}
