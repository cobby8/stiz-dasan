import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadTsModule } from "./_ts-module.mjs";

// 다중 역할 5단계 — 기사님이 문자 링크 없이 앱 로그인만으로 오늘 운행표를 연다(2026-10-25).
//
// 운행 화면은 학원 공용 고정 링크(ShuttleRunLink, ROLLING)를 열쇠로 연다. 로그인한 기사님에게는
// 서버가 그 열쇠를 찾아 같은 화면을 열어 준다. 가장 무서운 사고: 열쇠를 돌려주는 함수가
// **권한 확인 없이 다른 곳에서도 불려** 아무나 운행표(학생 이름·주소·학부모 전화)를 보게 되는 것.

const finderSource = fs.readFileSync("src/lib/shuttle/regularRun.ts", "utf8");
const runPage = fs.readFileSync("src/app/staff/run/page.tsx", "utf8");
// 안드로이드 앱 «로그인만으로 운행 시작» 길(2026-11-16) — 같은 권한 확인 뒤 운행 링크 화면으로 보낸다
const runOpenPage = fs.readFileSync("src/app/staff/run/open/page.tsx", "utf8");
const sessionRules = await loadTsModule("src/lib/staff-session-rules.ts");
const shuttlePage = fs.readFileSync("src/app/staff/shuttle/page.tsx", "utf8");
const driverHome = fs.readFileSync("src/app/driver/DriverHomeClient.tsx", "utf8");
const routes = await loadTsModule("src/lib/auth-routes.ts");
const { effectiveRoles } = await loadTsModule("src/lib/account/roles.ts");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full.split(path.sep).join("/"));
  }
  return out;
}

test("열쇠를 돌려주는 함수는 권한을 확인한 운행표 화면 두 곳에서만 불린다", () => {
  const callers = walk("src")
    .filter((file) => !file.endsWith("src/lib/shuttle/regularRun.ts"))
    .filter((file) => /findRollingDriverRunToken/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(callers.sort(), ["src/app/staff/run/open/page.tsx", "src/app/staff/run/page.tsx"], `열쇠 함수를 부르는 곳이 늘었다: ${callers.join(", ")}`);
});

test("운행표 화면은 셔틀 권한을 먼저 확인한 뒤에야 열쇠를 찾는다", () => {
  const guardAt = runPage.indexOf("const staff = await requireStaff();");
  const scopeAt = runPage.indexOf('if (shuttleScope(staff.roles) === "NONE") redirect("/staff");');
  const tokenAt = runPage.indexOf("await findRollingDriverRunToken()");
  assert.ok(guardAt > 0 && scopeAt > guardAt && tokenAt > scopeAt, "인증 → 셔틀 권한 → 열쇠 순서여야 한다");
  // 로그인 경로는 열쇠를 기기에 기억시키지 않는다(계정이 곧 열쇠). 기억시키면 로그아웃해도 남는다.
  assert.doesNotMatch(runPage, /rememberToken/);
  assert.match(runPage, /export const dynamic = "force-dynamic"/);
  // 날짜 입력은 서버에서 검증한 뒤에만(기존 /driver/[token] 과 같게).
  assert.match(runPage, /isValidRunDate\(sp\.date\)/);
});

test("앱 길(/staff/run/open)도 인증 → 셔틀 권한 → 열쇠 순서이고, 운행 링크 화면으로만 보낸다", () => {
  const guardAt = runOpenPage.indexOf("const staff = await requireStaff();");
  const scopeAt = runOpenPage.indexOf('if (shuttleScope(staff.roles) === "NONE") redirect("/staff");');
  const tokenAt = runOpenPage.indexOf("await findRollingDriverRunToken()");
  assert.ok(guardAt > 0 && scopeAt > guardAt && tokenAt > scopeAt, "인증 → 셔틀 권한 → 열쇠 순서여야 한다");
  assert.match(runOpenPage, /export const dynamic = "force-dynamic"/);
  assert.match(runOpenPage, /redirect\(`\/driver\/\$\{token\}`\)/);
  // 열쇠를 화면에 그리지 않는다(서버 이동만)
  assert.doesNotMatch(runOpenPage, /return \(/);
});

test("기사님 운행 화면 주소: 안드로이드 스토어 앱만 앱 길, 브라우저·아이폰은 기존 운행표", () => {
  const android = "Mozilla/5.0 (Linux; Android 15) STIZApp/1.0.3 (android)";
  assert.equal(sessionRules.driverRunPathFor(true, android), "/staff/run/open");
  assert.equal(sessionRules.driverRunPathFor(false, android), "/staff/run");
  assert.equal(sessionRules.driverRunPathFor(true, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"), "/staff/run");
  assert.equal(sessionRules.driverRunPathFor(false, null), "/staff/run");
  // 앱 길은 막힌 주소(/staff/run 정확히)와 달라야 한다 — 앱 AppNavigationPolicy.needsAccountRunHandoff
  assert.notEqual(sessionRules.DRIVER_APP_RUN_PATH, "/staff/run");
  assert.notEqual(sessionRules.DRIVER_APP_RUN_PATH, "/staff/run/");
});

test("열쇠 함수는 찾기만 하고 만들지 않으며, 형식이 맞는 열쇠만 돌려준다", () => {
  const fn = finderSource.slice(finderSource.indexOf("export async function findRollingDriverRunToken"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 3);
  assert.match(body, /SELECT "token" FROM "ShuttleRunLink"/);
  assert.doesNotMatch(body, /INSERT|UPDATE|DELETE/, "열쇠 함수가 DB 를 바꾼다 — 만드는 건 원장 전용이다");
  assert.match(body, /\/\^\[a-f0-9\]\{16,64\}\$\/\.test\(token\)/);
  // 고정(오늘) 링크만 — 특정 날짜 링크를 잘못 돌려주면 엉뚱한 날 명단이 열린다.
  assert.match(body, /WHERE "serviceDate" = \$1/);
  assert.match(body, /ROLLING_DATE,/);
});

test("경로 판정: 기사님은 운행표를 열고, 선생님만인 사람은 못 연다", () => {
  const access = (role, grants = []) => {
    const r = effectiveRoles({ primaryRole: role, grants: grants.map((g) => ({ role: g, status: "ACTIVE" })), hasStudents: false });
    return { admin: r.admin, teacher: r.teacher, driver: r.driver };
  };
  assert.equal(routes.canRoleAccessPath("DRIVER", "/staff/run"), true);
  assert.equal(routes.canRoleAccessPath("ADMIN", "/staff/run"), true);
  assert.equal(routes.canRoleAccessPath("INSTRUCTOR", "/staff/run"), false);
  assert.equal(routes.canRoleAccessPath("PARENT", "/staff/run"), false);
  // 학부모 + 기사님 승인자 — 로그인하면 바로 운행표로 돌아온다.
  assert.equal(routes.resolveRedirectForRole("PARENT", "/staff/run", { roles: access("PARENT", ["DRIVER"]) }), "/staff/run");
  // 선생님 + 기사님도 연다.
  assert.equal(routes.canRoleAccessPath("INSTRUCTOR", "/staff/run", { roles: access("INSTRUCTOR", ["DRIVER"]) }), true);
  // 비슷한 이름의 다른 주소까지 열리면 안 된다.
  assert.equal(routes.canRoleAccessPath("DRIVER", "/staff/runner"), false);
});

test("운행표로 가는 길이 두 곳에 있다", () => {
  // 셔틀 화면 맨 위 — 로그인한 기사님·관리자.
  assert.match(shuttlePage, /await authorizeAssign\(staff\)/);
  assert.match(shuttlePage, /getRegularDriverDay\(date\)/); // 2026-11-14: 섹션 + 휴무 안내
  assert.match(shuttlePage, /<UnifiedDriverClient/);
  assert.doesNotMatch(shuttlePage, /findRollingDriverRunToken/);
  // 2026-11-13 b7: 이 운행표(계정용)엔 위치 전송이 없다 → 맨 위에 «운행 시작(위치 전송)» 진입 버튼으로 /staff/run 을 연다.
  // 2026-11-16: 기사님 첫 화면을 거쳐 간다(안드로이드 앱은 위치 공유 되는 운행 링크 화면, 브라우저는 /staff/run).
  // 2026-11-18(원장 결정 F): 버튼은 «운행 시작을 눌러 왔다» 표시(?start=1)를 달고 간다 — 표시 없이 온 첫 화면은 셔틀 명단으로 돌아온다.
  assert.match(shuttlePage, /href=\{DRIVER_START_HREF\}[\s\S]*?운행 시작 \(위치 전송\)/);
  assert.equal(sessionRules.DRIVER_START_HREF, "/staff/driver?start=1");
  // 기사님 앱 첫 화면(링크를 기억 못 한 경우) — 로그인 후 운행표로 돌아오게.
  assert.match(driverHome, /redirect: "\/staff\/shuttle"/);
});

// 2026-11-17 뒤로 가기 조사(native #7): 열쇠가 없을 때 /staff/run 으로 넘기면 안드로이드 앱이 그 주소를 막아 «여는 중…»에서 멈춘다
test("앱 길에서 오늘 운행 열쇠가 없으면: 스토어 앱은 셔틀 화면, 브라우저는 안내가 있는 운행표", () => {
  // 2026-11-18(원장 결정 G): 셔틀 화면으로 보낼 때 «아직 운행 링크가 없습니다» 안내 표시를 싣는다
  assert.equal(sessionRules.driverRunMissingKeyPath(true), "/staff/shuttle?notice=no-run");
  assert.equal(sessionRules.driverRunMissingKeyPath(true).split("?")[0], sessionRules.DRIVER_SHUTTLE_PATH);
  assert.equal(sessionRules.driverRunMissingKeyPath(false), "/staff/run");
  // 앱으로 보내는 주소는 앱이 막는 주소(/staff/run 정확히)가 아니어야 한다
  assert.notEqual(sessionRules.driverRunMissingKeyPath(true), sessionRules.DRIVER_RUN_PATH);
  // 화면은 요청의 사용자 에이전트 표식으로 스토어 앱을 가른다 — 열쇠 확인 «뒤»에만(권한 순서는 위 테스트가 고정)
  assert.match(runOpenPage, /if \(!token\) \{[\s\S]*?const storeApp = looksLikeStoreApp\(\{ userAgent: \(await headers\(\)\)\.get\("user-agent"\) \}\);\s*redirect\(driverRunMissingKeyPath\(storeApp\)\);\s*\}/);
  assert.doesNotMatch(runOpenPage, /redirect\("\/staff\/run"\)/);
  // 셔틀 화면은 열쇠 없이 열린다(같은 곳으로 다시 튕기지 않는다)
  assert.doesNotMatch(shuttlePage, /findRollingDriverRunToken/);
});
