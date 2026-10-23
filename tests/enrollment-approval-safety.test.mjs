import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildEnrollmentOperationsEvent } from "../src/lib/operations-events/admin-hooks.ts";

const source = readFileSync("src/app/actions/admin.ts", "utf8");
const modalSource = readFileSync("src/app/admin/apply/ApplyAdminModals.tsx", "utf8");
const approval = source.slice(
  source.indexOf("export async function approveEnrollApplication"),
  source.indexOf("export async function rejectEnrollApplication"),
);

test("수강 승인 서버 액션에는 외부·관리자 알림 우회 경로가 없다", () => {
  assert.equal(approval.includes("sendNotifications"), false);
  assert.equal(approval.includes("sendParentSmsWithResult"), false);
  assert.equal(approval.includes("notifyAdmins("), false);
});

test("관리자 승인 화면은 외부 알림을 선택할 수 없고 정원 재확인에서도 미발송을 유지한다", () => {
  assert.equal(modalSource.includes("sendNotifications"), false);
  assert.equal(modalSource.includes("승인 알림 함께 발송"), false);
  assert.match(modalSource, /await handleApprove\(classIds, note, parentUserId, true\)/);
  assert.match(modalSource, /안내 알림은 발송하지 않았습니다/);
});

test("신규·복귀 수강만 활성화하고 같은 트랜잭션에서 운영 원장을 적재한다", () => {
  assert.match(approval, /if \(existingEnrollment\?\.status === "ACTIVE"\) continue/);
  assert.match(approval, /ON CONFLICT \("studentId", "classId"\) DO UPDATE\s+SET status = 'ACTIVE'/);
  assert.match(approval, /buildEnrollmentOperationsEvent\(\{/);
  assert.match(approval, /enqueueWebsiteOperationsEventInTransaction\(tx, event\)/);
});

test("수강 생성 이벤트는 홈페이지 완료·시트와 랠리즈 대기 원장에 사용할 CLASS_ADD다", () => {
  const event = buildEnrollmentOperationsEvent({
    enrollmentId: "enrollment-1",
    changedAt: new Date("2026-09-01T01:00:00.000Z"),
    actorUserId: "admin-1",
    studentId: "student-1",
    studentName: "테스트학생",
    classId: "class-1",
    className: "토요일 2교시",
    previousStatus: null,
    nextStatus: "ACTIVE",
  });

  assert.equal(event?.eventType, "ENROLLMENT_CREATED");
  assert.equal(event?.kind, "CLASS_ADD");
  assert.equal(event?.before, null);
  assert.equal(event?.after.status, "ACTIVE");
});

test("이미 ACTIVE인 동일 수강은 빌더도 원장 이벤트를 만들지 않는다", () => {
  assert.equal(buildEnrollmentOperationsEvent({
    enrollmentId: "enrollment-1",
    changedAt: new Date("2026-09-01T01:00:00.000Z"),
    actorUserId: "admin-1",
    studentId: "student-1",
    studentName: "테스트학생",
    classId: "class-1",
    className: "토요일 2교시",
    previousStatus: "ACTIVE",
    nextStatus: "ACTIVE",
  }), null);
});
