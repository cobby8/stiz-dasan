import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidence = path.join(root, '.tmp/public-site-browser');
await mkdir(evidence, { recursive: true });
const globals = await readFile(path.join(root, 'src/app/globals.css'), 'utf8');
const css = (await postcss([tailwind()]).process(globals, { from: path.join(root, 'src/app/globals.css') })).css
  + await readFile(path.join(root, 'src/app/academy-theme.css'), 'utf8')
  + await readFile(path.join(root, 'src/app/public-theme.css'), 'utf8');
const logo = await readFile(path.join(root, 'public/stiz-logo.png'));
const navigation = `import {useMemo,useSyncExternalStore} from 'react';
const subscribe=f=>{window.addEventListener('test:navigate',f);window.addEventListener('popstate',f);return()=>{window.removeEventListener('test:navigate',f);window.removeEventListener('popstate',f)}};
function useHref(){return useSyncExternalStore(subscribe,()=>location.href,()=>'/')};
export function usePathname(){return new URL(useHref()).pathname};
export function useSearchParams(){const href=useHref();return useMemo(()=>new URL(href).searchParams,[href])};
export function useRouter(){return {push(url){history.pushState({},'',url);window.dispatchEvent(new Event('test:navigate'))},refresh(){},back(){history.back()}}};`;
const fixture = {
  initialSettings: { introductionTitle: '즐겁게 배우고 함께 성장하는 스티즈 농구교실', introductionText: '<p>우리 아이의 첫 농구부터 함께 성장하는 수업까지, 수업 현장을 살펴보고 체험을 신청해 주세요.</p>', contactPhone: '000-0000-0000' },
  galleryPosts: [{ id: 'fixture', title: '합성 검사용 사진', caption: null, createdAt: '2026-10-20', mediaJSON: JSON.stringify([{ type: 'image', url: '/fixture.png' }, { type: 'image', url: '/fixture2.png' }]) }],
  notices: [{ id: 'fixture-notice', title: '합성 안내 · 이번 달 수업 일정과 체험 신청을 확인해 주세요', isPinned: true, createdAt: '2026-10-20' }],
  testimonials: Array.from({ length: 5 }, (_, index) => ({ name: `합성 후기 ${index + 1}`, info: '시험 자료', text: '친구들과 함께하는 농구 수업을 즐겁게 경험하고 있어요.', rating: 5 })),
};
const slots = [
  { slotKey: 'a', dayKey: 'Mon', dayLabel: '월요일', startTime: '15:00', endTime: '16:00', gradeRange: '초등학교 1~3학년', enrolled: 8, displayLabel: '합성 초등 기초반 · 친구들과 함께하는 농구 수업', note: '준비물: 실내 운동화', capacity: 12, isFull: false, coach: { name: '아주 긴 합성 선생님 이름', role: '전문 코치', imageUrl: '/fixture.png' }, programId: 'p1' },
  { slotKey: 'b', dayKey: 'Sat', dayLabel: '토요일', startTime: '09:40', endTime: '10:45', gradeRange: '초등학교 4~6학년', enrolled: 12, displayLabel: '합성 주말 경기반', note: null, capacity: 12, isFull: true, coach: null, programId: 'p2' },
];
const harness = await startStatusBrowserHarness({ css,
  assets: Object.fromEntries(['/stiz-logo.png', '/fixture.png', '/fixture2.png'].map(url => [url, { contentType: 'image/png', body: logo }])),
  mocks: {
    'next/navigation': navigation,
    './PublicAccountControls': `export function DesktopAccountControls(){return null};export function MobileAccountControls(){return null};`,
    // 소개 HTML 정화는 실제 서버 렌더 검사에서 검증하며 여기서는 고정된 합성 HTML만 쓴다.
    '@/lib/sanitize': `export function sanitizeHtml(value){return value};`,
    'next/image': `import {createElement} from 'react';export default function Image({priority,fill,unoptimized,...props}){return createElement('img',props)}`,
  },
  entry: `import {createElement,Fragment} from 'react';import {createRoot} from 'react-dom/client';
import {ThemeProvider} from '@/components/ThemeProvider';import Design from '@/components/PublicDesignProvider';import Header from '@/components/PublicHeader';import Help from '@/components/PublicHelp';import Footer from '@/components/PublicFooter';import Home from '@/app/LandingPageClient';import Schedule from '@/app/schedule/ScheduleClient';import Section from '@/components/ui/SectionLayout';import CTA from '@/components/landing/CTABanner';
const fixture=window.__fixture;const schedule=new URLSearchParams(location.search).get('screen')==='schedule';
const main=schedule?createElement(Fragment,null,createElement('section',{className:'public-page-intro'},createElement('div',{className:'public-container'},createElement('h1',null,'수업시간표'))),createElement(Schedule,{programs:[{id:'p1',name:'합성 초등 프로그램'},{id:'p2',name:'합성 주말 프로그램'}],allSlots:window.__slots,phone:'000-0000-0000'}),createElement(CTA)):createElement(Home,fixture);
createRoot(document.getElementById('root')).render(createElement(ThemeProvider,{attribute:'class',defaultTheme:'dark'},createElement(Design,null,createElement(Header,{phone:'000-0000-0000',address:'합성 주소',operatingHours:'합성 운영 시간'}),createElement('main',null,main),createElement(Section,{title:'합성 안내',description:'실제 공통 섹션 검사'},createElement('span',{id:'contrast-probe',className:'bg-blue-50 text-blue-700'},'연령 안내')),createElement(Footer,{phone:'000-0000-0000',address:'합성 주소'}),createElement(Help))));`,
});
const cases = [];
let browser;
async function check(name, work) {
  try { await work(); cases.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { cases.push({ name, pass: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
async function screen({ width = 360, theme = 'lavender', mode = 'home', large = false, installed = false, pathname = '/' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const errors = [], external = [], forbidden = [];
  await context.addInitScript(({ fixture, slots, large, installed }) => {
    window.__fixture = fixture; window.__slots = slots;
    localStorage.setItem('theme', 'dark'); if (large) localStorage.setItem('fontSize', 'large');
    Object.defineProperty(navigator, 'standalone', { value: installed, configurable: true });
  }, { fixture, slots, large, installed });
  const origin = new URL(harness.url).origin;
  await context.route('**/*', route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
    if (req.method() !== 'GET' || !['/', '/bundle.js', '/stiz-logo.png', '/fixture.png', '/fixture2.png'].includes(url.pathname)) { forbidden.push(`${req.method()} ${url.pathname}`); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${harness.url}/?previewTheme=${theme}&screen=${mode}`);
  await page.locator(`.public-site[data-public-theme="${theme}"]`).waitFor();
  if (pathname !== '/') await page.evaluate(pathname => { history.pushState({}, '', pathname); window.dispatchEvent(new Event('test:navigate')); }, pathname);
  await page.getByRole('heading', { level: 1 }).waitFor();
  return { page, context, async close() { try { assert.deepEqual(errors, [], '클라이언트 오류 없음'); assert.deepEqual(external, [], '외부 통신 없음'); assert.deepEqual(forbidden, [], '저장·운영 경로 요청 없음'); } finally { await context.close(); } } };
}
async function noOverflow(page) {
  const measured = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(measured.scroll <= measured.width + 1, `화면 전체 넘침: ${JSON.stringify(measured)}`);
}
async function contrast(page) {
  return page.locator('#contrast-probe').evaluate(el => {
    const s = getComputedStyle(el);
    const lum = color => { const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const c = [...ctx.getImageData(0,0,1,1).data].slice(0,3).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4); return c[0]*.2126+c[1]*.7152+c[2]*.0722; };
    const a = lum(s.color), b = lum(s.backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });
}
try {
  browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  for (const theme of ['lavender', 'official', 'sport']) for (const width of [320,360,768,1280,1440]) {
    await check(`${theme} ${width}px 메인·긴 제목·CTA·안내 대비`, async () => {
      const s = await screen({ width, theme }); try {
        await noOverflow(s.page);
        assert.equal(await s.page.locator('html').evaluate(el => el.classList.contains('dark')), false, '이전 dark 저장값보다 light 기본 우선');
        const cta = s.page.locator('main a[href="/apply/trial"]').first();
        const box = await cta.boundingBox(); assert.ok(box && box.height >= 44 && box.y < 900 && box.x >= 0 && box.x + box.width <= width + 1, '첫 화면에 신청 버튼 접근');
        const header = await s.page.locator('.public-header').boundingBox(); assert.ok(header.height <= 90, '헤더 두 줄 쌓임 없음');
        assert.equal(await s.page.locator('.public-help-button').count(),1); assert.equal(await s.page.getByRole('button', { name: '입학 가이드 시작' }).count(),0);
        const title = await s.page.locator('h1').boundingBox(); assert.ok(title.x >= 0 && title.x+title.width <= width+1);
        assert.ok(await contrast(s.page) >= 4.5, '연령·일정 안내 글씨 대비 4.5:1');
        assert.equal(await s.page.locator('img[src="/stiz-logo.png"]').first().evaluate(img => img.naturalWidth > 0), true, '공식 로고 원본 로컬 이미지 로드');
        await s.page.screenshot({ path:path.join(evidence, `${theme}-${width}.png`), fullPage:true });
      } finally { await s.close(); }
    });
    await check(`${theme} ${width}px 시간표 카드·표·프로그램 필터`, async () => {
      const s=await screen({width,theme,mode:'schedule'});try {
        await noOverflow(s.page); await s.page.getByRole('button',{name:'표',exact:true}).click(); await noOverflow(s.page);
        assert.equal(await s.page.getByRole('button',{name:'표',exact:true}).getAttribute('aria-pressed'),'true');
        await s.page.getByRole('button',{name:'카드',exact:true}).click();
        await s.page.getByRole('combobox',{name:'프로그램 선택'}).selectOption('p2');
        await s.page.getByText('1개 수업',{exact:true}).waitFor();
        assert.equal(await s.page.getByText('합성 초등 기초반 · 친구들과 함께하는 농구 수업',{exact:true}).count(),0);
        await noOverflow(s.page);
      }finally{await s.close();}
    });
  }
  for(const width of [320,360,768,1280,1440]) await check(`${width}px 메뉴 터치·닫기·Esc·초점 복원`,async()=>{
    const s=await screen({width});try {
      const open=s.page.getByRole('button',{name:'메뉴 열기',exact:true});await open.click();
      const dialog=s.page.getByRole('dialog',{name:'홈페이지 메뉴'}); await dialog.waitFor();
      const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
      await dialog.locator('summary').filter({hasText:'수업 안내'}).click();
      await dialog.getByRole('link',{name:'프로그램·수강료',exact:true}).waitFor({state:'visible'});
      await s.page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});
      assert.equal(await open.evaluate(el=>el===document.activeElement),true);
      assert.equal(await s.page.evaluate(()=>document.body.style.overflow),'');
      await open.click();await dialog.getByRole('button',{name:'메뉴 닫기'}).click();await dialog.waitFor({state:'hidden'});
    }finally{await s.close();}
  });
  await check('같은 경로 검색조건만 변경해 3테마 즉시 전환·관리자 범위 분리',async()=>{
    const s=await screen();try {
      for(const theme of ['official','sport','lavender']){
        await s.page.evaluate(theme=>{history.pushState({},'',`/?previewTheme=${theme}`);window.dispatchEvent(new Event('test:navigate'));},theme);
        await s.page.locator(`.public-site[data-public-theme="${theme}"]`).waitFor();
      }
      await s.page.evaluate(()=>{history.pushState({},'','/admin');window.dispatchEvent(new Event('test:navigate'));});
      await s.page.locator('.public-site').waitFor({state:'detached'});
    }finally{await s.close();}
  });
  await check('큰 글씨 저장값 새로고침 복원·토글·360px 경계',async()=>{
    const s=await screen({large:true});try {
      await s.page.waitForFunction(()=>document.documentElement.classList.contains('text-large'));
      await noOverflow(s.page);await s.page.getByRole('button',{name:'메뉴 열기',exact:true}).click();
      await s.page.getByRole('button',{name:'기본 글씨로 보기',exact:true}).click();
      await s.page.waitForFunction(()=>!document.documentElement.classList.contains('text-large'));
      await s.page.getByRole('button',{name:'큰 글씨로 보기',exact:true}).click();
      await s.page.reload();await s.page.waitForFunction(()=>document.documentElement.classList.contains('text-large'));await noOverflow(s.page);
    }finally{await s.close();}
  });
  await check('도움말 하나에서 간단한 3단계 안내·닫기·모바일 경계',async()=>{
    const s=await screen({width:320});try {
      await s.page.getByRole('button',{name:'상담·안내 열기'}).click();
      const panel=s.page.getByRole('region',{name:'상담과 이용 안내'});await panel.getByRole('button',{name:'학원 둘러보기'}).click();
      for(const [name,href]of [['1. 우리 아이에게 맞는 수업 보기','/programs'],['2. 가능한 요일과 시간 확인','/schedule'],['3. 체험 수업 신청','/apply/trial']])assert.equal(await panel.getByRole('link',{name,exact:true}).getAttribute('href'),href);
      const box=await panel.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=320);
      await panel.getByRole('button',{name:'닫기',exact:true}).click();await panel.waitFor({state:'hidden'});
      assert.equal(await s.page.getByRole('button',{name:'상담·안내 열기'}).evaluate(el=>el===document.activeElement),true);
    }finally{await s.close();}
  });
  await check('설치 앱에서만 공개 페이지 뒤로가기 보존',async()=>{
    const s=await screen({installed:true,pathname:'/about'});try {
      await s.page.getByRole('button',{name:'이전 화면으로 돌아가기',exact:true}).waitFor();await noOverflow(s.page);
    }finally{await s.close();}
  });
} finally {
  await browser?.close(); await harness.close();
  await writeFile(path.join(evidence,'report.json'),JSON.stringify({cases,passed:cases.filter(item=>item.pass).length,total:cases.length,externalNetwork:0,productionWrites:0},null,2));
}
if(cases.some(item=>!item.pass))process.exitCode=1;
console.log(`${cases.filter(item=>item.pass).length}/${cases.length} passed`);
