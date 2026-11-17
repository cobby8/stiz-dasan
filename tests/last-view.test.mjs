// 마지막에 쓰던 화면 기억(2026-11-17 원장 승인) — 실행·정적 테스트
//
// 지키려는 것:
//  ① 쿠키 값은 화면 키 한 단어뿐이고, 목록 밖·빈 값·이상한 문자는 무시한다.
//  ② 쿠키는 «바람»일 뿐이다 — 서버가 확인한 화면 목록에 있을 때만 따르고, 없으면 대표 역할 기본 화면.
//  ③ 원래 가려던 화면(redirect)·로그인 맥락(context)이 쿠키보다 먼저다.
//  ④ 방금 거절돼 돌아온 경우(bounced)는 쿠키를 무시한다(거절 → 판별 → 거절 반복 방지).
//  ⑤ 쿠키에 계정 ID·이메일·토큰이 실리지 않는다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

const lastView = await loadTsModule("src/lib/auth/last-view.ts");
const routes = await loadTsModule("src/lib/auth-routes.ts");
const { resolveAccountViews } = await loadTsModule("src/lib/account-views.ts");
const { LAST_VIEW_COOKIE, LAST_VIEW_KEYS, LAST_VIEW_MAX_AGE_SECONDS, parseLastViewKey, buildLastViewCookie, resolveLastViewDestination } = lastView;

/** CommonJS 로 올려 의존성을 바꿔 끼운다(next/headers·DB 처럼 그대로 못 올리는 것) */
function load(path, dependencies) {
  const exports = {};
  const compiled = ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Function("require", "exports", compiled)((name) => {
    assert.ok(name in dependencies, `예상 못 한 import: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

/** 서버 쪽 판정(쿠키 읽기 + 권한 확인)을 가짜 쿠키로 올린다. reads 로 쿠키를 몇 번 읽었는지 센다. */
function serverFixture(cookieValue, { broken = false } = {}) {
  const state = { reads: 0 };
  const server = load("src/lib/auth/last-view-server.ts", {
    "next/headers": {
      cookies: async () => {
        state.reads++;
        if (broken) throw new Error("cookies unavailable");
        return { get: (name) => (name === LAST_VIEW_COOKIE && cookieValue !== undefined ? { value: cookieValue } : undefined) };
      },
    },
    "@/lib/auth-routes": routes,
    "@/lib/account-views": { resolveAccountViews },
    "@/lib/auth/last-view": lastView,
  });
  return { read: server.readLastViewDestination, state };
}

/** 계속 함수(resolveContinueDestination)를 원본 그대로 올린다 */
function continueFixture({ role, cookieValue, access, signedOut = false, username = null }) {
  const { read: readLastViewDestination } = serverFixture(cookieValue);
  const lib = load("src/lib/auth/continue-destination.ts", {
    "@/lib/auth-routes": routes,
    "@/lib/prisma": { prisma: { $queryRawUnsafe: async () => (role ? [{ role, username, phoneVerifiedAt: null }] : []) } },
    "@/lib/supabase/server": {
      createClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedOut ? null : { id: "auth-fixture", email: "fixture@fixture.invalid" } } }) } }),
    },
    "@/lib/account-view-access": { getParentViewAccessForAuthUser: async () => access },
    "@/lib/auth/last-view-server": { readLastViewDestination },
  });
  return lib.resolveContinueDestination;
}

// 자주 쓰는 계정 모양(getParentViewAccessForAuthUser 가 돌려주는 값)
const adminWithChild = { hasOwnChildren: true, canUseParentView: true, grants: [], roles: { admin: true, teacher: true, driver: false } };
const adminNoChild = { hasOwnChildren: false, canUseParentView: false, grants: [], roles: { admin: true, teacher: true, driver: false } };
const teacherWithChild = { hasOwnChildren: true, canUseParentView: true, grants: [], roles: { admin: false, teacher: true, driver: false } };
const parentOnly = { hasOwnChildren: true, canUseParentView: true, grants: [], roles: { admin: false, teacher: false, driver: false } };
const parentTeacher = {
  hasOwnChildren: true, canUseParentView: true,
  grants: [{ role: "INSTRUCTOR", status: "ACTIVE" }],
  roles: { admin: false, teacher: true, driver: false },
};
const driverParent = { hasOwnChildren: true, canUseParentView: true, grants: [], roles: { admin: false, teacher: false, driver: true } };

test("쿠키 값은 목록에 있는 화면 키와 정확히 같을 때만 인정한다", () => {
  for (const key of ["admin", "teacher", "driver", "parent"]) assert.equal(parseLastViewKey(key), key);
  for (const bad of [
    "", " ", undefined, null, 0, 1, true, {}, ["parent"],
    "staff", "PARENT", "Parent", " parent", "parent ", "parent\n", "parent;admin", "parent,admin",
    "/admin", "/mypage", "//evil.example", "https://evil.example", "admin%20", "admin\u0000",
    "../admin", "<script>", "__proto__", "constructor", "toString", "0", "auth-user-id-1234", "a@b.co",
  ]) {
    assert.equal(parseLastViewKey(bad), null, `무시해야 합니다: ${JSON.stringify(bad)}`);
  }
});

test("기억할 수 있는 화면 키는 화면 전환 목록의 키와 같은 집합이다", () => {
  // 모든 화면이 열리는 계정(원장 + 자녀)의 목록이 곧 전체 키다.
  const all = resolveAccountViews("ADMIN", true, [{ role: "DRIVER", status: "ACTIVE" }]).map((view) => view.key);
  assert.deepEqual([...all].sort(), [...LAST_VIEW_KEYS].sort());
});

test("쿠키 문자열에는 화면 키만 실리고, 속성은 path=/·180일·samesite=lax·secure 다", () => {
  assert.equal(LAST_VIEW_COOKIE, "stiz-last-view");
  assert.equal(LAST_VIEW_MAX_AGE_SECONDS, 180 * 24 * 60 * 60);
  for (const key of LAST_VIEW_KEYS) {
    assert.equal(buildLastViewCookie(key), `stiz-last-view=${key}; path=/; max-age=15552000; samesite=lax; secure`);
  }
  // 목록 밖 값으로는 쿠키를 만들지 않는다(값에 다른 것을 실어 보낼 길이 없다)
  for (const bad of ["", "staff", "parent; domain=evil.example", "auth-user-id-1234", "a@b.co", undefined, null, {}]) {
    assert.equal(buildLastViewCookie(bad), null);
  }
});

test("브라우저에 굽는 값은 화면 키 하나뿐이다(실행)", () => {
  const written = [];
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { set cookie(value) { written.push(value); } },
  });
  try {
    lastView.rememberLastView("teacher");
    lastView.rememberLastView("auth-user-id-1234");
    lastView.rememberLastView("parent; domain=evil.example");
    lastView.rememberLastView(undefined);
  } finally {
    if (before) Object.defineProperty(globalThis, "document", before);
    else delete globalThis.document;
  }
  assert.deepEqual(written, ["stiz-last-view=teacher; path=/; max-age=15552000; samesite=lax; secure"]);
  // 브라우저가 아니면(서버 그림) 조용히 지나간다
  assert.doesNotThrow(() => lastView.rememberLastView("teacher"));
});

test("소스: 쿠키에 화면 키 외의 것을 실을 길이 없다", () => {
  const pure = stripComments(read("src/lib/auth/last-view.ts"));
  // 쿠키를 쓰는 곳은 한 군데, 그 값은 buildLastViewCookie 가 만든 문자열뿐
  assert.equal(pure.split("document.cookie").length - 1, 1);
  assert.match(pure, /const cookie = buildLastViewCookie\(key\);/);
  assert.match(pure, /document\.cookie = cookie;/);
  assert.match(pure, /return `\$\{LAST_VIEW_COOKIE\}=\$\{safe\}; path=\/; max-age=\$\{LAST_VIEW_MAX_AGE_SECONDS\}; samesite=lax; secure`;/);
  // 순수 모듈 — import 가 없고 계정 정보를 다루지 않는다
  assert.doesNotMatch(pure, /\bimport\b/);
  assert.doesNotMatch(pure, /email|userId|authUserId|token|localStorage|sessionStorage/i);

  // 화면 전환 부품은 화면 키만 넘긴다
  const switcher = stripComments(read("src/components/AccountViewSwitcher.tsx"));
  assert.equal(switcher.split("rememberLastView(").length - 1, 1);
  assert.match(switcher, /if \(!event\.defaultPrevented\) rememberLastView\(view\.key\);/);
  assert.doesNotMatch(switcher, /document\.cookie/);

  // 서버는 이 쿠키를 읽기만 한다(굽거나 지우지 않는다 — 로그아웃해도 남는다)
  const server = stripComments(read("src/lib/auth/last-view-server.ts"));
  assert.match(server, /\.get\(LAST_VIEW_COOKIE\)\?\.value/);
  assert.doesNotMatch(server, /\.set\(|\.delete\(/);
  assert.doesNotMatch(stripComments(read("src/app/actions/auth.ts")), /stiz-last-view|LAST_VIEW_COOKIE/);
});

test("화면 전환에서 이동이 보류되면(수업 진행 중 확인) 기억하지 않고, 기존 onNavigate 는 그대로 먼저 불린다", () => {
  const switcher = read("src/components/AccountViewSwitcher.tsx");
  const navigateAt = switcher.indexOf("onNavigate?.(event, view);");
  const rememberAt = switcher.indexOf("rememberLastView(view.key)");
  assert.ok(navigateAt > 0 && rememberAt > navigateAt, "onNavigate 가 먼저(거기서 preventDefault 할 수 있다)");
  // 가족 연결·내 계정 링크는 «화면»이 아니라 기억하지 않는다
  assert.match(switcher, /onNavigate\?\.\(event, familyOption\); setOpen\(false\);/);
});

test("순수 판정: 권한 있는 화면이면 그 화면, 없으면 null(= 기본 화면)", () => {
  const views = [{ key: "teacher", href: "/staff" }, { key: "parent", href: "/mypage" }];
  assert.equal(resolveLastViewDestination({ cookieValue: "parent", views }), "/mypage");
  assert.equal(resolveLastViewDestination({ cookieValue: "teacher", views }), "/staff");
  // 목록에 없는 화면(다른 계정이 남긴 쿠키)
  assert.equal(resolveLastViewDestination({ cookieValue: "admin", views }), null);
  assert.equal(resolveLastViewDestination({ cookieValue: "driver", views }), null);
  // 쿠키 없음·빈 값·이상한 값
  for (const bad of [undefined, null, "", "staff", "/admin", "PARENT", "parent "]) {
    assert.equal(resolveLastViewDestination({ cookieValue: bad, views }), null);
  }
  // 화면이 하나도 없는 계정
  assert.equal(resolveLastViewDestination({ cookieValue: "parent", views: [] }), null);
});

test("순수 판정: redirect·context·bounced 가 있으면 쿠키를 보지 않는다", () => {
  const views = [{ key: "admin", href: "/admin" }, { key: "parent", href: "/mypage" }];
  assert.equal(resolveLastViewDestination({ cookieValue: "parent", views, requestedPath: "/admin/students" }), null);
  assert.equal(resolveLastViewDestination({ cookieValue: "parent", views, context: "staff-app" }), null);
  assert.equal(resolveLastViewDestination({ cookieValue: "parent", views, context: "staff" }), null);
  assert.equal(resolveLastViewDestination({ cookieValue: "parent", views, bounced: true }), null);
  assert.equal(resolveLastViewDestination({ cookieValue: "parent", views, bounced: false, requestedPath: "", context: "" }), "/mypage");
});

test("서버 판정: 화면 전환 목록과 같은 판정으로 권한을 다시 확인한다", async () => {
  // 원장 + 자녀: 학부모 화면을 골랐으면 학부모 화면
  assert.equal(await serverFixture("parent").read({ role: "ADMIN", access: adminWithChild }), "/mypage");
  assert.equal(await serverFixture("teacher").read({ role: "ADMIN", access: adminWithChild }), "/staff");
  assert.equal(await serverFixture("admin").read({ role: "ADMIN", access: adminWithChild }), "/admin");
  // 관리자가 고른 «기사님»은 운행표(화면 전환 주소 그대로)
  assert.equal(await serverFixture("driver").read({ role: "ADMIN", access: adminWithChild }), "/staff/shuttle");
  // 자녀 없는 원장에게는 학부모 화면이 없다
  assert.equal(await serverFixture("parent").read({ role: "ADMIN", access: adminNoChild }), null);
  // 학부모로 가입해 선생님 승인을 받은 사람
  assert.equal(await serverFixture("teacher").read({ role: "PARENT", access: parentTeacher }), "/staff");
  assert.equal(await serverFixture("parent").read({ role: "PARENT", access: parentTeacher }), "/mypage");
});

test("서버 판정: 다른 계정이 남긴 쿠키는 권한 확인이 걸러 낸다", async () => {
  // 원장이 쓰던 기기에서 학부모가 로그인 — 관리자·선생님·기사님 쿠키는 전부 무시
  for (const key of ["admin", "teacher", "driver"]) {
    assert.equal(await serverFixture(key).read({ role: "PARENT", access: parentOnly }), null, key);
  }
  // 선생님에게 관리자 화면은 없다
  assert.equal(await serverFixture("admin").read({ role: "INSTRUCTOR", access: teacherWithChild }), null);
  // 신청만 한(승인 전) 추가 역할은 화면을 열지 않는다
  const pending = { ...parentOnly, grants: [{ role: "INSTRUCTOR", status: "PENDING" }] };
  assert.equal(await serverFixture("teacher").read({ role: "PARENT", access: pending }), null);
  // 화면 목록에는 있어도 경로 판정이 거절하면 따르지 않는다(두 겹 확인) — 목록과 열린 화면 묶음이 어긋난 경우
  const mismatched = { hasOwnChildren: false, canUseParentView: true, grants: [], roles: { admin: false, teacher: true, driver: false } };
  assert.equal(await serverFixture("parent").read({ role: "INSTRUCTOR", access: mismatched }), null);
  // 자격 값이 비어 있어도(계정을 못 찾은 경우) 터지지 않고 무시
  assert.equal(await serverFixture("parent").read({ role: "INSTRUCTOR", access: { hasOwnChildren: false } }), null);
});

test("서버 판정: 실제 기사님은 기사님 첫 화면으로 보낸다", async () => {
  assert.equal(await serverFixture("driver").read({ role: "DRIVER", access: driverParent }), "/staff/driver");
  assert.equal(await serverFixture("parent").read({ role: "DRIVER", access: driverParent }), "/mypage");
  assert.equal(routes.defaultPathForRole("DRIVER"), "/staff/driver");
});

test("서버 판정: redirect·context·bounced 면 쿠키를 읽지도 않고, 쿠키를 못 읽어도 멈추지 않는다", async () => {
  for (const extra of [{ requestedPath: "/admin" }, { context: "staff-app" }, { context: "staff" }, { bounced: true }]) {
    const { read: readLast, state } = serverFixture("parent");
    assert.equal(await readLast({ role: "ADMIN", access: adminWithChild, ...extra }), null, JSON.stringify(extra));
    assert.equal(state.reads, 0, "쿠키를 볼 일이 없으면 읽지 않는다");
  }
  assert.equal(await serverFixture("parent", { broken: true }).read({ role: "ADMIN", access: adminWithChild }), null);
  assert.equal(await serverFixture(undefined).read({ role: "ADMIN", access: adminWithChild }), null);
  assert.equal(await serverFixture("").read({ role: "ADMIN", access: adminWithChild }), null);
});

test("목적지: 쿠키가 없으면 지금처럼 대표 역할 기본 화면", async () => {
  assert.equal(await continueFixture({ role: "ADMIN", access: adminWithChild })({}), "/admin");
  assert.equal(await continueFixture({ role: "INSTRUCTOR", access: teacherWithChild })({}), "/staff");
  assert.equal(await continueFixture({ role: "PARENT", access: parentTeacher })({}), "/mypage");
  assert.equal(await continueFixture({ role: "DRIVER", access: driverParent })({}), "/staff/driver");
});

test("목적지: 쿠키가 가리킨 화면을 쓸 수 있으면 그 화면(앱 시작 = 빈 입력)", async () => {
  assert.equal(await continueFixture({ role: "ADMIN", cookieValue: "parent", access: adminWithChild })({}), "/mypage");
  assert.equal(await continueFixture({ role: "ADMIN", cookieValue: "teacher", access: adminWithChild })({}), "/staff");
  assert.equal(await continueFixture({ role: "PARENT", cookieValue: "teacher", access: parentTeacher })({}), "/staff");
  assert.equal(await continueFixture({ role: "INSTRUCTOR", cookieValue: "parent", access: teacherWithChild })({}), "/mypage");
});

test("목적지: 권한이 없거나 값이 이상하면 대표 역할 기본 화면", async () => {
  assert.equal(await continueFixture({ role: "PARENT", cookieValue: "admin", access: parentOnly })({}), "/mypage");
  assert.equal(await continueFixture({ role: "ADMIN", cookieValue: "parent", access: adminNoChild })({}), "/admin");
  for (const bad of ["", "staff", "/mypage", "PARENT", "parent;x"]) {
    assert.equal(await continueFixture({ role: "ADMIN", cookieValue: bad, access: adminWithChild })({}), "/admin", bad);
  }
});

test("목적지: 원래 가려던 화면(redirect)이 쿠키보다 먼저다", async () => {
  const go = continueFixture({ role: "ADMIN", cookieValue: "parent", access: adminWithChild });
  assert.equal(await go({ requestedPath: "/admin/students" }), "/admin/students");
  assert.equal(await go({ requestedPath: "/staff" }), "/staff");
  // 못 가는 화면을 원했으면 지금처럼 대표 역할 기본 화면(쿠키로 바꾸지 않는다)
  const parent = continueFixture({ role: "PARENT", cookieValue: "parent", access: parentOnly });
  assert.equal(await parent({ requestedPath: "/admin" }), "/mypage");
  const teacher = continueFixture({ role: "INSTRUCTOR", cookieValue: "parent", access: teacherWithChild });
  assert.equal(await teacher({ requestedPath: "/admin" }), "/staff");
});

test("목적지: 선생님 앱 로그인(context)은 지금 동작 그대로 — 쿠키가 덮어쓰지 않는다", async () => {
  const go = continueFixture({ role: "ADMIN", cookieValue: "parent", access: adminWithChild });
  assert.equal(await go({ context: "staff-app", requestedPath: "/staff" }), "/staff");
  assert.equal(await go({ context: "staff-app" }), "/staff");
  assert.equal(await go({ context: "staff", requestedPath: "/staff" }), "/admin");
  assert.equal(await go({ context: "staff" }), "/admin");
});

test("목적지: 방금 거절돼 돌아왔으면(bounced) 쿠키를 무시하고 기본 화면", async () => {
  const go = continueFixture({ role: "ADMIN", cookieValue: "parent", access: adminWithChild });
  assert.equal(await go({ bounced: true }), "/admin");
  assert.equal(await go({ bounced: false }), "/mypage");
  // 화면은 bounced 를 그대로 넘긴다 — 빠지면 쿠키 화면 → 거절 → 쿠키 화면이 반복된다
  const page = read("src/app/auth/continue/page.tsx");
  assert.match(page, /const requestedPath = bounced \? undefined : requestedPathParam;/);
  assert.match(page, /resolveContinueDestination\(\{ context, requestedPath, bounced \}\)/);
});

test("목적지: 로그인 전·가입 미완료는 쿠키와 무관하게 지금 그대로", async () => {
  assert.equal(await continueFixture({ role: "ADMIN", cookieValue: "parent", access: adminWithChild, signedOut: true })({}), "/login");
  // 앱 계정이 없는 간편로그인 사용자 → 가입 화면
  assert.equal(await continueFixture({ role: null, cookieValue: "parent", access: parentOnly })({}), "/signup/parent?social=1");
  // 휴대폰 인증 전 학부모 → 가입 화면
  assert.equal(
    await continueFixture({ role: "PARENT", cookieValue: "parent", access: parentOnly, username: "parent-user" })({}),
    "/signup/parent?social=1",
  );
  const lib = read("src/lib/auth/continue-destination.ts");
  assert.ok(lib.indexOf("/signup/parent?") < lib.indexOf("readLastViewDestination({"), "가입 확인이 쿠키보다 먼저");
  assert.ok(lib.indexOf("readLastViewDestination({") < lib.indexOf("return resolveRedirectForRole("), "쿠키 판정은 기본 판정 앞");
});
