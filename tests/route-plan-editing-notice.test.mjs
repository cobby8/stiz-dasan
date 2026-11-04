import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";

const file = "src/components/shuttle/planning/RoutePlanEditingNotice.tsx";
const code = ts.transpileModule(readFileSync(file,"utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;

async function render({month="2026-11",exists=true,date=null,fail=false,authorized=true}={}) {
  const requests=[], exported={}; let authCount=0;
  class FixedDate extends Date { constructor(value) { super(value ?? "2026-11-03T15:30:00Z"); } }
  vm.runInNewContext(code,{exports:exported,Date:FixedDate,Intl,Error,require(name){
    if(name==="server-only") return {};
    if(name==="react/jsx-runtime") return jsx;
    if(name==="@/lib/auth-guard") return {requireAdmin:async()=>{authCount++;if(!authorized)throw new Error("로그인 필요");}};
    if(name==="@/lib/regular/serviceMonth")return {isServiceMonth:value=>/^\d{4}-(0[1-9]|1[0-2])$/.test(value)};
    if(name==="@/lib/prisma")return {prisma:{$queryRawUnsafe:async(sql,...params)=>{requests.push({sql,params});if(fail)throw new Error("internal secret failure");return sql.includes("to_regclass")?[{present:exists?"RegularRoutePlanVersion":null}]:[{effectiveFrom:date}];}}};
    throw new Error(`Unexpected import ${name}`);
  }});
  const node=await exported.default({serviceMonth:month});return {html:node?renderToStaticMarkup(node):"",requests,authCount};
}

test("표가 없는 기존 환경은 존재 여부만 조회하고 안내를 추가하지 않는다",async()=>{
  const result=await render({exists:false});assert.equal(result.authCount,1);assert.equal(result.requests.length,1);assert.match(result.requests[0].sql,/to_regclass/);assert.equal(result.html,"");
});

test("선택 월의 가장 늦은 확정 적용일이 미래면 날짜별 편집 차이를 짧게 안내한다",async()=>{
  const result=await render({date:"2026-11-10"});assert.equal(result.requests.length,2);assert.deepEqual(result.requests[1].params,["2026-11"]);assert.match(result.requests[1].sql,/max\("effectiveFrom"\)/);assert.match(result.html,/2026.11.10/);assert.match(result.html,/현재 운행 조정은 기사님 날짜별 화면/);assert.doesNotMatch(result.requests.map(r=>r.sql).join(" "),/INSERT|UPDATE|DELETE|ALTER|CREATE/);
});

test("KST 오늘·과거·확정 없음은 미래 적용일 안내를 표시하지 않는다",async()=>{
  for(const date of ["2026-11-04","2026-11-03",null])assert.equal((await render({date})).html,"");
});

test("조회 장애는 내부 오류를 숨기고 적용일 확인 필요만 표시한다",async()=>{
  const result=await render({fail:true});assert.match(result.html,/적용일 확인이 필요합니다/);assert.doesNotMatch(result.html,/internal|secret/);
});

test("잘못된 월은 조회하지 않으며 관리자 권한이 없으면 조회 전에 차단한다",async()=>{
  assert.equal((await render({month:"invalid"})).requests.length,0);await assert.rejects(render({authorized:false}),/로그인 필요/);
});
