import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

const out = '.tmp/admin-short-sidebar';
await mkdir(out, { recursive: true });
const globals = await readFile('src/app/globals.css', 'utf8');
const css = (await postcss([tailwind()]).process(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none); @source "./admin/AdminShellClient.tsx"; @source "../components/AccountViewSwitcher.tsx"; @source "../components/AppBackButton.tsx"; @source "../components/academy"; @source "../components/ui";'), { from: 'src/app/globals.css' })).css + await readFile('src/app/academy-theme.css', 'utf8') + `
@font-face{font-family:'Material Symbols Outlined';src:url('/material.woff2')}body{margin:0;font-family:system-ui,sans-serif}#root{min-width:0}`;
const harness = await startStatusBrowserHarness({ css,
  assets: { '/material.woff2': { body: await readFile('.tmp/staff-header/material-full.woff2'), contentType: 'font/woff2' }, '/stiz-logo.png': await readFile('public/stiz-logo.png') },
  mocks: {
    '@/app/actions/auth': `export function logout(){throw Error('로그아웃 실행 금지')}`,
    'next/navigation': `export function usePathname(){return'/admin'}export function useRouter(){return{refresh(){},push(){},back(){}}}`,
    'next/image': `import{createElement}from'react';export default function Image({priority,fill,unoptimized,...props}){return createElement('img',props)}`,
  },
  entry: `import React from'react';import{createRoot}from'react-dom/client';import Shell from'@/app/admin/AdminShellClient';const views=[{key:'admin',label:'관리자',href:'/admin'},{key:'teacher',label:'선생님',href:'/staff'},{key:'parent',label:'학부모',href:'/mypage'}];createRoot(document.getElementById('root')).render(React.createElement(Shell,{initialUserName:'긴이름관리자검사',initialUserEmail:'',accountViews:views},React.createElement('p',{},'격리 메뉴 검사')));`,
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const cases = [];
const check = (name, passed, details) => { cases.push({ name, passed: !!passed, details }); assert.ok(passed, `${name} ${JSON.stringify(details)}`); };
try {
  for (const [width, height] of [[750,292],[874,402],[402,714],[390,844],[834,1112],[1440,900]]) {
    const page = await browser.newPage({ viewport: { width, height }, hasTouch: true });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', route => route.request().url().startsWith(harness.url + '/') ? route.continue() : route.abort());
    await page.goto(harness.url);
    const aside = page.locator('aside');
    if (width < 768) await page.getByRole('button', { name: '관리자 메뉴 열기', exact: true }).click();
    await aside.waitFor();
    await page.evaluate(async () => { await document.fonts.load('20px "Material Symbols Outlined"'); document.documentElement.classList.add('material-symbols-ready'); });
    const key = `${width}x${height}`;
    const metrics = await aside.evaluate(e => {
      const nav=e.querySelector('nav'); const children=[...e.children].map(n=>({height:n.getBoundingClientRect().height}));
      return { children, navHeight:nav.clientHeight, navScroll:nav.scrollHeight, asideHeight:e.getBoundingClientRect().height, pageWidth:document.documentElement.scrollWidth, viewport:innerWidth };
    });
    check(`${key} 업무 명단 공간 확보`, metrics.navHeight >= (height <= 450 ? height - 165 : height - 340), metrics);
    check(`${key} 사이드바 뷰포트 높이·가로 넘침 없음`, Math.abs(metrics.asideHeight - height) < 2 && metrics.pageWidth <= width, metrics);
    if (height <= 450) check(`${key} 로고·탭·계정 공간 절약`, metrics.children[0].height <= 48 && metrics.children[1].height <= 48 && metrics.children.at(-1).height <= 66, metrics);
    else check(`${key} 기존 로고 크기 보존`, await aside.locator('img').evaluate(e => Math.abs(e.getBoundingClientRect().height - 54) < 1));
    const nav=aside.locator('nav').first();
    for (const tab of ['사이트', '학원운영']) {
      const button=aside.getByRole('button',{name:tab,exact:true}); await button.click();
      if (height <= 450) check(`${key} ${tab} 탭 44px`, await button.evaluate(e => e.getBoundingClientRect().height >= 44));
      await nav.locator('details').evaluateAll(elements => elements.forEach(e => { e.open=true; }));
      const links=nav.getByRole('link'); const count=await links.count();
      const reached=[];
      for (let i=0;i<count;i++) {
        const link=links.nth(i); await link.scrollIntoViewIfNeeded();
        reached.push(await link.evaluate(e => { const r=e.getBoundingClientRect(); const n=e.closest('nav').getBoundingClientRect();return{href:e.getAttribute('href'),height:r.height,inside:r.top>=n.top-1&&r.bottom<=n.bottom+1,topmost:e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}; }));
      }
      check(`${key} ${tab} 모든 업무 메뉴 스크롤·터치 접근`, count > 10 && reached.every(r=>r.inside&&r.topmost), reached);
      if (height <= 450) check(`${key} ${tab} 업무 버튼 44px`, reached.every(r=>r.height >= 44), reached);
    }
    await aside.getByRole('button',{name:'화면 전환',exact:true}).click();
    const switcher=aside.getByRole('navigation',{name:'이용 화면 전환',exact:true});
    await switcher.waitFor();
    check(`${key} 화면 전환 세 역할·현재표시 유지`, await switcher.getByRole('link').count()===2&&await switcher.locator('[aria-current="page"]').count()===1);
    check(`${key} 화면 전환 메뉴 가림 없음`, await switcher.evaluate(e => {const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth;}));
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='화면 전환');
    check(`${key} 바닥 전환·로그아웃 터치 접근`, await aside.getByRole('button',{name:'로그아웃',exact:true}).evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));}));
    await page.screenshot({ path:`${out}/${key}.png` });
    check(`${key} JS 오류 없음`, errors.length===0,errors);
    await page.close();
  }
} finally { await browser.close(); await harness.close(); }
await writeFile(`${out}/browser.json`,JSON.stringify({source:'원본 AdminShellClient/공통전환/실제 Tailwind·Academy CSS·공식 로고·Material폰트, 외부 API/인증/운영/물리기기 미사용',passed:cases.length,cases},null,2));
console.log(`관리자 짧은 사이드바 ${cases.length}/${cases.length} 통과`);
