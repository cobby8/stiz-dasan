import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
// 6단계(2026-11-09): 기사님 순서·시각 저장 = 셔틀 명단만. 저장 노선(RegularDispatchRoute)·ORM 기본 메서드는 쓰지 않는다.
function load(file, deps={}) {
 const exports={}; vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Intl,Request,Response,console,require(name){if(!(name in deps))throw Error(name);return deps[name]}});return exports;
}
const logic=load('src/lib/shuttle/regularDriverRouteLogic.ts');
const unified=load('src/lib/shuttle/unifiedDriverRunLogic.ts');
const plan=load('src/lib/shuttle/driverOrderPlan.ts',{'./regularDriverRouteLogic':logic,'./unifiedDriverRunLogic':unified});
const routeSource=readFileSync('src/app/api/shuttle/regular-order/route.ts','utf8');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function setup({failWrite=false,failVerify=false}={}){
 let state={rows:[1,2].map((n,i)=>({id:id(n),serviceMonth:'2026-10',weekday:1,weekdayLabel:'월',direction:'BOARD',studentName:`합성${n}`,studentId:`student${n}`,stopName:`정류장${n}`,classTime:'15:00~16:00',arriveTime:i?'14:45':'14:38',sortOrder:i,parentPhone:null,studentPhone:null,note:null}))};
 let commits=0,rollbacks=0,writes=0;const sqls=[];
 const deps={
 'next/server':{NextResponse:{json(body,options={}){return new Response(JSON.stringify(body),options)}}},
 '@/lib/shuttle/driverToken':{isAnyDriverRunToken:async token=>token==='valid'},
 // 운행 링크 스위치 켜짐(기존 동작) — 스위치 자체는 driver-link-toggle.test.mjs 가 검사한다.
 '@/lib/shuttle/driverLinkAccess':{driverLinkBlocked:async()=>false,driverLinkDisabledResponse:()=>new Response('{}',{status:410})},
 '@/lib/datetime/kst':{kstDow:()=>1},
 '@/lib/shuttle/driverOrderPlan':plan,
 '@/lib/prisma':{prisma:{$transaction:async(fn,options)=>{assert.equal(options.isolationLevel,'Serializable');const before=structuredClone(state);try{
 const tx={
 $queryRawUnsafe:async(sql,...v)=>{sqls.push(sql);if(sql.includes('RegularDispatchRoute'))throw Error('저장 노선 조회 금지');
  if(sql.startsWith('SELECT *'))return structuredClone(state.rows.filter(row=>row.serviceMonth===v[0]&&row.weekday===v[1]).sort((a,b)=>a.sortOrder-b.sortOrder));
  // 읽어 확인(readback)
  return failVerify?[]:state.rows.filter(row=>v[0].includes(row.id)&&row.serviceMonth===v[1]&&row.weekday===v[2]).map(r=>({id:r.id,sortOrder:r.sortOrder,arriveTime:r.arriveTime}));},
 $executeRawUnsafe:async(sql,sortOrder,arriveTime,ids,month,weekday)=>{sqls.push(sql);writes++;if(failWrite)throw Error('SECRET database details');assert.match(sql,/^UPDATE "RegularShuttleStop"/);let count=0;for(const row of state.rows)if(ids.includes(row.id)&&row.serviceMonth===month&&row.weekday===weekday){row.sortOrder=sortOrder;row.arriveTime=arriveTime;count++}return count},
 };const result=await fn(tx);commits++;return result;
 }catch(error){state=before;rollbacks++;throw error}}}}
 };
 const api=load('src/app/api/shuttle/regular-order/route.ts',deps);
 const updates=[{rowIds:[id(2)],sortOrder:0,arriveTime:'14:38'},{rowIds:[id(1)],sortOrder:1,arriveTime:'14:45'}];
 return{api,updates,sqls,get state(){return state},get stats(){return{commits,rollbacks,writes}},post:body=>api.POST(new Request('http://test/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'valid',date:'2026-10-19',baseline:[{rowIds:[id(1)],sortOrder:0,arriveTime:'14:38'},{rowIds:[id(2)],sortOrder:1,arriveTime:'14:45'}],updates,...body})}))};
}

test('명단 순서·시각 저장 후 기사님 조립기(명단 순서)로 재조회해도 같은 순서·시각',async()=>{
 const f=setup();const response=await f.post();assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,verified:true,updated:2});
 const result=logic.buildFallbackClasses([...f.state.rows].sort((a,b)=>a.sortOrder-b.sortOrder),()=>false);
 assert.deepEqual(Array.from(result[0].board,s=>s.rows[0].rowId),[id(2),id(1)]);assert.deepEqual(Array.from(result[0].board,s=>s.arriveTime),['14:38','14:45']);assert.equal(f.stats.commits,1);
});
test('저장 노선은 읽지도 쓰지도 않고, ORM 기본 메서드도 쓰지 않는다',async()=>{
 const f=setup();assert.equal((await f.post()).status,200);assert.ok(f.sqls.every(sql=>!sql.includes('RegularDispatchRoute')));
 assert.doesNotMatch(routeSource,/FROM "RegularDispatchRoute"|UPDATE "RegularDispatchRoute"|to_regclass|getRegularShuttleRiders/);
 assert.doesNotMatch(routeSource,/\.regularShuttleStop\.|\.updateMany\(|\.findMany\(/);
});
for(const [name,change] of [
 ['잘못된 토큰',{token:'invalid'}],['빈 요청',{updates:[]}],['다른 월',{date:'2026-11-02'}],['모르는 행',{updates:[{rowIds:[id(88)],sortOrder:0,arriveTime:'14:30'}]}],['누락 행',{updates:[{rowIds:[id(1)],sortOrder:0,arriveTime:'14:30'}]}],['중복 행',{updates:[{rowIds:[id(1),id(1)],sortOrder:0,arriveTime:'14:30'}]}],['다른 정차 합침',{updates:[{rowIds:[id(1),id(2)],sortOrder:0,arriveTime:'14:30'}]}],['잘못된 시간',{updates:[{rowIds:[id(1)],sortOrder:0,arriveTime:'25:30'},{rowIds:[id(2)],sortOrder:1,arriveTime:'14:40'}]}]
])test(`${name}는 쓰기 없이 거절`,async()=>{const f=setup();const before=JSON.stringify(f.state);assert.ok((await f.post(change)).status>=400);assert.equal(JSON.stringify(f.state),before);assert.equal(f.stats.writes,0)});
for(const flag of ['failWrite','failVerify'])test(`${flag}이면 부분저장 rollback 및 내부정보 비노출`,async()=>{const f=setup({[flag]:true});const before=JSON.stringify(f.state);const response=await f.post();assert.ok(response.status>=400);assert.equal(JSON.stringify(f.state),before);assert.equal(f.stats.rollbacks,1);assert.equal((await response.text()).includes('SECRET'),false)});
test('시각 지우기는 명단 도착 시각을 비운다',async()=>{const f=setup();assert.equal((await f.post({updates:[{rowIds:[id(1)],sortOrder:0,arriveTime:null},{rowIds:[id(2)],sortOrder:1,arriveTime:null}]})).status,200);assert.ok(f.state.rows.every(row=>row.arriveTime===null))});
test('시간을 바꾸지 않고 순서만 뒤집으면 재조회 순서 불일치를 저장 전에 거절',async()=>{const f=setup();const before=JSON.stringify(f.state);const response=await f.post({updates:[{rowIds:[id(2)],sortOrder:0,arriveTime:'14:45'},{rowIds:[id(1)],sortOrder:1,arriveTime:'14:38'}]});assert.equal(response.status,409);assert.equal(JSON.stringify(f.state),before);assert.equal(f.stats.writes,0)});
test('다른 요일 행을 섞으면 전체 저장 거절',async()=>{const f=setup();f.state.rows[1].weekday=2;assert.equal((await f.post()).status,409);assert.equal(f.stats.writes,0)});
test('하원 명단도 같은 방식으로 저장',async()=>{const f=setup();f.state.rows.forEach(row=>row.direction='ALIGHT');const response=await f.post();assert.equal(response.status,200);assert.equal(f.state.rows.find(r=>r.id===id(2)).sortOrder,0)});
test('원본 baseline 없는 이전 화면은 새로고침 안내 후 쓰기 없이 거절',async()=>{const f=setup();assert.equal((await f.post({baseline:null})).status,409);assert.equal(f.stats.writes,0)});
test('첫 저장이 끝난 뒤 도착한 오래된 두 번째 탭은 baseline 비교로 거절',async()=>{const f=setup();assert.equal((await f.post()).status,200);const after=JSON.stringify(f.state);const writes=f.stats.writes;const response=await f.post();assert.equal(response.status,409);assert.equal(JSON.stringify(f.state),after);assert.equal(f.stats.writes,writes)});
test('오래된 baseline이 시각만 다르더라도 저장 전 거절',async()=>{const f=setup();f.state.rows[0].arriveTime='14:39';const before=JSON.stringify(f.state);assert.equal((await f.post()).status,409);assert.equal(f.stats.writes,0);assert.equal(JSON.stringify(f.state),before)});
test('같은 정류장 두 학생은 하나의 정차로 묶어 두 행을 함께 저장',async()=>{const f=setup();for(const row of f.state.rows){row.stopName='공용 정류장';row.arriveTime='14:38';}const response=await f.post({baseline:[{rowIds:[id(1),id(2)],sortOrder:0,arriveTime:'14:38'}],updates:[{rowIds:[id(1),id(2)],sortOrder:0,arriveTime:'14:40'}]});assert.equal(response.status,200);assert.equal((await response.json()).updated,2);assert.ok(f.state.rows.every(row=>row.arriveTime==='14:40'))});
// 2026-11-13: 순서 번호는 묶음(수업시간 × 방향)마다 그 묶음이 쓰던 번호를 돌려 쓴다.
// 예전엔 0,1,2…로 새로 매겨 2호점 경유·복귀 행(학생 없는 행, 번호 7·17 등)과 뒤섞였다.
test('순서 번호는 묶음이 쓰던 번호를 돌려 쓴다(0,1,2…로 새로 매기지 않음)',async()=>{const f=setup();f.state.rows[0].sortOrder=18;f.state.rows[1].sortOrder=25;const response=await f.post();assert.equal(response.status,200);
 assert.equal(f.state.rows.find(r=>r.id===id(2)).sortOrder,18);assert.equal(f.state.rows.find(r=>r.id===id(1)).sortOrder,25)});
test('planDriverRowSlots — 묶음별로 따로 돌려 쓰고 다른 묶음 번호는 건드리지 않는다',()=>{
 const rows=[{id:'a',classTime:'15:00~16:00',direction:'BOARD',sortOrder:5},{id:'b',classTime:'15:00~16:00',direction:'BOARD',sortOrder:6},{id:'c',classTime:'18:00~19:20',direction:'BOARD',sortOrder:18},{id:'d',classTime:'18:00~19:20',direction:'BOARD',sortOrder:25}];
 const out=plan.planDriverRowSlots(rows,[{rowIds:['b'],sortOrder:0,arriveTime:'14:40'},{rowIds:['a'],sortOrder:1,arriveTime:'14:45'},{rowIds:['d'],sortOrder:2,arriveTime:'17:30'},{rowIds:['c'],sortOrder:3,arriveTime:'17:55'}]);
 const by=Object.fromEntries(out.map(o=>[o.id,o.sortOrder]));assert.deepEqual(by,{b:5,a:6,d:18,c:25});
});
test('planDriverRowSlots — 같은 번호가 겹쳐 있으면 1씩 올려 순서를 지킨다',()=>{
 const rows=[{id:'a',classTime:'x',direction:'BOARD',sortOrder:3},{id:'b',classTime:'x',direction:'BOARD',sortOrder:3}];
 const out=plan.planDriverRowSlots(rows,[{rowIds:['b','a'],sortOrder:0,arriveTime:'14:40'}]);
 assert.equal(JSON.stringify(out.map(o=>[o.id,o.sortOrder])),JSON.stringify([['b',3],['a',4]]));
});
