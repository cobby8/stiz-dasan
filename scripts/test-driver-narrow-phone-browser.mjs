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
  stop('one', '다산푸르지오 정문', '14:38', [rider('one-child', '김지우'),rider('long-child','합성알렉산더김민준'),rider('absent-child','합성결석', {absent:true})]),
  stop('two', '합성 다산신도시 센트럴아이파크아파트 후문 승하차장', '14:45', [rider('two-child', '검증나래', { shuttleNote: '오늘만 다른 정류장' })], { warn: true }),
  stop('three', '검증 특강 하원 정류장', '14:52', [rider('three-child', '검증다온', { kind: 'SEASONAL', direction: 'DROPOFF' })], { kind: 'SEASONAL', direction: 'DROPOFF' }),
] };
const harness = await startStatusBrowserHarness({ css,
  assets: { '/stiz-logo.png': await readFile('public/stiz-logo.png'), '/material.woff2': { body: iconFont, contentType: 'font/woff2' } },
  mocks: {
    'next/image': `import{createElement}from'react';export default function Image({priority,...props}){return createElement('img',props);}`,
    '@/hooks/useGpsShare': `export function useGpsShare(){return{state:'active',transmission:'sent',lastSentAt:new Date(),accuracy:8,mode:'native',nativeRunning:true,...window.gpsPatch,start(){throw Error('GPS start forbidden');},stop(){throw Error('GPS stop forbidden');}};}`,
  },
  entry: `import React from'react';import{createRoot}from'react-dom/client';import Driver from'@/components/shuttle/UnifiedDriverClient';const root=createRoot(document.getElementById('root'));window.showDriver=patch=>root.render(React.createElement(Driver,{...window.fixture,...patch,key:patch.fixtureKey||'default'}));window.showDriver({});`,
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [], out = process.env.DRIVER_NARROW_OUT || '.tmp/driver-narrow-phone'; await mkdir(out,{recursive:true});
const check=(name,pass,detail)=>results.push({name,pass:Boolean(pass),detail});
try {
  for(const width of [320,360,375,390,554,834,1280]) {
    const page=await browser.newPage({viewport:{width,height:844},timezoneId:'Asia/Seoul',hasTouch:true});
    const errors=[],blocked=[]; page.on('pageerror',error=>errors.push(error.message));
    const origin=new URL(harness.url).origin;
    await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==origin||url.pathname.startsWith('/api/')){blocked.push(url.pathname);return route.abort();}return route.continue();});
    await page.addInitScript(data=>{window.fixture=data;},fixture);
    await page.clock.install({time:new Date('2026-10-19T14:35:00+09:00')});
    await page.goto(harness.url);await page.getByText('곧 도착 · 3분 후',{exact:true}).waitFor();
    await page.evaluate(async()=>{await document.fonts.load('18px "Material Symbols Outlined"');document.documentElement.classList.add('material-symbols-ready');});
    const layout=await page.evaluate(()=>{
      const box=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};};
      const overlap=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1;
      const cards=[...document.querySelectorAll('.academy-driver-stop')];
      const riders=[...document.querySelectorAll('.academy-driver-rider')].map(el=>{
        const identity=el.querySelector('.identity'),contacts=el.querySelector('.contacts'),actions=el.querySelector('.boardingActions');
        return{box:box(el),identity:box(identity),contacts:contacts&&box(contacts),actions:actions&&box(actions),nameFont:getComputedStyle(identity.firstElementChild).fontSize,contactFont:contacts&&getComputedStyle(contacts.firstElementChild).fontSize,buttonFont:actions&&getComputedStyle(actions.firstElementChild).fontSize,collision:contacts&&actions&&overlap(box(contacts),box(actions)),identityText:identity.textContent};
      });
      const controls=[...document.querySelectorAll('button,a')].filter(el=>el.getClientRects().length&&!el.closest('dialog:not([open])'));
      return{width:innerWidth,scroll:document.documentElement.scrollWidth,riders,cards:cards.map(el=>{const time=el.querySelector('.time'),navigation=el.querySelector('.navigation');return{box:box(el),name:box(el.querySelector('.stopName')),nameLineHeight:parseFloat(getComputedStyle(el.querySelector('.stopName')).lineHeight),time:time&&box(time),timeFont:time&&getComputedStyle(time).fontSize,navigation:navigation&&box(navigation)};}),tiny:controls.filter(el=>{const r=box(el);return r.w<43.5||r.h<43.5;}).map(el=>({text:el.textContent,box:box(el)}))};
    });
    check(`${width} 가로 넘침 없음`,layout.scroll<=width+1,layout);
    check(`${width} 버튼·전화 44px 유지`,layout.tiny.length===0,layout.tiny);
    check(`${width} 이름·전화·탑승 겹침 없음`,layout.riders.every(r=>!r.collision),layout.riders);
    check(`${width} 글자 축소 없음`,layout.riders.every(r=>parseFloat(r.nameFont)>=18&&(!r.actions||parseFloat(r.buttonFont)>=15))&&layout.cards.every(c=>!c.timeFont||parseFloat(c.timeFont)>=25));
    check(`${width} 시간은 길안내 왼쪽 한 행`,layout.cards.every(c=>!c.navigation||c.time.right<=c.navigation.x+1&&Math.abs(c.time.y+c.time.h/2-c.navigation.y-c.navigation.h/2)<2),layout.cards);
    check(`${width} 전화는 이름 우측`,layout.riders.filter(r=>r.contacts).every(r=>r.contacts.x>=r.identity.right-1&&Math.abs(r.contacts.y+r.contacts.h/2-r.identity.y-r.identity.h/2)<2),layout.riders);
    if(width<=390)check(`${width} 긴 정류장명 세 줄 이내`,layout.cards[1].name.h<=layout.cards[1].nameLineHeight*3+1,layout.cards[1]);
    if(width>=360&&width<=390)check(`${width} 표준 학생명 한 행`,layout.riders.filter(r=>r.contacts&&r.identityText.length<=7).every(r=>Math.abs(r.actions.y+r.actions.h/2-r.contacts.y-r.contacts.h/2)<2),layout.riders);
    await page.screenshot({path:`${out}/${width}.png`,fullPage:true});
    const indicator=page.getByRole('button',{name:/위치 공유 상세 보기/});await indicator.click();
    const dialog=page.getByRole('dialog');const rect=await dialog.boundingBox();check(`${width} 위치 안내 화면 안`,rect.x>=0&&rect.x+rect.width<=width+1&&await dialog.isVisible());
    await page.keyboard.press('Escape');check(`${width} 위치 안내 닫기`,await indicator.evaluate(el=>el===document.activeElement));
    await page.getByRole('button',{name:/순서·시간 수정/}).click();
    check(`${width} 편집 시간 입력 넘침 없음`,await page.locator('input[type=time]').evaluateAll(inputs=>inputs.every(input=>input.getBoundingClientRect().right<=innerWidth)));
    await page.getByRole('button',{name:'취소',exact:true}).click();
    if(width<=390){
      for(const length of [18,19]){
        await page.evaluate(length=>window.showDriver({fixtureKey:`label-${length}`,rows:[{...window.fixture.rows[0],label:'가'.repeat(length)}]}),length);
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const boundary=await page.locator('.academy-driver-stop').evaluate(el=>{const name=el.querySelector('.stopName'),rect=name.getBoundingClientRect();return{scroll:document.documentElement.scrollWidth,h:rect.height,line:parseFloat(getComputedStyle(name).lineHeight),special:name.classList.contains('longStopName')};});
        check(`${width} 정류장 ${length}자 경계 안전`,boundary.scroll<=width+1&&boundary.h<=boundary.line*3+1&&boundary.special===(length>18),boundary);
      }
      for(const name of ['김지우','합성나래','합성알렉산더김민준'])for(const grade of ['초4',null])for(const phones of [0,1,2]){
        await page.evaluate(({name,grade,phones})=>window.showDriver({fixtureKey:`rider-${name}-${grade}-${phones}`,rows:[{...window.fixture.rows[0],riders:[{...window.fixture.rows[0].riders[0],name,grade,parentPhone:phones?'00000000000':null,studentPhone:phones===2?'00000000001':null}]}]}),{name,grade,phones});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const variant=await page.locator('.academy-driver-rider').evaluate(el=>{
          const info=el.querySelector('.identity'),contact=el.querySelector('.contacts'),buttons=[...el.querySelectorAll('.boardingActions button')],r=info.getBoundingClientRect(),c=contact?.getBoundingClientRect();
          return{scroll:document.documentElement.scrollWidth,nameFont:parseFloat(getComputedStyle(info.firstElementChild).fontSize),contactCount:contact?.querySelectorAll('a').length||0,contactRight:!c||(c.x>=r.right-1&&Math.abs(c.y+c.height/2-r.y-r.height/2)<2),buttons:buttons.map(button=>{const r=button.getBoundingClientRect();return{x:r.x,right:r.right,w:r.width,h:r.height,font:parseFloat(getComputedStyle(button).fontSize),collision:c&&Math.min(c.right,r.right)-Math.max(c.x,r.x)>1&&Math.min(c.bottom,r.bottom)-Math.max(c.y,r.y)>1};})};
        });
        check(`${width} ${name.length}글자·학년${grade?'있음':'없음'}·전화${phones}개`,variant.scroll<=width+1&&variant.nameFont>=18&&variant.contactCount===phones&&variant.contactRight&&variant.buttons.every(b=>b.w>=44&&b.h>=44&&b.font>=15&&!b.collision&&b.x>=0&&b.right<=width+1),variant);
      }
      await page.evaluate(()=>window.showDriver({fixtureKey:'short-stop',rows:[{...window.fixture.rows[0],label:'학원'}]}));
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const short=await page.locator('.academy-driver-stop').evaluate(el=>{const name=el.querySelector('.stopName').getBoundingClientRect(),time=el.querySelector('.timeNavigation').getBoundingClientRect();return Math.min(name.bottom,time.bottom)-Math.max(name.y,time.y)>0;});
      check(`${width} 짧은 정류장 한 행 유지`,short);
      for(const [name,patch] of [['종료 확인 대기',{nativeRunning:false,transmission:'stop-unknown'}],['종료 후 재시작',{nativeRunning:false,transmission:'stopped'}],['권한 거부',{nativeRunning:false,state:'denied',transmission:'idle'}]]){
        await page.evaluate(patch=>{window.gpsPatch=patch;window.showDriver({fixtureKey:JSON.stringify(patch)});},patch);
        await page.waitForTimeout(50);
        const state=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,controls:[...document.querySelector('header').querySelectorAll('button')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return{x:r.x,right:r.right,w:r.width,h:r.height};})}));
        check(`${width} ${name} 버튼 보존`,state.scroll<=width+1&&state.controls.every(r=>r.x>=0&&r.right<=width+1&&r.w>=44&&r.h>=44),state);
      }
      await page.evaluate(()=>{window.gpsPatch=undefined;window.showDriver({fixtureKey:'next-date',date:'2026-10-20'});});
      await page.getByRole('link',{name:'오늘로',exact:true}).waitFor();
      check(`${width} 다른 날짜 안내 넘침 없음`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.evaluate(()=>window.showDriver({fixtureKey:'contact-variants',rows:[{...window.fixture.rows[0],riders:[{...window.fixture.rows[0].riders[1],key:'no-phone',checkId:'no-phone',parentPhone:null,studentPhone:null},{...window.fixture.rows[0].riders[1],key:'one-phone',checkId:'one-phone',studentPhone:null}]}]}));
      await page.locator('.academy-driver-rider').first().waitFor();
      check(`${width} 전화 없음·하나·긴 이름 넘침 없음`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    }
    check(`${width} 오류·외부·운영 요청 없음`,errors.length===0&&blocked.length===0,{errors,blocked});
    await page.close();
  }
}finally{await browser.close();await harness.close();}
await writeFile(`${out}/results.json`,JSON.stringify(results,null,2));console.log(JSON.stringify({cases:results.length,failed:results.filter(r=>!r.pass)}));assert.ok(results.every(r=>r.pass));
