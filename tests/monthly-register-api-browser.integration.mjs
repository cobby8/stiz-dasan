import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect } from 'playwright/test';
import { startMonthlyRegisterHarness } from './helpers/monthly-register-browser-harness.mjs';
import { createMonthlyRegisterApiDbHarness } from './helpers/monthly-register-api-db-harness.mjs';

// 실제 UI·권한 판단·API·SQL을 연결한다. 인증 공급자 응답만 합성이며 실제 로그인 시험이 아니다.
const endpoint = '/api/admin/finance/monthly-register';
const month = '2026-10';
const formReason = /^이번 저장·확정·재열기 사유/;
const saveButton = '초안 저장 미리보기';
const roles = ['ADMIN', 'VICE_ADMIN', 'PARENT', 'INSTRUCTOR', 'DRIVER'];
const identity = role => ({ id: `auth-${role}`, email: `${role.toLowerCase()}@integration.invalid` });

function command(studentId = 'student-1', expectedVersion = 0) {
  const reason = '합성 통합 검사 저장';
  return { action: 'SAVE_DRAFT', studentId, month, expectedVersion, reason,
    payload: { studentId, month, reason, classes: ['class-1', 'class-2'].map(classId => ({
      classId, status: 'ACTIVE', periodStart: `${month}-01`, periodEnd: `${month}-28`,
      baseAmount: 100000, discountAmount: 10000, carryAmount: 5000, prorationAmount: 5000,
      basis: '합성 금액 근거',
    })), shuttleAmount: 10000, shuttleBasis: '합성 월 셔틀비 한 번' } };
}

async function fillDraft(page) {
  for (let index = 0; index < 2; index++) {
    await page.getByRole('combobox', { name: /^실제 등록 반 추가/ }).selectOption(`class-${index + 1}`);
    await page.getByRole('combobox', { name: /^이번 달 상태/ }).nth(index).selectOption('ACTIVE');
    await page.getByLabel('실제 시작일', { exact: true }).nth(index).fill(`${month}-01`);
    await page.getByLabel('실제 종료일', { exact: true }).nth(index).fill(`${month}-28`);
    for (const [label, value] of [['기본 수강료 (원)', '100000'], ['할인 차감 (원)', '10000'], ['이월 차감 (원)', '5000'], ['일할 차감 (원)', '5000']]) {
      await page.getByLabel(label, { exact: true }).nth(index).fill(value);
    }
    await page.getByRole('textbox', { name: /^금액·할인·이월·일할 근거/ }).nth(index).fill('합성 금액 근거');
  }
  await page.getByLabel('월 전체 셔틀비 — 한 번만 (원)', { exact: true }).fill('10000');
  await page.getByLabel('셔틀비 근거', { exact: true }).fill('합성 월 셔틀비 한 번');
  await page.getByLabel(formReason, { exact: true }).fill('합성 통합 검사 저장');
}

async function submitPreview(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('region', { name: '작업 미리보기' })).toBeVisible();
  await page.getByRole('button', { name: /^위 내용을 확인했고/ }).click();
}

export async function runMonthlyRegisterApiBrowserTests({ pool, database }) {
  const checks = [];
  let browser; let harness; let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    try { await browser?.close(); } finally { await harness?.close(); }
  })();
  const stop = () => { void cleanup(); };
  async function check(name, work) {
    await work(); checks.push(name); console.log(`PASS ${name}`);
  }
  const snapshot = async () => ({
    records: (await pool.query('SELECT * FROM "MonthlyEnrollmentRegister" ORDER BY id')).rows,
    revisions: (await pool.query('SELECT * FROM "MonthlyEnrollmentRegisterRevision" ORDER BY id')).rows,
  });
  async function unchanged(work) {
    const before = await snapshot(); await work(); assert.deepEqual(await snapshot(), before);
  }

  try {
    // 전달된 연결도 한 번 더 검사하고 정확한 격리 DB 이외에서는 DDL을 시작하지 않는다.
    const location = (await pool.query('SELECT current_database() AS db, host(inet_server_addr()) AS host, inet_server_port() AS port')).rows[0];
    assert.deepEqual(location, { db: 'stiz_monthly_register_test', host: '127.0.0.1', port: 55432 });
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM "MonthlyEnrollmentRegister" WHERE month = $1', [month])).rows[0].n, 0);
    await pool.query('CREATE TABLE "User" (id TEXT PRIMARY KEY, name TEXT, role TEXT NOT NULL, email TEXT NOT NULL UNIQUE)');
    await pool.query('ALTER TABLE "User" ENABLE ROW LEVEL SECURITY');
    await pool.query('REVOKE ALL ON TABLE "User" FROM PUBLIC, anon, authenticated');
    for (const role of roles) {
      await pool.query('INSERT INTO "User" (id,name,role,email) VALUES ($1,$2,$3,$4)',
        [`db-${role}`, `합성 ${role}`, role, identity(role).email]);
    }
    const originalUsers = (await pool.query('SELECT * FROM "User" ORDER BY id')).rows;
    const originalStudents = (await pool.query('SELECT * FROM "Student" ORDER BY id')).rows;
    const bridge = await createMonthlyRegisterApiDbHarness({ database });
    harness = await startMonthlyRegisterHarness();
    // NextURL은 loopback 주소를 localhost로 정규화한다. 브라우저도 같은 정식 호스트를
    // 사용해야 실제 Origin 검사를 통과한다. 서버 바인딩·DB 주소는 127.0.0.1 그대로다.
    const browserUrl = new URL(harness.url); browserUrl.hostname = 'localhost';
    harness.url = browserUrl.origin;
    const origin = new URL(harness.url).origin;
    const call = (method, { who = identity('ADMIN'), body = command(), headers = {}, writesEnabled = true, authMode = 'claims' } = {}) => {
      const url = `${origin}${endpoint}${method === 'GET' ? `?studentId=student-1&month=${month}` : ''}`;
      return bridge.handle(new Request(url, { method,
        headers: { origin, 'content-type': 'application/json', ...headers },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      }), { identity: who, writesEnabled, authMode });
    };

    for (const [label, who] of [
      ['익명', null], ...['PARENT', 'INSTRUCTOR', 'DRIVER'].map(role => [role, identity(role)]),
      ['DB 미등록 계정', identity('MISSING')],
      ['학부모 metadata ADMIN 조작', { ...identity('PARENT'), user_metadata: { role: 'ADMIN' }, app_metadata: { role: 'ADMIN' } }],
    ]) {
      await check(`${label}: 실제 권한 가드가 GET·POST 403 차단하고 DB 불변`, () => unchanged(async () => {
        for (const method of ['GET', 'POST']) {
          const response = await call(method, { who }); assert.equal(response.status, 403);
          assert.match(response.headers.get('cache-control'), /no-store/);
        }
      }));
    }
    for (const role of ['ADMIN', 'VICE_ADMIN']) {
      await check(`${role}: DB 역할 확인 후 실제 API 조회 200`, () => unchanged(async () => {
        const response = await call('GET', { who: identity(role) }); assert.equal(response.status, 200);
        const result = await response.json(); assert.equal(result.record, null); assert.equal(result.candidates.length, 2);
      }));
    }
    await check('getClaims 실패 시 getUser 대체 응답도 실제 DB 관리자 역할 검증', () => unchanged(async () => {
      assert.equal((await call('GET', { authMode: 'user' })).status, 200);
    }));
    await check('병렬 요청의 사용자·저장 플래그 격리 및 DB 불변', () => unchanged(async () => {
      const [locked, denied, enabledView, disabledView] = await Promise.all([
        call('POST', { who: identity('ADMIN'), writesEnabled: false }),
        call('POST', { who: identity('PARENT'), writesEnabled: true }),
        call('GET', { who: identity('ADMIN'), writesEnabled: true }),
        call('GET', { who: identity('VICE_ADMIN'), writesEnabled: false }),
      ]);
      assert.equal(locked.status, 503); assert.equal(denied.status, 403);
      assert.equal(enabledView.status, 200); assert.equal(disabledView.status, 200);
      assert.equal((await enabledView.json()).writesEnabled, true);
      assert.equal((await disabledView.json()).writesEnabled, false);
    }));
    for (const [label, options, status] of [
      ['저장 잠금', { writesEnabled: false }, 503],
      ['다른 Origin', { headers: { origin: 'https://blocked.invalid' } }, 403],
      ['cross-site 요청', { headers: { 'sec-fetch-site': 'cross-site' } }, 403],
      ['잘못된 요청 자료', { body: { ...command(), payload: {} } }, 400],
      ['JSON 외 형식', { headers: { 'content-type': 'text/plain' } }, 415],
    ]) {
      await check(`${label}: 실제 API ${status} 및 DB 불변`, () => unchanged(async () => {
        const response = await call('POST', options);
        assert.equal(response.status, status, await response.text());
      }));
    }
    await check('부원장 실제 API 저장 및 DB 사용자 ID로 감사 기록', async () => {
      const body = command('student-3');
      const response = await call('POST', { who: identity('VICE_ADMIN'), body });
      assert.equal(response.status, 200, await response.clone().text());
      const { record } = await response.json(); assert.equal(record.version, 1);
      assert.equal(record.totals.totalAmount, 170000);
      const saved = (await pool.query('SELECT version,payload,"updatedBy" FROM "MonthlyEnrollmentRegister" WHERE "studentId"=$1 AND month=$2', ['student-3', month])).rows;
      assert.deepEqual(saved, [{ version: 1, payload: body.payload, updatedBy: 'db-VICE_ADMIN' }]);
      const revisions = (await pool.query('SELECT version,action,"actorUserId",payload FROM "MonthlyEnrollmentRegisterRevision" WHERE "studentId"=$1 AND month=$2', ['student-3', month])).rows;
      assert.deepEqual(revisions, [{ version: 1, action: 'SAVE_DRAFT', actorUserId: 'db-VICE_ADMIN', payload: body.payload }]);
    });

    let executablePath;
    for (const candidate of [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
      try { await access(candidate); executablePath = candidate; break; } catch { /* 설치된 실행기만 사용 */ }
    }
    if (!executablePath) throw new Error('설치된 격리 브라우저 실행기가 없습니다.');
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20000,
      args: ['--no-proxy-server', '--disable-background-networking', '--disable-component-update'] });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);

    async function scenario(name, studentId, work) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
      const state = { gets: 0, posts: 0, loseNextPost: false, external: [], routeErrors: [] };
      await context.route('**/*', async route => {
        try {
          const request = route.request(); const url = new URL(request.url());
          if (url.origin !== origin) { state.external.push(url.origin); return await route.abort(); }
          if (url.pathname !== endpoint) {
            if (request.method() !== 'GET' || !['/', '/bundle.js', '/favicon.ico', '/admin/finance/monthly-register', '/admin/finance/monthly-ledger'].includes(url.pathname)) {
              state.external.push('UNEXPECTED_LOCAL_ROUTE'); return await route.abort();
            }
            return await route.continue();
          }
          const method = request.method(); assert.ok(['GET', 'POST'].includes(method));
          if (method === 'GET') state.gets++; else state.posts++;
          const response = await bridge.handle(new Request(request.url(), { method,
            headers: await request.allHeaders(), ...(method === 'POST' ? { body: request.postData() } : {}),
          }), { identity: identity('ADMIN'), writesEnabled: true });
          if (method === 'POST' && state.loseNextPost) {
            state.loseNextPost = false; assert.equal(response.status, 200); await response.arrayBuffer();
            return await route.abort('failed');
          }
          await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
        } catch (error) { state.routeErrors.push(error.message); await route.abort().catch(() => {}); }
      });
      const page = await context.newPage(); page.setDefaultTimeout(10000);
      const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
      try {
        await page.goto(`${harness.url}/?studentId=${studentId}&month=${month}`);
        await expect(page.getByText('저장된 장부 없음', { exact: true })).toBeVisible();
        await check(name, async () => {
          await work(page, state);
          assert.deepEqual(state.external, []); assert.deepEqual(state.routeErrors, []); assert.deepEqual(pageErrors, []);
        });
      } catch (error) {
        await page.screenshot({ path: path.join(harness.outputDir, `api-db-failed-${checks.length}.png`), fullPage: true }).catch(() => {});
        throw error;
      } finally { await context.close(); }
    }

    await scenario('실제 UI→권한→API→DB: 초안 저장·확정·재열기·170000원·감사 이력', 'student-1', async (page, state) => {
      await fillDraft(page);
      await submitPreview(page, saveButton);
      await expect(page.getByText('초안 · 버전 1', { exact: true })).toBeVisible();
      await page.getByLabel(formReason, { exact: true }).fill('합성 통합 확정');
      await submitPreview(page, '저장된 장부 확정 미리보기');
      await expect(page.getByText('확정 · 버전 2', { exact: true })).toBeVisible();
      await page.screenshot({ path: path.join(harness.outputDir, 'api-db-confirmed.png'), fullPage: true });
      await page.getByLabel(formReason, { exact: true }).fill('합성 통합 재열기');
      await submitPreview(page, '재열기 미리보기');
      await expect(page.getByText('초안 · 버전 3', { exact: true })).toBeVisible();
      await expect(page.getByText(/버전 2 · 확정 · .*합성 통합 확정/)).toBeVisible();
      assert.equal(state.posts, 3); assert.equal(state.gets, 4);
      const view = await (await call('GET')).json(); assert.equal(view.record.totals.totalAmount, 170000);
      const record = (await pool.query('SELECT * FROM "MonthlyEnrollmentRegister" WHERE "studentId"=$1 AND month=$2', ['student-1', month])).rows[0];
      assert.equal(record.version, 3); assert.equal(record.status, 'DRAFT'); assert.equal(record.updatedBy, 'db-ADMIN');
      const revisions = (await pool.query('SELECT version,action,"actorUserId",payload FROM "MonthlyEnrollmentRegisterRevision" WHERE "studentId"=$1 AND month=$2 ORDER BY version', ['student-1', month])).rows;
      assert.deepEqual(revisions.map(row => [row.version, row.action, row.actorUserId]), [[1, 'SAVE_DRAFT', 'db-ADMIN'], [2, 'CONFIRM', 'db-ADMIN'], [3, 'REOPEN', 'db-ADMIN']]);
      assert.deepEqual(record.payload, revisions[2].payload);
      assert.deepEqual(view.history.map(row => row.version), [3, 2, 1]);
      await page.screenshot({ path: path.join(harness.outputDir, 'api-db-reopened.png'), fullPage: true });
    });

    await check('오래된 버전 저장은 실제 서비스 409 및 전체 장부·이력 불변', () => unchanged(async () => {
      assert.equal((await call('POST', { body: command('student-1', 1) })).status, 409);
    }));

    await scenario('실제 DB 저장 후 응답 유실: 재조회 1회·버전 1·중복 저장 없음', 'student-2', async (page, state) => {
      await fillDraft(page); state.loseNextPost = true;
      await submitPreview(page, saveButton);
      await expect(page.getByRole('alert')).toContainText('자동 재시도하지 않습니다');
      assert.equal(state.posts, 1); assert.equal(state.gets, 1);
      await expect(page.getByRole('button', { name: saveButton, exact: true })).toBeDisabled();
      // 최초 저장의 응답을 잃으면 화면은 아직 편집 상태다. 사용자처럼 재조회 확인에
      // 명시적으로 동의해야 하며 Playwright의 기본 dialog dismiss에 맡기지 않는다.
      const confirmation = page.waitForEvent('dialog');
      const refresh = page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
      const dialog = await confirmation;
      assert.equal(dialog.type(), 'confirm');
      assert.match(dialog.message(), /저장하지 않은 편집을 버리고 다시 조회/);
      await dialog.accept(); await refresh;
      await expect(page.getByText('초안 · 버전 1', { exact: true })).toBeVisible();
      assert.equal(state.posts, 1); assert.equal(state.gets, 2);
      const saved = (await pool.query('SELECT version FROM "MonthlyEnrollmentRegister" WHERE "studentId"=$1 AND month=$2', ['student-2', month])).rows;
      assert.deepEqual(saved, [{ version: 1 }]);
      const revisions = (await pool.query('SELECT version,"actorUserId" FROM "MonthlyEnrollmentRegisterRevision" WHERE "studentId"=$1 AND month=$2', ['student-2', month])).rows;
      assert.deepEqual(revisions, [{ version: 1, actorUserId: 'db-ADMIN' }]);
      await page.screenshot({ path: path.join(harness.outputDir, 'api-db-response-recovered.png'), fullPage: true });
    });

    await check('합성 사용자 역할·기존 학생 원본 불변', async () => {
      assert.deepEqual((await pool.query('SELECT * FROM "User" ORDER BY id')).rows, originalUsers);
      assert.deepEqual((await pool.query('SELECT * FROM "Student" ORDER BY id')).rows, originalStudents);
    });
    const result = { passed: checks.length, checks, outputDir: harness.outputDir,
      scope: 'actual React UI / actual auth guard DB roles / actual API route and SQL / synthetic identity provider; no real Supabase login or Next.js HTTP server' };
    await writeFile(path.join(harness.outputDir, 'api-db-result.json'), JSON.stringify(result, null, 2));
    console.log(`격리 API·DB 브라우저 검증 결과: ${harness.outputDir}`);
    return result;
  } finally {
    await cleanup(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
