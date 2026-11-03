import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

function setup() {
 const values=[],requests=[],confirmations=[];let cursor=0,confirm=true,fail=false;
 const exported={};
 const dependencies={"react/jsx-runtime":jsx,"@/components/admin/adminDisplayText":{adminErrorText:(error,fallback)=>error instanceof Error?error.message:fallback},react:{useState:initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],value=>{values[i]=value;}];}}};
 const code=ts.transpileModule(readFileSync("src/app/admin/shuttle/regular/RegularShuttleNoticePanel.tsx","utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText;
 vm.runInNewContext(code,{exports:exported,require:name=>{assert.ok(name in dependencies);return dependencies[name];},window:{confirm:body=>{confirmations.push(body);return confirm;}},fetch:async(url,options)=>{assert.equal(url,"/api/admin/shuttle/regular-notice");const body=JSON.parse(options.body);requests.push(body);return {ok:!fail,json:async()=>fail?{error:"노선이 변경됐습니다."}:{ok:true,status:body.action==="PREPARE"?"HELD":body.action==="APPROVE"?"APPROVED":"SENT",payloadHash:"current-hash",studentName:"합성학생",recipientLast4:"0001",messageBody:"월 등원 16:40 합성 정류장"}};},Error});
 const render=()=>{cursor=0;return exported.default({studentId:"student-1",serviceMonth:"2026-11",compareMonth:"2026-10"});};
 function buttons(node,out=[]) {if(Array.isArray(node)){node.forEach(n=>buttons(n,out));return out;}if(node&&typeof node==="object"){if(node.type==="button")out.push(node);buttons(node.props?.children,out);}return out;}
 const click=async label=>{const button=buttons(render()).find(b=>b.props.children===label);assert.ok(button,`버튼 없음: ${label}`);button.props.onClick();await new Promise(resolve=>setImmediate(resolve));};
 return {render,click,requests,confirmations,setConfirm:v=>{confirm=v;},setFail:v=>{fail=v;}};
}
test("학생 상세를 열기만 해서는 안내 준비·승인·발송을 실행하지 않는다",()=>{const f=setup();const html=renderToStaticMarkup(f.render());assert.match(html,/확정 차량 일정 안내 준비/);assert.equal(f.requests.length,0);assert.doesNotMatch(html,/보호자에게 문자 발송/);});
test("서버가 만든 수신자·문안 확인 후 승인과 실제 발송은 별도 클릭이다",async()=>{const f=setup();await f.click("확정 차량 일정 안내 준비");let html=renderToStaticMarkup(f.render());assert.match(html,/보호자 끝자리 0001/);assert.match(html,/16:40/);assert.doesNotMatch(html,/보호자에게 문자 발송/);assert.deepEqual(f.requests.map(r=>r.action),["PREPARE"]);await f.click("수신자·문구 확인 후 승인");assert.deepEqual(f.requests.map(r=>r.action),["PREPARE","APPROVE"]);f.setConfirm(false);await f.click("보호자에게 문자 발송");assert.equal(f.requests.length,2);f.setConfirm(true);await f.click("보호자에게 문자 발송");assert.deepEqual(f.requests.map(r=>r.action),["PREPARE","APPROVE","SEND"]);assert.equal(f.requests[2].payloadHash,"current-hash");assert.equal(f.requests[2].change.key,"student:student-1");assert.match(f.confirmations[1],/0001/);assert.match(f.confirmations[1],/16:40/);html=renderToStaticMarkup(f.render());assert.match(html,/발송 접수됐습니다/);assert.doesNotMatch(html,/안내 완료/);});
test("노선 변경으로 승인이 실패하면 이전 발송 버튼을 제거한다",async()=>{const f=setup();await f.click("확정 차량 일정 안내 준비");f.setFail(true);await f.click("수신자·문구 확인 후 승인");const html=renderToStaticMarkup(f.render());assert.match(html,/노선이 변경됐습니다/);assert.doesNotMatch(html,/보호자에게 문자 발송/);assert.equal(f.requests.length,2);});
test("안내 진입은 안정 학생·선택 월을 보존하고 명단 없는 학생도 명시 선택한다",()=>{const page=readFileSync("src/app/admin/shuttle/regular/page.tsx","utf8"),client=readFileSync("src/app/admin/shuttle/regular/RegularShuttleClient.tsx","utf8");assert.match(page,/requested\.month && isServiceMonth/);assert.match(page,/initialStudentId=\{requested\.studentId/);assert.match(client,/row\.studentId === initialStudentId/);assert.match(client,/신청 학생 선택해 명단 추가/);assert.match(client,/<RegularShuttleNoticePanel/);});
