import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

// 실제 화면·hook·bridge adapter를 연결한다. Android 서비스 자체는 별도 APK/기기 검증 대상이다.
const harness = await startStatusBrowserHarness({ entry: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import Driver from '@/components/shuttle/UnifiedDriverClient';
const root=createRoot(document.getElementById('root'));
const props={token:'synthetic-native-driver',date:'2026-10-19',today:'2026-10-19',prevDate:null,nextDate:null,driverLabel:'검증 기사',initialBoarding:{},rows:[]};
window.mountDriver=()=>root.render(React.createElement(Driver,props));
window.hideDriver=()=>root.render(null); window.mountDriver();` });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
async function check(name, test, initial = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.addInitScript(({ initial }) => {
      window.nativeCalls = []; window.gpsCalls = 0;
      Object.defineProperty(navigator, 'geolocation', { value: { watchPosition() { window.gpsCalls++; return 1; }, clearWatch() {} } });
      window.nativeState = { token: 'synthetic-native-driver', state: 'off', transmission: 'idle', running: false, lastSentAt: null, lastLocationAt: null, accuracy: null, ...initial };
      window.emitNative = patch => { Object.assign(window.nativeState, patch); window.dispatchEvent(new CustomEvent('stiz-driver-gps', { detail: { ...window.nativeState } })); };
      window.StizDriverGpsTransport = { postMessage(raw) { const message = JSON.parse(raw); window.nativeCalls.push(message); if (message.action === 'snapshot') window.emitNative({}); } };
    }, { initial });
    await page.goto(harness.url); await page.waitForFunction(() => window.nativeCalls.length > 0);
    await test(page);
    assert.equal(await page.evaluate(() => window.gpsCalls), 0, '앱에서 웹 GPS를 중복 실행하면 안 됨');
    results.push({ name, pass: true }); console.log('PASS', name);
  } catch (error) { results.push({ name, pass: false, error: error.message }); console.error('FAIL', name, error.message); }
  finally { await page.close(); }
}
try {
  await check('재진입 시 기기 운행 복구·웹 위치 수집 없음', async page => {
    await page.getByRole('button', { name: '운행 종료', exact: true }).waitFor();
    await page.getByText(/화면을 끄거나 길안내 앱으로 이동해도/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.nativeCalls.map(x => x.action)), ['snapshot']);
  }, { state: 'active', transmission: 'sent', running: true, lastSentAt: new Date().toISOString() });
  await check('시작 요청만으로 성공 단정 없이 실제 기기 상태를 표시', async page => {
    await page.getByRole('button', { name: '운행 시작', exact: true }).click();
    assert.equal(await page.evaluate(() => window.nativeCalls.at(-1).action), 'start');
    await page.evaluate(() => window.emitNative({ state: 'requesting', running: false }));
    await page.getByText('기기 위치 연결 중…').waitFor();
    await page.getByRole('button', { name: '운행 종료', exact: true }).waitFor();
  });
  await check('기기 권한 거부·시작 실패를 숨기지 않는다', async page => {
    await page.evaluate(() => window.emitNative({ state: 'denied', transmission: 'error', running: false, error: '정확한 위치 권한을 허용해 주세요.' }));
    await page.getByText(/위치 권한 거부됨/).waitFor();
    await page.getByRole('alert').filter({ hasText: '정확한 위치 권한을 허용해 주세요.' }).waitFor();
    await page.getByRole('button', { name: '위치 연결 다시 시도' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '운행 종료', exact: true }).count(), 0);
  });
  await check('종료 확인 대기·서버 미확인 상태 구분', async page => {
    await page.getByRole('button', { name: '운행 종료', exact: true }).click();
    await page.evaluate(() => window.emitNative({ state: 'off', running: false, transmission: 'stopping' }));
    assert.equal(await page.getByRole('button', { name: '종료 확인 중' }).isDisabled(), true);
    await page.evaluate(() => window.emitNative({ state: 'off', running: false, transmission: 'stop-unknown' }));
    await page.getByText(/기기 위치 수집은 중단됨 · 서버 공유 중단은 확인 필요/).waitFor();
  }, { state: 'active', transmission: 'sent', running: true });
  await check('화면 해제·복귀가 서비스 운행을 종료하거나 재시작하지 않는다', async page => {
    await page.getByRole('button', { name: '운행 종료', exact: true }).waitFor();
    await page.evaluate(() => window.hideDriver()); await page.locator('header').waitFor({ state: 'hidden' });
    await page.evaluate(() => window.mountDriver()); await page.getByRole('button', { name: '운행 종료', exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.nativeCalls.map(x => x.action)), ['snapshot', 'snapshot']);
  }, { state: 'active', transmission: 'sent', running: true });
  await check('강제 중단 후 복귀는 서버 종료 완료로 표시하지 않는다', async page => {
    await page.getByRole('alert').filter({ hasText: '운행 화면에서 다시 시작해 주세요.' }).waitFor();
    assert.equal(await page.getByText(/서버 중단 접수 완료/).count(), 0);
    await page.getByRole('button', { name: '운행 시작', exact: true }).waitFor();
  }, { state: 'error', transmission: 'error', running: false, error: '위치 공유가 중단되었습니다. 운행 화면에서 다시 시작해 주세요.' });
} finally { await browser.close(); await harness.close(); }
await mkdir('.tmp/native-tracking-qa', { recursive: true });
await writeFile('.tmp/native-tracking-qa/native-browser.json', JSON.stringify({ results }, null, 2));
assert.equal(results.every(x => x.pass), true, JSON.stringify(results.filter(x => !x.pass)));
