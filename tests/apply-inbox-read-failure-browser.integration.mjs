import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from './helpers/status-browser-harness.mjs';

function blockedActions(names) {
  return names.map(name => `export function ${name}() { throw new Error('격리 화면에서 허용하지 않은 처리'); }`).join('\n');
}

const harness = await startStatusBrowserHarness({
  mocks: {
    '@/app/actions/admin': blockedActions([
      'addToWaitlist', 'approveEnrollApplication', 'cancelEnrollApplication', 'confirmTrialFeePayment',
      'createTrialLead', 'getEnrollmentParentCandidates', 'linkEnrollApplicationToTrialLead',
      'offerWaitlistSpot', 'processWaitlistResponse', 'recordApplicationContact', 'rejectEnrollApplication',
      'removeFromWaitlist', 'reopenEnrollApplicationForReview', 'resendTrialApplicationSms',
      'sendManualSms', 'sendPostTrialEnrollGuide', 'sendTrialCoachNotice', 'updateAcademySettings',
      'updateEnrollApplication', 'updateTrialLead',
    ]) + '\nexport async function getEnrollTrialLinkSuggestions() { return {}; }',
    '@/app/actions/trial-fee': blockedActions([
      'getTrialFeeAdminState', 'previewTrialGuides', 'refundTrialFee', 'updateTrialFeePaymentSettings', 'updateTrialGuideAutomation',
    ]),
    '@/app/actions/student-register': blockedActions([
      'getStudentRegisterOptions', 'previewStudentRegistration', 'registerStudent',
    ]),
  },
  entry: `import {createElement} from 'react';
    import {createRoot} from 'react-dom/client';
    import Apply from '@/app/admin/apply/ApplyAdminClient';
    const mode = new URLSearchParams(location.search).get('mode');
    createRoot(document.getElementById('root')).render(createElement(Apply, {mode}));`,
});

let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
  });
  for (const mode of ['applications', 'settings']) {
    const page = await browser.newPage();
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, new URL(harness.url).origin);
      if (url.pathname === '/' || url.pathname === '/bundle.js') return route.continue();
      assert.equal(url.pathname, mode === 'applications' ? '/api/admin/apply' : '/api/admin/apply/source-stats');
      requests.push(url.searchParams.get('range') ?? 'applications');
      if (requests.length === 1) return route.fulfill({ status: 503, json: {} });
      const payload = mode === 'applications'
        ? { applications: [], classes: [], stats: { PENDING: 0, total: 0 } }
        : { range: url.searchParams.get('range'), rows: [], totals: { total: 0 } };
      return route.fulfill({ status: 200, json: payload });
    });
    await page.goto(`${harness.url}/?mode=${mode}`);
    const retry = page.getByRole('button', { name: '다시 시도', exact: true });
    await retry.waitFor();
    // 오류 화면을 유지하는 동안 추가 요청이 없어야 한다.
    await delay(250);
    assert.equal(requests.length, 1);
    await retry.click();
    await retry.waitFor({ state: 'hidden' });
    if (mode === 'settings') {
      await page.getByText('전체 접수', { exact: true }).waitFor();
      await Promise.all([
        page.waitForResponse(response => response.url().includes('range=THIS_MONTH')),
        page.locator('select').selectOption('THIS_MONTH'),
      ]);
      assert.deepEqual(requests, ['30D', '30D', 'THIS_MONTH']);
    } else {
      await page.getByPlaceholder('학생, 보호자, 전화번호로 검색').waitFor();
      assert.deepEqual(requests, ['applications', 'applications']);
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`PASS ${mode} 조회 실패 표시·반복 호출 차단·재시도`);
  }
} finally {
  await browser?.close();
  await harness.close();
}
