import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { loadChildAccess } from "./_child-access-fixture.mjs";
function load(file, dependencies={}) {
  const compiled=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports={};
  new Function("require","exports",compiled)(name=>{
    if(name in dependencies)return dependencies[name];
    throw new Error(`Unexpected dependency ${name}`);
  },exports);
  return exports;
}
const roles=load("src/lib/account/roles.ts");
const views=load("src/lib/account-views.ts",{"@/lib/account/roles":roles});
function guardFixture(withdrawn) {
  const row={id:"legacy-auth",name:"합성 보호자",role:"PARENT",username:null,phoneVerifiedAt:null};
  const queries=[];
  const prisma={$queryRawUnsafe:async(sql)=>{
    queries.push(sql);
    if(sql.includes('FROM "UserRoleGrant"'))return [];
    // DB의 WHERE 평가를 흉내 낸다. 인증 계정은 삭제됐어도 유효한 옛 JWT 자체는 반환된다.
    return withdrawn && /"withdrawnAt" IS NULL/.test(sql)?[]:[row];
  }};
  const childAccess=loadChildAccess(prisma);
  const auth=load("src/lib/auth-guard.ts",{
    "@/lib/prisma":{prisma},"@/lib/account/roles":roles,"@/lib/account/child-access":childAccess,
    "@/lib/supabase/server":{createClient:async()=>({auth:{getClaims:async()=>({data:{claims:{sub:"legacy-auth",role:"authenticated"}},error:null})}})},
  });
  const access=load("src/lib/account-view-access.ts",{
    "@/lib/prisma":{prisma},"@/lib/account/roles":roles,"@/lib/account/child-access":childAccess,
    "@/lib/auth-guard":auth,"@/lib/account-views":views,"@/lib/public-account":{getPublicAccountRole:async()=>"PARENT"},
  });
  return {auth,access,queries};
}
test("탈퇴 계정의 옛 JWT와 id fallback은 학부모 가드를 다시 열지 못한다",async()=>{
  const fixture=guardFixture(true);
  assert.equal((await fixture.auth.getVerifiedParentState()).status,"NO_APP_ACCOUNT");
  await assert.rejects(fixture.auth.requireVerifiedParent());
  assert.match(fixture.queries[0],/"withdrawnAt" IS NULL/);
});
test("탈퇴 계정은 옛 JWT가 있어도 역할 전환에 학부모 화면이 나타나지 않는다",async()=>{
  const fixture=guardFixture(true);
  const state=await fixture.access.getAccountViewAccess();
  assert.equal(state.views.some(view=>view.key==="parent"),false);
});
test("직접 연결된 활성 레거시 학부모의 기존 권한은 유지한다",async()=>{
  const fixture=guardFixture(false);
  assert.equal((await fixture.auth.getVerifiedParentState()).status,"OK");
  assert.equal((await fixture.access.getAccountViewAccess()).views.some(view=>view.key==="parent"),true);
});
const withdrawal=load("src/lib/account/child-withdrawal.ts");
test("기능 off여도 실제 탈퇴는 새 개인정보 원장과 본인 권한을 정리한다",async()=>{
  const writes=[];
  await withdrawal.anonymizeChildConnections({
    $queryRawUnsafe:async()=>[{access:true,request:true,challenge:true}],
    $executeRawUnsafe:async(sql,...args)=>{writes.push({sql,args});return 1;},
  },"withdrawn-fixture");
  assert.equal(writes.length,4);
  assert.ok(writes.every(row=>row.args[0]==="withdrawn-fixture"));
  assert.match(writes[0].sql,/status='REVOKED'/);
  assert.match(writes[1].sql,/"requesterName"='탈퇴한 회원',"requesterPhoneLast4"=''/);
  assert.match(writes[2].sql,/WHERE "approverId"=\$1/);
  assert.match(writes[3].sql,/"phoneHash"=NULL/);
  assert.match(writes[3].sql,/"proofUsedAt"=NOW\(\)/);
  assert.ok(writes.every(row=>!/DELETE|UPDATE "Student"|UPDATE "Payment"/.test(row.sql)));
});
test("새 원장이 없는 환경은 기존 탈퇴 처리에 쿼리를 추가하지 않는다",async()=>{
  let writes=0;
  await withdrawal.anonymizeChildConnections({$queryRawUnsafe:async()=>[{access:false,request:false,challenge:false}],$executeRawUnsafe:async()=>{writes++;}},"fixture");
  assert.equal(writes,0);
});
