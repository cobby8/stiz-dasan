import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const url=s=>`data:text/javascript;base64,${Buffer.from(ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText).toString('base64')}`;
export async function runBillingWorkbenchPostgresTests({pool,database,root}){
 const source=p=>readFile(path.join(root,p),'utf8'),checks=[];
 checks.push=(...values)=>{for(const value of values)console.log(`확인: ${value}`);return Array.prototype.push.apply(checks,values);};
 const modules={};for(const [key,file]of Object.entries({kst:'src/lib/datetime/kst.ts',register:'src/lib/billing/monthly-register.ts',due:'src/lib/billing-due-date.ts',visibility:'src/lib/studentVisibility.ts',schedule:'src/lib/classSchedule.ts'}))modules[key]=url(await source(file));
 modules.model=url((await source('src/lib/billing/workbench.ts')).replace('from "@/lib/datetime/kst"',`from "${modules.kst}"`));
 const calendar=url((await source('src/lib/enrollment/monthlyClassDates.ts')).replace('import { getAcademySettings, getAnnualEvents } from "@/lib/queries";','const getAcademySettings=()=>{throw Error("External query forbidden")},getAnnualEvents=getAcademySettings;').replace('import { fetchGoogleCalendarEvents } from "@/lib/googleCalendar";','const fetchGoogleCalendarEvents=()=>{throw Error("External calendar forbidden")};').replace('from "@/lib/classSchedule"',`from "${modules.schedule}"`));
 const service=url((await source('src/lib/billing/workbench-service.ts')).replaceAll('from "@/lib/enrollment/monthlyClassDates"',`from "${calendar}"`).replace('from "@/lib/billing-due-date"',`from "${modules.due}"`).replace('from "@/lib/studentVisibility"',`from "${modules.visibility}"`).replace('from "./monthly-register"',`from "${modules.register}"`).replace('from "./workbench"',`from "${modules.model}"`).replace('from "./workbench-pricing"',`from "${url(await source('src/lib/billing/workbench-pricing.ts'))}"`).replace('from "@/lib/regular/illnessPeriodRules"',`from "${url((await source('src/lib/regular/illnessPeriodRules.ts')).replace('from "@/lib/datetime/kst"',`from "${modules.kst}"`))}"`));
 const {readWorkbench,mutateWorkbench}=await import(service);
 const {resolveWorkbenchAbsence}=await import(url((await source('src/lib/billing/workbench-absence.ts')).replace('from "./carryEvidence"',`from "${url(await source('src/lib/billing/carryEvidence.ts'))}"`).replace('from "@/lib/studentVisibility"',`from "${modules.visibility}"`).replace('from "./monthly-register"',`from "${modules.register}"`).replace('from "./workbench"',`from "${modules.model}"`).replace('from "./workbench-service"',`from "${service}"`).replace('import("@/lib/enrollment/monthlyClassDates")',`import("${calendar}")`)));
 await pool.query(`CREATE TABLE "Student"(id text PRIMARY KEY,name text,"parentId" text,"mergedIntoStudentId" text,"birthDate" timestamp);
 CREATE TABLE "Program"(id text PRIMARY KEY,price integer,"updatedAt" timestamp DEFAULT NOW(),name text,"priceWeek1" integer,"priceWeek2" integer,"priceWeek3" integer,"priceDaily" integer,"runsShuttle" boolean DEFAULT true,"shuttleFeeOverride" integer);CREATE TABLE "Class"(id text PRIMARY KEY,name text,"programId" text,"dayOfWeek" text,"updatedAt" timestamp DEFAULT NOW(),"slotKey" text);
 CREATE TABLE "Enrollment"(id text PRIMARY KEY,"studentId" text,"classId" text,status text,"createdAt" timestamp,"updatedAt" timestamp,"startsOn" date);
 CREATE TABLE "Payment"(id text PRIMARY KEY,"studentId" text,"classId" text,amount integer,status text,"dueDate" timestamp,type text,description text,year integer,month integer,"invoiceNo" text UNIQUE,"issuedAt" timestamp,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "PaymentInvoice"(id text PRIMARY KEY,"paymentId" text REFERENCES "Payment"(id),"studentId" text,"classId" text,"parentId" text,"invoiceNo" text UNIQUE,status text,amount integer,title text,description text,"dueDate" timestamp,"issuedAt" timestamp,"createdAt" timestamp,"updatedAt" timestamp);
 CREATE TABLE "MonthlyEnrollmentRegister"("studentId" text,month text,status text,payload jsonb,version integer);
 CREATE TABLE "AnnualEvent"(id text PRIMARY KEY,title text,date timestamp,"endDate" timestamp,"updatedAt" timestamp DEFAULT NOW());
 CREATE TABLE "RegularAbsence"(id text PRIMARY KEY,"studentId" text,"classId" text,date date,reason text,status text);
 CREATE TABLE "Session"(id text PRIMARY KEY,"classId" text,date timestamp);CREATE TABLE "Attendance"(id text PRIMARY KEY,"studentId" text,"sessionId" text,status text,"updatedAt" timestamp);
 CREATE TABLE "MakeupCredit"(id text PRIMARY KEY,"studentId" text,"sourceKey" text,status text,"updatedAt" timestamp,"makeupSessionId" text);
 CREATE TABLE "MakeupSession"(id text PRIMARY KEY,"studentId" text,"originalClassId" text,"originalDate" timestamp,status text,"updatedAt" timestamp);
 CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;`);
 await pool.query(await source('src/lib/billing/workbench-schema.sql'));
 checks.push('원본 서비스 SQL·신규 6개 테이블 실제 생성');
 await pool.query(`INSERT INTO "Student" VALUES('s1','합성 원생',NULL,NULL),('s2','합성 원생2',NULL,NULL);INSERT INTO "Program" VALUES('p',100000);INSERT INTO "Class" VALUES('c','합성 토요반','p','Sat');INSERT INTO "Enrollment" VALUES('e','s1','c','ACTIVE','2026-01-01','2026-01-01'),('e2','s2','c','ACTIVE','2026-01-01','2026-01-01');INSERT INTO "AnnualEvent" VALUES('oct-open','10월 개강','2026-10-03',NULL),('oct-close','10월 종강','2026-10-24',NULL),('nov-open','11월 개강','2026-11-07',NULL),('nov-close','11월 종강','2026-11-28',NULL);INSERT INTO "RegularAbsence" VALUES('a','s1','c','2026-10-10','ILLNESS_INJURY','CONFIRMED'),('used','s2','c','2026-10-10','ILLNESS_INJURY','CONFIRMED');INSERT INTO "MakeupCredit"(id,"studentId","sourceKey",status,"updatedAt") VALUES('mc','s1','REGULAR:c:2026-10-10','RESERVED',NOW()),('used-mc','s2','REGULAR:c:2026-10-10','USED',NOW());INSERT INTO "MakeupSession" VALUES('ms','s1','c','2026-10-10 09:00','BOOKED',NOW());`);
 const reg={studentId:'s1',month:'2026-10',classes:[{classId:'c',status:'ACTIVE',periodStart:'2026-10-03',periodEnd:'2026-10-24',baseAmount:100000,discountAmount:10000,prorationAmount:0,carryAmount:0,basis:'합성 확정 근거'}],shuttleAmount:20000,shuttleBasis:'합성 셔틀',reason:'합성 확정'};
 await pool.query('INSERT INTO "MonthlyEnrollmentRegister" VALUES($1,$2,$3,$4::jsonb,1)',['s1','2026-10','CONFIRMED',JSON.stringify(reg)]);
 const view=()=>database.$transaction(tx=>readWorkbench(tx,'2026-11',true),{isolationLevel:'RepeatableRead'});
 let v=await view();assert.equal(v.rows[0].scheduledDates.length,4);checks.push('실제 연간 일정 계산·학생 조회');
 let sequence=0;const absence=(id,version)=>({action:'RESOLVE_ABSENCE',month:'2026-11',sourceVersion:version,requestId:`absence-${++sequence}`,absenceId:id,resolution:'CARRY',evidenceConfirmed:true,eligibility:'ILLNESS_INJURY',reason:'합성 인정',cancelReservation:false,originMonth:'2026-10'});
 await assert.rejects(resolveWorkbenchAbsence(database,absence('a',v.sourceVersion),'admin',true),/예약 취소/,'reserved cancellation gate');
 await assert.rejects(resolveWorkbenchAbsence(database,absence('used',v.sourceVersion),'admin',true),/사용된/,'used makeup gate');
 const resolved=await resolveWorkbenchAbsence(database,{...absence('a',v.sourceVersion),cancelReservation:true},'admin',true);v=resolved.view;
 assert.equal(v.rows.find(r=>r.studentId==='s1').carryAvailable,22500);assert.equal((await pool.query('SELECT status FROM "MakeupCredit" WHERE id=\'mc\'')).rows[0].status,'REVOKED');assert.equal((await pool.query('SELECT status FROM "MakeupSession" WHERE id=\'ms\'')).rows[0].status,'CANCELLED');checks.push('할인 후 이월 22500원·보강 예약 해제·보강권 회수·사용 건 차단');
 const guard=await import(url(await source('src/lib/billing/absence-compensation-guard.ts')));
 for(const [label,operation] of [['regular',tx=>guard.assertRegularMakeupAllowed(tx,{studentId:'s1',classId:'c',dateYmd:'2026-10-10'})],['session',tx=>guard.assertMakeupSessionAllowed(tx,'ms')],['absence',tx=>guard.assertAbsenceCompensationEditable(tx,'a')]])await assert.rejects(database.$transaction(operation,{isolationLevel:'Serializable'}),/이월로 정산/,label);
 checks.push('이월 후 기존 보강 재발급·예약·결석 변경 세 입구 차단');
 const cmd=(action,view,ids=['s1:c'],overrides={})=>({action,month:view.month,sourceVersion:view.sourceVersion,requestId:`pg-request-${++sequence}`,rows:ids.map(id=>{const r=view.rows.find(r=>r.id===id);return {id,expectedVersion:r.version,...(action==='SAVE'?{baseAmount:r.baseAmount,discountAmount:r.discountAmount,prorationAmount:r.prorationAmount,carryAmount:r.carryAmount,shuttleAmount:r.shuttleAmount,reason:'합성 검토',...overrides}:{})};})});
 await assert.rejects(mutateWorkbench(database,cmd('SAVE',v),'',true),/관리자/);await assert.rejects(mutateWorkbench(database,cmd('SAVE',v),'admin',false),/잠겨/);checks.push('미승인 쓰기·빈 관리자 차단');
 const stale=cmd('SAVE',v);await pool.query('UPDATE "Program" SET price=100001');await assert.rejects(mutateWorkbench(database,stale,'admin',true),/변경/,'source version gate');await pool.query('UPDATE "Program" SET price=100000');v=await view();checks.push('원본 변경시 이전 검토 저장 차단');
 v=(await mutateWorkbench(database,cmd('SAVE',v),'admin',true)).view;assert.equal(v.rows.find(r=>r.id==='s1:c').draftStatus,'DRAFT');
 v=(await mutateWorkbench(database,cmd('CONFIRM',v),'admin',true)).view;
 const issue=cmd('ISSUE',v),issued=await mutateWorkbench(database,issue,'admin',true);const retried=await mutateWorkbench(database,issue,'admin',true);assert.deepEqual(retried.operationResult,issued.operationResult);
 assert.equal(Number((await pool.query('SELECT count(*) FROM "Payment"')).rows[0].count),1);assert.equal(Number((await pool.query('SELECT count(*) FROM "PaymentInvoice"')).rows[0].count),1);const usage=(await pool.query('SELECT amount,"sourceCreditIds",basis FROM "BillingCarryUsage"')).rows[0];assert.equal(usage.amount,22500);assert.equal(usage.sourceCreditIds.length,1);assert.ok(usage.basis);assert.equal(issued.view.rows.find(r=>r.id==='s1:c').carryAvailable,0);checks.push('저장→확정→실청구 SQL·원적립 연결 이월 22500원 소진·응답 유실 재시도 중복 방지');
 v=await view();v=(await mutateWorkbench(database,cmd('SAVE',v,['s2:c'],{baseAmount:0,carryAmount:0}),'admin',true)).view;v=(await mutateWorkbench(database,cmd('CONFIRM',v,['s2:c']),'admin',true)).view;
 const zero=await mutateWorkbench(database,cmd('ISSUE',v,['s2:c']),'admin',true);assert.equal(zero.operationResult.zeroCount,1);assert.equal(Number((await pool.query('SELECT count(*) FROM "Payment"')).rows[0].count),1);checks.push('0원 발행 결과 보존·유상 청구 생성 제외');
 for(const role of ['anon','authenticated']){const c=await pool.connect();try{await c.query('BEGIN');await c.query(`SET LOCAL ROLE ${role}`);await assert.rejects(c.query('SELECT * FROM "BillingCarryCredit"'),e=>e.code==='42501');}finally{await c.query('ROLLBACK');c.release();}}checks.push('공개·인증 일반 역할 신규 정산표 접근 거부');
 await pool.query(`INSERT INTO "AnnualEvent" VALUES('dec-open','12월 개강','2026-12-05',NULL),('dec-close','12월 종강','2026-12-26',NULL)`);
 let december=await database.$transaction(tx=>readWorkbench(tx,'2026-12',true),{isolationLevel:'RepeatableRead'});
 const attempts=await Promise.allSettled([mutateWorkbench(database,cmd('SAVE',december,['s1:c'],{carryAmount:0}),'admin',true),mutateWorkbench(database,cmd('SAVE',december,['s1:c'],{carryAmount:0}),'admin',true)]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.filter(r=>r.status==='rejected').length,1);assert.equal((await pool.query('SELECT version FROM "BillingWorkbenchDraft" WHERE month=\'2026-12\' AND id=\'s1:c\'')).rows[0].version,1);checks.push('실제 두 연결 동시 저장 중 하나만 반영');
 december=await database.$transaction(tx=>readWorkbench(tx,'2026-12',true),{isolationLevel:'RepeatableRead'});december=(await mutateWorkbench(database,cmd('CONFIRM',december),'admin',true)).view;
 await pool.query(`CREATE FUNCTION fail_test_invoice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic invoice failure'; END $$;CREATE TRIGGER fail_invoice BEFORE INSERT ON "PaymentInvoice" FOR EACH ROW EXECUTE FUNCTION fail_test_invoice();`);
 const failedIssue=cmd('ISSUE',december);await assert.rejects(mutateWorkbench(database,failedIssue,'admin',true),/synthetic invoice failure/);
 assert.equal(Number((await pool.query('SELECT count(*) FROM "Payment" WHERE month=12')).rows[0].count),0);assert.equal((await pool.query('SELECT status FROM "BillingWorkbenchDraft" WHERE month=\'2026-12\' AND id=\'s1:c\'')).rows[0].status,'CONFIRMED');checks.push('청구서 INSERT 실패시 Payment·작업기록·확정 상태 전체 롤백');
 await pool.query('DROP TRIGGER fail_invoice ON "PaymentInvoice";DROP FUNCTION fail_test_invoice()');const recovered=await mutateWorkbench(database,failedIssue,'admin',true);assert.equal(recovered.operationResult.paymentIds.length,1);checks.push('실패 후 같은 요청으로 재조회·발행 복구');
 await pool.query(`CREATE TABLE "User"(id text PRIMARY KEY,name text,role text,email text UNIQUE,"authUserId" text,"withdrawnAt" timestamp,"withdrawRequestedAt" timestamp,username text,"phoneVerifiedAt" timestamp);INSERT INTO "User" VALUES('admin','합성 관리자','ADMIN','admin@fixture.invalid'),('parent','합성 부모','PARENT','parent@fixture.invalid'),('staff','합성 선생님','INSTRUCTOR','staff@fixture.invalid'),('driver','합성 기사','DRIVER','driver@fixture.invalid');CREATE TABLE "AcademySettings"(id text PRIMARY KEY,"googleCalendarIcsUrl" text);INSERT INTO "AcademySettings" VALUES('singleton',NULL)`);
 let identity=null,enabled=false;
 const authProvider={createClient:async()=>({auth:{getClaims:async()=>identity?{data:{claims:{sub:identity.id,email:identity.email,user_metadata:{role:'ADMIN'}}},error:null}:{data:null,error:new Error('합성 미인증')},getUser:async()=>({data:{user:identity},error:identity?null:new Error('합성 미인증')})}})};
 const isolatedDb={...database,$queryRawUnsafe:async(sql,...values)=>(await pool.query(sql,values)).rows};
 const load=async(file,dependencies)=>{const exports={};const code=ts.transpileModule(await source(file),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;vm.compileFunction(code,['require','exports','process'],{filename:file})(key=>{if(!Object.hasOwn(dependencies,key))throw Error(`Disallowed dependency ${key}`);return dependencies[key];},exports,{env:{get STIZ_BILLING_WORKBENCH_WRITES_ENABLED(){return enabled?'true':'false';}}});return exports;};
 const auth=await load('src/lib/auth-guard.ts',{'react':{cache:fn=>fn},'@/lib/account/child-access':await load('src/lib/account/child-access.ts',{'@/lib/prisma':{prisma:isolatedDb}}),'@/lib/account/roles':await load('src/lib/account/roles.ts',{}),'@/lib/supabase/server':authProvider,'@/lib/prisma':{prisma:isolatedDb}}),next=createRequire(import.meta.url)('next/server');
 const calendarModule=await load('src/lib/billing/workbench-calendar.ts',{'node:crypto':createRequire(import.meta.url)('node:crypto'),'@/lib/enrollment/monthlyClassDates':await import(calendar),'@/lib/prisma':{prisma:isolatedDb},'./workbench':await import(modules.model)});
 const route=await load('src/app/api/admin/billing-workbench/route.ts',{'next/server':next,'@/lib/auth-guard':auth,'@/lib/prisma':{prisma:isolatedDb},'@/lib/billing/workbench':await import(modules.model),'@/lib/billing/workbench-service':{readWorkbench,mutateWorkbench},'@/lib/billing/workbench-absence':{resolveWorkbenchAbsence},'@/lib/billing/workbench-calendar':calendarModule});
 for(const role of [null,'parent','staff','driver']){identity=role?{id:role,email:`${role}@fixture.invalid`}:null;for(const method of ['GET','POST'])assert.equal((await route[method](new next.NextRequest('http://localhost/api/admin/billing-workbench?month=2026-11',{method,...(method==='POST'?{headers:{origin:'http://localhost','content-type':'application/json'},body:'{}'}:{})}))).status,403);}
 identity={id:'admin',email:'admin@fixture.invalid'};assert.equal((await route.GET(new next.NextRequest('http://localhost/api/admin/billing-workbench?month=2026-11'))).status,200);
 assert.equal((await route.POST(new next.NextRequest('http://localhost/api/admin/billing-workbench',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:'{}'}))).status,503);enabled=true;
 assert.equal((await route.POST(new next.NextRequest('http://localhost/api/admin/billing-workbench',{method:'POST',headers:{origin:'https://wrong.invalid','content-type':'application/json'},body:'{}'}))).status,403);checks.push('실제 API→requireAdmin→합성 인증→실DB: 익명·부모·교사·기사 거부, 관리자 조회·쓰기 잠금·외부 출처 차단');
 await pool.query(`INSERT INTO "RegularAbsence" VALUES('fraction-a','s2','c','2026-10-11','ILLNESS_INJURY','CONFIRMED'),('fraction-b','s2','c','2026-10-12','ILLNESS_INJURY','CONFIRMED');INSERT INTO "BillingCarryCredit"(id,"studentId","absenceId",numerator,denominator,"availableMonth",basis,"actorUserId") VALUES('fraction-credit-a','s2','fraction-a',450001,3,'2026-11','{}','fixture'),('fraction-credit-b','s2','fraction-b',1,3,'2026-11','{}','fixture');INSERT INTO "AnnualEvent" VALUES('jan-open','1월 개강','2027-01-02',NULL),('jan-close','1월 종강','2027-01-23',NULL);`);
 let fractional=await database.$transaction(tx=>readWorkbench(tx,'2026-12',true),{isolationLevel:'RepeatableRead'});assert.equal(fractional.rows.find(r=>r.id==='s2:c').carryAvailable,150001);
 fractional=(await mutateWorkbench(database,cmd('SAVE',fractional,['s2:c']),'admin',true)).view;fractional=(await mutateWorkbench(database,cmd('CONFIRM',fractional,['s2:c']),'admin',true)).view;fractional=(await mutateWorkbench(database,cmd('ISSUE',fractional,['s2:c']),'admin',true)).view;assert.equal(fractional.rows.find(r=>r.id==='s2:c').carryAvailable,50001);
 let january=await database.$transaction(tx=>readWorkbench(tx,'2027-01',true),{isolationLevel:'RepeatableRead'});assert.equal(january.rows.find(r=>r.id==='s2:c').carryAmount,50001);january=(await mutateWorkbench(database,cmd('SAVE',january,['s2:c']),'admin',true)).view;january=(await mutateWorkbench(database,cmd('CONFIRM',january,['s2:c']),'admin',true)).view;const finalCarry=await mutateWorkbench(database,cmd('ISSUE',january,['s2:c']),'admin',true);assert.equal(finalCarry.view.rows.find(r=>r.id==='s2:c').carryAvailable,0);assert.equal((await pool.query('SELECT amount FROM "Payment" WHERE id=$1',[finalCarry.operationResult.paymentIds[0]])).rows[0].amount,49999);checks.push('분수 이월 합계 반올림150001원·초과잔액50001원 다음기간 보존·실차감 소진');
 await pool.query('UPDATE "Payment" SET status=\'CANCELLED\' WHERE id=$1',[issued.operationResult.paymentIds[0]]);
 let cancelled=await database.$transaction(tx=>readWorkbench(tx,'2027-01',true),{isolationLevel:'RepeatableRead'});assert.ok(cancelled.rows.find(r=>r.id==='s1:c').blockingReasons.some(reason=>reason.includes('취소')));cancelled=(await mutateWorkbench(database,cmd('SAVE',cancelled,['s1:c'],{carryAmount:0}),'admin',true)).view;await assert.rejects(mutateWorkbench(database,cmd('CONFIRM',cancelled,['s1:c']),'admin',true),/취소/);checks.push('이월 사용 청구 취소시 새 청구 확정 차단·임의 잔액 복원 금지');
 await pool.query(`INSERT INTO "Student" VALUES('s3','합성 구형 월중 원생',NULL,NULL),('s4','합성 신규 월중 원생',NULL,NULL);INSERT INTO "Enrollment" VALUES('e3','s3','c','ACTIVE','2026-01-01','2026-01-01'),('e4','s4','c','ACTIVE','2026-01-01','2026-01-01');INSERT INTO "RegularAbsence" VALUES('legacy-proration','s3','c','2026-10-17','ILLNESS_INJURY','CONFIRMED'),('snapshot-proration','s4','c','2026-10-17','ILLNESS_INJURY','CONFIRMED');INSERT INTO "Payment"(id,"studentId","classId",amount,status,type,year,month,"invoiceNo","updatedAt") VALUES('legacy-proration-payment','s3','c',50000,'PENDING','MONTHLY',2026,10,'LEGACY-PRORATION',NOW());INSERT INTO "PaymentInvoice"(id,"paymentId","studentId","classId","invoiceNo",status,amount,"updatedAt") VALUES('legacy-proration-invoice','legacy-proration-payment','s3','c','LEGACY-PRORATION','ISSUED',50000,NOW());`);
 const partial={baseAmount:100000,discountAmount:0,prorationAmount:50000,carryAmount:0,shuttleAmount:0};
 await pool.query('INSERT INTO "BillingWorkbenchDraft"(id,month,"studentId","classId",version,status,payload,reason,"sourceVersion","paymentId","actorUserId") VALUES($1,$2,$3,$4,1,\'ISSUED\',$5::jsonb,\'구형 합성 근거\',\'legacy\',$6,\'fixture\')',['s3:c','2026-10','s3','c',JSON.stringify(partial),'legacy-proration-payment']);
 let origin=await database.$transaction(tx=>readWorkbench(tx,'2026-10',true),{isolationLevel:'RepeatableRead'});
 origin=(await mutateWorkbench(database,cmd('SAVE',origin,['s4:c'],{...partial,periodStart:'2026-10-17',periodEnd:'2026-10-24'}),'admin',true)).view;origin=(await mutateWorkbench(database,cmd('CONFIRM',origin,['s4:c']),'admin',true)).view;await mutateWorkbench(database,cmd('ISSUE',origin,['s4:c']),'admin',true);
 const partialDraft=(await pool.query('SELECT "periodStart","periodEnd","scheduledDates","calculationBasis" FROM "BillingWorkbenchDraft" WHERE id=\'s4:c\' AND month=\'2026-10\'')).rows[0];assert.equal(partialDraft.periodStart,'2026-10-17');assert.equal(partialDraft.periodEnd,'2026-10-24');assert.deepEqual(partialDraft.scheduledDates,['2026-10-17','2026-10-24']);assert.ok(partialDraft.calculationBasis);
 let november=await view();await assert.rejects(resolveWorkbenchAbsence(database,absence('legacy-proration',november.sourceVersion),'admin',true),/실제 수강 기간 근거/);checks.push('구형 월중 발행에 기간 근거 없으면 전체월 분모로 추측 이월 차단');
 november=(await resolveWorkbenchAbsence(database,absence('snapshot-proration',november.sourceVersion),'admin',true)).view;assert.equal(november.rows.find(r=>r.id==='s4:c').carryAvailable,25000);const partialCredit=(await pool.query('SELECT numerator::text,denominator::text,basis FROM "BillingCarryCredit" WHERE "absenceId"=\'snapshot-proration\'')).rows[0];assert.equal(partialCredit.numerator,'50000');assert.equal(partialCredit.denominator,'2');assert.deepEqual(partialCredit.basis.scheduledDates,['2026-10-17','2026-10-24']);checks.push('실제 SAVE 기간 입력→발행 근거 보존→50000원 2회 분모로 25000원 이월');
 await pool.query(`INSERT INTO "AnnualEvent" VALUES('late-holiday','학원 휴무','2026-10-24',NULL)`);november=await view();assert.ok(november.rows.find(r=>r.id==='s4:c').blockingReasons.some(reason=>reason.includes('이월')));november=(await mutateWorkbench(database,cmd('SAVE',november,['s4:c'],{carryAmount:0}),'admin',true)).view;await assert.rejects(mutateWorkbench(database,cmd('CONFIRM',november,['s4:c']),'admin',true),/이월/);checks.push('이월 적립 후 원기간 휴강 변경시 새 저장으로 우회 확정 불가');
 const dbCalendar=await calendarModule.loadWorkbenchCalendar(true);assert.equal(dbCalendar.kind,'DB');
 const withCalendar=await database.$transaction(tx=>readWorkbench(tx,'2026-11',true,dbCalendar),{isolationLevel:'RepeatableRead'});
 const changedCalendar=calendarModule.createWorkbenchCalendarSnapshot({kind:'DB_AND_ICS',events:[...dbCalendar.events,{title:'학원 휴무',date:'2026-11-14T00:00:00.000Z'}]});
 const changedView=await database.$transaction(tx=>readWorkbench(tx,'2026-11',true,changedCalendar),{isolationLevel:'RepeatableRead'});assert.equal(changedView.calendarSource,'DB_AND_ICS');assert.ok(!changedView.rows.find(r=>r.id==='s3:c').scheduledDates.includes('2026-11-14'));assert.notEqual(changedView.sourceVersion,withCalendar.sourceVersion);await assert.rejects(mutateWorkbench(database,cmd('SAVE',withCalendar,['s3:c']),'admin',true,changedCalendar),/변경/);checks.push('실제 공식 일정 로더·실DB 조회 연결 및 합성 외부일정 변경시 이전 검토 저장 차단');
 await pool.query(`UPDATE "AcademySettings" SET "googleCalendarIcsUrl"='https://fixture.invalid/never-fetched.ics'`);const failedCalendarResponse=await route.GET(new next.NextRequest('http://localhost/api/admin/billing-workbench?month=2026-11'));assert.equal(failedCalendarResponse.status,503);assert.match((await failedCalendarResponse.json()).error,/공식 일정/);await pool.query('UPDATE "AcademySettings" SET "googleCalendarIcsUrl"=NULL');checks.push('설정된 외부 일정 조회 실패는 503으로 차단·DB 일정만으로 임의 계산하지 않음 (외부 호출은 격리 스텁)');
 // ── 납부 Payment 근거(2026-11-15): 발행 초안·확정 장부가 없는 달(랠리즈 이관)도 납부완료 청구 1건이면 이월한다 ──
 // 이 시점 10월 수업일은 3회(10/24 휴무 추가됨). 휴원 정산 표·셔틀 명단 표도 실제로 만들어 새 SQL 을 전부 지난다.
 await pool.query(`CREATE TABLE "EnrollmentChangeRequest"(id text PRIMARY KEY,"studentId" text,"fromClassId" text,status text);
 CREATE TABLE "EnrollmentChangeSettlement"(id text PRIMARY KEY,"requestId" text REFERENCES "EnrollmentChangeRequest"(id),"studentId" text);
 CREATE TABLE "EnrollmentChangeSettlementLine"(id text PRIMARY KEY,"settlementId" text REFERENCES "EnrollmentChangeSettlement"(id),"paymentId" text,kind text,channel text,amount integer,status text,"missedDates" jsonb NOT NULL DEFAULT '[]'::jsonb);
 CREATE TABLE "RegularShuttleStop"(id text PRIMARY KEY,"serviceMonth" text,"studentId" text,"studentName" text,direction text,"stopName" text);
 INSERT INTO "Student" VALUES('s5','합성 이관 원생',NULL,NULL);INSERT INTO "Enrollment" VALUES('e5','s5','c','ACTIVE','2026-01-01','2026-01-01');
 INSERT INTO "RegularAbsence" VALUES('paid-evidence','s5','c','2026-10-10','ILLNESS_INJURY','CONFIRMED');
 INSERT INTO "Payment"(id,"studentId","classId",amount,status,type,year,month,"invoiceNo","updatedAt") VALUES('rallyz-oct','s5','c',90000,'PAID','MONTHLY',2026,10,'RALLYZ-OCT',NOW()),('rallyz-oct-canceled','s5','c',1,'CANCELED','MONTHLY',2026,10,'RALLYZ-OCT-X',NOW());
 INSERT INTO "EnrollmentChangeRequest" VALUES('pause-1','s5','c','APPROVED');INSERT INTO "EnrollmentChangeSettlement" VALUES('settle-1','pause-1','s5');
 INSERT INTO "EnrollmentChangeSettlementLine" VALUES('line-1','settle-1','rallyz-oct','UNPAID_REDUCE','SITE',15000,'DONE','["2026-10-10"]'),('line-2','settle-1','rallyz-oct','UNPAID_REDUCE','RALLYZ',7000,'TODO','[]'),('line-3','settle-1','rallyz-oct','REFUND','TOSS',5000,'DONE','[]');
 INSERT INTO "RegularShuttleStop" VALUES('stop-1','2026-10','s5','합성 이관 원생','BOARD','합성 정류장');`);
 november=await view();
 await assert.rejects(resolveWorkbenchAbsence(database,absence('paid-evidence',november.sourceVersion),'admin',true),/휴원 정산에서 처리한 날/);checks.push('휴원 정산이 처리한 날은 이월 적립 거절(missedDates jsonb 포함 검사 실제 실행)');
 await pool.query(`UPDATE "EnrollmentChangeRequest" SET status='CANCELED' WHERE id='pause-1'`);november=await view();
 november=(await resolveWorkbenchAbsence(database,absence('paid-evidence',november.sourceVersion),'admin',true)).view;
 const paidCredit=(await pool.query('SELECT numerator::text,denominator::text,"availableMonth",basis FROM "BillingCarryCredit" WHERE "absenceId"=\'paid-evidence\'')).rows[0];
 assert.deepEqual([paidCredit.numerator,paidCredit.denominator,paidCredit.availableMonth],['105000','3','2026-11']);
 assert.deepEqual([paidCredit.basis.source,paidCredit.basis.sourcePaymentId,paidCredit.basis.paymentAmount,paidCredit.basis.priorReduction],['PAID_PAYMENT','rallyz-oct',90000,15000]);
 assert.deepEqual(paidCredit.basis.warnings,['셔틀비가 포함된 금액일 수 있어요.']);
 const paidRow=november.rows.find(r=>r.id==='s5:c');assert.equal(paidRow.carryAvailable,35000);assert.deepEqual(paidRow.blockingReasons,[]);
 checks.push('납부완료 청구 1건 근거 적립(90000+사이트 감액 15000)÷3회=35000원 · 취소 청구·랠리즈 할 일 줄·환불 줄 제외 · readWorkbench 유효 · 셔틀 경고');
 november=(await mutateWorkbench(database,cmd('SAVE',november,['s5:c']),'admin',true)).view;november=(await mutateWorkbench(database,cmd('CONFIRM',november,['s5:c']),'admin',true)).view;
 const paidIssue=await mutateWorkbench(database,cmd('ISSUE',november,['s5:c']),'admin',true);
 assert.equal((await pool.query('SELECT amount FROM "Payment" WHERE id=$1',[paidIssue.operationResult.paymentIds[0]])).rows[0].amount,65000);assert.equal(paidIssue.view.rows.find(r=>r.id==='s5:c').carryAvailable,0);
 checks.push('납부 근거 이월이 있는 학생의 저장→확정→발행이 막히지 않고 35000원 한 번만 차감(100000→65000)');
 await pool.query(`UPDATE "Payment" SET status='REFUNDED' WHERE id='rallyz-oct'`);
 const refunded=await database.$transaction(tx=>readWorkbench(tx,'2026-12',true),{isolationLevel:'RepeatableRead'});
 assert.ok(refunded.rows.find(r=>r.id==='s5:c').blockingReasons.some(reason=>reason.includes('원결석 취소·출석 정정된 이월')));checks.push('근거 청구 환불 뒤 그 이월 무효 → 그 학생 후속 발행 보류');

 // ── 부상·질병 기간 결석 «청구 발행 보류»(2단계, 2026-11-15) — 실제 PostgreSQL 로 SQL 을 돌린다 ──
 // 흐름: 1월 청구 발행(미납) → 부상 결석 승인 → 미리보기 → 결제 진행 중이면 건너뜀 → 보류로 돌리기 → 청구 준비가 막음
 //       → 승인 취소 → 다시 저장·확정·발행 → 살아 있는 청구는 정확히 1건
 const {loadTsModule}=await import('./_ts-module.mjs');
 const periodAdmin=await loadTsModule('src/lib/regular/illness-period-admin.ts');
 await pool.query(`ALTER TABLE "Payment" ADD COLUMN method text, ADD COLUMN "paidDate" timestamp;ALTER TABLE "PaymentInvoice" ADD COLUMN "canceledAt" timestamp;
 CREATE TABLE "PaymentAuditLog"(id text PRIMARY KEY,"paymentId" text,"invoiceId" text,"transactionId" text,"actorType" text NOT NULL,"actorId" text,action text NOT NULL,message text,metadata jsonb,"createdAt" timestamptz NOT NULL DEFAULT now());
 CREATE TABLE "PaymentTransaction"(id text PRIMARY KEY,"paymentId" text,provider text,status text,method text,"rawResponse" jsonb,"approvedAt" timestamptz,"updatedAt" timestamptz NOT NULL DEFAULT now());
 CREATE TABLE "PaymentTransactionItem"(id text PRIMARY KEY,"transactionId" text,"paymentId" text,amount integer);
 CREATE TABLE "PosChargeRequest"(id text PRIMARY KEY,"paymentId" text,status text);CREATE TABLE "PosChargeRequestItem"(id text PRIMARY KEY,"paymentId" text,"open" boolean);
 CREATE TABLE "OperationsAuditLog"(id text PRIMARY KEY,action text,"actorType" text,"actorUserId" text,"detailsJson" jsonb,"createdAt" timestamptz DEFAULT now());
 CREATE TABLE "RegularAbsencePeriod"(id text PRIMARY KEY,"studentId" text NOT NULL,reason text NOT NULL,"startDate" date NOT NULL,"returnDate" date,note text,status text NOT NULL DEFAULT 'ACTIVE',"classIds" text[] NOT NULL DEFAULT ARRAY[]::text[],"reportedByUserId" text,
   "carryState" text NOT NULL DEFAULT 'NONE',"carryApprovedAt" timestamptz,"carryApprovedByUserId" text,"carrySettledAt" timestamptz,"carrySettledByUserId" text,"carrySettlement" jsonb,"createdAt" timestamptz DEFAULT now(),"updatedAt" timestamptz DEFAULT now());
 ALTER TABLE "RegularAbsence" ADD COLUMN "periodId" text;
 INSERT INTO "Student" VALUES('s6','합성 부상 원생',NULL,NULL);INSERT INTO "Class" VALUES('h','합성 보류반','p','Sat');INSERT INTO "Enrollment" VALUES('e6','s6','h','ACTIVE','2026-01-01','2026-01-01');`);
 const holdMonthView=()=>database.$transaction(tx=>readWorkbench(tx,'2027-01',true),{isolationLevel:'RepeatableRead'});
 const holdRead=()=>database.$transaction(tx=>periodAdmin.readIllnessPeriodBillingHold(tx,'hold-period',Date.now()),{isolationLevel:'RepeatableRead'});
 // 기간 표가 생겼지만 보류가 없으면 지문·행이 그대로다(표가 없던 때와 같은 지문인지는 보류 0건 = 키 없음으로 보장)
 let jan=await holdMonthView();assert.ok(!jan.rows.some(r=>r.hold));
 jan=(await mutateWorkbench(database,cmd('SAVE',jan,['s6:h']),'admin',true)).view;jan=(await mutateWorkbench(database,cmd('CONFIRM',jan,['s6:h']),'admin',true)).view;
 const firstIssue=await mutateWorkbench(database,cmd('ISSUE',jan,['s6:h']),'admin',true);const heldPaymentId=firstIssue.operationResult.paymentIds[0];assert.ok(heldPaymentId);
 const beforeHoldVersion=(await holdMonthView()).sourceVersion;
 await pool.query(`INSERT INTO "RegularAbsencePeriod"(id,"studentId",reason,"startDate",status,"carryState","carryApprovedAt","carryApprovedByUserId","carrySettlement") VALUES('hold-period','s6','ILLNESS_INJURY','2026-12-20','ACTIVE','APPROVED',now(),'admin','{"approval":{"revokedCreditIds":[],"createdReviewAbsenceIds":["kept"]}}'::jsonb)`);
 jan=await holdMonthView();assert.notEqual(jan.sourceVersion,beforeHoldVersion);
 // 이미 발행된 행은 «발행됨» 그대로(보류 글자를 붙이지 않는다) — 보류는 새로 발행될 행만 막는다
 assert.equal(jan.rows.find(r=>r.id==='s6:h').status,'ISSUED');assert.ok(!jan.rows.find(r=>r.id==='s6:h').hold);
 let holdView=await holdRead();assert.equal(holdView.holdActive,true);assert.deepEqual(holdView.bills.map(b=>[b.paymentId,b.month,b.className,b.amount,b.skip]),[[heldPaymentId,1,'합성 보류반',100000,null]]);
 checks.push('보류 미리보기: 기간 시작 달 이후의 발행된 미납 청구 1건(실제 SQL — 랠리즈 사본 제외·현장 결제·결제 거래·이월 사용·휴원 정산 조건 포함)');
 // 보류 판정 조각 자체를 실제로 돌린다 — 학부모 결제 화면(학생 단위)·학생 상세(기간 단위)·신청함 상태식이 같은 조각을 쓴다
 const periodRules=await loadTsModule('src/lib/regular/illnessPeriodRules.ts');
 assert.deepEqual((await pool.query(`SELECT s.id FROM "Student" s WHERE ${periodRules.illnessBillingHoldSql('s')} ORDER BY s.id`)).rows.map(r=>r.id),['s6']);
 assert.equal((await pool.query(`SELECT ${periodRules.illnessHoldPeriodSql('p')} AS hold FROM "RegularAbsencePeriod" p WHERE p.id='hold-period'`)).rows[0].hold,true);
 assert.equal((await pool.query(`SELECT CASE WHEN ${periodRules.illnessHoldPeriodSql('x')} THEN '${periodRules.PERIOD_HOLD_INBOX_STATUS}' WHEN x."carryState" <> 'NONE' THEN x."carryState" ELSE 'PENDING' END AS raw FROM "RegularAbsencePeriod" x WHERE x.id='hold-period'`)).rows[0].raw,'APPROVED_HOLD');
 assert.equal(await database.$transaction(tx=>periodAdmin.readStudentName(tx,'s6'),{isolationLevel:'RepeatableRead'}),'합성 부상 원생');
 // 보류 범위 칸(학부모 문구용): 반 전부 → allClasses, 대상 반 지정 → 그 반 이름. 청구 준비도 대상 반만 막는다(다른 반 'c' 는 대상 아님)
 const scopeOf=async()=>(await pool.query(`SELECT ${periodRules.illnessHoldScopeColumnsSql('s')} FROM "Student" s WHERE s.id='s6'`)).rows[0];
 assert.deepEqual(await scopeOf(),{allClasses:true,classNames:[]});
 await pool.query(`UPDATE "RegularAbsencePeriod" SET "classIds"=ARRAY['c'] WHERE id='hold-period'`);
 assert.deepEqual(await scopeOf(),{allClasses:false,classNames:['합성 토요반']});
 assert.deepEqual((await holdRead()).bills,[],'대상 반(c)이 아닌 반(h)의 청구는 보류 전환 대상이 아니다');
 await pool.query(`UPDATE "RegularAbsencePeriod" SET "classIds"=ARRAY['h'] WHERE id='hold-period'`);
 assert.deepEqual(await scopeOf(),{allClasses:false,classNames:['합성 보류반']});
 assert.equal((await holdRead()).bills.length,1);
 await pool.query(`UPDATE "RegularAbsencePeriod" SET "classIds"=ARRAY[]::text[] WHERE id='hold-period'`);
 checks.push('보류 판정 조각(학생 단위·기간 단위·신청함 상태식)·보류 범위 칸(반 전부/대상 반)·아이 이름 조회 실제 실행');
 // 학부모가 방금 결제창을 열었다 → 건너뛰고, 그 청구를 넣어 요청하면 실행하지 않는다
 await pool.query(`INSERT INTO "PaymentTransaction"(id,"paymentId",provider,status,"updatedAt") VALUES('hold-tx',$1,'TOSS','READY',now())`,[heldPaymentId]);
 holdView=await holdRead();assert.equal(holdView.bills[0].skip,'CHECKOUT');
 await assert.rejects(periodAdmin.holdIssuedBillsForPeriod(database,{periodId:'hold-period',expectedPaymentIds:[heldPaymentId]},'admin'),/대상 청구가 바뀌었습니다/);
 assert.equal((await pool.query('SELECT status FROM "Payment" WHERE id=$1',[heldPaymentId])).rows[0].status,'PENDING');
 // 현장 결제 요청 중 / 이월을 쓴 청구도 건너뛴다(실제 SQL)
 await pool.query(`DELETE FROM "PaymentTransaction" WHERE id='hold-tx';INSERT INTO "PosChargeRequest" VALUES('hold-pos','${heldPaymentId}','SENT')`);assert.equal((await holdRead()).bills[0].skip,'POS');
 await pool.query(`DELETE FROM "PosChargeRequest" WHERE id='hold-pos'`);
 await pool.query(`INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status) VALUES('hold-abs','s6','h','2026-12-26','ILLNESS_INJURY','CONFIRMED');INSERT INTO "BillingCarryCredit"(id,"studentId","absenceId",numerator,denominator,"availableMonth",basis,"actorUserId") VALUES('hold-credit','s6','hold-abs',1,1,'2027-03','{}','fixture')`);
 await pool.query(`INSERT INTO "BillingCarryUsage"(id,"studentId",month,"draftId",amount,"paymentId","actorUserId","sourceCreditIds",basis) VALUES('hold-usage','s6','2027-01','s6:h',1,$1,'fixture',ARRAY['hold-credit'],'{}')`,[heldPaymentId]);
 assert.equal((await holdRead()).bills[0].skip,'CARRY_USED');
 await pool.query(`DELETE FROM "BillingCarryUsage" WHERE id='hold-usage';DELETE FROM "BillingCarryCredit" WHERE id='hold-credit';DELETE FROM "RegularAbsence" WHERE id='hold-abs'`);
 checks.push('결제 진행 중·현장 결제 요청 중·이월을 쓴 청구는 건너뜀(요청해도 실행 안 함)');
 // 경합(리뷰 필수): 보류 전환이 결제 잠금을 기다리는 «동안» 학부모 결제가 시작돼 커밋됐다 → 잠근 뒤 다시 읽어 그 거래를 보고 실행하지 않아야 한다.
 // Serializable 이면 첫 문장 시점 사진으로 읽어 이 거래가 안 보이고 청구가 취소된다 — READ COMMITTED 라서 보인다.
 const racer=await pool.connect();
 try{
  await racer.query('BEGIN');await racer.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,[`stiz-payment-checkout:${heldPaymentId}`]);
  const waiting=periodAdmin.holdIssuedBillsForPeriod(database,{periodId:'hold-period',expectedPaymentIds:[heldPaymentId]},'admin').then(()=>null,e=>e);
  await new Promise(r=>setTimeout(r,1200)); // 보류 전환이 결제 잠금 앞에서 기다리게 둔다
  await racer.query(`INSERT INTO "PaymentTransaction"(id,"paymentId",provider,status,"updatedAt") VALUES('hold-race',$1,'TOSS','READY',now())`,[heldPaymentId]);
  await racer.query('COMMIT');
  const raced=await waiting;assert.match(String(raced?.message),/대상 청구가 바뀌었습니다/);
 }finally{racer.release();}
 assert.equal(database.lastIsolation,'read committed');
 assert.equal((await pool.query('SELECT status FROM "Payment" WHERE id=$1',[heldPaymentId])).rows[0].status,'PENDING');
 await pool.query(`DELETE FROM "PaymentTransaction" WHERE id='hold-race'`);
 checks.push('경합: 결제 잠금을 기다리는 동안 시작된 학부모 결제를 잠근 뒤 다시 읽어 발견 → 청구를 취소하지 않음(READ COMMITTED)');
 const heldResult=await periodAdmin.holdIssuedBillsForPeriod(database,{periodId:'hold-period',expectedPaymentIds:[heldPaymentId]},'admin');
 assert.deepEqual(heldResult.held.map(b=>[b.paymentId,b.amount,b.draftId]),[[heldPaymentId,100000,'s6:h']]);
 const heldRow=(await pool.query('SELECT p.status,i.status AS "invoiceStatus",i."canceledAt" IS NOT NULL AS canceled FROM "Payment" p JOIN "PaymentInvoice" i ON i."paymentId"=p.id WHERE p.id=$1',[heldPaymentId])).rows[0];
 assert.deepEqual([heldRow.status,heldRow.invoiceStatus,heldRow.canceled],['CANCELED','CANCELED',true]);
 const heldDraft=(await pool.query(`SELECT status,"paymentId",version,payload FROM "BillingWorkbenchDraft" WHERE id='s6:h' AND month='2027-01'`)).rows[0];
 assert.deepEqual([heldDraft.status,heldDraft.paymentId,heldDraft.payload.baseAmount],['DRAFT',null,100000]);
 const heldRevision=(await pool.query(`SELECT action,version,payload FROM "BillingWorkbenchRevision" WHERE "draftId"='s6:h' AND month='2027-01' ORDER BY version DESC LIMIT 1`)).rows[0];
 assert.deepEqual([heldRevision.action,heldRevision.version,heldRevision.payload.heldPaymentId],['HOLD',heldDraft.version,heldPaymentId]);
 assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "PaymentAuditLog" WHERE "paymentId"=$1 AND action='ILLNESS_PERIOD_BILL_HELD'`,[heldPaymentId])).rows[0].n,1);
 const settlement=(await pool.query(`SELECT "carrySettlement" FROM "RegularAbsencePeriod" WHERE id='hold-period'`)).rows[0].carrySettlement;
 assert.deepEqual(settlement.approval.createdReviewAbsenceIds,['kept']);assert.deepEqual(settlement.held.map(b=>b.paymentId),[heldPaymentId]);
 checks.push('보류로 돌리기: 청구·청구서 취소, 초안 DRAFT·paymentId NULL·버전+1, HOLD 이력, 감사 기록, carrySettlement 병합 저장(approval 유지)');
 // 청구 준비: 그 행이 보류로 나오고 확정·발행이 거절된다. 다른 학생 행에는 보류 칸이 없다
 jan=await holdMonthView();const holdRow=jan.rows.find(r=>r.id==='s6:h');
 assert.equal(holdRow.hold,true);assert.equal(holdRow.holdPeriodId,'hold-period');assert.equal(holdRow.blockingReasons[0],'부상 결석 중 · 발행 보류');assert.equal(holdRow.totalAmount,100000);
 assert.ok(jan.rows.filter(r=>r.studentId!=='s6').every(r=>!('hold' in r)));
 await assert.rejects(mutateWorkbench(database,cmd('CONFIRM',jan,['s6:h']),'admin',true),/부상 결석 중 · 발행 보류/);
 jan=(await mutateWorkbench(database,cmd('SAVE',jan,['s6:h']),'admin',true)).view;
 await assert.rejects(mutateWorkbench(database,cmd('CONFIRM',jan,['s6:h']),'admin',true),/부상 결석 중 · 발행 보류/);
 assert.deepEqual((await holdRead()).bills,[]);assert.equal((await holdRead()).heldBills.length,1);
 checks.push('보류 중인 학생 행은 확정·발행 거절(저장 뒤에도), 다른 학생 행은 그대로');
 // 승인 취소 → 보류가 풀려 «확인 필요»로 다시 나온다 → 다시 저장·확정·발행 → 살아 있는 청구는 정확히 1건(취소된 청구는 되살리지 않는다)
 // 승인 때 거둔 보강권 2장: 12/26 은 결석 기록, 1/2 는 그날 출석으로 기록됐다 → 승인 취소는 12/26 것만 돌려준다(실제 SQL)
 await pool.query(`ALTER TABLE "MakeupCredit" ADD COLUMN "expiresAt" timestamptz, ADD COLUMN note text;
 INSERT INTO "RegularAbsence"(id,"studentId","classId",date,reason,status,"periodId") VALUES('hold-day-1','s6','h','2026-12-26','ILLNESS_INJURY','CONFIRMED','hold-period'),('hold-day-2','s6','h','2027-01-02','ILLNESS_INJURY','CONFIRMED','hold-period');
 INSERT INTO "MakeupCredit"(id,"studentId","sourceKey",status,"updatedAt","expiresAt") VALUES('hold-mc-1','s6','REGULAR:h:2026-12-26','REVOKED',NOW(),NOW()+interval '30 days'),('hold-mc-2','s6','REGULAR:h:2027-01-02','REVOKED',NOW(),NOW()+interval '30 days');
 INSERT INTO "Session" VALUES('hold-session','h','2027-01-02');INSERT INTO "Attendance" VALUES('hold-attendance','s6','hold-session','PRESENT',NOW());
 UPDATE "RegularAbsencePeriod" SET "carrySettlement"="carrySettlement" || '{"approval":{"revokedCreditIds":["hold-mc-1","hold-mc-2"],"createdReviewAbsenceIds":[]}}'::jsonb WHERE id='hold-period'`);
 const approvalCancelled=await periodAdmin.cancelIllnessPeriodApproval(database,{periodId:'hold-period'},'admin');assert.equal(approvalCancelled.heldBills,1);
 assert.equal(approvalCancelled.creditsRestored,1);
 assert.deepEqual((await pool.query(`SELECT id,status FROM "MakeupCredit" WHERE id LIKE 'hold-mc-%' ORDER BY id`)).rows.map(r=>[r.id,r.status]),[['hold-mc-1','AVAILABLE'],['hold-mc-2','REVOKED']]);
 checks.push('승인 취소: 그날 출석으로 기록된 날의 보강권은 돌려주지 않는다(결석일 것만 되돌림)');
 jan=await holdMonthView();const reopened=jan.rows.find(r=>r.id==='s6:h');assert.ok(!reopened.hold);assert.deepEqual(reopened.blockingReasons,[]);assert.equal(reopened.status,'REVIEW');
 jan=(await mutateWorkbench(database,cmd('SAVE',jan,['s6:h']),'admin',true)).view;jan=(await mutateWorkbench(database,cmd('CONFIRM',jan,['s6:h']),'admin',true)).view;
 const reissue=cmd('ISSUE',jan,['s6:h']),reissued=await mutateWorkbench(database,reissue,'admin',true);await mutateWorkbench(database,reissue,'admin',true);
 const s6Payments=(await pool.query(`SELECT id,status,amount FROM "Payment" WHERE "studentId"='s6' AND year=2027 AND month=1 ORDER BY status`)).rows;
 assert.deepEqual(s6Payments.map(p=>p.status),['CANCELED','PENDING']);assert.equal(s6Payments.find(p=>p.status==='PENDING').id,reissued.operationResult.paymentIds[0]);assert.notEqual(reissued.operationResult.paymentIds[0],heldPaymentId);
 assert.equal((await pool.query(`SELECT "paymentId" FROM "BillingWorkbenchDraft" WHERE id='s6:h' AND month='2027-01'`)).rows[0].paymentId,reissued.operationResult.paymentIds[0]);
 checks.push('승인 취소 뒤 다시 발행 가능 — 살아 있는 청구 정확히 1건(새 청구 번호), 취소된 청구는 그대로');
 return {checks};
}
