import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const action = fs.readFileSync("src/app/actions/kakao-parent-intake-admin.ts", "utf8");
const page = fs.readFileSync("src/app/admin/kakao-requests/page.tsx", "utf8");
const client = fs.readFileSync("src/app/admin/kakao-requests/KakaoRequestsClient.tsx", "utf8");
const migration = fs.readFileSync("prisma/migrations/20260903160000_add_kakao_intake_admin_review/migration.sql", "utf8");

test("관리자 검토는 인증된 학생 안정 ID를 확인한다", () => {
  assert.match(action, /identityStatus !== "ACTIVE"/);
  assert.match(action, /structuredStudentId !== intake\.studentId/);
  assert.match(action, /studentParentId !== intake\.parentUserId/);
});

test("완성된 운영 명령만 PENDING으로 이관하고 외부 실행은 HELD로 유지한다", () => {
  assert.match(action, /verifyReviewDetails/);
  assert.match(action, /'HIGH','PENDING'/);
  assert.match(action, /'HELD','HELD'/);
  assert.match(action, /billingStatus: "HELD", notificationStatus: "HELD", externalWrites: false, notificationsSent: false/);
});

test("관리자가 보완한 값은 학부모 확인값과 구분한다", () => {
  assert.match(action, /const parentConfirmed = effectiveDate === savedEffectiveDate/);
  assert.match(action, /parentConfirmed: verified\.parentConfirmed/);
  assert.match(action, /adminReviewed: true, parentReconfirmationRequired: !verified\.parentConfirmed/);
  assert.match(client, /관리자 보완값은 학부모 재확인 전/);
});

test("적용일·현재반·희망반·셔틀 요청을 실제 운영 데이터로 검증한다", () => {
  assert.match(action, /isRealDate\(effectiveDate\)/);
  assert.match(action, /e\.status IN \('ACTIVE','PAUSED'\)/);
  assert.match(action, /c\."dayOfWeek"<>'Seasonal' AND p\."deletedAt" IS NULL/);
  assert.match(action, /activeCount >= targetRows\[0\]\.capacity/);
  assert.match(action, /이미 수강 중이거나 휴원 중인 반/);
  assert.match(action, /SHUTTLE_START_STOP/);
});

test("동시 중복 처리와 감사 누락을 막는다", () => {
  assert.match(action, /"operationsRequestId" IS NULL/);
  assert.match(action, /KakaoParentIntakeAudit/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "KakaoParentIntake_operationsRequestId_key"/);
});

test("접수함은 처리 필터와 안전 경계를 보여준다", () => {
  assert.match(page, /NEEDS_DETAILS/);
  assert.match(client, /review:\{ \.\.\.detail/);
  assert.match(client, /검토 정보 저장 및 운영 원장 이관/);
  assert.match(client, /외부 서비스 반영과 알림 발송은 별도 승인 전까지 보류됩니다/);
});

test("접수함은 학생을 중심으로 표시하고 보호자 개인정보를 줄인다", () => {
  assert.match(client, /text-xl font-black[^>]*>\{row\.studentName/);
  assert.match(client, /연결 자녀/);
  assert.match(page, /function maskName/);
  assert.match(page, /parentName:maskName\(row\.rawParentName\)/);
  assert.match(page, /mergedIntoStudentId:null/);
  assert.doesNotMatch(client, /rawParentName|parentUserId/);
});
