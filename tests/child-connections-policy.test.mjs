import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadTsModule } from "./_ts-module.mjs";
import { loadChildAccess } from "./_child-access-fixture.mjs";

const policy=await loadTsModule("src/lib/account/child-link-policy.ts");
test("성인 자신 연결의 생일 전날·당일·다음날 경계",()=>{
  assert.equal(policy.canConnectSelf("2007-10-27","2026-10-26"),false);
  assert.equal(policy.canConnectSelf("2007-10-27","2026-10-27"),true);
  assert.equal(policy.canConnectSelf("2007-10-27","2026-10-28"),true);
});
test("윤년 생일은 달력 날짜를 지나야 하고 허구의 생일은 거절",()=>{
  assert.equal(policy.canConnectSelf("2008-02-29","2027-02-28"),false);
  assert.equal(policy.canConnectSelf("2008-02-29","2027-03-01"),true);
  for(const birth of ["2026-02-29","2007-13-01","not-date","2027-01-01"])
    assert.equal(policy.canConnectSelf(birth,"2026-10-27"),false);
});
test("등록된 이름·번호의 서식 차이만 정리",()=>{
  assert.equal(policy.identityName(" 김 수빈 ".normalize("NFD")),"김수빈");
  assert.notEqual(policy.identityName("김수빈"),policy.identityName("김수민"));
  assert.equal(policy.identityPhone("010-1234-5678"),"01012345678");
});
test("기본 off면 추가 표를 조회하지 않고 기존 SQL/ORM 권한 유지",async()=>{
  const before=process.env.CHILD_CONNECTIONS_ENABLED;
  delete process.env.CHILD_CONNECTIONS_ENABLED;
  const access=loadChildAccess({$queryRawUnsafe(){throw new Error("must-not-query");}});
  try{
    assert.equal(await access.childAccessSql("s","$2"),'s."parentId" = $2');
    assert.deepEqual(await access.childAccessWhere("parent"),{parentId:"parent"});
  }finally{if(before===undefined)delete process.env.CHILD_CONNECTIONS_ENABLED;else process.env.CHILD_CONNECTIONS_ENABLED=before;}
});
test("활성화했어도 새 표 확인 실패면 기존 접근만 유지",async()=>{
  const before=process.env.CHILD_CONNECTIONS_ENABLED;process.env.CHILD_CONNECTIONS_ENABLED="true";
  try{
    const access=loadChildAccess({$queryRawUnsafe:async()=>{throw new Error("schema unavailable");}});
    assert.equal(await access.childConnectionsAvailable(),false);
    assert.equal(await access.childAccessSql("s","$1"),'s."parentId" = $1');
  }finally{if(before===undefined)delete process.env.CHILD_CONNECTIONS_ENABLED;else process.env.CHILD_CONNECTIONS_ENABLED=before;}
});
test("연결 권한 SQL은 ACTIVE·탈퇴상태를 매번 읽고 입력식 SQL 삽입을 거절",async()=>{
  const before=process.env.CHILD_CONNECTIONS_ENABLED;process.env.CHILD_CONNECTIONS_ENABLED="true";
  let count=0;
  const access=loadChildAccess({$queryRawUnsafe:async()=>{count++;return [{ready:true}];}});
  try{
    for(let i=0;i<2;i++){
      const sql=await access.childAccessSql("s","$1");
      assert.match(sql,/child_access\.status = 'ACTIVE'/);
      assert.match(sql,/"withdrawnAt" IS NULL/);
    }
    assert.equal(count,2,"권한/스키마 상태를 프로세스 캐시에 가두지 않는다");
    await assert.rejects(access.childAccessSql("s;DELETE", "$1"));
    await assert.rejects(access.childAccessSql("s", "$1 OR TRUE"));
  }finally{if(before===undefined)delete process.env.CHILD_CONNECTIONS_ENABLED;else process.env.CHILD_CONNECTIONS_ENABLED=before;}
});
test("새 원장은 공개 API 직접 접근을 차단하고 가족요청에는 학원승인 우회가 없다",async()=>{
  const migration=await readFile("prisma/migrations/20261026150427_add_child_connections/migration.sql","utf8");
  for(const table of ["ParentStudentAccess","ChildIdentityChallenge","ChildLinkRequest"]){
    assert.ok(migration.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
    assert.ok(migration.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
  }
  assert.match(migration,/REVOKE ALL/);
  const source=await readFile("src/lib/account/child-links.ts","utf8");
  assert.doesNotMatch(source,/PENDING_ACADEMY|sendAuthenticationSms|notifyAdmins|sendMessage|auth\.admin|UPDATE "Student"/);
});
