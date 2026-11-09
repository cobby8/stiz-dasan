import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import ts from "typescript";
const require = createRequire(import.meta.url), exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync("src/lib/enrollment/shuttle-progress.ts", "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require: name => { assert.equal(name,"node:crypto"); return require(name); }, Date, Object, Array, Number, String, Set, Map, Error });
const p=exports;
function fixture() {
  const application={id:"application-1",status:"APPROVED",convertedStudentId:"student-1",assignedClassId:"class-1",shuttleNeeded:true};
  const roster=["BOARD","ALIGHT"].map((direction,i)=>({id:`row-${i}`,serviceMonth:"2026-11",weekday:1,direction,studentId:"student-1",classTime:"17:00~17:55",arriveTime:i?"18:15":"16:40",stopName:"합성 정류장",latitude:37.6,longitude:127.1,sortOrder:i}));
  const routes=["PICKUP","DROPOFF"].map((direction,i)=>({serviceMonth:"2026-11",dayOfWeek:"Mon",direction,classStart:"17:00",classEnd:"17:55",payload:{vehicles:[{vehicleName:"합성 차량",driverUserId:"driver-1",stops:[{label:"합성 정류장",lat:37.6,lng:127.1,etaMinutes:i?1095:1000,students:[{requestId:"student-1"}]}]}]}}));
  for (const route of routes) route.payload.confirmation=p.routeConfirmation(route,roster.filter(r=>r.direction===(route.direction==="PICKUP"?"BOARD":"ALIGHT")));
  return {application,serviceMonth:"2026-11",classes:[{id:"class-1",dayOfWeek:"Mon",active:true,startTime:"17:00",endTime:"17:55"}],locations:["PICKUP","DROPOFF"].map(kind=>({studentId:"student-1",kind,latitude:37.6,longitude:127.1,consentVersion:"2026-07-21",confirmedAt:"2026-11-01"})),roster,routes,notices:[],deliveries:[],recipientPhone:"01000000001",recipientHash:phone=>`hash:${phone}`};
}
function notice(f,providerStatus="ACCEPTED") {
 const eventKey=p.shuttleNoticeEventKey(f.serviceMonth,"student-1",p.studentRosterFingerprint("student-1",f.serviceMonth,f.roster));
 f.notices.push({studentId:"student-1",serviceMonth:f.serviceMonth,stableEventKey:eventKey,payloadHash:"notice-hash",status:"SENT",messageBody:"합성 배차 안내",recipientPhone:"01000000001",sentAt:"2026-11-02",createdAt:"2026-11-02"});
 f.deliveries.push({stableEventKey:p.shuttleDeliveryEventKey("notice-hash"),status:"SENT",providerStatus,bodyHash:require("node:crypto").createHash("sha256").update("합성 배차 안내").digest("hex"),recipientPhoneHash:"hash:01000000001",providerMessageId:"provider-1",sentAt:"2026-11-02"});
}
test("승인·위치 저장만 된 신규 신청은 배차 대기이며 완료가 아니다",()=>{const f=fixture();f.roster=[];f.routes=[];assert.equal(p.enrollmentShuttleProgress(f).status,"ROSTER_PENDING");});
test("미신청·승인 전·조회 장애를 구분한다",()=>{const f=fixture();f.application.shuttleNeeded=false;assert.equal(p.enrollmentShuttleProgress(f).status,"NOT_REQUESTED");f.application.shuttleNeeded=true;f.application.status="PENDING";assert.equal(p.enrollmentShuttleProgress(f).status,"REQUESTED");assert.equal(p.enrollmentShuttleProgress({...f,readFailed:true}).status,"UNKNOWN");});
test("명단에 없는 칸이 있으면 좌표·현재 동의 없는 레거시 신청은 위치 확인 필요",()=>{const f=fixture();f.roster=f.roster.slice(0,1);f.locations[0].consentVersion="old";assert.equal(p.enrollmentShuttleProgress(f).status,"LOCATION_REQUIRED");});
test("명단만 있으면(저장 노선 0건) 배차 완료, raw 노선에만 있으면 배차 대기",()=>{const f=fixture();f.routes=[];assert.equal(p.enrollmentShuttleProgress(f).status,"ASSIGNED");const g=fixture();g.roster=[];assert.equal(p.enrollmentShuttleProgress(g).status,"ROSTER_PENDING");});
test("저장 노선이 남아 있어도(확인 근거 없음 포함) 진행은 명단만 보고 배차 완료",()=>{const f=fixture();delete f.routes[0].payload.confirmation;assert.equal(p.enrollmentShuttleProgress(f).status,"ASSIGNED");const g=fixture();g.routes[0].payload.vehicles[0].stops[0].etaMinutes=1;assert.equal(p.enrollmentShuttleProgress(g).legs[0].timeLabel,"16:40");});
test("안정 학생 ID 없이 이름으로 연결된 명단은 완료 처리하지 않는다",()=>{const f=fixture();f.roster[0].studentId=null;assert.equal(p.enrollmentShuttleProgress(f).status,"ROSTER_PENDING");});
test("다른 월·다른 요일 노선은 현재 노선 근거가 아니라 그 칸은 명단 기준 배차 완료",()=>{for(const key of ["serviceMonth","dayOfWeek"]){const f=fixture();f.routes[0][key]=key==="serviceMonth"?"2026-12":"Tue";const r=p.enrollmentShuttleProgress(f);assert.equal(r.status,"ASSIGNED");assert.equal(r.confirmedCount,2);}});
test("한 방향만 확정돼도 1/2 부분 진행으로 남는다",()=>{const f=fixture();f.roster=f.roster.filter(r=>r.direction==="ALIGHT");const r=p.enrollmentShuttleProgress(f);assert.equal(r.confirmedCount,1);assert.equal(r.totalCount,2);assert.notEqual(r.status,"COMPLETE");});
test("이 학생 명단의 시각·정류장 변경은 이전 안내 성공을 재사용하지 않는다",()=>{for(const [key,value] of [["arriveTime","16:45"],["stopName","다른 장소"]]){const f=fixture();notice(f,"DELIVERED");f.roster[0][key]=value;const r=p.enrollmentShuttleProgress(f);assert.equal(r.status,"ASSIGNED");assert.match(r.detail,/변경 안내/);}});
test("정렬 번호·좌표·다른 학생 행 변경은 이 학생 안내 완료를 그대로 둔다",()=>{for(const mutate of [f=>f.roster[0].sortOrder=9,f=>f.roster[0].latitude=37.7,f=>f.roster.push({...f.roster[0],id:"other",studentId:"student-2",arriveTime:"16:50"})]){const f=fixture();notice(f,"DELIVERED");mutate(f);assert.equal(p.enrollmentShuttleProgress(f).status,"COMPLETE");}});
test("학부모 위치와 명단 공용 정류장 좌표가 달라도 재확인 사유가 아니다",()=>{const f=fixture();f.locations[0].latitude=37.8;assert.equal(p.enrollmentShuttleProgress(f).status,"ASSIGNED");});
test("배정 반의 실제 수업시간이 바뀌면 명단·노선을 재확인한다",()=>{const f=fixture();f.classes[0].startTime="17:10";assert.equal(p.enrollmentShuttleProgress(f).status,"RECONFIRM_REQUIRED");});
test("안내 전이면 배차 완료, 안내문은 명단 시각·정류장으로 만든다",()=>{const f=fixture();assert.equal(p.enrollmentShuttleProgress(f).status,"ASSIGNED");const n=p.buildStudentRouteNotice("student-1",f.serviceMonth,f.roster);assert.equal(n.text,"월 등원 16:40 합성 정류장 / 월 하원 18:15 합성 정류장");assert.equal(n.eventKey,p.shuttleNoticeEventKey(f.serviceMonth,"student-1",p.studentRosterFingerprint("student-1",f.serviceMonth,f.roster)));f.roster[0].arriveTime="8:05";assert.match(p.buildStudentRouteNotice("student-1",f.serviceMonth,f.roster).text,/월 등원 08:05/);});
test("공급자 ACCEPTED는 안내 완료가 아닌 전달 미확인",()=>{const f=fixture();notice(f);assert.equal(p.enrollmentShuttleProgress(f).status,"NOTICE_ACCEPTED");});
test("현재 배차·문안·수신자가 일치하는 최종 성공만 안내 완료",()=>{const f=fixture();notice(f,"DELIVERED");assert.equal(p.enrollmentShuttleProgress(f).status,"COMPLETE");assert.equal(p.enrollmentShuttleProgress(f).confirmedCount,2);});
test("실패·불확실·진행 중을 안내 완료로 승격하지 않는다",()=>{for(const status of ["FAILED","UNCERTAIN","PENDING","SENDING"]){const f=fixture();notice(f,"DELIVERED");f.deliveries[0].status=status;assert.notEqual(p.enrollmentShuttleProgress(f).status,"COMPLETE");}});
test("잘못된 문안·수신자·이벤트 증거는 완료에 사용하지 않는다",()=>{for(const [key,value] of [["bodyHash","wrong"],["recipientPhoneHash","other"],["stableEventKey","old"],["providerMessageId",null]]){const f=fixture();notice(f,"DELIVERED");f.deliveries[0][key]=value;assert.notEqual(p.enrollmentShuttleProgress(f).status,"COMPLETE");}const f=fixture();notice(f,"DELIVERED");f.recipientPhone="01000000002";assert.notEqual(p.enrollmentShuttleProgress(f).status,"COMPLETE");});
test("명단 시각 변경 뒤 과거 발송 성공은 재안내 필요로 남는다",()=>{const f=fixture();notice(f,"DELIVERED");f.roster[1].arriveTime="18:20";assert.equal(p.enrollmentShuttleProgress(f).status,"ASSIGNED");assert.match(p.enrollmentShuttleProgress(f).detail,/변경 안내/);});
test("다른 안내를 보낸 뒤 옛 명단 복귀해도 옛 성공 자동 부활 안 함",()=>{const f=fixture();notice(f,"DELIVERED");f.notices.push({...f.notices[0],stableEventKey:"different-route",createdAt:"2026-11-03"});assert.equal(p.enrollmentShuttleProgress(f).status,"ASSIGNED");});
test("같은 칸 명단 중복·도착 시각 누락이면 안내문을 만들지 않는다",()=>{const f=fixture();f.roster.push({...f.roster[0],id:"row-dup"});assert.throws(()=>p.buildStudentRouteNotice("student-1",f.serviceMonth,f.roster),/여러 줄/);const g=fixture();g.roster[0].arriveTime=null;assert.throws(()=>p.buildStudentRouteNotice("student-1",g.serviceMonth,g.roster),/도착 시각/);const h=fixture();assert.throws(()=>p.buildStudentRouteNotice("student-9",h.serviceMonth,h.roster),/명단을 확인/);});
test("실제 월·요일·방향·학생과 지문은 유지하고 객체 키 순서만 무시",()=>{const f=fixture();assert.equal(p.shuttleFingerprint({a:1,b:2}),p.shuttleFingerprint({b:2,a:1}));const before=JSON.stringify(f);p.enrollmentShuttleProgress(f);assert.equal(JSON.stringify(f),before);});

// ── 「셔틀 명단 = 기사님 화면」 기준(저장 노선 0건 운영) ──
test("저장 노선 0건 + 명단 있음 → 배차 완료이고 확정 칸 수에 포함",()=>{const f=fixture();f.routes=[];const r=p.enrollmentShuttleProgress(f);assert.equal(r.status,"ASSIGNED");assert.equal(r.label,"배차 완료");assert.equal(r.confirmedCount,2);assert.equal(r.totalCount,2);assert.equal(r.legs.map(l=>l.status).join(),"ASSIGNED,ASSIGNED");assert.equal(r.legs.map(l=>l.timeLabel).join(),"16:40,18:15");assert.match(r.legs[0].detail,/기사님 운행표/);});
test("수업 16:00~16:55 + 명단 칸 16:00~17:00 은 시작 시각이 같아 일치",()=>{const f=fixture();f.routes=[];f.classes[0].startTime="16:00";f.classes[0].endTime="16:55";for(const r of f.roster)r.classTime="16:00 ~ 17:00";assert.equal(p.enrollmentShuttleProgress(f).status,"ASSIGNED");f.roster[0].classTime="17:00~18:00";assert.equal(p.enrollmentShuttleProgress(f).status,"RECONFIRM_REQUIRED");});
test("학부모 위치와 명단 정류장이 수백 m 달라도 배차 완료",()=>{const f=fixture();f.routes=[];for(const r of f.roster){r.latitude=37.603;r.longitude=127.104;}assert.equal(p.enrollmentShuttleProgress(f).status,"ASSIGNED");});
test("반 이동(옛 반 WITHDRAWN, 새 반 ACTIVE)은 신청서 배정 반이 아니라 새 반 기준",()=>{const f=fixture();f.routes=[];f.application.assignedClassId="old-class";f.classes=[{id:"old-class",dayOfWeek:"Mon",active:false,status:"WITHDRAWN",startTime:"15:00",endTime:"15:55"},{id:"new-class",dayOfWeek:"Wed",active:true,status:"ACTIVE",startTime:"17:00",endTime:"17:55"}];for(const r of f.roster)r.weekday=3;const r=p.enrollmentShuttleProgress(f);assert.equal(r.status,"ASSIGNED");assert.equal([...new Set(r.legs.map(l=>l.dayOfWeek))].join(),"Wed");});
test("현재 수강이 전부 휴원이면 휴원 중, 수강 자체가 없으면 배정 반 확인",()=>{const f=fixture();f.classes=[{...f.classes[0],active:false,status:"PAUSED"}];const r=p.enrollmentShuttleProgress(f);assert.equal(r.status,"PAUSED");assert.equal(r.label,"휴원 중");assert.equal(r.detail,"휴원 중이라 셔틀 배정이 필요 없습니다.");const g=fixture();g.classes=[];assert.equal(p.enrollmentShuttleProgress(g).status,"RECONFIRM_REQUIRED");});
test("휴원 반과 수강 반이 함께 있으면 수강 반만 계산",()=>{const f=fixture();f.routes=[];f.classes.push({id:"paused-class",dayOfWeek:"Fri",active:false,status:"PAUSED",startTime:"18:00",endTime:"18:55"});const r=p.enrollmentShuttleProgress(f);assert.equal(r.status,"ASSIGNED");assert.equal(r.totalCount,2);});
test("명단이 모두 있으면 학부모 위치가 없어도 배차 완료",()=>{const f=fixture();f.routes=[];f.locations=[];assert.equal(p.enrollmentShuttleProgress(f).status,"ASSIGNED");});
test("명단에 일부 칸이 없으면 배차 대기",()=>{const f=fixture();f.routes=[];f.roster=f.roster.filter(r=>r.direction==="BOARD");const r=p.enrollmentShuttleProgress(f);assert.equal(r.status,"ROSTER_PENDING");assert.equal(r.confirmedCount,1);assert.match(r.detail,/1\/2개 배차 확정/);});
test("명단 정류장 좌표 누락·같은 칸 중복은 저장 노선이 없어도 재확인",()=>{const f=fixture();f.routes=[];f.roster[0].latitude=null;assert.equal(p.enrollmentShuttleProgress(f).status,"RECONFIRM_REQUIRED");const g=fixture();g.routes=[];g.roster.push({...g.roster[0],id:"row-dup"});assert.equal(p.enrollmentShuttleProgress(g).status,"RECONFIRM_REQUIRED");});

function loadFile(file,imports,globals={}) { const result={};vm.runInNewContext(ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:result,require:name=>{assert.ok(name in imports,`검사에서 허용하지 않은 접근: ${name}`);return imports[name];},Date,Intl,Map,Set,Object,Array,Number,String,Error,console,...globals});return result; }
function querySetup(f,fail=false,hasNoticeLedger=true) {
 const calls=[];
 const db={$queryRawUnsafe:async(sql,...values)=>{calls.push({sql,values});if(fail)throw new Error("합성 읽기 장애");if(sql.includes("to_regclass"))return [{noticeLedger:hasNoticeLedger?"RegularShuttleNoticeBatch":null}];if(sql.includes('FROM "Enrollment"'))return f.classes.map(c=>({runsShuttle:true,...c,studentId:"student-1"}));if(sql.includes('FROM "StudentShuttleLocation"'))return f.locations;if(sql.includes('FROM "RegularShuttleStop"'))return f.roster;if(sql.includes('FROM "RegularDispatchRoute"'))return f.routes;if(sql.includes('FROM "RegularShuttleNoticeBatch"'))return f.notices;if(sql.includes('FROM "NotificationDelivery"'))return f.deliveries;if(sql.includes('FROM "Student"'))return [{studentId:"student-1",phone:f.recipientPhone}];throw new Error("예상 밖 읽기");}};
 const prisma={...db,$transaction:async(fn,options)=>{assert.equal(options.isolationLevel,"RepeatableRead");return fn(db);}};
 const q=loadFile("src/lib/enrollment/shuttle-progress-query.ts",{"server-only":{},"@/lib/prisma":{prisma},"@/lib/studentVisibility":{notMergedStudent:alias=>`${alias}."mergedIntoStudentId" IS NULL`},"@/lib/message-ledger":{hashMessageRecipientPhone:f.recipientHash},"@/lib/regular/serviceMonth":{koreaServiceMonth:()=>"2026-11",isServiceMonth:v=>/^\d{4}-(0[1-9]|1[012])$/.test(v)},"./shuttle-progress":p,"@/lib/billing/workbench-pricing":loadFile("src/lib/billing/workbench-pricing.ts",{})});
 return {q,db,calls};
}
test("실제 배치 조회는 학생 ID별 반을 분리하고 전달 이벤트 키를 사용한다",async()=>{const f=fixture();notice(f,"DELIVERED");const {q,db,calls}=querySetup(f);const result=await q.getEnrollmentShuttleProgress([f.application,{...f.application,id:"other",convertedStudentId:"other-student"}],"2026-11",db);assert.equal(result[f.application.id].status,"COMPLETE");assert.notEqual(result.other.status,"COMPLETE");assert.equal(calls.length,7);assert.ok(!calls.some(c=>c.sql.includes("RegularDispatchRoute")));const enrollment=calls.find(c=>c.sql.includes('FROM "Enrollment"'));assert.match(enrollment.sql,/e\.status IN \('ACTIVE','PAUSED'\)/);assert.match(enrollment.sql,/"startsOn" IS NULL OR/);assert.doesNotMatch(enrollment.sql,/c\.id=ANY/);assert.equal(enrollment.values[1],"2026-11");const delivery=calls.find(c=>c.sql.includes('FROM "NotificationDelivery"'));assert.equal(delivery.values[0][0],p.shuttleDeliveryEventKey("notice-hash"));assert.ok(calls.every(c=>c.sql.trim().startsWith("SELECT")));});
test("배치 조회 실패는 기존 승인 신청을 배차 없음이나 완료로 위장하지 않는다",async()=>{const f=fixture();const {q,db}=querySetup(f,true);const result=await q.getEnrollmentShuttleProgress([f.application],"2026-11",db);assert.equal(result[f.application.id].status,"UNKNOWN");});
test("기본 서버 조회는 일관된 읽기 스냅샷으로 최종 전달 근거까지 대조한다",async()=>{const f=fixture();notice(f,"DELIVERED");const {q}=querySetup(f);assert.equal((await q.getEnrollmentShuttleProgress([f.application],"2026-11"))[f.application.id].status,"COMPLETE");});
test("신청 전·미신청만 있으면 운영 자료 조회 없이 상태를 반환한다",async()=>{const f=fixture();const {q,db,calls}=querySetup(f);const app={...f.application,status:"PENDING",convertedStudentId:null};assert.equal((await q.getEnrollmentShuttleProgress([app],"2026-11",db))[app.id].status,"REQUESTED");assert.equal(calls.length,0);});
test("노선 저장은 명단 월 잠금 아래 실제 읽은 명단의 지문을 원자적으로 기록한다",async()=>{
 const f=fixture(),events=[];let saved;
 const tx={$executeRawUnsafe:async(sql,...values)=>{events.push({kind:"lock",sql,values});return 1;},$queryRawUnsafe:async(sql,...values)=>{if(sql.includes('FROM "RegularShuttleStop"')){events.push({kind:"roster",values});return f.roster.filter(r=>r.direction==="BOARD");}events.push({kind:"save",sql,values});saved=JSON.parse(values[3]);return [{updatedAt:"2026-11-03T00:00:00.000Z"}];}};
 const db={$queryRawUnsafe:async()=>[{id:"driver-1"}],$transaction:async fn=>fn(tx)};
 const mod=loadFile("src/lib/regular/regularDispatchRoute.ts",{"@/lib/prisma":{prisma:db},"@/lib/auth-guard":{requireAdmin:async()=>({appUserId:"admin-1"})},"@/lib/seasonal/dispatchReconcile":{},"@/lib/seasonal/dispatchEtaLookup":{},"./shuttleRoster":{},"./shuttle-dispatch":{},"./regularDispatchPayload":{validateRegularDispatchVehicles:v=>v},"./serviceMonth":{koreaServiceMonth:()=>"2026-11",isServiceMonth:v=>v==="2026-11"},"@/lib/enrollment/shuttle-progress":p});
 const r=f.routes[0];await mod.saveRegularDispatchRoute({dayOfWeek:"Mon",direction:"PICKUP",vehicles:r.payload.vehicles,classStart:r.classStart,classEnd:r.classEnd,serviceMonth:"2026-11",expectedSavedAt:null});assert.deepEqual(events.map(e=>e.kind),["lock","roster","save"]);assert.equal(events[0].values[0],"regular-roster:2026-11");assert.equal(saved.confirmation.rosterHash,p.rosterFingerprint(f.roster.filter(r=>r.direction==="BOARD")));assert.ok(p.hasCurrentRouteConfirmation({...r,payload:saved},f.roster.filter(r=>r.direction==="BOARD")));assert.match(events[2].sql,/date_trunc\('milliseconds'/);
});

function providerFixture(mode="SUCCESS") {
 const f=fixture();notice(f);const row={...f.deliveries[0],id:"delivery-1",batchId:"batch-1",source:"MANUAL",trigger:"REGULAR_SHUTTLE_CHANGE",eventType:"REGULAR_SHUTTLE_CHANGE",provider:"SOLAPI",providerGroupId:"group-1",updatedAt:"2026-11-01T00:00:00Z"};let providerCalls=0,writeCount=0;
 const db={$queryRawUnsafe:async(sql,group)=>{assert.match(sql,/trigger='REGULAR_SHUTTLE_CHANGE' AND status='SENT'/);assert.match(sql,/"providerStatus"='ACCEPTED'/);if(row.providerStatus!=="ACCEPTED"||row.status!=="SENT")return [];return sql.includes('MIN("batchId")')?[{providerGroupId:row.providerGroupId,batchId:row.batchId}]:[{...row,acceptedAt:row.updatedAt}];},$executeRawUnsafe:async(sql,...values)=>{writeCount++;if(sql.includes("SET status='UNCERTAIN'")){assert.match(sql,/trigger='REGULAR_SHUTTLE_CHANGE'/);row.status="UNCERTAIN";}else{assert.match(sql,/trigger='REGULAR_SHUTTLE_CHANGE' AND status='SENT'/);row.status=values[1];row.providerStatus=values[2];row.sentAt=values[1]==="SENT"?"2026-11-03":null;}return 1;}};
 const ledger=loadFile("src/lib/message-ledger.ts",{"node:crypto":require("node:crypto"),"@/lib/prisma":{prisma:db}});
 const route=loadFile("src/app/api/cron/manual-message-reconcile/route.ts",{"next/server":{NextResponse:{json:Response.json}},"@/lib/message-ledger":{...ledger,finalizeMessageDeliveryBatch:async()=>{}},"@/lib/sms":{getSolapiBatchResults:async()=>{providerCalls++;if(mode==="THROW")throw new Error("합성 공급자 조회 오류");if(mode==="MISSING")return [];return [{messageId:row.providerMessageId,status:mode,statusCode:mode==="SUCCESS"?"4000":"5000"}];}}},{process:{env:{CRON_SECRET:"synthetic-cron"}},console:{error:()=>{}}});
 return {f,row,route,stats:()=>({providerCalls,writeCount})};
}
test("기존 결과 수집 실행기가 셔틀 접수 건을 조회해 최종 4000 성공 뒤 안내 완료로 연결한다",async()=>{const x=providerFixture();assert.equal(p.enrollmentShuttleProgress({...x.f,deliveries:[x.row]}).status,"NOTICE_ACCEPTED");const response=await x.route.GET(new Request("https://synthetic.test/cron",{headers:{authorization:"Bearer synthetic-cron"}}));assert.equal((await response.json()).sent,1);assert.equal(x.stats().providerCalls,1);assert.equal(x.row.providerStatus,"4000");assert.equal(p.enrollmentShuttleProgress({...x.f,deliveries:[x.row]}).status,"COMPLETE");});
test("결과 수집 권한 실패는 공급자 호출과 장부 변경 전에 차단한다",async()=>{const x=providerFixture();assert.equal((await x.route.GET(new Request("https://synthetic.test/cron"))).status,401);assert.equal(x.stats().providerCalls,0);assert.equal(x.stats().writeCount,0);});
test("공급자 최종 실패·유예 후 결과 없음은 안내 완료가 아니다",async()=>{for(const mode of ["FAILED","MISSING"]){const x=providerFixture(mode);await x.route.GET(new Request("https://synthetic.test/cron",{headers:{authorization:"Bearer synthetic-cron"}}));assert.notEqual(p.enrollmentShuttleProgress({...x.f,deliveries:[x.row]}).status,"COMPLETE");assert.equal(x.row.status,mode==="FAILED"?"FAILED":"UNCERTAIN");}});
test("공급자 조회 장애는 재발송·실패 확정 없이 기존 접수 상태를 보존한다",async()=>{const x=providerFixture("THROW");await x.route.GET(new Request("https://synthetic.test/cron",{headers:{authorization:"Bearer synthetic-cron"}}));assert.equal(x.stats().writeCount,0);assert.equal(x.row.providerStatus,"ACCEPTED");assert.equal(p.enrollmentShuttleProgress({...x.f,deliveries:[x.row]}).status,"NOTICE_ACCEPTED");});

test("미래 개시 신청은 기본 조회에서 해당 시작 월을 사용하고 현재 월은 시작 전으로 표시",async()=>{const f=fixture();f.application.requestedStartOn="2026-12-07";assert.equal(p.enrollmentShuttleProgress(f).label,"수강 시작 전");const {q,calls}=querySetup(f);const result=await q.getEnrollmentShuttleProgress([f.application]);assert.equal(result[f.application.id].serviceMonth,"2026-12");assert.notEqual(result[f.application.id].status,"COMPLETE");assert.equal(calls.find(c=>c.sql.includes('FROM "RegularShuttleStop"')).values[0],"2026-12");});
function noticeRouteFixture() {
 const f=fixture(),writes=[],stops=f.roster.map(r=>({...r,studentName:"합성학생",parentPhone:"01000000001",studentPhone:null,note:null}));let contact="01000000001";
 const db={$queryRawUnsafe:async sql=>{if(sql.includes('FROM "Student"'))return [{phone:contact}];if(sql.includes('RegularDispatchRoute'))throw new Error("저장 노선 조회 금지");if(sql.includes('FROM "RegularShuttleStop"'))return f.roster;if(sql.includes('FROM "RegularShuttleNoticeBatch"'))return [{status:"HELD",sentAt:null}];throw new Error("예상밖 조회");},$executeRawUnsafe:async(sql,...values)=>{writes.push({sql,values});return 1;},$transaction:async fn=>fn(db)};
 const hashMessageBody=value=>require("node:crypto").createHash("sha256").update(value).digest("hex");
 const route=loadFile("src/app/api/admin/shuttle/regular-notice/route.ts",{"next/server":{NextResponse:{json:Response.json}},"@/lib/auth-guard":{requireAdmin:async()=>({appUserId:"admin-1"})},"@/lib/prisma":{prisma:db},"@/lib/notification":{sendTrackedSms:async()=>{throw new Error("시험에서 실제 발송 금지");}},"@/lib/message-ledger":{hashMessageBody,normalizeMessagePhone:value=>value.replace(/\D/g,"")},"@/lib/regular/regularShuttleDiff":loadFile("src/lib/regular/regularShuttleDiff.ts",{}),"@/lib/regular/serviceMonth":{isServiceMonth:value=>/^\d{4}-\d{2}$/.test(value)},"@/lib/shuttle/regularImport":{getRegularShuttleStops:async month=>({serviceMonth:month,stops})},"@/lib/enrollment/shuttle-progress":p,"@/lib/studentVisibility":{notMergedStudent:alias=>`${alias}."mergedIntoStudentId" IS NULL`}});
 return {f,writes,route,setContact:value=>{contact=value;},post:body=>route.POST(new Request("https://synthetic.test/notice",{method:"POST",body:JSON.stringify({action:"PREPARE",serviceMonth:"2026-11",compareMonth:"2026-10",change:{key:"student:student-1"},...body})}))};
}
test("명단 월 차이가 없어도 현재 명단 시각·정류장 안내를 준비할 수 있다",async()=>{const x=noticeRouteFixture();const response=await x.post();assert.equal(response.status,200);assert.equal((await response.json()).status,"HELD");const inserted=x.writes.find(w=>w.sql.includes('INSERT INTO "RegularShuttleNoticeBatch"'));assert.match(inserted.values[7],/월 등원 16:40 합성 정류장/);assert.match(inserted.values[7],/월 하원 18:15/);assert.match(inserted.values[2],/^regular-shuttle-v2:/);});
test("같은 달 안에서 명단 시각을 고치면 이전 승인 지문은 저장·발송 없이 거절한다",async()=>{const x=noticeRouteFixture();const old=await (await x.post()).json();x.writes.length=0;x.f.roster[0].arriveTime="16:45";const response=await x.post({action:"APPROVE",payloadHash:old.payloadHash});assert.equal(response.status,409);assert.equal(x.writes.length,0);});
test("현재 보호자와 명단 수신 번호가 다르면 안내 준비도 차단한다",async()=>{const x=noticeRouteFixture();x.setContact("01000000002");assert.equal((await x.post()).status,400);assert.equal(x.writes.length,0);});


test("발송 기록표가 없어도 배차 대기를 조회하고 표 생성·발송은 하지 않는다",async()=>{
 const f=fixture();f.roster=[];f.routes=[];const {q,db,calls}=querySetup(f,false,false);
 const result=await q.getEnrollmentShuttleProgress([f.application],"2026-11",db);
 assert.equal(result[f.application.id].status,"ROSTER_PENDING");
 assert.ok(calls.every(c=>c.sql.trim().startsWith("SELECT")));
 assert.ok(!calls.some(c=>c.sql.includes('FROM "RegularShuttleNoticeBatch"')));
});
test("발송 기록표가 없으면 명단 반영 학생도 안내 완료로 오인하지 않는다",async()=>{
 const f=fixture();notice(f,"DELIVERED");const {q,db,calls}=querySetup(f,false,false);
 const result=await q.getEnrollmentShuttleProgress([f.application],"2026-11",db);
 assert.equal(result[f.application.id].status,"ASSIGNED");
 assert.ok(!calls.some(c=>c.sql.includes('FROM "NotificationDelivery"')));
});

// 2026-11-09 원장 발견: 금7+토2 학생에게 «토 등원/토 하원» 칸 — 셔틀 미운행 반(주말·성인반)은 배차 진행 칸에서 뺀다.
test("셔틀 미운행 반(토요일·성인반)은 배차 진행 칸에서 빠지고 평일 운행 반 결과는 그대로다",async()=>{
 const base=fixture();notice(base,"DELIVERED");
 const s0=querySetup(base);
 const before=(await s0.q.getEnrollmentShuttleProgress([base.application],"2026-11",s0.db))[base.application.id];
 const f=fixture();notice(f,"DELIVERED");
 f.classes.push({id:"sat-class",dayOfWeek:"Sat",active:true,startTime:"11:00",endTime:"11:55",runsShuttle:false},{id:"adult-class",dayOfWeek:"Wed",active:true,startTime:"21:00",endTime:"22:00",runsShuttle:false});
 const {q,db,calls}=querySetup(f);
 const result=(await q.getEnrollmentShuttleProgress([f.application],"2026-11",db))[f.application.id];
 assert.equal(result.status,before.status);
 assert.equal(result.status,"COMPLETE");
 assert.ok(!JSON.stringify(result).includes("Sat")&&!JSON.stringify(result).includes("Wed"));
 assert.match(calls.find(c=>c.sql.includes('FROM "Enrollment"')).sql,/JOIN "Program" p ON p\.id=c\."programId"[\s\S]*/);
 assert.match(calls.find(c=>c.sql.includes('FROM "Enrollment"')).sql,/p\."runsShuttle"/);
});
