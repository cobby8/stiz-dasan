import test from "node:test";
import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import vm from "node:vm";
import ts from "typescript";
const requireNative=createRequire(import.meta.url);
async function load(file,dependencies,globals={}){
  const code=ts.transpileModule(await readFile(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};vm.compileFunction(code,["require","exports","fetch","process","console"],{filename:file})(key=>{if(!Object.hasOwn(dependencies,key))throw Error(`차단한 의존성 ${key}`);return dependencies[key];},exports,globals.fetch??(()=>{throw Error("네트워크 금지");}),{env:globals.env??{}},globals.console??{error(){}});return exports;
}
const kst=await load("src/lib/datetime/kst.ts",{});
const model=await load("src/lib/billing/workbench.ts",{"@/lib/datetime/kst":kst});
const schedule=await load("src/lib/classSchedule.ts",{});
const body="BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR";
const parsed={first:{type:"VEVENT",summary:"11월 개강",start:new Date("2026-11-01T00:00:00Z"),datetype:"date"}};
test("청구용 strict 일정 조회 실패는 빈 배열·민감 원문 로그로 숨기지 않음",async()=>{
 const logs=[];const google=await load("src/lib/googleCalendar.ts",{"node-ical":{default:{sync:{parseICS:()=>parsed}}}},{fetch:async()=>{throw Error("synthetic private source unavailable");},console:{error:(...values)=>logs.push(values)}});
 await assert.rejects(()=>google.fetchGoogleCalendarEvents("https://calendar.invalid/public.ics",{strict:true,fresh:true}),e=>e.message.includes("공식 일정")&&!e.message.includes("private"));assert.equal(logs.length,0);
 const old=await google.fetchGoogleCalendarEvents("https://calendar.invalid/public.ics");assert.deepEqual(old,[]);assert.equal(logs.length,1);
});
test("최신 청구 조회는 Google API 실패 시 ICS로 복구하며 두 요청 모두 no-store",async()=>{
 const calls=[],logs=[];const google=await load("src/lib/googleCalendar.ts",{"node-ical":{default:{sync:{parseICS:()=>parsed}}}},{env:{GOOGLE_CALENDAR_API_KEY:"fixture-only"},console:{error:(...v)=>logs.push(v)},fetch:async(url,options)=>{calls.push({url,options});return calls.length===1?{ok:false,status:503,text:async()=>"unavailable"}:{ok:true,text:async()=>body};}});
 const events=await google.fetchGoogleCalendarEvents("https://calendar.google.com/calendar/ical/fixture/public/basic.ics",{strict:true,fresh:true});
 assert.equal(events.length,1);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.options.cache==="no-store"));assert.equal(logs.length,0);
});
test("strict 일정 조회는 비정상 ICS와 API 누락 페이지를 성공으로 처리하지 않음",async()=>{
 const google=await load("src/lib/googleCalendar.ts",{"node-ical":{default:{sync:{parseICS:()=>parsed}}}},{env:{GOOGLE_CALENDAR_API_KEY:"fixture-only"},fetch:async(url)=>String(url).includes("googleapis")?{ok:true,json:async()=>({items:[],nextPageToken:"remaining-page"})}:{ok:true,text:async()=>"<html>unavailable</html>"}});
 await assert.rejects(()=>google.fetchGoogleCalendarEvents("https://calendar.google.com/calendar/ical/fixture/public/basic.ics",{strict:true,fresh:true}),/공식 일정/);
});
test("반복 휴강을 전개하지 못한 ICS는 strict 청구에서 차단하고 기존 조회 동작은 유지",async()=>{
 const logs=[],recurring={...parsed,holiday:{type:"VEVENT",summary:"학원 휴무",start:new Date("2026-11-07T00:00:00Z"),datetype:"date",rrule:{fixture:true}}};
 const google=await load("src/lib/googleCalendar.ts",{"node-ical":{default:{sync:{parseICS:()=>recurring}}}},{fetch:async()=>({ok:true,text:async()=>body}),console:{error:(...v)=>logs.push(v)}});
 await assert.rejects(()=>google.fetchGoogleCalendarEvents("https://calendar.invalid/public.ics",{strict:true,fresh:true}),/공식 일정/);assert.equal(logs.length,0);
 const old=await google.fetchGoogleCalendarEvents("https://calendar.invalid/public.ics");assert.equal(old.length,1);assert.equal(old[0].title,"11월 개강");
});
test("기존 정책 함수와 공식 DB·ICS 로더를 공유하고 원본 설정 URL은 반환하지 않음",async()=>{
 const options=[];const calendar=await load("src/lib/enrollment/monthlyClassDates.ts",{"@/lib/queries":{getAcademySettings:async()=>{throw Error("캐시 조회 금지");},getAnnualEvents:async()=>{throw Error("캐시 조회 금지");}},"@/lib/googleCalendar":{fetchGoogleCalendarEvents:async(_,o)=>{options.push(o);return[{title:"11월 개강",date:new Date("2026-11-01")},{title:"11월 종강",date:new Date("2026-11-28")}];}},"@/lib/classSchedule":schedule});
 const source=await calendar.loadAnnualPlanEventsWithSource({strict:true,fresh:true},{settings:{googleCalendarIcsUrl:"https://calendar.invalid/public.ics"},dbEvents:[]});
 assert.equal(source.kind,"DB_AND_ICS");assert.deepEqual(calendar.getMonthlyClassDates(source.events,"2026-11","Sat"),["2026-11-07","2026-11-14","2026-11-21","2026-11-28"]);assert.deepEqual(options,[{strict:true,fresh:true}]);assert.equal(JSON.stringify(source).includes("calendar.invalid"),false);
});
test("경계 로더는 필요한 설정을 직접 읽고 snapshot을 정렬·중복제거·해시함",async()=>{
 const reads=[],requests=[];const mod=await load("src/lib/billing/workbench-calendar.ts",{"node:crypto":requireNative("node:crypto"),"@/lib/billing/workbench":model,"./workbench":model,"@/lib/prisma":{prisma:{$queryRawUnsafe:async(sql)=>{reads.push(sql);return sql.includes('"AcademySettings"')?[{googleCalendarIcsUrl:"https://calendar.invalid/public.ics"}]:[];}}},"@/lib/enrollment/monthlyClassDates":{loadAnnualPlanEventsWithSource:async(options,stored)=>{requests.push({options,stored});return{kind:"DB_AND_ICS",events:[{title:"11월 종강",date:"2026-11-28"},{title:"11월 개강",date:"2026-11-01"},{title:"11월 개강",date:"2026-11-01"}]};}}});
 const snapshot=await mod.loadWorkbenchCalendar(true);assert.equal(reads.length,2);assert.equal(snapshot.events.length,2);assert.equal(snapshot.fingerprint.length,64);assert.deepEqual(requests[0].options,{strict:true,fresh:true});assert.equal(JSON.stringify(snapshot).includes("calendar.invalid"),false);
 const same=mod.createWorkbenchCalendarSnapshot({kind:snapshot.kind,events:[...snapshot.events].reverse()});assert.equal(same.fingerprint,snapshot.fingerprint);
});
test("공식 경계에서 설정 조회 실패는 기본값으로 덮지 않고 일반 재시도 안내",async()=>{
 const mod=await load("src/lib/billing/workbench-calendar.ts",{"node:crypto":requireNative("node:crypto"),"./workbench":model,"@/lib/prisma":{prisma:{$queryRawUnsafe:async()=>{throw Error("private fixture error");}}},"@/lib/enrollment/monthlyClassDates":{loadAnnualPlanEventsWithSource:async()=>{throw Error("호출 금지");}}});
 await assert.rejects(()=>mod.loadWorkbenchCalendar(true),e=>e.status===503&&!e.message.includes("private"));
});
