import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync("src/app/actions/admin.ts", "utf8");
const functionSource = source.slice(
  source.indexOf("export async function createParentRequest"),
  source.indexOf("export async function updateRequestStatus"),
);

test("학부모 요청은 관리자 권한이 아니라 인증된 학부모 신원으로 저장한다", () => {
  assert.match(functionSource, /const parent = await requireVerifiedParent\(\)/);
  assert.doesNotMatch(functionSource, /await requireAdmin\(\)/);
  assert.match(functionSource, /parent\.appUserId,\s*ownedStudent\.id/);
  assert.doesNotMatch(functionSource, /data\.userId,\s*data\.studentId/);
});

test("요청 학생이 인증된 부모 소유인지 서버에서 확인한다", () => {
  assert.match(functionSource, /prisma\.student\.findFirst/);
  assert.match(functionSource, /where:\s*\{\s*id:\s*studentId, \.\.\.await childAccessWhere\(parent\.appUserId\) \}/);
  assert.match(functionSource, /if \(!ownedStudent\)/);
});

test("요청 유형과 사용자 입력 길이 및 날짜를 검증한다", () => {
  for (const type of ["ABSENCE", "SHUTTLE", "EARLY_LEAVE", "OTHER"]) {
    assert.match(functionSource, new RegExp(`"${type}"`));
  }
  assert.match(functionSource, /title\.length > 200/);
  assert.match(functionSource, /content\.length > 2000/);
  assert.match(functionSource, /Number\.isNaN\(requestedDate\.getTime\(\)\)/);
});

test("관리자 알림 생성 흐름은 유지한다", () => {
  assert.match(functionSource, /SELECT id FROM "User" WHERE role = 'ADMIN'/);
  assert.match(functionSource, /createNotificationRecord/);
  assert.match(functionSource, /linkUrl:\s*"\/admin\/requests"/);
});

test("요청 저장 후 관리자 알림 실패는 접수 실패로 반환하지 않는다", () => {
  assert.match(functionSource, /Parent request saved, but admin notification failed/);
  const notificationCatch = functionSource.slice(functionSource.indexOf("Parent request saved, but admin notification failed"));
  assert.doesNotMatch(notificationCatch, /throw new Error/);
  assert.match(functionSource, /throw new Error\("요청 접수에 실패했습니다\."\)/);
});
