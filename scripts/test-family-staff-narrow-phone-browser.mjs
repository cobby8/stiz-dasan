import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { chromium } from 'playwright';
import { startStatusBrowserHarness } from '../tests/helpers/status-browser-harness.mjs';

// 실제 UI·CSS에 합성 자료만 연결한다. 운영 인증·DB·저장·발송은 포함하지 않는다.
const before = process.env.NARROW_PHONE_BEFORE === '1';
const out = '.tmp/family-staff-narrow-phone' + (before ? '/before' : '');
await mkdir(out, { recursive: true });
const globals = await readFile('src/app/globals.css', 'utf8');
const css = (await postcss([tailwind()]).process(globals.replace('@import "tailwindcss";', '@import "tailwindcss" source(none); @source "./staff"; @source "./mypage"; @source "../components/staff"; @source "../components/academy"; @source "../components/ui";'), { from: 'src/app/globals.css' })).css + await readFile('src/app/academy-theme.css', 'utf8') + `@font-face{font-family:'Material Symbols Outlined';src:url('/material.woff2')}`;
const longName = '합성긴이름학생김대한민국';
const longClass = '합성초등고학년주말농구성장심화수업';
const lesson = { id: 'class-a', name: longClass, startTime: '16:00', endTime: '17:00', location: '합성다산농구체육관제일코트', studentCount: 2, sessionId: 'session-a', sessionStatus: 'IN_PROGRESS', plannedContent: null, startedAt: null, kind: 'REGULAR', scheduleKey: 'schedule-a', sessionDateId: null };
const student = { id: 'row-a', attendanceKey: 'seat-a', studentId: 'student-a', name: longName, grade: '초4', phone: null, status: null, attendanceNote: null, arrivedAt: null, absenceReport: null };
const summary = { rosterId: 'row-a', studentId: 'student-a', amount: 120000, status: 'UNPAID', statusLabel: '미납', sourceLabel: '확정 청구 금액', note: null, paymentIds: ['payment-a'], period: 'MONTHLY' };
const invoice = { id: 'payment-a', studentName: longName, title: longClass, amount: 120000, status: 'UNPAID', dueDate: '2026-11-01', confirmable: true, amountMismatch: false };
const child = { id: 'student-a', name: longName, birthDate: '2016-01-01', gender: null, enrollments: [{ id: 'enroll-a', classId: 'class-a', className: longClass, dayOfWeek: 'Mon', startTime: '16:00', endTime: '17:00', programName: '합성 농구' }], attendance: { total: 4, present: 3, absent: 1, late: 0, records: [] }, payments: [{ id: 'payment-a', amount: 120000, status: 'PENDING', dueDate: '2026-11-01', paidDate: null, invoiceId: 'invoice-a', description: longClass }] };
const scenarios = {
  home: { dateKey: '2026-10-20', classes: [lesson, { ...lesson, id: 'class-b', name: '다음 합성 수업', sessionStatus: null, sessionId: null }] },
  session: { session: { id: 'session-a', classId: 'class-a', className: longClass, startTime: '16:00', endTime: '17:00', location: '합성 체육관', studentCount: 1, status: 'IN_PROGRESS', plannedContent: '합성 드리블', content: null, notes: null, photos: [], startedAt: '2026-10-20T07:00:00Z', endedAt: null, sessionDateId: null }, initialStudents: [student], initialView: 'attendance' },
  contacts: { students: [{ id: 'student-a', name: longName, parentName: '합성긴이름학부모김대한민국', school: '합성다산초등학교', grade: '초4', studentPhone: '00000000000', parentPhone: '00000000000', classNames: [longClass] }] },
  parent: { data: { parent: { id: 'parent-a', name: '합성 보호자', email: null, phone: null }, children: [child] }, feedbacks: [], myRequests: [], notifications: [], unreadCount: 0, parentShuttleOverview: [{ id: 'shuttle-a', studentId: 'student-a', sourceType: 'REGULAR_CLASS', direction: 'PICKUP', status: 'CONFIRMED', label: '정규', title: '합성 셔틀', serviceDate: '2026-10-20', routeName: '합성 1노선', stopName: '합성다산푸르지오아파트정문경비실', stopAddress: null, plannedAt: '2026-10-20T06:30:00Z', vehicleName: '합성 차량', rideStatus: 'PENDING', pickupEtaLabel: '15:30 승차' }], shuttleDriverContact: { name: '합성 기사', phone: '00000000000' } },
  change: { initial: { effectiveFrom: '2026-11-01', minEffectiveFrom: '2026-10-20', maxEffectiveFrom: '2027-01-01', children: [{ studentId: 'student-a', studentName: longName, enrollmentId: 'enroll-a', currentClassId: 'class-a', currentClassName: longClass, currentProgramName: '합성 프로그램', pending: null }], classes: [{ classId: 'class-b', className: longClass, programName: '합성 프로그램', dayOfWeek: 'Mon', startTime: '15:00', endTime: '16:00', capacity: 12, enrolled: 5, full: false }] } },
  payment: { rows: [{ paymentId: 'payment-a', studentId: 'student-a', studentName: longName, description: longClass, amount: 120000, status: 'PENDING', dueDate: '2026-11-01', paidDate: null, invoiceNo: null, receiptUrl: null, pending: [], resolved: [] }] },
  shuttle: { initial: { today: '2026-10-20', maxDate: '2026-11-01', children: [{ studentId: 'student-a', studentName: longName }], upcoming: [{ id: 'change-a', studentId: 'student-a', studentName: longName, serviceDate: '2026-10-21', direction: 'PICKUP', kind: 'SKIP', location: null, note: null }] } },
};
const unused = name => `export async function ${name}(){throw Error('저장·발송 금지')}`;
// 현재 파일은 되돌리지 않는다. 비교 때만 HEAD의 학부모 원본을 별도 격리 모듈로 쓴다.
const baselineCommit = 'cf0ecb43225211b12e9669a0663653c577213b45';
const baselineMocks = before ? {'@/app/mypage/MyPageClient': ts.transpileModule(execFileSync('git',['show',`${baselineCommit}:src/app/mypage/MyPageClient.tsx`],{encoding:'utf8'}), {compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText} : {};
let font;
try { font = await readFile(`${out}/material-full.woff2`); }
catch {
  try { font = await readFile('.tmp/staff-header/material-full.woff2'); }
  catch {
    const response = await fetch('https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght@400');
    assert.ok(response.ok);
    const url = (await response.text()).match(/url\(([^)]+)\)/)?.[1];
    assert.equal(new URL(url).hostname, 'fonts.gstatic.com');
    const file = await fetch(url); assert.ok(file.ok);font=Buffer.from(await file.arrayBuffer());
  }
  await writeFile(`${out}/material-full.woff2`,font);
}
const harness = await startStatusBrowserHarness({ css, assets: {'/material.woff2': {body:font,contentType:'font/woff2'}}, mocks: {
  ...baselineMocks,
  '@/app/actions/staff-sessions': ['savePlannedClassContent', 'startClassSession', 'cancelClassSession', 'completeClassSession', 'saveSessionMemo', 'saveStaffAttendance'].map(unused).join('\n'),
  '@/app/actions/staff-notices': ['createStaffClassNotice', 'getStaffClassNoticeStatus'].map(unused).join('\n'),
  '@/app/actions/staff-billing': `export async function loadStaffSessionMonthlyFees(){return{month:'2026-10',items:[${JSON.stringify(summary)}]}}export async function loadStaffAttendanceBilling(){return{month:'2026-10',summary:${JSON.stringify(summary)},items:[${JSON.stringify(invoice)}]}}export async function loadStaffClassBilling(){return{items:[]}}${unused('requestStaffPaymentConfirmation')}`,
  '@/app/actions/admin': ['markNotificationRead', 'markAllNotificationsRead', 'createParentRequest'].map(unused).join('\n'),
  '@/components/staff/SessionPhotoUploader': 'export function SessionPhotoUploader(){return null}',
  '@/components/staff/VoiceToTextButton': 'export function VoiceToTextButton(){return null}',
  '@/components/staff/ClassPeopleSheet': 'export function ClassPeopleSheet(){return null}',
  'next/dynamic': `import {ClassBillingSheet} from'@/components/staff/ClassBillingSheet';export default function dynamic(){return ClassBillingSheet}`,
}, entry: `import React from'react';import{createRoot}from'react-dom/client';import Home from'@/app/staff/StaffHomeClient';import Session from'@/app/staff/sessions/[sessionId]/SessionInProgressClient';import Contacts from'@/app/staff/students/StaffStudentsClient';import Parent from'@/app/mypage/MyPageClient';import Change from'@/app/mypage/enrollment-change/EnrollmentChangeClient';import Payment from'@/app/mypage/payments/PaymentRequestClient';import Shuttle from'@/app/mypage/shuttle/ShuttleExceptionClient';const key=new URLSearchParams(location.search).get('screen');document.documentElement.classList.add('material-symbols-ready');document.getElementById('root').className='academy-app';createRoot(document.getElementById('root')).render(React.createElement('div',{className:['parent','change','payment','shuttle'].includes(key)?'mx-auto max-w-5xl p-4':''},React.createElement(({home:Home,session:Session,contacts:Contacts,parent:Parent,change:Change,payment:Payment,shuttle:Shuttle})[key],window.__props)));` });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const results = [];
async function inspect(page, key, width) {
  const metrics = await page.evaluate(() => {
    const visible = el => { const r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'; };
    const locallyScrollable = el => { for(let p=el.parentElement;p;p=p.parentElement)if(['auto','scroll'].includes(getComputedStyle(p).overflowX)&&p.scrollWidth>p.clientWidth)return true;return false; };
    const overflow = [...document.querySelectorAll('h1,h2,h3,p,a,button,input,select,textarea')].filter(visible).filter(el=>{ const r=el.getBoundingClientRect(); return (r.left<-.5 || r.right>innerWidth+.5)&&!locallyScrollable(el); }).map(el=>({tag:el.tagName,text:(el.innerText||el.getAttribute('aria-label')||'').slice(0,70),left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}));
    const buttons = [...document.querySelectorAll('button')].filter(visible).filter(el=>!el.className.includes('absolute inset-0')).map(el=>({label:el.innerText.trim(),width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,font:getComputedStyle(el).fontSize}));
    return {width:innerWidth,documentWidth:document.documentElement.scrollWidth,overflow,buttons};
  });
  const contracts = await page.evaluate(key=>{
    const style=el=>getComputedStyle(el);
    const oneLine=el=>{const range=document.createRange();range.selectNodeContents(el);const tops=new Set([...range.getClientRects()].map(r=>Math.round(r.top)));return tops.size===1;};
    const disjoint=(a,b)=>{const x=a.getBoundingClientRect(),y=b.getBoundingClientRect();return Math.min(x.right,y.right)-Math.max(x.left,y.left)<=.5||Math.min(x.bottom,y.bottom)-Math.max(x.top,y.top)<=.5;};
    const wordUnbroken=(el,word)=>{const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode()){const i=node.textContent.indexOf(word);if(i>=0){const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+word.length);return new Set([...r.getClientRects()].map(x=>Math.round(x.top))).size===1;}}return false;};
    const scope=document.querySelector('[role=dialog]')||document.body;
    const controls=[...scope.querySelectorAll('button,a,input,textarea,select')].filter(el=>{const r=el.getBoundingClientRect();return el.checkVisibility()&&r.width&&r.height&&!el.className.includes('absolute inset-0');});
    const pairs=controls.flatMap((a,i)=>controls.slice(i+1).filter(b=>!a.contains(b)&&!b.contains(a)).map(b=>[a,b]));
    const brokenWords=[];
    for(const control of controls.filter(el=>el.tagName==='BUTTON'&&!el.textContent.includes('합성'))){const walker=document.createTreeWalker(control,NodeFilter.SHOW_TEXT);for(let node=walker.nextNode();node;node=walker.nextNode()){if(node.parentElement.closest('.material-symbols-outlined'))continue;for(const word of node.textContent.match(/[가-힣]{2,}/g)||[])if(!wordUnbroken(control,word))brokenWords.push(word);}}
    window.__brokenWords=brokenWords;
    const common={independentControlsDoNotOverlap:pairs.every(([a,b])=>disjoint(a,b)),allStaticButtonWordsUnbroken:brokenWords.length===0};
    if(key==='session'||key==='billing'){const back=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='수업으로 돌아가기');common.returnWordsUnbroken=['수업으로','돌아가기'].every(word=>wordUnbroken(back,word));}
    if(key==='billing'){const amount=[...document.querySelectorAll('[role=dialog] article p')].find(el=>el.textContent==='120,000원');const badge=document.querySelector('[role=dialog] article span');return{...common,amountOneLine:oneLine(amount),amountFontPreserved:parseFloat(style(amount).fontSize)>=24,statusOneLine:oneLine(badge),requestTouchSize:document.querySelector('[role=dialog] article button').getBoundingClientRect().height>=48,amountAndDeadlineSeparate:disjoint(amount,amount.nextElementSibling),nameAndStatusSeparate:disjoint(document.querySelector('[role=dialog] article h3'),badge)};}
    if(key==='parent'){const message=[...document.querySelectorAll('button')].find(el=>el.textContent.includes('학원에 메시지 보내기'));const quick=document.querySelector('a[href="/mypage/reports"] span:last-child');return{...common,messageNoBrokenWords:['학원에','메시지','보내기'].every(word=>wordUnbroken(message,word)),quickActionKeepsWords:wordUnbroken(quick,'리포트'),messageActionsSeparate:disjoint(message,message.nextElementSibling),quickLabelAndIconSeparate:disjoint(quick,quick.previousElementSibling)};}
    if(key==='contacts')return{...common,phoneNumbersUnbroken:[...document.querySelectorAll('a[aria-label]')].every(el=>oneLine(el)),phoneTouchSize:[...document.querySelectorAll('a[href^="tel:"]')].filter(el=>el.innerText.includes('전화')).every(el=>el.getBoundingClientRect().height>=48),contactNameAndPhoneSeparate:[...document.querySelectorAll('a[aria-label]')].every(el=>disjoint(el,el.previousElementSibling))};
    if(key==='payment'){const transfer=[...document.querySelectorAll('button')].find(el=>el.textContent==='계좌이체');return{...common,transferMethodUnbroken:wordUnbroken(transfer,'계좌이체'),methodTouchPreserved:transfer.getBoundingClientRect().height>=44};}
    if(key==='shuttle'){const location=[...document.querySelectorAll('button')].find(el=>el.textContent==='다른 곳에서 타요');return{...common,shuttleKindWordsUnbroken:['다른','곳에서','타요'].every(word=>wordUnbroken(location,word)),kindTouchPreserved:location.getBoundingClientRect().height>=44};}
    return common;
  },key);
  await page.screenshot({ path: `${out}/${width}-${key}.png`, fullPage: true });
  results.push({ key, width, metrics, contracts, pass: metrics.documentWidth<=width && metrics.overflow.length===0 && Object.values(contracts).every(Boolean) });
  console.log(`${results.at(-1).pass?'PASS':'FAIL'} ${width} ${key} ${JSON.stringify(metrics.overflow)} ${JSON.stringify(await page.evaluate(()=>window.__brokenWords))}`);
}
try {
  for (const width of [320,360,375,390]) for (const [key,props] of Object.entries(scenarios).filter(([key])=>!before||key==='parent')) {
    const page = await browser.newPage({viewport:{width,height:844}}); const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(value=>{window.__props=value;delete window.PushManager;},props);
    await page.route('**/*',route=>new URL(route.request().url()).origin===new URL(harness.url).origin&&route.request().method()==='GET'?route.continue():route.abort());
    await page.goto(`${harness.url}/?screen=${key}`);await page.getByRole('heading',{level:1}).waitFor();await page.evaluate(()=>document.fonts.ready);
    if(key==='payment')await page.getByRole('button',{name:'입금했어요 알리기'}).click();
    if(key==='parent')for(const detail of await page.locator('details').all())await detail.evaluate(el=>el.open=true);
    await inspect(page,key,width);
    if(key==='session'){await page.getByRole('button',{name:`${longName} 수강료·청구 확인`}).click();await page.getByRole('dialog').waitFor();await page.getByText('120,000원',{exact:true}).first().waitFor();await inspect(page,'billing',width);}
    assert.deepEqual(errors,[]);await page.close();
  }
} finally { await browser.close();await harness.close();await writeFile(`${out}/report.json`,JSON.stringify({scope:'synthetic browser viewport, not physical device',results},null,2)); }
if(!before)assert.ok(results.every(r=>r.pass),'좁은 화면 넘침 확인 필요');console.log(`${results.length} narrow screens ${before?'baseline recorded':'passed'}`);
