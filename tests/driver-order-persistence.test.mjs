import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
function load(file, deps={}) {
 const exports={}; vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,Date,Intl,Request,Response,console,require(name){if(!(name in deps))throw Error(name);return deps[name]}});return exports;
}
const logic=load('src/lib/shuttle/regularDriverRouteLogic.ts');
const unified=load('src/lib/shuttle/unifiedDriverRunLogic.ts');
const plan=load('src/lib/shuttle/driverOrderPlan.ts',{'./regularDriverRouteLogic':logic,'./unifiedDriverRunLogic':unified});
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function setup({fallback=false,failWrite=false,failVerify=false,missingTable=false}={}){
 let state={rows:[1,2].map((n,i)=>({id:id(n),serviceMonth:'2026-10',weekday:1,weekdayLabel:'월',direction:'BOARD',studentName:`합성${n}`,studentId:`student${n}`,stopName:`정류장${n}`,classTime:'15:00~16:00',arriveTime:i?'14:45':'14:38',sortOrder:i,parentPhone:null,studentPhone:null,note:null})),routes:fallback?[]:[{id:'route-id',direction:'PICKUP',payload:{custom:'preserve',vehicles:[{vehicleName:'합성차량',tripLabel:'1회',custom:'vehicle',stops:[{label:'차고지',lat:10,students:[]},{label:'정류장1',lat:11,lng:12,etaLabel:'14:38 승차',students:[{requestId:'student1',custom:'student'}]},{label:'정류장2',lat:21,lng:22,etaLabel:'14:45 승차',students:[{requestId:'student2'}]}]}]}}]};
 let commits=0,rollbacks=0,writes=0;
 const deps={
 'next/server':{NextResponse:{json(body,options={}){return new Response(JSON.stringify(body),options)}}},
 '@/lib/shuttle/driverToken':{isAnyDriverRunToken:async token=>token==='valid'},
 '@/lib/datetime/kst':{kstDow:()=>1}, '@/lib/regular/shuttleRosterLogic':{DOW_NAMES:['Sun','Mon','Tue','Wed','Thu','Fri','Sat']},
 '@/lib/shuttle/driverOrderPlan':plan,
 '@/lib/regular/shuttleRoster':{getRegularShuttleRiders:async({direction})=>({riders:state.rows.filter(row=>row.direction===(direction==='PICKUP'?'BOARD':'ALIGHT')).map(row=>({studentId:row.studentId,stopRowId:row.id})),unassigned:[]})},
 '@/lib/prisma':{prisma:{$transaction:async(fn,options)=>{assert.equal(options.isolationLevel,'Serializable');const before=structuredClone(state);try{
 const tx={
 $queryRawUnsafe:async(sql,month,weekday)=>sql.includes('to_regclass')?[{present:!missingTable}]:sql.includes('RegularShuttleStop')?state.rows.filter(row=>row.serviceMonth===month&&row.weekday===weekday):structuredClone(state.routes),
 $executeRawUnsafe:async(sql,payload,routeId)=>{writes++;if(failWrite)throw Error('SECRET database details');const route=state.routes.find(r=>r.id===routeId);route.payload=JSON.parse(payload);return 1},
 regularShuttleStop:{updateMany:async({where,data})=>{writes++;let count=0;for(const row of state.rows)if(where.id.in.includes(row.id)&&row.serviceMonth===where.serviceMonth&&row.weekday===where.weekday){Object.assign(row,data);count++}return{count}},findMany:async()=>failVerify?[]:state.rows}
 };const result=await fn(tx);commits++;return result;
 }catch(error){state=before;rollbacks++;throw error}}}}
 };
 const api=load('src/app/api/shuttle/regular-order/route.ts',deps);
 const updates=[{rowIds:[id(2)],sortOrder:0,arriveTime:'14:38'},{rowIds:[id(1)],sortOrder:1,arriveTime:'14:45'}];
 return{api,updates,get state(){return state},get stats(){return{commits,rollbacks,writes}},post:body=>api.POST(new Request('http://test/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'valid',date:'2026-10-19',baseline:[{rowIds:[id(1)],sortOrder:0,arriveTime:'14:38'},{rowIds:[id(2)],sortOrder:1,arriveTime:'14:45'}],updates,...body})}))};
}

test('확정 배차 순서·시각 저장 후 실제 기사 조립기로 재조회, 차량·학생·경유 보존',async()=>{
 const f=setup();const response=await f.post();assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,verified:true,updated:2});
 const route=f.state.routes[0];assert.equal(route.payload.custom,'preserve');assert.equal(route.payload.vehicles[0].custom,'vehicle');assert.equal(route.payload.vehicles[0].stops[0].label,'차고지');assert.equal(route.payload.vehicles[0].stops[2].students[0].custom,'student');
 const reloaded=logic.assembleRegularDriverClasses({dayRows:[...f.state.rows].sort((a,b)=>a.sortOrder-b.sortOrder),saved:{PICKUP:route.payload,DROPOFF:null},rowIdsByStudentId:{PICKUP:new Map(f.state.rows.map(r=>[r.studentId,[r.id]])),DROPOFF:new Map()},isAbsent:()=>false});
 assert.deepEqual(Array.from(reloaded[0].board,s=>s.rows[0].rowId),[id(2),id(1)]);assert.deepEqual(Array.from(reloaded[0].board,s=>s.arriveTime),['14:38','14:45']);assert.equal(reloaded[0].board[1].lat,11);
 assert.equal(route.payload.vehicles[0].stops[1].etaManual,878);assert.equal(f.stats.commits,1);
});
test('확정 노선 없는 명단 폴백도 저장 후 같은 순서·시각',async()=>{const f=setup({fallback:true});assert.equal((await f.post()).status,200);const result=logic.buildFallbackClasses([...f.state.rows].sort((a,b)=>a.sortOrder-b.sortOrder),()=>false);assert.equal(result[0].board[0].rows[0].rowId,id(2));assert.equal(result[0].board[0].arriveTime,'14:38')});
for(const [name,change] of [
 ['잘못된 토큰',{token:'invalid'}],['빈 요청',{updates:[]}],['다른 월',{date:'2026-11-02'}],['모르는 행',{updates:[{rowIds:[id(88)],sortOrder:0,arriveTime:'14:30'}]}],['누락 행',{updates:[{rowIds:[id(1)],sortOrder:0,arriveTime:'14:30'}]}],['중복 행',{updates:[{rowIds:[id(1),id(1)],sortOrder:0,arriveTime:'14:30'}]}],['다른 정차 합침',{updates:[{rowIds:[id(1),id(2)],sortOrder:0,arriveTime:'14:30'}]}],['잘못된 시간',{updates:[{rowIds:[id(1)],sortOrder:0,arriveTime:'25:30'},{rowIds:[id(2)],sortOrder:1,arriveTime:'14:40'}]}]
])test(`${name}는 쓰기 없이 거절`,async()=>{const f=setup();const before=JSON.stringify(f.state);assert.ok((await f.post(change)).status>=400);assert.equal(JSON.stringify(f.state),before);assert.equal(f.stats.writes,0)});
for(const flag of ['failWrite','failVerify'])test(`${flag}이면 부분저장 rollback 및 내부정보 비노출`,async()=>{const f=setup({[flag]:true});const before=JSON.stringify(f.state);const response=await f.post();assert.ok(response.status>=400);assert.equal(JSON.stringify(f.state),before);assert.equal(f.stats.rollbacks,1);assert.equal((await response.text()).includes('SECRET'),false)});
test('시각 지우기는 모든 ETA 필드를 비워 이전 시각으로 돌아가지 않음',async()=>{const f=setup();await f.post({updates:f.updates.map(u=>({...u,arriveTime:null}))});const stop=f.state.routes[0].payload.vehicles[0].stops[1];assert.equal(logic.savedStopTimeLabel(stop),null);assert.equal(stop.etaMinutes,null)});


test('시간을 바꾸지 않고 순서만 뒤집으면 재조회 순서 불일치를 저장 전에 거절',async()=>{const f=setup();const before=JSON.stringify(f.state);const response=await f.post({updates:[{rowIds:[id(2)],sortOrder:0,arriveTime:'14:45'},{rowIds:[id(1)],sortOrder:1,arriveTime:'14:38'}]});assert.equal(response.status,409);assert.equal(JSON.stringify(f.state),before);assert.equal(f.stats.writes,0)});
test('다른 요일 행을 섞으면 전체 저장 거절',async()=>{const f=setup();f.state.rows[1].weekday=2;assert.equal((await f.post()).status,409);assert.equal(f.stats.writes,0)});
test('동일 정차의 여러 학생 중 일부만 저장하면 거절',async()=>{const f=setup();const stops=f.state.routes[0].payload.vehicles[0].stops;stops[1].students.push(stops[2].students[0]);stops.pop();const before=JSON.stringify(f.state);assert.equal((await f.post()).status,409);assert.equal(JSON.stringify(f.state),before);assert.equal(f.stats.writes,0)});
test('여러 차량·회차를 넘나드는 화면 순서여도 학생 소속 차량과 메타데이터 유지',async()=>{const f=setup();const vehicles=f.state.routes[0].payload.vehicles;vehicles.push({vehicleName:'합성차량2',tripLabel:'2회',custom:'second',stops:[vehicles[0].stops.pop()]});assert.equal((await f.post()).status,200);assert.equal(vehicles[0].vehicleName,'합성차량');const actual=f.state.routes[0].payload.vehicles;assert.equal(actual[0].stops[1].students[0].requestId,'student1');assert.equal(actual[1].stops[0].students[0].requestId,'student2');assert.equal(actual[1].custom,'second');assert.equal(actual[1].tripLabel,'2회')});
test('하원 확정 노선도 해당 방향 ETA와 명단 저장',async()=>{const f=setup();f.state.rows.forEach(row=>row.direction='ALIGHT');f.state.routes[0].direction='DROPOFF';const response=await f.post();assert.equal(response.status,200);assert.equal(f.state.routes[0].payload.vehicles[0].stops[1].etaLabel,'14:38 하차')});
test('확정 payload에 미연결 학생이 같은 정차에 남으면 추측하지 않고 거절',async()=>{const f=setup();f.state.routes[0].payload.vehicles[0].stops[1].students.push({requestId:'missing-student'});assert.equal((await f.post()).status,409);assert.equal(f.stats.writes,0)});



test('원본 baseline 없는 이전 화면은 새로고침 안내 후 쓰기 없이 거절',async()=>{const f=setup();assert.equal((await f.post({baseline:null})).status,409);assert.equal(f.stats.writes,0)});
test('첫 저장이 끝난 뒤 도착한 오래된 두 번째 탭은 baseline 비교로 거절',async()=>{const f=setup();assert.equal((await f.post()).status,200);const after=JSON.stringify(f.state);const writes=f.stats.writes;const response=await f.post();assert.equal(response.status,409);assert.equal(JSON.stringify(f.state),after);assert.equal(f.stats.writes,writes)});


test('확정 노선 테이블 없는 이전 환경도 명단 저장과 재조회 검증 유지',async()=>{const f=setup({fallback:true,missingTable:true});const response=await f.post();assert.equal(response.status,200);assert.equal((await response.json()).verified,true);assert.equal(f.state.rows[1].sortOrder,0)});

test('같은 정차 두 학생은 하나의 정차로 묶어 두 행을 함께 저장',async()=>{const f=setup();const stops=f.state.routes[0].payload.vehicles[0].stops;stops[1].students.push(stops[2].students[0]);stops.pop();const response=await f.post({baseline:[{rowIds:[id(1),id(2)],sortOrder:0,arriveTime:'14:38'}],updates:[{rowIds:[id(1),id(2)],sortOrder:0,arriveTime:'14:40'}]});assert.equal(response.status,200);assert.equal((await response.json()).updated,2);assert.equal(f.state.routes[0].payload.vehicles[0].stops[1].etaLabel,'14:40 승차');assert.ok(f.state.rows.every(row=>row.arriveTime==='14:40'))});
test('오래된 baseline이 시각만 다르더라도 저장 전 거절',async()=>{const f=setup();f.state.routes[0].payload.vehicles[0].stops[1].etaLabel='14:39 승차';const before=JSON.stringify(f.state);assert.equal((await f.post()).status,409);assert.equal(f.stats.writes,0);assert.equal(JSON.stringify(f.state),before)});
