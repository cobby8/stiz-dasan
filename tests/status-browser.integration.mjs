import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from './helpers/status-browser-harness.mjs';

// 운영 로그인·DB·알림 공급자를 실행하지 않고 실제 화면의 상태 전이를 검사한다.
export async function createStatusBrowserTest() {
  const action = name => `export async function ${name}(input){const r=await fetch('/test-actions/${name}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}); if(!r.ok)throw new Error('격리 통신 오류');return r.json();}`;
  const harness = await startStatusBrowserHarness({
    mocks: {
      '@/app/actions/staff-notices': ['createStaffClassNotice', 'getStaffClassNoticeStatus'].map(action).join('\n'),
      '@/app/actions/staff-sessions': ['savePlannedClassContent', 'startClassSession'].map(action).join('\n'),
      '@/components/staff/VoiceToTextButton': 'export function VoiceToTextButton(){return null;}',
      '@/components/staff/ClassPeopleSheet': 'export function ClassPeopleSheet(){return null;}',
      '@/components/staff/ClassBillingSheet': 'export function ClassBillingSheet(){return null;}',
    },
    entry: `import {createElement} from 'react'; import {createRoot} from 'react-dom/client';
import Parent from '@/app/mypage/shuttle/ShuttleExceptionClient';
import Staff from '@/app/staff/StaffHomeClient';
import Driver from '@/components/shuttle/UnifiedDriverClient';
import Delivery from '@/app/admin/notification-deliveries/OperationalDeliveryClient';
const views={parent:Parent,staff:Staff,driver:Driver,delivery:Delivery};
const query=new URLSearchParams(location.search);
createRoot(document.getElementById('root')).render(createElement(views[query.get('screen')||'parent'],window.__testProps||{}));`,
  });
  const browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const failures = [];
  const cases = [];
  async function check(name, run) {
    try { await run(); cases.push({ name, pass: true }); }
    catch (error) { cases.push({ name, pass: false, error: String(error.message) }); failures.push(name); }
  }
  async function screen(name, props, respond) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(value => { window.__testProps = value; }, props);
    const unexpected = [];
    const requests = [];
    const origin = new URL(harness.url).origin;
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== origin) { unexpected.push('외부 요청 차단'); return route.abort(); }
      if (request.method() === 'GET' && ['/', '/bundle.js'].includes(url.pathname)) return route.continue();
      requests.push({ method: request.method(), path: url.pathname, query: url.searchParams, body: request.postDataJSON?.() });
      return respond(route, requests.at(-1), url);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`${harness.url}/?screen=${name}`);
    return { page, context, requests, errors, unexpected, async close() {
      try {
        assert.deepEqual(errors, [], '화면 실행 오류');
        assert.deepEqual(unexpected, [], '외부 요청 없음');
      } finally { await context.close(); }
    } };
  }
  return { harness, browser, screen, check, cases, failures, async close() { await browser.close(); await harness.close(); } };
}

export const parentProps = { initial: { today: '2026-10-19', maxDate: '2026-11-02', children: [{ studentId: 'fixture-child', studentName: '검사용 학생' }], upcoming: [] } };
export const staffProps = { dateKey: '2026-10-19', classes: [{ id: 'fixture-class', name: '검사용 수업', startTime: '16:00', endTime: '16:55', location: null, studentCount: 2, sessionId: null, sessionStatus: null, plannedContent: null, startedAt: null, kind: 'REGULAR', scheduleKey: 'fixture-schedule', sessionDateId: null }] };
export const driverProps = { token: 'fixture-token', date: '2026-10-19', today: '2026-10-19', prevDate: null, nextDate: null, driverLabel: '검사용 기사', initialBoarding: {}, rows: [{ key: 'fixture-stop', kind: 'REGULAR', direction: 'PICKUP', groupKey: 'fixture-group', groupLabel: null, label: '검사용 정류장', subLabel: null, time: '15:40', minutes: 940, seq: 0, lat: null, lng: null, isHub: false, isTerminal: false, pending: false, warn: false, riders: [{ key: 'REGULAR:fixture-row', checkId: 'fixture-row', kind: 'REGULAR', direction: 'PICKUP', name: '검사용 학생', grade: null, parentPhone: null, studentPhone: null, absent: false }] }] };
