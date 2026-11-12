import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const staffClientSource = await readFile("src/app/admin/staff/StaffClient.tsx", "utf8");
const queriesSource = await readFile("src/lib/queries.ts", "utf8");
const adminActionSource = await readFile("src/app/actions/admin.ts", "utf8");
const inviteActionSource = await readFile("src/app/actions/invite.ts", "utf8");
const linkSource = await readFile("src/lib/staff-coach-link.ts", "utf8");

test("staff coach link selector is visible for admin, vice admin, and instructors", () => {
  assert.match(staffClientSource, /role === "ADMIN" \|\| role === "VICE_ADMIN" \|\| role === "INSTRUCTOR"/);
  // 코치 역할이 아니어도 예전 연결이 남아 있으면 해제할 수 있게 선택칸을 보인다(2026-11-12)
  assert.match(staffClientSource, /canManage && \(isCoachLinkable\(user\.role\) \|\| Boolean\(user\.coachId\)\)/);
  assert.match(staffClientSource, /handleCoachLink\(user\.id, e\.target\.value\)/);
});

test("스태프 관리 화면은 앱 계정과 별도로 코치 프로필을 보여준다(계정 없는 코치는 같은 표의 줄로)", () => {
  assert.match(staffClientSource, /코치 프로필/);
  assert.match(staffClientSource, /row\.kind === "coach"/);
  assert.match(staffClientSource, /앱 연결됨/);
  assert.match(staffClientSource, /앱 미연결/);
  assert.match(queriesSource, /SELECT id, name, role, phone, "userId"/);
});

test("만료된 스태프 초대도 이력에서 재발송할 수 있다", () => {
  assert.match(staffClientSource, /pastInvitations\.slice\(0, 20\)\.map/);
  assert.match(staffClientSource, /inv\.status === "PENDING"/);
  assert.match(staffClientSource, /handleResendInvitation\(inv\.id, inv\.name\)/);
});

// 2026-11-12: 직접 추가는 없앴다 — 코치 자동 연결은 초대 가입(새 기록·전환·재입사) 경로에만 남는다
test("스태프 가입(초대·전환·재입사)은 기존 코치 프로필을 자동 연결한다", () => {
  assert.match(linkSource, /input\.role !== "INSTRUCTOR"/);
  assert.match(linkSource, /regexp_replace\(COALESCE\(phone, ''\)/);
  assert.match(linkSource, /lower\(trim\(name\)\) = lower\(trim\(\$3\)\)/);
  assert.match(inviteActionSource, /linkMatchingCoachProfileToUser\(tx/);
  assert.match(inviteActionSource, /await linkCoachProfileIfNone\(tx,/);
  assert.doesNotMatch(adminActionSource, /export async function createStaffUser\(/);
});
