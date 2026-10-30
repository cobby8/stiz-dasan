import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {publicErrorText} from '../src/components/ui/public-error-text.ts'; // 공개 오류 안내 도우미(진짜 모듈)
const source=readFileSync('src/components/seasonal/RouteSection.tsx','utf8');
const cut=source.indexOf('  const activeMapIdx =');
const instrument=source.slice(0,cut)+'  globalThis.__api = { switchTo, generate, saveRoute, setDriver, scheduleReroute, runReroute, rerouteVehicle, markDirty, sug, dirty, savedAt, loadedFromSaved, routeReady, saveBlocked, err, saveMsg }; return null; }';
const suggestion=(date='Mon')=>({direction:'PICKUP',date,dow:'월',classStart:'15:00',classEnd:'16:00',academy:{lat:37,lng:127,name:'시험학원'},depot:null,hub:null,vehicles:[{vehicleName:'합성차량',capacity:12,passengers:1,stops:[{lat:37,lng:127,label:'합성정류장',students:[{requestId:'fake-student',name:'합성학생'}]}],path:[{lat:37,lng:127}]}],availableDates:[],totalRiders:1,loadedFromSaved:true,savedAt:'2026-10-20T00:00:00.000Z'});
const response=(body,ok=true)=>({ok,json:async()=>body});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function mount(fetch,initial=suggestion()){
 let slots=[],i=0;const timers=[];let props={initial,date:initial.date,refreshKey:0,regularEditing:true,apiBase:'/api/admin/regular/dispatch',serviceMonth:'2026-10'};
 const react={useState(v){const n=i++;if(!(n in slots))slots[n]=v;return [slots[n],v=>slots[n]=typeof v==='function'?v(slots[n]):v];},useRef(v){const n=i++;return slots[n]??=( {current:v});},useEffect(){i++;}};
 const exports={};const context={exports,require(name){if(name==='react')return react;if(name.includes('regularRouteEdit'))return {overCapacityVehicles:()=>[]};if(name.includes('shuttleStopEta'))return {reapplyManualEtaVehicles:x=>x};if(name.includes('public-error-text'))return {publicErrorText};return {};},fetch,window:{confirm:()=>true,setTimeout(fn){timers.push(fn);return timers.length;},clearTimeout(){},addEventListener(){},removeEventListener(){}},console,setTimeout,Intl};
 vm.runInNewContext(ts.transpileModule(instrument,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,context);
 const render=(patch={})=>{props={...props,...patch};i=0;exports.default(props);return context.__api;};
 return {render,get api(){return context.__api;},timers};
}
let checks=0;const check=(condition,label)=>{assert.ok(condition,label);checks++;};
// A prior weekday response must never overwrite the selected weekday.
{
 const mon=deferred(),tue=deferred();const ui=mount(url=>url.includes('date=Mon')?mon.promise:tue.promise);ui.render();const old=ui.api.switchTo('Mon');ui.render({date:'Tue'});const fresh=ui.api.switchTo('Tue');tue.resolve(response({saved:{...suggestion('Tue'),added:[],locationChanged:[]}}));await fresh;ui.render();mon.resolve(response({saved:{...suggestion(),added:[],locationChanged:[]}}));await old;check(ui.render().sug.date==='Tue','late Monday response blocked');
}
// A failed read is not an absent saved route and must not trigger auto generation.
{
 let post=0;const ui=mount((url,opts)=>{if(opts?.method==='POST')post++;return Promise.resolve(response({error:'fake failure'},false));});ui.render();await ui.api.switchTo('Mon');const api=ui.render();check(post===0,'failed read must not generate');check(api.routeReady===false&&api.saveBlocked,'failed read blocks saving');check(api.sug.vehicles.length===1,'failed read keeps route');
}
// HTTP 200 with a negative/malformed acknowledgement is not success.
for(const ack of [{ok:false,savedAt:null},{ok:true,savedAt:null},{ok:true,savedAt:'invalid'}]){
 const ui=mount(async()=>response(ack));ui.render();await ui.api.saveRoute();const api=ui.render();check(api.dirty&&api.routeReady===false&&!api.saveMsg,'invalid save acknowledgement blocked');
}
// A valid acknowledgement still requires an exact subsequent read.
{
 const saved=suggestion();let count=0;const ui=mount(async()=>response(++count===1?{ok:true,savedAt:saved.savedAt}:{saved}));ui.render();await ui.api.saveRoute();const api=ui.render();check(count===2&&!api.dirty&&api.saveMsg==='저장했습니다','save and read agreement');
}
{
 const saved=suggestion();saved.vehicles=[];let count=0;const ui=mount(async()=>response(++count===1?{ok:true,savedAt:saved.savedAt}:{saved}));ui.render();await ui.api.saveRoute();const api=ui.render();check(api.dirty&&api.saveMsg===null&&api.routeReady===false,'read mismatch blocks success');
}
// Edits made during a save survive the successful acknowledgement.
{
 const wait=deferred(),saved=suggestion();let count=0;const ui=mount(async()=>++count===1?wait.promise:response({saved}));ui.render();const saving=ui.api.saveRoute();ui.api.setDriver(0,'fake-driver');ui.render();wait.resolve(response({ok:true,savedAt:saved.savedAt}));await saving;const api=ui.render();check(api.dirty&&api.sug.vehicles[0].driverUserId==='fake-driver','new edit remains unsaved');
}
// Reroute response and queued timer are scoped to the original route and edit revision.
{
 const wait=deferred();let calls=0;const ui=mount(()=>{calls++;return wait.promise;});ui.render();const reroute=ui.api.rerouteVehicle(0);ui.api.setDriver(0,'fake-driver');ui.render();wait.resolve(response({path:[{lat:99,lng:99}]}));await reroute;check(ui.render().sug.vehicles[0].path[0].lat===37,'late reroute cannot replace newer edit');ui.api.scheduleReroute(0);check(ui.render().saveBlocked,'pending recalculation blocks saving');ui.render({date:'Tue'});ui.timers.at(-1)();check(calls===1,'previous scope timer cannot run on new weekday');
}
// A fresh auto suggestion in the same scope must preserve the existing saved version.
{
 const original=suggestion();const ui=mount(async()=>response(suggestion()));ui.render();await ui.api.generate('Mon');let api=ui.render();check(api.savedAt===original.savedAt&&!api.loadedFromSaved&&api.dirty,'auto suggestion keeps save baseline');
}
{
 const ui=mount(async(url,opts)=>response(opts?.method==='POST'?suggestion():{saved:null}));ui.render();await ui.api.switchTo('Mon');check(ui.render().savedAt===null,'confirmed absent saved route clears baseline');
}
{
 const ui=mount(async()=>response(suggestion()));ui.render();ui.render({serviceMonth:'2026-11'});check(ui.api.saveBlocked,'month changes block old route before effect');
}
// Saved-route APIs distinguish signed-out, forbidden and storage failure responses.
for (const kind of ['regular','seasonal']) {
 for (const [message, expected] of [['인증이 필요합니다. 로그인해주세요.',401],['관리자 권한이 필요합니다.',403],['synthetic database failure',500],[null,200]]) {
  const exports={};let reads=0;
  const read=async()=>{reads++;if(message==='synthetic database failure')throw new Error(message);return null;};
  const context={exports,URL,Error,console:{error(){}},require(name){
   if(name==='next/server')return {NextResponse:{json:(body,options)=>({body,status:options?.status??200})}};
   if(name==='@/lib/auth-guard')return {requireAdmin:async()=>{if(message&&message!=='synthetic database failure')throw new Error(message);}};
   if(name.includes('regularDispatchRoute'))return {getSavedRegularDispatchRoute:read};
   if(name.endsWith('/dispatchRoute'))return {getSavedDispatchRoute:read};
   if(name.endsWith('/serviceMonth'))return {isServiceMonth:()=>true};
   return {};
  }};
  vm.runInNewContext(ts.transpileModule(readFileSync(`src/app/api/admin/${kind}/dispatch/saved/route.ts`,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
  const result=await exports.GET({url:`http://127.0.0.1/api/saved?date=${kind==='regular'?'Mon':'2026-12-07'}&direction=PICKUP`});
  check(result.status===expected,`${kind} saved read status ${expected}`);
  if(expected===401||expected===403)check(reads===0,'unauthorized saved read blocked');
  if(expected===500)check(!JSON.stringify(result.body).includes('synthetic database'),'storage details are hidden');
 }
}
// When a month has different available weekdays, the rendered date is valid immediately.
{
 const clientSource=readFileSync('src/app/admin/shuttle/regular-dispatch/RegularDispatchClient.tsx','utf8');
 const ast=ts.createSourceFile('RegularDispatchClient.tsx',clientSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
 let initializer;
 function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='day')initializer=node.initializer.getText(ast);ts.forEachChild(node,visit);}visit(ast);
 const choose=vm.runInNewContext(`((selectedDay,weekdays,initialDay)=>(${initializer}))`);
 check(choose('Mon',['Tue'],'Tue')==='Tue','month switch immediately corrects missing weekday');
 check(choose('Mon',['Tue','Wed'],'Fri')==='Tue','unknown initial weekday falls back to first available');
 check(choose('Wed',['Tue','Wed'],'Tue')==='Wed','available selected weekday is preserved');
}
console.log(JSON.stringify({checks,passed:true,scope:'compiled actual RouteSection functions with synthetic hooks and fetch only; no operating access'}));
