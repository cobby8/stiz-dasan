import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { checkRosterRows, parseClassTimeRange } from "./regularRosterCheckLogic.ts";

// 명단 행 한 줄(기본 = 수요일 17:00~18:00 등원)
function r(over: Record<string, unknown> = {}) {
  return {
    id: "r1", weekday: 3, classTime: "17:00~18:00", arriveTime: "16:40", stopName: "다산자이 정문", direction: "BOARD",
    studentName: "김민준", studentId: "s1", studentPhone: null, parentPhone: "010-1111-2222", note: null, sortOrder: 1, ...over,
  };
}

test("수업시간 범위를 읽고, 못 읽으면 null", () => {
  assert.deepEqual(parseClassTimeRange("17:00~18:00"), { start: 1020, end: 1080 });
  assert.deepEqual(parseClassTimeRange("17:00 ~ 18:30"), { start: 1020, end: 1110 });
  assert.equal(parseClassTimeRange("저녁반"), null);
  assert.equal(parseClassTimeRange(null), null);
});

test("정상 명단은 경고가 없다", () => {
  assert.deepEqual(checkRosterRows([
    r(),
    r({ id: "r2", direction: "ALIGHT", arriveTime: "18:10" }),
    r({ id: "r3", studentId: "s2", studentName: "이서연", arriveTime: "16:40" }), // 같은 정류장·같은 시각은 정상
  ]), []);
});

test("하원 행이 승차로 잘못 들어가면(2026-10-02 수요일 사례) 등원 시각 경고", () => {
  const issues = checkRosterRows([r(), r({ id: "bad", studentId: "s2", studentName: "김하준", arriveTime: "18:10" })]);
  const hit = issues.find((i: { kind: string }) => i.kind === "BOARD_AFTER_START");
  assert.ok(hit);
  assert.deepEqual(hit.rowIds, ["bad"]);
  assert.match(hit.message, /수요일 17:00~18:00 등원/);
  assert.match(hit.message, /김하준 18:10/);
});

test("하원 시각이 수업 종료보다 이르면 경고(정각은 경고 안 함)", () => {
  const issues = checkRosterRows([
    r({ id: "a1", direction: "ALIGHT", arriveTime: "16:50" }),
    r({ id: "a2", direction: "ALIGHT", studentId: "s2", studentName: "나", arriveTime: "18:00", stopName: "다른곳" }),
  ]);
  const hit = issues.filter((i: { kind: string }) => i.kind === "ALIGHT_BEFORE_END");
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].rowIds, ["a1"]);
});

test("같은 요일·수업·방향에 같은 학생 행 2개 → 중복 경고", () => {
  const issues = checkRosterRows([r(), r({ id: "r2", stopName: "다른 정류장" })]);
  const hit = issues.find((i: { kind: string }) => i.kind === "DUPLICATE_STUDENT");
  assert.ok(hit);
  assert.deepEqual(hit.rowIds, ["r1", "r2"]);
});

test("수업시간이 비면 기사님 화면에서 빠진다고 경고(요일·방향별 한 줄)", () => {
  const issues = checkRosterRows([r({ id: "n1", classTime: null }), r({ id: "n2", classTime: "", studentId: "s2", studentName: "나" })]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, "NO_CLASS_TIME");
  assert.deepEqual(issues[0].rowIds, ["n1", "n2"]);
});

test("같은 정류장 이름이 시각이 다르게 두 번 → 합쳐짐 경고", () => {
  const issues = checkRosterRows([r(), r({ id: "r2", studentId: "s2", studentName: "나", arriveTime: "16:45" })]);
  const hit = issues.find((i: { kind: string }) => i.kind === "STOP_TIME_CONFLICT");
  assert.ok(hit);
  assert.match(hit.message, /16:40 \/ 16:45/);
});

test("운영 정차(PIVOT·RETURN)와 이름 없는 행은 점검하지 않는다", () => {
  assert.deepEqual(checkRosterRows([r({ direction: "PIVOT", arriveTime: "23:00" }), r({ id: "x", studentName: null, classTime: null })]), []);
});
