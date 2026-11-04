import test from 'node:test';
import assert from 'node:assert/strict';
import {recalculatePlan,recommendInsertion,reorderPlanStop,computePlanImpacts,planLocationKey} from '../src/lib/shuttle/routePlanning.ts';
import {confirmedEtaLabel,parseClockMinute} from '../src/lib/shuttle/confirmedEta.ts';
import {savedStopTimeLabel} from '../src/lib/shuttle/regularDriverRouteLogic.ts';
import {validateRegularDispatchVehicles} from '../src/lib/regular/regularDispatchPayload.ts';
const point=(id,n)=>({id,label:id,lat:37.6+n*.01,lng:127.1});
function fixture(direction='PICKUP'){
 const stops=[1,2].map(n=>({...point(`s${n}`,n),students:[{studentId:`p${n}`,name:`합성${n}`}],etaMin:990+n*5,dwellMin:1}));
 const start=point('start',0),end=point('end',3),points=[start,...stops,end];
 return {id:'run',dayOfWeek:'Mon',direction,vehicleId:'v',vehicleName:'시험차',driverUserId:'d',capacity:5,start,end,anchorMin:direction==='PICKUP'?1020:1080,classStartMin:1020,classEndMin:1075,stops,legs:points.slice(1).map((p,i)=>({fromId:points[i].id,toId:p.id,minutes:5,verified:true,provider:'SYNTHETIC'}))};
}
test('구간별 도로시간으로 등원 역산·하원 정산하며 입력을 보존한다',()=>{
 const run=fixture(),raw=JSON.stringify(run),result=recalculatePlan([run]);
 assert.equal(result.canConfirm,true);assert.deepEqual(result.runs[0].stops.map(s=>s.etaMin),[1008,1014]);assert.equal(result.runs[0].departMin,1003);assert.equal(JSON.stringify(run),raw);
 const down=recalculatePlan([fixture('DROPOFF')]);assert.deepEqual(down.runs[0].stops.map(s=>s.etaMin),[1085,1091]);assert.equal(down.runs[0].arriveMin,1097);
});
test('추정 구간·정원·정리시간·다음 운행 충돌은 확정을 막는다',()=>{
 for(const mutate of [r=>r.legs=[],r=>r.capacity=1,r=>r.anchorMin=1077,r=>r.nextRunDepartMin=1087]){
  const run=fixture('DROPOFF');mutate(run);assert.equal(recalculatePlan([run]).canConfirm,false);
 }
});
test('고정 시각은 보존하고 도착 불가능한 고정 시각을 검출한다',()=>{
 const run=fixture();run.stops[0].manualMin=1000;assert.equal(recalculatePlan([run]).runs[0].stops[0].etaMin,1000);
 run.stops[0].manualMin=1019;assert.ok(recalculatePlan([run]).issues.some(i=>i.code==='MANUAL_CONFLICT'));
 run.stops[0].manualMin=1000.5;assert.equal(recalculatePlan([run]).canConfirm,false);
});
test('드래그는 운행 내에서만 가능하고 잠긴 구간을 건너지 않는다',()=>{
 const run=fixture();assert.deepEqual(reorderPlanStop(run,'s1',1).stops.map(s=>s.id),['s2','s1']);
 run.stops[0].locked=true;assert.throws(()=>reorderPlanStop(run,'s2',0));assert.throws(()=>reorderPlanStop(run,'s2',-1));
});
test('추천은 총시간 비례 대신 검증된 추가 도로시간을 최소화한다',()=>{
 const run=fixture(),incoming={...point('new',1.5),students:[{studentId:'new',name:'신규',isNew:true}],etaMin:null};
 for(const [a,b,m] of [['start','new',20],['new','s1',20],['s1','new',2],['new','s2',4],['s2','new',10],['new','end',10]])run.legs.push({fromId:a,toId:b,minutes:m,verified:true,provider:'SYNTHETIC'});
 const result=recommendInsertion(run,incoming);assert.equal(result.index,1);assert.equal(result.addedMinutes,1);assert.equal(result.estimated,false);
 assert.equal(recommendInsertion({...run,legs:[]},incoming).estimated,true);
});
test('동일 위치는 정류장 키와 기존 학생을 보존하며 합친다',()=>{
 const run=fixture(),incoming={...run.stops[0],id:'new',students:[{studentId:'new',name:'신규',isNew:true}]};
 const result=recommendInsertion(run,incoming);assert.equal(result.run.stops.length,2);assert.equal(result.run.stops[0].id,'s1');assert.equal(result.run.stops[0].students.length,2);
});
test('마지막 전달 성공 대비 누적 3+3분과 앞당김 5분을 안내한다',()=>{
 const old=fixture(),next=structuredClone(old);next.stops[0].etaMin+=3;
 const snapshot={studentId:'p1',delivered:true,entries:[{studentId:'p1',dayOfWeek:'Mon',direction:'PICKUP',timeMin:old.stops[0].etaMin,locationKey:planLocationKey(old.stops[0]),locationLabel:'s1'}]};
 assert.equal(computePlanImpacts([old],[next],[snapshot])[0].notify,false);
 const later=structuredClone(next);later.stops[0].etaMin+=3;assert.equal(computePlanImpacts([next],[later],[snapshot])[0].notify,true);
 later.stops[0].etaMin=snapshot.entries[0].timeMin-5;assert.equal(computePlanImpacts([old],[later],[snapshot])[0].notify,true);
});
test('기존 학생 기준 누락을 첫 안내로 오인하지 않으며 신규만 첫 안내한다',()=>{
 const old=fixture(),next=structuredClone(old);assert.equal(computePlanImpacts([old],[next],[])[0].notify,false);
 next.stops[0].etaMin+=6;const result=computePlanImpacts([old],[next],[])[0];assert.equal(result.notify,false);assert.equal(result.baselineRequired,true);
 const newcomer=fixture();newcomer.stops[0].students[0].isNew=true;assert.ok(computePlanImpacts([], [newcomer],[])[0].reasons.includes('FIRST_NOTICE'));
 const untrusted={studentId:'p1',delivered:false,entries:[]};assert.equal(computePlanImpacts([old],[next],[untrusted])[0].baselineRequired,true);
 assert.equal(computePlanImpacts([old],[next],[{...untrusted,delivered:true}])[0].baselineRequired,true);
});
test('원장 확인 기준은 전달 성공으로 바꾸지 않고 변경 대상만 산출한다',()=>{
 const old=fixture(),next=structuredClone(old);next.stops[0].etaMin+=5;
 const snapshot={studentId:'p1',delivered:false,source:'ADMIN_CONFIRMED',confirmed:true,entries:[{studentId:'p1',dayOfWeek:'Mon',direction:'PICKUP',timeMin:old.stops[0].etaMin,locationKey:planLocationKey(old.stops[0]),locationLabel:'s1'}]};
 assert.equal(computePlanImpacts([old],[next],[snapshot])[0].notify,true);assert.equal(snapshot.delivered,false);
 next.stops[0].etaMin=old.stops[0].etaMin;next.stops[0].lng+=.01;assert.ok(computePlanImpacts([old],[next],[snapshot])[0].reasons.includes('LOCATION_CHANGED'));
 next.dayOfWeek='Wed';assert.ok(computePlanImpacts([old],[next],[snapshot])[0].reasons.includes('SERVICE_CHANGED'));
});
test('동일 학생의 운행 중복과 잠긴 시각 누락을 차단한다',()=>{
 const run=fixture();assert.equal(recalculatePlan([run,{...run,id:'other'}]).canConfirm,false);
 run.stops[0].locked=true;run.stops[0].etaMin=null;assert.ok(recalculatePlan([run]).issues.some(i=>i.code==='LOCKED_TIME_REQUIRED'));
});
test('확정 시각은 수동→자동→구형문구 동일 우선순위, 잘못된 시각은 거부한다',()=>{
 const stop={etaManual:1000,etaMinutes:990,etaLabel:'15:00 승차'};assert.equal(confirmedEtaLabel(stop),'16:40');assert.equal(savedStopTimeLabel(stop),'16:40');
 for(const value of [-1,1440,1000.5,NaN])assert.equal(confirmedEtaLabel({...stop,etaManual:value}),null);
 assert.equal(parseClockMinute('99:99'),null);assert.equal(confirmedEtaLabel({etaLabel:'8:53 승차'}),'08:53');
 for(const value of [1000.5,1440,-1])assert.throws(()=>validateRegularDispatchVehicles([{stops:[{label:'합성',etaManual:value,students:[]}]}]));
 assert.throws(()=>validateRegularDispatchVehicles([{classStart:'99:99',stops:[]}]));
});
