import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

// 실제 관리자 컴포넌트의 조회 경계·접기 동작을 확인한다. 운영 서버는 호출할 수 없다.
const primary = {
  stats: { studentCount: 42, programCount: 3, coachCount: 4, classCount: 8 },
  pendingRequests: [], pendingCount: 1,
  enrollStats: { PENDING: 2, APPROVED: 0, REJECTED: 0, CANCELLED: 0, total: 2 },
  extendedStats: { thisMonthRevenue: 0, lastMonthRevenue: 0, attendanceRate: 0, unpaidCount: 0, unpaidAmount: 0, monthlyRevenue: [], monthlyAttendance: [], programStudents: [] },
  todayClasses: [{ id: 'fixture-class', name: '검증 기초반', startTime: '16:00', endTime: '16:55', capacity: 12, programName: '검증 농구', enrolled: 8 }],
  recentStudents: [], todayLabel: '월요일',
};
const full = {
  ...primary,
  pendingRequests: [{ id: 'fixture-request', title: '검증 셔틀 문의', createdAt: '2026-10-19T05:00:00Z', studentName: '검증 학생', parentName: null }],
  extendedStats: { ...primary.extendedStats, thisMonthRevenue: 120000, unpaidCount: 1, unpaidAmount: 120000 },
  recentStudents: [{ id: 'fixture-new', name: '검증 새원생', createdAt: '2026-10-19T05:00:00Z', parentName: null }],
};
const harness = await startStatusBrowserHarness({
  mocks: {
    '@/app/actions/auth': 'export async function logout(){}',
    'next/navigation': `export function usePathname(){return '/admin';} export function useRouter(){return {back(){},push(){},refresh(){}};}`,
  },
  entry: `import{createElement}from'react';import{createRoot}from'react-dom/client';import Shell from '@/app/admin/AdminShellClient';import Dashboard from '@/app/admin/AdminDashboardClient';createRoot(document.getElementById('root')).render(createElement(Shell,{initialUserName:'검증 관리자',initialUserEmail:'qa@example.invalid'},createElement(Dashboard,{initialData:window.__testProps})));`,
});
const browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const cases = [];
const origin = new URL(harness.url).origin;
async function check(name, run) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const requests = []; const errors = [];
  let failures = 0;
  await context.addInitScript(value => { window.__testProps = value; }, primary);
  await context.route('**/*', async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin !== origin) { errors.push('외부 요청 차단'); return route.abort(); }
    if (request.method() === 'GET' && ['/', '/bundle.js'].includes(url.pathname)) return route.continue();
    requests.push({ path: url.pathname, method: request.method() });
    if (url.pathname === '/api/admin/dashboard') {
      if (failures-- > 0) return route.fulfill({ status: 503, json: { error: '검사용 조회 실패' } });
      return route.fulfill({ json: full });
    }
    return route.fulfill({ status: 404, json: { error: '검사 대상이 아닌 경로' } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(harness.url);
    await page.getByRole('heading', { name: '오늘의 업무' }).waitFor();
    await run({ page, requests, failNext: () => { failures++; } });
    assert.deepEqual(errors, []);
    cases.push({ name, pass: true });
  } catch (error) { cases.push({ name, pass: false, error: error.message }); }
  finally { await context.close(); }
  console.log(`${cases.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
const overview = page => page.getByText('운영 현황', { exact: true });
const tools = page => page.getByText('관리 도구', { exact: true });
try {
  await check('초기 조회의 실제 오늘 수업은 상세 조회 전에도 보인다', async ({ page, requests }) => {
    await page.getByText('검증 기초반', { exact: true }).waitFor();
    assert.equal(requests.length, 0);
    assert.equal(await page.getByText('검증 새원생', { exact: true }).count(), 0);
    assert.equal(await page.getByText('이번 달 매출', { exact: true }).isVisible(), false);
  });
  await check('운영 현황과 관리 도구 펼치기는 자동 조회·실행하지 않는다', async ({ page, requests }) => {
    await overview(page).click(); await tools(page).click();
    assert.equal(requests.length, 0);
    assert.equal(await page.getByRole('button', { name: '점검 실행', exact: true }).isVisible(), true);
  });
  await check('조회 실패 후 오늘 수업을 보존하고 같은 조회를 재시도한다', async ({ page, requests, failNext }) => {
    await overview(page).click(); failNext();
    const load = page.getByRole('button', { name: /불러오기|다시 시도|재시도/ });
    await load.first().click(); await page.getByRole('alert').waitFor();
    assert.equal(await page.getByText('검증 기초반', { exact: true }).isVisible(), true);
    await page.getByRole('button', { name: '상세 데이터 다시 불러오기', exact: true }).click();
    await page.getByText('검증 새원생', { exact: true }).waitFor();
    assert.equal(requests.filter(r => r.path === '/api/admin/dashboard').length, 2);
    assert.equal(requests.some(r => r.method !== 'GET'), false);
  });
  await check('중복 바로가기 카드 없이 기존 운영·사이트 메뉴로 이동할 수 있다', async ({ page }) => {
    const nav = page.locator('aside nav');
    for (const summary of await nav.locator('summary').all()) await summary.click();
    const operations = ['/admin', '/admin/apply', '/admin/students', '/admin/attendance', '/admin/finance', '/admin/seasonal/dispatch', '/admin/requests', '/admin/notification-deliveries', '/admin/uniform'];
    for (const href of operations) assert.equal(await nav.locator(`a[href="${href}"]`).first().isVisible(), true, href);
    await page.getByRole('button', { name: '사이트', exact: true }).click();
    for (const href of ['/admin/gallery', '/admin/notices', '/admin/schedule', '/admin/settings']) assert.equal(await nav.locator(`a[href="${href}"]`).isVisible(), true, href);
    assert.equal(await page.getByText('빠른 관리', { exact: true }).count(), 0);
  });
} finally { await browser.close(); await harness.close(); }
await mkdir('.tmp/admin-ux-qa', { recursive: true });
await writeFile('.tmp/admin-ux-qa/workspace-regression.json', JSON.stringify({ cases, passed: cases.filter(c => c.pass).length }, null, 2));
assert.equal(cases.every(c => c.pass), true, JSON.stringify(cases.filter(c => !c.pass)));
