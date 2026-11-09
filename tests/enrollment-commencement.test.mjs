import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import vm from "node:vm";
import { buildEnrollmentOperationsEvent } from "../src/lib/operations-events/admin-hooks.ts";
const source = await readFile("src/app/actions/admin.ts", "utf8");
const publicSource = await readFile("src/app/actions/public.ts", "utf8");
const url = text => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(text,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString("base64")}`;
const kst = url(await readFile("src/lib/datetime/kst.ts","utf8"));
const commencement = await import(url((await readFile("src/lib/enrollment/commencement.ts","utf8")).replace('from "@/lib/datetime/kst"', `from "${kst}"`)));
const ast = ts.createSourceFile("admin.ts",source,ts.ScriptTarget.Latest,true);
const fn = ast.statements.find(node => ts.isFunctionDeclaration(node)&&node.name?.text==="approveEnrollApplication");
const javascript = ts.transpileModule(fn.getText(ast).replace("export async function", "async function"),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function approvalHarness({requestedStartOn="2026-12-01",existingStatus=null}={}) {
 const writes=[],events=[];
 const app={id:"application-a",status:"PENDING",childName:"합성",childBirthDate:"2018-01-01",parentName:"합성부모",parentPhone:"01000000000",requestedStartOn,shuttleNeeded:false};
 const tx={async $queryRawUnsafe(sql,...args){
  if(sql.includes('FROM "Class" c JOIN "Program"')) return [{id:"class-a"}];
  if(sql.includes('FROM "EnrollmentApplication"'))return [app];
  if(sql.includes('SELECT id FROM "Student"'))return [{id:"student-a"}];
  if(sql.includes('SELECT name AS "className"'))return [{className:"합성반"}];
  if(sql.includes('SELECT "classId" FROM "Enrollment"')) return existingStatus==="ACTIVE"?[{classId:"class-a"}]:[];
  if(sql.includes('SELECT id, status FROM "Enrollment"'))return existingStatus?[{id:"existing-a",status:existingStatus}]:[];
  if(sql.includes('INSERT INTO "Enrollment"')) {writes.push({sql,args}); return [{id:"enrollment-a",updatedAt:new Date("2026-11-03T04:00:00Z")}];}
  throw Error(`unexpected query: ${sql}`);
 },async $executeRawUnsafe(sql,...args){writes.push({sql,args});return 1;}};
 const ctx=vm.createContext({console,Date,Set,Number,String,Boolean,Error,Array,Object,requireAdmin:async()=>({appUserId:"admin-a"}),normalizeApprovalClassIds:ids=>ids,
  prisma:{...tx,$transaction:async fn=>fn(tx)},...commencement,ApprovalAbort:class extends Error{},ParentSelectionRequired:class extends Error{},parentPhoneDigits:()=>"01000000000",resolveApprovalParent:async()=>"parent-a",verifyEnrollmentParentAuth:()=>{},notMergedStudent:()=>"true",SHUTTLE_LOCATION_CONSENT_VERSION:"test",buildEnrollmentOperationsEvent,enqueueWebsiteOperationsEventInTransaction:async(_tx,event)=>events.push(event),revalidatePath(){},revalidateApplyAdminCaches(){},revalidateStudentAdminCaches(){}});
 const approve=vm.runInContext(`${javascript};approveEnrollApplication`,ctx);
 return {writes,events,app,approve:(data={})=>approve("application-a",{classIds:["class-a"],force:true,...data})};
}
test("실제 승인 액션은 미래 개시일을 반 수강·신청서·운영 원장에 같은 날짜로 기록",async()=>{
 const h=approvalHarness();assert.equal((await h.approve()).approved,true);
 assert.equal(h.writes.find(w=>w.sql.includes('INSERT INTO "Enrollment"')).args[2],"2026-12-01");
 assert.ok(h.writes.some(w=>w.sql.includes('"requestedStartOn"')&&w.args.includes("2026-12-01")));
 assert.equal(h.events[0].effectiveDate,"2026-12-01");assert.equal(h.events[0].after.effectiveDate,"2026-12-01");
});
test("과거 월 정보만 있는 신청은 승인일·1일로 추정하지 않고 모든 쓰기 전에 중단",async()=>{
 const h=approvalHarness({requestedStartOn:null});await assert.rejects(h.approve(),/수강 개시일/);assert.equal(h.writes.length,0);assert.equal(h.events.length,0);
});
test("관리자가 확인한 시작일이 있으면 요청 날짜와 실제 반 수강을 함께 갱신",async()=>{
 const h=approvalHarness();await h.approve({startOn:"2026-11-16"});assert.equal(h.writes.find(w=>w.sql.includes('INSERT INTO "Enrollment"')).args[2],"2026-11-16");assert.equal(h.events[0].effectiveDate,"2026-11-16");
});
test("날짜는 시차 없는 달력 값이며 윤년·잘못된 입력·기간 범위를 검증",()=>{
 assert.equal(commencement.requireCommencement("2028-02-29"),"2028-02-29");
 for(const value of [null,"", "2026-02-29","2026-13-01","2026-11-01T00:00:00Z","1999-12-31","2101-01-01"]){assert.throws(()=>commencement.requireCommencement(value));}
});
test("개시일 미래 ACTIVE=수강 중, 개시일 당일부터 출결 포함, 기존 이력 null과 휴원 상태를 보존",()=>{
 // 2026-11-09 원장 기준: 개시일이 미래여도 ACTIVE 는 수강 중(예정으로 빼지 않는다)
 assert.equal(commencement.enrollmentDisplayStatus("ACTIVE","2026-12-01","2026-11-30"),"ACTIVE");
 assert.equal(commencement.isCurrentEnrollment("ACTIVE"),true);
 assert.equal(commencement.enrollmentStartsLater("2026-12-01","2026-11-30"),true);
 assert.equal(commencement.enrollmentStartsLater("2026-11-30","2026-11-30"),false);
 assert.equal(commencement.enrollmentDisplayStatus("PAUSED","2026-12-01","2026-11-30"),"PAUSED");
 assert.equal(commencement.enrollmentHasStarted("2026-12-01","2026-11-30"),false);
 assert.equal(commencement.enrollmentHasStarted("2026-12-01","2026-12-01"),true);
 assert.equal(commencement.enrollmentHasStarted(null,"2026-11-03"),true);
 assert.equal(commencement.enrollmentHasStarted("invalid","2026-11-03"),false);
});
test("신규·재제출 날짜 저장 경로와 체험 폼 분리, 읽기/런타임 신규 DDL 없음",()=>{
 const ensure=publicSource.slice(publicSource.indexOf('export async function ensureEnrollmentApplicationTable'),publicSource.indexOf('// 체험수업 신청 입력'));
 assert.equal(ensure.includes('requestedStartOn'),false);
 const trial=publicSource.slice(publicSource.indexOf('export async function submitTrialApplication'),publicSource.indexOf('interface EnrollApplicationInput'));
 assert.equal(trial.includes('"requestedStartOn"'),false);
 assert.match(publicSource,/"requestedStartOn" = \$46::date/);
 assert.match(publicSource,/requestedStartOn, \/\/ \$45/);
 assert.match(publicSource,/"enrollmentMonths" = COALESCE\("enrollmentMonths", \$12\)/);
});

test("이미 수강 중인 동일 반은 첫 쓰기 전에 충돌을 차단해 신청·실제 개시일 불일치를 막음",async()=>{
 const h=approvalHarness({existingStatus:"ACTIVE"});await assert.rejects(h.approve({startOn:"2026-12-15"}),/이미 수강 중인 반/);assert.equal(h.writes.length,0);assert.equal(h.events.length,0);
});

test("DB DATE의 UTC 자정만 날짜로 읽고 잘못된 Date·일반 시각은 거부",()=>{
 assert.equal(commencement.commencementYmd(new Date("2026-12-01T00:00:00.000Z")),"2026-12-01");
 assert.equal(commencement.commencementYmd(new Date("invalid")),null);
 assert.equal(commencement.commencementYmd(new Date("2026-11-30T23:00:00.000Z")),null);
});
