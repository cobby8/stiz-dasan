import { createServer, request as httpsRequest } from 'node:https';
import { randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import * as crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import net from 'node:net';
import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import ts from 'typescript';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE = path.join(root, '.tmp', 'driver-device-test');
export const HOST = '127.0.0.1', HTTPS_PORT = 8443, PG_PORT = 55435;
export const RUN_PATH = '/driver/device-test-only';
const tlsDir = path.join(WORKSPACE, 'tls');
const pgBin = 'C:/Program Files/PostgreSQL/16/bin';
const openssl = 'C:/Program Files/Git/usr/bin/openssl.exe';
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|DIRECT_URL$|TEST_DATABASE_URL$|NODE_OPTIONS$)/i.test(key)));
const command = async (file, args) => {
  try { return await promisify(execFile)(file, args, { env: safeEnv, windowsHide: true, shell: false, timeout: 45000, maxBuffer: 1024 * 1024 }); }
  catch { throw new Error('격리 시험 준비 명령 실패. 비밀값을 보호하기 위해 하위 출력을 생략합니다.'); }
};
export function ownedPath(candidate) {
  const resolved = path.resolve(candidate), relative = path.relative(WORKSPACE, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('시험 소유 하위 경로가 아닙니다.');
  return resolved;
}
export function controlAllowed(remote, header, key) {
  return remote === HOST && typeof header === 'string' && typeof key === 'string' && /^[0-9a-f]{64}$/.test(header) && /^[0-9a-f]{64}$/.test(key) && timingSafeEqual(Buffer.from(header), Buffer.from(key));
}
export async function verifiedOwnedPath(candidate) {
  const absolute = ownedPath(candidate), realRoot = await realpath(root), realWorkspace = await realpath(WORKSPACE), realCandidate = await realpath(absolute);
  if (realWorkspace.toLowerCase() !== path.join(realRoot, '.tmp', 'driver-device-test').toLowerCase() || !realCandidate.toLowerCase().startsWith(`${realWorkspace.toLowerCase()}${path.sep}`)) throw new Error('시험 실제 소유 경로 검증 실패');
  return absolute;
}
async function requireFreePort(port) {
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, HOST, () => probe.close(resolve)); });
}
export function maskedSummary(rows, location, counters, now = Date.now()) {
  const latest = rows[0];
  return {
    isolated: true, serverAt: new Date(now).toISOString(), requests: Object.fromEntries(['start', 'location', 'stop', 'status', 'failed'].map(key => [key, counters[key] ?? 0])), sessionCount: rows.length,
    activeSessions: rows.filter(row => row.state === 'ACTIVE' && new Date(row.expiresAt).getTime() > now).length,
    state: latest ? (latest.state === 'ACTIVE' && new Date(latest.expiresAt).getTime() <= now ? 'EXPIRED' : latest.state) : 'NONE',
    lastSentAt: latest?.lastSentAt ?? null, capturedAt: latest?.capturedAt ?? null,
    transmissionDelayMs: latest?.lastSentAt && latest?.capturedAt ? new Date(latest.lastSentAt).getTime() - new Date(latest.capturedAt).getTime() : null,
    secondsSinceReceipt: latest?.lastSentAt ? Math.max(0, Math.floor((now - new Date(latest.lastSentAt).getTime()) / 1000)) : null,
    accuracy: latest?.accuracy ?? null, sharing: location?.sharing ?? false,
  };
}
async function prepareCertificates() {
  await mkdir(tlsDir, { recursive: true });
  try {
    const cert = new X509Certificate(await readFile(path.join(tlsDir, 'server.crt')));
    if (Date.parse(cert.validTo) > Date.now() + 30 * 60 * 1000) {
      await stat(path.join(tlsDir, 'server.key')); await stat(path.join(tlsDir, 'ca.crt')); return;
    }
  } catch { /* 최초 준비 또는 종료 정리 후에는 새 시험 인증서를 만든다. */ }
  const caKey = path.join(tlsDir, 'ca.key'), csr = path.join(tlsDir, 'server.csr'), config = path.join(tlsDir, 'extensions.cnf');
  await writeFile(config, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n');
  try {
    await command(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '1', '-subj', '/CN=STIZ Isolated Device Test CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', path.join(tlsDir, 'ca.crt')]);
    await command(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=localhost', '-keyout', path.join(tlsDir, 'server.key'), '-out', csr]);
    await command(openssl, ['x509', '-req', '-in', csr, '-CA', path.join(tlsDir, 'ca.crt'), '-CAkey', caKey, '-CAcreateserial', '-days', '1', '-sha256', '-extfile', config, '-out', path.join(tlsDir, 'server.crt')]);
  } finally {
    for (const file of [caKey, csr, config, path.join(tlsDir, 'ca.srl')]) await unlink(file).catch(() => {});
  }
}
async function prepareBundle() {
  const output = path.join(WORKSPACE, 'web'); await mkdir(output, { recursive: true });
  const files = {
    'entry.js': `import{createElement}from'react';import{createRoot}from'react-dom/client';import Driver from '@/components/shuttle/UnifiedDriverClient';const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const id='11111111-1111-4111-8111-111111111111';const row={key:'device-test-stop',label:'기기 검증 정류장',time:'16:00',minutes:960,seq:1,kind:'REGULAR',direction:'PICKUP',groupKey:'device-test-group',groupLabel:'기기 검증 수업',subLabel:null,lat:null,lng:null,isHub:false,isTerminal:false,pending:false,warn:false,riders:[{key:'R:'+id,checkId:id,kind:'REGULAR',direction:'PICKUP',name:'검증 학생',grade:null,parentPhone:null,studentPhone:null,absent:false}]};createRoot(document.getElementById('root')).render(createElement(Driver,{token:'device-test-only',date,today:date,prevDate:null,nextDate:null,driverLabel:'기기 검증',initialBoarding:{},rows:[row]}));`,
    'loader.cjs': `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=function(source){return ts.transpileModule(source,{fileName:this.resourcePath,compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;};`,
    // 클래스는 원문 이름으로 연결하고 CSS 본문은 아래 screen.css에 합친다.
    // 인라인 style 삽입 없이 기존 style-src 'self' 보안 정책을 유지한다.
    'css-loader.cjs': `module.exports=function(source){const names=[...source.matchAll(/\\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)].map(match=>match[1]);return 'export default '+JSON.stringify(Object.fromEntries(names.map(name=>[name,name])))+';';};`,
    'navigation.js': `export function useRouter(){return{refresh(){},push(url){location.assign(url);}};}export function usePathname(){return location.pathname;}`,
    'link.js': `import{createElement}from'react';export default function Link({children,...props}){return createElement('a',props,children);}`,
    'image.js': `import{createElement}from'react';export default function Image({priority,fill,unoptimized,...props}){return createElement('img',props);}`,
  };
  await Promise.all(Object.entries(files).map(([name, value]) => writeFile(path.join(output, name), value)));
  const { webpack } = require('next/dist/compiled/webpack/webpack');
  const compiler = webpack({ mode: 'development', context: output, target: 'web', devtool: false, cache: false,
    entry: path.join(output, 'entry.js'), output: { path: output, filename: 'bundle.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], modules: [path.join(root, 'node_modules')], alias: { '@': path.join(root, 'src'), 'next/navigation$': path.join(output, 'navigation.js'), 'next/link$': path.join(output, 'link.js'), 'next/image$': path.join(output, 'image.js') } },
    module: { rules: [
      { test: /\.tsx?$/, use: [path.join(output, 'loader.cjs')] },
      { test: /\.module\.css$/, use: [path.join(output, 'css-loader.cjs')] },
    ] },
    plugins: [{ apply(current) { current.hooks.compilation.tap('IsolatedDevice', compilation => { compilation.hooks.finishModules.tap('IsolatedDevice', modules => {
      for (const item of modules) if (/\/src\/(?:app\/actions\/|lib\/(?:prisma|auth-guard|notification))/.test(item.resource?.replaceAll('\\', '/') ?? '')) throw new Error('시험 번들에 서버 모듈이 들어왔습니다.');
    }); }); } }],
  });
  let moduleCssFiles = [];
  try { await new Promise((resolve, reject) => compiler.run((error, result) => {
    if (error || !result || result.hasErrors()) { reject(new Error('시험 번들 빌드 실패')); return; }
    moduleCssFiles = [...result.compilation.fileDependencies].filter(file => /\.module\.css$/.test(file));
    resolve();
  })); }
  finally { await new Promise(resolve => compiler.close(resolve)); }
  // 렌더링은 원본, 색상은 원본 academy-theme. 이 시험은 기능/위치 검증이며 시각 QA를 대체하지 않는다.
  const theme = await readFile(path.join(root, 'src/app/academy-theme.css'), 'utf8');
  const moduleCss = (await Promise.all(moduleCssFiles.map(file => readFile(file, 'utf8')))).join('\n').replace(/:global\(([^)]+)\)/g, '$1');
  const css = await postcss([tailwind({ base: root })]).process(`@import "tailwindcss" source(none);\n@source "${path.join(root, 'src/components/shuttle').replaceAll('\\', '/')}";\n@source "${path.join(root, 'src/components/academy').replaceAll('\\', '/')}";\n${theme}\n${moduleCss}\nbody{margin:0;font-family:system-ui,sans-serif}.material-symbols-outlined{font-size:16px}`, { from: path.join(output, 'screen.input.css') });
  await writeFile(path.join(output, 'screen.css'), css.css);
  await writeFile(path.join(output, 'index.html'), '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>STIZ 격리 기기 시험</title><link rel="stylesheet" href="/screen.css"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
}
export async function acquireWorkspace() {
  await mkdir(WORKSPACE, { recursive: true });
  const actual = await realpath(WORKSPACE), expected = path.join(await realpath(root), '.tmp', 'driver-device-test');
  if (actual.toLowerCase() !== expected.toLowerCase()) throw new Error('시험 작업 경로가 외부로 연결되어 있습니다.');
  const lock = path.join(WORKSPACE, 'server.lock');
  const handle = await open(lock, 'wx', 0o600);
  await handle.writeFile(String(process.pid));
  return async () => { try { await handle.close(); } finally { await unlink(lock); } };
}
async function prepareArtifacts() { await prepareCertificates(); await prepareBundle(); }
export async function prepare() {
  const release = await acquireWorkspace();
  try { await prepareArtifacts(); } finally { await release(); }
}
async function loadApi(file, dependencies) {
  const source = ts.transpileModule(await readFile(path.join(root, file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, Buffer, Date, process: { env: { DRIVER_MOBILE_TRACKING_ENABLED: 'true' } }, require(id) { if (!Object.hasOwn(dependencies, id)) throw new Error('시험 서버 의존성 범위 밖'); return dependencies[id]; } }, { filename: file });
  return exports;
}
async function status() {
  const key = await readFile(path.join(WORKSPACE, 'control-key'), 'utf8');
  const ca = await readFile(path.join(tlsDir, 'ca.crt'));
  return new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: HOST, port: HTTPS_PORT, servername: 'localhost', ca, path: '/__test/status', headers: { 'X-STIZ-Test-Control': key } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => response.statusCode === 200 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error('시험 상태 조회 거부'))); });
    req.on('error', () => reject(new Error('시험 서버에 연결할 수 없습니다.'))); req.end();
  });
}
export async function serve() {
  const release = await acquireWorkspace();
  let pool, prisma, server, dataDir, started = false, closing = false, timeout, ready = false, shutdownRequested = false;
  let ownsSecrets = false;
  const inFlight = new Set();
  const controlKey = randomBytes(32).toString('hex');
  const counters = { start: 0, location: 0, stop: 0, status: 0, failed: 0 };
  async function close() {
    if (closing) return; closing = true; clearTimeout(timeout);
    const cleanup = { serverClosed: !server, databaseStopped: !started, databaseDeleted: !dataDir, serverKeyDeleted: !ownsSecrets, controlKeyDeleted: !ownsSecrets };
    try {
      if (server) try { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); cleanup.serverClosed = true; } catch { console.error('HELD: HTTPS 종료 상태 재확인 필요'); }
      await Promise.allSettled([...inFlight]);
      if (prisma) try { await prisma.$disconnect(); } catch { console.error('HELD: 시험 Prisma 종료 확인 필요'); }
      if (pool) try { await pool.end(); } catch { console.error('HELD: 시험 DB 연결 종료 확인 필요'); }
      let stopped = !started;
      if (started) try { await command(path.join(pgBin, 'pg_ctl.exe'), ['stop', '-D', dataDir, '-m', 'fast', '-w']); stopped = true; cleanup.databaseStopped = true; } catch { console.error(`HELD: 시험 DB 종료 확인 실패. 보존 경로: ${path.dirname(dataDir)}`); }
      if (dataDir && stopped) try { await rm(await verifiedOwnedPath(path.dirname(dataDir)), { recursive: true, force: true }); cleanup.databaseDeleted = true; } catch { console.error(`HELD: 시험 DB 삭제 확인 필요. 보존 경로: ${path.dirname(dataDir)}`); }
      if (ownsSecrets) for (const [file, field] of [[path.join(tlsDir, 'server.key'), 'serverKeyDeleted'], [path.join(WORKSPACE, 'control-key'), 'controlKeyDeleted']]) {
        try { await unlink(ownedPath(file)); cleanup[field] = true; } catch (error) { if (error.code === 'ENOENT') cleanup[field] = true; }
      }
      await writeFile(path.join(WORKSPACE, 'cleanup.json'), JSON.stringify(cleanup));
      console.log(`격리 시험 정리 결과: ${JSON.stringify(cleanup)}`);
    } finally { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); await release(); }
  }
  const onSignal = () => { shutdownRequested = true; if (ready) void close().then(() => process.exit(0)); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  const checkShutdown = () => { if (shutdownRequested) throw new Error('시험 시작 중 종료 요청'); };
  try {
    await requireFreePort(HTTPS_PORT); await requireFreePort(PG_PORT);
    ownsSecrets = true; await prepareArtifacts(); checkShutdown();
    const owned = await mkdtemp(path.join(WORKSPACE, 'pg-')); dataDir = path.join(owned, 'data');
    const password = randomBytes(32).toString('hex'), user = 'driver_device_fixture', passwordFile = path.join(owned, 'init-password');
    await writeFile(passwordFile, password, { mode: 0o600, flag: 'wx' });
    try { await command(path.join(pgBin, 'initdb.exe'), ['-D', dataDir, '-U', user, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${passwordFile}`, '--encoding=UTF8', '--no-locale']); }
    finally { await unlink(passwordFile); }
    checkShutdown();
    started = true;
    await command(path.join(pgBin, 'pg_ctl.exe'), ['start', '-D', dataDir, '-l', path.join(owned, 'postgres.log'), '-o', `-h ${HOST} -p ${PG_PORT} -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0`, '-w']);
    checkShutdown();
    pool = new pg.Pool({ host: HOST, port: PG_PORT, user, password, database: 'postgres', ssl: false });
    const { rows: [identity] } = await pool.query("SELECT host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('data_directory') AS directory");
    if (identity.host !== HOST || identity.port !== PG_PORT || (await realpath(identity.directory)).toLowerCase() !== (await realpath(dataDir)).toLowerCase()) throw new Error('시험 DB 소유권이 일치하지 않습니다.');
    await pool.query(`CREATE TABLE "ShuttleRunLink"(id text PRIMARY KEY,token text UNIQUE);CREATE TABLE "DriverLocation"(token text PRIMARY KEY,label text,latitude float8,longitude float8,accuracy float8,speed float8,heading float8,sharing boolean,"updatedAt" timestamptz);INSERT INTO "ShuttleRunLink" VALUES ('device-test-link','device-test-only');`);
    await pool.query(await readFile(path.join(root, 'scripts/sql/driver-mobile-tracking-session.sql'), 'utf8'));
    prisma = new PrismaClient({ datasources: { db: { url: `postgresql://${user}:${password}@${HOST}:${PG_PORT}/postgres?schema=public` } }, log: [] });
    const helper = await loadApi('src/lib/shuttle/mobileTracking.ts', { 'node:crypto': crypto });
    const api = await loadApi('src/app/api/driver/mobile/session/route.ts', { '@/lib/prisma': { prisma }, '@/lib/shuttle/mobileTracking': helper, 'next/server': { NextResponse: { json: (body, options) => new Response(JSON.stringify(body), options) } } });
    await writeFile(path.join(WORKSPACE, 'control-key'), controlKey, { mode: 0o600 });
    const handler = async (incoming, outgoing) => {
      outgoing.setHeader('Cache-Control', 'no-store');
      outgoing.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'");
      try {
        const pathname = new URL(incoming.url, 'https://localhost').pathname;
        if (pathname === '/__test/status' && incoming.method === 'GET') {
          if (!controlAllowed(incoming.socket.remoteAddress, incoming.headers['x-stiz-test-control'], controlKey)) { outgoing.writeHead(403); outgoing.end(); return; }
          const { rows } = await pool.query(`SELECT state,"expiresAt","lastSentAt","capturedAt",accuracy FROM "DriverMobileTrackingSession" ORDER BY "createdAt" DESC`);
          const { rows: locations } = await pool.query('SELECT sharing FROM "DriverLocation" LIMIT 1');
          outgoing.writeHead(200, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify(maskedSummary(rows, locations[0], counters))); return;
        }
        if (pathname === '/api/driver/mobile/session' && incoming.method === 'POST') {
          const chunks = []; let length = 0;
          for await (const chunk of incoming) { length += chunk.length; if (length > 16384) { outgoing.writeHead(413); outgoing.end(); return; } chunks.push(chunk); }
          const body = Buffer.concat(chunks).toString('utf8');
          let action; try { action = JSON.parse(body).action; } catch { /* 원본 라우트가 검증한다. */ }
          const response = await api.POST(new Request('https://localhost/api/driver/mobile/session', { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: incoming.headers.authorization ?? '' }, body }));
          if (response.ok && Object.hasOwn(counters, action) && action !== 'failed') counters[action]++; else if (!response.ok) counters.failed++;
          outgoing.writeHead(response.status, { 'Content-Type': 'application/json' }); outgoing.end(await response.text()); return;
        }
        const assets = { [RUN_PATH]: ['web/index.html', 'text/html; charset=utf-8'], '/bundle.js': ['web/bundle.js', 'application/javascript'], '/screen.css': ['web/screen.css', 'text/css'], '/stiz-logo.png': [null, 'image/png'] };
        if (incoming.method !== 'GET' || !Object.hasOwn(assets, pathname)) { outgoing.writeHead(404); outgoing.end(); return; }
        const [relative, type] = assets[pathname]; const file = relative ? path.join(WORKSPACE, relative) : path.join(root, 'public/stiz-logo.png');
        outgoing.writeHead(200, { 'Content-Type': type }); outgoing.end(await readFile(file));
      } catch { outgoing.writeHead(503, { 'Content-Type': 'application/json' }); outgoing.end('{"error":"ISOLATED_TEST_UNAVAILABLE"}'); }
    };
    server = createServer({ key: await readFile(path.join(tlsDir, 'server.key')), cert: await readFile(path.join(tlsDir, 'server.crt')) }, (incoming, outgoing) => {
      const task = handler(incoming, outgoing); inFlight.add(task); void task.finally(() => inFlight.delete(task)).catch(() => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(HTTPS_PORT, HOST, resolve); });
    ready = true; checkShutdown();
    timeout = setTimeout(() => { void close().then(() => process.exit(0)); }, 2 * 60 * 60 * 1000);
    console.log('격리 기기 시험 서버 준비 완료: loopback HTTPS8443, 임시 DB55435. 요청·좌표 로그 없음. 최대 2시간.');
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === '--prepare') { await prepare(); console.log('시험 공개 CA와 원본 화면 번들 준비 완료. 서버와 DB는 시작하지 않았습니다.'); }
    else if (args.length === 1 && args[0] === '--status') console.log(await status());
    else if (args.length === 0) await serve();
    else throw new Error('허용된 실행 옵션: --prepare 또는 --status');
  } catch { console.error('격리 기기 시험 준비/실행 실패. 운영 서비스에 연결하지 않았습니다.'); process.exitCode = 1; }
}
