import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
function load(file, deps={}) {
  const js=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};new Function('require','exports',js)(name=>{if(name in deps)return deps[name];throw Error(`Unexpected ${name}`)},exports);return exports;
}
const withdrawal=load('src/lib/account/withdrawal.ts');
const policy=load('src/lib/account/account-withdrawal-policy.ts',{'./withdrawal':withdrawal});
function ownFixture({authId='auth-own',rows=[{id:'own',name:'합성 회원',role:'INSTRUCTOR'}],error=null}={}) {
  const calls=[];
  const module=load('src/lib/account/own-account.ts',{'server-only':{},'@/lib/prisma':{prisma:{$queryRawUnsafe:async(sql,...args)=>{calls.push({sql,args});return rows}}},'@/lib/supabase/server':{createClient:async()=>({auth:{getUser:async()=>({data:{user:authId?{id:authId,email:'ignored@invalid',user_metadata:{role:'ADMIN'}}:null},error})}})}});
  return {module,calls};
}
test('본인 계정은 신선한 인증ID에 직접 연결된 무자녀 직원도 허용한다',async()=>{
  const f=ownFixture();assert.equal((await f.module.requireOwnAccount()).appUserRole,'INSTRUCTOR');assert.deepEqual(f.calls[0].args,['auth-own']);assert.match(f.calls[0].sql,/"withdrawnAt" IS NULL/);assert.doesNotMatch(f.calls[0].sql,/email|metadata/);
});
test('무로그인·인증오류·미연결·중복연결은 본인계정으로 인정하지 않는다',async()=>{
 for(const options of [{authId:null},{error:{message:'expired'}},{rows:[]},{rows:[{id:'a'},{id:'b'}]}]) {const f=ownFixture(options);await assert.rejects(f.module.requireOwnAccount());}
});
test('정책은 관리자·직원·역할부여·업무·재학생과 불명확한 집계를 즉시 삭제하지 않는다',()=>{
 const base={role:'PARENT',activeEnrollmentCount:0,activeStaffGrantCount:0,activeWorkCount:0};
 assert.equal(policy.accountWithdrawalPolicy(base).immediate,true);
 for(const change of [{role:'ADMIN'},{role:'VICE_ADMIN'},{role:'INSTRUCTOR'},{role:'DRIVER'},{activeStaffGrantCount:1},{activeWorkCount:1},{activeWorkCount:undefined},{activeStaffGrantCount:null},{activeEnrollmentCount:1}])assert.equal(policy.accountWithdrawalPolicy({...base,...change}).immediate,false,JSON.stringify(change));
});
function actionFixture(options={}) {
 const events=[];let identityCalls=0;let actor=options.actor??{appUserId:'own',authUserId:'auth-own',appUserRole:'PARENT'};
 let row={id:'own',role:'PARENT',authUserId:'auth-own',activeEnrollments:0,activeStaffGrantCount:0,activeWorkCount:0,withdrawRequestedAt:new Date(),withdrawnAt:null,...options.row};
 const own=ownFixture().module;
 const tx={$queryRawUnsafe:async(sql)=>/role::text/.test(sql)?[{role:options.freshRole??actor.appUserRole}]:[{id:row.id}],$executeRawUnsafe:async(sql)=>{events.push(sql);if(options.dbFails&&sql.includes('UPDATE "User"'))throw Error('synthetic DB failure');return 1}};
 const module=load('src/app/actions/parent-account.ts',{
 '@\/unused':{},'next/headers':{cookies:async()=>({})},'next/cache':{revalidatePath:()=>{}},'@/lib/account/own-account':{...own,requireOwnAccount:async()=>{identityCalls++;if(options.removedAfterLock && identityCalls>1)throw new own.OwnAccountError("로그인이 필요합니다.");if(!actor)throw new own.OwnAccountError('로그인이 필요합니다.');return actor}},'@/lib/account/account-withdrawal-data':{readWithdrawalRecord:async()=>row},'@/lib/account/account-withdrawal-policy':policy,'@/lib/account/withdrawal':withdrawal,'@/lib/parent-account-claim':{},'@/lib/account/child-withdrawal':{anonymizeChildConnections:async()=>events.push('childCleanup')},'@/lib/prisma':{prisma:{$transaction:async fn=>fn(tx),$executeRawUnsafe:async()=>1}},'@/lib/supabase/admin':{createAdminClient:()=>({auth:{admin:{deleteUser:async id=>{events.push(`Auth:${id}`);return {error:options.authError??null}}}}})},'@/lib/supabase/server':{createClient:async()=>({auth:{signOut:async()=>events.push('signOut')}})} });
 return {module,events,setActor:value=>actor=value};
}
test('공개 탈퇴 실행 자체가 무로그인과 타인 계정 ID를 차단한다',async()=>{
 for(const target of ['other','own']) {const f=actionFixture();if(target==='own')f.setActor(null);assert.ok((await f.module.executeAccountWithdrawal(target)).error);assert.equal(f.events.length,0);}
});
test('접수 없는 직접 실행·직원 본인·재학생 보호자·관리자 자기삭제를 차단한다',async()=>{
 for(const row of [{withdrawRequestedAt:null},{role:'INSTRUCTOR'},{activeEnrollments:1},{role:'ADMIN'},{role:'VICE_ADMIN'},{activeStaffGrantCount:1}]) {const f=actionFixture({row});assert.ok((await f.module.executeAccountWithdrawal('own')).error);assert.equal(f.events.length,0);}
});
test('일반 본인계정은 Auth 삭제 후 익명화하고 학원 업무 장부는 지우지 않는다',async()=>{
 const f=actionFixture();assert.equal((await f.module.executeAccountWithdrawal('own')).ok,true);assert.equal(f.events[0],'Auth:auth-own');assert.match(f.events[1],/UPDATE "User"/);assert.ok(f.events.includes('childCleanup'));for(const e of f.events)assert.doesNotMatch(e,/DELETE FROM "(?:Student|Enrollment|Payment|Attendance|Session)"/);
});
test('관리자는 접수된 직원만 업무 이관 후 처리하며 실제 DB 역할을 재검사한다',async()=>{
 const actor={appUserId:'admin',authUserId:'auth-admin',appUserRole:'ADMIN'};
 const ok=actionFixture({actor,row:{id:'target',role:'INSTRUCTOR',authUserId:'auth-target'}});assert.equal((await ok.module.executeAccountWithdrawal('target')).ok,true);assert.equal(ok.events[0],'Auth:auth-target');
 for(const options of [{freshRole:'PARENT'},{row:{activeWorkCount:1}},{row:{role:'ADMIN'}},{row:{role:'VICE_ADMIN'}}]) {const f=actionFixture({actor,...options});assert.ok((await f.module.executeAccountWithdrawal('target')).error);assert.equal(f.events.length,0);}
});
test('Auth 오류나 Auth 성공 후 DB 실패는 완료라고 응답하지 않고 관리자 재시도를 허용한다',async()=>{
 const failed=actionFixture({authError:{message:'provider failed'}});assert.ok((await failed.module.executeAccountWithdrawal('own')).error);assert.equal(failed.events.length,1);
 const partial=actionFixture({dbFails:true});assert.ok((await partial.module.executeAccountWithdrawal('own')).error);
 const retry=actionFixture({actor:{appUserId:'admin',authUserId:'auth-admin',appUserRole:'ADMIN'},authError:{message:'user_not_found'},row:{id:'own'}});assert.equal((await retry.module.executeAccountWithdrawal('own')).ok,true);
});
test('공통 계정과 탈퇴는 학부모 자녀 가드를 완화하지 않고 별도 직접 인증을 쓴다',()=>{
 for(const path of ['src/app/account/page.tsx','src/app/account/withdraw/page.tsx'])assert.match(fs.readFileSync(path,'utf8'),/requireOwnAccount\(\)/);
 assert.match(fs.readFileSync('src/app/mypage/layout.tsx','utf8'),/requireVerifiedParent/);
 assert.match(fs.readFileSync('src/app/staff/StaffProfileMenu.tsx','utf8'),/href="\/account"/);
});

test('다른 서버에서 탈퇴한 직원은 남아 있는 역할 캐시와 옛 JWT로 업무 화면을 다시 열지 못한다',async()=>{
 const roles=load('src/lib/account/roles.ts');
 for(const role of ['ADMIN','INSTRUCTOR','DRIVER']) {
  let withdrawn=false;const queries=[];
  const guard=load('src/lib/auth-guard.ts',{
   '@/lib/prisma':{prisma:{$queryRawUnsafe:async sql=>{queries.push(sql);if(sql.includes('UserRoleGrant'))return [];return withdrawn?[]:[{id:'own',name:'합성 직원',role}];}}},
   '@/lib/account/roles':roles,'@/lib/account/child-access':{},
   '@/lib/supabase/server':{createClient:async()=>({auth:{getClaims:async()=>({data:{claims:{sub:'auth-own',email:'synthetic@invalid'}},error:null})}})},
  });
  const enter=role==='ADMIN'?()=>guard.requireAdmin():()=>guard.requireStaff();
  assert.equal((await enter()).appUserId,'own');assert.equal((await enter()).appUserId,'own');
  withdrawn=true;await assert.rejects(enter());
  assert.ok(queries.some(sql=>/WHERE id = \$1 AND "withdrawnAt" IS NULL/.test(sql)));
 }
});

test('공통 인증은 Auth삭제·DB정리실패로 남은 PENDING의 옛 JWT와 직접액션 접근을 차단한다',async()=>{
 const roles=load('src/lib/account/roles.ts');
 for(const scenario of ['removed','swapped','provider-error','withdrawn','db-error','live','ordinary','anonymized','ambiguous','unbound-live']) {
  let freshCalls=0;
  const guard=load('src/lib/auth-guard.ts',{
   '@/lib/prisma':{prisma:{$queryRawUnsafe:async()=>{if(scenario==='db-error')throw Error('synthetic offline');if(scenario==='ordinary')return [{}];if(['anonymized','unbound-live'].includes(scenario))return [];if(scenario==='ambiguous')return [{},{}];return [{withdrawRequestedAt:new Date(),withdrawnAt:scenario==='withdrawn'?new Date():null}];}}},
   '@/lib/account/roles':roles,'@/lib/account/child-access':{},
   '@/lib/supabase/server':{createClient:async()=>({auth:{getClaims:async()=>({data:{claims:{sub:'auth-own',email:'synthetic@invalid'}},error:null}),getUser:async()=>{freshCalls++;return {data:{user:['removed','anonymized'].includes(scenario)?null:{id:scenario==='swapped'?'foreign-auth':'auth-own'}},error:scenario==='provider-error'?{message:'expired'}:null}}}})},
  });
  if(['live','ordinary','unbound-live'].includes(scenario))assert.equal((await guard.requireAuth()).id,'auth-own');else await assert.rejects(guard.requireAuth());
  assert.equal(freshCalls,['removed','swapped','provider-error','live','anonymized','unbound-live'].includes(scenario)?1:0,scenario);
 }
});

test('삭제 잠금을 기다린 본인 취소는 Auth 재검증 실패 시 PENDING 마커를 보존한다',async()=>{
 const stopped=actionFixture({removedAfterLock:true});assert.ok((await stopped.module.cancelAccountWithdrawalRequest()).error);assert.equal(stopped.events.length,0);
 const live=actionFixture();assert.equal((await live.module.cancelAccountWithdrawalRequest()).ok,true);assert.match(live.events[0],/"withdrawRequestedAt" = NULL/);
});
test('관리자 반려는 같은 행 잠금 뒤 대상 Auth를 확인하고 부분삭제·미연결·실패 시 마커를 보존한다',async()=>{
 const OwnAccountError=ownFixture().module.OwnAccountError;
 for(const scenario of ['live','removed','unbound','wrong-id','provider-error','cas-zero']) {
  const events=[];
  const tx={$queryRawUnsafe:async sql=>{if(sql.includes('FOR UPDATE')){events.push('lock');return [{id:'target'}];}return [{authUserId:scenario==='unbound'?null:'auth-target',withdrawRequestedAt:new Date(),withdrawnAt:null}];},$executeRawUnsafe:async()=>{events.push('clear');return scenario==='cas-zero'?0:1}};
  const module=load('src/app/actions/account-withdrawal-admin.ts',{
   'next/cache':{revalidatePath:()=>{}},'@/lib/auth-guard':{requireAdmin:async()=>({appUserId:'admin'})},'@/app/actions/parent-account':{},'@/lib/account/account-withdrawal-data':{},'@/lib/account/account-withdrawal-policy':{},
   '@/lib/account/own-account':{OwnAccountError,requireOwnAccount:async()=>({appUserId:'admin',authUserId:'auth-admin',appUserRole:'ADMIN'})},
   '@/lib/prisma':{prisma:{$transaction:async fn=>fn(tx)}},'@/lib/supabase/admin':{createAdminClient:()=>({auth:{admin:{getUserById:async()=>{events.push('provider');return {data:{user:scenario==='removed'?null:{id:scenario==='wrong-id'?'foreign':'auth-target'}},error:scenario==='provider-error'?{message:'offline'}:null};}}}})},
  });
  const result=await module.rejectWithdrawalRequest('target');
  assert.equal(events[0],'lock');
  if(scenario==='live'){assert.equal(result.ok,true);assert.deepEqual(events,['lock','provider','clear']);}
  else {assert.ok(result.error,scenario);if(scenario!=='cas-zero')assert.equal(events.includes('clear'),false,scenario);}
 }
});
