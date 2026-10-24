import assert from 'node:assert/strict';
import path from 'node:path';
import { expect } from 'playwright/test';

const endpoint = '/api/admin/finance/monthly-register';
const formReason = /^이번 저장·확정·재열기 사유/;
const saveButton = '초안 저장 미리보기';
const confirmButton = '저장된 장부 확정 미리보기';
const backLink = '월별·반별 장부 점검으로 돌아가기';
const stamp = '2026-09-04T00:00:00.000Z';
const candidates = [
  { classId: 'class-1', className: '가상 화요일반', status: 'ACTIVE' },
  { classId: 'class-2', className: '가상 목요일반', status: 'ACTIVE' },
];
const clone = value => structuredClone(value);
const key = (studentId, month) => JSON.stringify([studentId, month]);

function payload(studentId = 'student-1', month = '2026-09') {
  return { studentId, month, classes: candidates.map(({ classId }) => ({
    classId, status: 'ACTIVE', periodStart: `${month}-01`, periodEnd: `${month}-28`,
    baseAmount: 100000, discountAmount: 10000, carryAmount: 5000, prorationAmount: 5000,
    basis: '가상 수강료 근거',
  })), shuttleAmount: 10000, shuttleBasis: '가상 셔틀 월 1회', reason: '가상 초안 저장' };
}

// UI 응답 모형입니다. 운영 API·DB 검증으로 간주하지 않습니다.
function record(draft = payload(), version = 1, status = 'DRAFT') {
  const rows = draft.classes.map(row => ({ classId: row.classId,
    amount: row.baseAmount - row.discountAmount - row.carryAmount - row.prorationAmount }));
  const tuitionAmount = rows.reduce((sum, row) => sum + row.amount, 0);
  return { id: `synthetic-${draft.studentId}-${draft.month}`, studentId: draft.studentId, month: draft.month,
    version, status, payload: clone(draft), updatedAt: stamp, confirmedAt: status === 'CONFIRMED' ? stamp : null,
    totals: { rows, tuitionAmount, shuttleAmount: draft.shuttleAmount, totalAmount: tuitionAmount + draft.shuttleAmount } };
}

function fixtures({ seeded = false, writesEnabled = true, unknownClass = false, missingClass = false } = {}) {
  const records = new Map();
  if (seeded) {
    const draft = payload();
    if (unknownClass) draft.classes[0].classId = 'historical-class';
    if (missingClass) draft.classes.pop();
    records.set(key(draft.studentId, draft.month), record(draft));
  }
  return { records, histories: new Map(), writesEnabled, posts: [], gets: [], external: [],
    nextPostFailure: null, postDelay: 0, delayedStudent: null, getDelay: 500, mismatchNextGet: false,
    view(studentId, month) {
      const saved = records.get(key(studentId, month)) ?? null;
      return { studentName: '가상 동명이인', candidates: clone(candidates), record: clone(saved), writesEnabled: this.writesEnabled,
        history: clone(this.histories.get(key(studentId, month)) ?? (saved ? [{ version: saved.version, status: saved.status, reason: saved.payload.reason, createdAt: stamp }] : [])) };
    },
  };
}

async function connectFixture(context, baseUrl, state) {
  const origin = new URL(baseUrl).origin;
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // 다른 사이트 요청은 기록만 하고 차단합니다. 실제 운영 API는 호출할 수 없습니다.
    if (url.origin !== origin) { state.external.push(url.origin); return route.abort(); }
    if (url.pathname !== endpoint) {
      if (request.method() !== 'GET' || !['/', '/bundle.js', '/favicon.ico', '/admin/finance/monthly-register', '/admin/finance/monthly-ledger'].includes(url.pathname)) {
        state.external.push('UNEXPECTED_LOCAL_ROUTE'); return route.abort();
      }
      return route.continue();
    }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'GET') {
      const studentId = url.searchParams.get('studentId'); const month = url.searchParams.get('month');
      state.gets.push({ studentId, month });
      if (!['student-1', 'student-2'].includes(studentId) || !['2026-09', '2026-10'].includes(month)) return json({ error: '가상 대상 없음' }, 404);
      const body = state.view(studentId, month);
      if (state.delayedStudent === studentId) await new Promise(resolve => setTimeout(resolve, state.getDelay));
      if (state.mismatchNextGet) { state.mismatchNextGet = false; body.record = record(payload('student-2')); }
      return json(body);
    }
    if (request.method() !== 'POST') return json({ error: '지원하지 않는 가상 요청' }, 405);
    const body = request.postDataJSON(); state.posts.push(clone(body));
    if (state.postDelay) await new Promise(resolve => setTimeout(resolve, state.postDelay));
    const failure = state.nextPostFailure; state.nextPostFailure = null;
    if (failure === 'abort') return route.abort('failed');
    if (typeof failure === 'number') return json({ error: `가상 오류 ${failure}` }, failure);
    if (!state.writesEnabled) return json({ error: '저장 잠금' }, 503);
    assert.ok(['student-1', 'student-2'].includes(body.studentId));
    assert.ok(['2026-09', '2026-10'].includes(body.month));
    const target = key(body.studentId, body.month); const previous = state.records.get(target);
    if (body.expectedVersion !== (previous?.version ?? 0)) return json({ error: '버전 충돌' }, 409);
    assert.ok(['SAVE_DRAFT', 'CONFIRM', 'REOPEN'].includes(body.action));
    if (body.action !== 'SAVE_DRAFT') { assert.ok(previous); assert.equal(Object.hasOwn(body, 'payload'), false); }
    const draft = body.action === 'SAVE_DRAFT' ? body.payload : previous.payload;
    assert.equal(draft.studentId, body.studentId); assert.equal(draft.month, body.month);
    const saved = record(draft, body.expectedVersion + 1, body.action === 'CONFIRM' ? 'CONFIRMED' : 'DRAFT');
    const history = state.histories.get(target) ?? (previous ? [{ version: previous.version, status: previous.status, reason: previous.payload.reason, createdAt: stamp }] : []);
    state.histories.set(target, [{ version: saved.version, status: saved.status, reason: body.reason, createdAt: stamp }, ...history]);
    state.records.set(target, saved);
    if (failure === 'after-save') return route.abort('failed');
    return json(saved);
  });
}

async function fillDraft(page) {
  for (let index = 0; index < 2; index++) {
    await page.getByRole('combobox', { name: /^실제 등록 반 추가/ }).selectOption(`class-${index + 1}`);
    await page.getByRole('combobox', { name: /^이번 달 상태/ }).nth(index).selectOption('ACTIVE');
    await page.getByLabel('실제 시작일', { exact: true }).nth(index).fill('2026-09-01');
    await page.getByLabel('실제 종료일', { exact: true }).nth(index).fill('2026-09-28');
    for (const [label, value] of [['기본 수강료 (원)', '100000'], ['할인 차감 (원)', '10000'], ['이월 차감 (원)', '5000'], ['일할 차감 (원)', '5000']]) {
      await page.getByLabel(label, { exact: true }).nth(index).fill(value);
    }
    await page.getByRole('textbox', { name: /^금액·할인·이월·일할 근거/ }).nth(index).fill('가상 수강료 근거');
  }
  await page.getByLabel('월 전체 셔틀비 — 한 번만 (원)', { exact: true }).fill('10000');
  await page.getByLabel('셔틀비 근거', { exact: true }).fill('가상 셔틀 월 1회');
  await page.getByLabel(formReason, { exact: true }).fill('가상 초안 저장');
}

async function submitPreview(page, name) {
  await page.getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('region', { name: '작업 미리보기' })).toBeVisible();
  await page.getByRole('button', { name: /^위 내용을 확인했고/ }).click();
}

async function clickBackWithWarning(page, accept = false) {
  const dialogs = [];
  const handle = async dialog => {
    dialogs.push(dialog.type());
    if (accept) await dialog.accept(); else await dialog.dismiss();
  };
  page.on('dialog', handle);
  try {
    await page.getByRole('link', { name: backLink, exact: true }).click();
    if (accept) {
      await expect(page).toHaveURL(/\/admin\/finance\/monthly-ledger$/);
      await expect(page.getByRole('heading', { name: '격리 장부 목록', exact: true })).toBeVisible();
    }
    assert.deepEqual(dialogs, ['confirm'], '동일 창 링크는 확인창 한 번으로 이동 여부를 결정한다');
  } finally { page.off('dialog', handle); }
}

async function clickBackWithoutWarning(page) {
  const dialogs = [];
  const handle = async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); };
  page.on('dialog', handle);
  try {
    await page.getByRole('link', { name: backLink, exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/finance\/monthly-ledger$/);
    await expect(page.getByRole('heading', { name: '격리 장부 목록', exact: true })).toBeVisible();
    assert.deepEqual(dialogs, [], '검증된 저장 상태에서는 이탈 확인창이 없어야 한다');
  } finally { page.off('dialog', handle); }
}

async function reloadWithWarning(page, accept = false) {
  const pending = page.waitForEvent('dialog');
  // page.reload()의 취소 오류를 삼키지 않고, 실제 beforeunload 대화상자를 직접 검증한다.
  await page.evaluate(() => { setTimeout(() => window.location.reload(), 0); });
  const dialog = await pending;
  assert.equal(dialog.type(), 'beforeunload');
  if (accept) {
    const loaded = page.waitForEvent('domcontentloaded');
    await dialog.accept();
    await loaded;
  } else await dialog.dismiss();
}

export async function runMonthlyRegisterBrowserTests({ browser, url, outputDir }) {
  const checks = []; const findings = []; const observations = [];
  async function scenario(name, options, work) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, serviceWorkers: 'block' });
    const state = fixtures(options); const errors = [];
    await connectFixture(context, url, state);
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(`${url}/?studentId=student-1&month=2026-09`);
      await expect(page.getByRole('heading', { name: '가상 동명이인 · 2026-09', exact: true })).toBeVisible();
      await work(page, state, context);
      assert.deepEqual(state.external, [], '예상하지 않은 외부/로컬 경로 요청');
      assert.deepEqual(errors, [], '브라우저 실행 오류');
      checks.push(name); console.log(`PASS ${name}`);
    } catch (error) {
      await page.screenshot({ path: path.join(outputDir, `failed-${checks.length + 1}.png`), fullPage: true }).catch(() => {});
      throw new Error(`${name}: ${error.message}`, { cause: error });
    } finally { await context.close(); }
  }

  await scenario('새 반의 빈 상태·날짜·금액 유지 및 잘못된 입력 차단', {}, async (page, state) => {
    await page.getByRole('combobox', { name: /^실제 등록 반 추가/ }).selectOption('class-1');
    await expect(page.getByRole('combobox', { name: /^이번 달 상태/ })).toHaveValue('');
    for (const label of ['실제 시작일', '실제 종료일', '기본 수강료 (원)']) await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
    await page.getByLabel(formReason, { exact: true }).fill('필수 입력 검증');
    await page.getByRole('button', { name: saveButton, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('상태를 직접 선택');
    assert.equal(state.posts.length, 0);
  });

  await scenario('실제 화면 저장→확정→재열기·미리보기 취소·버전 이력', {}, async (page, state) => {
    await fillDraft(page);
    await expect(page.getByRole('button', { name: confirmButton, exact: true })).toBeDisabled();
    await page.getByRole('button', { name: saveButton, exact: true }).click();
    await expect(page.getByRole('region', { name: '작업 미리보기' })).toContainText('월 총액 170,000원');
    await expect(page.getByLabel('학생 ID', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('기본 수강료 (원)', { exact: true }).first()).toBeDisabled();
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await expect(page.getByLabel('기본 수강료 (원)', { exact: true }).first()).toHaveValue('100000');
    assert.equal(state.posts.length, 0);
    await submitPreview(page, saveButton);
    await expect(page.getByText('초안 · 버전 1', { exact: true })).toBeVisible();
    await page.getByLabel(formReason, { exact: true }).fill('가상 확정 확인');
    await submitPreview(page, confirmButton);
    await expect(page.getByText('확정 · 버전 2', { exact: true })).toBeVisible();
    await expect(page.getByLabel('기본 수강료 (원)', { exact: true }).first()).toBeDisabled();
    await page.screenshot({ path: path.join(outputDir, 'confirmed.png'), fullPage: true });
    await page.getByLabel(formReason, { exact: true }).fill('가상 재열기 확인');
    await submitPreview(page, '재열기 미리보기');
    await expect(page.getByText('초안 · 버전 3', { exact: true })).toBeVisible();
    await expect(page.getByLabel('기본 수강료 (원)', { exact: true }).first()).toBeEnabled();
    await expect(page.getByText(/버전 2 · 확정 · .*가상 확정 확인/)).toBeVisible();
    assert.deepEqual(state.posts.map(row => row.action), ['SAVE_DRAFT', 'CONFIRM', 'REOPEN']);
    assert.equal(state.records.get(key('student-1', '2026-09')).totals.totalAmount, 170000);
    await page.screenshot({ path: path.join(outputDir, 'reopened.png'), fullPage: true });
  });

  await scenario('미저장 편집·현재 등록 반 누락은 확정 차단', { seeded: true, missingClass: true }, async (page, state) => {
    await page.getByLabel(formReason, { exact: true }).fill('빠진 반 확인');
    await page.getByRole('button', { name: confirmButton, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('현재 등록 반이 빠져');
    await page.getByLabel('기본 수강료 (원)', { exact: true }).fill('110000');
    await expect(page.getByRole('button', { name: confirmButton, exact: true })).toBeDisabled();
    assert.equal(state.posts.length, 0);
  });

  await scenario('빠른 연속 클릭에도 POST 한 번·저장 중 입력 잠금', { seeded: true }, async (page, state) => {
    state.postDelay = 400;
    await page.getByLabel(formReason, { exact: true }).fill('중복 클릭 검사');
    await page.getByRole('button', { name: saveButton, exact: true }).click();
    const button = page.getByRole('button', { name: /^위 내용을 확인했고/ });
    await button.evaluate(element => { element.click(); element.click(); });
    await expect(page.getByLabel('학생 ID', { exact: true })).toBeDisabled();
    await expect(page.getByText('초안 · 버전 2', { exact: true })).toBeVisible();
    assert.equal(state.posts.length, 1);
  });

  for (const failure of [409, 500, 'abort']) {
    await scenario(`저장 실패 ${failure}: 자동 재시도 없이 재조회 전 잠금`, { seeded: true }, async (page, state) => {
      state.nextPostFailure = failure;
      await page.getByLabel(formReason, { exact: true }).fill('실패 검사');
      await submitPreview(page, saveButton);
      await expect(page.getByRole('alert')).toContainText('자동 재시도하지 않습니다');
      await expect(page.getByRole('button', { name: saveButton, exact: true })).toBeDisabled();
      await page.waitForTimeout(200);
      assert.equal(state.posts.length, 1);
      await clickBackWithWarning(page);
      await expect(page.getByText('초안 · 버전 1', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
      await expect(page.getByText('초안 · 버전 1', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: saveButton, exact: true })).toBeEnabled();
      assert.equal(state.posts.length, 1);
      await clickBackWithoutWarning(page);
    });
  }

  await scenario('저장 완료 후 응답만 유실: 재조회로 새 버전 확인·중복 저장 없음', { seeded: true }, async (page, state) => {
    state.nextPostFailure = 'after-save';
    await page.getByLabel(formReason).fill('응답 유실 확인');
    await submitPreview(page, saveButton);
    await expect(page.getByRole('alert')).toContainText('자동 재시도하지 않습니다');
    await expect(page.getByRole('button', { name: saveButton, exact: true })).toBeDisabled();
    assert.equal(state.records.get(key('student-1', '2026-09')).version, 2);
    await clickBackWithWarning(page);
    await page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
    await expect(page.getByText('초안 · 버전 2', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: saveButton, exact: true })).toBeEnabled();
    assert.equal(state.posts.length, 1);
    await clickBackWithoutWarning(page);
  });

  await scenario('동명이인·학생/월 변경·편집 폐기 취소를 ID로 구분', { seeded: true }, async (page, state) => {
    await page.getByLabel('기본 수강료 (원)', { exact: true }).first().fill('111000');
    await page.getByLabel('학생 ID', { exact: true }).fill('student-2');
    await expect(page.getByRole('button', { name: saveButton, exact: true })).toHaveCount(0);
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
    await page.getByLabel('학생 ID', { exact: true }).fill('student-1');
    await expect(page.getByLabel('기본 수강료 (원)', { exact: true }).first()).toHaveValue('111000');
    await page.getByLabel('학생 ID', { exact: true }).fill('student-2');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
    await expect(page.getByText('학생 ID: student-2', { exact: true })).toBeVisible();
    await expect(page.getByText('저장된 장부 없음', { exact: true })).toBeVisible();
    await page.getByLabel('적용 월', { exact: true }).fill('2026-10');
    await page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
    await expect(page.getByRole('heading', { name: '가상 동명이인 · 2026-10', exact: true })).toBeVisible();
    assert.equal(state.posts.length, 0);
    assert.deepEqual(state.gets.at(-1), { studentId: 'student-2', month: '2026-10' });
  });

  await scenario('조회 중 학생 입력이 바뀌면 이전 응답으로 저장 불가', { seeded: true }, async (page, state) => {
    state.delayedStudent = 'student-1';
    await page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
    await page.getByLabel('학생 ID', { exact: true }).fill('student-2');
    await expect(page.getByRole('button', { name: '조회 / 새로고침', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: saveButton, exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
    await expect(page.getByText('학생 ID: student-2', { exact: true })).toBeVisible();
    assert.equal(state.posts.length, 0);
  });

  for (const [name, options] of [['서버 저장 off', { seeded: true, writesEnabled: false }], ['미등록 과거 반', { seeded: true, unknownClass: true }]]) {
    await scenario(`${name}: 조회만 허용하고 저장·확정 차단`, options, async (page, state) => {
      await expect(page.getByRole('button', { name: saveButton, exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: confirmButton, exact: true })).toBeDisabled();
      await expect(page.getByLabel('기본 수강료 (원)', { exact: true }).first()).toBeDisabled();
      assert.equal(state.posts.length, 0);
    });
  }

  await scenario('조회 응답 학생 ID 불일치는 장부 표시 차단', { seeded: true }, async (page, state) => {
    state.mismatchNextGet = true;
    await page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('조회 대상과 반환된 장부가 다릅니다');
    await expect(page.getByRole('button', { name: saveButton, exact: true })).toHaveCount(0);
    assert.equal(state.posts.length, 0);
  });

  await scenario('미저장 새로고침 경고: 취소는 편집 유지·승인은 저장값 복원', { seeded: true }, async (page, state) => {
    await page.getByLabel('기본 수강료 (원)', { exact: true }).first().fill('123456');
    await reloadWithWarning(page);
    await expect(page.getByLabel('기본 수강료 (원)', { exact: true }).first()).toHaveValue('123456');
    await reloadWithWarning(page, true);
    await expect(page.getByLabel('기본 수강료 (원)', { exact: true }).first()).toHaveValue('100000');
    assert.equal(state.posts.length, 0);
  });

  await scenario('미저장 동일 창 링크: 취소는 편집 유지·승인은 점검표 이동', { seeded: true }, async (page, state) => {
    await page.getByLabel('기본 수강료 (원)', { exact: true }).first().fill('123456');
    await clickBackWithWarning(page);
    await expect(page.getByLabel('기본 수강료 (원)', { exact: true }).first()).toHaveValue('123456');
    await clickBackWithWarning(page, true);
    assert.equal(state.posts.length, 0);
  });

  await scenario('미편집 장부는 확인창 없이 점검표 이동', { seeded: true }, async (page, state) => {
    await clickBackWithoutWarning(page);
    assert.equal(state.posts.length, 0);
  });

  await scenario('사유만 입력·미리보기 상태도 이탈 경고하고 취소 시 유지', { seeded: true }, async (page, state) => {
    await page.getByLabel(formReason).fill('사유만 변경');
    await clickBackWithWarning(page);
    await expect(page.getByLabel(formReason)).toHaveValue('사유만 변경');
    await reloadWithWarning(page);
    await page.getByRole('button', { name: saveButton, exact: true }).click();
    await clickBackWithWarning(page);
    await expect(page.getByRole('region', { name: '작업 미리보기' })).toBeVisible();
    await reloadWithWarning(page);
    await expect(page.getByRole('region', { name: '작업 미리보기' })).toBeVisible();
    assert.equal(state.posts.length, 0);
  });

  await scenario('저장·결과 재조회 중 링크 이동 차단 후 검증 완료 시 해제', { seeded: true }, async (page, state) => {
    state.postDelay = 1500;
    state.delayedStudent = 'student-1';
    state.getDelay = 1500;
    await page.getByLabel(formReason).fill('저장 중 이동 검사');
    await page.getByRole('button', { name: saveButton, exact: true }).click();
    // 같은 이벤트 턴의 링크 클릭까지 검사해 React 상태 반영 전 빈틈을 확인한다.
    await page.getByRole('button', { name: /^위 내용을 확인했고/ }).evaluate(element => {
      element.click();
      document.querySelector('a[href="/admin/finance/monthly-ledger"]').click();
    });
    await expect(page.getByRole('alert')).toContainText('저장');
    await expect(page.getByRole('alert')).toContainText('이동');
    await expect(page.getByLabel('학생 ID', { exact: true })).toBeDisabled();
    await reloadWithWarning(page);
    await expect(page.getByRole('heading', { name: '가상 동명이인 · 2026-09', exact: true })).toBeVisible();
    await expect.poll(() => state.gets.length).toBe(2);
    await expect(page.getByText('장부를 조회하고 있습니다.', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: backLink, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('이동');
    await expect(page.getByText('초안 · 버전 2', { exact: true })).toBeVisible();
    assert.equal(state.posts.length, 1);
    await clickBackWithoutWarning(page);
  });

  await scenario('저장 후 다른 학생 응답이면 사유 초기화 뒤에도 재조회 전 이탈 경고', { seeded: true }, async (page, state) => {
    state.mismatchNextGet = true;
    await page.getByLabel(formReason).fill('결과 검증 실패');
    await submitPreview(page, saveButton);
    await expect(page.getByRole('alert')).toContainText('조회 대상과 반환된 장부가 다릅니다');
    await clickBackWithWarning(page);
    await reloadWithWarning(page);
    await expect(page.getByRole('alert')).toContainText('조회 대상과 반환된 장부가 다릅니다');
    await page.getByRole('button', { name: '조회 / 새로고침', exact: true }).click();
    await expect(page.getByText('초안 · 버전 2', { exact: true })).toBeVisible();
    assert.equal(state.posts.length, 1);
    await clickBackWithoutWarning(page);
  });
  return { checks, findings, observations };
}
