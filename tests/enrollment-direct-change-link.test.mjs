// 관리자 직접 휴원·퇴원·복귀도 「수강 변경 신청」 화면의 "확인 필요" 목록·배지·건수에 잡히는지 확인한다.
// 직접 변경 원장은 idempotencyKey 가 해시라, 수강 변경 이력 id 를 afterJson 에 실어 잇는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { buildEnrollmentOperationsEvent } from "../src/lib/operations-events/admin-hooks.ts";

const BASE = {
  enrollmentId: "enrollment-1",
  changedAt: new Date("2026-10-05T15:10:00.000Z"),
  actorUserId: "admin-1",
  studentId: "student-1",
  studentName: "홍길동",
  classId: "class-1",
  className: "화요일반",
};

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("이력 id 를 주면 원장 afterJson 에 enrollmentChangeRequestId 가 실린다(휴원·퇴원·복귀 모두)", () => {
  for (const [previousStatus, nextStatus] of [["ACTIVE", "PAUSED"], ["ACTIVE", "WITHDRAWN"], ["PAUSED", "ACTIVE"]]) {
    const event = buildEnrollmentOperationsEvent({ ...BASE, previousStatus, nextStatus, enrollmentChangeRequestId: "ecr-1" });
    assert.equal(event.after.enrollmentChangeRequestId, "ecr-1");
  }
});

test("이력 id 를 안 주면 기존 이벤트 모양 그대로다(다른 호출자 보존)", () => {
  const plain = buildEnrollmentOperationsEvent({ ...BASE, previousStatus: "ACTIVE", nextStatus: "PAUSED" });
  assert.equal(Object.hasOwn(plain.after, "enrollmentChangeRequestId"), false);
  const linked = buildEnrollmentOperationsEvent({ ...BASE, previousStatus: "ACTIVE", nextStatus: "PAUSED", enrollmentChangeRequestId: "ecr-1" });
  assert.deepEqual(linked, { ...plain, after: { ...plain.after, enrollmentChangeRequestId: "ecr-1" } });
});

test("updateEnrollmentStatus 는 이력 INSERT 의 id 를 돌려받아 원장 이벤트에 넘긴다", () => {
  const source = read("src/app/actions/admin.ts");
  const fn = source.slice(source.indexOf("export async function updateEnrollmentStatus"), source.indexOf("export async function deleteEnrollment"));
  const insert = fn.indexOf('INSERT INTO "EnrollmentChangeRequest"');
  const returning = fn.indexOf("RETURNING id", insert);
  const link = fn.indexOf("enrollmentChangeRequestId: history?.id");
  const enqueue = fn.indexOf("enqueueWebsiteOperationsEventInTransaction(tx, event)");
  assert.ok(insert >= 0 && returning > insert, "이력 INSERT 가 id 를 돌려줘야 한다");
  assert.ok(link > returning && enqueue > link, "이력 id 를 이벤트에 실은 뒤 원장에 적재해야 한다");
});

test("목록·확인 필요·건수가 키 연결과 afterJson 연결을 모두 인정하고, 행을 늘리지 않는다", () => {
  const lib = read("src/lib/enrollment/admin-change-request.ts");
  assert.match(lib, /c\."idempotencyKey" = 'enrollment-change:' \|\| r\.id\s+OR c\."afterJson"->>'enrollmentChangeRequestId' = r\.id/);
  // 목록은 LATERAL ... LIMIT 1 → 원장이 여러 건이어도 신청 행이 중복되지 않는다.
  assert.match(lib, /LEFT JOIN LATERAL \(SELECT[\s\S]*?WHERE \$\{LINKED_COMMAND_SQL\}[\s\S]*?LIMIT 1\) oc ON true/);
  // 확인 필요 조건(탭·건수 공용)도 같은 연결 조건을 쓴다.
  assert.match(lib, /const NEEDS_CHECK_SQL = `EXISTS \(SELECT 1 FROM "OperationsCommand" c[\s\S]*?WHERE \$\{LINKED_COMMAND_SQL\}/);
  assert.doesNotMatch(lib, /LEFT JOIN "OperationsCommand" oc ON/);
  // 복귀는 학부모 신청 종류에 없어 따로 이름을 붙인다.
  assert.match(lib, /row\.kind === "RESUME" \? "복귀"/);
});
