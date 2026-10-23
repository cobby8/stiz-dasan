import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 경로 판정은 의존성 없는 순수 함수라 실제로 실행해서 검증한다.
const moduleSource = await readFile("src/lib/auth-routes.ts", "utf8");
const transpiled = ts.transpileModule(moduleSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { resolveRedirectForRole } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const inApp = { stayInStaffApp: true };

test("설치된 선생님 앱에서 로그인하면 원장도 선생님 화면에 머문다", () => {
  // 앱의 영역은 /staff 다. /admin 으로 보내면 앱이 브라우저로 튕긴다.
  assert.equal(resolveRedirectForRole("ADMIN", "/staff", inApp), "/staff");
  assert.equal(resolveRedirectForRole("VICE_ADMIN", "/staff", inApp), "/staff");
});

test("앱에서 온 로그인은 역할별 시작 화면도 앱 안으로 잡는다", () => {
  assert.equal(resolveRedirectForRole("INSTRUCTOR", "/staff", inApp), "/staff");
  assert.equal(resolveRedirectForRole("DRIVER", "/staff", inApp), "/staff/shuttle");
});

test("앱에서 왔어도 그 역할이 쓸 수 없는 화면이면 제 화면으로 보낸다", () => {
  // 학부모가 선생님 앱으로 로그인한 경우. /staff 에 가둬두면 아무것도 못 한다.
  assert.equal(resolveRedirectForRole("PARENT", "/staff", inApp), "/mypage");
});

test("앱에서 온 로그인은 앱 영역 밖 주소를 따라가지 않는다", () => {
  for (const outside of ["/admin", "/admin/students", "/mypage", "//evil.example/x", "/staff/../admin", null]) {
    assert.equal(
      resolveRedirectForRole("ADMIN", outside, inApp),
      "/staff",
      `앱 영역 밖으로 나가면 안 됩니다: ${String(outside)}`,
    );
  }
});

test("앱에서 온 로그인은 앱 안의 원래 목적지는 그대로 지킨다", () => {
  assert.equal(resolveRedirectForRole("ADMIN", "/staff/students", inApp), "/staff/students");
  assert.equal(resolveRedirectForRole("DRIVER", "/staff/shuttle", inApp), "/staff/shuttle");
  // 기사님은 수업 화면을 쓸 수 없으므로 제 화면으로 돌린다.
  assert.equal(resolveRedirectForRole("DRIVER", "/staff/students", inApp), "/staff/shuttle");
});

test("브라우저의 관리자 로그인은 기존대로 관리자 화면으로 간다", () => {
  // PC 에서 로그인할 때까지 선생님 화면으로 보내면 원장이 매번 되돌아가야 한다.
  assert.equal(resolveRedirectForRole("ADMIN", "/staff", { preferRoleHome: true }), "/admin");
  assert.equal(resolveRedirectForRole("ADMIN", "/admin/students"), "/admin/students");
});

test("앱 로그인과 브라우저 로그인을 다른 값으로 구분해 넘긴다", async () => {
  const middleware = await readFile("src/lib/supabase/middleware.ts", "utf8");
  // 둘을 같은 값으로 묶으면 원장이 앱을 열 때마다 관리자 화면으로 튕긴다.
  assert.match(middleware, /isStaffLogin \? "staff-app" : "staff"/);

  const continuePage = await readFile("src/app/auth/continue/page.tsx", "utf8");
  assert.match(continuePage, /stayInStaffApp: context === "staff-app"/);
  assert.match(continuePage, /preferRoleHome: context === "staff"/);
});

test("선생님 앱의 관리자 바로가기는 원장·부원장에게만 보인다", async () => {
  const menu = await readFile("src/app/staff/StaffProfileMenu.tsx", "utf8");
  const viewSource = await readFile("src/lib/account-views.ts", "utf8");
  const compiledViews = ts.transpileModule(viewSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { resolveAccountViews } = await import(`data:text/javascript;base64,${Buffer.from(compiledViews).toString("base64")}`);
  for (const role of ["ADMIN", "VICE_ADMIN"]) assert.equal(resolveAccountViews(role, false).some(view => view.href === "/admin"), true);
  for (const role of ["INSTRUCTOR", "PARENT", "DRIVER"]) assert.equal(resolveAccountViews(role, true).some(view => view.href === "/admin"), false);
  assert.match(menu, /AccountViewSwitcher views=\{accountViews\}/);
  // 수업 진행 중 이동은 다른 링크와 같은 저장 확인을 거쳐야 한다.
  assert.match(menu, /onNavigate=\{\(event, view\) => requestPublicNavigation\(event, view\.href\)\}/);
});
