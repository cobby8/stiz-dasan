import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from './helpers/status-browser-harness.mjs';

const harness = await startStatusBrowserHarness({
  mocks: { '@/app/actions/admin': `
    async function call(name,args){const response=await fetch('/test-actions/'+name,{method:'POST',body:JSON.stringify(args)});if(!response.ok)throw new Error('격리 오류');return response.json();}
    export function updateRequestStatus(...args){return call('update',args);}
    export function getParentRequestStatusForAdmin(...args){return call('read',args);}
    export function deleteParentRequest(...args){return call('delete',args);}` },
  entry: `import {createElement} from 'react';import {createRoot} from 'react-dom/client';import Requests from '@/app/admin/requests/RequestsAdminClient';createRoot(document.getElementById('root')).render(createElement(Requests,window.__testProps));`,
});
const browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const request = { id: 'request-test', userId: 'parent-test', studentId: 'student-test', type: 'OTHER', title: '검사용 문의', content: '일정 상담', date: null, status: 'PENDING', adminNote: '기존 메모', createdAt: '2026-10-19', updatedAt: '2026-10-19', studentName: '검사용 학생', parentName: '검사용 보호자', parentPhone: null };
try {
  for (const lost of [false, true]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(value => { window.__testProps = value; }, { requests: [request] });
    const calls = []; const errors = [];
    await context.route('**/*', async route => {
      const req = route.request(); const url = new URL(req.url());
      assert.equal(url.origin, new URL(harness.url).origin);
      if (url.pathname === '/' || url.pathname === '/bundle.js') return route.continue();
      calls.push(url.pathname);
      const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
      if (url.pathname === '/test-actions/update') {
        if (lost) return route.abort();
        return json({ saved: true, notification: 'REGISTERED', push: 'NO_SUBSCRIPTION' });
      }
      if (url.pathname === '/test-actions/read') return json({ ...request, status: 'COMPLETED', adminNote: '수정한 답변' });
      if (url.pathname === '/api/admin/requests') return json({ requests: [{ ...request, status: 'COMPLETED', adminNote: '수정한 답변' }] });
      throw new Error(`예상하지 않은 격리 요청: ${url.pathname}`);
    });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(harness.url);
    // 목록 개편 6단계: 펼침 버튼 → 한 줄 행 클릭 = 상세 패널(답변·상태 변경·재조회·삭제는 패널 안 그대로)
    await page.getByRole('row', { name: /검사용 문의/ }).click();
    await page.locator('textarea').fill('수정한 답변');
    await page.getByRole('button', { name: '상담 종결', exact: true }).click();
    if (lost) {
      await page.getByText(/저장 응답을 확인하지 못했습니다/).waitFor();
      assert.equal(await page.locator('textarea').inputValue(), '수정한 답변');
      assert.equal(await page.locator('textarea').isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: '삭제', exact: true }).isDisabled(), true);
      await page.getByRole('button', { name: '저장 상태 다시 조회' }).click();
      await page.getByText(/상담 상태 저장을 확인했습니다/).waitFor();
      assert.equal(calls.filter(path => path === '/test-actions/update').length, 1);
      assert.equal(calls.filter(path => path === '/test-actions/read').length, 1);
    } else {
      await page.getByText(/상담 상태 저장 완료 · 사이트 알림 등록 완료 · 푸시 미등록/).waitFor();
      assert.equal(calls.filter(path => path === '/test-actions/update').length, 1);
    }
    assert.deepEqual(errors, []);
    await context.close();
    console.log(`PASS 일반요청 실제 React ${lost ? '응답 유실→잠금·메모 보존→저장 재조회' : '저장·알림 등록·푸시 미등록 분리'}`);
  }
} finally { await browser.close(); await harness.close(); }
