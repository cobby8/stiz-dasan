import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { promisify } from 'node:util';
import pg from 'pg';
import ts from 'typescript';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

// 접속 URL을 받지 않는다. 실행기가 새로 만든 loopback PostgreSQL만 사용한다.
const root = process.cwd(), bin = 'C:/Program Files/PostgreSQL/16/bin', port = 55433;
const user = 'staff_fee_fixture_owner', password = randomBytes(32).toString('hex');
const exec = promisify(execFile), checks = [];
const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|DIRECT_URL$|TEST_DATABASE_URL$)/i.test(key)));
let owned, pool, harness, browser, started = false;
const cases = [];
async function command(name, args) {
  try { return await exec(path.join(bin, `${name}.exe`), args, { windowsHide: true, shell: false, timeout: 45000, env: safeEnv }); }
  catch (error) { throw new Error(`${name}: ${String(error.stderr ?? error.code).replaceAll(password, '[REDACTED]').slice(0, 800)}`); }
}
async function loadSource(relative, dependencies) {
  const file = path.join(root, relative);
  const code = ts.transpileModule(await readFile(file, 'utf8'), { fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.compileFunction(code, ['require', 'exports'], { filename: file })(id => {
    if (!Object.hasOwn(dependencies, id)) throw new Error(`격리 로더의 허용되지 않은 의존성: ${id}`);
    return dependencies[id];
  }, exports);
  return exports;
}
async function run(name, work) {
  try { await work(); cases.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, pass: false, error: error.message }); console.log(`FAIL ${name}: ${error.message.slice(0, 300)}`); }
  await writeFile('.tmp/staff-fee-qa/integration-progress.json', JSON.stringify({ cases }, null, 2));
}

try {
  assert.equal(process.platform, 'win32'); assert.equal(process.argv.length, 2, 'URL·추가 인자를 허용하지 않습니다.');
  await access(path.join(bin, 'initdb.exe'));
  await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(resolve)); });
  await mkdir('.tmp/staff-fee-qa', { recursive: true });
  owned = await mkdtemp(path.join(root, '.tmp', 'staff-fee-pg-'));
  const dataDir = path.join(owned, 'data'), pwfile = path.join(owned, 'init-password');
  await writeFile(pwfile, password, { flag: 'wx', mode: 0o600 });
  try { await command('initdb', ['-D', dataDir, '-U', user, '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${pwfile}`, '--encoding=UTF8', '--no-locale']); }
  finally { await unlink(pwfile); }
  started = true;
  await command('pg_ctl', ['start', '-D', dataDir, '-l', path.join(owned, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', '-t', '30']);
  pool = new pg.Pool({ host: '127.0.0.1', port, user, password, database: 'postgres', ssl: false, connectionTimeoutMillis: 5000, query_timeout: 15000 });
  pool.on('error', error => { console.error(`임시 DB 연결 오류: ${error.code ?? 'unknown'}`); });
  const { rows: [identity] } = await pool.query("SELECT current_database() AS db, host(inet_server_addr()) AS host, inet_server_port() AS port, current_setting('data_directory') AS directory");
  assert.equal(identity.db, 'postgres'); assert.equal(identity.host, '127.0.0.1'); assert.equal(identity.port, port);
  assert.equal((await realpath(identity.directory)).toLowerCase(), (await realpath(dataDir)).toLowerCase());
  const database = {
    $queryRawUnsafe: async (sql, ...values) => { assert.match(sql.trim(), /^(SELECT|WITH)\b/i); return (await pool.query(sql, values)).rows; },
    $executeRawUnsafe: async (sql, ...values) => { assert.match(sql.trim(), /^INSERT INTO "StaffPaymentConfirmationRequest"/); return (await pool.query(sql, values)).rowCount; },
  };
  await pool.query(`CREATE TABLE "Student" (id text PRIMARY KEY, name text);
    CREATE TABLE "Enrollment" ("studentId" text, "classId" text, status text);
    CREATE TABLE "Payment" (id text PRIMARY KEY,"studentId" text,"classId" text,amount int,status text,type text,year int,month int,"dueDate" timestamptz,"paidDate" timestamptz,description text,"issuedAt" timestamptz);
    CREATE TABLE "PaymentInvoice" (id text PRIMARY KEY,"paymentId" text UNIQUE,"studentId" text,"classId" text,amount int,status text,title text,"invoiceNo" text,"issuedAt" timestamptz);
    CREATE TABLE "StaffPaymentConfirmationRequest" (id text PRIMARY KEY,"paymentId" text,"invoiceId" text,"classId" text,"studentId" text,"requestedByUserId" text,method text,amount int,"receivedAt" timestamptz,note text,status text,"createdAt" timestamptz,"updatedAt" timestamptz);
    CREATE UNIQUE INDEX unique_pending ON "StaffPaymentConfirmationRequest" ("paymentId") WHERE status='PENDING';
    CREATE TABLE "MonthlyEnrollmentRegister" ("studentId" text,month text,status text,payload jsonb);
    CREATE TABLE "SpecialProgramEnrollmentDate" (id text,"applicationItemId" text,status text);
    CREATE TABLE "SpecialProgramApplicationItem" (id text,"applicationId" text,status text,"tuitionPriceSnapshot" int,"siblingDiscountSnapshot" int,"priceSnapshot" int,"shuttleFeeSnapshot" int,"paymentId" text);
    CREATE TABLE "SpecialProgramApplication" (id text,"convertedStudentId" text);`);
  for (let i = 1; i <= 6; i++) {
    await pool.query('INSERT INTO "Student" VALUES ($1,$2)', [`student-${i}`, `검증 학생${i}`]);
    await pool.query('INSERT INTO "Enrollment" VALUES ($1,\'fixture-class\',\'ACTIVE\')', [`student-${i}`]);
  }
  const session = { id: 'fixture-session', classId: 'fixture-class', className: '검증 수업', startTime: '16:00', endTime: '17:00', location: '검증 체육관', studentCount: 6, status: 'IN_PROGRESS', plannedContent: null, content: null, notes: null, photos: [], startedAt: new Date().toISOString(), endedAt: null, sessionDateId: null };
  const roster = Array.from({ length: 6 }, (_, n) => ({ id: `student-${n + 1}`, studentId: `student-${n + 1}`, attendanceKey: `student-${n + 1}`, name: `검증 학생${n + 1}`, grade: null, phone: null, status: null, attendanceNote: null, arrivedAt: null, absenceReport: null }));
  const sessions = {
    async getStaffSessionDetail(id) { if (id !== session.id) throw new Error('담당 수업에만 접근할 수 있습니다.'); return session; },
    async getStaffSessionStudents(id, classId) { assert.equal(id, session.id); assert.equal(classId, session.classId); return roster; },
  };
  const accessScope = {
    async requireStaffClassAccess(classId) { if (classId !== session.classId) throw new Error('담당 수업 범위 밖'); },
    async requireStaffStudentAccess(classId, studentId) { if (classId !== session.classId || !roster.some(r => r.studentId === studentId)) throw new Error('담당 학생 범위 밖'); },
  };
  const policy = await loadSource('src/lib/staff-billing-policy.ts', {});
  const feePolicy = await loadSource('src/lib/staff-monthly-fee-policy.ts', {});
  const fees = await loadSource('src/lib/staff-monthly-fees.ts', { '@/lib/prisma': { prisma: database }, '@/lib/staff-session-queries': sessions, '@/lib/staff-class-access': accessScope, '@/lib/staff-billing-policy': policy, './staff-monthly-fee-policy': feePolicy });
  const legacy = await loadSource('src/lib/staff-class-billing.ts', { '@/lib/prisma': { prisma: database }, '@/lib/staff-class-access': accessScope, '@/lib/staff-billing-policy': policy });
  const actions = await loadSource('src/app/actions/staff-billing.ts', { 'next/cache': { revalidatePath() {} }, '@/lib/prisma': { prisma: database }, '@/lib/auth-guard': { async requireStaff() { return { appUserId: 'fixture-teacher' }; }, async requireAdmin() { throw new Error('관리자 승인 미실행'); } }, '@/lib/staff-class-access': accessScope, '@/lib/staff-billing-policy': policy, '@/lib/staff-class-billing': legacy, '@/lib/staff-monthly-fees': fees });
  const month = fees.staffFeeMonth(), [year, monthNumber] = month.split('-').map(Number);
  async function payment(id, studentId, amount, status, invoice, targetMonth = monthNumber, classId = session.classId) {
    await pool.query('INSERT INTO "Payment" VALUES($1,$2,$3,$4,$5,\'MONTHLY\',$6,$7,NOW()+interval \'5 day\',$8,$9,NOW()-interval \'1 hour\')', [id, studentId, classId, amount, status, year, targetMonth, status === 'PAID' ? new Date() : null, '검증 월 수강료']);
    if (invoice) await pool.query('INSERT INTO "PaymentInvoice" VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()-interval \'1 hour\')', [`invoice-${id}`, id, studentId, classId, amount, status === 'PAID' ? 'PAID' : 'ISSUED', targetMonth === monthNumber ? '당월 검증 청구' : '다른 월 검증 청구', `fixture-${id}`]);
  }
  await payment('pay-1', 'student-1', 120000, 'PENDING', true);
  await payment('pay-2', 'student-2', 110000, 'PAID', false);
  await payment('pay-old', 'student-1', 99000, 'PENDING', true, monthNumber === 1 ? 12 : monthNumber - 1);
  await payment('pay-other-class', 'student-1', 777777, 'PENDING', true, monthNumber, 'other-class');
  await payment('pay-unassigned', 'student-6', 80000, 'PENDING', false, monthNumber, null);
  for (const [id, base, discount] of [['student-3', 100000, 10000], ['student-5', 0, 0]]) {
    await pool.query('INSERT INTO "MonthlyEnrollmentRegister" VALUES($1,$2,\'CONFIRMED\',$3::jsonb)', [id, month, JSON.stringify({ studentId: id, month, classes: [{ classId: session.classId, status: 'ACTIVE', periodStart: `${month}-01`, periodEnd: `${month}-28`, baseAmount: base, discountAmount: discount, carryAmount: 0, prorationAmount: 0, basis: '합성 근거' }], shuttleAmount: 15000, shuttleBasis: '합성 셔틀', reason: '합성 검증' })]);
  }
  const confirmationCount = async () => Number((await pool.query('SELECT COUNT(*)::int AS count FROM "StaffPaymentConfirmationRequest"')).rows[0].count);
  await run('실제 SQL은 미발행 결제·확정 장부·0원·자료없음·반 미지정을 구분한다', async () => {
    const result = await actions.loadStaffSessionMonthlyFees({ sessionId: session.id });
    assert.equal(result.month, month); const by = Object.fromEntries(result.items.map(i => [i.rosterId, i]));
    assert.equal(by['student-1'].amount, 120000); assert.equal(by['student-1'].status, 'UNPAID');
    assert.equal(by['student-2'].amount, 110000); assert.equal(by['student-2'].status, 'PAID'); assert.match(by['student-2'].note, /미발행/);
    assert.equal(by['student-3'].amount, 90000); assert.equal(by['student-3'].status, 'UNISSUED');
    assert.equal(by['student-4'].amount, null); assert.equal(by['student-5'].amount, 0); assert.equal(by['student-6'].status, 'REVIEW');
    assert.equal(await confirmationCount(), 0);
  });
  await run('실제 상세 SQL은 현재 월·선택 학생의 청구만 반환한다', async () => {
    const result = await actions.loadStaffAttendanceBilling({ sessionId: session.id, rosterId: 'student-1' });
    assert.deepEqual(result.items.map(i => i.id), ['pay-1']); assert.equal(result.items[0].confirmable, true);
    await assert.rejects(actions.loadStaffAttendanceBilling({ sessionId: session.id, rosterId: 'foreign-student' }));
    await assert.rejects(actions.loadStaffSessionMonthlyFees({ sessionId: 'foreign-session' }));
    assert.equal(await confirmationCount(), 0);
  });

  const globals = await readFile('src/app/globals.css', 'utf8');
  const css = (await postcss([tailwind()]).process(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none); @source "./staff"; @source "../components/staff";'), { from: 'src/app/globals.css' })).css + await readFile('src/app/academy-theme.css', 'utf8');
  const proxy = name => `export async function ${name}(value){const r=await fetch('/fixture-action/${name}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});const body=await r.json();if(!r.ok)throw new Error(body.error||'격리 요청 실패');return body;}`;
  harness = await startStatusBrowserHarness({ css, mocks: {
    '@/app/actions/staff-billing': ['loadStaffSessionMonthlyFees', 'loadStaffAttendanceBilling', 'loadStaffClassBilling', 'requestStaffPaymentConfirmation'].map(proxy).join('\n'),
    '@/app/actions/staff-sessions': ['saveStaffAttendance', 'saveSessionMemo', 'completeClassSession', 'cancelClassSession'].map(proxy).join('\n'),
    '@/components/staff/SessionPhotoUploader': 'export function SessionPhotoUploader(){return null;}',
    '@/components/staff/VoiceToTextButton': 'export function VoiceToTextButton(){return null;}',
    '@/components/staff/ClassPeopleSheet': 'export function ClassPeopleSheet(){return null;}',
    // 격리 서버는 Next 청크 서버가 아니다. 실제 청구 컴포넌트를 정적 연결해 같은 UI를 검사한다.
    'next/dynamic': `import{ClassBillingSheet}from'@/components/staff/ClassBillingSheet';export default function dynamic(load){return String(load).includes('ClassBillingSheet')?ClassBillingSheet:function UnusedPeopleSheet(){return null}}`,
  }, entry: `import{createElement}from'react';import{createRoot}from'react-dom/client';import Session from '@/app/staff/sessions/[sessionId]/SessionInProgressClient';createRoot(document.getElementById('root')).render(createElement('div',{className:'academy-app',style:{minHeight:'100vh',padding:'8px 0'}},createElement(Session,window.__testProps)));` });
  browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const origin = new URL(harness.url).origin;
  async function screen(name, work, fault = '') {
    await run(name, async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
      const calls = [], errors = []; let failed = false;
      await context.addInitScript(value => { window.__testProps = value; }, { session, initialStudents: roster, initialView: 'attendance' });
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin !== origin) { errors.push('외부 요청 차단'); return route.abort(); }
        if (req.method() === 'GET' && ['/', '/bundle.js'].includes(url.pathname)) return route.continue();
        const actionName = url.pathname.split('/').at(-1), input = req.postDataJSON(); calls.push({ name: actionName, body: input });
        if (!failed && fault === actionName) { failed = true; return route.fulfill({ status: 503, json: { error: '합성 조회 실패' } }); }
        try {
          const result = actionName === 'saveStaffAttendance' ? { ok: true } : await actions[actionName](input);
          return route.fulfill({ json: result });
        } catch { return route.fulfill({ status: 400, json: { error: '검증 요청이 거부되었습니다.' } }); }
      });
      const page = await context.newPage(); page.setDefaultTimeout(7000); page.on('pageerror', e => errors.push(e.message));
      try { await page.goto(harness.url); await page.getByRole('heading', { name: '출석 확인', exact: true }).waitFor(); await work(page, calls); assert.deepEqual(errors, []); }
      finally { await context.close(); }
    });
  }
  const open = (page, n) => page.getByRole('button', { name: `검증 학생${n} 수강료·청구 확인`, exact: true }).click();
  const billing = page => page.getByRole('dialog', { name: /검증 학생\d 청구/ });
  await screen('출석 명단 → 실제 청구 창에서 당월 금액·청구만 확인한다', async page => {
    await page.getByRole('button', { name: '검증 학생1 수강료·청구 확인', exact: true }).filter({ hasText: '120,000원' }).waitFor(); await open(page, 1);
    await billing(page).getByText('당월 검증 청구', { exact: true }).waitFor();
    assert.equal(await page.getByText('다른 월 검증 청구', { exact: true }).count(), 0);
    assert.equal(await billing(page).getByRole('tab', { name: '전체', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await billing(page).getByRole('button', { name: '납부 확인 요청', exact: true }).isVisible(), true);
    await page.screenshot({ path: '.tmp/staff-fee-qa/billing-390.png', fullPage: true }); assert.equal(await confirmationCount(), 0);
  });
  await screen('청구서 없는 납부 기록도 금액·납부 완료와 미발행 근거를 보여준다', async page => {
    await open(page, 2); await billing(page).getByText('110,000원', { exact: true }).waitFor();
    assert.match(await billing(page).innerText(), /납부 완료/); assert.match(await billing(page).innerText(), /미발행/);
    assert.equal(await billing(page).getByRole('button', { name: '납부 확인 요청', exact: true }).count(), 0);
  });
  await screen('청구·결제 없는 학생도 확정 장부 차감 금액을 확인한다', async page => {
    await open(page, 3); await billing(page).getByText('90,000원', { exact: true }).waitFor();
    assert.match(await billing(page).innerText(), /확정 월 수강 장부/); assert.match(await billing(page).innerText(), /청구.*(미생성|미발행)/);
    assert.equal(await billing(page).getByRole('button', { name: '납부 확인 요청', exact: true }).count(), 0);
  });
  await screen('금액 근거 없는 학생을 0원이나 납부 완료로 표시하지 않는다', async page => {
    await open(page, 4); await billing(page).getByText('금액 미확인', { exact: true }).waitFor();
    assert.equal(await billing(page).getByText('0원', { exact: true }).count(), 0);
  });
  await screen('청구 창 조회 실패를 빈 목록으로 감추지 않고 재시도한다', async page => {
    await open(page, 1); await billing(page).getByRole('alert').waitFor();
    await billing(page).getByRole('button', { name: '청구 내역 다시 불러오기', exact: true }).click();
    await billing(page).getByText('당월 검증 청구', { exact: true }).waitFor();
  }, 'loadStaffAttendanceBilling');
  await screen('수강료 조회 실패 중에도 출석을 처리하고 금액 조회만 재시도한다', async (page, calls) => {
    await page.getByRole('button', { name: '수강료 다시 불러오기', exact: true }).waitFor();
    await page.getByRole('button', { name: '검증 학생1 출석', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="검증 학생1 출석"]').getAttribute('aria-pressed') === 'true');
    await page.getByRole('button', { name: '수강료 다시 불러오기', exact: true }).click();
    await page.getByRole('button', { name: '검증 학생1 수강료·청구 확인', exact: true }).filter({ hasText: '120,000원' }).waitFor(); assert.equal(calls.filter(c => c.name === 'saveStaffAttendance').length, 1);
  }, 'loadStaffSessionMonthlyFees');
  await screen('실제 납부 확인 요청 폼은 대기 원장만 만들고 납부 완료로 바꾸지 않는다', async page => {
    await open(page, 1); await billing(page).getByRole('button', { name: '납부 확인 요청', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '납부 확인 요청', exact: true });
    await dialog.getByRole('combobox').selectOption('CASH'); await dialog.getByRole('textbox').fill('합성 현장 인계');
    await dialog.getByRole('button', { name: '내용 확인 · 요청', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' }); await billing(page).getByText('관리자에게 납부 확인을 요청했습니다.', { exact: true }).waitFor();
    assert.equal(await confirmationCount(), 1);
    assert.equal((await pool.query('SELECT status FROM "Payment" WHERE id=\'pay-1\'')).rows[0].status, 'PENDING');
    assert.equal((await pool.query('SELECT status FROM "PaymentInvoice" WHERE id=\'invoice-pay-1\'')).rows[0].status, 'ISSUED');
    assert.equal((await actions.loadStaffSessionMonthlyFees({ sessionId: session.id })).items[0].status, 'PENDING_CONFIRMATION');
  });
  checks.push('새 클러스터 소유 경로·포트·데이터베이스 검증', '실제 원본 조회/요청 액션과 SQL 사용', '운영 URL·Prisma·Supabase 모듈 차단', '실제 ClassBillingSheet/BillingCard/PaymentRequestDialog 사용');
} finally {
  if (browser) await browser.close(); if (harness) await harness.close(); if (pool) await pool.end();
  if (started) await command('pg_ctl', ['stop', '-D', path.join(owned, 'data'), '-m', 'fast', '-w', '-t', '30']);
  await mkdir('.tmp/staff-fee-qa', { recursive: true });
  await writeFile('.tmp/staff-fee-qa/integration.json', JSON.stringify({ cases, passed: cases.filter(c => c.pass).length, checks, limits: ['수업 권한·명단 제공자와 인증 응답은 합성', '운영 DB·실제 결제·알림·배포 미실행', '임시 PostgreSQL의 최소 fixture 스키마이며 전체 운영 스키마 검증 아님'] }, null, 2));
}
assert.equal(cases.every(c => c.pass), true, JSON.stringify(cases.filter(c => !c.pass)));
