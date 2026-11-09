import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { planStudentReassign, reassignLabel } from "./regularReassignLogic.ts";

// 반 이동 재배정 판정(D4) — 반 요일 변경·시각 변경·퇴원·휴원·등원만 타는 학생(오탐 없음)·두 반 요일.

let seq = 0;
function r(over: Record<string, unknown> = {}): any {
  seq += 1;
  return {
    id: `r${String(seq).padStart(3, "0")}`, serviceMonth: "2026-11", weekday: 2, weekdayLabel: "화", classTime: "17:00~18:00", arriveTime: "16:40",
    stopName: "푸르지오 정문", direction: "BOARD", studentName: "허재원", studentId: "s1", studentPhone: null, parentPhone: "010-1234-5678",
    note: null, sortOrder: seq, latitude: 37.61, longitude: 127.15, ...over,
  };
}
const cls = (weekday: number, startTime: string, endTime: string, status: "ACTIVE" | "PAUSED" = "ACTIVE") =>
  ({ weekday, startTime, endTime, className: null, programName: null, status });
const student = (enrolled: any[]) => ({ studentId: "s1", name: "허재원", parentPhone: "010-1234-5678", enrolled });
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("화 → 목 반 이동: 등원·하원 둘 다 옛 칸(화)·새 칸(목) 짝, 옛 칸 정류장이 기본값으로 따라온다", () => {
  const stops = [
    r({ id: "b1" }), r({ id: "a1", direction: "ALIGHT", stopName: "푸르지오 후문", arriveTime: "18:10" }),
    // 다른 학생의 목요일 칸 — 수업시간 글자 맞춤 재료
    r({ id: "o1", weekday: 4, studentId: "x", studentName: "다른", parentPhone: "010-0000-0000", classTime: "17:00~18:00" }),
  ];
  const plan = plain(planStudentReassign(student([cls(4, "17:00", "17:55")]), stops));
  assert.equal(plan.pairs.length, 2);
  assert.deepEqual(plan.removeOnly, []);
  const [board, alight] = plan.pairs;
  assert.equal(board.direction, "BOARD");
  assert.deepEqual([board.from.weekday, board.from.rowIds, board.from.stopName], [2, ["b1"], "푸르지오 정문"]);
  assert.deepEqual([board.to.weekday, board.to.classTime], [4, "17:00~18:00"]); // 그 요일 명단 글자에 맞춤
  assert.equal(board.label, "화→목 등원 (반 이동)");
  assert.deepEqual([alight.from.rowIds, alight.to.weekday, alight.from.stopName], [["a1"], 4, "푸르지오 후문"]);
});

test("같은 요일 시각만 바뀜(화 17시 → 화 18시): 같은 요일끼리 짝", () => {
  const stops = [r({ id: "b1" })];
  const plan = plain(planStudentReassign(student([cls(2, "18:00", "18:55")]), stops));
  assert.equal(plan.pairs.length, 1);
  assert.deepEqual([plan.pairs[0].from.weekday, plan.pairs[0].to.weekday, plan.pairs[0].to.classTime], [2, 2, "18:00~18:55"]);
  assert.equal(plan.pairs[0].label, "화 17:00→18:00 등원 (반 이동)");
});

test("오탐 없음: 반이 그대로면 빈 결과 · 등원만 타는 학생은 하원 칸을 띄우지 않는다", () => {
  const stops = [r({ id: "b1" })];
  assert.deepEqual(plain(planStudentReassign(student([cls(2, "17:00", "17:55")]), stops)), { pairs: [], removeOnly: [] });
  // 수업 끝 표기(17:55)가 명단(18:00)과 달라도 시작 시각이 같으면 같은 반.
  assert.deepEqual(plain(planStudentReassign(student([cls(2, "17:00", "18:00")]), stops)).pairs, []);
});

test("새 칸만 생김(요일 추가) = 재배정 아님 — 일부러 안 타는 요일일 수 있다", () => {
  const stops = [r({ id: "b1" })];
  const plan = plain(planStudentReassign(student([cls(2, "17:00", "17:55"), cls(4, "17:00", "17:55")]), stops));
  assert.deepEqual(plan, { pairs: [], removeOnly: [] });
});

test("퇴원(수강 없음)·요일 줄임 = 빼기 필요(removeOnly), 재배정 아님", () => {
  const stops = [r({ id: "b1" }), r({ id: "b2", weekday: 4, weekdayLabel: "목" })];
  const none = plain(planStudentReassign(student([]), stops));
  assert.equal(none.pairs.length, 0);
  assert.deepEqual(none.removeOnly.map((c: any) => c.rowIds[0]), ["b1", "b2"]);
  const fewer = plain(planStudentReassign(student([cls(2, "17:00", "17:55")]), stops));
  assert.deepEqual([fewer.pairs.length, fewer.removeOnly.map((c: any) => c.rowIds[0])], [0, ["b2"]]);
});

test("휴원은 재배정 아님 — 모두 휴원이면 아무것도 띄우지 않고, 휴원 요일 행도 옛 칸이 아니다", () => {
  const stops = [r({ id: "b1" })];
  assert.deepEqual(plain(planStudentReassign(student([cls(2, "17:00", "17:55", "PAUSED")]), stops)), { pairs: [], removeOnly: [] });
  // 화 휴원 + 목 다님(새 반) → 화 행은 그대로(복귀 대비), 목은 새 칸만이라 띄우지 않는다.
  assert.deepEqual(plain(planStudentReassign(student([cls(2, "17:00", "17:55", "PAUSED"), cls(4, "17:00", "17:55")]), stops)), { pairs: [], removeOnly: [] });
});

test("다른 학생 행은 섞이지 않는다 — 학생 id 없는 옛 행은 이름+학부모 전화로 같은 학생", () => {
  const stops = [
    r({ id: "b1", studentId: null }), // 같은 학생(이름+전화)
    r({ id: "x1", studentId: "x", studentName: "다른", parentPhone: "010-9999-0000" }),
  ];
  const plan = plain(planStudentReassign(student([cls(4, "17:00", "17:55")]), stops));
  assert.deepEqual(plan.pairs.map((p: any) => p.from.rowIds), [["b1"]]);
});

test("한 요일 두 반: 등원은 이른 반, 하원은 늦은 반 칸으로 새 칸을 잡는다", () => {
  const stops = [r({ id: "b1" }), r({ id: "a1", direction: "ALIGHT" })];
  const plan = plain(planStudentReassign(student([cls(4, "16:00", "16:55"), cls(4, "17:00", "17:55")]), stops));
  // 하원 칸 글자는 명단에 이미 있는 같은 시작 시각 글자(17:00~18:00)에 맞춘다.
  const byDir = Object.fromEntries(plan.pairs.map((p: any) => [p.direction, p.to.classTime]));
  assert.deepEqual(byDir, { BOARD: "16:00~16:55", ALIGHT: "17:00~18:00" });
});

test("reassignLabel 문구", () => {
  assert.equal(reassignLabel({ weekday: 1, classTime: "17:00~18:00", direction: "ALIGHT" }, { weekday: 3, classTime: "17:00~18:00" }), "월→수 하원 (반 이동)");
});

test("리뷰 S-3: 시트 이관 칸 글자가 수업 시작과 몇 분 어긋나도(시간대 겹침) 반 이동이 아니다", () => {
  // 명단 칸 '16:00~17:00' · 실제 수업 16:05~16:55 → 같은 반(예전엔 «화 16:00→16:05 반 이동»으로 오탐)
  const stops = [r({ id: "b1", classTime: "16:00~17:00" }), r({ id: "a1", classTime: "16:00~17:00", direction: "ALIGHT" })];
  assert.deepEqual(plain(planStudentReassign(student([cls(2, "16:05", "16:55")]), stops)), { pairs: [], removeOnly: [] });
  // 공백 섞인 칸 글자도 같다
  assert.deepEqual(plain(planStudentReassign(student([cls(2, "15:50", "16:50")]), [r({ id: "b2", classTime: "16:00 ~ 17:00" })])).pairs, []);
});

test("리뷰 S-3: 끝과 시작이 맞닿기만 한 반(17~18시 → 18~19시)은 겹침이 아니라 반 이동", () => {
  const plan = plain(planStudentReassign(student([cls(2, "18:00", "19:00")]), [r({ id: "b1", classTime: "17:00~18:00" })]));
  assert.equal(plan.pairs.length, 1);
  assert.equal(plan.pairs[0].label, "화 17:00→18:00 등원 (반 이동)");
});
