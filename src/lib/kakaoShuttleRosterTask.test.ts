import assert from "node:assert/strict";
import test from "node:test";

import {
  isShuttleRosterTask,
  shuttleRosterTaskDoneAt,
  shuttleRosterTaskHref,
  shuttleRosterTaskNextStatus,
  shuttleRosterTaskSummary,
  // @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
} from "./kakaoShuttleRosterTask.ts";

// 카카오 대화 접수(buildRegularShuttleIntake)가 실제로 저장하는 모양
const startJson = {
  studentId: "s1", studentName: "김민준", kind: "SHUTTLE_START_STOP", effectiveDate: "2026-11-10", shuttleIntent: "START",
  regularShuttle: { action: "START", days: ["월", "수"], direction: "BOTH", place: "다산자이 정문", time: null, effectiveDate: "2026-11-10" },
  source: "KAKAO_FLOW",
};
const row = (over: Record<string, unknown> = {}) => ({ kind: "SHUTTLE_START_STOP", status: "HELD", studentId: "s1", structuredJson: startJson, ...over });

test("정규 셔틀 신청(START) 접수는 처리 전이면 할 일", () => {
  for (const status of ["SUBMITTED", "HELD", "FAILED", "NEEDS_DETAILS", "CONSULTATION", "APPROVED"]) assert.equal(isShuttleRosterTask(row({ status })), true, status);
});

test("중단·장소 변경·종결·대화 미완료·학생 미연결·이미 완료는 할 일이 아니다", () => {
  assert.equal(isShuttleRosterTask(row({ structuredJson: { ...startJson, shuttleIntent: "STOP", regularShuttle: { ...startJson.regularShuttle, action: "STOP" } } })), false);
  assert.equal(isShuttleRosterTask(row({ kind: "SHUTTLE_CHANGE" })), false);
  for (const status of ["APPLIED", "REJECTED", "CANCELED", "CONSULTATION_CLOSED", "SHUTTLE_FLOW", "PROCESSING"]) assert.equal(isShuttleRosterTask(row({ status })), false, status);
  assert.equal(isShuttleRosterTask(row({ studentId: null })), false);
  assert.equal(isShuttleRosterTask(row({ structuredJson: { ...startJson, rosterTask: { doneAt: "2026-11-08T01:00:00Z" } } })), false);
  assert.equal(shuttleRosterTaskDoneAt({ rosterTask: { doneAt: "x" } }), "x");
  assert.equal(shuttleRosterTaskDoneAt(null), null);
});

test("검토값만 START 인 접수(대화 외 경로)도 할 일로 본다", () => {
  assert.equal(isShuttleRosterTask(row({ structuredJson: { studentId: "s1", shuttleIntent: "START" } })), true);
});

test("요약 한 줄과 명단 화면 주소", () => {
  assert.equal(shuttleRosterTaskSummary(startJson), "월·수 · 등원·하원 · 장소 다산자이 정문 · 11/10부터");
  assert.equal(shuttleRosterTaskSummary({ regularShuttle: { days: ["전체"], direction: "PICKUP" } }), "다니는 요일 전체 · 등원");
  assert.equal(shuttleRosterTaskSummary(null), "");
  assert.equal(shuttleRosterTaskHref("s1", startJson), "/admin/shuttle/regular?month=2026-11&studentId=s1");
  assert.equal(shuttleRosterTaskHref("s 1", {}), "/admin/shuttle/regular?studentId=s+1");
});

test("처리 완료 뒤 상태: 결정 전 → APPLIED, 이관 → 그대로, 자동 분류 중·종결 → 완료 불가", () => {
  for (const s of ["SUBMITTED", "HELD", "FAILED", "NEEDS_DETAILS", "CONSULTATION"]) assert.equal(shuttleRosterTaskNextStatus(s), "APPLIED");
  assert.equal(shuttleRosterTaskNextStatus("APPROVED"), "APPROVED");
  for (const s of ["PROCESSING", "APPLIED", "REJECTED", "SHUTTLE_FLOW"]) assert.equal(shuttleRosterTaskNextStatus(s), null);
});
