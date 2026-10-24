import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
// 시트 은퇴 스위치(순수 판정, DB·외부 접근 없음)는 실제 모듈을 그대로 쓴다(2026-10-06).
import * as sheetRetirement from '../src/lib/operations-sync/sheetRetirement.ts';
const source = readFileSync('src/app/actions/kakao-parent-intake-admin.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const revision = '2026-09-09 01:00:00.123456+00';
// 실제 서버 함수를 실행하지만 DB 잠금·시각은 가짜 거래로 대체한다. 운영 모듈은 가져오지 않는다.
function fixture(options = {}) {
  const initial = { id:'intake-test', revision, status:'CONSULTATION', kind:'CONTACT_CHANGE', sourceText:'synthetic request',
    studentId:'student-test', studentName:'test-student', parentUserId:'parent-test', studentParentId:'parent-test',
    identityStatus:'ACTIVE', structuredJson:{ studentId:'student-test', effectiveDate:'2026-09-10', details:'synthetic detail' },
    targetMonth:'2026-09', operationsRequestId:null, ...options.row };
  let state = { row:structuredClone(initial), writes:[] };
  const calls = { attempted:0, query:0, infrastructure:0, cache:[] };
  let tail = Promise.resolve();
  async function execute(sql, ...args) {
    calls.attempted++;
    if (sql.includes('UPDATE "KakaoParentIntake"')) {
      if (sql.includes("SET status='APPROVED'")) {
        assert.equal(state.row.status, 'PROCESSING');
        state.row.status='APPROVED'; state.row.operationsRequestId=args[3];
      } else {
        const transfer = sql.includes("SET status='PROCESSING'");
        const statusIndex = transfer ? 1 : 4;
        const revisionIndex = transfer ? 2 : 5;
        assert.match(sql, new RegExp('status=\\$' + (statusIndex + 1)));
        assert.match(sql, new RegExp('"updatedAt"=\\$' + (revisionIndex + 1) + '::timestamptz'));
        assert.match(sql, /"operationsRequestId" IS NULL/);
        assert.match(sql, /GREATEST\(clock_timestamp\(\),"updatedAt"\+interval '1 microsecond'\)/);
        if (state.row.status !== args[statusIndex] || state.row.revision !== args[revisionIndex] || state.row.operationsRequestId) return 0;
        state.row.status = transfer ? 'PROCESSING' : args[1];
        if (!transfer) {
          assert.match(sql, /"decidedAt"=now\(\)/);
          state.row.decidedByUserId=args[2]; state.row.decisionNote=args[3]; state.row.decidedAt='synthetic transaction time';
        }
      }
      state.row.revision += '1';
    } else if (sql.includes('INSERT INTO "KakaoParentIntakeAudit"') && options.auditFail) {
      throw new Error('synthetic audit failure');
    } else {
      assert.match(sql, /INSERT INTO "(KakaoParentIntakeAudit|OperationsRequest|OperationsCommand|OperationsSyncAttempt|OperationsAuditLog)"/);
    }
    state.writes.push({ sql,args });
    return 1;
  }
  const prisma = {
    async $queryRawUnsafe(sql) { calls.query++; assert.match(sql, /"updatedAt"::text AS revision/); return options.missing ? [] : [structuredClone(state.row)]; },
    async $transaction(fn) {
      const preceding=tail; let release;
      tail=new Promise(resolve => { release=resolve; });
      await preceding;
      const before=structuredClone(state);
      try { return await fn({ $executeRawUnsafe:execute, $queryRawUnsafe:async () => { throw new Error('unexpected query'); } }); }
      catch (error) { state=before; throw error; }
      finally { release(); }
    },
  };
  const dependencies = {
    'next/cache':{ revalidatePath:path => calls.cache.push(path) },
    '@/lib/auth-guard':{ requireAdmin:async () => { if(options.unauthorized) throw new Error('unauthorized'); return { appUserId:'admin-test' }; } },
    '@/lib/prisma':{ prisma },
    '@/lib/operationsSync':{ operationsRequestKey:() => 'synthetic-key', SYNC_TARGETS:['WEBSITE','SHEET','RALLYZ'] },
    '@/lib/operationsSyncInfrastructure':{ ensureOperationsSyncInfrastructure:async () => { calls.infrastructure++; } },
    '@/lib/operations-sync/sheetRetirement':sheetRetirement,
  };
  const exports={};
  vm.compileFunction(compiled,['require','exports','crypto'])(id => { assert.ok(Object.hasOwn(dependencies,id),id); return dependencies[id]; },exports,{randomUUID});
  return { calls, get state(){return state;}, run:input => exports.decideKakaoParentIntake({ intakeId:'intake-test', decision:'CLOSE_CONSULTATION', note:'reason', expectedRevision:revision, ...input }) };
}
test('관리자 권한 실패는 조회와 쓰기 전에 거절', async () => {
  const f=fixture({unauthorized:true}); await assert.rejects(f.run(),/unauthorized/);
  assert.equal(f.calls.query,0); assert.equal(f.calls.attempted,0); assert.equal(f.calls.infrastructure,0);
});
test('빈 종결 사유와 알 수 없는 처리 및 누락 버전은 쓰기 차단', async () => {
  for(const input of [{note:'  '},{decision:'UNKNOWN'},{expectedRevision:''},{expectedRevision:undefined}]) {
    const f=fixture(); assert.equal((await f.run(input)).ok,false); assert.equal(f.calls.attempted,0);
  }
});
test('종결 사유 500자 초과는 쓰기 차단',async()=>{
  const f=fixture(); await assert.rejects(f.run({note:'a'.repeat(501)})); assert.equal(f.calls.attempted,0);
});
test('종결은 사유 처리자 시각과 감사 저장, 외부 처리 없음',async()=>{
  const f=fixture(); assert.deepEqual(await f.run({note:'  closed reason  '}),{ok:true,status:'CONSULTATION_CLOSED'});
  assert.equal(f.state.row.decisionNote,'closed reason'); assert.equal(f.state.row.decidedByUserId,'admin-test'); assert.ok(f.state.row.decidedAt);
  assert.equal(f.state.writes.length,2);
  const audit=f.state.writes[1].args;
  assert.deepEqual(audit.slice(2,7),['CLOSE_CONSULTATION','admin-test','CONSULTATION','CONSULTATION_CLOSED','closed reason']);
  assert.deepEqual(JSON.parse(audit[7]),{externalMessageSent:false,operationsCreated:false,enrollmentApplied:false,billingApplied:false});
});
test('감사 실패 시 상태와 기록 모두 롤백',async()=>{
  const f=fixture({auditFail:true}); await assert.rejects(f.run(),/audit/);
  assert.equal(f.state.row.status,'CONSULTATION'); assert.equal(f.state.row.revision,revision);
  assert.equal(f.state.writes.length,0); assert.equal(f.calls.cache.length,0);
});
test('두 관리자 동시 종결은 한 번만 성공',async()=>{
  const f=fixture(); const results=await Promise.all([f.run(),f.run()]);
  assert.equal(results.filter(r=>r.ok).length,1); assert.equal(f.state.writes.length,2);
  assert.match(results.find(r=>!r.ok).message,/새로고침/);
});
test('중복 클릭은 한 번 성공하고 다시 조회 안내',async()=>{
  const f=fixture(); assert.equal((await f.run()).ok,true); assert.equal((await f.run()).ok,false); assert.equal(f.state.writes.length,2);
});
test('동일 상태 재수정도 이전 revision으로 덮어쓸 수 없다',async()=>{
  const f=fixture({row:{status:'NEEDS_DETAILS'}});
  assert.equal((await f.run({decision:'NEEDS_DETAILS'})).ok,true);
  assert.equal(f.state.row.status,'NEEDS_DETAILS');
  assert.equal((await f.run({decision:'NEEDS_DETAILS',note:'stale'})).ok,false);
  assert.equal(f.state.row.decisionNote,'reason');
});
test('동일 상태 동시 재수정 경쟁은 한 번만 성공',async()=>{
  const f=fixture({row:{status:'NEEDS_DETAILS'}});
  const results=await Promise.all([f.run({decision:'NEEDS_DETAILS'}),f.run({decision:'NEEDS_DETAILS',note:'other'})]);
  assert.equal(results.filter(r=>r.ok).length,1); assert.equal(f.state.writes.length,2);
});
test('종결 상태 및 이미 이관한 요청 재처리 거절',async()=>{
  for(const row of [{status:'CONSULTATION_CLOSED'},{status:'APPLIED'},{status:'REJECTED'},{status:'CANCELED'},{status:'APPROVED'},{operationsRequestId:'existing'}]) {
    const f=fixture({row}); assert.equal((await f.run()).ok,false); assert.equal(f.calls.attempted,0);
  }
});
test('상담 이외 상태에서 종결 시도 거절',async()=>{
  for(const status of ['SUBMITTED','HELD','FAILED','NEEDS_DETAILS']) {
    const f=fixture({row:{status}}); assert.equal((await f.run()).ok,false); assert.equal(f.calls.attempted,0);
  }
});
test('상담에서 추가확인으로 이동 가능',async()=>{
  const f=fixture(); assert.equal((await f.run({decision:'NEEDS_DETAILS'})).status,'NEEDS_DETAILS');
  assert.equal(f.state.writes[1].args[4],'CONSULTATION');
});
test('운영 이관 인증 및 안정 학생 ID 보호',async()=>{
  for(const row of [{identityStatus:'PENDING'},{parentUserId:null},{studentId:null},{studentName:null},{structuredJson:{studentId:'other'}}]) {
    const f=fixture({row}); assert.equal((await f.run({decision:'TRANSFER'})).ok,false); assert.equal(f.calls.attempted,0);
  }
});
test('보호자 연결 불일치는 이관 거래를 롤백',async()=>{
  const f=fixture({row:{studentParentId:'other-parent'}});
  await assert.rejects(f.run({decision:'TRANSFER'})); assert.equal(f.state.row.status,'CONSULTATION'); assert.equal(f.state.writes.length,0);
});
test('일치한 상담 이관은 보호자 확인과 청구/알림 HELD를 보존',async()=>{
  const f=fixture(); assert.equal((await f.run({decision:'TRANSFER'})).status,'APPROVED');
  const command=f.state.writes.find(w=>w.sql.includes('INSERT INTO "OperationsCommand"'));
  assert.match(command.sql,/'HELD','HELD'/); const payload=JSON.parse(command.args[8]);
  assert.equal(payload.parentConfirmed,true); assert.equal(payload.parentReconfirmationRequired,false);
  const audit=f.state.writes.find(w=>w.sql.includes('INSERT INTO "KakaoParentIntakeAudit"'));
  assert.equal(JSON.parse(audit.args[5]).externalWrites,false); assert.equal(JSON.parse(audit.args[5]).notificationsSent,false);
});
test('관리자가 변경한 내용 이관은 학부모 재확인을 계속 요구',async()=>{
  const f=fixture(); assert.equal((await f.run({decision:'TRANSFER',review:{details:'changed'}})).ok,true);
  const payload=JSON.parse(f.state.writes.find(w=>w.sql.includes('INSERT INTO "OperationsCommand"')).args[8]);
  assert.equal(payload.parentConfirmed,false); assert.equal(payload.parentReconfirmationRequired,true);
});
test('운영 이관 감사 실패도 원장과 상태를 모두 롤백',async()=>{
  const f=fixture({auditFail:true}); await assert.rejects(f.run({decision:'TRANSFER'}),/audit/);
  assert.equal(f.state.row.status,'CONSULTATION'); assert.equal(f.state.writes.length,0);
});
test('동시 운영 이관은 원장 하나만 생성',async()=>{
  const f=fixture(); const results=await Promise.all([f.run({decision:'TRANSFER'}),f.run({decision:'TRANSFER'})]);
  assert.equal(results.filter(r=>r.ok).length,1); assert.equal(f.state.writes.filter(w=>w.sql.includes('INSERT INTO "OperationsRequest"')).length,1);
});
