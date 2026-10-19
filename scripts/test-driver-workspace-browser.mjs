import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

// 실제 기사 화면과 체크 저장/검증 코드를 사용하고, API와 GPS 기기만 격리한다.
const regularId = '11111111-1111-4111-8111-111111111111';
const rider = (id, name, kind = 'REGULAR', direction = 'PICKUP', absent = false) => ({ key: kind === 'REGULAR' ? `R:${id}` : `S:${direction}:${id}`, checkId: id, kind, direction, name, grade: '초4', parentPhone: '00000000000', studentPhone: '00000000001', absent });
const stop = (key, label, time, riders, options = {}) => ({ key, label, time, minutes: time ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) : null, seq: 0, kind: 'REGULAR', direction: 'PICKUP', groupKey: 'fixture-group', groupLabel: '검증 오전 수업', subLabel: null, lat: 37.6, lng: 127.1, isHub: false, isTerminal: false, pending: false, warn: false, riders, ...options });
const props = { token: 'fixture-token', date: '2026-10-19', today: '2026-10-19', prevDate: '2026-10-18', nextDate: '2026-10-20', driverLabel: '검증 기사', initialBoarding: {}, rows: [
  stop('terminal', '검증 차고지 출발', '08:00', [], { isTerminal: true, lat: null, lng: null }),
  stop('regular', '검증 첫 정류장', '08:10', [rider(regularId, '검증 가온'), rider('absent-fixture', '검증 사전결석', 'REGULAR', 'PICKUP', true)], { pending: true, warn: true }),
  stop('seasonal', '검증 특강 정류장', '08:20', [rider('seasonal-fixture', '검증 나래', 'SEASONAL', 'DROPOFF'), rider('planned-absent', '검증 결석예정', 'SEASONAL', 'DROPOFF', true)], { kind: 'SEASONAL', direction: 'DROPOFF', groupKey: 'seasonal-group' }),
  stop('hub', '검증 무료 거점', '08:30', [], { isHub: true, kind: 'SEASONAL' }),
  stop('unknown-time', '검증 시간 미정', null, [rider('unknown-rider', '검증 다온')]),
] };
const harness = await startStatusBrowserHarness({
  mocks: { '@/hooks/useGpsShare': `import{useState}from'react';export function useGpsShare(){const[s,setS]=useState({state:'off',transmission:'idle',lastSentAt:null,accuracy:null});return{...s,start(){window.__gpsStarts++;setS({state:'denied',transmission:'idle',lastSentAt:null,accuracy:null});},async stop(){window.__gpsStops++;setS({state:'off',transmission:'stop-unknown',lastSentAt:null,accuracy:null});return false;}}}` },
  entry: `import{createElement}from'react';import{createRoot}from'react-dom/client';import Driver from '@/components/shuttle/UnifiedDriverClient';createRoot(document.getElementById('root')).render(createElement(Driver,window.__testProps));`,
});
const browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const origin = new URL(harness.url).origin, cases = [];
async function check(name, exercise, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  const requests = [], errors = [], regular = {}, seasonal = { PICKUP: {}, DROPOFF: {} }; let failedReads = options.failReads ?? 0;
  await context.addInitScript(value => { window.__testProps = value; window.__gpsStarts = 0; window.__gpsStops = 0; window.__installPrompts = 0; }, { ...props, ...options.props });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { errors.push('외부 요청 차단'); return route.abort(); }
    if (req.method() === 'GET' && ['/', '/bundle.js'].includes(url.pathname)) return route.continue();
    const body = req.method() === 'POST' ? req.postDataJSON() : null;
    requests.push({ path: url.pathname, method: req.method(), body, date: url.searchParams.get('date') });
    if (url.pathname === '/api/shuttle/regular-order') return route.fulfill({ json: { updated: 1 } });
    if (!['/api/shuttle/regular-boarding', '/api/shuttle/boarding'].includes(url.pathname)) return route.fulfill({ status: 404, json: { error: '격리 검사 범위 밖' } });
    if (req.method() === 'POST') {
      if (!options.dontSave) {
        const map = body.direction ? seasonal[body.direction] : regular, id = body.shuttleRequestId ?? body.rowId;
        if (body.status) map[id] = body.status; else delete map[id];
      }
      return options.abortPost ? route.abort() : route.fulfill({ json: { ok: true } });
    }
    if (failedReads-- > 0) return route.fulfill({ status: 503, json: { error: '합성 조회 실패' } });
    return route.fulfill({ json: { ok: true, boarding: url.pathname.endsWith('regular-boarding') ? regular : seasonal, checkedAt: {} } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000); page.on('pageerror', err => errors.push(err.message));
  try { await page.goto(harness.url); await page.getByRole('heading', { name: '셔틀 운행', exact: true }).waitFor(); await exercise(page, requests); assert.deepEqual(errors, []); cases.push({ name, pass: true }); }
  catch (error) { cases.push({ name, pass: false, error: error.message }); }
  finally { await context.close(); }
  console.log(`${cases.at(-1).pass ? 'PASS' : 'FAIL'} ${name}`);
}
const row = (page, label) => page.locator('ol > li').filter({ hasText: label });
const person = (page, name) => page.locator('.academy-driver-rider').filter({ hasText: name });
const posts = requests => requests.filter(r => r.method === 'POST');
try {
  await check('정차 순서와 날짜·연락·길안내 목적지를 보존한다', async (page, requests) => {
    assert.equal(await page.getByText('10/19 (월)', { exact: true }).count(), 1);
    for (const date of ['2026-10-18', '2026-10-20']) assert.equal(await page.locator(`a[href="?date=${date}"]`).count(), 1);
    assert.equal(await page.locator('ol > li').last().innerText().then(t => t.includes('검증 시간 미정')), true);
    assert.equal(await row(page, '검증 첫 정류장').getByText('1', { exact: true }).count(), 1);
    assert.equal(await person(page, '검증 가온').locator('a[href="tel:00000000000"]').count(), 1);
    const nav = row(page, '검증 첫 정류장').getByRole('link', { name: /길안내/ });
    assert.match(await nav.getAttribute('href'), /127\.1/); assert.equal(requests.length, 0);
  });
  await check('정규 체크는 기존 rowId로 저장하고 서버 조회 후 선택 상태를 바꾼다', async (page, requests) => {
    const target = person(page, '검증 가온').getByRole('button', { name: '탑승', exact: true }); await target.click();
    await person(page, '검증 가온').getByRole('status').filter({ hasText: '저장 완료' }).waitFor();
    assert.equal(posts(requests)[0].path, '/api/shuttle/regular-boarding'); assert.equal(posts(requests)[0].body.rowId, regularId);
    assert.equal(posts(requests)[0].body.date, props.date); assert.equal(await target.getAttribute('aria-pressed'), 'true');
    await target.click(); await page.waitForFunction(() => [...document.querySelectorAll('.academy-driver-rider')].find(el => el.textContent.includes('검증 가온'))?.querySelector('button')?.getAttribute('aria-pressed') === 'false');
    assert.equal(posts(requests)[1].body.status, null);
  });
  await check('특강 하차·자차는 방향과 원래 신청 키를 유지한다', async (page, requests) => {
    const target = person(page, '검증 나래'); await target.getByRole('button', { name: '하차', exact: true }).click();
    await target.getByRole('status').filter({ hasText: '저장 완료' }).waitFor();
    assert.equal(posts(requests)[0].path, '/api/shuttle/boarding'); assert.equal(posts(requests)[0].body.direction, 'DROPOFF'); assert.equal(posts(requests)[0].body.shuttleRequestId, 'seasonal-fixture');
    await target.getByRole('button', { name: '미하차', exact: true }).click(); await target.getByRole('button', { name: /자차하원/ }).click();
    await target.locator('span').filter({ hasText: /^자차하원$/ }).waitFor();
    assert.equal(posts(requests).at(-1).body.status, 'SELF');
  });
  await check('정규 사전 결석은 잠그고 특강 결석 예정은 확인 가능하다', async (page, requests) => {
    assert.equal(await person(page, '검증 사전결석').getByRole('button').count(), 0);
    assert.equal(await person(page, '검증 결석예정').getByRole('button', { name: '하차', exact: true }).isEnabled(), true);
    assert.equal(requests.length, 0);
  });
  await check('응답 유실 후 서버 확인은 중복 토글하지 않는다', async (page, requests) => {
    await person(page, '검증 가온').getByRole('button', { name: '탑승', exact: true }).click();
    await person(page, '검증 가온').getByRole('status').filter({ hasText: '저장 완료' }).waitFor(); assert.equal(posts(requests).length, 1);
  }, { abortPost: true });
  await check('결과 미확인은 체크를 잠그고 조회만 재시도한다', async (page, requests) => {
    const target = person(page, '검증 가온'); await target.getByRole('button', { name: '탑승', exact: true }).click();
    await target.getByText(/결과 확인 필요/).waitFor(); assert.equal(await target.getByRole('button', { name: '탑승', exact: true }).isDisabled(), true);
    await target.getByRole('button', { name: '저장 상태 확인', exact: true }).click();
    await target.getByText(/서버 상태 확인 완료/).waitFor(); assert.equal(posts(requests).length, 1);
  }, { failReads: 1 });
  await check('연속 클릭은 한 번만 저장하고 서버 미반영은 성공으로 표시하지 않는다', async (page, requests) => {
    await person(page, '검증 가온').getByRole('button', { name: '탑승', exact: true }).evaluate(b => { b.click(); b.click(); b.click(); });
    await person(page, '검증 가온').getByText(/변경 미반영/).waitFor(); assert.equal(posts(requests).length, 1);
    assert.equal(await person(page, '검증 가온').getByRole('button', { name: '탑승', exact: true }).getAttribute('aria-pressed'), 'false');
  }, { dontSave: true });
  await check('최초 체크 조회 실패는 미체크 0건이나 완료로 안내하지 않는다', async page => {
    await page.getByText(/체크 기록을 불러오지 못했습니다/).waitFor();
    assert.equal(await person(page, '검증 가온').getByRole('button', { name: '탑승', exact: true }).isDisabled(), true);
    assert.ok(await page.getByText('기록 확인 필요', { exact: true }).count() > 0);
    assert.equal(await page.getByText(/^체크 \d+\/\d+/).count(), 0);
  }, { props: { initialBoardingReliable: false } });
  await check('시작·종료는 헤더 한곳에 있고 GPS 실패·중단 불확실을 남긴다', async page => {
    await page.getByRole('button', { name: /운행 시작/ }).click();
    await page.getByRole('button', { name: /위치 공유 상세 보기/ }).click();
    await page.getByText(/위치 권한 거부됨/).waitFor();
    await page.getByRole('button', { name: '위치 공유 상세 닫기' }).click();
    assert.equal(await page.locator('header').getByRole('button', { name: /운행 종료/ }).count(), 1);
    await page.getByRole('button', { name: /운행 종료/ }).click();
    await page.getByRole('button', { name: /위치 공유 상세 보기/ }).click();
    await page.getByText(/서버 공유 중단은 확인 필요/).waitFor();
    assert.equal(await page.evaluate(() => window.__gpsStarts), 1); assert.equal(await page.evaluate(() => window.__gpsStops), 1);
  });
  await check('설치 안내는 명시적으로 누를 때만 설치 창을 요청한다', async page => {
    await page.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = async () => { window.__installPrompts++; }; window.dispatchEvent(e); });
    const install = page.getByRole('button', { name: '설치', exact: true }); await install.waitFor(); assert.equal(await page.evaluate(() => window.__installPrompts), 0);
    await install.click(); await install.waitFor({ state: 'hidden' }); assert.equal(await page.evaluate(() => window.__installPrompts), 1);
  });
} finally { await browser.close(); await harness.close(); }
await mkdir('.tmp/driver-ux-qa', { recursive: true });
await writeFile('.tmp/driver-ux-qa/workspace-regression.json', JSON.stringify({ cases, passed: cases.filter(c => c.pass).length }, null, 2));
assert.equal(cases.every(c => c.pass), true, JSON.stringify(cases.filter(c => !c.pass)));
