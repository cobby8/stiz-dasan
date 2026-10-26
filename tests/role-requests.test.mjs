import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTsModule } from "./_ts-module.mjs";

// 다중 역할 3단계 — 가입할 때 역할을 고르고, 선생님·기사님은 «신청»으로만 쌓인다(원장 결정 2026-10-25).
// 가장 무서운 사고: 신청 화면이 바로 ACTIVE 를 써서, 고르기만 한 사람에게 학생 개인정보가 열리는 것.

const routes = await loadTsModule("src/lib/auth-routes.ts");
const { effectiveRoles } = await loadTsModule("src/lib/account/roles.ts");

const action = fs.readFileSync("src/app/actions/role-requests.ts", "utf8");
const page = fs.readFileSync("src/app/mypage/roles/page.tsx", "utf8");
const client = fs.readFileSync("src/app/mypage/roles/RolesClient.tsx", "utf8");
const signup = fs.readFileSync("src/components/auth/ParentSignupClient.tsx", "utf8");
const accountLayout = fs.readFileSync("src/app/mypage/layout.tsx", "utf8");
const myPage = fs.readFileSync("src/components/account/AccountLinks.tsx", "utf8");
const continuePage = fs.readFileSync("src/app/auth/continue/page.tsx", "utf8");
const loginAction = fs.readFileSync("src/app/actions/auth.ts", "utf8");
const viewAccess = fs.readFileSync("src/lib/account-view-access.ts", "utf8");

const access = (primaryRole, grants = []) => {
  const roles = effectiveRoles({ primaryRole, grants: grants.map((role) => ({ role, status: "ACTIVE" })), hasStudents: false });
  return { admin: roles.admin, teacher: roles.teacher, driver: roles.driver };
};

// ── 로그인 직후 목적지(실제 실행) ──────────────────────────────────────────────
test("묶음을 넘겨도 추가 역할이 없으면 모든 사람의 목적지가 예전과 똑같다", () => {
  // 기존 사용자 동작을 바꾸지 않는 것이 1순위다. 역할 5종 × 경로 9종 × 옵션 3종을 전부 대조한다.
  const paths = ["/admin", "/admin/students", "/staff", "/staff/students", "/staff/shuttle", "/mypage", "/mypage/roles", "/", "https://evil.example"];
  const optionSets = [{}, { stayInStaffApp: true }, { preferRoleHome: true }];
  for (const role of ["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER", "PARENT"]) {
    for (const path of paths) {
      assert.equal(
        routes.canRoleAccessPath(role, path, { roles: access(role) }),
        routes.canRoleAccessPath(role, path),
        `${role} ${path} 접근 판정이 바뀌었다`,
      );
      for (const options of optionSets) {
        assert.equal(
          routes.resolveRedirectForRole(role, path, { ...options, roles: access(role) }),
          routes.resolveRedirectForRole(role, path, options),
          `${role} ${path} ${JSON.stringify(options)} 목적지가 바뀌었다`,
        );
      }
    }
  }
});

test("승인된 추가 역할이 있으면 그 화면으로 보낸다", () => {
  // 학부모 + 선생님 승인 — 선생님 앱으로 로그인하면 선생님 화면.
  assert.equal(routes.resolveRedirectForRole("PARENT", "/staff", { stayInStaffApp: true, roles: access("PARENT", ["INSTRUCTOR"]) }), "/staff");
  assert.equal(routes.resolveRedirectForRole("PARENT", "/staff/students", { roles: access("PARENT", ["INSTRUCTOR"]) }), "/staff/students");
  // 학부모 + 기사님 승인 — 앱 영역 안의 셔틀 화면.
  assert.equal(routes.resolveRedirectForRole("PARENT", "/staff", { stayInStaffApp: true, roles: access("PARENT", ["DRIVER"]) }), "/staff/shuttle");
  // 선생님 + 기사님 — 둘 다 열린다.
  assert.equal(routes.canRoleAccessPath("INSTRUCTOR", "/staff/shuttle", { roles: access("INSTRUCTOR", ["DRIVER"]) }), true);
  assert.equal(routes.canRoleAccessPath("INSTRUCTOR", "/staff", { roles: access("INSTRUCTOR", ["DRIVER"]) }), true);
});

test("추가 역할로도 관리자 화면·남의 범위는 열리지 않는다", () => {
  assert.equal(routes.canRoleAccessPath("PARENT", "/admin", { roles: access("PARENT", ["INSTRUCTOR", "DRIVER"]) }), false);
  // 기사님 승인만으로 선생님 화면이 열리면 안 된다(학생 개인정보).
  assert.equal(routes.canRoleAccessPath("PARENT", "/staff/students", { roles: access("PARENT", ["DRIVER"]) }), false);
  // 외부 주소는 어떤 역할이어도 거절.
  assert.equal(routes.resolveRedirectForRole("PARENT", "https://evil.example", { roles: access("PARENT", ["INSTRUCTOR"]) }), "/mypage");
});

test("로그인 두 곳이 같은 묶음을 넘기고, 묶음은 서버가 계산한다", () => {
  assert.match(continuePage, /roles: parentView\.roles/);
  assert.match(loginAction, /roles: parentView\.roles/);
  // 묶음의 원천은 서버 조회(주 역할 + ACTIVE 추가 역할). 화면에서 받은 값을 쓰면 안 된다.
  assert.match(viewAccess, /const grants = await getActiveGrantsForViews\(appUserId\)/);
  assert.match(viewAccess, /effectiveRoles\(\{ primaryRole: account\.role, grants, hasStudents: hasOwnChildren \}\)/);
  assert.match(viewAccess, /WHERE "userId" = \$1 AND status = 'ACTIVE'/);
  // 계정 ID·추가 역할 목록은 화면 전환 응답으로 새지 않는다(views 만 나간다).
  assert.match(viewAccess, /return \{ role, views: resolveAccountViews\(role, parent\.canUseParentView, parent\.grants\) \};/);
});

// ── 신청 액션 계약 ───────────────────────────────────────────────────────────
test("신청 화면은 PENDING 만 쓴다 — 절대 바로 ACTIVE 로 만들지 않는다", () => {
  assert.match(action, /VALUES \(\$1, \$2, 'PENDING', 'REQUEST'\)/);
  // 읽기(status IN ('PENDING','ACTIVE'))는 괜찮다. 막을 것은 «쓰기»로 ACTIVE 를 만드는 것.
  assert.doesNotMatch(action, /VALUES \([^)]*'ACTIVE'/, "신청 액션이 ACTIVE 로 INSERT 하고 있다");
  assert.doesNotMatch(action, /SET[^`]*status = 'ACTIVE'/, "신청 액션이 ACTIVE 로 UPDATE 하고 있다");
  // INSERT 는 한 곳뿐이고 그것이 PENDING 이어야 한다.
  assert.equal((action.match(/INSERT INTO "UserRoleGrant"/g) ?? []).length, 1);
  // 두 번 눌러도 하나만 — 부분 유니크 인덱스에 맞춘 ON CONFLICT.
  assert.match(action, /ON CONFLICT \("userId", role\) WHERE status IN \('PENDING', 'ACTIVE'\) DO NOTHING/);
});

test("신청은 휴대폰 인증까지 끝난 본인만, 아는 역할만", () => {
  for (const fn of ["getMyRoleRequests", "requestStaffRoles", "cancelStaffRoleRequest"]) {
    const start = action.indexOf(`export async function ${fn}`);
    assert.ok(start > 0, `${fn} 가 없다`);
    assert.match(action.slice(start, start + 200), /await requireVerifiedParent\(\)/, `${fn} 가 인증을 거치지 않는다`);
  }
  // 관리자·학부모·오타가 하나라도 섞이면 통째로 거절(조용히 버리면 화면·서버 어긋남을 못 찾는다).
  assert.match(action, /if \(!list\.every\(isGrantableRole\)\) return \{ error:/);
  // 대상은 언제나 로그인한 본인 — 화면이 보낸 사용자 ID 를 받지 않는다.
  assert.doesNotMatch(action, /export async function requestStaffRoles\([^)]*userId/);
});

test("취소는 신청 중인 것만 — 승인된 역할은 본인이 못 내린다", () => {
  assert.match(action, /WHERE "userId" = \$1 AND role = \$2 AND status = 'PENDING'/);
  assert.match(action, /SET status = 'REVOKED', "decidedAt" = NOW\(\), note = '본인 취소'/);
});

test("원장 알림이 실패해도 신청은 남는다", () => {
  assert.match(action, /try \{\s*await notifyAdmins\([\s\S]*?\} catch \(error\) \{\s*console\.error\("\[requestStaffRoles\] 원장 알림 실패:"/);
});

// ── 화면 ─────────────────────────────────────────────────────────────────────
test("가입 첫 화면에서 역할을 여러 개 고르고, 직원 역할은 신청 화면으로 이어 간다", () => {
  for (const label of ["학부모", "선생님", "기사님"]) assert.match(signup, new RegExp(`label: "${label}"`));
  assert.match(signup, /aria-pressed=\{option\.on\}/);
  // 고르기만 해서는 안 열린다는 것을 누르기 전에 알린다.
  assert.match(signup, /원장님 확인 후<\/b> 열립니다/);
  // 따로 가려던 곳이 없을 때만 신청 화면으로 바꾼다(수강신청 연결 등 기존 목적지를 덮지 않는다).
  assert.match(signup, /staffRoles\.length > 0 && requestedNext === "\/mypage"\s*\n?\s*\? `\/mypage\/roles\?request=\$\{staffRoles\.join\(","\)\}`/);
  // 아무 역할도 안 골랐으면 가입을 시작하지 않는다.
  assert.match(signup, /disabled=\{noRoleChosen\}/);
  // 간편가입 링크도 같은 목적지를 들고 간다(다른 사이트에 다녀와도 유지).
  assert.match(signup, /const continueParams = new URLSearchParams\(\{ next \}\)/);
});

test("신청 화면은 인증된 본인만, 주소창 값은 아는 역할만 미리 고른다", () => {
  assert.match(page, /requireVerifiedParent\(\)/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /\.filter\(isGrantableRole\)/);
  // 미리 고르기만 하고 신청은 학부모가 직접 누른다(주소만 열어서 신청되면 안 된다).
  assert.doesNotMatch(page, /requestStaffRoles/);
  assert.match(client, /onClick=\{submit\}/);
  // 이미 열렸거나 신청 중인 역할은 다시 고를 수 없다.
  assert.match(client, /row\.state === "NONE" \? \(\s*\n?\s*<input/);
});

test("마이페이지에서 신청 화면으로 가는 길이 있다", () => {
  // 화면만 있고 길이 없으면 아무도 못 쓴다(이 프로젝트에서 2회 실측).
  assert.match(myPage, /href="\/mypage\/roles"/);
  assert.match(myPage, /역할 추가 신청/);
  assert.match(accountLayout, /\{children\}\s*<AccountLinks\s*\/>/);
});
