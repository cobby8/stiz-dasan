import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

// 실제 화면과 합성 수업을 연결한다. 모든 저장·발송은 격리된 모의 액션이다.
const lesson = (id, status = null) => ({ id, name: `검증 ${id}반`, startTime: '16:00', endTime: '17:00', location: '검증 체육관', studentCount: 2, sessionId: status ? `session-${id}` : null, sessionStatus: status, plannedContent: null, startedAt: null, kind: 'REGULAR', scheduleKey: `schedule-${id}`, sessionDateId: null });
const home = { dateKey: '2026-10-19', classes: [lesson('기초'), lesson('심화')] };
const student = (id, status = null) => ({ id: `row-${id}`, attendanceKey: `seat-${id}`, studentId: null, name: `검증 ${id}`, grade: '초4', phone: null, status, attendanceNote: null, arrivedAt: null, absenceReport: id === '둘째' ? { reason: 'ILLNESS', status: 'CONFIRMED' } : null });
const session = {
  session: { id: 'fixture-session', classId: 'fixture-class', className: '검증 진행반', startTime: '16:00', endTime: '17:00', location: '검증 체육관', studentCount: 2, status: 'IN_PROGRESS', plannedContent: '검증 드리블', content: null, notes: null, photos: [], startedAt: '2026-10-19T07:00:00Z', endedAt: null, sessionDateId: null },
  initialStudents: [student('첫째'), student('둘째')], initialView: 'main',
};
const action = name => `export async function ${name}(value){const r=await fetch('/test-action/${name}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});if(!r.ok)throw new Error('격리 통신 오류');return r.json();}`;
const harness = await startStatusBrowserHarness({
  mocks: {
    '@/app/actions/staff-sessions': ['savePlannedClassContent', 'startClassSession', 'cancelClassSession', 'completeClassSession', 'saveSessionMemo', 'saveStaffAttendance'].map(action).join('\n'),
    '@/app/actions/staff-notices': ['createStaffClassNotice', 'getStaffClassNoticeStatus'].map(action).join('\n'),
    '@/components/staff/SessionPhotoUploader': `import{createElement}from'react';export function SessionPhotoUploader(){return createElement('p',null,'검증 사진 업로더');}`,
    '@/components/staff/VoiceToTextButton': 'export function VoiceToTextButton(){return null;}',
    '@/components/staff/ClassPeopleSheet': 'export function ClassPeopleSheet(){return null;}',
    '@/components/staff/ClassBillingSheet': 'export function ClassBillingSheet(){return null;}',
    'next/navigation': `const nav=(url)=>window.__navigation.push(url);export function useRouter(){return{push:nav,replace:nav,refresh(){}};}export function usePathname(){return '/staff';}`,
  },
  entry: `import{createElement}from'react';import{createRoot}from'react-dom/client';import Home from '@/app/staff/StaffHomeClient';import Session from '@/app/staff/sessions/[sessionId]/SessionInProgressClient';createRoot(document.getElementById('root')).render(createElement(location.search.includes('session')?Session:Home,window.__testProps));`,
});
const browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const origin = new URL(harness.url).origin, cases = [];
async function check(name, screen, props, run, respond = () => ({ ok: true })) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const requests = [], errors = [];
  await context.addInitScript(value => { window.__testProps = value; window.__navigation = []; }, props);
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { errors.push('외부 요청 차단'); return route.abort(); }
    if (req.method() === 'GET' && ['/', '/bundle.js'].includes(url.pathname)) return route.continue();
    const call = { path: url.pathname, method: req.method(), body: req.postDataJSON() }; requests.push(call);
    const result = await respond(call, requests);
    return result === 'abort' ? route.abort() : route.fulfill({ json: result });
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', err => errors.push(err.message)); page.on('dialog', dialog => dialog.accept());
  try {
    await page.goto(`${harness.url}?${screen}`); await page.getByRole('heading', { level: 1 }).waitFor();
    await run(page, requests); assert.deepEqual(errors, []);
    cases.push({ name, pass: true });
  } catch (err) { cases.push({ name, pass: false, error: err.message }); }
  finally { await context.close(); }
  console.log(`${cases.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
const submitStart = page => page.getByRole('dialog').getByRole('button', { name: '수업 시작', exact: true });
const attendance = page => page.getByRole('button', { name: /출석부|출석 확인/ }).first().click();
const row = (page, name) => page.locator('article').filter({ hasText: name });
try {
  await check('완료 수업을 다음 수업으로 다시 제시하지 않는다', 'home', { ...home, classes: home.classes.map(c => ({ ...c, sessionStatus: 'COMPLETED', sessionId: `session-${c.id}` })) }, async (page, calls) => {
    assert.equal(await page.getByText('다음 수업', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /수업 시작$/ }).count(), 0);
    assert.match(await page.locator('body').innerText(), /완료/); assert.equal(calls.length, 0);
  });
  await check('빈 수업 상태에서도 시작·발송을 자동 실행하지 않는다', 'home', { ...home, classes: [] }, async (page, calls) => {
    await page.getByText('오늘 배정된 수업이 없습니다.', { exact: true }).waitFor(); assert.equal(calls.length, 0);
  });
  await check('진행 중인 수업 복귀와 다른 수업 시작 잠금', 'home', { ...home, classes: [lesson('기초', 'IN_PROGRESS'), lesson('심화')] }, async page => {
    await page.getByRole('button', { name: /수업으로 돌아가기$/ }).click();
    assert.deepEqual(await page.evaluate(() => window.__navigation), ['/staff/sessions/session-기초']);
    assert.equal(await page.getByRole('button', { name: /현재 수업 종료 후 시작$/ }).isDisabled(), true);
  });
  await check('특강 시작은 기존 회차 식별자를 보낸다', 'home', { ...home, classes: [{ ...lesson('특강'), kind: 'SEASONAL', sessionDateId: 'fixture-date' }] }, async (page, calls) => {
    await page.getByRole('button', { name: /수업 시작$/ }).click(); await submitStart(page).click();
    await page.waitForFunction(() => window.__navigation.length > 0);
    assert.equal(calls[0].body.sessionDateId, 'fixture-date'); assert.equal(calls[0].body.date, '2026-10-19');
    assert.deepEqual(await page.evaluate(() => window.__navigation), ['/staff/sessions/started-session?view=attendance']);
  }, () => ({ ok: true, sessionId: 'started-session' }));
  await check('보조 도구 펼치기는 저장·공지 발송을 실행하지 않는다', 'home', home, async (page, calls) => {
    for (const summary of await page.locator('summary').all()) await summary.click(); assert.equal(calls.length, 0);
    assert.ok(await page.getByRole('button', { name: '수업 공지', exact: true }).count() > 0);
  });
  await check('출결은 좌석 식별자로 저장하고 사전 결석 알림을 유지한다', 'session', session, async (page, calls) => {
    await attendance(page); await page.getByText(/학부모 결석 알림/).waitFor();
    await row(page, '검증 첫째').getByRole('button', { name: '검증 첫째 출석', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('article button[aria-pressed="true"]'));
    assert.equal(calls[0].body.attendanceKey, 'seat-첫째'); assert.equal(calls[0].body.status, 'PRESENT');
  });
  await check('개별 저장 실패는 미확인 상태와 입력을 유지한다', 'session', { ...session, initialView: 'attendance' }, async page => {
    await row(page, '검증 첫째').getByRole('button', { name: '검증 첫째 출석', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '검증 저장 실패' }).waitFor();
    assert.match(await row(page, '검증 첫째').innerText(), /미확인/);
  }, () => ({ ok: false, message: '검증 저장 실패' }));
  await check('일괄 출석 부분 실패 후 성공 건을 유지하고 남은 학생만 재시도한다', 'session', { ...session, initialView: 'attendance' }, async (page, calls) => {
    await page.getByRole('button', { name: '미확인 학생 전체 출석', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /1명은 저장/ }).waitFor();
    assert.equal(calls.length, 2);
    await page.getByRole('button', { name: '미확인 학생 전체 출석', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /전체 출석을 저장/ }).waitFor();
    assert.deepEqual(calls.map(c => c.body.attendanceKey), ['seat-첫째', 'seat-둘째', 'seat-둘째']);
  }, (_call, calls) => calls.length === 2 ? { ok: false, message: '검증 부분 실패' } : { ok: true } );
  await check('미확인 출결이 남으면 종료 확인 대신 출석부로 안내한다', 'session', session, async (page, calls) => {
    await page.getByRole('button', { name: /수업 종료 확인$/ }).click();
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('button', { name: '종료 확인', exact: true }).count(), 0);
    await page.getByRole('button', { name: '출석부 확인하기', exact: true }).click();
    await page.getByRole('heading', { name: '출석 확인', exact: true }).waitFor(); assert.equal(calls.length, 0);
  });
  await check('확인된 수업 종료는 리포트 옵션과 메모 저장을 유지한다', 'session', { ...session, initialStudents: session.initialStudents.map(s => ({ ...s, status: 'PRESENT' })) }, async (page, calls) => {
    await page.getByRole('button', { name: /수업 종료 확인$/ }).click();
    await page.locator('#session-report').fill('합성 수업 리포트');
    await page.getByRole('button', { name: '종료 확인', exact: true }).click();
    await page.waitForFunction(() => window.__navigation.length > 0);
    const finish = calls.find(c => c.path.endsWith('completeClassSession'));
    assert.equal(finish.body.report, '합성 수업 리포트'); assert.equal(finish.body.publishReport, true);
    assert.deepEqual(await page.evaluate(() => window.__navigation), ['/staff']);
  });
} finally { await browser.close(); await harness.close(); }
await mkdir('.tmp/staff-ux-qa', { recursive: true });
await writeFile('.tmp/staff-ux-qa/workspace-regression.json', JSON.stringify({ cases, passed: cases.filter(c => c.pass).length }, null, 2));
assert.equal(cases.every(c => c.pass), true, JSON.stringify(cases.filter(c => !c.pass)));
