import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as React from "react";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const FILE = "src/components/shuttle/planning/RoutePlanningClient.tsx";
const plan = (status = "DRAFT") => ({ id:"plan-1", applicationId:"app-1", reviewId:"review-1",studentId:"new",serviceMonth:"2026-11",effectiveFrom:"2026-11-09",revision:1,baseFingerprint:"base",status,canConfirm:true,previewHash:"preview-1",issues:[],notices:[{studentId:"old",studentName:"합성 기존",recipientLabel:"보호자 ***1234",message:"월 등원 16:20에서 16:26으로 변경됩니다.",reasons:["TIME_5_MIN"]}],impacts:[{studentId:"old",studentName:"합성 기존",legs:[{dayOfWeek:"Mon",direction:"PICKUP",beforeMin:980,afterMin:986,deltaMin:6,beforeLocation:"합성 정문",afterLocation:"합성 정문"}],notify:true,reasons:["TIME_5_MIN"]}],runs:[{id:"run-1",dayOfWeek:"Mon",direction:"PICKUP",vehicleId:"vehicle-1",vehicleName:"합성 1호차",driverUserId:"driver-1",capacity:12,start:{id:"start",label:"출발",lat:37,lng:127},end:{id:"end",label:"학원",lat:37,lng:127},anchorMin:1020,classStartMin:1020,classEndMin:1075,departMin:970,arriveMin:1010,legs:[],stops:[{id:"old-stop",label:"기존 정류장",lat:37,lng:127,etaMin:980,students:[{studentId:"old",name:"합성 기존"}]},{id:"new-stop",label:"추천 정류장",lat:37,lng:127,etaMin:990,recommended:true,students:[{studentId:"new",name:"합성 신규",isNew:true}]}]}]});
const item = () => ({applicationId:"app-1",studentId:"new",studentName:"합성 신규",grade:"초3",classes:[{dayOfWeek:"Mon",startTime:"17:00",endTime:"17:55"}],review:{id:"review-1"}});
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(mode, items = [item()]) {
 const scopes = new Map(), requests = [], effects = []; let current = null, cursor = 0, pointerTarget = null, getData = { items: [plan(mode === "admin" ? "SUBMITTED" : "DRAFT")], reviews: items, vehicles: [{id:"vehicle-1",name:"합성 1호차"}] }, failure = null, postHandler = null, getHandler = null;
 const state = () => { assert.ok(current); return scopes.get(current); };
 const react = {
  useState(initial) { const s = state(), i = cursor++; if (!(i in s.values)) s.values[i] = typeof initial === "function" ? initial() : initial; return [s.values[i], value => { s.values[i] = typeof value === "function" ? value(s.values[i]) : value; }]; },
  useRef(initial) { const s = state(), i = cursor++; if (!(i in s.values)) s.values[i] = { current: initial }; return s.values[i]; },
  useCallback(fn) { cursor++; return fn; },
  useEffect(fn, deps) { const s = state(), i = cursor++; const old = s.effects[i]; if (!old || deps.some((value, at) => value !== old.deps[at])) { old?.cleanup?.(); const record = { deps, cleanup: null }; s.effects[i] = record; effects.push(() => { record.cleanup = fn(); }); } },
 };
 const exported = {};
 const code = ts.transpileModule(readFileSync(FILE, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
 vm.runInNewContext(code, { exports: exported, require(name) { if (name === "react") return react; if (name === "react/jsx-runtime") return jsx; if (name.endsWith(".module.css")) return { default: new Proxy({}, {get: (_t,key) => String(key)}) }; if (name.includes("AdminModal")) return { default: props => jsx.jsx("div", {children:props.children}) }; throw new Error(`Unexpected import: ${name}`); }, AbortController, Error, document: {elementFromPoint: () => pointerTarget}, fetch: async (url, options = {}) => {
  requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
  if (options.method === "POST" && postHandler) return postHandler(url, options);
  if (!options.method && getHandler) return getHandler(url, options);
  if (failure && (failure.method === (options.method ?? "GET"))) return { ok: false, json: async () => ({ error: failure.message }) };
  return { ok: true, json: async () => options.method === "POST" ? { ok: true, draft: {...structuredClone(getData.items[0]),revision:2} } : url.includes("?id=") ? {draft:structuredClone(getData.items[0])} : structuredClone(getData) };
 } });
 function expand(node) {
  if (Array.isArray(node)) return node.map((child, index) => { const expanded = expand(child); return React.isValidElement(expanded) ? React.cloneElement(expanded, { key: expanded.key ?? index }) : expanded; });
  if (!React.isValidElement(node)) return node;
  if (typeof node.type === "function") {
   const previous = current, previousCursor = cursor;
   current = `${node.type.name}:${node.key ?? "root"}`; cursor = 0;
   if (!scopes.has(current)) scopes.set(current, { values: [], effects: [] });
   const result = node.type(node.props); current = previous; cursor = previousCursor; return expand(result);
  }
  return React.cloneElement(node, node.props, expand(node.props.children));
 }
 const render = () => expand(jsx.jsx(exported.default, { mode, initialMonth: "2026-11", initialDate:"2026-11-09" }));
 function all(node, predicate, found = []) { if (Array.isArray(node)) node.forEach(n => all(n, predicate, found)); else if (React.isValidElement(node)) { if (predicate(node)) found.push(node); all(node.props.children, predicate, found); } return found; }
 const text = node => Array.isArray(node) ? node.map(text).join("") : React.isValidElement(node) ? node.props["aria-hidden"] ? "" : text(node.props.children) : node == null || typeof node === "boolean" ? "" : String(node);
 async function settle() { for (let i = 0; i < 3; i++) { render(); effects.splice(0).forEach(run => run()); await tick(); } }
 function control(label, index = 0) { const labels = all(render(), n => n.type === "label" && text(n).startsWith(label)); assert.ok(labels[index], `라벨 없음 ${label}`); return all(labels[index], n => ["input", "select", "textarea"].includes(n.type))[0]; }
 async function change(label, value, index = 0) { control(label, index).props.onChange({ target: { value } }); await settle(); }
 async function click(label, index = 0) { const button = all(render(), n => n.type === "button" && text(n) === label)[index]; assert.ok(button, `버튼 없음 ${label}`); assert.ok(!button.props.disabled, `비활성 버튼 ${label}`); button.props.onClick(); await settle(); }
 return { render, settle, requests, control, change, click, all, text, setPointerTarget: (runId,stopId) => {pointerTarget={closest:()=>({dataset:{planRun:runId,planStop:stopId}})};}, html: () => renderToStaticMarkup(render()), setFailure: value => { failure = value; }, setData: value => { getData = value; }, data: () => structuredClone(getData), setPost: value => { postHandler = value; }, setGet: value => { getHandler = value; } };
}

test("로그인 담당 요청을 조회만 하고 추천 생성은 날짜·요청으로 명시 실행한다", async () => {
 const f=harness("driver"); await f.settle(); assert.equal(f.requests.length,1); assert.equal(f.requests[0].url,"/api/staff/shuttle/route-plans?month=2026-11");
 await f.change("적용 시작일","2026-12-01"); assert.ok(f.all(f.render(),n=>n.type==="button"&&f.text(n)==="추천 넣기")[0].props.disabled);
 await f.change("적용 시작일","2026-11-09"); await f.click("추천 넣기"); assert.deepEqual(f.requests.find(r=>r.body).body,{action:"CREATE",reviewId:"review-1",effectiveFrom:"2026-11-09"});
 assert.match(f.html(),/추천 · 미확정/); assert.doesNotMatch(f.html(),/탑승 체크|학부모 안내 미리보기|원장님 확정·안내/);
});

test("기사 순서 이동은 수정번호와 정류장 순서만 보내고 실패하면 조정 내용을 보존한다", async () => {
 const f=harness("driver"); await f.settle(); await f.click("신규 학생2026-11-09부터 · 조정 중 · 미확정");
 f.setFailure({method:"POST",message:"연결 실패"});
 const down=f.all(f.render(),n=>n.type==="button"&&n.props["aria-label"]==="기존 정류장 아래로")[0]; down.props.onClick(); await f.settle();
 assert.deepEqual(f.requests.find(r=>r.body).body,{action:"UPDATE",id:"plan-1",revision:1,orders:[{runId:"run-1",stopIds:["new-stop","old-stop"],manualTimes:{}}]});
 const stops=f.all(f.render(),n=>n.props["data-plan-stop"]); assert.equal(stops[0].props["data-plan-stop"],"new-stop"); assert.match(f.html(),/연결 실패/); assert.ok(f.all(f.render(),n=>n.type==="button"&&f.text(n)==="원장님께 배차안 제출")[0].props.disabled); assert.ok(f.control("운행 월").props.disabled);
});

test("통과한 정류장을 지나서 이동하지 못하고 수정 중 이중 전송을 차단한다", async () => {
 const f=harness("driver"); const d=f.data(); d.items[0].runs[0].stops[0].locked=true; f.setData(d); await f.settle(); await f.click("신규 학생2026-11-09부터 · 조정 중 · 미확정");
 assert.ok(f.all(f.render(),n=>n.type==="button"&&n.props["aria-label"]==="추천 정류장 위로")[0].props.disabled); assert.equal(f.requests.filter(r=>r.body).length,0);
});

test("기사는 확인필요 초안도 원장님에게 제출하며 확정·문자를 직접 요청하지 않는다", async () => {
 const f=harness("driver"); const d=f.data();d.items[0].issues=[{code:"BASELINE_REQUIRED",message:"기존 안내 확인 필요"}];d.items[0].canConfirm=false;f.setData(d);await f.settle();await f.click("신규 학생2026-11-09부터 · 조정 중 · 미확정");await f.click("원장님께 배차안 제출");
 assert.deepEqual(f.requests.find(r=>r.body).body,{action:"SUBMIT",id:"plan-1",revision:1});assert.doesNotMatch(f.html(),/이 배차안 확정·안내 접수/);
});

test("원장님은 최신안을 재조회하고 적용일·안내대상을 검토한 뒤에만 확정 요청한다",async()=>{
 const f=harness("admin");await f.settle();await f.click("신규 학생2026-11-09부터 · 원장님 확인 대기");assert.match(f.html(),/16:20 → 16:26/);assert.match(f.html(),/보호자 \*\*\*1234/);
 await f.click("원장님 확정·안내");assert.equal(f.requests.filter(r=>r.body).length,0);assert.match(f.requests.at(-1).url,/\?id=plan-1/);assert.match(f.html(),/배차 확정·안내 최종 확인/);await f.click("이 배차안 확정·안내 접수");assert.deepEqual(f.requests.find(r=>r.body).body,{action:"CONFIRM",id:"plan-1",revision:1,previewHash:"preview-1"});assert.match(f.html(),/발송 결과를 확인/);
});

test("기존 안내 근거가 없으면 자동 첫 문자로 바꾸지 않고 명시 기준 확인을 받는다",async()=>{
 const f=harness("admin");const d=f.data();d.items[0].impacts[0].baselineRequired=true;d.items[0].impacts[0].notify=false;d.items[0].issues=[{code:"BASELINE_REQUIRED",message:"기준 확인"}];d.items[0].canConfirm=false;d.items[0].notices=[];f.setData(d);await f.settle();await f.click("신규 학생2026-11-09부터 · 원장님 확인 대기");assert.match(f.html(),/기존 안내 시각 확인 필요/);assert.match(f.html(),/학부모 안내 미리보기 · 0명/);const button=f.all(f.render(),n=>n.type==="button"&&f.text(n)==="안내 기준 확인 반영")[0];assert.ok(button.props.disabled);
 const checkbox=f.all(f.render(),n=>n.type==="input"&&n.props.type==="checkbox")[0];checkbox.props.onChange({target:{checked:true}});await f.settle();await f.click("안내 기준 확인 반영");assert.deepEqual(f.requests.find(r=>r.body).body,{action:"BASELINE",id:"plan-1",revision:1,acknowledgeStudentIds:["old"]});
});

test("실제 드래그 이벤트도 같은 수정번호로 재계산하며 충돌 시 조정안을 유지한다",async()=>{
 const f=harness("driver");await f.settle();await f.click("신규 학생2026-11-09부터 · 조정 중 · 미확정");
 f.setPost(async()=>({ok:false,status:409,json:async()=>({error:"기존 노선이 변경됐습니다."})}));
 const handle=f.all(f.render(),n=>n.type==="button"&&n.props["aria-label"]==="추천 정류장 순서 끌기")[0]; const pointer={button:0,pointerId:7,clientX:10,clientY:20,preventDefault(){},currentTarget:{setPointerCapture(){},releasePointerCapture(){}}};
 handle.props.onPointerDown(pointer);f.setPointerTarget("run-1","old-stop");handle.props.onPointerMove(pointer);await f.settle();assert.match(f.html(),/data-drop-target="true"/);handle.props.onPointerUp(pointer);await f.settle();assert.doesNotMatch(f.html(),/data-dragging="true"/);
 assert.equal(f.requests.filter(r=>r.body).length,1);assert.deepEqual(f.requests.at(-1).body.orders[0].stopIds,["new-stop","old-stop"]);assert.match(f.html(),/기존 노선이 변경/);assert.match(f.html(),/현재 순서로 다시 계산/);
});

test("시간 조정은 분 단위 수동 시각만 보내고 저장 실패 후에도 입력을 유지한다",async()=>{
 const f=harness("driver");await f.settle();await f.click("신규 학생2026-11-09부터 · 조정 중 · 미확정");f.setFailure({method:"POST",message:"시각 저장 실패"});
 f.all(f.render(),n=>n.type==="input"&&n.props["aria-label"]==="추천 정류장 조정 시각")[0].props.onChange({target:{value:"16:45"}});await f.settle();assert.deepEqual(f.requests.at(-1).body.orders[0].manualTimes,{"new-stop":1005});assert.equal(f.all(f.render(),n=>n.type==="input"&&n.props["aria-label"]==="추천 정류장 조정 시각")[0].props.value,"16:45");
});

test("원장님 검토 직전 상태가 달라지면 최종 확정 버튼을 막는다",async()=>{
 const f=harness("admin");await f.settle();await f.click("신규 학생2026-11-09부터 · 원장님 확인 대기");const d=f.data();d.items[0].status="STALE";d.items[0].canConfirm=false;f.setData(d);await f.click("원장님 확정·안내");assert.ok(f.all(f.render(),n=>n.type==="button"&&f.text(n)==="이 배차안 확정·안내 접수")[0].props.disabled);assert.equal(f.requests.filter(r=>r.body).length,0);
});

test("달을 바꾼 뒤 늦게 온 이전 월 조회를 현재 목록에 섞지 않는다",async()=>{
 const f=harness("driver");let finish;f.setGet(url=>url.includes("2026-11")?new Promise(resolve=>{finish=resolve;}):Promise.resolve({ok:true,json:async()=>({items:[],reviews:[],vehicles:[]})}));await f.settle();await f.change("운행 월","2026-12");finish({ok:true,json:async()=>f.data()});await f.settle();assert.match(f.html(),/이 달에 검토할 담당 요청이 없습니다/);assert.doesNotMatch(f.html(),/합성 신규/);
});

test("공용 링크는 계획 진입이 기본 비활성이며 원장님 페이지는 관리자 인증을 요구한다",()=>{
 assert.match(readFileSync("src/app/admin/shuttle/plan-drafts/page.tsx","utf8"),/await requireAdmin\(\)/);
 assert.match(readFileSync("src/components/shuttle/UnifiedDriverRunPage.tsx","utf8"),/planningEnabled = false/);
 assert.match(readFileSync("src/app/staff/run/page.tsx","utf8"),/searchDate=\{searchDate\} planningEnabled/);
 for(const file of ["src/app/driver/[token]/page.tsx","src/app/shuttle/run/[token]/page.tsx","src/app/shuttle/regular/[token]/page.tsx"]){assert.doesNotMatch(readFileSync(file,"utf8"),/planningEnabled/);}
});

test("신규 첫 안내는 기준 누락·장소 변경 오류처럼 표시하지 않는다",async()=>{
 const f=harness("driver"),d=f.data();d.items[0].impacts=[{studentId:"new",studentName:"합성 신규",notify:true,reasons:["FIRST_NOTICE"],legs:[{dayOfWeek:"Mon",direction:"PICKUP",beforeMin:null,afterMin:990,deltaMin:null,beforeLocation:null,afterLocation:"합성 정문"}]}];f.setData(d);await f.settle();await f.click("합성 신규2026-11-09부터 · 조정 중 · 미확정");assert.match(f.html(),/첫 안내 → 16:30/);assert.match(f.html(),/신규 이용/);assert.doesNotMatch(f.html(),/기준 미확인|장소 변경/);
});

test("원장님은 제출된 배차안을 기사 수정 단계로 돌려보내며 확정이나 발송을 요청하지 않는다",async()=>{
 const f=harness("admin");await f.settle();await f.click("신규 학생2026-11-09부터 · 원장님 확인 대기");
 f.setPost(async()=>({ok:true,json:async()=>({ok:true,draft:{...plan("DRAFT"),revision:2,canConfirm:false}})}));
 await f.click("기사님께 수정 요청");assert.deepEqual(f.requests.find(r=>r.body).body,{action:"RETURN_TO_DRIVER",id:"plan-1",revision:1});assert.match(f.html(),/기사님이 다시 조정할 수 있도록 돌려보냈습니다/);assert.match(f.html(),/조정 중 · 미확정/);assert.doesNotMatch(f.html(),/기사님께 수정 요청/);assert.equal(f.requests.filter(r=>r.body?.action==="CONFIRM").length,0);
 const driver=harness("driver");await driver.settle();await driver.click("신규 학생2026-11-09부터 · 조정 중 · 미확정");assert.doesNotMatch(driver.html(),/기사님께 수정 요청/);
});

test("기존 차량을 기본 표시하고 오래된 배차안은 초기화 동의·새 적용일 뒤 새 초안으로 복구한다",async()=>{
 const f=harness("admin"),d=f.data();d.items[0].status="STALE";d.items[0].canConfirm=false;f.setData(d);await f.settle();await f.click("신규 학생2026-11-09부터 · 기존 노선 변경 · 다시 확인");
 assert.equal(f.control("담당 차량").props.value,"vehicle-1");const action=()=>f.all(f.render(),n=>n.type==="button"&&f.text(n)==="최신 명단으로 다시 만들기")[0];assert.ok(action().props.disabled);
 const check=f.all(f.render(),n=>n.type==="input"&&n.props.type==="checkbox")[0];check.props.onChange({target:{checked:true}});await f.settle();await f.change("새 적용 시작일","2026-12-01");assert.ok(action().props.disabled);await f.change("새 적용 시작일","2026-11-10");
 f.setPost(async()=>({ok:true,json:async()=>({ok:true,draft:{...plan("DRAFT"),id:"plan-new",reviewId:"review-new",effectiveFrom:"2026-11-10",revision:1,canConfirm:false}})}));await f.click("최신 명단으로 다시 만들기");assert.deepEqual(f.requests.find(r=>r.body).body,{action:"REBUILD",id:"plan-1",revision:1,effectiveFrom:"2026-11-10",discardChanges:true});assert.match(f.html(),/최신 명단으로 새 추천 배차안을 만들었습니다/);assert.match(f.html(),/조정 중 · 미확정/);assert.equal(f.requests.filter(r=>r.body?.action==="CONFIRM").length,0);
});

test("문자 자동 발송이 꺼졌으면 최종 확인부터 배차만 확정한다고 표시한다",async()=>{
 const f=harness("admin"),d=f.data();d.items[0].noticeDelivery={enabled:false,items:[]};f.setData(d);await f.settle();await f.click("신규 학생2026-11-09부터 · 원장님 확인 대기");await f.click("원장님 확정·안내");assert.match(f.html(),/배차만 확정하며 문자는 접수하지 않습니다/);
 f.setPost(async()=>({ok:true,json:async()=>({ok:true,dispatch:{status:"BLOCKED"},draft:{...d.items[0],status:"CONFIRMED",revision:2,noticeDelivery:{enabled:false,items:[{studentId:"old",status:"PENDING"}]}}})}));await f.click("이 배차안만 확정");assert.match(f.html(),/문자 자동 발송이 꺼져 있습니다. 배차만 확정했습니다/);assert.match(f.html(),/미발송 대기/);assert.doesNotMatch(f.html(),/안내를 접수합니다|전달 완료<\/span>/);
});

test("확정 응답의 발송 차단을 안내 접수 성공으로 표시하지 않는다",async()=>{
 const f=harness("admin");await f.settle();await f.click("신규 학생2026-11-09부터 · 원장님 확인 대기");await f.click("원장님 확정·안내");f.setPost(async()=>({ok:true,json:async()=>({ok:true,dispatch:{status:"BLOCKED"},draft:{...plan("CONFIRMED"),revision:2,noticeDelivery:{enabled:true,items:[{studentId:"old",status:"UNKNOWN"}]}}})}));await f.click("이 배차안 확정·안내 접수");assert.match(f.html(),/문자 발송이 차단되어 안내는 접수되지 않았습니다/);assert.match(f.html(),/결과 확인 필요/);
});

test("접수·전달 완료를 분리하고 새로 읽기는 조회만 하여 상태를 갱신한다",async()=>{
 const f=harness("admin"),d=f.data();d.items[0]={...plan("CONFIRMED"),noticeDelivery:{enabled:true,items:["PENDING","SENDING","ACCEPTED","DELIVERED","FAILED","UNKNOWN"].map((status,index)=>({studentId:index===0?"old":`synthetic-${index}`,status}))}};f.setData(d);await f.settle();await f.click("신규 학생2026-11-09부터 · 배차 확정");for(const label of ["미발송 대기","전송 중","접수 · 전달 미확인","전달 완료","발송 보류","결과 확인 필요"])assert.match(f.html(),new RegExp(label));
 const updated=f.data();updated.items[0].noticeDelivery.items[0].status="DELIVERED";f.setData(updated);await f.click("발송 결과 새로 읽기");assert.equal(f.requests.filter(r=>r.body).length,0);assert.match(f.requests.at(-1).url,/\?id=plan-1/);assert.equal(f.all(f.render(),n=>n.type==="span"&&f.text(n)==="전달 완료").length,2);
});

test("한국어 오전·오후와 시각 숫자가 잘리지 않도록 폭을 확보하고 좁은 화면의 조정 행 여백을 없앤다",()=>{
 const css=readFileSync("src/components/shuttle/planning/RoutePlanning.module.css","utf8");
 const timeWidth=Number(css.match(/\.timeLabel input\{width:(\d+)px/)?.[1]);assert.ok(timeWidth>=140&&timeWidth<=148);assert.match(css,/\.timeLabel input\{[^}]*min-width:148px/);assert.match(css,/@media\(max-width:440px\)\{[^\n]*\.moves\{padding-left:0;width:100%/);assert.match(css,/\.moves \.button\{padding:6px\}/);assert.match(css,/min-height:44px;min-width:44px/);
});
