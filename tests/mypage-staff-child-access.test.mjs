import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 학원 관계자의 자녀도 이 학원에 다닐 수 있다(원장 자녀 등).
// 자기 앞으로 등록된 학생이 있으면 학부모 화면을 열되, **그 외 권한은 하나도
// 넓어지면 안 된다.** 이 파일이 그 경계를 지킨다.

const moduleSource = await readFile("src/lib/auth-routes.ts", "utf8");
const transpiled = ts.transpileModule(moduleSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { canRoleAccessPath, resolveRedirectForRole } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const withChild = { hasOwnChildren: true };

test("자녀가 등록된 직원 계정은 학부모 화면을 연다", () => {
  assert.equal(canRoleAccessPath("ADMIN", "/mypage", withChild), true);
  assert.equal(canRoleAccessPath("VICE_ADMIN", "/mypage/reports", withChild), true);
  assert.equal(canRoleAccessPath("INSTRUCTOR", "/mypage", withChild), true);
});

test("자녀가 없으면 직원 계정은 여전히 학부모 화면을 못 연다", () => {
  assert.equal(canRoleAccessPath("ADMIN", "/mypage"), false);
  assert.equal(canRoleAccessPath("INSTRUCTOR", "/mypage"), false);
  assert.equal(canRoleAccessPath("DRIVER", "/mypage"), false);
});

test("학부모는 지금까지처럼 학부모 화면만 연다", () => {
  assert.equal(canRoleAccessPath("PARENT", "/mypage"), true);
  assert.equal(canRoleAccessPath("PARENT", "/admin"), false);
  assert.equal(canRoleAccessPath("PARENT", "/staff"), false);
});

test("자녀가 있다고 해서 다른 화면 권한이 넓어지지 않는다", () => {
  // 이 옵션은 /mypage 한 곳에만 영향을 줘야 한다.
  assert.equal(canRoleAccessPath("PARENT", "/admin", withChild), false);
  assert.equal(canRoleAccessPath("PARENT", "/admin/students", withChild), false);
  assert.equal(canRoleAccessPath("PARENT", "/staff", withChild), false);
  assert.equal(canRoleAccessPath("INSTRUCTOR", "/admin", withChild), false);
  assert.equal(canRoleAccessPath("DRIVER", "/staff/students", withChild), false);
});

test("로그인 후 목적지도 같은 규칙을 따른다", () => {
  assert.equal(resolveRedirectForRole("ADMIN", "/mypage", withChild), "/mypage");
  // 자녀가 없으면 예전처럼 관리자 화면으로 돌린다.
  assert.equal(resolveRedirectForRole("ADMIN", "/mypage"), "/admin");
});

test("직원 계정의 학부모 화면 통과는 자녀 조회로만 결정한다", async () => {
  const guard = await readFile("src/lib/auth-guard.ts", "utf8");
  // 역할만 보고 통과시키면 자녀 없는 직원도 학부모 화면에 들어간다.
  assert.match(guard, /SELECT 1 AS one FROM "Student" WHERE "parentId" = \$1 LIMIT 1/);
  // 판정은 getVerifiedParentState 가 상태로 돌려주고(카카오 연결 화면 안내용),
  // requireVerifiedParent 는 OK 가 아니면 전부 거절(throw)한다.
  assert.match(guard, /ownChildren\.length === 0[\s\S]{0,120}return \{ status: "STAFF_ACCOUNT" \}/);
  // 학부모 계정의 휴대폰 인증 요구는 그대로 남아 있어야 한다.
  assert.match(guard, /isVerifiedSignup && !isDirectlyBoundLegacyParent[\s\S]{0,120}return \{ status: "PHONE_UNVERIFIED" \}/);
  assert.match(guard, /if \(state\.status === "OK"\) return state\.parent;[\s\S]{0,200}throw new Error\("휴대폰 인증을 완료한 학부모 계정이 필요합니다\."\)/);
});

test("로그인 직후 판별도 DB 의 자녀 유무를 그대로 쓴다", async () => {
  const continuePage = await readFile("src/app/auth/continue/page.tsx", "utf8");
  assert.match(continuePage, /getParentViewAccessForAuthUser\(user\)/);
  assert.match(continuePage, /hasOwnChildren: parentView\.hasOwnChildren/);
  const access = await readFile("src/lib/account-view-access.ts", "utf8");
  assert.match(access, /EXISTS \(SELECT 1 FROM "Student" s WHERE s\."parentId" = u\.id\)/);
  assert.match(access, /u\."authUserId" = \$1 OR \(u\."authUserId" IS NULL AND u\.id = \$1\)/);
});
