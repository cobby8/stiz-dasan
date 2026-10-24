import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const routing = readFileSync("src/lib/kakao-parent-intake-routing.ts", "utf8");
const route = readFileSync("src/app/api/cron/kakao-parent-intake-routing/route.ts", "utf8");

test("카카오 접수 라우터는 잠금과 수동 복구로 중복 처리를 막는다", () => {
  assert.match(routing, /FOR UPDATE SKIP LOCKED/);
  assert.match(routing, /status = 'PROCESSING'/);
  assert.match(routing, /AND r\.status = 'SUBMITTED'/);
  assert.doesNotMatch(routing, /PROCESSING'.*interval/s);
  assert.match(routing, /자동 재실행하지 않고/);
  assert.match(routing, /WHERE id=\$1 AND status='PROCESSING'/);
});

test("완전한 결석과 당일 셔틀만 기존 검증 함수로 자동 반영한다", () => {
  assert.match(routing, /AUTO_KINDS[\s\S]*REGULAR_ABSENCE[\s\S]*SHUTTLE_SKIP[\s\S]*SHUTTLE_LOCATION/);
  assert.match(routing, /reportRegularAbsence/);
  assert.match(routing, /submitShuttleException/);
  assert.match(routing, /MISSING_STRUCTURED_FIELDS/);
  assert.match(routing, /text\(data\.studentId\) !== intake\.studentId/);
});

test("수강 청구 지속 셔틀 연락처 상담은 관리자 승인 대기로 남긴다", () => {
  assert.match(routing, /if \(!AUTO_KINDS\.has\(intake\.kind\)\)/);
  assert.match(routing, /ADMIN_APPROVAL_REQUIRED/);
  assert.match(routing, /PENDING_APPROVAL/);
  assert.match(routing, /finish\(intake, \"APPLIED\"/);
  assert.match(routing, /finish\(intake, \"HELD\"/);
  assert.match(routing, /도메인 반영이 끝난 뒤 이 상태 기록만 실패하면 PROCESSING으로 남긴다/);
  assert.doesNotMatch(routing, /finish\(intake, \"FAILED\"/);
  assert.match(routing, /manual reconciliation required/);
});

test("전달 대상별 상태를 구조화 결과에 남긴다", () => {
  assert.match(routing, /ADMIN_AND_VICE_ADMIN/);
  assert.match(routing, /ASSIGNED_CLASS_COACH/);
  assert.match(routing, /SHUTTLE_DRIVER/);
  assert.match(routing, /delivery = result\.notification/);
  assert.match(routing, /admin: delivery\?\.admin \?\? "NOTIFICATION_FAILED"/);
  assert.match(routing, /driver: delivery\?\.driver \?\? "NOT_FOUND"/);
});

test("cron 라우트는 CRON_SECRET 인증 뒤에만 처리한다", () => {
  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /authorization/);
  assert.match(route, /routeSubmittedKakaoIntakes\(20\)/);
});
