import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

// 실제 화면·CSS·시계 hook을 실행한다. 운영 DB·GPS·전화·지도 앱은 실행하지 않는다.
const theme = await readFile('src/app/academy-theme.css', 'utf8');
const globals = await readFile('src/app/globals.css', 'utf8');
// 외부 폰트는 준비 단계에서 한 번만 받아 격리 서버에서 제공한다. 브라우저는 외부에 접속하지 않는다.
let iconFont;
try { iconFont = await readFile('.tmp/driver-material-font.woff2'); }
catch {
  await mkdir('.tmp', { recursive: true });
  const response = await fetch('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@400&icon_names=call,close,location_disabled,location_off,location_searching,my_location,near_me');
  assert.ok(response.ok, '검사용 아이콘 폰트 안내를 읽지 못했습니다');
  const url = (await response.text()).match(/url\(([^)]+)\)/)?.[1];
  assert.equal(new URL(url).hostname, 'fonts.gstatic.com');
  const font = await fetch(url); assert.ok(font.ok, '검사용 아이콘 폰트를 읽지 못했습니다');
  iconFont = Buffer.from(await font.arrayBuffer()); await writeFile('.tmp/driver-material-font.woff2', iconFont);
}
const css = (await postcss([tailwind()]).process(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none); @source "../components/shuttle"; @source "../components/academy";'), { from: 'src/app/globals.css' })).css + theme + `
@font-face{font-family:'Material Symbols Outlined';src:url('/material.woff2')}.material-symbols-outlined{font-size:18px}body{margin:0;font-family:system-ui,sans-serif}`;
const rider = (key, name, extra = {}) => ({ key, checkId: key, name, grade: '초4', kind: 'REGULAR', direction: 'PICKUP', parentPhone: '00000000000', studentPhone: '00000000001', absent: false, ...extra });
const stop = (key, label, time, riders, extra = {}) => ({ key, label, time, minutes: Number(time.slice(0, 2)) * 60 + Number(time.slice(3)), seq: 0, kind: 'REGULAR', direction: 'PICKUP', groupKey: 'synthetic', groupLabel: '15:00 수업', subLabel: null, lat: 0, lng: 0, isTerminal: false, isHub: false, pending: false, warn: false, riders, ...extra });
const fixture = { token: 'synthetic-only', date: '2026-10-19', today: '2026-10-19', prevDate: '2026-10-18', nextDate: '2026-10-20', driverLabel: '검증 기사', initialBoarding: {}, rows: [
  stop('one', '검증 첫 정류장', '14:38', [rider('one-child', '검증가온')]),
  stop('two', '검증 두 번째 아파트 후문', '14:45', [rider('two-child', '검증나래', { shuttleNote: '오늘만 다른 정류장' })], { warn: true }),
  stop('three', '검증 특강 하원 정류장', '14:52', [rider('three-child', '검증다온', { kind: 'SEASONAL', direction: 'DROPOFF' })], { kind: 'SEASONAL', direction: 'DROPOFF' }),
] };
const harness = await startStatusBrowserHarness({ css,
  assets: { '/stiz-logo.png': await readFile('public/stiz-logo.png'), '/material.woff2': { body: iconFont, contentType: 'font/woff2' } },
  mocks: {
    'next/image': `import{createElement}from'react';export default function Image({priority,...props}){return createElement('img',props);}`,
    '@/hooks/useGpsShare': `export function useGpsShare(){return{state:'active',transmission:'sent',lastSentAt:new Date(),accuracy:8,mode:'native',nativeRunning:true,start(){throw Error('GPS start forbidden');},stop(){throw Error('GPS stop forbidden');}};}`,
  },
  entry: `import React from'react';import{createRoot}from'react-dom/client';import Driver from'@/components/shuttle/UnifiedDriverClient';const root=createRoot(document.getElementById('root'));window.showDriver=patch=>root.render(React.createElement(Driver,{...window.fixture,...patch}));window.showDriver({});`,
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [], out = '.tmp/driver-lavender-actual'; await mkdir(out, { recursive: true });
function check(name, value, detail) { results.push({ name, pass: Boolean(value), detail }); }
try {
  for (const [width, height] of [[320,800],[360,800],[390,844],[554,771],[768,1024],[834,1194],[1024,768],[1280,800],[1920,1080]]) {
    const page = await browser.newPage({ viewport: { width, height }, timezoneId: 'Asia/Seoul', hasTouch: width < 1280 });
    const errors = [], requests = []; page.on('pageerror', e => errors.push(e.message));
    const origin = new URL(harness.url).origin;
    await page.route('**/*', route => { const req = route.request(); const url = new URL(req.url()); if (url.origin !== origin || url.pathname.startsWith('/api/')) { requests.push(url.pathname); return route.abort(); } return route.continue(); });
    await page.addInitScript(data => { window.fixture = data; }, fixture);
    await page.clock.install({ time: new Date('2026-10-19T14:35:00+09:00') });
    await page.goto(harness.url); await page.getByText('곧 도착 · 3분 후', { exact: true }).waitFor();
    await page.evaluate(async () => { await document.fonts.load('18px "Material Symbols Outlined"'); document.documentElement.classList.add('material-symbols-ready'); });
    const layout = await page.evaluate(() => {
      const box = el => { const r = el.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom,w:r.width,h:r.height }; };
      const cards = [...document.querySelectorAll('.academy-driver-stop')];
      const controls = [...document.querySelectorAll('button,a')].filter(el => el.getClientRects().length && !el.closest('dialog:not([open])'));
      const tiny = controls.filter(el => {const r=box(el);return r.w<43.5||r.h<43.5;}).map(el=>({text:el.textContent,box:box(el)}));
      const first=cards[0], identity=first.querySelector('[class~="identity"]'), contacts=first.querySelector('[class~="contacts"]'), navigation=first.querySelector('[class~="navigation"]'), time=first.querySelector('[class~="time"]');
      return { width:innerWidth,scroll:document.documentElement.scrollWidth,workspace:box(document.querySelector('[data-academy-role="driver"]')),tiny,cards:cards.map(el=>({box:box(el),upcoming:el.hasAttribute('data-upcoming')})),rider:box(document.querySelector('.academy-driver-rider')),identity:box(identity),contacts:box(contacts),navigation:box(navigation),time:box(time),preview:document.querySelectorAll('[aria-label="시안 기준 시각"],.driver-time-preview').length };
    });
    check(`${width} 페이지 가로 넘침`, layout.scroll <= width + 1, layout);
    check(`${width} 조작 버튼 44px`, layout.tiny.length === 0, layout.tiny);
    check(`${width} 다음 정류장 한 개·미리보기 없음`, layout.cards.filter(c=>c.upcoming).length === 1 && layout.preview === 0);
    check(`${width} 시간은 길안내 왼쪽 같은 행`,layout.time.right<=layout.navigation.x+1&&Math.abs(layout.time.y+layout.time.h/2-layout.navigation.y-layout.navigation.h/2)<2);
    check(`${width} 전화는 이름 오른쪽`,layout.contacts.x>=layout.identity.right-1&&Math.abs(layout.contacts.y+layout.contacts.h/2-layout.identity.y-layout.identity.h/2)<2);
    if(width>=390)check(`${width} 일반 학생 행 압축`,layout.rider.h<=64,layout.rider);
    if (width >= 768) check(`${width} 태블릿·PC 너비 활용`, layout.workspace.w >= Math.min(width,1120)-2, layout.workspace);
    const indicator = page.getByRole('button', { name: /위치 공유 상세 보기/ }); await indicator.click();
    check(`${width} 위치 상세 안내`, await page.getByRole('dialog').isVisible() && await page.getByText(/화면을 끄거나 길안내 앱으로 이동해도/).isVisible());
    await page.keyboard.press('Escape'); check(`${width} Escape 닫기·초점 복귀`, await indicator.evaluate(el => el === document.activeElement));
    if ([390,834,1280].includes(width)) await page.screenshot({ path: `${out}/${width}.png`, fullPage: true });
    if (width === 390) {
      for (const [time,key] of [['14:39:00','two'],['14:46:00','three'],['14:53:00',null]]) {
        await page.clock.setFixedTime(new Date(`2026-10-19T${time}+09:00`)); await page.evaluate(()=>dispatchEvent(new Event('focus')));
        await page.waitForFunction(expected => { const current=document.querySelector('[data-upcoming]');return expected?current?.textContent.includes(expected):!current; }, key==='two'?'검증 두 번째':key==='three'?'검증 특강':null);
        check(`${time} 실제 hook 강조 이동`, true);
      }
      await page.evaluate(()=>window.showDriver({date:'2026-10-20'})); await page.getByText('선택한 날짜의 운행').waitFor();
      check('미래 날짜 강조 없음', await page.locator('[data-upcoming]').count() === 0);
      await page.evaluate(()=>window.showDriver({}));
      await page.clock.setFixedTime(new Date('2026-10-19T14:35:00+09:00')); await page.evaluate(()=>dispatchEvent(new Event('focus')));
      await page.getByRole('button',{name:/순서·시간 수정/}).click(); check('순서 편집 중 강조 없음',await page.locator('[data-upcoming]').count()===0);
      await page.getByRole('button',{name:'취소',exact:true}).click();
      await page.getByText('곧 도착 · 3분 후',{exact:true}).waitFor(); check('편집 취소 후 강조 복원', true);
      await page.clock.setSystemTime(new Date('2026-10-19T14:38:50+09:00')); await page.evaluate(()=>dispatchEvent(new Event('focus'))); await page.clock.fastForward(15_000);
      await page.locator('[data-upcoming]').filter({hasText:'검증 두 번째'}).waitFor(); check('15초 타이머 경계 갱신',true);
    }
    check(`${width} JS·운영 요청 없음`,errors.length===0&&requests.length===0,{errors,requests});
    await page.close();
  }
} finally { await browser.close(); await harness.close(); }
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));
console.log(JSON.stringify({cases:results.length,failed:results.filter(r=>!r.pass)}));
assert.equal(results.every(r=>r.pass),true);
