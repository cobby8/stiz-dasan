import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const native=createRequire(import.meta.url),cache=new Map();
let liveCalls=0;
function load(file){
 const path=resolve(file);if(cache.has(path))return cache.get(path);const exports={};cache.set(path,exports);
 const require=name=>{
  if(name==='server-only')return {};
  if(name==='@/lib/prisma')return {prisma:{}};
  if(name==='@/lib/notification')return {sendTrackedSms:async()=>{liveCalls++;throw Error('LIVE forbidden');}};
  if(name.startsWith('@/'))return load(`src/${name.slice(2)}.ts`);
  if(name.startsWith('.'))return load(resolve(dirname(path),name.endsWith('.ts')?name:`${name}.ts`));
  return native(name);
 };
 vm.runInNewContext(ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require,process,Date,Object,Array,Number,String,Set,Map,Error,Promise,JSON});return exports;
}
const outbox=load('src/lib/enrollment/route-plan-outbox.ts'),worker=load('src/lib/enrollment/route-plan-worker.ts'),recipient=load('src/lib/enrollment/route-plan-recipient.ts'),calc=load('src/lib/shuttle/routePlanning.ts');
function fixture(){
 const point={id:'stop',label:'합성 정류장',lat:37.6,lng:127.1};
 const entries=[{studentId:'student',dayOfWeek:'Mon',direction:'PICKUP',timeMin:1000,locationKey:calc.planLocationKey(point),locationLabel:point.label}];
 const routes=[{dayOfWeek:'Mon',direction:'PICKUP',payload:{vehicles:[{stops:[{...point,etaMinutes:1000,students:[{requestId:'student'}]}]}]}}];
 const state={row:{id:'notice',versionId:'version',studentId:'student',recipientPhone:'01000000000',recipientKey:recipient.routeRecipientKey('parent','01000000000'),message:'합성 배차 안내',entries,status:'PENDING'},parent:{parentId:'parent',phone:'01000000000',withdrawnAt:null,mergedIntoStudentId:null},confirmed:true,routes,latest:structuredClone(routes),snapshots:new Set(),queries:0,hook:null};
 const db={
  async $queryRawUnsafe(sql,...args){state.queries++;
   if(sql.includes('SELECT * FROM "RegularRouteNoticeOutbox"'))return args[0]===state.row.id?[{...state.row}]:[];
   if(sql.includes('SELECT status,"providerId"'))return [{...state.row}];
   if(sql.includes('SELECT s."parentId"'))return state.parent?[{...state.parent}]:[];
   if(sql.includes('SELECT v."serviceMonth"'))return [{serviceMonth:'2026-11',afterSnapshot:{routes:structuredClone(state.routes)},draftData:{runs:[{dayOfWeek:'Mon',direction:'PICKUP',stops:[{students:[{studentId:'student'}]}]}]},confirmed:state.confirmed}];
   if(sql.includes('SELECT "afterSnapshot"'))return [{afterSnapshot:{routes:structuredClone(state.latest)}}];
   if(sql.includes('FROM "RegularDispatchRoute"'))return structuredClone(state.routes);
   if(sql.includes('SELECT v.id'))return state.confirmed&&args[0]==='version'?[{id:'version'}]:[];
   if(sql.includes('SELECT id FROM "RegularRouteNoticeOutbox"'))return state.row.status==='PENDING'&&args[0]===state.row.versionId?[{id:'notice'}]:[];
   if(sql.includes('NotificationDelivery'))return state.delivery??[];
   throw Error(`Unexpected query ${sql}`);
  },
  async $executeRawUnsafe(sql,...args){
   if(sql.includes('INSERT INTO "RegularRouteNoticeSnapshot"')){if(state.row.status==='DELIVERED')state.snapshots.add(state.row.id);return 1;}
   if(sql.includes("status='SENDING'" )&&sql.includes('SET status=' )&&!sql.includes('AND status=')){state.row.status='SENDING';if(state.hook)state.hook(state);return 1;}
   if(sql.includes("SET status='FAILED'")){state.row.status='FAILED';state.row.errorCode=args[1];return 1;}
   if(sql.includes('SET status=$2')){if(state.row.status==='SENDING'){state.row.status=args[1];state.row.providerId=args[2];state.row.errorCode=args[3];}return 1;}
   if(sql.includes("SET status='DELIVERED'")){state.row.status='DELIVERED';return 1;}
   if(sql.includes("SET status='UNKNOWN'")){if(state.row.status==='SENDING')state.row.status='UNKNOWN';return 1;}
   throw Error(`Unexpected write ${sql}`);
  }
 };
 let tail=Promise.resolve();const store={...db,$transaction(fn){const result=tail.then(()=>fn(db));tail=result.catch(()=>{});return result;}};
 return {state,store};
}
const options={syntheticOnly:true,approvedVersionId:'version'};
const synthetic=(send=async()=>({status:'ACCEPTED',providerId:'synthetic-id'}))=>({kind:'SYNTHETIC',send});
test('기본OFF는 조회·공급자 호출 전에 차단하며 합성 실행에 LIVE 공급자를 섞지 못한다',async()=>{
 const {state,store}=fixture();delete process.env.STIZ_ROUTE_NOTICE_SEND;
 assert.equal((await worker.dispatchConfirmedRouteVersion('version',store)).status,'BLOCKED');assert.equal(state.queries,0);
 assert.equal((await worker.dispatchConfirmedRouteVersion('version',store,worker.trackedRouteNoticeProvider,true)).status,'BLOCKED');assert.equal(liveCalls,0);
 assert.equal((await outbox.dispatchRouteNotice(store,'notice',synthetic(),{syntheticOnly:true})).status,'BLOCKED');
});
test('원장 확정 버전 worker→점유→합성 공급자→전달 확인은 하나의 안내만 만든다',async()=>{
 const {state,store}=fixture();let calls=0;
 const provider=synthetic(async()=>{calls++;return {status:'ACCEPTED',providerId:'synthetic-id'};});
 assert.equal((await worker.dispatchConfirmedRouteVersion('version',store,provider,true)).results[0].status,'ACCEPTED');assert.equal(state.snapshots.size,0);
 await worker.dispatchConfirmedRouteVersion('version',store,provider,true);assert.equal(calls,1);
 assert.equal((await outbox.recordRouteNoticeDelivery(store,{outboxId:'notice',providerId:'wrong',delivered:true})).accepted,false);
 await outbox.recordRouteNoticeDelivery(store,{outboxId:'notice',providerId:'synthetic-id',delivered:true});await outbox.recordRouteNoticeDelivery(store,{outboxId:'notice',providerId:'synthetic-id',delivered:true});assert.equal(state.snapshots.size,1);
});
test('미확정·다른 버전·중복 동시점유는 발송하지 않는다',async()=>{
 const {state,store}=fixture();let calls=0;const provider=synthetic(async()=>{calls++;return {status:'ACCEPTED',providerId:'id'};});
 state.confirmed=false;assert.equal((await worker.dispatchConfirmedRouteVersion('version',store,provider,true)).status,'NOT_CONFIRMED');state.confirmed=true;
 await outbox.dispatchRouteNotice(store,'notice',provider,{...options,approvedVersionId:'other'});assert.equal(calls,0);
 await Promise.all([outbox.dispatchRouteNotice(store,'notice',provider,options),outbox.dispatchRouteNotice(store,'notice',provider,options)]);assert.equal(calls,1);
});
test('현재 보호자 계정·번호·탈퇴·학생 병합 변경은 전송 없이 보류한다',async()=>{
 for(const mutate of [s=>s.parent.parentId='other',s=>s.parent.phone='01099999999',s=>s.parent.withdrawnAt=new Date(),s=>s.parent.mergedIntoStudentId='other',s=>s.parent=null]){
  const {state,store}=fixture();mutate(state);let calls=0;await outbox.dispatchRouteNotice(store,'notice',synthetic(async()=>{calls++;return {status:'DELIVERED',providerId:'id'};}),options);
  assert.equal(calls,0);assert.equal(state.row.status,'FAILED');assert.equal(state.row.errorCode,'CURRENT_RECIPIENT_CHANGED');assert.equal(state.snapshots.size,0);
 }
});
test('점유 직후 보호자 변경도 공급자 호출 직전에 재확인한다',async()=>{
 const {state,store}=fixture();state.hook=s=>{s.parent.parentId='changed';};let calls=0;
 await outbox.dispatchRouteNotice(store,'notice',synthetic(async()=>{calls++;return {status:'DELIVERED',providerId:'id'};}),options);assert.equal(calls,0);assert.equal(state.row.status,'FAILED');
});
test('새 버전에서 같은 학생 시각·위치 변경과 직접 배차 수정은 보류한다',async()=>{
 for(const mutate of [s=>s.latest[0].payload.vehicles[0].stops[0].etaMinutes++,s=>s.latest[0].payload.vehicles[0].stops[0].lat+=.01,s=>s.routes[0].payload.vehicles[0].stops[0].etaMinutes++]){
  const {state,store}=fixture();mutate(state);let calls=0;await outbox.dispatchRouteNotice(store,'notice',synthetic(async()=>{calls++;return {status:'DELIVERED',providerId:'id'};}),options);assert.equal(calls,0);assert.equal(state.row.status,'FAILED');
 }
 const {state,store}=fixture();state.latest.push({dayOfWeek:'Tue',direction:'DROPOFF',payload:{vehicles:[]}});assert.equal((await outbox.dispatchRouteNotice(store,'notice',synthetic(),options)).status,'ACCEPTED');
});
test('공급자 예외·모호한 성공은 UNKNOWN이며 재전송하지 않는다',async()=>{
 for(const send of [async()=>{throw Error('timeout');},async()=>({status:'ACCEPTED'}),async()=>({status:'nonsense'})]){
  const {state,store}=fixture();let calls=0;const provider=synthetic(async input=>{calls++;return send(input);});assert.equal((await outbox.dispatchRouteNotice(store,'notice',provider,options)).status,'UNKNOWN');await outbox.dispatchRouteNotice(store,'notice',provider,options);assert.equal(calls,1);assert.equal(state.snapshots.size,0);
 }
});
test('후속 전달 장부도 본문 지문이 일치하는 성공만 전달완료로 기록한다',async()=>{
 const {state,store}=fixture();state.row.status='ACCEPTED';state.row.providerId='provider';process.env.STIZ_ROUTE_NOTICE_SEND='enabled';
 try{state.delivery=[{id:'notice',providerId:'provider',message:state.row.message,bodyHash:'wrong'}];assert.equal((await worker.reconcileRouteNoticeDeliveries(store)).updated,0);
 state.delivery[0].bodyHash=createHash('sha256').update(state.row.message).digest('hex');assert.equal((await worker.reconcileRouteNoticeDeliveries(store)).updated,1);assert.equal(state.snapshots.size,1);}finally{delete process.env.STIZ_ROUTE_NOTICE_SEND;}
});
test('이전 안내 기준 보존용 다른 요일은 이번 발송 증명 범위에 섞지 않는다',async()=>{
 const {state,store}=fixture();state.row.entries.push({...state.row.entries[0],dayOfWeek:'Fri',timeMin:1100});
 assert.equal((await outbox.dispatchRouteNotice(store,'notice',synthetic(),options)).status,'ACCEPTED');
});
test('정책 차단은 FAILED, 접수 불명은 UNKNOWN으로 구분한다',()=>{
 assert.equal(worker.classifyTrackedRouteResult({ok:false,to:'',reason:'AUTOMATION_DISABLED'}).status,'FAILED');
 assert.equal(worker.classifyTrackedRouteResult({ok:false,to:'',reason:'SMS request timed out'}).status,'UNKNOWN');
 assert.equal(worker.classifyTrackedRouteResult({ok:true,to:'',reason:'DUPLICATE_SKIPPED'}).status,'UNKNOWN');
});
