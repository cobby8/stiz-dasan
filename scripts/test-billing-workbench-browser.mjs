import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

// 실제 TSX·CSS를 실행하되 운영 API·인증·DB·외부 통신은 포함하지 않는다.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, '.tmp/billing-workbench-browser');
await mkdir(evidence, { recursive: true });
const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
const academy = await readFile(path.join(root, 'src/app/academy-theme.css'), 'utf8');
const css = (await postcss([tailwind()]).process(globals, { from: path.join(root, 'src/app/globals.css') })).css + academy;
const actionNames = ['createPayment', 'cancelUnpaidPayment', 'updatePaymentStatus', 'deletePayment', 'previewMonthlyInvoices', 'generateMonthlyInvoices', 'refreshPaymentLedger', 'sendInvoiceLinksForMonth', 'sendUnpaidReminders', 'bulkUpdatePaymentStatus', 'markTerminalPaymentPaid'];
const harness = await startStatusBrowserHarness({
  css,
  mocks: {
    'next/navigation': `export function useSearchParams(){return new URLSearchParams(location.search)};`,
    '@/app/actions/admin': actionNames.map(name => `export async function ${name}(){throw new Error('격리 검사에서 실제 저장 호출 금지')}`).join('\n'),
  },
  entry: `import {createElement} from 'react';import {createRoot} from 'react-dom/client';
import Workbench from '@/app/admin/finance/prepare/BillingWorkbench';import Finance from '@/app/admin/finance/FinanceClient';
document.body.className='academy-app';document.getElementById('root').style.padding='12px';
const query=new URLSearchParams(location.search);createRoot(document.getElementById('root')).render(createElement(query.get('screen')==='finance'?Finance:Workbench,window.__testProps||{}));`,
});
let browser;
const cases = [];
const json = (route, value, status = 200) => route.fulfill({ status, json: value });
const row = (overrides = {}) => ({ id: 'test-child:test-class', studentId: 'test-child', studentName: '검사용 학생', classId: 'test-class', className: '검사용 주중반', status: 'READY', baseAmount: 100000, discountAmount: 10000, prorationAmount: 0, carryAmount: 0, shuttleAmount: 10000, totalAmount: 100000, reviewReasons: [], blockingReasons: [], basis: ['연간 일정 4회', '할인 후 수강료 90,000원'], version: 0, draftStatus: null, paymentId: null, dueDate: '2026-09-30', periodStart: '2026-10-01', periodEnd: '2026-10-31', scheduledDates: ['2026-10-06', '2026-10-13', '2026-10-20', '2026-10-27'], carryAvailable: 20000, remainingCarry: 20000, ...overrides });
const view = (overrides = {}) => ({ month: '2026-10', sourceVersion: 'a'.repeat(64), writesEnabled: true, storageReady: true, rows: [row()], absences: [], notices: [], carrySettlementReady: true, summary: {}, ...overrides });
async function screen({ width = 360, fixture = view(), respond, screen = '', props = {}, studentId = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const errors = [], external = [], calls = [];
  let state = structuredClone(fixture);
  await context.addInitScript(value => { window.__testProps = value; }, props);
  const origin = new URL(harness.url).origin;
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
    if (req.method() === 'GET' && ['/', '/bundle.js'].includes(url.pathname)) return route.continue();
    if (req.method() === 'GET' && url.pathname === '/api/admin/student-options') return json(route, { students: [] });
    if (url.pathname !== '/api/admin/billing-workbench') { errors.push(`예상하지 않은 경로 ${url.pathname}`); return route.abort(); }
    const call = { method: req.method(), body: req.method() === 'POST' ? req.postDataJSON() : null, month: url.searchParams.get('month') };
    calls.push(call);
    if (respond) { const handled = await respond(route, call, state); if (handled) return; }
    if (req.method() === 'GET') return json(route, { ...state, month: call.month });
    const ids = new Set(call.body.rows?.map(item => item.id));
    state.rows = state.rows.map(item => {
      if (!ids.has(item.id)) return item;
      const edit = call.body.rows.find(value => value.id === item.id);
      if (call.body.action === 'SAVE') return { ...item, ...edit, version: item.version + 1, draftStatus: 'DRAFT', status: 'READY', reviewReasons: [], totalAmount: edit.baseAmount - edit.discountAmount - edit.prorationAmount - edit.carryAmount + edit.shuttleAmount };
      return { ...item, version: item.version + 1, draftStatus: call.body.action === 'CONFIRM' ? 'CONFIRMED' : 'ISSUED', status: call.body.action === 'CONFIRM' ? 'READY' : 'ISSUED' };
    });
    return json(route, { view: state, operationResult: { action: call.body.action, paymentIds: call.body.action === 'ISSUE' ? ['test-payment'] : [], zeroCount: 0 } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message)); page.on('dialog', dialog => dialog.accept());
  await page.goto(`${harness.url}/?month=2026-10${screen ? `&screen=${screen}` : ''}${studentId ? `&studentId=${studentId}` : ''}`);
  await page.getByRole('heading', { name: screen === 'finance' ? '수납/결제 관리' : '이번 달 청구 준비', exact: true }).waitFor();
  if (!screen) await page.getByRole('button', { name: '검색 결과 선택', exact: true }).waitFor({ state: 'visible' });
  return { page, calls, context, async close() { try { assert.deepEqual(errors, []); assert.deepEqual(external, []); } finally { await context.close(); } } };
}
async function check(name, exercise) {
  try { await exercise(); cases.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, pass: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
const select = page => page.getByRole('button', { name: '검색 결과 선택', exact: true }).click();
const save = page => page.getByRole('button', { name: '선택 검토 저장', exact: true }).click();
const openDetails = page => page.getByRole('button', { name: /검토 가능 · 근거|확인 필요 · 근거|발행 보류 · 근거/ }).first().click();
try {
  browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  for (const width of [320, 360, 768, 1440]) await check(`${width}px 실제 화면 경계·기간 정렬`, async () => {
    const s = await screen({ width });
    try {
      await s.page.getByText('검사용 학생', { exact: true }).filter({ visible: true }).waitFor();
      const measure = await s.page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, label: [...document.querySelectorAll('label span')].find(item => item.textContent === '청구 기간')?.getBoundingClientRect().height }));
      assert.ok(measure.scroll <= measure.width + 1); assert.ok(measure.label < 30, '기간 라벨은 한 줄');
      await s.page.screenshot({ path: path.join(evidence, `workbench-${width}.png`), fullPage: true });
      if (width < 768) {
        await openDetails(s.page);
        assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '수강 기간·금액 편집을 펼쳐도 화면 넘침 없음');
        const fields = await s.page.locator('input[type=date]:visible').evaluateAll(inputs => inputs.map(input => ({ width: input.getBoundingClientRect().width, right: input.getBoundingClientRect().right, height: input.getBoundingClientRect().height })));
        assert.ok(fields.every(field => field.width >= 44 && field.height >= 44 && field.right <= width + 1));
        await s.page.screenshot({ path: path.join(evidence, `workbench-${width}-expanded.png`), fullPage: true });
      }
    } finally { await s.close(); }
  });
  await check('기본 발행 대상에서 기존 발행·제외 숨김과 전체 이력 전환', async () => {
    const s = await screen({ fixture: view({ rows: [row(), row({ id: 'issued:class', studentId: 'issued', studentName: '발행이력 검사', status: 'ISSUED', draftStatus: 'ISSUED', paymentId: 'old-payment' }), row({ id: 'excluded:class', studentId: 'excluded', studentName: '제외이력 검사', status: 'EXCLUDED' })] }) }); try {
      await s.page.getByText('검사용 학생', { exact: true }).filter({ visible: true }).waitFor();
      for (const name of ['발행이력 검사', '제외이력 검사']) assert.equal(await s.page.getByText(name, { exact: true }).filter({ visible: true }).count(), 0);
      await s.page.locator('summary').filter({ hasText: '필터' }).click();
      const stateFilter = s.page.locator('details select').first(); assert.equal(await stateFilter.inputValue(), 'UNISSUED');
      await stateFilter.selectOption('ALL');
      for (const name of ['발행이력 검사', '제외이력 검사']) await s.page.getByText(name, { exact: true }).filter({ visible: true }).waitFor();
      assert.ok(await s.page.getByRole('checkbox', { name: '발행이력 검사 검사용 주중반 선택', exact: true }).filter({ visible: true }).isDisabled());
      await s.page.getByRole('button', { name: '기본 조건으로', exact: true }).click(); assert.equal(await stateFilter.inputValue(), 'UNISSUED');
      for (const name of ['발행이력 검사', '제외이력 검사']) assert.equal(await s.page.getByText(name, { exact: true }).filter({ visible: true }).count(), 0);
      assert.equal(s.calls.filter(call => call.method === 'POST').length, 0);
    } finally { await s.close(); }
  });
  await check('검토 저장→확정→사이트 발행·전달 구분', async () => {
    const s = await screen(); try {
      await select(s.page); await save(s.page); await s.page.getByRole('status').waitFor();
      await s.page.getByRole('button', { name: '선택 청구 확정', exact: true }).click();
      await s.page.getByText('납부기한 2026-09-30', { exact: true }).waitFor();
      await s.page.getByRole('button', { name: '위 내역 확정', exact: true }).click();
      await s.page.getByRole('button', { name: '선택 일괄 발행', exact: true }).click();
      await s.page.getByRole('button', { name: '위 내역으로 사이트 발행', exact: true }).click();
      await s.page.getByRole('status').filter({ hasText: /랠리즈 발행과 학부모 전달은 별도 확인/ }).waitFor();
      assert.deepEqual(s.calls.filter(call => call.method === 'POST').map(call => call.body.action), ['SAVE', 'CONFIRM', 'ISSUE']);
    } finally { await s.close(); }
  });
  await check('금액·사유 수정과 학부모 내역 연결', async () => {
    const s = await screen(); try {
      await openDetails(s.page); await s.page.getByRole('spinbutton', { name: '검사용 학생 할인', exact: true }).filter({ visible: true }).fill('20000');
      await s.page.getByRole('textbox', { name: '검사용 학생 검토·수정 사유', exact: true }).filter({ visible: true }).fill('할인 확인');
      await s.page.getByRole('button', { name: '학부모 청구 내역 미리보기', exact: true }).filter({ visible: true }).click();
      assert.match(await s.page.getByRole('dialog').innerText(), /90,000원/);
      await s.page.getByRole('button', { name: '닫기', exact: true }).click(); await save(s.page); await s.page.getByRole('status').waitFor();
      assert.equal(s.calls.find(call => call.method === 'POST').body.rows[0].discountAmount, 20000);
    } finally { await s.close(); }
  });
  await check('월중 수강 기간과 차감액을 함께 저장', async () => {
    const s = await screen(); try {
      await openDetails(s.page);
      await s.page.getByLabel('검사용 학생 수강 시작일', { exact: true }).filter({ visible: true }).fill('2026-10-13');
      await s.page.getByRole('spinbutton', { name: '검사용 학생 기간 조정', exact: true }).filter({ visible: true }).fill('22500');
      await s.page.getByRole('textbox', { name: '검사용 학생 검토·수정 사유', exact: true }).filter({ visible: true }).fill('월중 시작 3회 확인');
      await save(s.page); await s.page.getByRole('status').waitFor();
      const edit = s.calls.find(call => call.method === 'POST').body.rows[0];
      assert.equal(edit.periodStart, '2026-10-13'); assert.equal(edit.periodEnd, '2026-10-31'); assert.equal(edit.prorationAmount, 22500);
    } finally { await s.close(); }
  });
  await check('읽기 전용은 실제 저장·확정·발행 차단', async () => {
    const s = await screen({ fixture: view({ writesEnabled: false }) }); try { await select(s.page); for (const name of ['선택 검토 저장', '선택 청구 확정', '선택 일괄 발행']) assert.ok(await s.page.getByRole('button', { name, exact: true }).isDisabled()); assert.equal(s.calls.filter(call => call.method === 'POST').length, 0); } finally { await s.close(); }
  });
  await check('원본 충돌은 입력 보존·확정 발행 차단', async () => {
    const s = await screen({ respond: async (route, call) => call.method === 'POST' ? (await json(route, { error: '원본 자료가 변경됐습니다.', refreshRequired: true }, 409), true) : false }); try {
      await openDetails(s.page); await s.page.getByRole('textbox', { name: '검사용 학생 검토·수정 사유', exact: true }).filter({ visible: true }).fill('보존할 사유'); await save(s.page); await s.page.getByRole('alert').waitFor();
      assert.equal(await s.page.getByRole('textbox', { name: '검사용 학생 검토·수정 사유', exact: true }).filter({ visible: true }).inputValue(), '보존할 사유'); assert.ok(await s.page.getByRole('button', { name: '선택 청구 확정', exact: true }).isDisabled());
    } finally { await s.close(); }
  });
  await check('서버 보류 안내·행 보류 근거 실제 표시', async () => {
    const s = await screen({ fixture: view({ notices: ['기존 특강 이월은 대조 후 처리합니다.'], rows: [row({ blockingReasons: ['수업일 확인 필요'], draftStatus: 'DRAFT', status: 'REVIEW' })] }) }); try {
      await s.page.getByText('기존 특강 이월은 대조 후 처리합니다.', { exact: true }).waitFor(); await select(s.page); assert.ok(await s.page.getByRole('button', { name: '선택 청구 확정', exact: true }).isDisabled()); await openDetails(s.page); await s.page.getByText('확정·발행 보류', { exact: true }).filter({ visible: true }).waitFor();
    } finally { await s.close(); }
  });
  await check('월 변경 시 이전 성공 안내 제거', async () => {
    const s = await screen(); try { await select(s.page); await save(s.page); await s.page.getByRole('status').waitFor(); await s.page.getByLabel('청구 기간', { exact: true }).fill('2026-11'); await s.page.getByText('검사용 학생', { exact: true }).filter({ visible: true }).waitFor(); assert.equal(await s.page.getByRole('status').count(), 0); } finally { await s.close(); }
  });
  await check('응답 유실 재시도는 동일 요청 번호 유지', async () => {
    const s = await screen({ respond: async (route, call) => call.method === 'POST' ? (await route.abort(), true) : false }); try { await select(s.page); await save(s.page); await s.page.getByRole('alert').waitFor(); await save(s.page); await s.page.getByRole('alert').waitFor(); const posts = s.calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 2); assert.equal(posts[0].body.requestId, posts[1].body.requestId); } finally { await s.close(); }
  });
  const absence = { id: 'test-absence', studentId: 'test-child', studentName: '검사용 학생', classId: 'test-class', date: '2026-10-06', reason: 'ILLNESS_INJURY', status: 'CONFIRMED', makeupStatus: 'RESERVED', resolution: null, reviewReasons: ['처리 선택 필요'] };
  for (const scenario of [
    { name: '질병·부상은 이월 검토 추천·증빙 자동확인 금지', reasons: ['ILLNESS_INJURY'], makeupStatus: null, expected: 'CARRY', text: '이월 검토 추천' },
    { name: '개인 사정·가족 여행은 보강 추천', reasons: ['PERSONAL', 'FAMILY_TRIP'], makeupStatus: null, expected: 'MAKEUP', text: '보강 추천' },
    { name: '보강 사용·참석·노쇼는 이월 자동 추천 금지', reasons: ['ILLNESS_INJURY'], statuses: ['USED', 'ATTENDED', 'NO_SHOW'], expected: 'MAKEUP', text: '보강 추천' },
  ]) await check(scenario.name, async () => {
    for (const reason of scenario.reasons) for (const makeupStatus of scenario.statuses ?? [scenario.makeupStatus]) {
      const s = await screen({ fixture: view({ absences: [{ ...absence, reason, makeupStatus }] }) }); try {
        await openDetails(s.page);
        await s.page.getByText(new RegExp(scenario.text)).filter({ visible: true }).waitFor();
        await s.page.getByRole('button', { name: '이월·보강 검토', exact: true }).filter({ visible: true }).click();
        const dialog = s.page.getByRole('dialog');
        assert.equal(await dialog.getByLabel('처리 방식', { exact: true }).inputValue(), scenario.expected);
        if (scenario.expected === 'MAKEUP') await dialog.getByLabel('처리 방식', { exact: true }).selectOption('CARRY');
        assert.equal(await dialog.getByLabel('인정 사유와 증빙을 확인했습니다.', { exact: true }).isChecked(), false);
        assert.equal(await dialog.getByLabel('인정 사유', { exact: true }).inputValue(), reason === 'ILLNESS_INJURY' ? 'ILLNESS_INJURY' : 'NONE');
        await dialog.locator('textarea').fill('검토 사유 입력');
        assert.ok(await dialog.getByRole('button', { name: '위 내용으로 결석 처리', exact: true }).isDisabled(), '증빙 미확인 상태는 자동 이월 불가');
        assert.equal(s.calls.filter(call => call.method === 'POST').length, 0);
      } finally { await s.close(); }
    }
  });
  await check('이월 모달 업무 검증 오류 후 입력 수정·재시도', async () => {
    const s = await screen({ fixture: view({ absences: [absence] }), respond: async (route, call) => call.method === 'POST' ? (await json(route, { error: '원기간 확정 근거를 확인해주세요.', refreshRequired: false }, 409), true) : false }); try {
      await openDetails(s.page); await s.page.getByRole('button', { name: '이월·보강 검토', exact: true }).filter({ visible: true }).click(); const dialog = s.page.getByRole('dialog');
      await dialog.getByLabel('인정 사유', { exact: true }).selectOption('ILLNESS_INJURY'); await dialog.getByLabel('인정 사유와 증빙을 확인했습니다.', { exact: true }).check(); await dialog.getByLabel('연결된 보강 예약 취소·좌석 해제에 동의합니다.', { exact: true }).check(); await dialog.locator('textarea').fill('증빙 검토'); await dialog.getByRole('button', { name: '위 내용으로 결석 처리', exact: true }).click(); await dialog.getByRole('alert').waitFor();
      assert.equal(await dialog.locator('textarea').inputValue(), '증빙 검토'); assert.ok(await dialog.getByLabel('원결석 청구 기간', { exact: true }).isEnabled()); await dialog.getByLabel('원결석 청구 기간', { exact: true }).fill('2026-09'); await dialog.getByRole('button', { name: '위 내용으로 결석 처리', exact: true }).click(); assert.equal(s.calls.filter(call => call.method === 'POST').length, 2);
    } finally { await s.close(); }
  });
  const payment = (id, studentId, studentName, classId, className, status) => ({ id, studentId, studentName, classId, className, status, amount: 100000, dueDate: '2026-10-01', paidDate: status === 'PAID' ? '2026-10-02' : null, type: 'MONTHLY', description: null, month: 10, year: 2026, autoGenerated: false, notifiedAt: null, createdAt: '2026-09-30' });
  const financeProps = { initialYear: 2026, initialMonth: 10, currentAdminRole: 'ADMIN', sheetRetired: true, initialPayments: [payment('p-a', 'child-a', '검색검사 원생가', 'class-a', '검색검사 월요반', 'PENDING'), payment('p-b', 'child-b', '검색검사 원생나', 'class-b', '검색검사 화요반', 'OVERDUE'), payment('p-c', 'child-a', '검색검사 원생가', 'class-a', '검색검사 월요반', 'PAID')], initialSummary: { totalCount: 3, totalAmount: 300000, paidAmount: 100000, unpaidAmount: 200000, paidCount: 1, unpaidCount: 2 } };
  await check('실제 수납 검색·납부상태·반 필터 결합', async () => {
    const s = await screen({ screen: 'finance', props: financeProps }); try {
      const bodyRows = s.page.locator('tbody tr'); assert.equal(await bodyRows.count(), 3);
      await s.page.getByRole('textbox', { name: '학생·반·내용 검색', exact: true }).fill('원생나'); assert.equal(await bodyRows.count(), 1);
      await s.page.getByRole('textbox', { name: '학생·반·내용 검색', exact: true }).fill('');
      await s.page.locator('summary').filter({ hasText: '필터' }).click();
      await s.page.getByLabel('납부 상태 필터', { exact: true }).selectOption('UNPAID'); assert.equal(await bodyRows.count(), 2);
      await s.page.getByLabel('반 필터', { exact: true }).selectOption('class-b'); assert.equal(await bodyRows.count(), 1);
      assert.match(await bodyRows.innerText(), /원생나/);
    } finally { await s.close(); }
  });
  await check('청구 준비 단일 입구·구형 일괄 생성 우회 제거', async () => {
    const s = await screen({ screen: 'finance', props: financeProps }); try {
      assert.match(await s.page.getByRole('link', { name: '이번 달 청구 준비', exact: true }).getAttribute('href'), /prepare\?month=2026-10$/);
      await s.page.locator('summary').filter({ hasText: '기타 청구 작업' }).click();
      await s.page.getByRole('button', { name: '청구 빠른 작업', exact: true }).click();
      for (const name of ['자동 생성/정리', '대상 확인', '청구서 생성']) assert.equal(await s.page.getByRole('button', { name, exact: true }).count(), 0);
      await s.page.getByRole('button', { name: /상태 새로고침/ }).waitFor();
      await s.page.keyboard.press('Escape');
      await s.page.locator('summary').filter({ hasText: '기타 청구 작업' }).click();
      await s.page.getByRole('button', { name: /수납 추가/ }).click();
      const manualType = s.page.locator('select').filter({ has: s.page.locator('option[value="OTHER"]') });
      assert.deepEqual(await manualType.locator('option').evaluateAll(options => options.map(option => option.value)), ['UNIFORM', 'OTHER']);
      await s.page.getByRole('link', { name: '청구 준비에서 계산·발행', exact: true }).waitFor();
    } finally { await s.close(); }
  });
  await check('신청에서 연결한 특정 원생 수납과 해제', async () => {
    const s = await screen({ width: 1440, screen: 'finance', props: financeProps, studentId: 'child-a' }); try {
      assert.equal(await s.page.locator('tbody tr').count(), 2);
      await s.page.getByRole('button', { name: '전체 원생 보기', exact: true }).click(); assert.equal(await s.page.locator('tbody tr').count(), 3);
      await s.page.screenshot({ path: path.join(evidence, 'finance-1440.png'), fullPage: true });
    } finally { await s.close(); }
  });

} finally {
  if (browser) await browser.close(); await harness.close();
  const cleanupTarget = path.resolve(harness.outputDir), expectedParent = path.resolve(root, '.tmp');
  assert.ok(cleanupTarget.startsWith(expectedParent + path.sep), '검사 임시 폴더 안에서만 정리');
  await rm(cleanupTarget, { recursive: true, force: true });
  await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ cases, passed: cases.filter(item => item.pass).length, failed: cases.filter(item => !item.pass).length }, null, 2));
}
if (cases.some(item => !item.pass)) process.exitCode = 1;
