import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRosterEnrollmentReport,
  indexRosterEnrollments,
  rosterCopyWarningText,
  rosterEntryFlags,
  summarizeRosterEnrollmentReport,
  // @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
} from "./regularRosterEnrollmentCheckLogic.ts";

// 명단 행 한 줄(기본 = 월요일 17:00~18:00 등원, 학생 s1)
function r(over: Record<string, unknown> = {}) {
  return {
    id: `r-${Math.random()}`, weekday: 1, classTime: "17:00~18:00", arriveTime: "16:40", stopName: "다산자이 정문", direction: "BOARD",
    studentName: "김민준", studentId: "s1", studentPhone: null, parentPhone: "010-1111-2222", note: null, sortOrder: 1, ...over,
  };
}
const both = (over: Record<string, unknown> = {}) => [r(over), r({ ...over, direction: "ALIGHT", arriveTime: "18:20" })];

test("다니는 반이 있고 그 요일 수업이 있으면 경고 없음", () => {
  const index = indexRosterEnrollments([{ studentId: "s1", weekday: 1, status: "ACTIVE" }]);
  assert.deepEqual(rosterEntryFlags({ studentId: "s1", board: {}, alight: {} }, 1, index), []);
});

test("수강이 없으면 «다니는 반 없음», 휴원만 있으면 «다니는 반 없음(휴원)» — 요일 경고는 겹쳐 붙이지 않는다", () => {
  const none = rosterEntryFlags({ studentId: "s1", board: {}, alight: {} }, 1, indexRosterEnrollments([]));
  assert.deepEqual(none.map((f: { label: string }) => f.label), ["다니는 반 없음"]);
  const paused = rosterEntryFlags({ studentId: "s1", board: {}, alight: {} }, 1, indexRosterEnrollments([{ studentId: "s1", weekday: 1, status: "PAUSED" }]));
  assert.deepEqual(paused.map((f: { label: string }) => f.label), ["다니는 반 없음(휴원)"]);
});

test("다니는 반은 있지만 그 요일이 아니면 «수업 없는 요일»(반 변경 뒤 남은 행)", () => {
  const index = indexRosterEnrollments([{ studentId: "s1", weekday: 3, status: "ACTIVE" }, { studentId: "s1", weekday: 1, status: "PAUSED" }]);
  const flags = rosterEntryFlags({ studentId: "s1", board: {}, alight: {} }, 1, index);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, "NO_CLASS_ON_DAY");
  assert.match(flags[0].detail, /다니는 요일: 수/);
});

test("등원·하원 한쪽만이면 «등원만»/«하원만»(참고)", () => {
  const index = indexRosterEnrollments([{ studentId: "s1", weekday: 1, status: "ACTIVE" }]);
  assert.deepEqual(rosterEntryFlags({ studentId: "s1", board: {}, alight: null }, 1, index).map((f: { label: string }) => f.label), ["등원만"]);
  assert.deepEqual(rosterEntryFlags({ studentId: "s1", board: null, alight: {} }, 1, index).map((f: { label: string }) => f.label), ["하원만"]);
});

test("학생 연결이 없는(이름만) 행은 수강 판단을 하지 않는다", () => {
  assert.deepEqual(rosterEntryFlags({ studentId: null, board: {}, alight: {} }, 1, indexRosterEnrollments([])), []);
});

test("한 달 보고서: 학생 단위로 모으고, 문제/참고를 나누고, 요약 한 줄을 만든다", () => {
  const rows = [
    ...both(), // s1 월 — 정상
    ...both({ weekday: 3, studentId: "s1" }), // s1 수 — 수업 없는 요일
    ...both({ weekday: 5, studentId: "s1" }), // s1 금 — 수업 없는 요일(같은 학생 → where 2곳)
    ...both({ studentId: "s2", studentName: "이서연", parentPhone: "010-3333-4444" }), // s2 퇴원
    r({ studentId: "s3", studentName: "박하준", parentPhone: "010-5555-6666" }), // s3 등원만
    ...both({ studentId: null, studentName: "최이름", parentPhone: "010-7777-8888" }), // 연결 없음
    { ...r(), direction: "PIVOT", studentName: null }, // 운영 정차는 무시
  ];
  const report = buildRosterEnrollmentReport(rows, [
    { studentId: "s1", weekday: 1, status: "ACTIVE" },
    { studentId: "s3", weekday: 1, status: "ACTIVE" },
  ]);
  assert.deepEqual(report.problems.map((p: { studentName: string }) => p.studentName), ["김민준", "이서연"]);
  assert.deepEqual(report.notes.map((p: { studentName: string }) => p.studentName), ["박하준"]);
  assert.deepEqual(report.problems[0].flags[0].where, ["수 17:00~18:00", "금 17:00~18:00"]);
  assert.equal(report.unlinkedCount, 1);
  assert.equal(summarizeRosterEnrollmentReport(report), "다니는 반 없음 1명 · 수업 없는 요일 1명 · 한쪽만 1명");

  const text = rosterCopyWarningText(report);
  assert.match(text, /확인이 필요한 학생 2명/);
  assert.match(text, /이서연 — 다니는 반 없음/);
  assert.match(text, /자동으로 빼지 않습니다/);
});

test("확인할 학생이 없으면 복사 경고 문구는 빈 문자열, 많으면 «외 N명»", () => {
  const ok = buildRosterEnrollmentReport(both(), [{ studentId: "s1", weekday: 1, status: "ACTIVE" }]);
  assert.equal(rosterCopyWarningText(ok), "");
  assert.equal(summarizeRosterEnrollmentReport(ok), "");
  const many = buildRosterEnrollmentReport(
    Array.from({ length: 5 }, (_, i) => both({ studentId: `x${i}`, studentName: `학생${i}`, parentPhone: `010-0000-000${i}` })).flat(),
    [],
  );
  assert.match(rosterCopyWarningText(many, 2), /외 3명/);
});
