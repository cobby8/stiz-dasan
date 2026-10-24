import test from "node:test";
import assert from "node:assert/strict";
import { interpretParentOperationsRequest, validateConfirmedParentOperationsDraft } from "../src/lib/parentOperationsInterpretation.ts";

const enrollments = [{ enrollmentId: "e1", classId: "tue5", className: "화요일 5교시", status: "ACTIVE", dayOfWeek: "Tuesday", startTime: "17:00", endTime: "18:00", slotKey: "Tue-5" }];
const classes = [
  { classId: "tue5", className: "화요일 5교시", programName: "정규", dayOfWeek: "Tuesday", startTime: "17:00", endTime: "18:00", slotKey: "Tue-5" },
  { classId: "sat3", className: "토요일 3교시", programName: "정규", dayOfWeek: "Saturday", startTime: "13:00", endTime: "14:00", slotKey: "Sat-3" },
];

test("수업 변경과 셔틀 중단을 복수 명령으로 해석한다", () => {
  const result = interpretParentOperationsRequest({ sourceText: "9월 3일부터 화요일 5교시를 토요일 3교시로 바꾸고, 셔틀은 안 탈게요", targetMonth: "2026-09", enrollments, classes });
  assert.equal(result.commands.length, 2);
  assert.deepEqual(result.commands.map((item) => item.kind), ["CLASS_CHANGE", "SHUTTLE_STOP"]);
  assert.equal(result.commands[0].fromClassId, "tue5");
  assert.equal(result.commands[0].toClassId, "sat3");
  assert.equal(result.commands[1].shuttleIntent, "STOP");
});

test("없는 반은 만들지 않고 확인 질문으로 보류한다", () => {
  const result = interpretParentOperationsRequest({ sourceText: "9월 3일부터 목요일 9교시로 바꿔주세요", targetMonth: "2026-09", enrollments, classes });
  assert.equal(result.readyToSubmit, false);
  assert.equal(result.commands[0].toClassId, null);
  assert.match(result.blockingQuestions.join(" "), /실제 개설반/);
});

test("학부모가 확정해도 서버의 실제 반 목록 밖 ID는 거부한다", () => {
  const sourceText = "9월 3일부터 토요일 3교시로 변경";
  assert.throws(() => validateConfirmedParentOperationsDraft({ sourceText, targetMonth: "2026-09", commands: [{ sourceText, kind: "CLASS_CHANGE", effectiveDate: "2026-09-03", fromClassId: "tue5", toClassId: "invented", shuttleIntent: null, details: sourceText, confidence: "HIGH", warnings: [], blockingQuestions: [] }] }, { sourceText, targetMonth: "2026-09", enrollments, classes }), /실제로 개설된 수업/);
});

test("쉼표 없이 이어 쓴 수업 변경과 셔틀 중단도 두 요청으로 해석한다", () => {
  const result = interpretParentOperationsRequest({ sourceText: "9월 3일부터 화요일 5교시를 토요일 3교시로 바꾸고 셔틀은 안 탈게요", targetMonth: "2026-09", enrollments, classes });
  assert.deepEqual(result.commands.map((item) => item.kind), ["CLASS_CHANGE", "SHUTTLE_STOP"]);
});

test("화면 예시 문장도 실제 반만 사용해 수업 변경과 셔틀 중단으로 해석한다", () => {
  const result = interpretParentOperationsRequest({ sourceText: "9월부터 화요일 수업을 토요일 3교시로 옮기고 셔틀은 이용하지 않을게요.", targetMonth: "2026-09", enrollments, classes });
  assert.deepEqual(result.commands.map((item) => item.kind), ["CLASS_CHANGE", "SHUTTLE_STOP"]);
  assert.equal(result.commands[0].fromClassId, "tue5");
  assert.equal(result.commands[0].toClassId, "sat3");
  assert.equal(result.commands[1].shuttleIntent, "STOP");
});

test("월말을 넘긴 실제로 존재하지 않는 날짜는 서버가 거부한다", () => {
  const sourceText = "9월 31일부터 토요일 3교시로 변경";
  assert.throws(() => validateConfirmedParentOperationsDraft({ sourceText, targetMonth: "2026-09", commands: [{ sourceText, kind: "CLASS_CHANGE", effectiveDate: "2026-09-31", fromClassId: "tue5", toClassId: "sat3", shuttleIntent: null, details: sourceText, confidence: "HIGH", warnings: [], blockingQuestions: [] }] }, { sourceText, targetMonth: "2026-09", enrollments, classes }), /적용일/);
});

test("수업 변경의 현재 반을 누락해 확인 질문을 우회할 수 없다", () => {
  const sourceText = "토요일 3교시로 변경";
  assert.throws(() => validateConfirmedParentOperationsDraft({ sourceText, targetMonth: "2026-09", commands: [{ sourceText, kind: "CLASS_CHANGE", effectiveDate: "2026-09-03", fromClassId: null, toClassId: "sat3", shuttleIntent: null, details: sourceText, confidence: "HIGH", warnings: [], blockingQuestions: [] }] }, { sourceText, targetMonth: "2026-09", enrollments, classes }), /현재 수업/);
});

test("현재 등록이 바뀐 뒤에는 예전 반 기준 확정안을 거부한다", () => {
  const sourceText = "토요일 3교시로 변경";
  const changedEnrollments = [{ ...enrollments[0], classId: "sat3", className: "토요일 3교시", dayOfWeek: "Saturday", slotKey: "Sat-3" }];
  assert.throws(() => validateConfirmedParentOperationsDraft({ sourceText, targetMonth: "2026-09", commands: [{ sourceText, kind: "CLASS_CHANGE", effectiveDate: "2026-09-03", fromClassId: "tue5", toClassId: "sat3", shuttleIntent: null, details: sourceText, confidence: "HIGH", warnings: [], blockingQuestions: [] }] }, { sourceText, targetMonth: "2026-09", enrollments: changedEnrollments, classes }), /현재 수업 정보가 달라졌습니다/);
});

test("UNKNOWN 직접 제출은 신뢰도 HIGH로 승격되지 않는다", () => {
  const sourceText = "잘 모르겠지만 처리해주세요";
  const result = validateConfirmedParentOperationsDraft({ sourceText, targetMonth: "2026-09", commands: [{ sourceText, kind: "UNKNOWN", effectiveDate: "2026-09-03", fromClassId: null, toClassId: null, shuttleIntent: null, details: sourceText, confidence: "HIGH", warnings: [], blockingQuestions: [] }] }, { sourceText, targetMonth: "2026-09", enrollments, classes });
  assert.equal(result.commands[0].confidence, "LOW");
});

test("셔틀 요청에는 종류와 일치하는 셔틀 상태만 제출할 수 있다", () => {
  const sourceText = "셔틀 이용을 중단합니다";
  assert.throws(() => validateConfirmedParentOperationsDraft({ sourceText, targetMonth: "2026-09", commands: [{ sourceText, kind: "SHUTTLE_STOP", effectiveDate: "2026-09-03", fromClassId: null, toClassId: null, shuttleIntent: "START", details: sourceText, confidence: "HIGH", warnings: [], blockingQuestions: [] }] }, { sourceText, targetMonth: "2026-09", enrollments, classes }), /셔틀/);
});
