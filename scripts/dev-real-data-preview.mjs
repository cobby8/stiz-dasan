// 운영 자료는 SELECT 전용 연결로 한 번 읽고, 앱은 별도의 로컬 DB만 사용합니다.
import assert from 'node:assert/strict';
import { access, cp, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import pg from 'pg';
import dotenv from 'dotenv';
import { capturePreviewSnapshot } from './lib/real-preview-snapshot.mjs';
import { capturePreviewCalendar } from './lib/real-preview-calendar.mjs';
import { createPreviewProxy, LOCAL_DRIVER_TOKEN } from './lib/real-preview-proxy.mjs';

const root = process.cwd();
const out = path.join(root, '.tmp', 'real-data-preview');
const host = '127.0.0.1', pgPort = 55476, httpPort = 4091, proxyPort = 4090;
const bin = 'C:/Program Files/PostgreSQL/16/bin';
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|HOMEDRIVE|HOMEPATH|NUMBER_OF_PROCESSORS)$/i.test(key)));
const password = randomBytes(32).toString('hex');
const gate = randomBytes(32).toString('hex');
const user = 'local_preview_owner';
let owned, target, source, local, server, proxy, started = false, stopping = false;
let snapshot, closed = false;
const summary = { sourceReadOnly: false, sourceDisconnectedBeforeApp: false, operationsEnabled: false, proxyBlocked: 0, proxyErrors: 0, cleanup: {} };
process.on('SIGINT', () => { stopping = true; });
process.on('SIGTERM', () => { stopping = true; });
const stopFile = path.join(out, 'STOP');
const identifier = value => '"' + String(value).replaceAll('"', '""') + '"';

async function free(port) { await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, host, () => s.close(resolve)); }); }
async function command(executable, args, { cwd = root, env = safeEnv, timeout = 60000 } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('LOCAL_COMMAND_TIMEOUT')); }, timeout);
    child.once('error', () => { clearTimeout(timer); reject(new Error('LOCAL_COMMAND_FAILED')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('LOCAL_COMMAND_FAILED')); });
  });
}
async function pgCommand(name, args) { return command(path.join(bin, name + '.exe'), args); }
async function writeSummary() { await writeFile(path.join(out, 'summary.json'), JSON.stringify(summary, null, 2)); }
async function cleanup() {
  if (closed) return; closed = true;
  if (proxy) await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections?.(); });
  if (server) { server.kill(); if (server.exitCode === null) await new Promise(resolve => server.once('close', resolve)); summary.cleanup.serverStopped = true; }
  if (source) { await source.query('ROLLBACK').catch(() => {}); await source.end().catch(() => {}); }
  if (local) await local.end().catch(() => {});
  if (started) { await pgCommand('pg_ctl', ['stop', '-D', path.join(owned, 'data'), '-m', 'fast', '-w', '-t', '30']); summary.cleanup.databaseStopped = true; }
  if (owned && (!started || summary.cleanup.databaseStopped)) {
    const actual = await realpath(owned); assert.ok(actual.toLowerCase().startsWith(path.join(os.tmpdir(), 'stiz-real-preview-db-').toLowerCase()));
    await rm(owned, { recursive: true, force: true }); summary.cleanup.databaseDeleted = true;
  }
  if (target) {
    // 개인정보가 담긴 로컬 DB와 인증 대체 빌드는 미리보기 종료 시 함께 정리합니다.
    for (const name of ['src/lib/supabase/qa-fixture.ts', '.next']) {
      const p = path.join(target, name); assert.ok(path.resolve(p).startsWith(path.resolve(target) + path.sep));
      await rm(p, { recursive: true, force: true });
    }
    summary.cleanup.localIdentityBuildRemoved = true;
  }
  summary.running = false; await writeSummary();
}

try {
  summary.phase = 'source-read';
  await mkdir(out, { recursive: true });
  assert.equal(await access(path.join(out, 'ready.json')).then(() => true, () => false), false, 'Fresh preview directory required');
  await Promise.all([free(pgPort), free(httpPort), free(proxyPort)]);
  // 실제 운영 자료는 애플리케이션 조회 함수를 호출하지 않고 읽습니다.
  let productionEnv = dotenv.parse(await readFile(path.join(root, '.env.local')));
  const connectionString = productionEnv.DIRECT_URL || productionEnv.DATABASE_URL;
  assert.ok(connectionString && !['127.0.0.1', 'localhost', '::1'].includes(new URL(connectionString).hostname));
  source = new pg.Client({ connectionString, connectionTimeoutMillis: 12000, statement_timeout: 30000, application_name: 'stiz_local_readonly_preview', options: '-c default_transaction_read_only=on' });
  await source.connect(); await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal((await source.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
  summary.sourceReadOnly = true;
  // 달력을 읽지 못해도 목록 검토는 허용하되, 부분 일정으로 청구를 계산하지 않습니다.
  const calendarSnapshot = await capturePreviewCalendar(source).catch(() => ({ events: [], kind: 'UNAVAILABLE' }));
  snapshot = await capturePreviewSnapshot(source, { calendarEvents: calendarSnapshot.events });
  if (calendarSnapshot.kind === 'UNAVAILABLE') {
    const annual = snapshot.tables.find(table => table.name === 'AnnualEvent');
    if (annual) annual.rows = [];
    snapshot.summary.tablecounts.AnnualEvent = 0;
  }
  summary.annualCalendar = { kind: calendarSnapshot.kind, eventCount: calendarSnapshot.events.length };
  summary.capturedAt = new Date().toISOString();
  assert.equal((await source.query('SHOW transaction_read_only')).rows[0].transaction_read_only, 'on');
  await source.query('ROLLBACK'); await source.end(); source = null; productionEnv = null;
  summary.sourceDisconnectedBeforeApp = true; summary.snapshot = snapshot.summary;
  console.log('승인된 자료 읽기와 개인정보 가림을 완료했습니다.');
  await writeSummary();

  summary.phase = 'local-db';
  owned = await mkdtemp(path.join(os.tmpdir(), 'stiz-real-preview-db-'));
  const pw = path.join(owned, 'init-password'); await writeFile(pw, password, { mode: 0o600, flag: 'wx' });
  try { await pgCommand('initdb', ['-D', path.join(owned, 'data'), '-U', user, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${pw}`, '--encoding=UTF8', '--no-locale']); } finally { await unlink(pw); }
  await pgCommand('pg_ctl', ['start', '-D', path.join(owned, 'data'), '-l', path.join(owned, 'postgres.log'), '-o', `-h ${host} -p ${pgPort} -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0`, '-w', '-t', '30']); started = true;
  local = new pg.Client({ host, port: pgPort, user, password, database: 'postgres', ssl: false }); await local.connect();
  const identity = (await local.query("SELECT host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS directory")).rows[0];
  assert.equal(identity.host, host); assert.equal(identity.port, pgPort); assert.equal(await realpath(identity.directory), await realpath(path.join(owned, 'data')));
  const databaseUrl = `postgresql://${user}:${password}@${host}:${pgPort}/postgres?schema=public`;

  target = await mkdtemp(path.join(os.tmpdir(), 'stiz-real-preview-app-'));
  for (const name of ['src', 'prisma', 'package.json', 'package-lock.json', 'tsconfig.json', 'next-env.d.ts', 'next.config.ts', 'postcss.config.mjs']) await cp(path.join(root, name), path.join(target, name), { recursive: true });
  await symlink(path.join(root, 'node_modules'), path.join(target, 'node_modules'), 'junction');
  await symlink(path.join(root, 'public'), path.join(target, 'public'), 'junction');
  await cp(path.join(root, 'scripts/lib/real-preview-guard.cjs'), path.join(target, 'preview-guard.cjs'));
  const identities = Object.fromEntries(Object.entries(snapshot.accounts).map(([role, value]) => [role, { id: value.authId, email: value.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }]));
  const fixture = `// LOCAL COPY ONLY. This file is never part of the real application.\nconst identities=${JSON.stringify(identities)};\nexport function createServerClient(_url:any,_key:any,options:{cookies:{getAll:()=>Array<{name:string;value:string}>,setAll?:(items:any[])=>void}}):any{const role=options.cookies.getAll().find((c:any)=>c.name==='qa-role')?.value;const user=(identities as any)[role??'']??null;return{auth:{getClaims:async()=>({data:{claims:user?{sub:user.id,email:user.email,aud:user.aud,role:user.role,app_metadata:{},user_metadata:{}}:null},error:null}),getUser:async()=>({data:{user},error:null})}};}\n`;
  await writeFile(path.join(target, 'src/lib/supabase/qa-fixture.ts'), fixture);
  for (const name of ['server.ts', 'middleware.ts']) {
    const file = path.join(target, 'src/lib/supabase', name), sourceText = await readFile(file, 'utf8');
    assert.ok(sourceText.includes('from "@supabase/ssr"'));
    let replacement = sourceText.replace('from "@supabase/ssr"', 'from "./qa-fixture"');
    if (name === 'middleware.ts') {
      const marker = 'export async function updateSession(request: NextRequest) {';
      assert.ok(replacement.includes(marker));
      replacement = replacement.replace(marker, marker + '\n  if (request.headers.get("x-stiz-preview-gate") !== process.env.STIZ_REAL_PREVIEW_GATE) return new NextResponse("개발 미리보기 경로를 사용해 주세요.", { status: 403 });');
    }
    await writeFile(file, replacement);
  }
  const env = { ...safeEnv, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, NEXT_PUBLIC_SUPABASE_URL: 'https://preview.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'local-preview-only', STIZ_REAL_PREVIEW_GATE: gate, STIZ_REAL_PREVIEW_PORTS: [pgPort, httpPort, proxyPort].join(','), STIZ_REAL_PREVIEW_AUDIT: path.join(out, 'outbound-blocked.log'), NODE_OPTIONS: `--require "${path.join(target, 'preview-guard.cjs').replaceAll('\\', '/')}"` };
  await command(process.execPath, [path.join(root, 'node_modules/prisma/build/index.js'), 'db', 'push', '--schema', path.join(target, 'prisma/schema.prisma'), '--skip-generate'], { cwd: target, env });
  await local.query('BEGIN'); await local.query("SET LOCAL session_replication_role = 'replica'");
  for (const table of snapshot.tables) {
    summary.currentTable = table.name;
    const columns = (await local.query('SELECT column_name,data_type FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2', ['public', table.name])).rows;
    const types = Object.fromEntries(columns.map(c => [c.column_name, c.data_type]));
    for (const row of table.rows) {
      const entries = Object.entries(row).filter(([name]) => Object.hasOwn(types, name)); if (!entries.length) continue;
      const sql = `INSERT INTO ${identifier(table.name)} (${entries.map(([name]) => identifier(name)).join(',')}) VALUES (${entries.map((_, index) => '$' + (index + 1)).join(',')})`;
      const values = entries.map(([name, value]) => value != null && ['json', 'jsonb'].includes(types[name]) ? JSON.stringify(value) : value);
      await local.query(sql, values);
    }
    assert.equal(Number((await local.query(`SELECT count(*) FROM ${identifier(table.name)}`)).rows[0].count), table.rows.length);
  }
  await local.query('COMMIT');
  // 기사님 링크는 로컬 전용이며 운영 토큰을 읽거나 복제하지 않습니다.
  assert.match(LOCAL_DRIVER_TOKEN, /^[a-f0-9]{16,64}$/);
  await local.query('INSERT INTO "ShuttleRunLink" (id,token,"serviceDate",direction,"createdAt") VALUES ($1,$2,$3,$4,NOW())', ['preview-local-only', LOCAL_DRIVER_TOKEN, 'ROLLING', 'REGULAR']);
  summary.localCountsMatched = true;
  delete summary.currentTable;
  const proof = [];
  for (const file of await readdir(path.join(root, 'src'), { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const relative = path.relative(root, path.join(file.parentPath || file.path, file.name));
    if (['src/lib/supabase/server.ts', 'src/lib/supabase/middleware.ts'].includes(relative.replaceAll('\\', '/'))) continue;
    const hash = createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex');
    assert.equal(hash, createHash('sha256').update(await readFile(path.join(target, relative))).digest('hex')); proof.push({ file: relative, hash });
  }
  summary.sourceFilesMatched = proof.length; await writeFile(path.join(out, 'source-proof.json'), JSON.stringify(proof));
  console.log('실제 자료의 로컬 복사본과 최신 화면을 연결했습니다. 빌드를 시작합니다.');
  summary.phase = 'build'; await writeSummary();
  await command(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], { cwd: target, env, timeout: 600000 });
  summary.buildPassed = true;
  if (stopping) throw new Error('LOCAL_PREVIEW_STOPPED');
  const actions = {};
  for (const file of await readdir(path.join(target, '.next/static/chunks'), { recursive: true })) {
    if (!file.endsWith('.js')) continue;
    const text = await readFile(path.join(target, '.next/static/chunks', file), 'utf8');
    for (const match of text.matchAll(/createServerReference\)\("([a-f0-9]{40,64})",[^;]{0,160}?,"(loadStaffSessionMonthlyFees|loadStaffAttendanceBilling)"/g)) actions[match[1]] = match[2];
  }
  summary.allowedReadActions = Object.values(actions);
  // 학생 자료나 연결 정보가 로그에 남지 않도록 앱 출력은 저장하지 않습니다.
  server = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', String(httpPort), '-H', host], { cwd: target, env, windowsHide: true, stdio: 'ignore' });
  proxy = createPreviewProxy({ upstreamPort: httpPort, accounts: snapshot.accounts, actions, gate, onBlocked: () => { summary.proxyBlocked++; }, onError: () => { summary.proxyErrors++; } });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, host, resolve); });
  let ready = false;
  for (let i = 0; i < 90; i++) { try { const res = await fetch(`http://${host}:${proxyPort}/admin`, { headers: { cookie: 'qa-role=admin' }, redirect: 'manual', signal: AbortSignal.timeout(3000) }); if (res.status === 200) { ready = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 500)); }
  assert.ok(ready, 'PREVIEW_NOT_READY');
  summary.running = true;
  summary.phase = 'ready';
  await writeFile(path.join(out, 'ready.json'), JSON.stringify({ url: `http://${host}:${proxyPort}/__entry/admin`, httpPort, proxyPort, pgPort, serverPid: server.pid, accountViews: Object.keys(snapshot.accounts), source: 'local sanitized snapshot only' }));
  await writeSummary(); console.log(`실제 자료 개발 미리보기 준비 완료: http://${host}:${proxyPort}/__entry/admin`);
  snapshot = null;
  let lastSummary = Date.now();
  while (!stopping && !(await access(stopFile).then(() => true, () => false))) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (Date.now() - lastSummary > 10000) { await writeSummary(); lastSummary = Date.now(); }
  }
} catch (error) {
  // 예외 원문에는 DB·학생 자료가 포함될 수 있어 코드만 기록합니다.
  summary.failed = true; summary.errorCode = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'LOCAL_PREVIEW_SETUP_FAILED';
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(error.column || '')) summary.errorColumn = error.column;
  console.error('개발 미리보기 준비 중 오류가 발생했습니다. 운영 자료는 수정하지 않았습니다.'); process.exitCode = 1;
} finally { await cleanup(); }
