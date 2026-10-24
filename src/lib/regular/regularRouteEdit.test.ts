import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { bestInsertIndex, moveStopToVehicle, moveStudentToVehicle, overCapacityVehicles, removeStudentFromRoute, runTimeChange } from "./regularRouteEdit.ts";

// 테스트용 최소 데이터 — 학생은 이름 문자열로 둔다(모듈은 학생 모양을 보지 않는다).
type St = string;
type Stop = { lat: number; lng: number; label: string; students: St[]; approx: boolean; isHub?: boolean; etaManual?: number | null };
type Run = { vehicleName: string; tripLabel: string | null; stops: Stop[]; passengers: number; capacity: number; over: boolean; path?: { lat: number; lng: number }[] };

const ends = { start: { lat: 37.60, lng: 127.10 }, end: { lat: 37.60, lng: 127.20 } }; // 서→동 일직선
const stop = (lng: number, students: St[], extra: Partial<Stop> = {}): Stop => ({ lat: 37.60, lng, label: `정차${lng}`, students, approx: false, ...extra });
const run = (name: string, stops: Stop[], capacity = 10): Run => ({
  vehicleName: name, tripLabel: null, stops, capacity,
  passengers: stops.reduce((a, s) => a + s.students.length, 0), over: false, path: [{ lat: 0, lng: 0 }],
});

test("bestInsertIndex: 일직선 위 중간 지점은 두 정차 사이에 들어간다", () => {
  assert.equal(bestInsertIndex([stop(127.12, []), stop(127.18, [])], ends, { lat: 37.60, lng: 127.15 }), 1);
  assert.equal(bestInsertIndex([], ends, { lat: 37.60, lng: 127.15 }), 0);
});

test("정차 이동: 다른 차량의 같은 장소(≤30m)면 합치고, 두 차량 인원·정원·경로를 갱신한다", () => {
  const vs = [run("1호차", [stop(127.12, ["가", "나"]), stop(127.18, ["다"])]), run("2호차", [stop(127.12001, ["라"])])];
  const r = moveStopToVehicle(vs, { v: 0, s: 0 }, 1, ends);
  assert.deepEqual(r.touched, [0, 1]);
  assert.equal(r.vehicles[1].stops.length, 1);
  assert.deepEqual(r.vehicles[1].stops[0].students, ["라", "가", "나"]);
  assert.equal(r.vehicles[0].passengers, 1);
  assert.equal(r.vehicles[1].passengers, 3);
  assert.equal(r.vehicles[0].path, undefined);
  assert.equal(r.vehicles[1].path, undefined);
  // 원본은 그대로
  assert.equal(vs[0].stops.length, 2);
  assert.deepEqual(vs[1].stops[0].students, ["라"]);
});

test("정차 이동: 같은 장소가 없으면 최적 위치에 삽입하고 손으로 고친 시각은 풀린다", () => {
  const vs = [run("1호차", [stop(127.15, ["가"], { etaManual: 900 })]), run("2호차", [stop(127.12, ["나"]), stop(127.18, ["다"])])];
  const r = moveStopToVehicle(vs, { v: 0, s: 0 }, 1, ends);
  assert.deepEqual(r.vehicles[1].stops.map((s: Stop) => s.students[0]), ["나", "가", "다"]);
  assert.equal(r.vehicles[1].stops[1].etaManual, null);
  assert.equal(r.vehicles[0].stops.length, 0);
});

test("정차 이동: 정원 초과면 over=true, 같은 차량·잘못된 인덱스는 아무것도 안 바꾼다", () => {
  const vs = [run("1호차", [stop(127.15, ["가", "나"])]), run("2호차", [stop(127.12, ["다"])], 2)];
  const r = moveStopToVehicle(vs, { v: 0, s: 0 }, 1, ends);
  assert.equal(r.vehicles[1].over, true);
  assert.deepEqual(overCapacityVehicles(r.vehicles), [{ name: "2호차", passengers: 3, capacity: 2 }]);
  assert.deepEqual(moveStopToVehicle(vs, { v: 0, s: 0 }, 0, ends).touched, []);
  assert.deepEqual(moveStopToVehicle(vs, { v: 0, s: 5 }, 1, ends).touched, []);
});

test("무료탑승 거점은 같은 좌표의 일반 정차와 합치지 않는다", () => {
  const vs = [run("1호차", [stop(127.15, ["가"], { isHub: true })]), run("2호차", [stop(127.15, ["나"])])];
  const r = moveStopToVehicle(vs, { v: 0, s: 0 }, 1, ends);
  assert.equal(r.vehicles[1].stops.length, 2);
  assert.equal(r.vehicles[1].stops.filter((s: Stop) => s.isHub).length, 1);
});

test("학생 이동: 한 명만 옮기고, 원래 정차에 남은 학생은 그대로 둔다", () => {
  const vs = [run("1호차", [stop(127.15, ["가", "나"])]), run("2호차", [stop(127.12, ["다"])])];
  const r = moveStudentToVehicle(vs, { v: 0, s: 0, i: 1 }, 1, ends);
  assert.deepEqual(r.vehicles[0].stops[0].students, ["가"]);
  assert.deepEqual(r.vehicles[1].stops.map((s: Stop) => s.students), [["다"], ["나"]]);
  assert.equal(r.vehicles[1].stops[1].label, "정차127.15"); // 장소를 그대로 들고 간다
});

test("학생 이동: 원래 정차가 비면 지우고, 대상 차량 같은 장소에 합친다", () => {
  const vs = [run("1호차", [stop(127.15, ["가"]), stop(127.18, ["나"])]), run("2호차", [stop(127.15, ["다"])])];
  const r = moveStudentToVehicle(vs, { v: 0, s: 0, i: 0 }, 1, ends);
  assert.equal(r.vehicles[0].stops.length, 1);
  assert.deepEqual(r.vehicles[1].stops[0].students, ["다", "가"]);
  assert.equal(r.vehicles[0].passengers, 1);
});

test("학생 빼기: 빈 정차는 지우되 무료탑승 거점은 비어도 남긴다", () => {
  const vs = [run("1호차", [stop(127.12, ["가"]), stop(127.15, ["나"], { isHub: true }), stop(127.18, ["다", "라"])])];
  let r = removeStudentFromRoute(vs, { v: 0, s: 0, i: 0 });
  assert.equal(r.vehicles[0].stops.length, 2);
  assert.equal(r.vehicles[0].passengers, 3);
  r = removeStudentFromRoute(r.vehicles, { v: 0, s: 0, i: 0 });
  assert.equal(r.vehicles[0].stops.length, 2);
  assert.equal(r.vehicles[0].stops[0].isHub, true);
  assert.deepEqual(r.vehicles[0].stops[0].students, []);
  assert.deepEqual(removeStudentFromRoute(vs, { v: 0, s: 2, i: 9 }).touched, []);
});

test("회차 수업시간 비교: 등원은 시작, 하원은 종료 시각이 다를 때만 알린다", () => {
  const a = { classStart: "16:00", classEnd: "17:20" }, b = { classStart: "17:30", classEnd: "17:20" };
  assert.deepEqual(runTimeChange(a, b, true), { from: "16:00", to: "17:30" });
  assert.equal(runTimeChange(a, b, false), null); // 하원 종료 시각은 같다
  assert.equal(runTimeChange(a, { classStart: null }, true), null); // 판단 불가면 묻지 않는다
  assert.equal(runTimeChange(undefined, b, true), null);
});
