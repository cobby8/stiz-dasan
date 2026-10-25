import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// 다중 역할 4단계 — 원장이 직원 역할 신청을 승인·반려하고, 부여한 역할을 회수한다.
// 그리고 이미 학부모 계정이 있는 사람을 초대하면 새 계정 대신 그 계정에 역할을 붙인다.
//
// 승인은 «학생 개인정보를 여는 일»이다. 가장 무서운 사고 셋:
//   ① 부원장·선생님이 승인해 버림  ② 처리된 건이 다시 처리됨(목록이 낡았을 때)
//   ③ 번호만 같은 엉뚱한 계정에 선생님 권한이 붙음

const action = fs.readFileSync("src/app/actions/role-requests-admin.ts", "utf8");
const page = fs.readFileSync("src/app/admin/role-requests/page.tsx", "utf8");
const client = fs.readFileSync("src/app/admin/role-requests/RoleRequestsClient.tsx", "utf8");
const shell = fs.readFileSync("src/app/admin/AdminShellClient.tsx", "utf8");
const admin = fs.readFileSync("src/app/actions/admin.ts", "utf8");
const inviteModal = fs.readFileSync("src/app/admin/staff/InviteStaffModal.tsx", "utf8");
const authGuard = fs.readFileSync("src/lib/auth-guard.ts", "utf8");
const requestAction = fs.readFileSync("src/app/actions/role-requests.ts", "utf8");

test("관리자 메뉴에서 직원 역할 신청 화면에 도달할 수 있다", () => {
  // 화면만 있고 메뉴가 없으면 아무도 못 쓴다(이 프로젝트 2회 실측). 학부모 요청 계열 묶음 안에.
  const group = shell.slice(shell.indexOf("업무별 상세 메뉴"), shell.indexOf("홈페이지·소식"));
  assert.match(group, /\["\/admin\/role-requests", "직원 역할 신청"/);
  // 3단계 신청 알림이 이 화면을 가리킨다 — 둘이 어긋나면 알림을 눌러도 길을 잃는다.
  assert.match(requestAction, /"\/admin\/role-requests"/);
});

test("승인·반려·회수는 원장만, 목록은 원장·부원장", () => {
  // 직원 역할 변경(updateUserRole)이 원장 전용이라 같은 기준. 승인 권한을 넓히면 새는 길이 늘어난다.
  assert.match(action, /export async function getRoleGrantsForAdmin\(\) \{\s*const admin = await requireAdmin\(\);/);
  assert.match(action, /async function transition\([\s\S]*?\) \{\s*const owner = await requireOwner\(\);/);
  for (const fn of ["approveRoleRequest", "rejectRoleRequest", "revokeRoleGrant"]) {
    assert.match(action, new RegExp(`export async function ${fn}\\([^)]*\\) \\{[\\s\\S]*?return transition\\(`), `${fn} 가 transition(=원장 확인)을 거치지 않는다`);
  }
  assert.match(admin, /export async function updateUserRole[\s\S]{0,120}requireOwner\(\)/);
  // 화면 버튼 표시는 참고용이고, 실제 권한은 액션이 다시 본다.
  assert.match(action, /canDecide: admin\.appUserRole === "ADMIN"/);
  assert.match(client, /\{!canDecide \? \(/);
});

test("상태 전이는 «지금 상태»를 조건에 걸어 한 줄만 바꾼다", () => {
  // 목록이 낡았을 때 이미 처리된 건을 다시 처리하면, 반려한 사람이 승인되거나 회수한 역할이 살아난다.
  assert.match(action, /WHERE id = \$1 AND status = \$5/);
  assert.match(action, /if \(affected !== 1\) \{/);
  assert.match(action, /return transition\(grantId, "PENDING", "ACTIVE", "원장 승인"\)/);
  assert.match(action, /return transition\(grantId, "PENDING", "REJECTED", note\)/);
  assert.match(action, /return transition\(grantId, "ACTIVE", "REVOKED", "원장 회수"\)/);
  // 누가 처리했는지 남긴다(DB CHECK 가 decidedAt 을 강제한다).
  assert.match(action, /"decidedAt" = NOW\(\), "decidedBy" = \$3/);
  assert.match(authGuard, /export async function requireOwner[\s\S]*?appUserId: appUser\.id/);
});

test("목록은 살아 있는 건만, 탈퇴한 계정은 빼고, 판단 근거를 함께 보여준다", () => {
  assert.match(action, /WHERE g\.status IN \('PENDING', 'ACTIVE'\)\s*\n\s*AND u\."withdrawnAt" IS NULL/);
  assert.match(action, /s\."mergedIntoStudentId" IS NULL/);
  // 승인이 무엇을 여는지, 회수는 바로 막힌다는 것을 누르기 전에 알린다.
  assert.match(client, /승인하면 그 사람에게 학생 정보가 보이기 시작합니다/);
  assert.match(client, /confirming === row\.id/);
  assert.match(client, /승인 확정/);
  assert.match(client, /회수 확정/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
});

// ── 초대 링크 연동 ───────────────────────────────────────────────────────────
test("이미 학부모 계정이 있으면 새 계정 대신 그 계정에 역할을 붙인다", () => {
  // 초대 수락은 항상 새 로그인 계정을 만든다 — 그대로 두면 같은 사람의 계정이 둘로 갈린다.
  const invite = admin.slice(admin.indexOf("export async function inviteStaff"), admin.indexOf("export async function cancelInvitation"));
  assert.match(invite, /VALUES \(\$1, \$2, 'ACTIVE', 'INVITE', NOW\(\), \$3, '원장 초대'\)/);
  // 신청 중이던 건이 있으면 그대로 승인된다(살아 있는 건은 하나뿐).
  assert.match(invite, /ON CONFLICT \("userId", role\) WHERE status IN \('PENDING', 'ACTIVE'\)\s*\n\s*DO UPDATE SET status = 'ACTIVE'/);
  assert.match(invite, /return \{\s*grantedExisting: true as const/);
  // 원장 전용 액션 안에서만 일어난다.
  assert.match(invite, /const user = await requireOwner\(\);/);
});

test("붙이는 조건은 엄격하다 — 번호 주인이 확인된 학부모 계정이 정확히 하나일 때만", () => {
  const invite = admin.slice(admin.indexOf("export async function inviteStaff"), admin.indexOf("export async function cancelInvitation"));
  // 번호 인증 안 된 계정·탈퇴 계정에는 붙이지 않는다(엉뚱한 사람에게 학생 정보가 열린다).
  assert.match(invite, /AND "phoneVerifiedAt" IS NOT NULL AND "withdrawnAt" IS NULL/);
  // 둘 이상이면 누군지 모른다 → 예전처럼 초대 링크.
  assert.match(invite, /LIMIT 2/);
  assert.match(invite, /if \(parentAccounts\.length === 1\) \{/);
  // 번호는 숫자만 남겨 비교하고, 빈 번호·자리채움 번호는 열쇠로 쓰지 않는다(4가족 사고).
  assert.match(invite, /regexp_replace\(COALESCE\(phone, ''\), '\[\^0-9\]', '', 'g'\) = \$1 AND role = 'PARENT'/);
  assert.match(invite, /isUsablePhoneKey\(inviteDigits\)/);
});

test("초대 화면은 «링크 발송»과 «기존 계정에 부여»를 구분해 보여준다", () => {
  // 링크가 없는 결과에 「링크 복사」가 남으면 빈 값을 복사한다.
  assert.match(inviteModal, /\{result\?\.grantedExisting \? \(/);
  assert.match(inviteModal, /if \(!result \|\| result\.grantedExisting\) return;/);
  assert.match(inviteModal, /if \(!result \|\| result\.grantedExisting \|\| !navigator\.share\) return;/);
  assert.match(inviteModal, /기존 계정에 \{form\.role === "DRIVER" \? "기사님" : "선생님"\} 역할을 추가했습니다/);
});
