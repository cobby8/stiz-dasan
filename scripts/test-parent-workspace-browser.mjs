import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

// 합성 가족 자료로 실제 학부모 홈을 확인한다. 운영 인증·DB·발송은 번들에서 차단한다.
const child = (id, name, className, amount) => ({
  id, name, birthDate: '2016-01-01', gender: null,
  enrollments: [{ id: `enroll-${id}`, classId: `class-${id}`, className, dayOfWeek: 'Mon', startTime: '16:00', endTime: '17:00', programName: '검증 농구' }],
  attendance: { total: 4, present: 3, absent: 1, late: 0, records: [] },
  payments: amount ? [{ id: `payment-${id}`, amount, status: 'PENDING', dueDate: '2026-10-20', paidDate: null, invoiceId: `invoice-${id}`, description: `${name} 검증 청구` }] : [],
});
const props = {
  data: { parent: { id: 'parent-qa', name: '검증 보호자', email: 'qa@example.invalid', phone: null }, children: [child('child-a', '검증 첫째', '기초 검증반', 120000), child('child-b', '검증 둘째', '심화 검증반', 0)] },
  feedbacks: [{ id: 'feedback-b', studentId: 'child-b', studentName: '검증 둘째', sessionDate: '2026-10-18', category: 'GENERAL', title: '둘째 검증 피드백', content: '합성 피드백 본문', rating: null, createdAt: '2026-10-18', coachName: '검증 코치' }],
  myRequests: [{ id: 'request-b', studentId: 'child-b', studentName: '검증 둘째', userId: 'parent-qa', type: 'OTHER', title: '둘째 검증 문의', content: '합성 문의 본문', date: null, status: 'PENDING', adminNote: null, createdAt: '2026-10-18', updatedAt: '2026-10-18' }],
  notifications: [{ id: 'notification-qa', userId: 'parent-qa', type: 'ATTENDANCE', title: '검증 알림', message: '합성 알림 본문', linkUrl: null, isRead: false, createdAt: '2026-10-18' }], unreadCount: 1,
  parentShuttleOverview: [{ id: 'shuttle-a', studentId: 'child-a', sourceType: 'REGULAR_CLASS', direction: 'PICKUP', status: 'CONFIRMED', label: '정규', title: '첫째 검증 셔틀', serviceDate: '2026-10-19', routeName: '검증 1노선', stopName: '합성 정류장', stopAddress: null, plannedAt: '2026-10-19T06:30:00Z', vehicleName: '검증 차량', rideStatus: 'PENDING', pickupEtaLabel: '15:30 승차' }],
  shuttleDriverContact: { name: '검증 기사', phone: '00000000000' },
};
const harness = await startStatusBrowserHarness({
  mocks: { '@/app/actions/admin': `async function call(name,args){const result=await fetch('/test-action/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});return result.json();} export const markNotificationRead=id=>call('read',id);export const markAllNotificationsRead=id=>call('read-all',id);export const createParentRequest=value=>call('message',value);` },
  entry: `import{createElement}from'react';import{createRoot}from'react-dom/client';import Home from '@/app/mypage/MyPageClient';createRoot(document.getElementById('root')).render(createElement(Home,window.__testProps));`,
});
const browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const cases = [];
const origin = new URL(harness.url).origin;
async function check(name, run, hash = '') {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const requests = [], errors = [];
  await context.addInitScript(value => { window.__testProps = value; delete window.PushManager; }, props);
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { errors.push('외부 요청 차단'); return route.abort(); }
    if (req.method() === 'GET' && ['/', '/bundle.js'].includes(url.pathname)) return route.continue();
    requests.push({ path: url.pathname, method: req.method(), body: req.postDataJSON() });
    return route.fulfill({ json: { ok: true } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.clock.install({ time: new Date('2026-10-19T03:00:00Z') });
    await page.goto(harness.url + hash);
    await page.getByRole('heading', { name: '검증 첫째 학생', exact: true }).waitFor();
    await run(page, requests);
    assert.deepEqual(errors, []);
    cases.push({ name, pass: true });
  } catch (error) { cases.push({ name, pass: false, error: error.message }); }
  finally { await context.close(); }
  console.log(`${cases.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
try {
  await check('접기·펼치기는 서버 쓰기나 알림 읽음을 실행하지 않는다', async (page, requests) => {
    for (const summary of await page.locator('summary').all()) await summary.click();
    assert.equal(requests.length, 0);
  });
  await check('선택 자녀에 맞춰 수업·청구·셔틀이 바뀐다', async page => {
    assert.equal(await page.locator('a[href="/payments/invoice-child-a"]').first().isVisible(), true);
    await page.getByRole('button', { name: '검증 둘째', exact: true }).click();
    await page.getByRole('heading', { name: '검증 둘째 학생', exact: true }).waitFor();
    assert.equal(await page.locator('a[href="/payments/invoice-child-a"]').count(), 0);
    assert.equal(await page.getByText('심화 검증반', { exact: false }).first().isVisible(), true);
    assert.equal(await page.getByText('첫째 검증 셔틀', { exact: true }).count(), 0);
  });
  await check('실제 신청·보강·청구·리포트 목적지를 보존한다', async page => {
    for (const summary of await page.locator('summary').all()) await summary.click();
    for (const href of ['/mypage/regular-absence', '/mypage/seasonal', '/mypage/makeup', '/mypage/shuttle', '/mypage/payments', '/mypage/enrollment-change', '/mypage/reports']) {
      assert.equal(await page.locator(`a[href="${href}"]`).first().isVisible(), true, href);
    }
    assert.equal(await page.locator('a[href="tel:00000000000"]').isVisible(), true);
  });
  for (const id of ['mypage-enrollments', 'mypage-shuttle', 'mypage-feedback', 'parent-absence-hub']) {
    await check(`직접 해시 진입은 ${id}의 접힌 상위 영역을 연다`, async page => {
      await page.locator(`#${id}`).waitFor({ state: 'visible' });
      assert.equal(await page.locator(`#${id}`).evaluate(el => { for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'DETAILS' && !p.open) return false; return true; }), true);
    }, `#${id}`);
  }
  await check('같은 화면의 해시 변경과 동일 링크 재클릭도 접힌 내용을 연다', async page => {
    await page.evaluate(() => { window.location.hash = 'mypage-shuttle'; });
    await page.waitForFunction(() => document.querySelector('#mypage-shuttle').open);
    const absence = page.locator('#parent-absence-hub');
    const link = page.locator('nav[aria-label="자주 하는 요청"] a[href="#parent-absence-hub"]');
    await link.click();
    await page.waitForFunction(() => document.querySelector('#parent-absence-hub').open);
    await absence.locator('summary').click();
    assert.equal(await absence.evaluate(el => el.open), false);
    await link.click();
    await page.waitForFunction(() => document.querySelector('#parent-absence-hub').open);
  });
  await check('가족 메시지를 확인하고 선택 자녀에게만 문의를 보낸다', async (page, requests) => {
    await page.getByRole('button', { name: /보낸 메시지/ }).click();
    await page.getByText('둘째 검증 문의', { exact: true }).waitFor();
    await page.getByRole('button', { name: '검증 둘째', exact: true }).click();
    await page.getByRole('button', { name: /학원에 메시지 보내기/ }).click();
    await page.getByPlaceholder('문의하실 내용을 편하게 적어주세요').fill('합성 검증 문의');
    await page.getByRole('button', { name: '메시지 보내기', exact: true }).click();
    await page.getByPlaceholder('문의하실 내용을 편하게 적어주세요').waitFor({ state: 'hidden' });
    const post = requests.filter(req => req.path === '/test-action/message');
    assert.equal(post.length, 1); assert.equal(post[0].body.studentId, 'child-b'); assert.equal(post[0].body.type, 'OTHER');
  });
  await check('알림 펼치기는 읽음 처리를 하지 않고 명시적 버튼만 호출한다', async (page, requests) => {
    await page.getByRole('button', { name: /알림/ }).first().click();
    await page.getByText('검증 알림', { exact: true }).waitFor();
    assert.equal(requests.length, 0);
    await Promise.all([
      page.waitForRequest(req => new URL(req.url()).pathname === '/test-action/read-all'),
      page.getByRole('button', { name: '모두 읽음', exact: true }).click(),
    ]);
    assert.equal(requests.filter(req => req.path === '/test-action/read-all').length, 1);
  });
} finally { await browser.close(); await harness.close(); }
await mkdir('.tmp/parent-ux-qa', { recursive: true });
await writeFile('.tmp/parent-ux-qa/workspace-regression.json', JSON.stringify({ cases, passed: cases.filter(c => c.pass).length }, null, 2));
assert.equal(cases.every(c => c.pass), true, JSON.stringify(cases.filter(c => !c.pass)));
