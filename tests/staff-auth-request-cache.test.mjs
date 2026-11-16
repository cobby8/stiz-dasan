// 선생님 화면 속도(2026-11-16): 직원 확인(requireStaff)과 수업 접근 정보(getStaffClassAccessContext)는
// «한 요청 안에서만» 한 번 계산한다. 요청 사이에 남는 캐시는 금지 — 원장이 역할을 회수하면 다음 요청부터 막혀야 한다.
// 소스 글자 검사 + 실제 실행(React cache 를 «요청 범위» 대역으로 바꿔 끼움) 두 가지로 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(path, "utf8");
const authGuard = read("src/lib/auth-guard.ts");
const classAccess = read("src/lib/staff-class-access.ts");
const layout = read("src/app/staff/layout.tsx");

// ── 실행용 조립 ────────────────────────────────────────────────
function load(path, dependencies) {
  const exports = {};
  const compiled = ts.transpileModule(read(path), {
    fileName: path,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", compiled)((name) => {
    assert.ok(name in dependencies, `준비하지 않은 의존성: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

/**
 * React cache() 의 요청 범위 대역.
 * 실제 React 와 같은 규칙: 요청(렌더) 안이면 함수별로 한 번만 실행해 같은 promise 를 돌려주고,
 * 요청 밖(서버 액션·API)이면 기억 없이 매번 실행한다.
 */
function fixture({ role = "INSTRUCTOR", email = "teacher@invalid", grants = [], signedOut = false } = {}) {
  const state = { role, grants, signedOut, coachId: "coach-1" };
  const queries = [];
  let scope = null;
  const react = {
    cache: (fn) => (...args) => {
      if (!scope) return fn(...args);
      if (!scope.has(fn)) scope.set(fn, fn(...args));
      return scope.get(fn);
    },
  };
  const inRequest = async (run) => {
    scope = new Map();
    try { return await run(); } finally { scope = null; }
  };
  const prisma = {
    $queryRawUnsafe: async (sql) => {
      queries.push(sql);
      if (sql.includes('"UserRoleGrant"')) return state.grants.map((r) => ({ role: r, status: "ACTIVE" }));
      if (sql.includes('FROM "Coach"')) return state.coachId ? [{ coachId: state.coachId }] : [];
      if (sql.includes('"withdrawRequestedAt"')) return [{ withdrawRequestedAt: null, withdrawnAt: null }];
      if (sql.includes("SELECT id, name, role FROM \"User\"")) return state.role ? [{ id: "app-1", name: "합성 선생님", role: state.role }] : [];
      throw new Error(`예상하지 못한 조회: ${sql}`);
    },
  };
  const roles = load("src/lib/account/roles.ts", {});
  const guard = load("src/lib/auth-guard.ts", {
    react,
    "@/lib/prisma": { prisma },
    "@/lib/account/roles": roles,
    "@/lib/account/child-access": {},
    "@/lib/supabase/server": {
      createClient: async () => ({
        auth: {
          getClaims: async () => state.signedOut
            ? { data: null, error: { message: "no session" } }
            : { data: { claims: { sub: "auth-1", email, app_metadata: { provider: "email" } } }, error: null },
          getUser: async () => ({ data: { user: null }, error: { message: "no session" } }),
        },
      }),
    },
  });
  const access = load("src/lib/staff-class-access.ts", {
    react,
    "@/lib/auth-guard": guard,
    "@/lib/prisma": { prisma },
    "@/lib/staff/classSubstitute": { SUBSTITUTE_TEACHER_SQL: "TRUE", substituteAllowedNow: () => false },
    "@/lib/datetime/kst": { isKstYmd: () => true, todayKst: () => "2026-11-16" },
    "@/lib/feed/rules": { sessionKstDateSql: () => "s.date" },
  });
  const count = (needle) => queries.filter((sql) => sql.includes(needle)).length;
  return { guard, access, state, queries, count, inRequest };
}

const ROLE_QUERY = 'SELECT id, name, role FROM "User"';
const GRANT_QUERY = '"UserRoleGrant"';
const COACH_QUERY = 'FROM "Coach"';

// ── (a) react cache 로 감쌌다 ─────────────────────────────────
test("requireStaff·getStaffClassAccessContext 는 React cache(요청 단위 기억)로 감싸여 있다", () => {
  assert.match(authGuard, /import \{ cache \} from "react";/);
  assert.match(authGuard, /async function requireStaffUncached\(\): Promise<StaffAuthUser> \{/);
  assert.match(authGuard, /const requireStaffCached = cache\(requireStaffUncached\);/);
  assert.match(authGuard, /export async function requireStaff\(\): Promise<StaffAuthUser> \{\s*const staff = await requireStaffCached\(\);/);

  assert.match(classAccess, /import \{ cache \} from "react";/);
  assert.match(classAccess, /async function getStaffClassAccessContextUncached\(\): Promise<StaffClassAccessContext> \{/);
  assert.match(classAccess, /const getStaffClassAccessContextCached = cache\(getStaffClassAccessContextUncached\);/);
  assert.match(classAccess, /export async function getStaffClassAccessContext\(\): Promise<StaffClassAccessContext> \{\s*const access = await getStaffClassAccessContextCached\(\);/);
  // 판정 본문은 그대로 — 통과 조건과 실패 문구가 바뀌지 않았다
  const body = authGuard.slice(authGuard.indexOf("async function requireStaffUncached"), authGuard.indexOf("const requireStaffCached"));
  assert.equal(body.match(/throw new Error\("Staff permission is required\."\);/g)?.length, 3);
  assert.match(body, /if \(!hasStaffAccess\(roles\) \|\| !staffRole\)/);
});

// ── (b) 요청 사이에 남는 저장소가 없다 ─────────────────────────
test("직원 확인 결과를 모듈 변수·Map 에 담지 않는다(요청 사이 캐시 금지)", () => {
  // auth-guard 의 Map 은 예전부터 있던 주 역할 캐시(roleCache) 하나뿐이고, 그것도 매번 DB 로 다시 확인한다
  assert.equal(authGuard.match(/new (?:Weak)?Map\b/g)?.length, 1);
  assert.match(authGuard, /const roleCache = new Map</);
  const staffPart = authGuard.slice(authGuard.indexOf("async function getActiveRoleGrants"), authGuard.indexOf("async function requireOwnerUncached"));
  assert.doesNotMatch(staffPart, /roleCache|new (?:Weak)?Map\b|new Set\b|globalThis|unstable_cache|expiresAt|TTL/);
  for (const [name, source] of [["auth-guard", authGuard], ["staff-class-access", classAccess]]) {
    assert.doesNotMatch(source, /^(?:export )?let /m, `${name}: 모듈 수준 let 금지`);
    // 주석의 «unstable_cache 와 다르다» 설명은 허용하고, 실제 호출·가져오기만 막는다
    assert.doesNotMatch(source, /unstable_cache\(|import [^;]*unstable_cache|globalThis|"use cache"/, `${name}: 요청을 넘는 캐시 금지`);
  }
  assert.doesNotMatch(classAccess, /new (?:Weak)?Map\b|new Set\b/);
  // 뜻이 주석으로 남아 있다
  assert.match(authGuard, /요청 사이/);
  assert.match(classAccess, /요청 사이에 남는 캐시/);
});

// ── (c) 복사본을 돌려준다 ─────────────────────────────────────
test("부를 때마다 복사본을 돌려준다(roles 같은 중첩 객체 포함)", () => {
  assert.match(authGuard, /const staff = await requireStaffCached\(\);\s*return \{\s*\.\.\.staff,\s*roles: \{ \.\.\.staff\.roles \},/);
  assert.match(classAccess, /return \{ \.\.\.access, staff: \{ \.\.\.access\.staff, roles: \{ \.\.\.access\.staff\.roles \} \} \};/);
});

// ── (d) 레이아웃은 함께 기다린다 ───────────────────────────────
test("선생님 레이아웃은 직원 확인과 화면 전환 메뉴를 Promise.all 로 함께 기다린다", () => {
  assert.match(layout, /const \[staff, \{ views \}\] = await Promise\.all\(\[requireStaff\(\), getAccountViewAccess\(\)\]\);/);
  assert.equal(layout.match(/requireStaff\(\)/g)?.length, 1);
  assert.equal(layout.match(/getAccountViewAccess\(\)/g)?.length, 1);
  // 묶어도 안전한 근거: 화면 전환 메뉴 계산은 로그인이 없어도 던지지 않고 빈 값을 준다
  const viewAccess = read("src/lib/account-view-access.ts");
  assert.match(viewAccess, /async function readAccountViewAccess\(\) \{\s*try \{[\s\S]*?\} catch \{[\s\S]*?return \{ role: null, views: \[\] \};\s*\}\s*\}/);
});

// ── 실제 실행 ────────────────────────────────────────────────
test("실행: 한 요청에서 네 번 불러도 역할·추가 역할·코치 조회는 한 번씩", async () => {
  const f = fixture({ grants: ["DRIVER"] });
  const result = await f.inRequest(async () => {
    // 선생님 홈과 같은 모양: 레이아웃 + 화면 + 읽기 함수 2곳
    const [a, b, c, d] = await Promise.all([
      f.guard.requireStaff(),
      f.guard.requireStaff(),
      f.access.getStaffClassAccessContext(),
      f.access.getStaffClassAccessContext(),
    ]);
    return { a, b, c, d };
  });
  assert.equal(f.count(ROLE_QUERY), 1, "주 역할 조회 1번");
  assert.equal(f.count(GRANT_QUERY), 1, "추가 역할 조회 1번");
  assert.equal(f.count(COACH_QUERY), 1, "코치 연결 조회 1번");
  // 판정 값은 그대로
  assert.equal(result.a.appUserId, "app-1");
  assert.equal(result.a.appUserRole, "INSTRUCTOR");
  assert.deepEqual(result.a.roles, { admin: false, teacher: true, driver: true, parent: false });
  assert.deepEqual(result.c, { staff: result.a, coachId: "coach-1", canAccessAllClasses: false });
  assert.deepEqual(result.b, result.a);
  assert.deepEqual(result.d, result.c);
});

test("실행: 받은 결과를 고쳐도 같은 요청의 다음 호출에 번지지 않는다", async () => {
  const f = fixture();
  await f.inRequest(async () => {
    const first = await f.guard.requireStaff();
    first.appUserRole = "ADMIN";
    first.roles.admin = true;
    first.app_metadata.provider = "tampered";
    Object.assign(first, { extra: true });
    const second = await f.guard.requireStaff();
    assert.notEqual(second, first);
    assert.equal(second.appUserRole, "INSTRUCTOR");
    assert.equal(second.roles.admin, false);
    assert.equal(second.app_metadata.provider, "email");
    assert.equal("extra" in second, false);

    const ctx1 = await f.access.getStaffClassAccessContext();
    ctx1.canAccessAllClasses = true;
    ctx1.coachId = "someone-else";
    ctx1.staff.appUserId = "someone-else";
    ctx1.staff.roles.admin = true;
    const ctx2 = await f.access.getStaffClassAccessContext();
    assert.notEqual(ctx2, ctx1);
    assert.equal(ctx2.canAccessAllClasses, false);
    assert.equal(ctx2.coachId, "coach-1");
    assert.equal(ctx2.staff.appUserId, "app-1");
    assert.equal(ctx2.staff.roles.admin, false);
    // 접근 정보를 고친 것이 requireStaff 쪽 기억에도 번지지 않는다
    assert.equal((await f.guard.requireStaff()).roles.admin, false);
  });
});

test("실행: 다음 요청은 다시 확인한다 — 추가 역할을 회수하면 바로 막힌다", async () => {
  // 주 역할은 학부모, 선생님은 원장이 승인한 추가 역할
  const f = fixture({ role: "PARENT", grants: ["INSTRUCTOR"] });
  assert.equal((await f.inRequest(() => f.guard.requireStaff())).appUserRole, "INSTRUCTOR");
  f.state.grants = []; // 원장이 회수
  await assert.rejects(f.inRequest(() => f.guard.requireStaff()), { message: "Staff permission is required." });
  await assert.rejects(f.inRequest(() => f.access.getStaffClassAccessContext()), { message: "Staff permission is required." });
  assert.equal(f.count(GRANT_QUERY), 3, "요청마다 추가 역할을 다시 읽는다");
});

test("실행: 요청 범위 밖(서버 액션·API)에서는 기억하지 않고 부를 때마다 확인한다", async () => {
  const f = fixture();
  await f.guard.requireStaff();
  await f.guard.requireStaff();
  await f.access.getStaffClassAccessContext();
  assert.equal(f.count(GRANT_QUERY), 3);
  assert.equal(f.count(COACH_QUERY), 1);
});

test("실행: 실패는 예전과 같은 예외·같은 문구이고, 같은 요청 안에서는 다시 묻지 않는다", async () => {
  // 권한 없음(학부모 계정)
  const parent = fixture({ role: "PARENT" });
  await parent.inRequest(async () => {
    await assert.rejects(parent.guard.requireStaff(), { message: "Staff permission is required." });
    await assert.rejects(parent.guard.requireStaff(), { message: "Staff permission is required." });
    await assert.rejects(parent.access.getStaffClassAccessContext(), { message: "Staff permission is required." });
  });
  assert.equal(parent.count(GRANT_QUERY), 1);
  assert.equal(parent.count(COACH_QUERY), 0, "권한이 없으면 코치 조회까지 가지 않는다");

  // 앱 계정 없음 · 이메일 없음
  await assert.rejects(fixture({ role: null }).guard.requireStaff(), { message: "Staff permission is required." });
  await assert.rejects(fixture({ email: "" }).guard.requireStaff(), { message: "Staff permission is required." });

  // 로그인 없음
  const out = fixture({ signedOut: true });
  await out.inRequest(async () => {
    await assert.rejects(out.guard.requireStaff(), { message: "인증이 필요합니다. 로그인해주세요." });
    await assert.rejects(out.access.getStaffClassAccessContext(), { message: "인증이 필요합니다. 로그인해주세요." });
  });
  assert.equal(out.queries.length, 0);
});

test("실행: 원장·부원장은 코치 조회 없이 모든 반 — 판정 그대로", async () => {
  for (const role of ["ADMIN", "VICE_ADMIN"]) {
    const f = fixture({ role });
    const ctx = await f.inRequest(async () => {
      await f.access.getStaffClassAccessContext();
      return f.access.getStaffClassAccessContext();
    });
    assert.equal(ctx.canAccessAllClasses, true);
    assert.equal(ctx.coachId, null);
    assert.equal(ctx.staff.appUserRole, role);
    assert.equal(f.count(COACH_QUERY), 0);
    assert.equal(f.count(ROLE_QUERY), 1);
  }
});
