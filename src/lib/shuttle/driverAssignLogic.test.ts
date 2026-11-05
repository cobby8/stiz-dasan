import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { ALREADY_ASSIGNED, assertLegStillOpen, buildAssignAddInput, buildAssignBoard, DriverAssignError, openLegsFor, parseAssignRequest, planLeg, routeVersionOf, summarizeClasses } from "./driverAssignLogic.ts";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { findRouteCell, suggestPlacement } from "./regularRosterPlacementLogic.ts";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { validateAddInput } from "./regularRosterEditLogic.ts";

// 기사님 「새 학생 배정」 순수 로직 — 남은 칸 · 휴원 제외 · 이미 있는 칸 제외 · 추천 전달 · 저장 입력 재검사.

let seq = 0;
function r(over: Record<string, unknown> = {}): any {
  seq += 1;
  return {
    id: `r${String(seq).padStart(3, "0")}`, serviceMonth: "2026-11", weekday: 1, weekdayLabel: "월", classTime: "17:00~18:00", arriveTime: "16:40",
    stopName: "A", direction: "BOARD", studentName: `학생${seq}`, studentId: `s${seq}`, studentPhone: "010-1111-2222", parentPhone: `010-9999-${String(1000 + seq)}`,
    note: null, sortOrder: seq, latitude: null, longitude: null, ...over,
  };
}

const ACADEMY = { lat: 37.6, lng: 127.1 };
const DEPOT = { lat: 37.64, lng: 127.1 };

/** 월요일 17시 등원 노선: A(37.630) → B(37.620) → C(37.610) → 학원. 하원도 같은 정류장. */
function roster(): any[] {
  return [
    r({ stopName: "A", latitude: 37.63, longitude: 127.1, arriveTime: "16:30" }),
    r({ stopName: "B", latitude: 37.62, longitude: 127.1, arriveTime: "16:40" }),
    r({ stopName: "C", latitude: 37.61, longitude: 127.1, arriveTime: "16:50" }),
    r({ stopName: "C", direction: "ALIGHT", latitude: 37.61, longitude: 127.1, arriveTime: "18:10" }),
  ];
}

function student(over: Record<string, unknown> = {}): any {
  return {
    studentId: "new1", name: "신입", grade: "초3", wishTime: "16:40", parentPhone: "010-5555-7777",
    enrolled: [
      { weekday: 1, startTime: "17:00", endTime: "17:55", className: "월반", programName: "정규", status: "ACTIVE" },
      { weekday: 3, startTime: "17:00", endTime: "17:55", className: "수반", programName: "정규", status: "ACTIVE" },
    ],
    pickup: { name: "B 근처", address: "다산동 1", latitude: 37.6205, longitude: 127.1 }, // B 에서 약 55m
    dropoff: { name: "B 근처", address: "다산동 1", latitude: 37.6205, longitude: 127.1 },
    ...over,
  };
}

test("남은 칸: 다니는 요일 × 등원/하원, 명단 칸 글자는 그 요일 명단(17:00~18:00)에 맞춘다", () => {
  const legs = openLegsFor(student(), roster());
  assert.deepEqual(legs.map((l: any) => l.label), ["월 등원", "월 하원", "수 등원", "수 하원"]);
  assert.equal(legs[0].classTime, "17:00~18:00");
  assert.equal(legs[0].startTime, "17:00");
});

test("이미 있는 칸은 빠진다 — 학생 id 행, 그리고 id 없는 이름+학부모 전화 행도 같은 학생으로 본다", () => {
  const stops = [...roster(), r({ studentId: "new1", studentName: "신입", stopName: "B" })];
  assert.deepEqual(openLegsFor(student(), stops).map((l: any) => l.label), ["월 하원", "수 등원", "수 하원"]);
  const byName = [...roster(), r({ studentId: null, studentName: "신입", parentPhone: "010-5555-7777", weekday: 3, direction: "ALIGHT" })];
  assert.deepEqual(openLegsFor(student(), byName).map((l: any) => l.label), ["월 등원", "월 하원", "수 등원"]);
});

test("휴원(PAUSED)만 있는 학생·모든 칸이 찬 학생은 목록에서 빠진다", () => {
  const paused = student({ studentId: "p1", name: "휴원생", enrolled: [{ weekday: 1, startTime: "17:00", endTime: "17:55", className: null, programName: null, status: "PAUSED" }] });
  const full = student({ studentId: "f1", name: "다참", enrolled: [{ weekday: 1, startTime: "17:00", endTime: "17:55", className: null, programName: null, status: "ACTIVE" }] });
  const stops = [...roster(), r({ studentId: "f1", studentName: "다참" }), r({ studentId: "f1", studentName: "다참", direction: "ALIGHT" })];
  const board = buildAssignBoard({ students: [paused, full, student()], stops, academy: ACADEMY, depot: DEPOT });
  assert.deepEqual(board.map((s: any) => s.studentId), ["new1"]);
  // 휴원 수업은 칸을 만들지 않는다(다니는 요일만)
  const mixed = student({ enrolled: [...student().enrolled, { weekday: 5, startTime: "17:00", endTime: "17:55", className: null, programName: null, status: "PAUSED" }] });
  assert.equal(openLegsFor(mixed, roster()).some((l: any) => l.weekday === 5), false);
  assert.equal(summarizeClasses(mixed.enrolled), "월·수 17:00~17:55");
});

test("추천 전달: 300m 안 정류장이면 합류 추천이 기본값, 순서는 기사님 화면 함수 그대로, 다른 학생은 이름만", () => {
  const stops = roster();
  const s = student();
  const leg = openLegsFor(s, stops)[0];
  const plan = planLeg(s, leg, stops, ACADEMY, DEPOT);
  const expected = suggestPlacement({ stops: findRouteCell(stops, 1, "17:00~18:00", "BOARD"), direction: "BOARD", stopName: "B 근처", student: { lat: 37.6205, lng: 127.1 }, academy: ACADEMY, depot: DEPOT });
  assert.deepEqual(plan.defaultChoice, expected.choice);
  assert.deepEqual(plan.defaultChoice, { kind: "JOIN", stopIndex: 1 });
  assert.equal(plan.joinOptions[0].label, "B");
  assert.equal(plan.joinOptions[0].recommended, true);
  assert.ok(plan.joinOptions[0].distanceMeters! < 100);
  assert.deepEqual(plan.route.map((x: any) => x.label), ["A", "B", "C"]);
  assert.equal(plan.reason, expected.reason);
  // 개인정보 최소화: 다른 학생 전화가 화면 자료에 없다
  const json = JSON.stringify(buildAssignBoard({ students: [s], stops, academy: ACADEMY, depot: DEPOT }));
  assert.doesNotMatch(json, /010-/);
  assert.doesNotMatch(json, /parentPhone|studentPhone|rowId/);
});

test("추천 전달: 멀면 새 정류장 끼울 자리 추천(관리자 학생 추가와 같은 자리), 위치가 아예 없으면 막힘 안내", () => {
  const far = student({ pickup: { name: "먼 곳", address: "별내동", latitude: 37.615, longitude: 127.12 }, dropoff: null });
  const stops = roster();
  const plan = planLeg(far, openLegsFor(far, stops)[0], stops, ACADEMY, DEPOT);
  const expected = suggestPlacement({ stops: findRouteCell(stops, 1, "17:00~18:00", "BOARD"), direction: "BOARD", stopName: "먼 곳", student: { lat: 37.615, lng: 127.12 }, academy: ACADEMY, depot: DEPOT });
  assert.equal(expected.choice.kind, "INSERT");
  assert.deepEqual(plan.defaultChoice, expected.choice);
  assert.equal(plan.defaultPosition, (expected.choice as any).position);
  assert.deepEqual(plan.newStop, { name: "먼 곳", address: "별내동" });

  // 정차 없는 칸 + 학생 위치 없음 → 넣을 수 없음
  const none = student({ pickup: null, dropoff: null, enrolled: [{ weekday: 2, startTime: "15:00", endTime: "15:55", className: null, programName: null, status: "ACTIVE" }] });
  const p2 = planLeg(none, openLegsFor(none, stops)[0], stops, ACADEMY, DEPOT);
  assert.equal(p2.defaultChoice, null);
  assert.match(p2.blocked!, /위치/);
});

test("같은 이름 정류장이 이미 있으면 「새 정류장」을 내지 않는다(기사님 화면에서 그 정류장에 합쳐지므로)", () => {
  const s = student({ pickup: { name: "C", address: "다산동 3", latitude: 37.5, longitude: 127.3 } });
  const plan = planLeg(s, openLegsFor(s, roster())[0], roster(), ACADEMY, DEPOT);
  assert.equal(plan.newStop, null);
  assert.deepEqual(plan.defaultChoice, { kind: "JOIN", stopIndex: 2 });
});

test("저장 재검사: 합류 → JOIN 기준 행·이후 달 범위, 새 정류장 → 학생 위치 좌표·BEFORE 자리, 결과는 명단 입력 검증을 통과", () => {
  const stops = roster();
  const s = student();
  const plan = planLeg(s, openLegsFor(s, stops)[0], stops, ACADEMY, DEPOT);
  const base: any = { month: "2026-11", studentId: "new1", weekday: 1, direction: "BOARD", routeVersion: plan.routeVersion, includeNextMonth: true };

  const join = buildAssignAddInput({ ...base, choice: { kind: "JOIN", stopIndex: 1 } }, s, stops, ACADEMY, DEPOT);
  assert.equal(join.scope, "FROM_THIS_MONTH");
  assert.deepEqual(join.placements, [{ weekday: 1, classTime: "17:00~18:00", direction: "BOARD", mode: "JOIN", rowId: stops[1].id }]);
  assert.equal((join.board as any).stopName, "B");
  assert.equal(join.alight, null);
  assert.equal(validateAddInput(join).placements?.[0]?.mode, "JOIN");

  const ins = buildAssignAddInput({ ...base, includeNextMonth: false, choice: { kind: "INSERT", position: 1 } }, s, stops, ACADEMY, DEPOT);
  assert.equal(ins.scope, "THIS_MONTH");
  const p = (ins.placements as any[])[0];
  assert.equal(p.mode, "BEFORE");
  assert.equal(p.rowId, stops[1].id); // 1번 정차(A) 다음 = B 의 첫 행 앞
  assert.equal((ins.board as any).latitude, 37.6205);
  assert.equal((ins.board as any).stopName, "B 근처");
  assert.equal(validateAddInput(ins).board!.latitude, 37.6205);

  const end = buildAssignAddInput({ ...base, choice: { kind: "INSERT", position: 3 } }, s, stops, ACADEMY, DEPOT);
  assert.equal((end.placements as any[])[0].mode, "END");
});

test("저장 재검사: 이미 있는 칸 409 · 수업 없는 요일 409 · 순서 바뀜 409 · 범위 밖 자리 409", () => {
  const stops = roster();
  const s = student();
  const plan = planLeg(s, openLegsFor(s, stops)[0], stops, ACADEMY, DEPOT);
  const base = { month: "2026-11", studentId: "new1", weekday: 1, direction: "BOARD", routeVersion: plan.routeVersion, includeNextMonth: true, choice: { kind: "JOIN", stopIndex: 0 } };
  const code = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof DriverAssignError); return `${(e as any).status}:${(e as any).code}`; } return "ok"; };

  const filled = [...stops, r({ studentId: "new1", studentName: "신입" })];
  assert.equal(code(() => buildAssignAddInput(base as any, s, filled, ACADEMY, DEPOT)), "409:ALREADY_ASSIGNED");
  assert.equal(code(() => buildAssignAddInput({ ...base, weekday: 2 } as any, s, stops, ACADEMY, DEPOT)), "409:NOT_CLASS_DAY");
  assert.equal(code(() => buildAssignAddInput({ ...base, routeVersion: "x" } as any, s, stops, ACADEMY, DEPOT)), "409:ROUTE_CHANGED");
  assert.equal(code(() => buildAssignAddInput({ ...base, choice: { kind: "JOIN", stopIndex: 9 } } as any, s, stops, ACADEMY, DEPOT)), "409:ROUTE_CHANGED");
  // 휴원 요일은 칸이 아니다
  const paused = student({ enrolled: [{ weekday: 1, startTime: "17:00", endTime: "17:55", className: null, programName: null, status: "PAUSED" }] });
  assert.equal(code(() => buildAssignAddInput(base as any, paused, stops, ACADEMY, DEPOT)), "409:NOT_CLASS_DAY");
  // 행이 하나 늘면 지문이 바뀐다
  const grown = [...stops, r({ stopName: "D" })];
  assert.notEqual(routeVersionOf(findRouteCell(grown, 1, "17:00~18:00", "BOARD")), plan.routeVersion);
});

test("잠금 안 마지막 확인: 그사이 같은 칸이 들어갔으면 409", () => {
  assert.doesNotThrow(() => assertLegStillOpen(roster(), student(), 1, "BOARD"));
  assert.throws(() => assertLegStillOpen([...roster(), r({ studentId: "new1", studentName: "신입" })], student(), 1, "BOARD"),
    (e: any) => e instanceof DriverAssignError && e.status === 409 && e.message === ALREADY_ASSIGNED);
});

test("요청 형식 검사: 잘못된 값은 400", () => {
  const ok = { month: "2026-11", studentId: "s1", weekday: 1, direction: "BOARD", choice: { kind: "JOIN", stopIndex: 0 }, routeVersion: "3-abc" };
  assert.equal(parseAssignRequest(ok).includeNextMonth, true);
  assert.equal(parseAssignRequest({ ...ok, includeNextMonth: false }).includeNextMonth, false);
  for (const bad of [null, [], { ...ok, month: "2026-13" }, { ...ok, studentId: "" }, { ...ok, weekday: 7 }, { ...ok, direction: "PIVOT" },
    { ...ok, choice: { kind: "JOIN", stopIndex: -1 } }, { ...ok, choice: { kind: "MOVE" } }, { ...ok, routeVersion: "" }]) {
    assert.throws(() => parseAssignRequest(bad), (e: any) => e instanceof DriverAssignError && e.status === 400);
  }
});
