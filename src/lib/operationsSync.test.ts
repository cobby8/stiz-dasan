import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error -- Node의 타입 제거 실행기는 런타임 확장자를 요구한다.
import { overallSyncStatus, parseOperationsRequest } from "./operationsSync.ts";

test("학부모 요청을 학생별 동기화 명령으로 나눈다", () => {
  const commands = parseOperationsRequest("김민서 9월 휴원, 서정빈 셔틀 탑승", "2026-09");

  assert.equal(commands.length, 2);
  assert.deepEqual(commands.map(({ studentName, kind, effectiveMonth }) => ({ studentName, kind, effectiveMonth })), [
    { studentName: "김민서", kind: "PAUSE", effectiveMonth: "2026-09" },
    { studentName: "서정빈", kind: "SHUTTLE_START", effectiveMonth: "2026-09" },
  ]);
  assert.notEqual(commands[0].idempotencyKey, commands[1].idempotencyKey);
});

test("알 수 없는 요청은 자동 실행하지 않고 보류한다", () => {
  const [command] = parseOperationsRequest("김민서 확인 부탁", "2026-09");
  assert.equal(command.kind, "UNKNOWN");
  assert.equal(command.confidence, "LOW");
  assert.match(command.holdReason || "", /변경 종류/);
});

test("휴원 종료는 휴원이 아니라 복귀로 구분한다", () => {
  const [command] = parseOperationsRequest("신이준 9월 휴원 종료", "2026-09");
  assert.equal(command.studentName, "신이준");
  assert.equal(command.kind, "RESUME");
});

test("세 시스템이 모두 끝나기 전에는 동기화 완료가 아니다", () => {
  assert.equal(overallSyncStatus(["SUCCEEDED", "SUCCEEDED", "PENDING"]), "PENDING");
  assert.equal(overallSyncStatus(["SUCCEEDED", "FAILED", "PENDING"]), "PARTIAL");
  assert.equal(overallSyncStatus(["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"]), "SYNCED");
});
