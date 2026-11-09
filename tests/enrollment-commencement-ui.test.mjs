import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
const require = createRequire(import.meta.url);
const cache = new Map();
function load(file, overrides = {}) {
  const full = path.resolve(file);
  if (Object.keys(overrides).length === 0 && cache.has(full)) return cache.get(full);
  const exports = {};
  const code = ts.transpileModule(readFileSync(full, 'utf8'), { fileName: full, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  new Function('require','exports',code)((id) => {
    if (Object.hasOwn(overrides,id)) return overrides[id];
    if (id === '@/app/actions/admin') return new Proxy({}, { get: () => () => { throw Error('검사 중 운영 작업 금지'); } });
    if (id === 'next/link') return { default: ({ children, prefetch, ...props }) => React.createElement('a',props,children) };
    if (id.includes('AdminModal') || id.includes('ListDetailPanel')) return { default: ({children}) => React.createElement('div',{className:'w-full min-w-0 max-w-full p-4',role:'dialog'},children) };
    if (id.includes('LocationPickerModal')) return { default: () => null };
    if (id === '@/components/ui/FontFreeIcon') return { default: () => React.createElement('span') };
    if (id.startsWith('@/') || id.startsWith('.')) { const target=id.startsWith('@/') ? path.resolve('src',id.slice(2)) : path.resolve(path.dirname(full),id); return load(existsSync(target+'.ts')?target+'.ts':existsSync(target+'.tsx')?target+'.tsx':target); }
    return require(id);
  }, exports);
  if (Object.keys(overrides).length === 0) cache.set(full,exports); return exports;
}
const display = load('src/lib/enrollment-application-display.ts');
const LaterSteps = load('src/app/apply/enroll/EnrollApplicationLaterSteps.tsx').default;
const Modals = load('src/app/admin/apply/ApplyAdminModals.tsx').default;
const Progress = load('src/app/admin/apply/EnrollmentShuttleProgressView.tsx').default;
const progress = {status:'ROSTER_PENDING',label:'배차 대기',detail:'월·수 등하원 명단을 확인해 주세요.',serviceMonth:'2026-11',confirmedCount:0,totalCount:4,legs:['Mon','Wed'].flatMap(dayOfWeek=>['PICKUP','DROPOFF'].map(direction=>({dayOfWeek,direction,status:'ROSTER_PENDING',label:'배차 대기',detail:'명단 미반영',timeLabel:null}))),rosterHref:'/admin/shuttle/regular?month=2026-11',dispatchHref:'/admin/shuttle/regular-dispatch?month=2026-11'};
const app = {id:'synthetic-app',childName:'합성 학생',childBirthDate:'2017-01-01',status:'PENDING',enrollmentMonths:null,requestedStartOn:'2026-11-09',preferredSlotKeys:'Mon-5,Wed-5',shuttleNeeded:true,shuttleProgress:progress,parentName:'합성 보호자',parentPhone:'',createdAt:'2026-11-03'};
const classes=['Mon','Wed'].map(dayOfWeek=>({id:dayOfWeek,name:`${dayOfWeek==='Mon'?'월':'수'}요일 5교시`,dayOfWeek,startTime:'17:00',endTime:'17:55',slotKey:`${dayOfWeek}-5`,program:{id:'synthetic',name:'합성 수업'}}));
const form={requestedStartOn:app.requestedStartOn,preferredSlotKeys:['Mon-5','Wed-5'],shuttleChoice:'미탑승',referralSource:'NAVER_SEARCH'};
const modalProps={classes,approveApp:null,rejectApp:null,detailApp:app,editApp:null,cancelApp:null,onCloseApprove(){},onCloseReject(){},onCloseDetail(){},onCloseEdit(){},onCloseCancel(){},onSaved(){},onFeedback(){}};
const detailHtml = render(React.createElement(Modals,modalProps));
test('신규 신청은 복수 월 대신 날짜 하나를 받고 마지막 확인에도 같은 값을 표시한다',()=>{
 const input=render(React.createElement(LaterSteps,{step:3,form,availableSlots:[],update(){},toggleSlot(){}}));
 assert.match(input,/type="date"[^>]*required=""[^>]*value="2026-11-09"/);
 assert.doesNotMatch(input,/수강신청 월|enrollmentMonths/);
 const summary=render(React.createElement(LaterSteps,{step:4,form,availableSlots:[],update(){},toggleSlot(){}}));
 assert.match(summary,/수강 개시일/); assert.match(summary,/2026-11-09/);
});
test('상세는 목록과 같은 날짜 포맷 및 월·수 실제 수업을 보여준다',()=>{
 assert.match(detailHtml,/수강 개시일/); assert.ok(detailHtml.includes(display.formatEnrollmentStartOn(app.requestedStartOn)));
 assert.match(detailHtml,/월요일 5교시/); assert.match(detailHtml,/수요일 5교시/); assert.match(detailHtml,/17:00~17:55/);
 assert.doesNotMatch(detailHtml,/기존 신청 월/);
});
test('구형 신청은 월을 날짜로 추정하지 않고 기존 월을 모두 보존한다',()=>{
 const html=render(React.createElement(Modals,{...modalProps,detailApp:{...app,requestedStartOn:null,enrollmentMonths:'2026년 11월,2026년 10월'}}));
 assert.match(html,/개시일 확인 필요/); assert.match(html,/2026년 10·11월/); assert.doesNotMatch(html,/2026\.11\.01/);
});
test('승인 창은 별도로 확정 개시일을 받으며 legacy는 빈 값으로 남긴다',()=>{
 for(const requestedStartOn of [null,'2026-11-09']) {
  const html=render(React.createElement(Modals,{...modalProps,detailApp:null,approveApp:{...app,requestedStartOn}}));
  assert.match(html,/확정 수강 개시일/); assert.match(html,/바로 수강 중\(재원생\)으로 등록/); assert.doesNotMatch(html,/수강 예정/);
  assert.ok(html.includes(`value="${requestedStartOn||''}"`));
 }
});
test('셔틀 상세는 네 방향의 배차 대기를 보존하고 조회 누락을 완료로 위장하지 않는다',()=>{
 assert.equal((detailHtml.match(/명단 미반영/g)||[]).length,4);
 assert.match(detailHtml,/0\/4 배차 확정/);
 assert.match(render(React.createElement(Progress,{detailed:true})),/셔틀 상태 확인 필요/);
});
test('모바일 목록도 개시일·셔틀 상태를 같은 행에서 읽고 승인된 개시일은 신청 수정으로 바꾸지 않는다',()=>{
 const client=readFileSync('src/app/admin/apply/ApplyAdminClient.tsx','utf8');
 assert.match(client,/lg:hidden`\}><span className="sr-only">수강 개시일 <\/span>\{formatEnrollmentStartOn\(app.requestedStartOn\)\}/);
 assert.match(client,/md:hidden"><EnrollmentShuttleProgressView/);
 const html=render(React.createElement(Modals,{...modalProps,detailApp:null,editApp:{...app,status:'APPROVED'}}));
 assert.match(html,/type="date" disabled=""/);
});
test('관리자 수업일지는 신규 개시 전 출석을 막고 같은 회차의 실제 과거 출결은 보존한다',async()=>{
 const history={id:'past',date:'2026-11-01',attendances:[{studentId:'future',status:'PRESENT'}]};
 for (const [date,initialData,expected] of [['2026-11-08',undefined,['legacy']],['2026-11-09',undefined,['legacy','future']],['2026-11-01',history,['legacy','future']],['2026-11-02',history,['legacy']]]) {
  let stateIndex=0, saved;
  const students=[{id:'legacy',name:'기존',startsOn:null},{id:'future',name:'예정',startsOn:'2026-11-09'}];
  const hooks={...React,useState(initial){const index=stateIndex++;return [index===0?date:index===6?students.map(s=>({studentId:s.id,studentName:s.name,status:'PRESENT'})):initial,()=>{}];},useEffect(){},useMemo:fn=>fn(),useCallback:fn=>fn,useRef:()=>({current:null})};
  const Client=load('src/app/admin/classes/[id]/SessionLogModal.tsx',{'react':hooks,'@/app/actions/admin':{saveSessionLog:async data=>{saved=data;}},'@/lib/clientImageCompression':{}}).default;
  const tree=Client({isOpen:true,classId:'class',students,coaches:[],initialData,onClose(){},onSaved(){}});
  const nodes=[]; const walk=node=>{if(Array.isArray(node))return node.forEach(walk);if(node&&typeof node==='object'&&node.props){nodes.push(node);walk(node.props.children);}};walk(tree);
  const save=nodes.find(n=>n.type==='button'&&['저장','수정 완료'].includes(n.props.children));assert.ok(save);
  await save.props.onClick();
  assert.equal(saved.date,date);
  assert.deepEqual(saved.attendances.map(a=>a.studentId),expected);
 }
});
test('실제 신청 목록도 모바일 개시일·셔틀 상태와 PC 날짜를 같은 자료에서 표시한다',()=>{
 const Client=load('src/app/admin/apply/ApplyAdminClient.tsx',{
  react:{...React,useState(initial){return React.useState(initial==='trial'?'applications':initial);}},
  'next/dynamic':{default:()=>()=>null},
  './ManualSmsModal':{default:()=>null},
  '@/components/admin/AdminQuickActionMenu':{default:()=>null},
 }).default;
 assert.equal(typeof Client,'function',JSON.stringify(Client));
 const html=render(React.createElement(Client,{initialApplications:[app],initialClasses:classes,initialStats:{total:1,PENDING:1,APPROVED:0,REJECTED:0,CANCELLED:0}}));
 assert.match(html,/수강 개시일/);assert.equal((html.match(/2026\.11\.09/g)||[]).length,2);
 assert.match(html,/월5 \/ 수5/);assert.ok((html.match(/배차 대기/g)||[]).length>=2);
 assert.doesNotMatch(html,/화69|수강 시작월/);
 if(process.env.STIZ_UI_PROOF_DIR)writeFileSync(path.join(process.env.STIZ_UI_PROOF_DIR,'list.html'),`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/proof.css"><body class="academy-app"><main style="padding:12px">${html}</main></body></html>`);
});
if(process.env.STIZ_UI_PROOF_DIR) {
 mkdirSync(process.env.STIZ_UI_PROOF_DIR,{recursive:true});
 for(const [name,body] of Object.entries({detail:detailHtml,input:render(React.createElement(LaterSteps,{step:3,form,availableSlots:[],update(){},toggleSlot(){}})),progress:render(React.createElement(Progress,{progress,detailed:true}))})) writeFileSync(path.join(process.env.STIZ_UI_PROOF_DIR,`${name}.html`),`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/proof.css"><body class="academy-app"><main style="max-width:600px;margin:auto;padding:12px">${body}</main></body></html>`);
}
