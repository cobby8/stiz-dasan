// 직원 비밀번호 재설정(2026-11-12) — 초대와 같은 문자 인증 절차를 쓰고, 새 계정 없이 기존 직원 계정만 바꾼다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ADMIN = "src/app/actions/admin.ts";
const INVITE = "src/app/actions/invite.ts";
const MIGRATION = "prisma/migrations/20261112200000_staff_invitation_password_reset/migration.sql";

function slice(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `${start} 없음`);
  const b = end ? src.indexOf(end, a + start.length) : src.length;
  return src.slice(a, b < 0 ? src.length : b);
}

test("재설정 링크는 원장만, 가입된 선생님·기사 한 명에게만, 대기 중 링크가 없을 때 24시간짜리로 만든다", async () => {
  const src = await readFile(ADMIN, "utf8");
  const fn = slice(src, "export async function sendStaffPasswordReset", "/**\n * cancelInvitation");
  assert.match(fn, /await requireOwner\(\)/);
  assert.match(fn, /role IN \('INSTRUCTOR','DRIVER'\) AND "withdrawnAt" IS NULL/);
  assert.match(fn, /staff\.length !== 1/, "같은 번호 계정이 둘 이상이면 고르지 않는다");
  assert.match(fn, /status = 'PENDING' AND "expiresAt" > NOW\(\)/, "대기 중 초대가 있으면 막는다");
  assert.match(fn, /'PASSWORD_RESET', \$4/);
  assert.match(fn, /INTERVAL '1 day'/);
  assert.doesNotMatch(fn, /updateUserById|createUser/, "링크 만들기에서 비밀번호를 바꾸지 않는다");
});

test("초대 거절은 throw 대신 값으로 돌려줘 운영 화면에서도 이유가 보인다", async () => {
  const src = await readFile(ADMIN, "utf8");
  const fn = slice(src, "export async function inviteStaff(", "export async function cancelInvitation");
  assert.match(fn, /return inviteStaffRejected\(/);
  assert.doesNotMatch(fn, /throw new Error\("이미 등록된 스태프입니다\."\)/);
  assert.match(fn, /resetAvailable: resettable/);
  const modal = await readFile("src/app/admin/staff/InviteStaffModal.tsx", "utf8");
  assert.match(modal, /"rejected" in invitation/);
  assert.match(modal, /sendStaffPasswordReset\(/);
});

test("재설정 수락은 새 계정을 만들지 않고 대상 직원(번호·역할 재확인)의 비밀번호만 바꾼다", async () => {
  const src = await readFile(INVITE, "utf8");
  const accept = slice(src, "export async function acceptInvitation");
  const branch = slice(accept, 'if (invitation.purpose === "PASSWORD_RESET")', "const staffEmail =");
  assert.match(branch, /updateUserById\(target\.authUserId \?\? target\.id, \{ password \}\)/);
  assert.match(branch, /role = \$2::"Role" AND "withdrawnAt" IS NULL/);
  assert.match(branch, /regexp_replace\(COALESCE\(phone, ''\)/, "번호가 바뀐 계정은 바꾸지 않는다");
  assert.doesNotMatch(branch, /createUser|INSERT INTO "User"/);
  assert.match(branch, /status = 'ACCEPTED'/, "링크는 한 번만 쓴다");
  // 문자 인증(otpVerifiedAt)·1회 사용 예약은 가입과 같은 UPDATE 를 거친 뒤에만 이 분기에 온다
  assert.ok(accept.indexOf('"otpVerifiedAt" IS NOT NULL') < accept.indexOf('invitation.purpose === "PASSWORD_RESET"'));
});

test("마이그레이션: purpose 기본값 SIGNUP·허용값 제한·재설정은 대상 필수", async () => {
  const sql = await readFile(MIGRATION, "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "purpose" text NOT NULL DEFAULT 'SIGNUP'/);
  assert.match(sql, /CHECK \("purpose" IN \('SIGNUP', 'PASSWORD_RESET'\)\)/);
  assert.match(sql, /CHECK \("purpose" <> 'PASSWORD_RESET' OR "targetUserId" IS NOT NULL\)/);
});
