import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

const out = '.tmp/staff-header';
await mkdir(out, { recursive: true });
const globals = await readFile('src/app/globals.css', 'utf8');
const css = (await postcss([tailwind()]).process(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none); @source "./staff"; @source "../components/AppBackButton.tsx"; @source "../components/academy"; @source "../components/ui";'), { from: 'src/app/globals.css' })).css + await readFile('src/app/academy-theme.css', 'utf8') + `
@font-face{font-family:'Material Symbols Outlined';src:url('/material.woff2')}body{margin:0;font-family:system-ui,sans-serif}#root{min-width:0}`;
// 실제 아이콘 폰트는 캐시 후 localhost로 제공한다. 운영 계정·API·위치 공유는 연결하지 않는다.
let font;
try { font = await readFile(`${out}/material-full.woff2`); }
catch {
  try { font = await readFile('.tmp/apply-tabs/material-full.woff2'); }
  catch {
    const response = await fetch('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@400');
    assert.ok(response.ok);
    const url = (await response.text()).match(/url\(([^)]+)\)/)?.[1];
    assert.equal(new URL(url).hostname, 'fonts.gstatic.com');
    const data = await fetch(url); assert.ok(data.ok);
    font = Buffer.from(await data.arrayBuffer());
  }
  await writeFile(`${out}/material-full.woff2`, font);
}
const logo = await readFile('public/stiz-logo.png');
const harness = await startStatusBrowserHarness({ css,
  assets: { '/material.woff2': { body: font, contentType: 'font/woff2' }, '/stiz-logo.png': logo },
  mocks: {
    '@/app/actions/auth': `export function logoutStaff(){throw Error('로그아웃 조작 금지')}`,
    '@/lib/auth-guard': `export async function requireStaff(){const p=new URLSearchParams(location.search);return{appUserName:p.get('name')||'김선생',appUserRole:p.get('role')||'INSTRUCTOR'}}`,
    '@/lib/account-view-access': `export async function getAccountViewAccess(){return{role:'INSTRUCTOR',views:[]}}`,
    'next/navigation': `export function usePathname(){return new URLSearchParams(location.search).get('path')||'/staff'}export function useRouter(){return{refresh(){},push(){},back(){}}}`,
    'next/image': `import{createElement}from'react';export default function Image({priority,fill,unoptimized,...props}){return createElement('img',props)}`,
  },
  entry: `import React from'react';import{createRoot}from'react-dom/client';import Layout from'@/app/staff/layout';Layout({children:React.createElement('main',{},'격리 헤더 검사')}).then(tree=>createRoot(document.getElementById('root')).render(tree));`,
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const cases = [];
const check = (name, passed, details) => { cases.push({ name, passed: !!passed, details }); assert.ok(passed, `${name} ${JSON.stringify(details)}`); };
try {
  for (const width of [320, 360, 390, 402, 834, 1440]) {
    for (const [scenario, name, role, path] of [
      ['normal', '김선생', 'INSTRUCTOR', '/staff'],
      ['long', '긴이름확인용농구교실선생님ABCDEFGHIJKLMN', 'INSTRUCTOR', '/staff/students'],
      ['driver', '긴이름확인용기사님ABCDEFGHIJKLMN', 'DRIVER', '/staff/shuttle'],
      ['session', '긴이름확인용농구교실선생님ABCDEFGHIJKLMN', 'INSTRUCTOR', '/staff/sessions/test-session'],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', route => route.request().url().startsWith(harness.url + '/') ? route.continue() : route.abort());
      await page.goto(harness.url + '/?' + new URLSearchParams({ name, role, path }));
      const header = page.locator('header.academy-staff-header');
      await header.waitFor();
      await page.evaluate(async () => { await document.fonts.load('20px "Material Symbols Outlined"'); document.documentElement.classList.add('material-symbols-ready'); });
      const metrics = await header.evaluate(element => {
        const link = element.querySelector('a'); const label = link.querySelector('span');
        const profile = element.querySelector('button[aria-haspopup="dialog"]');
        const name = profile.querySelector('span.block.truncate');
        const range = document.createRange(); range.selectNodeContents(label);
        const l = link.getBoundingClientRect(); const p = profile.getBoundingClientRect();
        const n = name.getBoundingClientRect();
        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, labelLines: range.getClientRects().length,
          labelHeight: label.getBoundingClientRect().height, headerHeight: element.getBoundingClientRect().height,
          gap: p.left - l.right, profileWidth: p.width, profileHeight: p.height, profileRight: p.right,
          nameWidth: n.width, nameOverflow: getComputedStyle(name).textOverflow, nameWhiteSpace: getComputedStyle(name).whiteSpace,
          chevronVisible: profile.lastElementChild.getBoundingClientRect().width > 0,
          logoLoaded: link.querySelector('img').naturalWidth > 0 };
      });
      const key = `${width}-${scenario}`;
      check(`${key} 문구 한 줄·헤더 높이 일정`, metrics.labelLines === 1 && metrics.labelHeight < 24 && metrics.headerHeight <= 80, metrics);
      check(`${key} 페이지 넘침·헤더 겹침 없음`, metrics.documentWidth <= width && metrics.gap >= 7 && metrics.profileRight <= width - 15, metrics);
      check(`${key} 이름 말줄임·전체 이름 접근`, metrics.nameWidth > 0 && metrics.nameOverflow === 'ellipsis' && metrics.nameWhiteSpace === 'nowrap' && await header.getByRole('button', { name: `${name} ${role === 'DRIVER' ? '기사님' : '선생님'} 메뉴 열기`, exact: true }).count() === 1, metrics);
      check(`${key} 실제 로고·48px 메뉴 유지`, metrics.logoLoaded && metrics.profileHeight >= 48 && metrics.profileWidth >= 44, metrics);
      check(`${key} 작은 화면 화살표 숨김 유지`, metrics.chevronVisible === (width >= 640), metrics);
      await header.getByRole('button', { name: /메뉴 열기$/ }).click();
      await page.getByRole('dialog').waitFor();
      check(`${key} 메뉴 열기·키보드 닫기`, await page.getByRole('dialog').isVisible());
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.activeElement?.matches('header button[aria-haspopup="dialog"]'));
      check(`${key} 초점 복원·JS 오류 없음`, await header.getByRole('button', { name: /메뉴 열기$/ }).evaluate(e => e === document.activeElement) && errors.length === 0, errors);
      await page.screenshot({ path: `${out}/${key}.png` });
      await page.close();
    }
  }
} finally { await browser.close(); await harness.close(); }
await writeFile(`${out}/browser.json`, JSON.stringify({ source: '원본 async StaffLayout 직접호출/StaffHomeLink/StaffProfileMenu/AppBackButton/실제 Tailwind·Academy CSS·공식 로고·Material 폰트. 인증 응답만 합성, Next hydration·실기기 검증 아님.', passed: cases.length, cases }, null, 2));
console.log(`선생님 공통 헤더 ${cases.length}/${cases.length} 통과`);
