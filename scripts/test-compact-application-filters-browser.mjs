import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

const out = '.tmp/compact-application-filters';
await mkdir(out, { recursive: true });
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const lead = (id, name, status, extra = {}) => ({ id, childName: name, childAge: '10', parentName: '검사 보호자', parentPhone: '000', source: 'OTHER', status, trialDate: today, scheduledDate: null, scheduledClassId: null, attendedDate: null, enrollGuideSentAt: null, enrollApplicationReceivedAt: null, coachNoticeSentAt: null, memo: '', createdAt: today, updatedAt: today, childGrade: '초4', childSchool: '검사학교', trialFeeConfirmed: false, smsDeliveryTotal: 0, ...extra });
const leads = [lead('t1', '검사한별', 'NEW'), lead('t2', '검사두별', 'SCHEDULED'), lead('t3', '검사세별', 'ATTENDED', { enrollApplicationReceivedAt: today }), lead('t4', '검사네별', 'CANCELLED', { trialDate: null })];
const app = (id, name, status, extra = {}) => ({ id, childName: name, childBirthDate: '2015-01-01', parentName: '검사 보호자', parentPhone: '000', status, childGrade: '초4', childSchool: '검사학교', assignedClassId: null, preferredSlotKeys: null, enrollmentMonths: null, shuttleNeeded: false, trialLeadId: null, createdAt: today, updatedAt: today, ...extra });
const apps = [app('a1', '검사한별', 'PENDING', { shuttleNeeded: true }), app('a2', '검사두별', 'APPROVED', { shuttleNeeded: true, assignedClassId: 'c1' }), app('a3', '검사세별', 'PENDING'), app('a4', '검사네별', 'REJECTED', { trialLeadId: 't4' })];
const globals = await readFile('src/app/globals.css', 'utf8');
const css = (await postcss([tailwind()]).process(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none); @source "./admin/apply"; @source "./admin/trial"; @source "../components/academy"; @source "../components/admin"; @source "../components/ui";'), { from: 'src/app/globals.css' })).css + await readFile('src/app/academy-theme.css', 'utf8') + `
@font-face{font-family:'Material Symbols Outlined';src:url('/material.woff2')}body{margin:0;font-family:system-ui,sans-serif}#root{min-width:0}.test-shell{padding:16px;min-width:0}`;
const blockedAction = name => `export async function ${name}(){throw Error('운영 변경 금지')}`;
const harness = await startStatusBrowserHarness({ css,
  assets: { '/material.woff2': { body: await readFile('.tmp/staff-header/material-full.woff2'), contentType: 'font/woff2' } },
  mocks: {
    '@/app/actions/admin': ['updateTrialLead','sendPostTrialEnrollGuide','sendTrialCoachNotice','resendTrialApplicationSms','resendTrialAttendedSms','recordApplicationContact','confirmTrialFeePayment','sendManualSms'].map(blockedAction).join('\n'),
  },
  entry: `import React from'react';import{createRoot}from'react-dom/client';import Apply from'@/app/admin/apply/ApplyAdminClient';import Trial from'@/app/admin/trial/TrialCrmClient';import Theme from'@/components/academy/AcademyTheme';const trial={initialLeads:${JSON.stringify(leads)},initialStats:{NEW:1,CONTACTED:0,SCHEDULED:1,ATTENDED:1,CONVERTED:0,LOST:0,CANCELLED:1,total:4,conversionRate:0},initialClasses:[]};const apply={initialApplications:${JSON.stringify(apps)},initialClasses:[],initialStats:{PENDING:2,APPROVED:1,REJECTED:1,CANCELLED:0,total:4},initialTrialLeads:trial.initialLeads,initialTrialStats:trial.initialStats,initialTrialClasses:[]};const params=new URLSearchParams(location.search);const isTrial=params.get('view')==='trial';if(params.has('more')){const pagination={limit:50,offset:0,returned:4,total:8,hasMore:true,nextOffset:4,partial:true};trial.initialPagination=pagination;apply.initialApplyPagination=pagination;}createRoot(document.getElementById('root')).render(React.createElement(Theme,{role:'admin',className:'test-shell'},React.createElement(isTrial?Trial:Apply,params.has('loading')?{}:isTrial?trial:apply)));`,
});
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const cases = [];
const check = (name, passed, details) => { cases.push({ name, passed: !!passed, details }); assert.ok(passed, `${name} ${JSON.stringify(details)}`); };
try {
  for (const [width, height] of [[320,714],[390,844],[750,292],[874,402],[834,1112],[1440,900]]) {
    for (const view of ['trial','apply']) {
      const page = await browser.newPage({ viewport: { width, height }, timezoneId:'Asia/Seoul', hasTouch:true });
      const errors=[];const writes=[];
      page.on('pageerror',error=>errors.push(error.message));
      await page.route('**/*',route=>{
        if(!route.request().url().startsWith(harness.url+'/'))return route.abort();
        if(route.request().method()!=='GET'){writes.push(route.request().url());return route.abort();}
        if(route.request().url().includes('/api/'))return route.fulfill({status:503,json:{error:'격리 조회'}});
        return route.continue();
      });
      await page.goto(harness.url+'/?view='+view);
      const key=`${width}x${height}-${view}`;
      if(view==='apply') {
        const business=page.getByRole('combobox',{name:'신청 관리 업무',exact:true});await business.waitFor();
        check(`${key} 다섯 업무 선택 유지`,await business.locator('option').count()===5);
        for(const value of ['applications','waitlist','sources','settings','trial','applications']){
          await business.selectOption(value);check(`${key} ${value} 업무 선택`,await business.inputValue()===value);
        }
      }
      const filters=page.getByRole('region',{name:'목록 검색과 필터',exact:true});await filters.waitFor();
      await page.evaluate(async()=>{await document.fonts.load('20px "Material Symbols Outlined"');document.documentElement.classList.add('material-symbols-ready');});
      const count=()=>page.locator('table tbody tr').count();
      check(`${key} 초기 네 자료 표시`,await count()===4);
      check(`${key} 전체 표시 때 하단 중복 건수 없음`,await page.getByText('4건 중 4건 표시',{exact:true}).count()===0);
      check(`${key} 필터 한 개·기본 접힘`,await filters.getByRole('button',{name:'필터',exact:true}).count()===1&&await filters.getByRole('combobox').count()===0);
      const search=filters.getByRole('searchbox');
      check(`${key} 검색17px·필터44px`,await search.evaluate(e=>Number.parseFloat(getComputedStyle(e).fontSize)>=17)&&await filters.getByRole('button',{name:'필터',exact:true}).evaluate(e=>e.getBoundingClientRect().height>=44));
      if(view==='trial') check(`${key} 등록 동작 보존·검색 필터와 한 행`,await filters.getByRole('button',{name:'체험 신청 등록',exact:true}).evaluate(e=>{const r=e.getBoundingClientRect();const input=e.closest('section').querySelector('input').getBoundingClientRect();return r.height>=44&&Math.abs(r.top-input.top)<10;}));
      await filters.getByRole('button',{name:'필터',exact:true}).click();
      const status=filters.getByRole('combobox',{name:view==='trial'?'체험 신청 상태':'수강신청 상태',exact:true});
      const work=filters.getByRole('combobox',{name:view==='trial'?'체험 업무 조건':'수강신청 업무 조건',exact:true});
      check(`${key} 모든 조건 한번씩·native선택`,await filters.getByRole('combobox').count()===(view==='trial'?3:2)&&await work.locator('option').count()===6&&await status.locator('option').count()===(view==='trial'?8:5));
      check(`${key} 조건 선택17px·44px`,await filters.getByRole('combobox').evaluateAll(elements=>elements.every(e=>e.getBoundingClientRect().height>=44&&Number.parseFloat(getComputedStyle(e).fontSize)>=17)));
      if(view==='trial'){
        const date=filters.getByRole('combobox',{name:'체험일 필터',exact:true});
        await date.selectOption('TODAY');check(`${key} 오늘 세 자료`,await count()===3);
        await work.selectOption('SCHEDULED');check(`${key} 날짜와 업무 AND 한 자료`,await count()===1&&await page.locator('table tbody').innerText().then(s=>s.includes('검사두별')));
        await status.selectOption('NEW');check(`${key} 충돌 조건은 기존대로 0건`,await count()===0);
      }else{
        await work.selectOption('CLASS_ASSIGNMENT');check(`${key} 반배정 두 자료`,await count()===2);
        await status.selectOption('APPROVED');check(`${key} 충돌 조건은 기존대로 0건`,await count()===0);
        await work.selectOption('SHUTTLE');check(`${key} 상태와 셔틀 AND 한 자료`,await count()===1&&await page.locator('table tbody').innerText().then(s=>s.includes('검사두별')));
      }
      await search.fill('한별');
      await filters.getByRole('button',{name:'필터 초기화',exact:true}).click();
      check(`${key} 조건초기화·검색 보존`,await search.inputValue()==='한별'&&await status.inputValue()==='ALL'&&await work.inputValue()==='ALL'&&await count()===1);
      await filters.getByRole('button',{name:'검색어 지우기',exact:true}).click();
      check(`${key} 검색만 지우기·네 자료 복원`,await search.inputValue()===''&&await count()===4);
      await filters.getByRole('button',{name:'필터',exact:true}).click();
      check(`${key} 접을 때 불필요한 조건행 사라짐`,await filters.getByRole('combobox').count()===0);
      check(`${key} 페이지 가로 넘침 없음`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      check(`${key} JS오류·변경 요청 없음`,errors.length===0&&writes.length===0,{errors,writes});
      await page.screenshot({path:`${out}/${key}.png`,fullPage:true});
      await page.close();
    }
  }
  for(const view of ['trial','apply']){
    const page=await browser.newPage({viewport:{width:390,height:844},timezoneId:'Asia/Seoul'});
    const requests=[];
    await page.route('**/*',route=>{if(!route.request().url().startsWith(harness.url+'/'))return route.abort();if(route.request().url().includes('/api/')){requests.push(route.request().url());return route.fulfill({status:503,json:{error:'합성 추가조회 실패'}});}return route.continue();});
    await page.goto(harness.url+'/?view='+view+'&more=1');
    if(view==='apply')await page.getByRole('combobox',{name:'신청 관리 업무',exact:true}).selectOption('applications');
    const more=page.getByRole('button',{name:'50건 더 보기',exact:true});await more.waitFor();
    check(`${view} 추가 자료 있을 때 기존 더보기 유지`,await page.getByText('4건 중 4건 표시',{exact:true}).count()===1);
    const pending=page.waitForRequest(request=>request.url().includes('/api/admin/'));
    await more.click();const request=await pending;const response=await request.response();await response.finished();
    await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(button=>button.textContent.trim()==='50건 더 보기'&&!button.disabled));
    check(`${view} 기존 서버 페이징 offset 유지`,requests.length===1&&new URL(request.url()).searchParams.get('offset')==='4');
    check(`${view} 다음 조회 실패에도 기존 명단 보존`,await page.locator('table tbody tr').count()===4);
    await page.close();
  }

  for(const width of [320,834])for(const view of ['trial','apply']){
    const page=await browser.newPage({viewport:{width,height:900},timezoneId:'Asia/Seoul'});const held=[];
    await page.route('**/*',route=>{if(!route.request().url().startsWith(harness.url+'/'))return route.abort();if(route.request().url().includes('/api/')){held.push(route);return;}return route.continue();});
    await page.goto(harness.url+'/?view='+view+'&loading=1');
    if(view==='apply')await page.getByRole('combobox',{name:'신청 관리 업무',exact:true}).selectOption('applications');
    const loading=page.getByRole('status');await loading.waitFor();
    check(`${width}-${view} 로딩에도 큰 통계 카드 없음`,await loading.locator('.animate-pulse').count()===6&&await loading.evaluate(e=>e.getBoundingClientRect().height<450));
    check(`${width}-${view} 로딩 페이지 넘침 없음`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await Promise.all(held.map(route=>route.abort()));await page.close();
  }

}finally{await browser.close();await harness.close();}
await writeFile(`${out}/browser.json`,JSON.stringify({source:'원본 TrialCrmClient/ApplyAdminClient/CompactListFilters·실제Tailwind/Academy CSS/Material폰트. 합성4자료·하위지연모달/체험패널격리·API합성503/POST차단, 운영/실기기아님',passed:cases.length,cases},null,2));
console.log(`신청 컴팩트 필터 ${cases.length}/${cases.length} 통과`);
