import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 실제 사고(2026-11-09): 목록 «원생 등록»이 학부모 계정을 **이메일로만** 찾고, 찾으면 그 계정의 이름·번호를
// 입력값으로 덮어썼다(역할 확인 없음). 원장이 자기 이메일을 넣자 학생이 원장(ADMIN) 계정에 붙고
// 원장 계정 이름·번호가 학부모 값으로 바뀌었다. 체험 «정규 전환»도 같은 코드 복사본이었다.
// 또 목록 «수정»은 이메일을 안 넘기는데 서버가 User.email = NULL(NOT NULL)로 덮어 늘 실패했다.
// 연결 규칙은 parentAccountLink 한 곳 — 순수 판정은 실행해서, 트랜잭션 연결부는 가짜 db 로 실행해서 확인한다.

const link = await loadTsModule("src/lib/students/parentAccountLink.ts");
const admin = await readFile("src/app/actions/admin.ts", "utf8");
const listClient = await readFile("src/app/admin/students/StudentManagementClient.tsx", "utf8");
const trialModals = await readFile("src/app/admin/trial/TrialCrmModals.tsx", "utf8");
const approvalSource = await readFile("src/lib/enrollment/approval-parent.ts", "utf8");

/** admin.ts 에서 함수 하나의 본문만 잘라 온다(다음 export 직전까지) */
function fnBlock(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} 를 찾지 못했습니다`);
  const next = source.indexOf("\nexport ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

/** SQL 을 기록하고 정해 둔 행을 돌려주는 가짜 트랜잭션 */
function fakeTx({ phoneRows = [], conflictOnPlaceholder = false } = {}) {
  const calls = [];
  return {
    calls,
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes("pg_advisory_xact_lock")) return [{ locked: 1 }];
      if (sql.includes('FROM "User"') && sql.includes("FOR UPDATE")) return phoneRows;
      if (sql.includes('INSERT INTO "User"') && sql.includes("ON CONFLICT (email) DO NOTHING")) {
        return conflictOnPlaceholder ? [] : [{ id: "new-parent" }];
      }
      if (sql.includes('INSERT INTO "User"')) return [{ id: "fallback-parent" }];
      throw new Error(`예상하지 못한 SQL: ${sql}`);
    },
    async $executeRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      return 1;
    },
  };
}

const guardian = { relation: "엄마", name: "김엄마", phone: "01012345678" };

test("주 보호자는 관계·이름·휴대폰이 모두 필요하고 번호는 숫자만으로 저장한다", () => {
  const ok = link.validatePrimaryGuardian({ relation: " 엄마 ", name: " 김엄마 ", phone: "010-1234-5678" });
  assert.deepEqual(ok, { ok: true, value: guardian });
  assert.equal(link.validatePrimaryGuardian({ relation: "엄마", name: "김엄마", phone: "+82 10-1234-5678" }).value.phone, "01012345678");
  assert.equal(link.validatePrimaryGuardian({ name: "김엄마", phone: "01012345678" }).ok, false, "관계 없음");
  assert.equal(link.validatePrimaryGuardian({ relation: "엄마", phone: "01012345678" }).ok, false, "이름 없음");
  assert.equal(link.validatePrimaryGuardian({ relation: "엄마", name: "김엄마" }).ok, false, "번호 없음");
  // 자리채움·짧은 번호로 남의 계정에 붙는 일을 막는다
  assert.equal(link.validatePrimaryGuardian({ relation: "엄마", name: "김엄마", phone: "000-0000-0000" }).ok, false);
  assert.equal(link.validatePrimaryGuardian({ relation: "엄마", name: "김엄마", phone: "0101234" }).ok, false);
});

test("PARENT 가 1순위, PARENT 가 없으면 같은 번호 직원 1명에 붙인다(원장 결정 «직원 자녀는 그냥 붙여»)", () => {
  assert.deepEqual(link.decideParentAccount([]), { kind: "CREATE_NEW" });
  assert.deepEqual(link.decideParentAccount([{ id: "p1", role: "PARENT" }]), { kind: "USE_EXISTING", parentId: "p1", staffAccount: false });
  // 직원만 1명 → 그 직원 계정(새 빈 학부모 계정을 만들지 않는다)
  for (const role of ["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER"]) {
    assert.deepEqual(link.decideParentAccount([{ id: "s1", role }]), { kind: "USE_EXISTING", parentId: "s1", staffAccount: true }, role);
  }
  // PARENT 와 직원이 같이 있으면 PARENT 우선
  assert.deepEqual(
    link.decideParentAccount([{ id: "s1", role: "ADMIN" }, { id: "p1", role: "PARENT" }]),
    { kind: "USE_EXISTING", parentId: "p1", staffAccount: false },
  );
  // 같은 등급 후보가 2명 이상이면 자동 연결하지 않는다
  assert.deepEqual(link.decideParentAccount([{ id: "p1", role: "PARENT" }, { id: "p2", role: "PARENT" }]), { kind: "AMBIGUOUS", accountCount: 2 });
  assert.deepEqual(
    link.decideParentAccount([{ id: "p1", role: "PARENT" }, { id: "p2", role: "PARENT" }, { id: "s1", role: "ADMIN" }]),
    { kind: "AMBIGUOUS", accountCount: 2 },
    "PARENT 가 여럿이면 직원 계정으로 피해 가지 않는다",
  );
  assert.deepEqual(link.decideParentAccount([{ id: "s1", role: "ADMIN" }, { id: "s2", role: "DRIVER" }]), { kind: "AMBIGUOUS", accountCount: 2 });
  // 직원 목록 밖의 역할은 후보가 아니다
  assert.deepEqual(link.decideParentAccount([{ id: "x1", role: "UNKNOWN" }]), { kind: "CREATE_NEW" });
});

test("빈 계정 이메일·잠금 열쇠는 신청서 승인 경로와 같은 형식", () => {
  assert.equal(link.placeholderParentEmail("01012345678"), "parent_01012345678@stiz.local");
  assert.equal(link.parentPhoneLockKey("01012345678"), "enrollment-parent:01012345678");
  // 승인 경로가 같은 형식을 쓰는지(형식이 갈라지면 학부모 가입 자동 연결이 한쪽만 된다)
  assert.match(admin, /`parent_\$\{parentPhoneDigitsValue\}@stiz\.local`/);
  assert.match(approvalSource, /`enrollment-parent:\$\{parentPhoneDigits\(/);
});

test("관리자 화면이 고칠 수 있는 학부모 계정 = 학원이 만든 빈 계정뿐", () => {
  assert.equal(link.canAdminEditParentAccount({ role: "PARENT", authUserId: null, email: "parent_01012345678@stiz.local" }), true);
  assert.equal(link.canAdminEditParentAccount({ role: "PARENT", authUserId: "auth-1", email: "parent_01012345678@stiz.local" }), false, "로그인 연결된 학부모");
  assert.equal(link.canAdminEditParentAccount({ role: "PARENT", authUserId: null, email: "mom@gmail.com" }), false, "실제 이메일 계정");
  assert.equal(link.canAdminEditParentAccount({ role: "ADMIN", authUserId: null, email: "parent_1@stiz.local" }), false, "직원");
  assert.equal(link.canAdminEditParentAccount(null), false);
});

test("[연결부] 같은 번호 계정이 하나도 없으면 잠금 뒤 빈 학부모 계정을 만들고 어떤 계정도 UPDATE 하지 않는다", async () => {
  const tx = fakeTx({ phoneRows: [] });
  const result = await link.linkParentAccountForNewStudent(tx, guardian);
  assert.deepEqual(result, { parentId: "new-parent", created: true, staffAccount: false });
  assert.ok(tx.calls[0].sql.includes("pg_advisory_xact_lock"), "같은 번호 동시 등록 잠금이 먼저");
  assert.deepEqual(tx.calls[0].values, ["enrollment-parent:01012345678"]);
  const select = tx.calls[1];
  assert.match(select.sql, /regexp_replace\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\) = \$1/);
  assert.match(select.sql, /"withdrawnAt" IS NULL/);
  const insert = tx.calls[2];
  assert.match(insert.sql, /'PARENT'/);
  assert.deepEqual(insert.values, ["parent_01012345678@stiz.local", "김엄마", "01012345678"]);
  assert.ok(!tx.calls.some((c) => /UPDATE\s+"User"/.test(c.sql)), "어떤 계정도 UPDATE 하지 않는다");
});

test("[연결부] 합성 이메일이 이미 있으면 트랜잭션을 깨지 않고 uuid 형식으로 다시 만든다", async () => {
  const tx = fakeTx({ phoneRows: [], conflictOnPlaceholder: true });
  const result = await link.linkParentAccountForNewStudent(tx, guardian);
  assert.deepEqual(result, { parentId: "fallback-parent", created: true, staffAccount: false });
  assert.match(tx.calls.at(-1).sql, /'parent_' \|\| gen_random_uuid\(\)::text \|\| '@stiz\.local'/);
});

test("[연결부] PARENT 1명이면 그 계정을 쓰고 이름·번호·이메일을 건드리지 않는다", async () => {
  const tx = fakeTx({ phoneRows: [{ id: "parent-1", role: "PARENT" }] });
  const result = await link.linkParentAccountForNewStudent(tx, guardian);
  assert.deepEqual(result, { parentId: "parent-1", created: false, staffAccount: false });
  assert.equal(tx.calls.length, 2, "잠금 + 조회만 — INSERT·UPDATE 없음");
});

test("[연결부] PARENT 없이 직원 1명이면 그 직원 계정에 붙이고 새 계정을 만들거나 직원 정보를 고치지 않는다", async () => {
  const tx = fakeTx({ phoneRows: [{ id: "coach-1", role: "INSTRUCTOR" }] });
  const result = await link.linkParentAccountForNewStudent(tx, guardian);
  assert.deepEqual(result, { parentId: "coach-1", created: false, staffAccount: true });
  assert.equal(tx.calls.length, 2, "잠금 + 조회만 — INSERT·UPDATE 없음");
});

test("[연결부] PARENT 2명 이상이면 고르게 하는 안내 오류(계정을 만들지도 붙이지도 않는다)", async () => {
  const tx = fakeTx({ phoneRows: [{ id: "p1", role: "PARENT" }, { id: "p2", role: "PARENT" }] });
  await assert.rejects(
    () => link.linkParentAccountForNewStudent(tx, guardian),
    (error) => error instanceof link.ParentAccountLinkError && /여러 개/.test(error.message) && /직접 골라/.test(error.message),
  );
  // (조회의 «FOR UPDATE» 잠금은 쓰기가 아니라 제외)
  assert.ok(!tx.calls.some((c) => /INSERT INTO|UPDATE\s+"/.test(c.sql)));
  // 직원 2명도 같은 오류
  const staffTx = fakeTx({ phoneRows: [{ id: "s1", role: "ADMIN" }, { id: "s2", role: "DRIVER" }] });
  await assert.rejects(() => link.linkParentAccountForNewStudent(staffTx, guardian), link.ParentAccountLinkError);
  assert.ok(!staffTx.calls.some((c) => /INSERT INTO|UPDATE\s+"/.test(c.sql)));
});

test("[연결부] 주 보호자 Guardian 은 isPrimary=true 로 입력값 그대로 저장", async () => {
  const tx = fakeTx();
  await link.insertPrimaryGuardian(tx, "student-1", guardian);
  assert.match(tx.calls[0].sql, /INSERT INTO "Guardian"[\s\S]*true, NOW\(\), NOW\(\)/);
  assert.deepEqual(tx.calls[0].values, ["student-1", "엄마", "김엄마", "01012345678"]);
});

test("createStudent·convertTrialToStudent 는 이메일 매칭·계정 덮어쓰기 없이 공용 모듈을 쓴다", () => {
  for (const name of ["createStudent", "convertTrialToStudent"]) {
    const body = fnBlock(admin, name);
    assert.doesNotMatch(body, /WHERE email = \$1/, `${name}: 이메일로 계정을 찾으면 안 된다`);
    assert.doesNotMatch(body, /UPDATE "User"/, `${name}: 기존 계정을 덮어쓰면 안 된다`);
    assert.doesNotMatch(body, /parent_\$\{Date\.now\(\)\}/, `${name}: 시각 기반 합성 이메일 금지(같은 사람이 여러 계정이 된다)`);
    assert.match(body, /validatePrimaryGuardian\(/);
    assert.match(body, /insertAdminStudentWithGuardian\(/);
    assert.match(body, /prisma\.\$transaction\(/, `${name}: 계정·학생·보호자를 한 트랜잭션으로`);
    assert.match(body, /ParentAccountLinkError/);
  }
  const helper = admin.slice(admin.indexOf("async function insertAdminStudentWithGuardian("), admin.indexOf("export async function updateStudentMemo"));
  assert.match(helper, /linkParentAccountForNewStudent\(tx, guardian\)/);
  assert.match(helper, /insertPrimaryGuardian\(tx, studentId, guardian\)/);
  // 체험 전환은 학생 생성과 TrialLead 전환이 같은 트랜잭션
  assert.match(fnBlock(admin, "convertTrialToStudent"), /await tx\.\$executeRawUnsafe\(\s*`UPDATE "TrialLead"/);
});

test("updateStudent 는 이메일을 쓰지 않고, 빈 계정일 때만 학부모 이름·번호를 고친다", () => {
  const body = fnBlock(admin, "updateStudent");
  assert.doesNotMatch(body, /email = \$/, "User.email 을 덮으면 NOT NULL 위반·로그인 이메일 변경");
  assert.match(body, /canAdminEditParentAccount\(parent\)/);
  assert.match(body, /WHERE id = \$3 AND role = 'PARENT' AND "authUserId" IS NULL/, "SQL 에서도 한 번 더 막는다");
  assert.match(body, /COALESCE\(\$1, name\)/, "빈 값으로 덮지 않는다");
  assert.match(body, /return \{ parentAccountUpdated \}/);
});

test("엑셀 덮어쓰기 모드는 학부모 계정 이름을 관계명으로 덮지 않고 보호자1을 주 보호자로 다시 넣는다", () => {
  const body = fnBlock(admin, "bulkCreateStudents");
  const overwrite = body.slice(body.indexOf("// 덮어쓰기 모드"), body.indexOf("result.updated++"));
  assert.doesNotMatch(overwrite, /UPDATE "User"/);
  assert.match(overwrite, /INSERT INTO "Guardian"[\s\S]*true, NOW\(\), NOW\(\)/);
});

test("신청서 승인 경로는 이번 변경과 무관하게 그대로(명시 선택 규칙 유지)", () => {
  const body = fnBlock(admin, "approveEnrollApplication");
  assert.match(body, /resolveApprovalParent\(tx, app, data\.parentUserId, verifyEnrollmentParentAuth\)/);
  assert.doesNotMatch(body, /linkParentAccountForNewStudent/);
});

test("목록 등록 폼: 이메일 칸 없음·관계 칸·휴대폰 필수·등록 뒤 새 학생 상세를 연다", () => {
  assert.doesNotMatch(listClient, /parentEmail/, "학부모 이메일 칸·상태 제거");
  assert.match(listClient, /parentRelation: parentRelation\.trim\(\)/);
  assert.match(listClient, /주 보호자 관계 \*/);
  assert.match(listClient, /주 보호자 휴대폰 \*/);
  assert.match(listClient, /required=\{!editingId\}/);
  assert.match(listClient, /setFilterStatus\("NONE"\);\s*setDetailStudentId\(result\.studentId\)/, "기본 «활성» 필터에 안 보이던 문제");
  assert.match(listClient, /if \(!result\.ok\) \{\s*\/\/[^\n]*\n\s*setFormError\(result\.error\)/);
});

test("체험 정규 전환 창: 이메일 칸 없음, 안내 오류는 창을 닫지 않고 보여 준다", () => {
  assert.doesNotMatch(trialModals, /parentEmail/);
  assert.match(trialModals, /if \(!result\.ok\) throw new Error\(result\.error\)/);
});
