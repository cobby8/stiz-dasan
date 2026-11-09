import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const modules = new Map();
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const exports = {};
  modules.set(file, exports);
  const req = name => {
    if (name === 'server-only') return {};
    if (name === '@/lib/prisma') return { prisma: {} };
    // 셔틀 운행 반 판정은 청구와 같은 실제 함수를 쓴다(가짜로 바꾸면 «같은 규칙» 검사가 무의미해진다).
    if (name === '@/lib/billing/workbench-pricing') return load('src/lib/billing/workbench-pricing.ts');
    if (name === '@/lib/studentVisibility') return { notMergedStudent: () => 's."mergedIntoId" IS NULL' };
    if (name === './shuttle-progress-query') return { getEnrollmentShuttleProgress: async apps => Object.fromEntries(apps.map(a => [a.id, { status:'ROSTER_PENDING',label:'배차 대기',detail:'검토 중',rosterHref:'/admin/shuttle/regular',dispatchHref:'/admin/shuttle/regular-dispatch' }])) };
    if (name.startsWith('./')) return load(`src/lib/enrollment/${name.slice(2)}.ts`);
    if (name === 'node:crypto') return require(name);
    throw new Error(`unexpected import ${name}`);
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require:req,Date,JSON,Array,Object,Set,Map,Number,String,Error});
  return exports;
}
const pure = load('src/lib/enrollment/shuttle-review.ts');
const api = load('src/lib/enrollment/shuttle-review-query.ts');
function fixture() {
  const state = {
    apps: [{id:'app-1',status:'APPROVED',convertedStudentId:'student-1',assignedClassId:'class-1',shuttleNeeded:true,requestedStartOn:'2026-11-02',shuttleTime:'16:40',studentName:'합성 학생',grade:'초3'}],
    classes:[{id:'class-1',name:'합성 월요반',dayOfWeek:'Mon',startTime:'17:00',endTime:'17:55',enrollmentStartOn:'2026-11-02',runsShuttle:true}],
    locations:['PICKUP','DROPOFF'].map(kind=>({kind,name:'합성 정류장',address:'합성 시험 주소',latitude:37.6,longitude:127.1,confirmedAt:'2026-11-01',consentVersion:'2026-07-21'})),
    roster:[],routes:[],reviews:[],writes:[],queries:[],roles:{admin:{admin:true,driver:false},driver:{admin:false,driver:true},other:{admin:false,driver:true},teacher:{admin:false,driver:false},parent:{admin:false,driver:false}},drivers:[{id:'driver',name:'합성 기사'}],transactions:[]
  };
  const clone = value => JSON.parse(JSON.stringify(value));
  const db = {
    async $queryRawUnsafe(sql,...args) {
      state.queries.push({sql,args});
      if (sql.includes('pg_advisory_xact_lock')) return [];
      if (sql.includes(' AS admin,')) return state.roles[args[0]] ? [state.roles[args[0]]] : [];
      if (sql.startsWith('SELECT u.id,u.name')) return clone(state.drivers);
      if (sql.startsWith('SELECT u.id FROM "User"')) return state.drivers.filter(x=>x.id===args[0]);
      if (sql.includes('FROM "EnrollmentApplication" a')) {
        let apps=state.apps.filter(a=>a.status==='APPROVED'&&a.shuttleNeeded);
        if (sql.includes('AND a.id=$1')) apps=apps.filter(a=>a.id===args[0]&&(!sql.includes('a."convertedStudentId"=$2')||a.convertedStudentId===args[1]));
        else { apps=apps.filter(a=>!a.requestedStartOn||a.requestedStartOn.slice(0,7)<=args[0]);if(sql.includes('a.id=ANY'))apps=apps.filter(a=>args[1].includes(a.id));if(sql.includes(' LIMIT $'))apps=apps.slice(args.at(-1),args.at(-1)+args.at(-2)); }
        return clone(apps);
      }
      if (sql.includes('FROM "Class" c')) return clone(state.classes);
      if (sql.includes('FROM "StudentShuttleLocation"')) return clone(state.locations);
      if (sql.includes('FROM "RegularShuttleStop"')) return clone(state.roster);
      // 6단계: 신청 검토 지문은 저장 노선을 읽지 않는다.
      if (sql.includes('RegularDispatchRoute')) throw new Error('저장 노선 조회 금지');
      if (sql.includes('FROM "EnrollmentShuttleReview" r')) {
        let rows=state.reviews.filter(r=>r.status!=='SUPERSEDED');
        if (sql.includes('WHERE r.id=$1')) rows=rows.filter(r=>r.id===args[0]&&r.driverUserId===args[1]);
        else if(sql.includes('WHERE r."applicationId"=$1'))rows=rows.filter(r=>r.applicationId===args[0]&&r.serviceMonth===args[1]);
        else {rows=rows.filter(r=>r.serviceMonth===args[0]);if(sql.includes('r."driverUserId"=$2'))rows=rows.filter(r=>r.driverUserId===args[1]);}
        return clone(rows);
      }
      if (sql.startsWith('INSERT INTO "EnrollmentShuttleReview"')) {
        const row={id:`review-${state.reviews.length+1}`,applicationId:args[0],studentId:args[1],serviceMonth:args[2],driverUserId:args[3],driverName:'합성 기사',sourceFingerprint:args[4],status:'PENDING',note:null,proposals:[],requestedByUserId:args[5],requestedAt:'2026-11-03',reviewedAt:null};
        state.writes.push({sql,args});state.reviews.push(row);return [{id:row.id}];
      }
      throw new Error(`unhandled SQL ${sql}`);
    },
    async $executeRawUnsafe(sql,...args) {
      state.writes.push({sql,args});
      if(sql.includes("status='SUPERSEDED'")){for(const row of state.reviews)if(row.applicationId===args[0]&&row.serviceMonth===args[1])row.status='SUPERSEDED';}
      else {const row=state.reviews.find(r=>r.id===args[0]);Object.assign(row,{status:args[1],note:args[2],proposals:JSON.parse(args[3]),reviewedAt:'2026-11-03'});}
      return 1;
    },
    async $transaction(work,options){state.transactions.push(options);return work(db);}
  };
  return {state,db};
}
const actor = id=>({appUserId:id});
async function pending(f) {
  const list=await api.getShuttleIntakeDashboard(actor('admin'),'2026-11',true,f.db);
  const input={applicationId:'app-1',serviceMonth:'2026-11',driverUserId:'driver',expectedFingerprint:list.items[0].fingerprint};
  const result=await api.assignShuttleReview(actor('admin'),input,f.db);return {...input,reviewId:result.id};
}
const response={result:'PROPOSED',note:'기존 노선 확인 후 가능 시각 제안',proposals:[{dayOfWeek:'Mon',direction:'PICKUP',time:'16:40'},{dayOfWeek:'Mon',direction:'DROPOFF',time:'18:20'}]};
test('관리자 조회는 읽기만 하며 신규 신청·개시일·셔틀 상태를 반환한다',async()=>{const f=fixture();const r=await api.getShuttleIntakeDashboard(actor('admin'),'2026-11',true,f.db);assert.equal(r.items.length,1);assert.equal(r.items[0].requestedStartOn,'2026-11-02');assert.equal(r.items[0].progress.status,'ROSTER_PENDING');assert.equal(f.state.writes.length,0);assert.equal(f.state.transactions[0].isolationLevel,'RepeatableRead');});
test('선생님·학부모·없는 계정은 개인정보 조회 전 거절한다',async()=>{for(const id of ['teacher','parent','missing']){const f=fixture();await assert.rejects(api.getShuttleIntakeDashboard(actor(id),'2026-11',false,f.db),e=>e.status===403);assert.equal(f.state.queries.length,1);assert.equal(f.state.writes.length,0);}});
test('기사에게 아직 지정되지 않은 신청은 보이지 않는다',async()=>{const f=fixture();const r=await api.getShuttleIntakeDashboard(actor('driver'),'2026-11',false,f.db);assert.equal(r.items.length,0);assert.equal('drivers' in r,false);assert.equal(f.state.writes.length,0);});
test('관리자만 현재 기사에게 배정하고 지정 기사만 조회한다',async()=>{const f=fixture();const i=await pending(f);assert.ok(i.reviewId);assert.equal((await api.getShuttleIntakeDashboard(actor('driver'),'2026-11',false,f.db)).items.length,1);assert.equal((await api.getShuttleIntakeDashboard(actor('other'),'2026-11',false,f.db)).items.length,0);assert.equal(f.state.transactions.at(-3).isolationLevel,'Serializable');});
test('기사의 관리자 배정 호출과 다른 기사 결과 제출은 거절한다',async()=>{const f=fixture();const i=await pending(f);const count=f.state.writes.length;await assert.rejects(api.assignShuttleReview(actor('driver'),i,f.db),e=>e.status===403);await assert.rejects(api.submitShuttleReview(actor('other'),{...i,...response},f.db),e=>e.status===404);assert.equal(f.state.writes.length,count);});
test('회수된 기사 역할·교사 계정으로 지정 불가',async()=>{const f=fixture();const list=await api.getShuttleIntakeDashboard(actor('admin'),'2026-11',true,f.db);await assert.rejects(api.assignShuttleReview(actor('admin'),{applicationId:'app-1',serviceMonth:'2026-11',driverUserId:'teacher',expectedFingerprint:list.items[0].fingerprint},f.db),e=>e.code==='DRIVER_UNAVAILABLE');assert.equal(f.state.writes.length,0);});
test('같은 미처리 요청 반복은 중복 기록 없이 재사용한다',async()=>{const f=fixture();const i=await pending(f);const count=f.state.writes.length;const r=await api.assignShuttleReview(actor('admin'),i,f.db);assert.equal(r.reused,true);assert.equal(r.id,i.reviewId);assert.equal(f.state.writes.length,count);});
test('담당 기사 제안은 검토 기록만 갱신하고 배차·알림은 만들지 않는다',async()=>{const f=fixture();const i=await pending(f);await api.submitShuttleReview(actor('driver'),{...i,...response},f.db);assert.equal(f.state.reviews[0].status,'PROPOSED');assert.equal(f.state.reviews[0].proposals.length,2);assert.ok(f.state.writes.every(x=>x.sql.includes('"EnrollmentShuttleReview"')));await assert.rejects(api.submitShuttleReview(actor('driver'),{...i,...response},f.db),e=>e.code==='SHUTTLE_REVIEW_ALREADY_DONE');});
test('완료 후 명시적 재요청은 이전 의견 보존하고 새 PENDING 생성',async()=>{const f=fixture();const i=await pending(f);await api.submitShuttleReview(actor('driver'),{...i,...response},f.db);const r=await api.assignShuttleReview(actor('admin'),i,f.db);assert.equal(r.reused,false);assert.equal(f.state.reviews.length,2);assert.equal(f.state.reviews[0].status,'SUPERSEDED');assert.equal(f.state.reviews[0].note,response.note);assert.equal(f.state.reviews[1].status,'PENDING');});
test('클라이언트 지문을 신뢰하지 않고 위조 값은 배정 전에 거절한다',async()=>{const f=fixture();await assert.rejects(api.assignShuttleReview(actor('admin'),{applicationId:'app-1',serviceMonth:'2026-11',driverUserId:'driver',expectedFingerprint:'forged'},f.db),e=>e.code==='STALE_SHUTTLE_REVIEW');assert.equal(f.state.writes.length,0);});
test('시작일·요일·위치·희망시간·명단 변경은 이전 검토를 무효로 한다',async()=>{for(const change of [s=>s.apps[0].requestedStartOn='2026-11-04',s=>s.apps[0].shuttleTime='16:50',s=>s.classes[0].dayOfWeek='Wed',s=>s.classes[0].enrollmentStartOn='2026-11-05',s=>s.locations[0].latitude=37.7,s=>s.roster.push({id:'new-stop'})]){const f=fixture();const i=await pending(f);change(f.state);const count=f.state.writes.length;await assert.rejects(api.submitShuttleReview(actor('driver'),{...i,...response},f.db),e=>e.status===409);assert.equal(f.state.writes.length,count);const r=await api.getShuttleIntakeDashboard(actor('driver'),'2026-11',false,f.db);assert.equal(r.items[0].review.status,'STALE');assert.equal(r.items[0].locations.length,0);}});
test('동의 없는 위치는 담당 지정 전에 보류한다',async()=>{const f=fixture();f.state.locations[0].consentVersion='old';const list=await api.getShuttleIntakeDashboard(actor('admin'),'2026-11',true,f.db);await assert.rejects(api.assignShuttleReview(actor('admin'),{applicationId:'app-1',serviceMonth:'2026-11',driverUserId:'driver',expectedFingerprint:list.items[0].fingerprint},f.db),e=>e.code==='SHUTTLE_LOCATION_REQUIRED');assert.equal(f.state.writes.length,0);});
test('취소·연결 변경은 기존 요청에 제출할 수 없다',async()=>{for(const change of [s=>s.apps[0].status='CANCELLED',s=>s.apps[0].convertedStudentId='another-student']){const f=fixture();const i=await pending(f);change(f.state);const count=f.state.writes.length;await assert.rejects(api.submitShuttleReview(actor('driver'),{...i,...response},f.db),e=>e.status===409);assert.equal(f.state.writes.length,count);}});
test('다른 월과 잘못된 월·식별자는 차단한다',async()=>{const f=fixture();assert.equal((await api.getShuttleIntakeDashboard(actor('admin'),'2026-10',true,f.db)).items.length,0);for(const value of ['2026-13','2026-00','26-11','2026-11-03'])assert.throws(()=>pure.reviewMonth(value));assert.throws(()=>pure.reviewId("a' OR 1=1"));});
test('미정 사유는 시각 없이 제출되며 빈 사유·중복·없는 요일·불가능한 시각 차단',()=>{assert.equal(pure.parseReviewResponse({result:'NEEDS_CONFIRMATION',note:'정류장 확인 필요'},['Mon']).status,'NEEDS_CONFIRMATION');for(const input of [{...response,note:''},{...response,proposals:[...response.proposals,response.proposals[0]]},{...response,proposals:[{dayOfWeek:'Tue',direction:'PICKUP',time:'16:40'}]},{...response,proposals:[{dayOfWeek:'Mon',direction:'PICKUP',time:'24:00'}]},{...response,proposals:[response.proposals[0]]}])assert.throws(()=>pure.parseReviewResponse(input,['Mon']));});
test('수업 전 등원·수업 후 하원 제안 기준을 다반 요일에도 적용한다',()=>{const classes=[{dayOfWeek:'Mon',startTime:'17:00',endTime:'17:55'},{dayOfWeek:'Mon',startTime:'18:00',endTime:'18:55'}];assert.throws(()=>pure.parseReviewResponse(response,['Mon'],classes));assert.doesNotThrow(()=>pure.parseReviewResponse({...response,proposals:[response.proposals[0],{dayOfWeek:'Mon',direction:'DROPOFF',time:'19:10'}]},['Mon'],classes));assert.throws(()=>pure.parseReviewResponse({...response,proposals:[{dayOfWeek:'Mon',direction:'PICKUP',time:'23:00'},response.proposals[1]]},['Mon'],classes));});
test('마이그레이션은 검토 표에 RLS·외부 역할 거부·현재 요청 유일성을 둔다',()=>{const sql=readFileSync('prisma/migrations/20261103130000_enrollment_shuttle_review/migration.sql','utf8');assert.match(sql,/ENABLE ROW LEVEL SECURITY/);assert.match(sql,/REVOKE ALL .* FROM PUBLIC, anon, authenticated/);assert.match(sql,/UNIQUE INDEX[\s\S]*WHERE status <> 'SUPERSEDED'/);assert.doesNotMatch(sql,/INSERT INTO|UPDATE "Regular|DELETE FROM/i);});
test('50개 뒤 신청도 페이지로 조회하며 hasMore가 누락을 알린다',async()=>{const f=fixture();f.state.apps=Array.from({length:51},(_,i)=>({...f.state.apps[0],id:`app-${i}`}));const first=await api.getShuttleIntakeDashboard(actor('admin'),'2026-11',true,f.db);assert.equal(first.items.length,50);assert.equal(first.page,1);assert.equal(first.hasMore,true);const second=await api.getShuttleIntakeDashboard(actor('admin'),'2026-11',true,f.db,2);assert.equal(second.items.length,1);assert.equal(second.page,2);assert.equal(second.hasMore,false);assert.equal(second.items[0].applicationId,'app-50');assert.equal(f.state.writes.length,0);for(const page of [0,-1,'01','1.5','NaN',1001])await assert.rejects(api.getShuttleIntakeDashboard(actor('admin'),'2026-11',true,f.db,page));});
test('신청을 변경 후 원래 값으로 복원해도 갱신 버전이 다르면 옛 검토는 부활하지 않는다',async()=>{const f=fixture();f.state.apps[0].applicationVersion='v1';const i=await pending(f);f.state.apps[0].applicationVersion='v3';await assert.rejects(api.submitShuttleReview(actor('driver'),{...i,...response},f.db),e=>e.status===409);});

// 2026-11-09 원장 발견: 금7+토2 학생에게 «토 등원/토 하원» 칸이 생김 — 셔틀 미운행 반(주말·성인반)은 검토 요일에서 뺀다.
test('셔틀 미운행 반(토요일·성인반)은 검토 요일·제안 시각에서 빠지고, 평일 운행 반은 그대로다',async()=>{
  const f=fixture();
  f.state.apps[0].assignedClassId='class-1,class-sat,class-adult';
  f.state.classes.push(
    {id:'class-sat',name:'통쾌한 주말경기반 토2',dayOfWeek:'Sat',startTime:'11:00',endTime:'11:55',enrollmentStartOn:'2026-11-02',runsShuttle:false},
    {id:'class-adult',name:'성인반',dayOfWeek:'Wed',startTime:'21:00',endTime:'22:00',enrollmentStartOn:'2026-11-02',runsShuttle:false},
  );
  const list=await api.getShuttleIntakeDashboard(actor('admin'),'2026-11',true,f.db);
  assert.deepEqual(list.items[0].classes.map(c=>c.id),['class-1']);
  // 기사님 제안도 평일 운행 반 요일만 받는다 — 토요일 제안은 거절, 월요일만으로 PROPOSED 가 된다.
  const input={applicationId:'app-1',serviceMonth:'2026-11',driverUserId:'driver',expectedFingerprint:list.items[0].fingerprint};
  const {id}=await api.assignShuttleReview(actor('admin'),input,f.db);
  const mon=[{dayOfWeek:'Mon',direction:'PICKUP',time:'16:40'},{dayOfWeek:'Mon',direction:'DROPOFF',time:'18:10'}];
  await assert.rejects(api.submitShuttleReview(actor('driver'),{reviewId:id,expectedFingerprint:input.expectedFingerprint,result:'PROPOSED',note:'확인',proposals:[...mon,{dayOfWeek:'Sat',direction:'PICKUP',time:'10:40'}]},f.db),e=>e.status===400);
  const ok=await api.submitShuttleReview(actor('driver'),{reviewId:id,expectedFingerprint:input.expectedFingerprint,result:'PROPOSED',note:'확인',proposals:mon},f.db);
  assert.equal(ok.status,'PROPOSED');
  // 운행 반이 하나도 없으면(토요일반만) 검토 목록에 올리지 않는다.
  const only=fixture();
  only.state.apps[0].assignedClassId='class-sat';
  only.state.classes=[{id:'class-sat',name:'통쾌한 주말경기반 토2',dayOfWeek:'Sat',startTime:'11:00',endTime:'11:55',enrollmentStartOn:'2026-11-02',runsShuttle:false}];
  assert.equal((await api.getShuttleIntakeDashboard(actor('admin'),'2026-11',true,only.db)).items.length,0);
});
