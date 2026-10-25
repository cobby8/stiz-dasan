import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTsModule } from "./_ts-module.mjs";
import {
  REQUIRED_USER_ROLE_GRANT_COLUMNS,
  findUserRoleGrantIssues,
} from "../scripts/user-role-grant-db-preflight.mjs";

// 다중 역할 — 한 사람이 선생님이면서 기사님, 기사님이면서 학부모일 수 있다(원장 결정 2026-10-25).
// 「이 사람에게 어떤 화면이 열리는가」는 권한 그 자체다. 가장 무서운 사고는 하나 —
// **신청(PENDING)만 했는데 선생님 화면이 열려 모든 학생의 개인정보가 보이는 것.**

const {
  effectiveRoles,
  activeGrantedRoles,
  hasAnyRole,
  isGrantableRole,
  GRANTABLE_ROLES,
} = await loadTsModule("src/lib/account/roles.ts");

const migration = fs.readFileSync("prisma/migrations/20261025120000_add_user_role_grants/migration.sql", "utf8");
const schema = fs.readFileSync("prisma/schema.prisma", "utf8");

const NONE = { admin: false, teacher: false, driver: false, parent: false };

// ── 판정(실제 실행) ──────────────────────────────────────────────────────────
test("주 역할만 있을 때는 지금과 똑같이 열린다", () => {
  // 기존 resolveAccountViews 와 같은 결과여야 한다(원장·부원장은 선생님 화면도 쓴다).
  assert.deepEqual(effectiveRoles({ primaryRole: "ADMIN", hasStudents: false }), { ...NONE, admin: true, teacher: true });
  assert.deepEqual(effectiveRoles({ primaryRole: "VICE_ADMIN", hasStudents: false }), { ...NONE, admin: true, teacher: true });
  assert.deepEqual(effectiveRoles({ primaryRole: "INSTRUCTOR", hasStudents: false }), { ...NONE, teacher: true });
  assert.deepEqual(effectiveRoles({ primaryRole: "DRIVER", hasStudents: false }), { ...NONE, driver: true });
  // 학부모로 가입했으면 자녀 연결 전에도 학부모 화면이 열려야 자녀를 등록할 수 있다.
  assert.deepEqual(effectiveRoles({ primaryRole: "PARENT", hasStudents: false }), { ...NONE, parent: true });
});

test("원장 결정대로 여러 역할을 함께 맡을 수 있다", () => {
  // 선생님 + 기사님 — 지금 구조(역할 칸 하나)로는 불가능했다.
  assert.deepEqual(
    effectiveRoles({ primaryRole: "INSTRUCTOR", grants: [{ role: "DRIVER", status: "ACTIVE" }], hasStudents: false }),
    { ...NONE, teacher: true, driver: true },
  );
  // 기사님 + 학부모 — 기존 화면 전환은 기사님을 아예 빼고 있었다.
  assert.deepEqual(
    effectiveRoles({ primaryRole: "DRIVER", hasStudents: true }),
    { ...NONE, driver: true, parent: true },
  );
  // 학부모로 가입한 사람이 나중에 선생님 승인을 받은 경우.
  assert.deepEqual(
    effectiveRoles({ primaryRole: "PARENT", grants: [{ role: "INSTRUCTOR", status: "ACTIVE" }], hasStudents: true }),
    { ...NONE, teacher: true, parent: true },
  );
  // 셋 다.
  assert.deepEqual(
    effectiveRoles({
      primaryRole: "PARENT",
      grants: [{ role: "INSTRUCTOR", status: "ACTIVE" }, { role: "DRIVER", status: "ACTIVE" }],
      hasStudents: true,
    }),
    { ...NONE, teacher: true, driver: true, parent: true },
  );
});

test("신청만 한 역할로는 화면이 열리지 않는다", () => {
  // 이게 무너지면 스토어에서 받은 아무나 「선생님」을 골라 학생 개인정보를 본다.
  for (const status of ["PENDING", "REJECTED", "REVOKED", "", "active", null, undefined]) {
    const roles = effectiveRoles({
      primaryRole: "PARENT",
      grants: [{ role: "INSTRUCTOR", status }, { role: "DRIVER", status }],
      hasStudents: false,
    });
    assert.equal(roles.teacher, false, `status=${JSON.stringify(status)} 에서 선생님 화면이 열렸다`);
    assert.equal(roles.driver, false, `status=${JSON.stringify(status)} 에서 기사님 화면이 열렸다`);
  }
});

test("추가 역할 표로는 관리자 권한을 얻을 수 없다", () => {
  // DB CHECK 가 막지만, 판정에서도 한 번 더 버린다 — 승인 실수 한 번이 전체 데이터 유출이다.
  for (const role of ["ADMIN", "VICE_ADMIN", "PARENT", "admin", "OWNER", ""]) {
    const roles = effectiveRoles({ primaryRole: "PARENT", grants: [{ role, status: "ACTIVE" }], hasStudents: false });
    assert.equal(roles.admin, false, `${role} 부여로 관리자 화면이 열렸다`);
    assert.equal(roles.teacher, false, `${role} 부여로 선생님 화면이 열렸다`);
  }
  assert.deepEqual([...GRANTABLE_ROLES], ["INSTRUCTOR", "DRIVER"]);
  assert.equal(isGrantableRole("ADMIN"), false);
});

test("모르는 주 역할·빈 입력은 아무 화면도 열지 않는다", () => {
  for (const primaryRole of [null, undefined, "", "OWNER", "parent"]) {
    assert.deepEqual(effectiveRoles({ primaryRole, hasStudents: false }), NONE, `${String(primaryRole)}`);
  }
  // hasStudents 는 정확히 true 일 때만.
  assert.equal(effectiveRoles({ primaryRole: null, hasStudents: "true" }).parent, false);
  assert.equal(hasAnyRole(NONE), false);
  assert.equal(hasAnyRole({ ...NONE, driver: true }), true);
  // 이상한 grants 값도 터지지 않는다.
  assert.equal(activeGrantedRoles(null).size, 0);
  assert.equal(activeGrantedRoles([null, { role: "DRIVER" }]).size, 0);
});

// ── DB 구조 계약 ─────────────────────────────────────────────────────────────
test("DB 가 관리자 부여와 상태 오타를 막는다", () => {
  assert.match(migration, /CHECK \(role IN \('INSTRUCTOR', 'DRIVER'\)\)/);
  assert.match(migration, /CHECK \(status IN \('PENDING', 'ACTIVE', 'REJECTED', 'REVOKED'\)\)/);
  // 처리된 건에는 처리 시각이 있어야 누가 언제 열었는지 남는다.
  assert.match(migration, /CHECK \(status = 'PENDING' OR "decidedAt" IS NOT NULL\)/);
  // 살아 있는 건 하나뿐 — 둘이면 하나를 회수해도 다른 하나로 화면이 계속 열린다.
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "UserRoleGrant_live_unique"[\s\S]*?\("userId", role\) WHERE status IN \('PENDING', 'ACTIVE'\)/);
  // 탈퇴(계정 삭제) 시 함께 사라진다.
  assert.match(migration, /REFERENCES public\."User"\(id\) ON DELETE CASCADE/);
});

test("이 표는 브라우저 키로 열리지 않는다", () => {
  // 열리면 누구나 자기에게 선생님 권한을 쓸 수 있다. 공개 스키마 표의 프로젝트 규칙을 그대로 따른다.
  assert.match(migration, /ALTER TABLE public\."UserRoleGrant" ENABLE ROW LEVEL SECURITY;/);
  assert.match(migration, /ALTER TABLE public\."UserRoleGrant" FORCE ROW LEVEL SECURITY;/);
  assert.match(migration, /REVOKE ALL ON TABLE public\."UserRoleGrant" FROM anon, authenticated;/);
  // 멱등 — 운영 DB 에 직접 적용하므로 두 번 돌아도 안전해야 한다.
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\."UserRoleGrant"/);
  assert.doesNotMatch(migration, /\b(DROP|TRUNCATE|DELETE FROM|UPDATE)\b/);
});

test("schema.prisma 와 preflight 가 마이그레이션과 같은 칸을 본다", () => {
  assert.match(schema, /^model UserRoleGrant \{/m);
  for (const column of REQUIRED_USER_ROLE_GRANT_COLUMNS.UserRoleGrant) {
    assert.match(migration, new RegExp(`"?${column}"?\\s+(TEXT|TIMESTAMPTZ)`), `${column} 가 마이그레이션에 없다`);
  }
});

test("preflight 가 표·인덱스·보안 누락을 실제로 잡는다", () => {
  const cols = REQUIRED_USER_ROLE_GRANT_COLUMNS.UserRoleGrant.map((column) => ({ table_name: "UserRoleGrant", column_name: column }));
  const idx = ["UserRoleGrant_live_unique", "UserRoleGrant_pending_idx", "UserRoleGrant_user_active_idx"]
    .map((index_name) => ({ table_name: "UserRoleGrant", index_name }));
  const rlsOk = [{ table_name: "UserRoleGrant", rls_enabled: true, rls_forced: true }];

  assert.deepEqual(findUserRoleGrantIssues({ columnRows: cols, indexRows: idx, rlsRows: rlsOk }), []);
  // 2026-10-25 운영 실측과 같은 상태 — 표가 아예 없다(15개).
  assert.equal(findUserRoleGrantIssues({ columnRows: [], indexRows: [], rlsRows: [] }).length, 15);
  // RLS 는 켰지만 FORCE 를 빠뜨림 — 표 소유자 권한으로 우회된다.
  assert.deepEqual(
    findUserRoleGrantIssues({ columnRows: cols, indexRows: idx, rlsRows: [{ table_name: "UserRoleGrant", rls_enabled: true, rls_forced: false }] }),
    [{ type: "rls", table: "UserRoleGrant" }],
  );
  // 살아 있는 건 유일성 인덱스만 빠짐.
  assert.deepEqual(
    findUserRoleGrantIssues({ columnRows: cols, indexRows: idx.slice(1), rlsRows: rlsOk }),
    [{ type: "index", table: "UserRoleGrant", index: "UserRoleGrant_live_unique" }],
  );
  // 브라우저 키에 직접 권한이 남아 있음.
  assert.equal(
    findUserRoleGrantIssues({
      columnRows: cols, indexRows: idx, rlsRows: rlsOk,
      privilegeRows: [{ table_name: "UserRoleGrant", grantee: "anon", privilege_type: "SELECT" }],
    })[0].type,
    "direct-privilege",
  );
});
