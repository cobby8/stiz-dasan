import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const url = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString("base64")}`;
const kstUrl=url(await readFile("src/lib/datetime/kst.ts","utf8"));
const modelSource = await readFile("src/lib/billing/workbench.ts","utf8"), modelUrl=url(modelSource.replace('from "@/lib/datetime/kst"',`from "${kstUrl}"`));
const {roundCarryTotal,workbenchTotal,validateWorkbenchCommand,carryPool,allocateCarry,shortMonthProration}=await import(modelUrl);
const registerUrl=url(await readFile("src/lib/billing/monthly-register.ts","utf8"));
const dueUrl=url(await readFile("src/lib/billing-due-date.ts","utf8"));
const visibilityUrl=url(await readFile("src/lib/studentVisibility.ts","utf8"));
const pricingUrl=url(await readFile("src/lib/billing/workbench-pricing.ts","utf8"));
const serviceSource=await readFile("src/lib/billing/workbench-service.ts","utf8");
const serviceUrl=url(serviceSource.replace('import { getMonthlyClassDates } from "@/lib/enrollment/monthlyClassDates";','const getMonthlyClassDates=(events,month)=>events.some(e=>e.title==="NO_SCHEDULE")?[]:events.some(e=>e.title==="SHORT_MONTH")&&month==="2026-11"?["2026-11-07","2026-11-14","2026-11-21"]:(month==="2026-10"?["2026-10-03","2026-10-10","2026-10-17","2026-10-24"]:["2026-11-07","2026-11-14","2026-11-21","2026-11-28"]).filter(d=>!(d==="2026-10-10"&&events.some(e=>e.title==="CLOSE_OCT_10")));').replace('from "@/lib/billing-due-date"',`from "${dueUrl}"`).replace('from "@/lib/studentVisibility"',`from "${visibilityUrl}"`).replace('from "./monthly-register"',`from "${registerUrl}"`).replace('from "./workbench"',`from "${modelUrl}"`).replace('from "./workbench-pricing"',`from "${pricingUrl}"`));
const {readWorkbench,mutateWorkbench}=await import(serviceUrl);
const absenceSource=await readFile("src/lib/billing/workbench-absence.ts","utf8");
const absenceUrl=url(absenceSource.replace('from "@/lib/studentVisibility"',`from "${visibilityUrl}"`).replace('from "./monthly-register"',`from "${registerUrl}"`).replace('from "./workbench"',`from "${modelUrl}"`).replace('from "./workbench-service"',`from "${serviceUrl}"`).replace('await import("@/lib/enrollment/monthlyClassDates")','({getMonthlyClassDates:()=>["2026-10-03","2026-10-10","2026-10-17","2026-10-24"]})'));
const {resolveWorkbenchAbsence}=await import(absenceUrl);
const zero={baseAmount:0,discountAmount:0,prorationAmount:0,carryAmount:0,shuttleAmount:0};
const draft=()=>({...zero,baseAmount:100000});
test("이월은 건별 반올림하지 않고 합계에서 원 단위 반올림",()=>{
 assert.equal(roundCarryTotal(Array.from({length:3},()=>({numerator:"100000",denominator:"3"}))),100000);
 assert.equal(roundCarryTotal([{numerator:"1",denominator:"2"}]),1);
 assert.equal(roundCarryTotal([{numerator:"1",denominator:"3"}]),0);
});
test("분모·음수·안전범위 오류는 계산 차단",()=>{
 for(const v of [{numerator:"1",denominator:"0"},{numerator:"-1",denominator:"2"},{numerator:"100000001",denominator:"1"}])assert.throws(()=>roundCarryTotal([v]));
});
test("할인·기간·이월은 수강료만 차감하고 셔틀을 더한다",()=>assert.equal(workbenchTotal({baseAmount:100000,discountAmount:10000,prorationAmount:10000,carryAmount:25000,shuttleAmount:20000}),75000));
test("음수·소수·초과차감 금액은 저장 불가",()=>{
 for(const v of [{...draft(),baseAmount:-1},{...draft(),carryAmount:1.1},{...draft(),carryAmount:100001}])assert.throws(()=>workbenchTotal(v));
});
const command=(action,view,overrides={})=>({action,month:view.month,sourceVersion:view.sourceVersion,requestId:`request-${action}-${Math.random().toString(36).slice(2)}`,rows:view.rows.filter(r=>r.classId==="class-a").map(r=>({id:r.id,expectedVersion:r.version,...(action==="SAVE"?{...draft(),reason:"기간 및 금액 확인"}:{})})),...overrides});
test("빈 선택·중복·추가 필드·확정 시 금액 주입 차단",()=>{
 const base={action:"CONFIRM",month:"2026-11",sourceVersion:"a".repeat(64),requestId:"request-test",rows:[{id:"s:c",expectedVersion:0}]};
 assert.throws(()=>validateWorkbenchCommand({...base,rows:[]}));
 assert.throws(()=>validateWorkbenchCommand({...base,rows:[base.rows[0],base.rows[0]]}));
 assert.throws(()=>validateWorkbenchCommand({...base,rows:[{...base.rows[0],baseAmount:1}]}));
 assert.throws(()=>validateWorkbenchCommand({...base,actorId:"admin"}));
});
function database({credit=0,secondClass=false}={}){
 const state={drafts:[],payments:[],invoices:[],operations:[],usages:[],revisions:[],absences:[],makeupCredits:[],bookings:[],registers:[],carryCredits:[],resolutions:[],attendance:[],seasonalCredits:[],events:[],enrollments:[{studentId:"student-a",studentName:"합성 원생",classId:"class-a",className:"합성 반",status:"ACTIVE",price:100000,dayOfWeek:"Sat",createdAt:"2026-01-01",updatedAt:"2026-01-01"}]};
 if(secondClass)state.enrollments.push({...state.enrollments[0],classId:"class-b"});
 const tx={async $queryRawUnsafe(sql,...v){
  if(sql.includes("to_regclass"))return [{found:"present"}];
  if(sql.includes('FROM "Enrollment"'))return structuredClone(state.enrollments);
  if(sql.includes('FROM "PaymentInvoice"'))return structuredClone(state.invoices);
  if(sql.includes('FROM "Payment"'))return sql.includes("type='SHUTTLE'")?state.payments.filter(p=>p.type==="SHUTTLE"):structuredClone(state.payments);
  if(sql.includes('FROM "MonthlyEnrollmentRegister"'))return structuredClone(v.length?state.registers.filter(r=>r.month===v[1]):state.registers);
  if(sql.includes('FROM "AnnualEvent"'))return structuredClone(state.events);
  if(sql.includes('FROM "BillingWorkbenchDraft"'))return structuredClone(state.drafts.filter(d=>sql.includes('"studentId"=$1')? d.studentId===v[0]&&d.classId===v[1]&&d.month===v[2]&&["ISSUED","ZERO"].includes(d.status):sql.includes("WHERE id=")?d.id===v[0]&&d.month===v[1]:sql.includes("month<>")?d.month!==v[0]&&["ISSUED","ZERO"].includes(d.status):d.month===v[0]));
  if(sql.includes('FROM "BillingCarryCredit"'))return [...(credit?[{id:"credit-a",studentId:"student-a",numerator:String(credit),denominator:"1",availableMonth:"2026-11"}]:[]),...state.carryCredits.filter(c=>c.availableMonth<=v[0])];
  if(sql.includes('FROM "BillingCarryUsage"'))return structuredClone(state.usages.map(u=>({...u,paymentStatus:state.payments.find(p=>p.id===u.paymentId)?.status??null,invoiceStatus:state.invoices.find(i=>i.paymentId===u.paymentId)?.status??null})));
  if(sql.includes('FROM "RegularAbsence"'))return sql.includes("SELECT id FROM")?[{id:"absence-a"}]:structuredClone(state.absences.map(a=>({...a,makeupStatus:state.makeupCredits.map(c=>c.status).join(",")||null,resolution:state.resolutions.find(r=>r.id===a.id)?.resolution??null})));
  if(sql.includes('FROM "MakeupSession"'))return structuredClone(state.bookings);
  if(sql.includes('FROM "MakeupCredit"'))return structuredClone(state.makeupCredits);
  if(sql.includes('FROM "Attendance"'))return structuredClone(state.attendance);
  if(sql.includes('FROM "SpecialProgramCredit"'))return structuredClone(state.seasonalCredits);
  if(sql.includes('FROM "Class"'))return [{dayOfWeek:"Sat"}];
  if(sql.includes('FROM "BillingWorkbenchOperation"'))return structuredClone(state.operations.filter(o=>o.requestId===v[0]));
  if(sql.includes('FROM "Student"'))return state.studentHidden?[]:[{id:"student-a"}];
  // 셔틀 명단(그 달 승차·하차 이용자). 기본은 비어 있음 → 셔틀비 제안 없음.
  if(sql.includes('FROM "RegularShuttleStop"'))return structuredClone((state.shuttleStops??[]).filter(r=>r.serviceMonth===v[0]));
  throw new Error(`unexpected read ${sql}`);
 },async $executeRawUnsafe(sql,...v){
  if(sql.includes("pg_advisory"))return 1;
  if(sql.startsWith('INSERT INTO "BillingWorkbenchDraft"')){const d={id:v[0],month:v[1],studentId:v[2],classId:v[3],version:v[4],status:v[5],payload:JSON.parse(v[6]),reason:v[7],sourceVersion:v[8],paymentId:v[9],periodStart:v[11],periodEnd:v[12],scheduledDates:JSON.parse(v[13]),calculationBasis:JSON.parse(v[14])};const i=state.drafts.findIndex(x=>x.id===d.id&&x.month===d.month);if(i<0)state.drafts.push(d);else state.drafts[i]=d;return 1;}
  if(sql.startsWith('INSERT INTO "BillingWorkbenchOperation"')){state.operations.push({requestId:v[0],fingerprint:v[1],result:JSON.parse(v[2])});return 1;}
  if(sql.startsWith('INSERT INTO "BillingWorkbenchRevision"')){state.revisions.push(v);return 1;}
  if(sql.startsWith('INSERT INTO "BillingCarryUsage"')){state.usages.push({studentId:v[1],month:v[2],amount:v[4],paymentId:v[5],sourceCreditIds:v[7],basis:JSON.parse(v[8])});return 1;}
  if(sql.startsWith('INSERT INTO "BillingCarryCredit"')){state.carryCredits.push({id:v[0],studentId:v[1],absenceId:v[2],numerator:v[3],denominator:v[4],availableMonth:v[5],basis:JSON.parse(v[6])});return 1;}
  if(sql.startsWith('INSERT INTO "BillingAbsenceResolution"')){state.resolutions.push({id:v[0],resolution:v[2]});return 1;}
  // 질병·부상 이월 검토(2026-11-14): 정산과 같은 거래에서 검토 상태를 맞춘다(질병·부상 결석만)
  if(sql.startsWith('INSERT INTO "RegularAbsenceCarryReview"')){assert.match(sql,/a\.reason='ILLNESS_INJURY'/);const a=state.absences.find(x=>x.id===v[0]&&x.reason==="ILLNESS_INJURY");if(!a)return 0;state.reviews=(state.reviews??[]).filter(r=>r.absenceId!==v[0]);state.reviews.push({absenceId:v[0],status:v[1],decidedByUserId:v[2],convertReason:v[3]});return 1;}
  // 신청함 [이월 승인]: 신고 상태 결석을 확정으로(같은 거래)
  if(sql.startsWith('UPDATE "RegularAbsence" SET status = \'CONFIRMED\'')){const a=state.absences.find(x=>x.id===v[0]&&x.status==="REPORTED");if(a)a.status="CONFIRMED";return a?1:0;}
  if(sql.startsWith('UPDATE "MakeupSession"')){for(const b of state.bookings)if(b.status==="BOOKED")b.status="CANCELLED";return 1;}
  if(sql.startsWith('UPDATE "MakeupCredit"')){for(const c of state.makeupCredits)if(["AVAILABLE","RESERVED","EXPIRED"].includes(c.status)){c.status="REVOKED";c.makeupSessionId=null;}return 1;}
  if(sql.startsWith('INSERT INTO "Payment"')){state.payments.push({id:v[0],studentId:v[1],classId:v[2],amount:v[3],status:"PENDING",type:"MONTHLY",updatedAt:"now"});return 1;}
  if(sql.startsWith('INSERT INTO "PaymentInvoice"')){state.invoices.push({id:v[0],paymentId:v[1],amount:v[4],status:"ISSUED",updatedAt:"now"});return 1;}
  throw new Error(`unexpected write ${sql}`);
 }};
 return {state,tx,async $transaction(work){const before=structuredClone(state);try{return await work(tx);}catch(e){Object.assign(state,before);throw e;}}};
}
test("기본 꺼짐 상태에서는 DB 호출 전에 쓰기를 차단",async()=>{await assert.rejects(()=>mutateWorkbench({$transaction(){throw new Error("called");}},{} ,"admin"),/잠겨/);});
test("관리자 검토 저장 → 확정 → 사이트 발행이 연결되고 전달은 실행하지 않음",async()=>{
 const db=database();let view=await readWorkbench(db.tx,"2026-11",true);
 assert.equal(view.rows[0].status,"REVIEW");
 assert.equal(view.rows[0].dueDate,"2026-10-31");
 ({view}=await mutateWorkbench(db,command("SAVE",view),"admin",true));assert.equal(view.rows[0].status,"READY");assert.equal(view.rows[0].draftStatus,"DRAFT");
 ({view}=await mutateWorkbench(db,command("CONFIRM",view),"admin",true));assert.equal(view.rows[0].draftStatus,"CONFIRMED");
 const c=command("ISSUE",view),result=await mutateWorkbench(db,c,"admin",true);
 assert.equal(result.view.rows[0].draftStatus,"ISSUED");assert.equal(db.state.payments.length,1);assert.equal(db.state.invoices.length,1);assert.equal(db.state.revisions.length,3);
 await mutateWorkbench(db,c,"admin",true);assert.equal(db.state.payments.length,1);
 await assert.rejects(()=>mutateWorkbench(db,{...c,sourceVersion:"a".repeat(64)},"admin",true),/다른 내용/);
});
test("0원은 Payment·Invoice 없이 완료 기록",async()=>{
 const db=database();let view=await readWorkbench(db.tx,"2026-11",true);
 const save=command("SAVE",view);save.rows[0].discountAmount=100000;
 ({view}=await mutateWorkbench(db,save,"admin",true));({view}=await mutateWorkbench(db,command("CONFIRM",view),"admin",true));
 const result=await mutateWorkbench(db,command("ISSUE",view),"admin",true);
 assert.equal(result.operationResult.zeroCount,1);assert.equal(result.view.rows[0].draftStatus,"ZERO");assert.equal(db.state.payments.length,0);assert.equal(db.state.usages.length,0);
});
test("원본이 변경되면 금액 저장·발행 차단",async()=>{
 const db=database();const view=await readWorkbench(db.tx,"2026-11",true);db.state.enrollments[0].price=120000;
 await assert.rejects(()=>mutateWorkbench(db,command("SAVE",view),"admin",true),/자료가 변경/);
 assert.equal(db.state.drafts.length,0);
});
test("서로 다른 창의 낡은 버전은 저장 불가",async()=>{
 const db=database();const view=await readWorkbench(db.tx,"2026-11",true);
 await mutateWorkbench(db,command("SAVE",view),"admin",true);
 await assert.rejects(()=>mutateWorkbench(db,command("SAVE",view),"admin",true),/다른 작업/);
});
test("미확정 발행·기발행 청구 수정 차단",async()=>{
 const db=database();let view=await readWorkbench(db.tx,"2026-11",true);
 await assert.rejects(()=>mutateWorkbench(db,command("ISSUE",view),"admin",true),/저장·확정/);
 db.state.payments.push({id:"paid",studentId:"student-a",classId:"class-a",amount:100000,status:"PAID",type:"MONTHLY"});view=await readWorkbench(db.tx,"2026-11",true);
 await assert.rejects(()=>mutateWorkbench(db,command("SAVE",view),"admin",true),/이미 발행/);
});
test("이월 잔액 초과·한 학생 두 반의 셔틀 중복 차단",async()=>{
 const db=database({secondClass:true});let view=await readWorkbench(db.tx,"2026-11",true),save=command("SAVE",view);save.rows[0].carryAmount=1;
 await assert.rejects(()=>mutateWorkbench(db,save,"admin",true),/잔액/);
 save=command("SAVE",view,{rows:view.rows.map(r=>({id:r.id,expectedVersion:0,...draft(),shuttleAmount:20000,reason:"확인"}))});
 await assert.rejects(()=>mutateWorkbench(db,save,"admin",true),/셔틀비/);
 assert.equal(db.state.drafts.length,0);
});
test("서버 보안 계약: 기본 꺼짐·권한·동일출처·크기제한·서버 거래",async()=>{
 const route=await readFile("src/app/api/admin/billing-workbench/route.ts","utf8"),schema=await readFile("src/lib/billing/workbench-schema.sql","utf8");
 assert.match(route,/requireAdmin\(\)/);assert.match(route,/STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true"/);assert.match(route,/sec-fetch-site/);assert.match(route,/length>limit/);
 assert.equal((schema.match(/ENABLE ROW LEVEL SECURITY/g)||[]).length,6);assert.match(schema,/FROM PUBLIC/);assert.match(schema,/'anon','authenticated'/);
 assert.doesNotMatch(serviceSource,/ensurePaymentInfrastructure|fetch\(|sendSMS|sendNotification|rallyz.*fetch/i);
});
function absenceDatabase(status="AVAILABLE") {
 const db=database();
 db.state.absences.push({id:"absence-a",studentId:"student-a",studentName:"합성 원생",classId:"class-a",date:"2026-10-10",reason:"ILLNESS_INJURY",status:"CONFIRMED",makeupStatus:status,resolution:null});
 db.state.makeupCredits.push({id:"makeup-a",status});
 db.state.registers.push({studentId:"student-a",month:"2026-10",status:"CONFIRMED",version:1,payload:{studentId:"student-a",month:"2026-10",classes:[{classId:"class-a",status:"ACTIVE",periodStart:"2026-10-01",periodEnd:"2026-10-31",baseAmount:100000,discountAmount:10000,carryAmount:0,prorationAmount:0,basis:"확정 원기간"}],shuttleAmount:20000,shuttleBasis:"확인",reason:"확인"}});
 return db;
}
const resolveCommand=view=>({action:"RESOLVE_ABSENCE",month:view.month,sourceVersion:view.sourceVersion,requestId:"resolve-absence-test",absenceId:"absence-a",resolution:"CARRY",evidenceConfirmed:true,eligibility:"ILLNESS_INJURY",reason:"증빙 확인",cancelReservation:false,originMonth:"2026-10"});
test("정규 결석 이월은 할인 후 원기간 금액/실제 예정 회수, 셔틀 제외",async()=>{
 const db=absenceDatabase();const view=await readWorkbench(db.tx,"2026-11",true);
 const result=await resolveWorkbenchAbsence(db,resolveCommand(view),"admin",true);
 assert.equal(db.state.carryCredits[0].numerator,"90000");assert.equal(db.state.carryCredits[0].denominator,"4");
 assert.equal(db.state.makeupCredits[0].status,"REVOKED");assert.equal(result.view.rows[0].carryAvailable,22500);
 // 신청함 검토 상태도 같은 거래에서 «이월 승인»으로
 assert.deepEqual(db.state.reviews,[{absenceId:"absence-a",status:"APPROVED",decidedByUserId:"admin",convertReason:null}]);
 await resolveWorkbenchAbsence(db,resolveCommand(view),"admin",true);assert.equal(db.state.carryCredits.length,1);
});
test("보강 예약은 명시 취소 확인 후 같은 거래에서 좌석 해제와 권 회수",async()=>{
 const db=absenceDatabase("RESERVED");db.state.bookings.push({id:"booking-a",status:"BOOKED",studentId:"student-a",originalClassId:"class-a",originalDate:"2026-10-09T15:00:00Z",updatedAt:"2026-10-11"});
 const view=await readWorkbench(db.tx,"2026-11",true),c=resolveCommand(view);
 await assert.rejects(()=>resolveWorkbenchAbsence(db,c,"admin",true),/좌석 해제/);assert.equal(db.state.carryCredits.length,0);
 await resolveWorkbenchAbsence(db,{...c,cancelReservation:true},"admin",true);
 assert.equal(db.state.bookings[0].status,"CANCELLED");assert.equal(db.state.makeupCredits[0].status,"REVOKED");
});
test("사용·노쇼·증빙 미확인은 이월 적립 차단",async()=>{
 for(const status of ["USED","NO_SHOW"]){const db=absenceDatabase(status);const view=await readWorkbench(db.tx,"2026-11",true);await assert.rejects(()=>resolveWorkbenchAbsence(db,resolveCommand(view),"admin",true),/사용된/);assert.equal(db.state.carryCredits.length,0);}
 const db=absenceDatabase();const view=await readWorkbench(db.tx,"2026-11",true);await assert.rejects(()=>resolveWorkbenchAbsence(db,{...resolveCommand(view),evidenceConfirmed:false},"admin",true),/인정 근거/);
});
test("원기간 확정 근거 누락·다른 예정일이면 추측 이월 금지",async()=>{
 const db=absenceDatabase();db.state.registers=[];let view=await readWorkbench(db.tx,"2026-11",true);await assert.rejects(()=>resolveWorkbenchAbsence(db,resolveCommand(view),"admin",true),/원결석 기간/);
 const db2=absenceDatabase();db2.state.absences[0].date="2026-10-11";view=await readWorkbench(db2.tx,"2026-11",true);await assert.rejects(()=>resolveWorkbenchAbsence(db2,resolveCommand(view),"admin",true),/예정 수업일/);
});
test("보강 선택은 기존 권리만 연결하고 새 소급 발급·금액 이월 없음",async()=>{
 const db=absenceDatabase();let view=await readWorkbench(db.tx,"2026-11",true);
 await resolveWorkbenchAbsence(db,{...resolveCommand(view),resolution:"MAKEUP",eligibility:"NONE",evidenceConfirmed:false},"admin",true);
 assert.equal(db.state.carryCredits.length,0);assert.equal(db.state.makeupCredits.length,1);assert.equal(db.state.makeupCredits[0].status,"AVAILABLE");
 view=await readWorkbench(db.tx,"2026-11",true);await assert.rejects(()=>resolveWorkbenchAbsence(db,{...resolveCommand(view),requestId:"resolve-again"},"admin",true),/미처리/);
});
test("이월 소진은 원적립별 분수로 연결하고 반올림 잔액·부채를 보존",()=>{
 const sources=[{id:"a",availableMonth:"2026-11",numerator:"2",denominator:"3"},{id:"b",availableMonth:"2026-12",numerator:"1",denominator:"3"}];
 const first=allocateCarry(sources,[],"2026-11",1);
 assert.deepEqual(first.sourceCreditIds,["a"]);assert.equal(first.basis.after.numerator,"-1");assert.equal(first.basis.after.denominator,"3");
 assert.equal(carryPool(sources,[{amount:1,basis:first.basis}],"2026-12").available,0);
 const third={id:"c",availableMonth:"2027-01",numerator:"2",denominator:"3"};
 assert.equal(carryPool([...sources,third],[{amount:1,basis:first.basis}],"2027-01").available,1);
});
test("미래 원적립 소진은 과거 적립 잔액을 임의 차감하지 않음",()=>{
 const sources=[{id:"old",availableMonth:"2026-11",numerator:"100",denominator:"1"},{id:"future",availableMonth:"2026-12",numerator:"200",denominator:"1"}];
 const usage={amount:200,basis:{allocations:[{creditId:"future",numerator:"200",denominator:"1"}]}};
 assert.equal(carryPool(sources,[usage],"2026-11").available,100);
 assert.equal(carryPool(sources,[{amount:1}],"2026-11").unresolved,true);
});
test("정상 이월 청구는 실제 사용근거·잔액을 저장하고 다음 발행에 중복 사용하지 않음",async()=>{
 const db=database({credit:50000});let view=await readWorkbench(db.tx,"2026-11",true);const save=command("SAVE",view);save.rows[0].carryAmount=20000;
 ({view}=await mutateWorkbench(db,save,"admin",true));({view}=await mutateWorkbench(db,command("CONFIRM",view),"admin",true));
 const result=await mutateWorkbench(db,command("ISSUE",view),"admin",true);
 assert.equal(db.state.payments[0].amount,80000);assert.deepEqual(db.state.usages[0].sourceCreditIds,["credit-a"]);
 assert.equal(db.state.usages[0].basis.allocations[0].numerator,"20000");assert.equal(result.view.rows[0].carryAvailable,30000);
});
test("원기간 장부·보강 시각·출결 정정도 미리보기 원본 버전을 바꿈",async()=>{
 const db=absenceDatabase();let view=await readWorkbench(db.tx,"2026-11",true),c=resolveCommand(view);
 db.state.registers[0].payload.classes[0].discountAmount=20000;
 await assert.rejects(()=>resolveWorkbenchAbsence(db,c,"admin",true),e=>e.refreshRequired===true);
 view=await readWorkbench(db.tx,"2026-11",true);c=resolveCommand(view);db.state.makeupCredits[0].updatedAt="2026-10-20T00:00:01Z";
 await assert.rejects(()=>resolveWorkbenchAbsence(db,c,"admin",true),e=>e.refreshRequired===true);
 view=await readWorkbench(db.tx,"2026-11",true);c=resolveCommand(view);db.state.attendance.push({id:"at-a",studentId:"student-a",classId:"class-a",date:"2026-10-10",status:"PRESENT",updatedAt:"now"});
 await assert.rejects(()=>resolveWorkbenchAbsence(db,c,"admin",true),e=>e.refreshRequired===true);
});
test("예정 수업일 0건은 저장 사유로 해소되지 않으며 확정 불가",async()=>{
 const db=database();db.state.events.push({title:"NO_SCHEDULE",date:"2026-11-01",endDate:null});let view=await readWorkbench(db.tx,"2026-11",true);
 ({view}=await mutateWorkbench(db,command("SAVE",view),"admin",true));assert.equal(view.rows[0].status,"REVIEW");assert.ok(view.rows[0].blockingReasons.length);
 await assert.rejects(()=>mutateWorkbench(db,command("CONFIRM",view),"admin",true),/실제 수업일/);
});
test("이미 발행한 반이 미사용 이월 잔액을 선점하지 않음",async()=>{
 const db=database({credit:50000,secondClass:true});db.state.payments.push({id:"already",studentId:"student-a",classId:"class-a",amount:100000,type:"MONTHLY",status:"PAID"});
 const view=await readWorkbench(db.tx,"2026-11",true);assert.equal(view.rows[0].carryAmount,0);assert.equal(view.rows[1].carryAmount,50000);
});
test("취소·출석정정된 원적립과 특강 미대조 금액은 추가 확정·발행 보류",async()=>{
 const db=database();db.state.carryCredits.push({id:"bad",studentId:"student-a",numerator:"1000",denominator:"1",availableMonth:"2026-11",valid:false});let view=await readWorkbench(db.tx,"2026-11",true);
 assert.equal(view.rows[0].carryAvailable,0);assert.match(view.rows[0].blockingReasons.join(" "),/원결석/);
 ({view}=await mutateWorkbench(db,command("SAVE",view),"admin",true));await assert.rejects(()=>mutateWorkbench(db,command("CONFIRM",view),"admin",true),/원결석/);
 const db2=database();db2.state.seasonalCredits.push({id:"season-credit",studentId:"student-a",amount:25000,status:"ACTIVE"});view=await readWorkbench(db2.tx,"2026-11",true);assert.match(view.rows[0].blockingReasons.join(" "),/특강 이월/);
});
test("사용된 이월 청구가 취소되면 기록 보존하고 해당 학생 후속 발행 차단",async()=>{
 const db=database({credit:50000,secondClass:true});let view=await readWorkbench(db.tx,"2026-11",true);const save=command("SAVE",view);save.rows[0].carryAmount=20000;
 ({view}=await mutateWorkbench(db,save,"admin",true));({view}=await mutateWorkbench(db,command("CONFIRM",view),"admin",true));await mutateWorkbench(db,command("ISSUE",view),"admin",true);
 db.state.payments[0].status="CANCELED";view=await readWorkbench(db.tx,"2026-11",true);
 assert.equal(db.state.usages.length,1);assert.match(view.rows[1].blockingReasons.join(" "),/취소·환불/);
});
test("이월 회수는 보강 예약 연결까지 지움",async()=>{
 const db=absenceDatabase("RESERVED");db.state.makeupCredits[0].makeupSessionId="old-booking";const view=await readWorkbench(db.tx,"2026-11",true);
 await resolveWorkbenchAbsence(db,{...resolveCommand(view),cancelReservation:true},"admin",true);assert.equal(db.state.makeupCredits[0].makeupSessionId,null);
});
test("원기간 새 발행 금액과 구 월장부 충돌 시 자동 이월 적립하지 않음",async()=>{
 const db=absenceDatabase();db.state.drafts.push({id:"student-a:class-a",studentId:"student-a",classId:"class-a",month:"2026-10",version:3,status:"ISSUED",payload:{...draft(),discountAmount:20000},reason:"원기간 수정",sourceVersion:"old",paymentId:"origin-payment"});
 const view=await readWorkbench(db.tx,"2026-11",true);await assert.rejects(()=>resolveWorkbenchAbsence(db,resolveCommand(view),"admin",true),/발행 금액과 기존 확정 장부/);assert.equal(db.state.carryCredits.length,0);
});
test("원기간 새 워크벤치 발행이 있으면 구 월장부 없이 정본 할인 후 수강료 사용",async()=>{
 const db=absenceDatabase();db.state.registers=[];
 db.state.drafts.push({id:"student-a:class-a",studentId:"student-a",classId:"class-a",month:"2026-10",version:3,status:"ISSUED",payload:{...draft(),discountAmount:20000,carryAmount:10000},reason:"원기간 수정",sourceVersion:"old",paymentId:"origin-payment"});
 db.state.payments.push({id:"origin-payment",studentId:"student-a",classId:"class-a",status:"PAID",amount:70000,type:"MONTHLY",year:2026,month:10,invoiceAmount:70000,invoiceStatus:"PAID"});
 db.state.invoices.push({id:"origin-invoice",paymentId:"origin-payment",status:"PAID",amount:70000});
 const view=await readWorkbench(db.tx,"2026-11",true);await resolveWorkbenchAbsence(db,resolveCommand(view),"admin",true);
 assert.equal(db.state.carryCredits[0].numerator,"80000");assert.equal(db.state.carryCredits[0].basis.source,"WORKBENCH_ISSUED");
});
test("P1 구 발행 월중 차감에 기간 스냅샷이 없으면 4회로 추측 이월 금지",async()=>{
 const db=absenceDatabase();db.state.registers=[];
 db.state.drafts.push({id:"student-a:class-a",studentId:"student-a",classId:"class-a",month:"2026-10",version:3,status:"ISSUED",payload:{...draft(),prorationAmount:50000},reason:"월중 등록",sourceVersion:"old",paymentId:"origin-payment"});
 db.state.payments.push({id:"origin-payment",studentId:"student-a",classId:"class-a",status:"PAID",amount:50000,type:"MONTHLY",year:2026,month:10,invoiceAmount:50000,invoiceStatus:"PAID"});
 const view=await readWorkbench(db.tx,"2026-11",true);
 await assert.rejects(()=>resolveWorkbenchAbsence(db,resolveCommand(view),"admin",true),/월중 청구의 실제 수강 기간/);
 assert.equal(db.state.carryCredits.length,0);
});
test("P1 발행 스냅샷의 실제 월중 2회와 할인 후 50000원으로 25000원 이월",async()=>{
 const db=absenceDatabase();db.state.registers=[];db.state.absences[0].date="2026-10-17";
 db.state.drafts.push({id:"student-a:class-a",studentId:"student-a",classId:"class-a",month:"2026-10",version:3,status:"ISSUED",payload:{...draft(),prorationAmount:50000},reason:"월중 등록",sourceVersion:"old",paymentId:"origin-payment",periodStart:"2026-10-17",periodEnd:"2026-10-31",scheduledDates:["2026-10-17","2026-10-24"],calculationBasis:{source:"ANNUAL_EVENT"}});
 db.state.payments.push({id:"origin-payment",studentId:"student-a",classId:"class-a",status:"PAID",amount:50000,type:"MONTHLY",year:2026,month:10,invoiceAmount:50000,invoiceStatus:"PAID"});db.state.invoices.push({id:"origin-invoice",paymentId:"origin-payment",status:"PAID",amount:50000});
 const view=await readWorkbench(db.tx,"2026-11",true);const result=await resolveWorkbenchAbsence(db,resolveCommand(view),"admin",true);
 assert.equal(db.state.carryCredits[0].numerator,"50000");assert.equal(db.state.carryCredits[0].denominator,"2");assert.equal(result.view.rows[0].carryAvailable,25000);
});
test("P1 적립 후 원기간 휴강 변경은 새 저장 사유로 기존 분모를 우회하지 못함",async()=>{
 const db=absenceDatabase();let view=await readWorkbench(db.tx,"2026-11",true);await resolveWorkbenchAbsence(db,resolveCommand(view),"admin",true);
 db.state.events.push({title:"CLOSE_OCT_10",date:"2026-10-10",endDate:null});view=await readWorkbench(db.tx,"2026-11",true);assert.equal(view.rows[0].carryAvailable,0);
 assert.ok(view.rows[0].blockingReasons.length);const save=command("SAVE",view);save.rows[0].carryAmount=0;({view}=await mutateWorkbench(db,save,"admin",true));
 await assert.rejects(()=>mutateWorkbench(db,command("CONFIRM",view),"admin",true),/원결석/);
});
test("신규 초안·발행에 실제 수강 기간·예정일·계산 근거를 고정 저장",async()=>{
 const db=database();let view=await readWorkbench(db.tx,"2026-11",true);const save=command("SAVE",view);Object.assign(save.rows[0],{periodStart:"2026-11-15",periodEnd:"2026-11-30",prorationAmount:50000});
 ({view}=await mutateWorkbench(db,save,"admin",true));assert.deepEqual(db.state.drafts[0].scheduledDates,["2026-11-21","2026-11-28"]);assert.equal(db.state.drafts[0].calculationBasis.discountedTuition,50000);assert.equal(view.rows[0].periodStart,"2026-11-15");
 ({view}=await mutateWorkbench(db,command("CONFIRM",view),"admin",true));await mutateWorkbench(db,command("ISSUE",view),"admin",true);
 assert.equal(db.state.drafts[0].periodStart,"2026-11-15");assert.equal(db.state.drafts[0].scheduledDates.length,2);assert.equal(db.state.payments[0].amount,50000);
});
test("학생 잠금에서 통합된 이전 ID가 사라지면 저장·이월 정산 차단",async()=>{
 const db=database();const view=await readWorkbench(db.tx,"2026-11",true);db.state.studentHidden=true;
 await assert.rejects(()=>mutateWorkbench(db,command("SAVE",view),"admin",true),/통합되거나 변경된 학생/);assert.equal(db.state.drafts.length,0);
 const absenceDb=absenceDatabase();const absenceView=await readWorkbench(absenceDb.tx,"2026-11",true);absenceDb.state.studentHidden=true;
 await assert.rejects(()=>resolveWorkbenchAbsence(absenceDb,resolveCommand(absenceView),"admin",true),/통합되거나 변경된 학생/);assert.equal(absenceDb.state.carryCredits.length,0);
});
test("공식 일정 주입은 DB 단독 누락을 보완하고 저장·확정·발행에 같은 snapshot 사용",async()=>{
 const db=database();db.state.events.push({title:"NO_SCHEDULE",date:"2026-11-01",endDate:null});
 const calendar={kind:"DB_AND_ICS",events:[{title:"11월 개강",date:"2026-11-01T00:00:00Z"}],fingerprint:"a".repeat(64)};
 assert.equal((await readWorkbench(db.tx,"2026-11",true)).rows[0].scheduledDates.length,0);
 let view=await readWorkbench(db.tx,"2026-11",true,calendar);assert.equal(view.rows[0].scheduledDates.length,4);assert.equal(view.calendarSource,"DB_AND_ICS");
 ({view}=await mutateWorkbench(db,command("SAVE",view),"admin",true,calendar));assert.equal(db.state.drafts[0].calculationBasis.source,"DB_AND_ICS");
 assert.equal(db.state.drafts[0].calculationBasis.calendarFingerprint,calendar.fingerprint);
 ({view}=await mutateWorkbench(db,command("CONFIRM",view),"admin",true,calendar));await mutateWorkbench(db,command("ISSUE",view),"admin",true,calendar);assert.equal(db.state.payments.length,1);
});
test("공식 일정 snapshot이 바뀌면 미리보기 금액의 확정·발행을 거부",async()=>{
 const db=database(),calendar={kind:"DB_AND_ICS",events:[{title:"11월 개강",date:"2026-11-01T00:00:00Z"}],fingerprint:"a".repeat(64)};
 let view=await readWorkbench(db.tx,"2026-11",true,calendar);({view}=await mutateWorkbench(db,command("SAVE",view),"admin",true,calendar));
 const changed={...calendar,events:[...calendar.events,{title:"학원 휴무",date:"2026-11-21T00:00:00Z"}],fingerprint:"b".repeat(64)};
 await assert.rejects(()=>mutateWorkbench(db,command("CONFIRM",view),"admin",true,changed),e=>e.refreshRequired===true);
 assert.equal(db.state.payments.length,0);
});

// ── 3회 달 자동 차감(원장 결정 2026-10-30): 정가는 월 4회 기준, 모자란 회차만큼 1/4씩 뺀다 ──
test("3회 달 차감액은 정가÷4×모자란 회차, 0회·4회 이상은 0원",()=>{
 assert.equal(shortMonthProration(100000,3),25000);
 assert.equal(shortMonthProration(110000,3),27500);
 assert.equal(shortMonthProration(120000,3),30000);
 assert.equal(shortMonthProration(300000,2),150000);
 assert.equal(shortMonthProration(99999,3),25000); // 원 단위 반올림
 for(const [fee,n] of [[100000,4],[100000,5],[100000,0],[0,3],[100000,-1],[100000,2.5]]) assert.equal(shortMonthProration(fee,n),0);
});
test("연간 일정 3회인 달은 1회분을 자동 차감해 제안하고 그대로 발행된다",async()=>{
 const db=database();db.state.events.push({title:"SHORT_MONTH",date:"2026-11-01",endDate:null});
 let view=await readWorkbench(db.tx,"2026-11",true);const row=view.rows[0];
 assert.equal(row.scheduledDates.length,3);assert.equal(row.prorationAmount,25000);assert.equal(row.totalAmount,75000);
 assert.ok(row.basis.some(b=>/1회 적은 달 → 25,000원 차감/.test(b)),row.basis.join(" / "));
 const save=command("SAVE",view);save.rows[0]={...save.rows[0],prorationAmount:row.prorationAmount,periodStart:row.periodStart,periodEnd:row.periodEnd};
 ({view}=await mutateWorkbench(db,save,"admin",true));({view}=await mutateWorkbench(db,command("CONFIRM",view),"admin",true));
 await mutateWorkbench(db,command("ISSUE",view),"admin",true);
 assert.equal(db.state.payments.length,1);assert.equal(db.state.payments[0].amount,75000);
});
test("4회인 달은 차감하지 않는다",async()=>{
 const db=database();const view=await readWorkbench(db.tx,"2026-11",true);
 assert.equal(view.rows[0].scheduledDates.length,4);assert.equal(view.rows[0].prorationAmount,0);assert.equal(view.rows[0].totalAmount,100000);
});
test("확정 장부에 3회 달 일할이 빠져 있으면 금액은 장부대로 두고 검토로 알린다",async()=>{
 const db=database();db.state.events.push({title:"SHORT_MONTH",date:"2026-11-01",endDate:null});
 db.state.registers.push({studentId:"student-a",month:"2026-11",status:"CONFIRMED",version:1,payload:{studentId:"student-a",month:"2026-11",classes:[{classId:"class-a",status:"ACTIVE",periodStart:"2026-11-01",periodEnd:"2026-11-30",baseAmount:100000,discountAmount:0,carryAmount:0,prorationAmount:0,basis:"확정"}],shuttleAmount:0,shuttleBasis:"없음",reason:"확인"}});
 const view=await readWorkbench(db.tx,"2026-11",true);
 assert.equal(view.rows[0].prorationAmount,0);
 assert.ok(view.rows[0].reviewReasons.some(r=>r.includes("할인 후 금액 기준 25,000원이어야 합니다(현재 0원)")),view.rows[0].reviewReasons.join(" / "));
});

// ── 할인 후 금액 기준(원장 결정 2026-10-30): (정가 − 할인) × 모자란 회차 ÷ 4 ──
test("3회 달 차감은 할인 후 금액 기준 — 할인 10,000원이면 22,500원",()=>{
 assert.equal(shortMonthProration(100000,3,10000),22500);
 assert.equal(shortMonthProration(100000,3,0),25000);
 assert.equal(shortMonthProration(100000,3),25000);
 assert.equal(shortMonthProration(110000,3,11000),24750);
 for(const d of [100000,120000,-1,0.5]) assert.equal(shortMonthProration(100000,3,d),0);
 // 결석 이월 1회분 = (정가 − 할인 − 기간 조정) ÷ 그달 횟수 → 4회 달의 1회분과 같아야 한다
 const base=100000,discount=10000;
 assert.equal((base-discount-shortMonthProration(base,3,discount))/3,(base-discount)/4);
 assert.equal((base-discount-shortMonthProration(base,3,discount))/3,22500);
});
test("할인 있는 3회 달: 할인 후 기준 차감으로 저장하면 67,500원 발행, 근거에 경고 없음",async()=>{
 const db=database();db.state.events.push({title:"SHORT_MONTH",date:"2026-11-01",endDate:null});
 let view=await readWorkbench(db.tx,"2026-11",true);const row=view.rows[0];
 const save=command("SAVE",view);save.rows[0]={...save.rows[0],discountAmount:10000,prorationAmount:22500,periodStart:row.periodStart,periodEnd:row.periodEnd};
 ({view}=await mutateWorkbench(db,save,"admin",true));
 assert.equal(view.rows[0].totalAmount,67500);
 assert.ok(!view.rows[0].basis.some(b=>b.startsWith("확인:")),view.rows[0].basis.join(" / "));
 ({view}=await mutateWorkbench(db,command("CONFIRM",view),"admin",true));
 await mutateWorkbench(db,command("ISSUE",view),"admin",true);
 assert.equal(db.state.payments[0].amount,67500);
});
test("할인을 넣고 정가 기준 차감(25,000원)을 그대로 두면 근거에 할인 후 기준 22,500원을 알린다",async()=>{
 const db=database();db.state.events.push({title:"SHORT_MONTH",date:"2026-11-01",endDate:null});
 let view=await readWorkbench(db.tx,"2026-11",true);const row=view.rows[0];
 const save=command("SAVE",view);save.rows[0]={...save.rows[0],discountAmount:10000,prorationAmount:25000,periodStart:row.periodStart,periodEnd:row.periodEnd};
 ({view}=await mutateWorkbench(db,save,"admin",true));
 assert.ok(view.rows[0].basis.some(b=>b.includes("할인 후 금액 기준 22,500원이어야 합니다(현재 25,000원)")),view.rows[0].basis.join(" / "));
});
test("기간을 그달 일부로 좁힌 3회 달은 관리자 값이라 할인 후 기준과 비교하지 않는다",async()=>{
 const db=database();db.state.events.push({title:"SHORT_MONTH",date:"2026-11-01",endDate:null});
 let view=await readWorkbench(db.tx,"2026-11",true);
 const save=command("SAVE",view);save.rows[0]={...save.rows[0],prorationAmount:50000,periodStart:"2026-11-14",periodEnd:"2026-11-21"};
 ({view}=await mutateWorkbench(db,save,"admin",true));
 assert.equal(view.rows[0].scheduledDates.length,2);
 assert.ok(!view.rows[0].basis.some(b=>b.startsWith("확인:")));
});
test("청구 행에 그달 전체 수업일(monthDates)을 함께 내려준다",async()=>{
 const db=database();db.state.events.push({title:"SHORT_MONTH",date:"2026-11-01",endDate:null});
 const view=await readWorkbench(db.tx,"2026-11",true);
 assert.deepEqual(view.rows[0].monthDates,["2026-11-07","2026-11-14","2026-11-21"]);
});
test("청구 화면은 수강료·할인을 바꾸면 할인 후 기준으로 기간 조정을 다시 계산하고, 기간을 좁히면 경고한다",async()=>{
 const ui=await readFile("src/app/admin/finance/prepare/BillingWorkbench.tsx","utf8");
 assert.ok(ui.includes('key === "baseAmount" || key === "discountAmount"'));
 assert.ok(ui.includes("shortMonthProration(base, row.monthDates.length, discount)"));
 assert.match(ui,/수강 기간을 그달 일부로 좁혔습니다/);
});


test("수강 개시 전 월은 청구 제외·예정 수업 0회이며 뒤집힌 기간을 만들지 않음",async()=>{
 const db=database();db.state.enrollments[0].startsOn="2026-12-01";
 const view=await readWorkbench(db.tx,"2026-11",true),row=view.rows[0];
 assert.equal(row.status,"EXCLUDED");assert.equal(row.totalAmount,0);assert.deepEqual(row.scheduledDates,[]);assert.equal(row.periodStart,null);assert.equal(row.periodEnd,null);
 await assert.rejects(()=>mutateWorkbench(db,command("ISSUE",view),"admin",true));assert.equal(db.state.payments.length,0);
});
test("월중 개시일은 그 이전 수업을 청구 계산에서 제외하고 금액 검토를 요구",async()=>{
 const db=database();db.state.enrollments[0].startsOn="2026-11-15";
 const view=await readWorkbench(db.tx,"2026-11",true),row=view.rows[0];
 assert.equal(row.periodStart,"2026-11-15");assert.deepEqual(row.scheduledDates,["2026-11-21","2026-11-28"]);assert.equal(row.status,"REVIEW");assert.ok(row.reviewReasons.some(t=>t.includes("개시일 이후")));
});
test("같은 날 개시는 포함하고 기존 개시일 미상 수강의 기간은 보존",async()=>{
 const db=database();db.state.enrollments[0].startsOn="2026-11-07";
 assert.equal((await readWorkbench(db.tx,"2026-11",true)).rows[0].scheduledDates.length,4);
 db.state.enrollments[0].startsOn=null;assert.equal((await readWorkbench(db.tx,"2026-11",true)).rows[0].scheduledDates.length,4);
});
// ── 주N회 요금·셔틀비·형제할인 «제안값» (2026-11-08) ──
const hobbyProgram={programId:"hobby",programName:"주중취미반",price:100000,priceWeek1:100000,priceWeek2:160000,priceWeek3:210000,priceDaily:null,runsShuttle:true,shuttleFeeOverride:null,slotKey:null};
function pricingDatabase(){
 const db=database();
 db.state.enrollments=[
  {...db.state.enrollments[0],...hobbyProgram,studentId:"kid-1",studentName:"형",classId:"mon",dayOfWeek:"Mon",parentId:"parent-a",birthDate:"2015-01-01"},
  {...db.state.enrollments[0],...hobbyProgram,studentId:"kid-1",studentName:"형",classId:"wed",dayOfWeek:"Wed",parentId:"parent-a",birthDate:"2015-01-01"},
  {...db.state.enrollments[0],...hobbyProgram,studentId:"kid-2",studentName:"동생",classId:"tue",dayOfWeek:"Tue",parentId:"parent-a",birthDate:"2017-01-01"},
 ];
 db.state.shuttleStops=[{serviceMonth:"2026-11",studentId:"kid-1",studentName:"형"},{serviceMonth:"2026-11",studentId:null,studentName:"연결안됨"}];
 return db;
}
test("주2회 학생은 주2회 요금을 반 수로 나누고, 형제는 수강료만 10% 할인, 셔틀비는 첫 반 한 행에만",async()=>{
 const view=await readWorkbench(pricingDatabase().tx,"2026-11",true);
 const row=id=>view.rows.find(r=>r.id===id);
 assert.equal(row("kid-1:mon").baseAmount,80000);assert.equal(row("kid-1:wed").baseAmount,80000);
 assert.equal(row("kid-1:mon").discountAmount,8000);assert.equal(row("kid-2:tue").discountAmount,10000);
 assert.equal(row("kid-1:mon").shuttleAmount,15000);assert.equal(row("kid-1:wed").shuttleAmount,0);assert.equal(row("kid-2:tue").shuttleAmount,0);
 // 형 합계 = 160,000 − 16,000 + 셔틀 15,000(할인 대상 아님)
 assert.equal(row("kid-1:mon").totalAmount+row("kid-1:wed").totalAmount,159000);
 assert.ok(row("kid-1:mon").basis.some(b=>/주2회 요금 160,000원/.test(b)));
 assert.ok(view.notices.some(n=>/연결되지 않은 1명/.test(n)));
});
test("휴원 형제는 세지 않고, 휴원 반은 주N회 횟수에서 뺀다",async()=>{
 const db=pricingDatabase();db.state.enrollments[1].status="PAUSED";db.state.enrollments[2].status="PAUSED";
 const view=await readWorkbench(db.tx,"2026-11",true),row=view.rows.find(r=>r.id==="kid-1:mon");
 assert.equal(row.baseAmount,100000);assert.equal(row.discountAmount,0);assert.equal(row.shuttleAmount,10000);
});
test("사람이 저장한 할인·셔틀 값은 제안값으로 덮어쓰지 않는다",async()=>{
 const db=pricingDatabase();let view=await readWorkbench(db.tx,"2026-11",true);
 const target=view.rows.find(r=>r.id==="kid-1:mon");
 const save={action:"SAVE",month:"2026-11",sourceVersion:view.sourceVersion,requestId:"request-manual-discount",rows:[{id:target.id,expectedVersion:target.version,baseAmount:80000,discountAmount:20000,prorationAmount:0,carryAmount:0,shuttleAmount:0,reason:"원장 지시 별도 할인·셔틀 무료"}]};
 ({view}=await mutateWorkbench(db,save,"admin",true));
 const saved=view.rows.find(r=>r.id==="kid-1:mon");
 assert.equal(saved.discountAmount,20000);assert.equal(saved.shuttleAmount,0);
 // 저장 행이 셔틀 첫 행이라 다른 반에 셔틀비를 다시 제안하지 않는다
 assert.equal(view.rows.find(r=>r.id==="kid-1:wed").shuttleAmount,0);
});
test("이번 달 기존 청구가 있는 학생에게는 셔틀비를 다시 제안하지 않는다",async()=>{
 const db=pricingDatabase();db.state.payments.push({id:"rallyz",studentId:"kid-1",classId:"mon",amount:95000,status:"PAID",type:"MONTHLY"});
 const view=await readWorkbench(db.tx,"2026-11",true);
 assert.equal(view.rows.find(r=>r.id==="kid-1:wed").shuttleAmount,0);
 assert.ok(view.rows.find(r=>r.id==="kid-1:wed").basis.some(b=>/제안하지 않음/.test(b)));
});
test("셔틀 명단이 바뀌면 원본 버전이 바뀐다(저장 초안 재검토)",async()=>{
 const db=pricingDatabase();const before=(await readWorkbench(db.tx,"2026-11",true)).sourceVersion;
 db.state.shuttleStops.push({serviceMonth:"2026-11",studentId:"kid-2",studentName:"동생"});
 assert.notEqual((await readWorkbench(db.tx,"2026-11",true)).sourceVersion,before);
});
// ── 검수 권장 반영(2026-11-08): 저장값≠제안값 알림 · 셔틀비 미제안 검토 사유 · 확정 장부 학생은 장부 셔틀비만 ──
test("저장 초안이 새 요금 기준 제안과 다르면 검토 사유에 알리고 저장값은 그대로 둔다",async()=>{
 const db=pricingDatabase();let view=await readWorkbench(db.tx,"2026-11",true);
 const target=view.rows.find(r=>r.id==="kid-1:mon");
 assert.equal(target.baseAmount,80000);assert.equal(target.discountAmount,8000);assert.equal(target.shuttleAmount,15000);
 const save={action:"SAVE",month:"2026-11",sourceVersion:view.sourceVersion,requestId:"request-old-price",rows:[{id:target.id,expectedVersion:target.version,baseAmount:100000,discountAmount:8000,prorationAmount:0,carryAmount:0,shuttleAmount:15000,reason:"옛 요금으로 저장"}]};
 ({view}=await mutateWorkbench(db,save,"admin",true));
 let row=view.rows.find(r=>r.id==="kid-1:mon");
 assert.equal(row.baseAmount,100000); // 저장값 유지
 const note="수강료: 새 요금 기준 제안 80,000원과 다릅니다(저장값 100,000원)";
 assert.ok(!row.basis.some(b=>/새 요금 기준/.test(b))); // 근거에 영구 경고로 남기지 않는다
 // 원본이 바뀌어(옛 기준 초안) 재검토 상태가 되면 검토 사유에 보인다
 db.state.shuttleStops.push({serviceMonth:"2026-11",studentId:"someone-else",studentName:"다른 아이"});
 row=(await readWorkbench(db.tx,"2026-11",true)).rows.find(r=>r.id==="kid-1:mon");
 assert.ok(row.reviewReasons.includes(note));assert.equal(row.baseAmount,100000);assert.equal(row.status,"REVIEW");
 assert.ok(!row.reviewReasons.some(r=>/^(할인|셔틀비): 새 요금/.test(r))); // 같은 칸은 알리지 않는다
});
test("기존 청구 때문에 셔틀비를 제안하지 않으면 검토 사유에도 남긴다",async()=>{
 const db=pricingDatabase();db.state.payments.push({id:"rallyz",studentId:"kid-1",classId:"mon",amount:95000,status:"PAID",type:"MONTHLY"});
 const row=(await readWorkbench(db.tx,"2026-11",true)).rows.find(r=>r.id==="kid-1:wed");
 assert.equal(row.shuttleAmount,0);
 assert.ok(row.reviewReasons.some(r=>/제안하지 않음.*셔틀비가 빠지거나 두 번/.test(r)));
});
test("확정 장부가 있는 학생은 장부 뒤 추가된 반이 정렬상 앞이어도 셔틀비를 새로 제안하지 않고 장부 셔틀비를 쓴다",async()=>{
 const db=pricingDatabase();
 // 장부에는 수요일 반만 있다(월요일 반은 장부 확정 뒤 추가). 정렬상 kid-1:mon 이 먼저 처리된다.
 db.state.registers.push({studentId:"kid-1",month:"2026-11",status:"CONFIRMED",version:1,payload:{studentId:"kid-1",month:"2026-11",classes:[{classId:"wed",status:"ACTIVE",periodStart:"2026-11-01",periodEnd:"2026-11-30",baseAmount:80000,discountAmount:8000,carryAmount:0,prorationAmount:0,basis:"확정"}],shuttleAmount:20000,shuttleBasis:"장부 셔틀",reason:"확인"}});
 const view=await readWorkbench(db.tx,"2026-11",true),row=id=>view.rows.find(r=>r.id===id);
 assert.equal(row("kid-1:mon").shuttleAmount,0);
 assert.equal(row("kid-1:wed").shuttleAmount,20000);
 assert.ok(!row("kid-1:mon").basis.some(b=>/셔틀 명단 있음/.test(b))); // 새 셔틀비 제안·미제안 문구 없음
});
// ── 원장 결정 2026-11-09: 무료 거점 셔틀·대회준비반 30만원 묶음이 화면 행까지 이어지는지 ──
test("무료 거점(1호점 앞 버스정류장)만 타는 학생은 셔틀비 0원, 근거에 무료 거점이 남는다",async()=>{
 const db=pricingDatabase();
 db.state.shuttleStops=[{serviceMonth:"2026-11",studentId:"kid-1",studentName:"형",direction:"BOARD",stopName:"1호점 앞 버스정류장"},{serviceMonth:"2026-11",studentId:"kid-1",studentName:"형",direction:"ALIGHT",stopName:"새봄중학교 앞 버스정류장"}];
 const view=await readWorkbench(db.tx,"2026-11",true),row=view.rows.find(r=>r.id==="kid-1:mon");
 assert.equal(row.shuttleAmount,0);
 assert.ok(row.basis.some(b=>/무료 거점\(1호점 앞 버스정류장\)/.test(b)));
});
test("대회준비반(주말+수요일)+일반 반 1개 학생은 첫 대회준비반 행에 300,000원, 나머지 0원",async()=>{
 const db=pricingDatabase();
 const comp={programId:"comp",programName:"대회준비반",price:300000,priceWeek1:null,priceWeek2:null,priceWeek3:null,priceDaily:null,runsShuttle:true,shuttleFeeOverride:null};
 const base={...db.state.enrollments[0],studentId:"ace",studentName:"대표",parentId:null,birthDate:null};
 db.state.enrollments=[{...base,...comp,classId:"a-sun8",dayOfWeek:"Sun",slotKey:"Sun-8"},{...base,...comp,classId:"b-wed7",dayOfWeek:"Wed",slotKey:"Wed-7"},{...base,...hobbyProgram,classId:"c-fri5",dayOfWeek:"Fri"}];
 const view=await readWorkbench(db.tx,"2026-11",true),row=id=>view.rows.find(r=>r.id===id);
 assert.deepEqual(["ace:a-sun8","ace:b-wed7","ace:c-fri5"].map(id=>row(id).baseAmount),[300000,0,0]);
 assert.ok(row("ace:a-sun8").basis.some(b=>/대회준비반 월 300,000원 고정/.test(b)));
});
// 원장 확정(2026-11-09): 대회준비반 고정 요금(30만 묶음·평일만 15만)에는 형제할인·3회 달 차감을 붙이지 않는다.
const compProgram={programId:"comp",programName:"대회준비반",price:300000,priceWeek1:null,priceWeek2:null,priceWeek3:null,priceDaily:null,runsShuttle:true,shuttleFeeOverride:null};
function compSiblingDatabase(aceClasses){
 const db=pricingDatabase();
 const ace={...db.state.enrollments[0],studentId:"ace",studentName:"대표",parentId:"parent-a",birthDate:"2014-01-01"};
 // 형제(parent-a): kid-1(주중취미 주2회)·kid-2(주중취미 주1회)·ace(대회준비반)
 db.state.enrollments=[...db.state.enrollments,...aceClasses.map(c=>({...ace,...c}))];
 db.state.shuttleStops=[];
 return db;
}
test("형제+대회준비반 묶음: 묶음 행은 형제할인 없음, 묶음 밖 일반 반과 다른 형제는 형제할인 그대로",async()=>{
 const db=compSiblingDatabase([{...compProgram,classId:"a-sun8",dayOfWeek:"Sun",slotKey:"Sun-8"},{...compProgram,classId:"b-wed7",dayOfWeek:"Wed",slotKey:"Wed-7"},
  {...hobbyProgram,classId:"c-fri5",dayOfWeek:"Fri"},{...hobbyProgram,classId:"d-thu",dayOfWeek:"Thu"}]);
 const view=await readWorkbench(db.tx,"2026-11",true),row=id=>view.rows.find(r=>r.id===id);
 assert.equal(row("ace:a-sun8").baseAmount,300000);assert.equal(row("ace:a-sun8").discountAmount,0);
 assert.ok(row("ace:a-sun8").basis.some(b=>/고정 요금 — 형제할인·3회 달 차감 없음/.test(b)),row("ace:a-sun8").basis.join(" / "));
 assert.ok(!row("ace:a-sun8").basis.some(b=>/형제할인 10% 제안/.test(b)));
 assert.equal(row("ace:c-fri5").discountAmount,0); // 포함된 일반 반(0원)
 assert.equal(row("ace:d-thu").baseAmount,100000);assert.equal(row("ace:d-thu").discountAmount,10000); // 묶음 밖 일반 반은 형제할인
 assert.equal(row("kid-2:tue").discountAmount,10000); // 다른 형제는 그대로
});
test("3회 달+대회준비반 묶음: 300,000원에서 차감하지 않고, 같은 달 일반 반은 차감",async()=>{
 const db=compSiblingDatabase([{...compProgram,classId:"a-sun8",dayOfWeek:"Sun",slotKey:"Sun-8"},{...compProgram,classId:"b-wed7",dayOfWeek:"Wed",slotKey:"Wed-7"}]);
 db.state.events.push({title:"SHORT_MONTH",date:"2026-11-01",endDate:null});
 const view=await readWorkbench(db.tx,"2026-11",true),row=id=>view.rows.find(r=>r.id===id);
 assert.equal(row("ace:a-sun8").prorationAmount,0);assert.equal(row("ace:a-sun8").totalAmount,300000);
 assert.ok(!row("ace:a-sun8").reviewReasons.some(r=>/기간 조정/.test(r)),row("ace:a-sun8").reviewReasons.join(" / "));
 assert.ok(row("kid-2:tue").prorationAmount>0); // 일반 반은 3회 달 차감 그대로
});
test("대회준비반 수요일만: 150,000원 고정, 형제·3회 달이어도 할인·차감 없음",async()=>{
 const db=compSiblingDatabase([{...compProgram,classId:"b-wed7",dayOfWeek:"Wed",slotKey:"Wed-7"}]);
 db.state.events.push({title:"SHORT_MONTH",date:"2026-11-01",endDate:null});
 const view=await readWorkbench(db.tx,"2026-11",true),r=view.rows.find(x=>x.id==="ace:b-wed7");
 assert.deepEqual([r.baseAmount,r.discountAmount,r.prorationAmount,r.totalAmount],[150000,0,0,150000]);
 assert.ok(r.basis.some(b=>/평일\(수요일\)만 월 150,000원 고정/.test(b)));
});
test("대회준비반 수요일+일반 반: 대회준비반 150,000 고정(할인 없음), 일반 반은 일반 요금+형제할인+확인 경고",async()=>{
 const db=compSiblingDatabase([{...compProgram,classId:"b-wed7",dayOfWeek:"Wed",slotKey:"Wed-7"},{...hobbyProgram,classId:"c-mon",dayOfWeek:"Mon"}]);
 const view=await readWorkbench(db.tx,"2026-11",true),row=id=>view.rows.find(r=>r.id===id);
 assert.deepEqual([row("ace:b-wed7").baseAmount,row("ace:b-wed7").discountAmount],[150000,0]);
 // 일반 반은 대회준비반을 빼고 주1회 → 100,000, 형제할인 10%
 assert.deepEqual([row("ace:c-mon").baseAmount,row("ace:c-mon").discountAmount],[100000,10000]);
 assert.ok(row("ace:c-mon").reviewReasons.some(x=>/평일 대회준비반\(150,000원 고정\)과 일반 반 1개/.test(x)));
});

// ── 신청함 [이월 승인](2026-11-14 원장 결정 a3) — 기존 CARRY 규칙을 «그대로» 부르는 연결부를 실제로 돌려 본다 ──
// src/lib/regular/illness-carry-admin.ts: 결석 확정 + 최신 자료 버전 읽기 + resolveWorkbenchAbsence 를 한 거래로 묶는다.
const guardUrl=url(await readFile("src/lib/billing/absence-compensation-guard.ts","utf8"));
const creditRulesUrl=url(await readFile("src/lib/makeup/credit-rules.ts","utf8"));
const reportCreditUrl=url((await readFile("src/lib/makeup/absence-report-credit.ts","utf8")).replace('from "./credit-rules"',`from "${creditRulesUrl}"`).replace('from "@/lib/billing/absence-compensation-guard"',`from "${guardUrl}"`).replace('from "@/lib/datetime/kst"',`from "${kstUrl}"`).replace('from "@/lib/parent/changeDeadline"',`from "${url(await readFile("src/lib/parent/changeDeadline.ts","utf8"))}"`));
const illnessRulesUrl=url((await readFile("src/lib/regular/illnessCarryRules.ts","utf8")).replace('from "@/lib/datetime/kst"',`from "${kstUrl}"`));
const illnessTxUrl=url((await readFile("src/lib/regular/illness-carry-tx.ts","utf8")).replace('from "@/lib/billing/absence-compensation-guard"',`from "${guardUrl}"`).replace('from "@/lib/makeup/absence-report-credit"',`from "${reportCreditUrl}"`).replace('from "@/lib/regular/illnessCarryRules"',`from "${illnessRulesUrl}"`));
const illnessAdminUrl=url((await readFile("src/lib/regular/illness-carry-admin.ts","utf8")).replace('from "@/lib/datetime/kst"',`from "${kstUrl}"`).replace('from "@/lib/billing/workbench"',`from "${modelUrl}"`).replace('from "@/lib/billing/workbench-service"',`from "${serviceUrl}"`).replace('from "@/lib/billing/workbench-absence"',`from "${absenceUrl}"`).replace('from "@/lib/makeup/absence-report-credit"',`from "${reportCreditUrl}"`).replace('from "@/lib/regular/illness-carry-tx"',`from "${illnessTxUrl}"`).replace('from "@/lib/regular/illnessCarryRules"',`from "${illnessRulesUrl}"`));
const {approveIllnessCarry}=await import(illnessAdminUrl);
const approve=(db,input={})=>approveIllnessCarry(db,{absenceId:"absence-a",evidenceConfirmed:true,...input},"admin",true);
// 학부모가 알린(아직 «신고» 상태인) 질병·부상 결석 — 원래 달(10월) 확정 장부 있음, 보강권 상태는 인자로
const reportedAbsence=(status="AVAILABLE")=>{const db=absenceDatabase(status);db.state.absences[0].status="REPORTED";return db;};
test("신청함 이월 승인: 신고 상태 결석을 확정하고 기존 규칙으로 적립(할인 후 수강료÷그 달 수업 횟수) + 보강권 회수 + 검토 «이월 승인»",async()=>{
 const db=reportedAbsence();
 const done=await approve(db);
 assert.deepEqual(done,{studentId:"student-a",classId:"class-a",absenceYmd:"2026-10-10"});
 assert.equal(db.state.absences[0].status,"CONFIRMED","원장이 증빙을 보고 승인 = 결석 확정");
 assert.equal(db.state.carryCredits.length,1);
 assert.deepEqual([db.state.carryCredits[0].numerator,db.state.carryCredits[0].denominator,db.state.carryCredits[0].availableMonth],["90000","4","2026-11"],"(100,000−할인 10,000)÷10월 4회 → 다음 달(11월)부터 차감");
 assert.equal(db.state.carryCredits[0].basis.eligibility,"ILLNESS_INJURY");assert.equal(db.state.carryCredits[0].basis.evidenceConfirmed,true);
 assert.equal(db.state.makeupCredits[0].status,"REVOKED","이미 나간 보강권은 회수(a7)");
 assert.deepEqual(db.state.resolutions,[{id:"absence-a",resolution:"CARRY"}]);
 assert.deepEqual(db.state.reviews,[{absenceId:"absence-a",status:"APPROVED",decidedByUserId:"admin",convertReason:null}]);
 // 다음 달 청구 준비 화면에 이월 잔액으로 잡힌다(기존 «이월 차감» 표시 재사용)
 const next=await readWorkbench(db.tx,"2026-11",true);assert.equal(next.rows[0].carryAvailable,22500);
 // 두 번 누르면 기존 규칙이 막는다(이중 적립 없음)
 await assert.rejects(()=>approve(db),/미처리 결석만/);assert.equal(db.state.carryCredits.length,1);
});
test("신청함 이월 승인: 이미 확정된 결석(기간 결석·출석부 표시)도 같은 길로 적립된다",async()=>{
 const db=absenceDatabase();await approve(db);
 assert.equal(db.state.carryCredits.length,1);assert.equal(db.state.reviews[0].status,"APPROVED");
});
test("신청함 이월 승인: 조건이 안 맞으면 기존 규칙의 사유로 거절하고 아무것도 남기지 않는다(결석 확정도 되돌림)",async()=>{
 const untouched=db=>{assert.equal(db.state.absences[0].status,"REPORTED");assert.equal(db.state.carryCredits.length,0);assert.equal(db.state.resolutions.length,0);assert.equal((db.state.reviews??[]).length,0);};
 // 증빙 확인 체크 없음 · 저장 스위치 꺼짐 — DB 를 건드리기 전에 막는다
 let db=reportedAbsence();await assert.rejects(()=>approve(db,{evidenceConfirmed:false}),/증빙을 확인했는지/);untouched(db);
 db=reportedAbsence();await assert.rejects(()=>approveIllnessCarry(db,{absenceId:"absence-a",evidenceConfirmed:true},"admin",false),/꺼져 있어/);untouched(db);
 // 아직 오지 않은 결석일
 db=reportedAbsence();db.state.absences[0].date="2099-01-03";await assert.rejects(()=>approve(db),/결석일이 지난 뒤/);untouched(db);
 // 질병·부상이 아닌 결석
 db=reportedAbsence();db.state.absences[0].reason="PERSONAL";await assert.rejects(()=>approve(db),/질병·부상 결석만/);untouched(db);
 // 이미 보강을 들은 결석 — 기존 규칙이 막고, 그 앞에서 한 «결석 확정»까지 통째로 되돌아간다
 for(const status of ["USED","NO_SHOW"]){db=reportedAbsence(status);await assert.rejects(()=>approve(db),/사용된/);untouched(db);assert.equal(db.state.makeupCredits[0].status,status);}
 // 원래 달 수강료 근거(확정 장부·발행 청구)가 없다 = 청구 발행 전
 db=reportedAbsence();db.state.registers=[];await assert.rejects(()=>approve(db),/원결석 기간/);untouched(db);
 // 보강 예약이 있으면 «함께 취소» 확인이 있어야 한다
 db=reportedAbsence("RESERVED");db.state.bookings.push({id:"booking-a",status:"BOOKED",studentId:"student-a",originalClassId:"class-a",originalDate:"2026-10-09T15:00:00Z",updatedAt:"2026-10-11"});
 await assert.rejects(()=>approve(db),/좌석 해제/);untouched(db);
 await approve(db,{cancelReservation:true});assert.equal(db.state.bookings[0].status,"CANCELLED");assert.equal(db.state.makeupCredits[0].status,"REVOKED");assert.equal(db.state.carryCredits.length,1);
});
test("청구 준비 화면에서 «보강»으로 정산하면 신청함 검토도 «보강권으로 전환»으로 맞춰진다(경조사 등 다른 사유 결석은 적지 않는다)",async()=>{
 const db=absenceDatabase();let view=await readWorkbench(db.tx,"2026-11",true);
 await resolveWorkbenchAbsence(db,{...resolveCommand(view),resolution:"MAKEUP",eligibility:"NONE",evidenceConfirmed:false},"admin",true);
 assert.deepEqual(db.state.reviews,[{absenceId:"absence-a",status:"MAKEUP",decidedByUserId:"admin",convertReason:"REJECTED"}]);
 const other=absenceDatabase();other.state.absences[0].reason="FAMILY_TRIP";view=await readWorkbench(other.tx,"2026-11",true);
 await resolveWorkbenchAbsence(other,{...resolveCommand(view),eligibility:"DIRECT_FAMILY_EVENT"},"admin",true);
 assert.equal(other.state.carryCredits.length,1);assert.equal((other.state.reviews??[]).length,0);
});
