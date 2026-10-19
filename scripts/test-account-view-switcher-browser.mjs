import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

const out = '.tmp/account-view-switcher';
await mkdir(out, { recursive: true });
const globals = await readFile('src/app/globals.css', 'utf8');
const css = (await postcss([tailwind()]).process(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none); @source "./staff"; @source "./admin/AdminShellClient.tsx"; @source "./mypage/layout.tsx"; @source "../components/AccountViewSwitcher.tsx"; @source "../components/PublicAccountControls.tsx"; @source "../components/AppBackButton.tsx"; @source "../components/academy"; @source "../components/ui";'), { from: 'src/app/globals.css' })).css + await readFile('src/app/academy-theme.css', 'utf8') + `
@font-face{font-family:'Material Symbols Outlined';src:url('/material.woff2')}body{margin:0;font-family:system-ui,sans-serif}#root{min-width:0}`;
const fixture = `const p=new URLSearchParams(location.search);const role=p.get('role')||'ADMIN';const hasParent=p.get('own')==='1';const all=[{key:'admin',label:'관리자',href:'/admin'},{key:'teacher',label:'선생님',href:'/staff'},{key:'parent',label:'학부모',href:'/mypage'}];export const views=role==='DRIVER'?[]:all.filter(v=>v.key==='admin'?role==='ADMIN':v.key==='teacher'?role==='ADMIN'||role==='INSTRUCTOR':role==='PARENT'||hasParent);`;
const harness = await startStatusBrowserHarness({ css,
  assets: { '/material.woff2': { body: await readFile('.tmp/staff-header/material-full.woff2'), contentType: 'font/woff2' }, '/stiz-logo.png': await readFile('public/stiz-logo.png') },
  mocks: {
    '@/app/actions/auth': `export function logout(){throw Error('로그아웃 금지')}export function logoutStaff(){throw Error('로그아웃 금지')}`,
    '@/lib/auth-guard': `export async function requireStaff(){return{appUserName:'아주긴이름테스트선생님ABCDEFGHIJ',appUserRole:new URLSearchParams(location.search).get('role')||'ADMIN'}}export async function requireAdmin(){return{appUserName:'검사',email:'',appUserRole:'ADMIN'}}export async function requireVerifiedParent(){return{appUserId:'synthetic-parent'}}`,
    '@/lib/account-view-access': fixture + `export async function getAccountViewAccess(){return{role,views}}`,
    '@/lib/operations-sync/sheetRetirement': `export function isSheetSyncRetired(){return true}`,
    'next/navigation': `export function usePathname(){return new URLSearchParams(location.search).get('path')||'/admin'}export function useRouter(){return{refresh(){},push(){},back(){}}}`,
    'next/image': `import{createElement}from'react';export default function Image({priority,fill,unoptimized,...props}){return createElement('img',props)}`,
    '@/lib/supabase/client': `export function createClient(){return{auth:{onAuthStateChange(fn){(window.testAuthCallbacks ||= []).push(fn);return{data:{subscription:{unsubscribe(){}}}}}}}}`,
  },
  entry: `import React from'react';import{createRoot}from'react-dom/client';import Staff from'@/app/staff/layout';import Parent from'@/app/mypage/layout';import Admin from'@/app/admin/layout';import{DesktopAccountControls,MobileAccountControls}from'@/components/PublicAccountControls';globalThis.process={env:{}};const p=new URLSearchParams(location.search);const mode=p.get('mode');const children=React.createElement('p',{},'격리 역할 화면 검사');const root=createRoot(document.getElementById('root'));if(mode==='public')root.render(React.createElement('div',{},React.createElement(DesktopAccountControls),React.createElement(MobileAccountControls)));else(mode==='staff'?Staff:mode==='parent'?Parent:Admin)({children}).then(tree=>root.render(tree));window.testSaveCalls=0;window.testFailSave=true;window.addEventListener('staff:prepare-navigation',event=>{event.detail.handled=true;window.testSaveCalls++;event.detail.complete(window.testFailSave?{ok:false,message:'합성 저장 실패'}:{ok:true})});`,
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const cases = [];
const check = (name, passed, details) => { cases.push({ name, passed: !!passed, details }); assert.ok(passed, `${name} ${JSON.stringify(details)}`); };
const all = [{ key: 'admin', label: '관리자', href: '/admin' }, { key: 'teacher', label: '선생님', href: '/staff' }, { key: 'parent', label: '학부모', href: '/mypage' }];
async function openPage(params, width, installed = false) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = []; const navigations = [];
  page.on('pageerror', e => errors.push(e.message));
  if (installed) await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== harness.url) return route.abort();
    if (url.pathname === '/api/auth/account-role') return route.fulfill({ json: { role: params.role, views: params.own === '1' ? all : all.slice(0, 2) } });
    if (['/admin', '/mypage', '/staff'].includes(url.pathname)) { navigations.push(url.pathname); return route.fulfill({ contentType: 'text/html', body: '<p>합성 이동 완료</p>' }); }
    return route.continue();
  });
  await page.goto(harness.url + '/?' + new URLSearchParams(params));
  try { await page.locator('#root > *').waitFor(); } catch (error) { console.error(params, errors); throw error; }
  await page.evaluate(async () => { await document.fonts.load('20px "Material Symbols Outlined"'); document.documentElement.classList.add('material-symbols-ready'); });
  return { page, errors, navigations };
}
try {
  for (const width of [320, 390, 834, 1440]) {
    for (const [mode, path] of [['admin', '/admin'], ['staff', '/staff'], ['parent', '/mypage']]) {
      const { page, errors } = await openPage({ mode, path, role: 'ADMIN', own: '1' }, width, mode !== 'admin');
      if (mode === 'admin' && width < 768) await page.getByRole('button', { name: '관리자 메뉴 열기', exact: true }).click();
      if (mode === 'staff') await page.getByRole('button', { name: /메뉴 열기$/ }).click();
      else await page.getByRole('button', { name: '화면 전환', exact: true }).click();
      const nav = page.getByRole('navigation', { name: '이용 화면 전환', exact: true });
      await nav.waitFor();
      const key = `${width}-${mode}`;
      check(`${key} 세 화면·현재 화면 표시`, await nav.getByText('현재 화면', { exact: true }).count() === 1 && await nav.getByRole('link').count() === 2);
      check(`${key} 자기 자녀 화면 링크`, mode === 'parent' ? await nav.locator('[aria-current="page"]').innerText().then(s => s.includes('학부모')) : await nav.getByRole('link', { name: /학부모/ }).getAttribute('href') === '/mypage');
      check(`${key} installed 범위 외 안내`, mode === 'admin' || await nav.getByText('앱 밖의 브라우저 화면으로 이동', { exact: true }).count() === 2);
      const rect = await nav.evaluate(e => { const r = e.getBoundingClientRect(); const p = e.parentElement.getBoundingClientRect(); return { x: r.x, right: r.right, top: r.top, bottom: r.bottom, outerX: p.x, outerRight: p.right, page: document.documentElement.scrollWidth, width: innerWidth, height: innerHeight }; });
      check(`${key} 메뉴가 화면 안·페이지 넘침 없음`, rect.x >= 0 && rect.right <= width + 1 && rect.top >= 0 && rect.bottom <= rect.height && rect.page <= width + 1, rect);
      check(`${key} 메뉴 외곽 여백 유지`, rect.outerX >= 8 && rect.outerRight <= width - 8, rect);
      if (mode === 'staff') check(`${key} 프로필 하단 버튼이 하단 내비보다 위에 표시`, await page.getByRole('link', { name: '설치 안내', exact: true }).evaluate(e => { const r=e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); }));
      check(`${key} 버튼 최소44px`, await nav.locator('a,[aria-current="page"]').evaluateAll(elements => elements.every(e => e.getBoundingClientRect().height >= 44)));
      check(`${key} JS 오류 없음`, errors.length === 0, errors);
      await page.screenshot({ path: `${out}/${key}.png` });
      await page.close();
    }
  }
  for (const [role, own, expected] of [['ADMIN', '0', 2], ['INSTRUCTOR', '0', 1], ['DRIVER', '0', 0]]) {
    const { page } = await openPage({ mode: 'staff', path: '/staff', role, own }, 390);
    await page.getByRole('button', { name: /메뉴 열기$/ }).click();
    const nav = page.getByRole('navigation', { name: '이용 화면 전환', exact: true });
    check(`${role} 자격 없는 학부모 화면 숨김`, await nav.getByRole('link', { name: /학부모/ }).count() === 0 && await nav.count() === (expected > 1 ? 1 : 0));
    await page.close();
  }
  const { page, navigations } = await openPage({ mode: 'staff', path: '/staff/sessions/synthetic', role: 'ADMIN', own: '1' }, 390, true);
  await page.getByRole('button', { name: /메뉴 열기$/ }).click();
  await page.getByRole('navigation', { name: '이용 화면 전환', exact: true }).getByRole('link', { name: /학부모/ }).click();
  await page.getByRole('alertdialog').waitFor();
  check('수업 중 화면 전환 전 확인·아직 이동 안 함', navigations.length === 0 && await page.evaluate(() => window.testSaveCalls) === 0);
  await page.getByRole('button', { name: '저장 후 이동', exact: true }).click();
  await page.getByRole('alert').waitFor();
  check('저장 실패 시 이동 차단·입력 화면 유지', navigations.length === 0 && await page.getByRole('alert').innerText() === '합성 저장 실패');
  await page.evaluate(() => { window.testFailSave = false; });
  await page.getByRole('button', { name: '저장 후 이동', exact: true }).click();
  await page.waitForURL(harness.url + '/mypage');
  check('저장 성공 뒤에만 선택한 자녀 화면으로 이동', navigations.join() === '/mypage');
  await page.close();
  for (const width of [390, 1440]) {
    const { page } = await openPage({ mode: 'public', path: '/', role: 'ADMIN', own: '1' }, width);
    const button = page.getByRole('button', { name: '화면 전환', exact: true }).filter({ visible: true }).first();
    await button.waitFor();
    check(`${width} 기존 계정 링크와 전환 메뉴 중복 없음`, await page.locator('a[href="/admin"]').count() === 0);
    check(`${width} 모바일 전환은 기존 한 셀·행 추가 없음`, await page.locator('[data-account-controls="mobile"]').evaluate(e => {
      const cells=[...e.children];
      return cells.length===3 && getComputedStyle(cells[0]).gridColumn==='auto' && Math.abs(cells[0].getBoundingClientRect().top-cells[1].getBoundingClientRect().top)<1;
    }));
    await button.click();
    const nav = page.getByRole('navigation', { name: '이용 화면 전환', exact: true });
    check(`${width} 공개 계정에 서버 조회한 세 화면 표시`, await nav.getByRole('link').count() === 3);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '화면 전환');
    check(`${width} 메뉴 Escape 닫기·초점 복원`, await nav.count() === 0);
    await page.evaluate(() => window.testAuthCallbacks.forEach(fn => fn('SIGNED_OUT')));
    check(`${width} 로그아웃 후 전환 자격 초기화`, await page.getByRole('button', { name: '화면 전환', exact: true }).count() === 0);
    await page.close();
  }
} finally { await browser.close(); await harness.close(); }
await writeFile(`${out}/browser.json`, JSON.stringify({ source: '원본 관리자/선생/학부모 layout·공통전환·공개계정UI와 실제CSS/로고/폰트. 인증·DB·계정API 응답은 합성, 운영변경/실기기검증 없음.', passed: cases.length, cases }, null, 2));
console.log(`화면 전환 UI ${cases.length}/${cases.length} 통과`);
