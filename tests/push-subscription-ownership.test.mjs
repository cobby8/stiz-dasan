// 웹푸시 구독 등록·해제의 «누구 것인가» (2026-11-10 보안 검수 HIGH 반영).
//  예전엔 이메일로 앱 계정을 찾아 간편로그인 계정은 실패하고, 이메일이 겹치면 남의 userId 로 저장됐다.
//  → 로그인(Auth id)에 직접 연결된 계정만(findLinkedAppUserId, auth-guard 의 학부모 판정과 같은 규칙), 역할 무관.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8");
const pushRoute = read("src/app/api/push/route.ts");
const authGuard = read("src/lib/auth-guard.ts");

function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => (name in mocks ? mocks[name] : require(name));
  module._compile(compiled, absolute);
  return module.exports;
}

/** 대역 로그인·대역 DB 로 라우트를 불러온다. users = 앱 계정 표(역할 무관) */
function loadRoute({ authUser, users }) {
  const writes = [];
  const lookups = [];
  const prisma = {
    $queryRawUnsafe: async (sql, authUserId) => {
      lookups.push(sql);
      return users.filter((u) => !u.withdrawnAt && (u.authUserId === authUserId || (u.authUserId == null && u.id === authUserId))).slice(0, 2).map((u) => ({ id: u.id }));
    },
    $executeRawUnsafe: async (sql, ...params) => { writes.push({ sql, params }); return 1; },
  };
  const guard = load("src/lib/auth-guard.ts", {
    "@/lib/prisma": { prisma },
    "@/lib/supabase/server": { createClient: async () => ({}) },
    "@/lib/account/child-access": {},
    "@/lib/account/roles": {},
  });
  const route = load("src/app/api/push/route.ts", {
    "next/server": { NextResponse: { json: (body, init) => ({ body, status: init?.status ?? 200 }) } },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: authUser } }) } }) },
    "@/lib/prisma": { prisma },
    "@/lib/auth-guard": { findLinkedAppUserId: guard.findLinkedAppUserId },
  });
  const req = (body) => ({ json: async () => body });
  return { route, req, writes, lookups };
}

const SUB = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };

test("정적: 이메일로 계정을 찾지 않고, 해제는 본인 소유 구독만 지운다", () => {
  assert.doesNotMatch(pushRoute, /WHERE email = \$1/, "이메일 조회 금지");
  assert.match(pushRoute, /findLinkedAppUserId\(user\.id\)/);
  assert.match(pushRoute, /DELETE FROM "PushSubscription" WHERE endpoint = \$1 AND "userId" = \$2/);
  assert.doesNotMatch(pushRoute, /role/, "역할 제한 없음(학부모·선생님·기사님·관리자 모두)");
  // auth-guard 의 학부모 판정과 같은 연결 규칙 + 탈퇴 제외
  const fn = authGuard.slice(authGuard.indexOf("export async function findLinkedAppUserId"), authGuard.indexOf("requireAuth: 로그인 여부만"));
  assert.match(fn, /\("authUserId" = \$1 OR \("authUserId" IS NULL AND id = \$1\)\)\s+AND "withdrawnAt" IS NULL/);
  assert.doesNotMatch(fn, /email/i);
});

test("실행: 간편로그인 계정(이메일 다름)도 Auth id 로 찾아 본인 id 로 저장 — 이메일이 같은 남의 계정은 안 잡힌다", async () => {
  const users = [
    { id: "victim", authUserId: "auth-victim", email: "same@x.kr", role: "PARENT" },
    { id: "me", authUserId: "auth-me", email: "kakao_123@oauth", role: "PARENT" },
  ];
  const { route, req, writes } = loadRoute({ authUser: { id: "auth-me", email: "same@x.kr" }, users });
  const res = await route.POST(req({ subscription: SUB }));
  assert.equal(res.status, 200);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].params, ["me", SUB.endpoint, "p", "a"], "userId 는 Auth id 로 찾은 본인");
});

test("실행: 역할 무관 — 기사님·선생님·관리자 계정도 등록·해제된다", async () => {
  for (const role of ["DRIVER", "INSTRUCTOR", "ADMIN"]) {
    const { route, req, writes } = loadRoute({ authUser: { id: `auth-${role}` }, users: [{ id: `u-${role}`, authUserId: `auth-${role}`, role }] });
    assert.equal((await route.POST(req({ subscription: SUB }))).status, 200, role);
    assert.equal((await route.DELETE(req({ endpoint: SUB.endpoint }))).status, 200, role);
    assert.deepEqual(writes[1].params, [SUB.endpoint, `u-${role}`], `${role} 해제는 본인 구독만`);
  }
});

test("실행: 로그인 없음 401 · 연결 계정 없음/탈퇴/두 계정 걸림 404(추측 연결 안 함) · 구독 값 이상 400 — 모두 DB 쓰기 없음", async () => {
  const none = loadRoute({ authUser: null, users: [] });
  assert.equal((await none.route.POST(none.req({ subscription: SUB }))).status, 401);
  const withdrawn = loadRoute({ authUser: { id: "auth-w" }, users: [{ id: "w", authUserId: "auth-w", withdrawnAt: new Date() }] });
  assert.equal((await withdrawn.route.POST(withdrawn.req({ subscription: SUB }))).status, 404);
  const twin = loadRoute({ authUser: { id: "x" }, users: [{ id: "a", authUserId: "x" }, { id: "x", authUserId: null }] });
  assert.equal((await twin.route.POST(twin.req({ subscription: SUB }))).status, 404);
  const bad = loadRoute({ authUser: { id: "auth-me" }, users: [{ id: "me", authUserId: "auth-me" }] });
  assert.equal((await bad.route.POST(bad.req({ subscription: { endpoint: "http://insecure", keys: { p256dh: "p", auth: "a" } } }))).status, 400);
  assert.equal((await bad.route.POST(bad.req({ subscription: { endpoint: SUB.endpoint } }))).status, 400, "키 없음");
  for (const r of [none, withdrawn, twin, bad]) assert.equal(r.writes.length, 0);
});

test("같은 기기(endpoint)를 다른 계정이 다시 등록하면 지금 로그인한 사람으로 옮긴다(옛 계정 알림이 이 기기로 새지 않게)", () => {
  assert.match(pushRoute, /ON CONFLICT \(endpoint\) DO UPDATE SET "userId" = \$1, p256dh = \$3, auth = \$4/);
});
