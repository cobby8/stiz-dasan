import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

const out = '.tmp/apply-tabs';
await mkdir(out, { recursive: true });
let font;
try { font = await readFile(`${out}/material-full.woff2`); }
catch {
  const response = await fetch('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@400');
  assert.ok(response.ok);
  const url = (await response.text()).match(/url\(([^)]+)\)/)?.[1];
  assert.equal(new URL(url).hostname, 'fonts.gstatic.com');
  const data = await fetch(url); assert.ok(data.ok);
  font = Buffer.from(await data.arrayBuffer()); await writeFile(`${out}/material-full.woff2`, font);
}
const globals = await readFile('src/app/globals.css', 'utf8');
const css = (await postcss([tailwind()]).process(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none); @source "./admin/apply"; @source "./admin/AdminShellClient.tsx"; @source "../components/academy"; @source "../components/ui"; @source "../components/AppBackButton.tsx";'), { from: 'src/app/globals.css' })).css + await readFile('src/app/academy-theme.css', 'utf8') + `
@font-face{font-family:'Material Symbols Outlined';src:url('/material.woff2')}body{margin:0;font-family:system-ui,sans-serif}.test-shell{min-width:0;padding:16px}#root{min-width:0}`;
const harness = await startStatusBrowserHarness({ css,
  assets: { '/material.woff2': { body: font, contentType: 'font/woff2' } },
  mocks: { '@/app/actions/auth': `export function logout(){throw Error('로그아웃 조작 금지')}`, 'next/navigation': `export function usePathname(){return'/admin/apply'}export function useRouter(){return{refresh(){},push(){},back(){}}}`, '@/app/actions/admin': `export function recordApplicationContact(){throw Error('운영 쓰기 금지')}export function sendManualSms(){throw Error('외부 발송 금지')}` },
  entry: `import React from'react';import{createRoot}from'react-dom/client';import Apply from'@/app/admin/apply/ApplyAdminClient';import Shell from'@/app/admin/AdminShellClient';createRoot(document.getElementById('root')).render(React.createElement(Shell,{initialUserName:'검사 관리자',initialUserEmail:''},React.createElement(Apply,{initialApplications:[],initialClasses:[],initialStats:{PENDING:7,APPROVED:0,REJECTED:0,CANCELLED:0,total:7},initialTrialLeads:[],initialTrialClasses:[],initialTrialStats:{NEW:3}})));`,
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const cases = [];
const check = (name, actual, details) => { cases.push({ name, passed: !!actual, details }); assert.ok(actual, name + (details ? ` ${JSON.stringify(details)}` : '')); };
try {
  for (const width of [320, 360, 390, 834, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: width > 800 ? 1000 : 844 }, hasTouch: width < 1000 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      if (!url.startsWith(harness.url + '/')) return route.abort();
      if (url.includes('/api/')) return route.fulfill({ status: 503, json: { error: '격리 조회 검사' } });
      return route.continue();
    });
    await page.goto(harness.url);
    const menu = page.getByRole('group', { name: '신청 관리 메뉴', exact: true });
    await menu.waitFor();
    await page.evaluate(async () => { await document.fonts.load('18px "Material Symbols Outlined"'); document.documentElement.classList.add('material-symbols-ready'); });
    const layout = await menu.evaluate(element => ({
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
      overflow: getComputedStyle(element).overflowX,
      tabs: [...element.querySelectorAll('button')].map(button => {
        const rect = button.getBoundingClientRect();
        const textRects = [...button.childNodes].filter(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()).flatMap(node => { const range = document.createRange(); range.selectNode(node); return [...range.getClientRects()].map(r => ({ y: r.y, height: r.height })); });
        return { width: rect.width, height: rect.height, whiteSpace: getComputedStyle(button).whiteSpace, textLines: new Set(textRects.map(r => Math.round(r.y))).size };
      }),
    }));
    check(`${width} 페이지 가로 넘침 없음`, layout.documentWidth <= width + 1, layout);
    check(`${width} 다섯 메뉴 모두 한 줄·44px`, layout.tabs.length === 5 && layout.tabs.every(tab => tab.whiteSpace === 'nowrap' && tab.textLines === 1 && tab.height >= 44 && tab.width >= 44), layout.tabs);
    check(`${width} 메뉴 내부에서만 가로 스크롤`, layout.overflow === 'auto' && (width > 390 || layout.scrollWidth > layout.clientWidth), layout);
    check(`${width} 기존 알림 숫자 유지`, await menu.getByText('3', { exact: true }).count() === 1 && await menu.getByText('7', { exact: true }).count() === 1);
    for (const name of ['체험 문의', '수강신청', '대기자', '유입 통계', '안내 설정']) {
      const button = menu.getByRole('button', { name: new RegExp(name) });
      await button.scrollIntoViewIfNeeded(); await button.click();
      check(`${width} ${name} 실제 선택 상태`, await button.getAttribute('aria-pressed') === 'true' && await menu.locator('[aria-pressed="true"]').count() === 1);
      check(`${width} ${name} 선택 후 window 넘침 없음`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await menu.locator('button').last().focus();
    await page.keyboard.press('Shift+Tab');
    const focused = menu.getByRole('button', { name: '유입 통계', exact: true });
    check(`${width} 키보드 초점 이동 유지`, await focused.evaluate(element => document.activeElement === element));
    await page.keyboard.press('Enter');
    check(`${width} 키보드 실제 선택`, await focused.getAttribute('aria-pressed') === 'true');
    await menu.locator('button').first().focus();
    await page.keyboard.press('Enter');
    await menu.evaluate(element => { element.scrollLeft = 0; });
    await page.screenshot({ path: `${out}/${width}-first.png`, fullPage: true });
    await menu.locator('button').last().scrollIntoViewIfNeeded();
    await menu.locator('button').last().click();
    await page.waitForFunction(() => document.querySelector('[aria-label="신청 관리 메뉴"] button:last-child')?.getAttribute('aria-pressed') === 'true');
    const visible = await menu.locator('button').last().evaluate(element => { const r = element.getBoundingClientRect(); const p = element.parentElement.getBoundingClientRect(); return r.right <= p.right + 1 && r.left >= p.left - 1; });
    check(`${width} 마지막 메뉴 끝까지 접근 가능`, visible);
    await page.screenshot({ path: `${out}/${width}-last.png`, fullPage: true });
    check(`${width} JS 오류 없음`, errors.length === 0, errors);
    await page.close();
  }
} finally { await browser.close(); await harness.close(); }
await writeFile(`${out}/browser.json`, JSON.stringify({ source: '원본 AdminShellClient/AcademyTheme/ApplyAdminClient·실제 Tailwind/학원 CSS·로컬 Material 폰트·하위 지연 화면 격리·API 합성503', passed: cases.length, cases }, null, 2));
console.log(`신청 관리 탭 ${cases.length}/${cases.length} 통과`);
