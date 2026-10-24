import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

const require = createRequire(import.meta.url);
const ts = require('typescript');
async function serverProps(kind, payload) {
  const source = await readFile(new URL(`../src/app/admin/${kind}/page.tsx`, import.meta.url), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const sandbox = { exports: {}, require(name) {
    if (name === 'react/jsx-runtime') return require(name);
    if (name === '@/lib/adminReadPayloads') return { getCachedAdminSettingsPayload: async () => payload };
    if (name.endsWith('AdminClient')) return { default: () => null };
    throw new Error(`격리 SSR에서 허용하지 않는 모듈: ${name}`);
  } };
  vm.runInNewContext(code, sandbox);
  return (await sandbox.exports.default()).props;
}

const harness = await startStatusBrowserHarness({
  mocks: {
    'next/dynamic': `import React from'react';export default function dynamic(){return function ActualEditor(props){return React.createElement(window.__RichTextEditor,props);};}`,
    '@/app/actions/admin': `export function updateAcademySettings(data){window.__actions.push(data);return new Promise((resolve,reject)=>{window.__settleAction=ok=>ok?resolve():reject(new Error('합성 저장 실패'));});}`,
  },
  entry: `import React from 'react';import RichTextEditor from'@/components/RichTextEditor';window.__RichTextEditor=RichTextEditor;import{createRoot}from'react-dom/client';import Settings from'@/app/admin/settings/AdminSettingsClient';import Privacy from'@/app/admin/privacy/PrivacyAdminClient';import Terms from'@/app/admin/terms/TermsAdminClient';const Component={settings:Settings,privacy:Privacy,terms:Terms}[window.__kind];const root=createRoot(document.getElementById('root'));window.__render=props=>root.render(React.createElement(Component,props));window.__render(window.__props);`,
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const cases = [];
async function open(kind, props = {}) {
  const page = await browser.newPage();
  await page.addInitScript(({ kind, props }) => {
    window.__kind = kind; window.__props = props; window.__actions = []; window.__loads = 0;
    window.confirm = () => true;
    window.fetch = (url) => {
      if (url !== '/api/admin/settings') return Promise.reject(new Error('운영 통신 차단'));
      window.__loads++;
      return new Promise(resolve => { window.__settleLoad = (status, data) => resolve({ ok: status >= 200 && status < 300, json: async () => data }); });
    };
  }, { kind, props });
  await page.route('**/*', route => route.request().url().startsWith(harness.url + '/') ? route.continue() : route.abort());
  await page.goto(harness.url);
  return page;
}
async function check(name, fn) { await fn(); cases.push({ name, passed: true }); }
try {
  const settings = await open('settings', { initialSettings: { introductionTitle: '기존 제목' } });
  const input = settings.locator('input[name="introductionTitle"]');
  await input.fill('수정 제목 보존');
  await settings.getByRole('button', { name: '저장하기', exact: true }).click();
  await settings.waitForFunction(() => window.__actions.length === 1);
  await check('기본설정 서버 응답 전 완료 표시 없음·저장 중·입력 잠금', async () => {
    assert.equal(await settings.getByText('✓ 저장되었습니다.', { exact: false }).count(), 0);
    assert.equal(await settings.getByRole('button', { name: '저장 중...', exact: true }).isDisabled(), true);
    assert.equal(await input.isDisabled(), true);
  });
  await settings.locator('form').evaluate(form => form.requestSubmit());
  await check('기본설정 강제 중복 제출도 저장 요청 한 번', async () => assert.equal(await settings.evaluate(() => window.__actions.length), 1));
  await settings.evaluate(() => window.__settleAction(false));
  await settings.getByText('⚠ 합성 저장 실패').waitFor();
  await check('기본설정 실패 시 비제어 입력 보존·재시도 가능', async () => {
    assert.equal(await input.inputValue(), '수정 제목 보존');
    assert.equal(await input.isDisabled(), false);
    assert.equal(await settings.getByText('✓ 저장되었습니다.', { exact: false }).count(), 0);
  });
  await settings.getByRole('button', { name: '저장하기', exact: true }).click();
  await settings.waitForFunction(() => window.__actions.length === 2);
  await settings.evaluate(() => window.__settleAction(true));
  await settings.getByText('✓ 저장되었습니다.', { exact: false }).waitFor();
  await check('기본설정 성공 확인 뒤 완료 표시·수정값 전달', async () => {
    assert.equal(await settings.evaluate(() => window.__actions[1].introductionTitle), '수정 제목 보존');
    assert.equal(await input.inputValue(), '수정 제목 보존');
  });
  await settings.getByText('원장 인사말 / 학원 소개', { exact: true }).scrollIntoViewIfNeeded();
  const editor = settings.locator('.ProseMirror').first();
  await editor.waitFor();
  await editor.fill('원본 Tiptap 본문 수정');
  await check('실제 Tiptap 수정 시 이전 저장 완료 표시 제거', async () => assert.equal(await settings.getByText('✓ 저장되었습니다.', { exact: false }).count(), 0));
  await settings.getByRole('button', { name: '저장하기', exact: true }).click();
  await settings.waitForFunction(() => window.__actions.length === 3);
  const beforeLock = await editor.innerHTML();
  await editor.evaluate(element => element.focus());
  await settings.keyboard.type('잠금 중 입력 금지');
  await check('저장 중 inert로 실제 Tiptap 키보드 편집 차단', async () => {
    assert.equal(await editor.innerHTML(), beforeLock);
    assert.equal(await settings.locator('form').evaluate(form => form.inert), true);
  });
  await settings.evaluate(() => window.__settleAction(true));
  await settings.getByText('✓ 저장되었습니다.', { exact: false }).waitFor();
  await check('실제 Tiptap 본문 저장 전달 확인', async () => assert.match(await settings.evaluate(() => window.__actions[2].introductionText), /원본 Tiptap 본문 수정/));
  await input.fill('다음 수정');
  await check('기본설정 재편집 시 이전 완료 표시 제거', async () => assert.equal(await settings.getByText('✓ 저장되었습니다.', { exact: false }).count(), 0));
  await settings.close();

  for (const kind of ['privacy', 'terms']) {
    const key = kind === 'privacy' ? 'privacyPolicy' : 'termsOfService';
    const ssrFailureProps = await serverProps(kind, { settings: null, fetchError: true });
    assert.equal(ssrFailureProps.fetchError, true);
    const ssrFailure = await open(kind, ssrFailureProps);
    await ssrFailure.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor();
    await check(`${kind} 실제 SSR 조회 실패 props 전달·저장 잠금`, async () => {
      assert.equal(await ssrFailure.getByRole('button', { name: '저장', exact: true }).isDisabled(), true);
      assert.equal(await ssrFailure.evaluate(() => window.__loads), 0);
    });
    await ssrFailure.getByRole('button', { name: '다시 불러오기', exact: true }).click();
    await ssrFailure.waitForFunction(() => window.__loads === 1);
    await ssrFailure.evaluate(key => window.__settleLoad(200, { settings: { [key]: 'SSR retry canonical' } }), key);
    await ssrFailure.waitForFunction(() => document.querySelector('textarea')?.value === 'SSR retry canonical');
    await check(`${kind} SSR 실패 후 재조회 성공까지 저장 잠금 유지`, async () => assert.equal(await ssrFailure.getByRole('button', { name: '저장', exact: true }).isDisabled(), false));
    await ssrFailure.close();
    const page = await open(kind);
    await page.waitForFunction(() => window.__loads === 1);
    await page.evaluate(() => window.__settleLoad(503, {}));
    const textarea = page.locator('textarea');
    await page.getByRole('alert').filter({ hasText: '현재 내용을 불러오지 못했습니다' }).waitFor();
    const original = await textarea.inputValue();
    await check(`${kind} 조회 503 시 저장·편집 잠금`, async () => {
      assert.equal(await page.getByRole('button', { name: '저장', exact: true }).isDisabled(), true);
      assert.equal(await textarea.isDisabled(), true);
      assert.equal(await page.evaluate(() => window.__actions.length), 0);
    });
    await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
    await page.waitForFunction(() => window.__loads === 2);
    await page.evaluate(() => window.__settleLoad(200, { fetchError: true, settings: null }));
    await page.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor();
    await check(`${kind} 200 fetchError도 실패로 처리·기존 내용 보존`, async () => {
      assert.equal(await textarea.inputValue(), original);
      assert.equal(await page.getByRole('button', { name: '저장', exact: true }).isDisabled(), true);
    });
    await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
    await page.waitForFunction(() => window.__loads === 3);
    await page.evaluate(key => window.__settleLoad(200, { settings: { [key]: '서버 정본 내용' } }), key);
    await page.waitForFunction(() => document.querySelector('textarea')?.value === '서버 정본 내용');
    await check(`${kind} 조회 재시도 성공 후 정본 표시·저장 허용`, async () => assert.equal(await textarea.isDisabled(), false));
    await textarea.fill('작성 중인 정책 내용');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.waitForFunction(() => window.__actions.length === 1);
    await check(`${kind} 저장 응답 전 완료 없음·중복 잠금`, async () => {
      assert.equal(await page.getByText('저장됨', { exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '저장 중...', exact: true }).isDisabled(), true);
      assert.equal(await textarea.isDisabled(), true);
    });
    await page.evaluate(() => window.__settleAction(false));
    await page.getByRole('alert').filter({ hasText: '합성 저장 실패' }).waitFor();
    await check(`${kind} 저장 실패 시 작성 내용 보존`, async () => assert.equal(await textarea.inputValue(), '작성 중인 정책 내용'));
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.waitForFunction(() => window.__actions.length === 2);
    await page.evaluate(() => window.__settleAction(true));
    await page.getByText('저장됨', { exact: true }).waitFor();
    await check(`${kind} 재저장 성공 확인 뒤에만 완료`, async () => assert.equal(await page.evaluate(key => window.__actions[1][key], key), '작성 중인 정책 내용'));
    await page.close();

    const draft = await open(kind, { [key]: 'existing policy' });
    await draft.locator('textarea').fill('unsaved draft');
    await draft.evaluate(() => window.__render({}));
    await draft.waitForFunction(() => window.__loads === 1);
    await draft.evaluate(() => window.__settleLoad(503, {}));
    await draft.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor();
    await check(`${kind} 재조회 실패도 실제 작성 중 초안 보존`, async () => {
      assert.equal(await draft.locator('textarea').inputValue(), 'unsaved draft');
      assert.equal(await draft.getByRole('button', { name: '저장', exact: true }).isDisabled(), true);
    });
    await draft.close();

    const empty = await open(kind);
    await empty.waitForFunction(() => window.__loads === 1);
    await empty.evaluate(key => window.__settleLoad(200, { settings: { [key]: '' } }), key);
    await empty.locator('textarea').waitFor();
    await check(`${kind} 정상 조회 빈 정책의 기존 기본값 기준 유지`, async () => {
      const value = await empty.locator('textarea').inputValue();
      assert.equal(value.length > 0, kind === 'privacy');
      assert.equal(await empty.getByRole('button', { name: '저장', exact: true }).isDisabled(), false);
    });
    await empty.close();
  }
  await mkdir('.tmp/admin-save-safety', { recursive: true });
  await writeFile('.tmp/admin-save-safety/browser.json', JSON.stringify({ passed: cases.length, source: '실제 원본 클라이언트·합성 조회/저장 응답·운영 연결 없음', cases }, null, 2));
  console.log(`관리자 저장 안전성 ${cases.length}/${cases.length} 통과`);
} finally { await browser.close(); await harness.close(); }
