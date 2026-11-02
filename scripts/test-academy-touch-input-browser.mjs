import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.tmp/academy-touch-input');
await mkdir(out, { recursive: true });
const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
const theme = await readFile(path.join(root, 'src/app/academy-theme.css'), 'utf8');
// 실제 전역 CSS를 컴파일하고 시험 화면의 글씨 유틸리티를 명시한다.
const input = globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none);\n@source inline("text-sm");');
const css = (await postcss([tailwind({ base: root })]).process(input, { from: path.join(root, 'src/app/globals.css') })).css + '\n' + theme;
const fieldSet = prefix => `<input id="${prefix}-input" class="text-sm" type="text" value="합성"><textarea id="${prefix}-textarea" class="text-sm">합성</textarea><select id="${prefix}-select" class="text-sm"><option>합성</option></select>`;
const cases = [], failures = [];
let browser;
try {
  // 사용자 프로필에 연결하지 않는 독립 headless 브라우저다.
  browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  for (const spec of [{ width: 402, touch: true }, { width: 750, touch: true }, { width: 874, touch: true }, { width: 1024, touch: true }, { width: 1440, touch: false }, { width: 402, touch: false }]) {
    for (const mode of ['normal', 'large', 'small-root']) {
      const context = await browser.newContext({ viewport: { width: spec.width, height: 800 }, hasTouch: spec.touch, timezoneId: 'Asia/Seoul' });
      const page = await context.newPage();
      let attemptedRequests = 0;
      await page.route('**/*', route => { attemptedRequests++; return route.abort(); });
      try {
        await page.setContent(`<!doctype html><html class="${mode === 'large' ? 'text-large' : ''}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline';connect-src 'none';font-src 'none';img-src 'none'"></head><body><span id="size-reference" class="text-sm">기준</span><main class="academy-app">${fieldSet('academy')}<input id="academy-checkbox" class="text-sm" type="checkbox"><input id="academy-radio" class="text-sm" type="radio"></main><section>${fieldSet('outside')}</section></body></html>`);
        await page.addStyleTag({ content: css });
        if (mode === 'small-root') await page.evaluate(() => { document.documentElement.style.fontSize = '14px'; });
        const result = await page.evaluate(() => {
          const font = id => parseFloat(getComputedStyle(document.getElementById(id)).fontSize);
          return { root: parseFloat(getComputedStyle(document.documentElement).fontSize), reference: font('size-reference'), coarse: matchMedia('(any-pointer: coarse)').matches, academy: ['input', 'textarea', 'select'].map(tag => font('academy-' + tag)), outside: ['input', 'textarea', 'select'].map(tag => font('outside-' + tag)), checkbox: font('academy-checkbox'), radio: font('academy-radio') };
        });
        assert.equal(result.coarse, spec.touch, '터치 모의 조건 확인');
        const enforced = spec.touch || spec.width <= 600;
        const expected = enforced ? Math.max(result.root, 16) : result.reference;
        for (const font of result.academy) assert.ok(Math.abs(font - expected) < 0.02, `입력 글씨 ${font}, 기대 ${expected}`);
        if (enforced) assert.ok(result.academy.every(font => font >= 16), '터치·좁은 화면 최소 16px');
        if (mode === 'large') assert.equal(result.root, 19, '실제 큰 글씨 모드 유지');
        // 체크·라디오와 학원 밖 요소는 이번 입력 글씨 변경의 대상이 아니다.
        for (const font of [...result.outside, result.checkbox, result.radio]) assert.ok(Math.abs(font - result.reference) < 0.02, '범위 밖 글자 크기 유지');
        assert.equal(attemptedRequests, 0, '외부·운영 요청 없음');
        cases.push({ ...spec, mode, pass: true, ...result, attemptedRequests });
      } catch (error) { failures.push({ ...spec, mode, message: error.message }); }
      finally { await context.close(); }
    }
  }
} finally {
  if (browser) await browser.close();
  await writeFile(path.join(out, 'report.json'), JSON.stringify({ passed: cases.length, failed: failures.length, cases, failures, sourceHashes: { globals: createHash('sha256').update(globals).digest('hex'), theme: createHash('sha256').update(theme).digest('hex') }, limits: ['로컬 Chromium 계산 스타일 검사; iOS 자동확대·네이티브 키보드 가림은 실기기 별도 검증'] }, null, 2));
}
assert.equal(failures.length, 0, JSON.stringify(failures));
assert.equal(cases.length, 18);
console.log(`학원 입력 글씨 계산 스타일 ${cases.length}/18 통과 · 사용자 브라우저/기기/서버 접근 없음`);
