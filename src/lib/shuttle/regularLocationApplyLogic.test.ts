import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { kindToDirection, planLocationApply } from "./regularLocationApplyLogic.ts";

// 학생 위치 수정 → 명단 반영(D3) — 이름 맞는 300m 안 정류장 합류 / 없으면 새 위치 / 가장 가까움만으로는 합류 안 함.

let seq = 0;
function r(over: Record<string, unknown> = {}): any {
  seq += 1;
  return {
    id: `r${seq}`, serviceMonth: "2026-11", weekday: 1, weekdayLabel: "월", classTime: "17:00~18:00", arriveTime: "16:40",
    stopName: "옛 정류장", direction: "BOARD", studentName: "허재원", studentId: "s1", studentPhone: null, parentPhone: "010-1234-5678",
    note: null, sortOrder: seq, latitude: 37.6, longitude: 127.15, ...over,
  };
}
const me = { id: "s1", name: "허재원", parentPhone: "010-1234-5678" };
const other = (over: Record<string, unknown>) => r({ studentId: "x", studentName: "다른", parentPhone: "010-9999-0000", ...over });
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("PICKUP → 등원 행만, DROPOFF → 하원 행만 (행 id 유지)", () => {
  assert.equal(kindToDirection("PICKUP"), "BOARD");
  assert.equal(kindToDirection("DROPOFF"), "ALIGHT");
  const stops = [r({ id: "b1" }), r({ id: "b2", weekday: 3 }), r({ id: "a1", direction: "ALIGHT" })];
  const p = plain(planLocationApply(stops, me, "PICKUP", { name: "우리집 앞", latitude: 37.61, longitude: 127.16 }));
  assert.deepEqual(p.rowIds, ["b1", "b2"]);
  assert.deepEqual([p.by, p.stopName, p.latitude], ["NEW", "우리집 앞", 37.61]);
  const d = plain(planLocationApply(stops, me, "DROPOFF", { name: "우리집 앞", latitude: 37.61, longitude: 127.16 }));
  assert.deepEqual(d.rowIds, ["a1"]);
});

test("같은 단지·같은 출입구 이름이 300m 안에 있으면 그 정류장 이름·좌표로 합류(정문보다 가까워도 후문)", () => {
  const stops = [
    r({ id: "b1" }),
    other({ stopName: "다산이편한세상자이 정문", latitude: 37.6105, longitude: 127.1600 }), // 더 가깝다
    other({ stopName: "다산이편한세상자이 후문", latitude: 37.6120, longitude: 127.1600 }),
  ];
  const p = plain(planLocationApply(stops, me, "PICKUP", { name: "다산e편한세상자이아파트 후문", latitude: 37.6100, longitude: 127.1600 }));
  assert.deepEqual([p.by, p.stopName, p.latitude], ["NAME", "다산이편한세상자이 후문", 37.612]);
  assert.match(p.reason, /기존 정류장/);
});

test("표기만 다른 같은 이름(공백·아파트)도 합류 · 300m 밖이면 새 위치", () => {
  const near = [r({ id: "b1" }), other({ stopName: "푸르지오 아파트", latitude: 37.6110, longitude: 127.16 })];
  assert.equal(plain(planLocationApply(near, me, "PICKUP", { name: "푸르지오", latitude: 37.6100, longitude: 127.16 })).stopName, "푸르지오 아파트");
  const far = [r({ id: "b1" }), other({ stopName: "푸르지오", latitude: 37.6200, longitude: 127.16 })]; // 약 1.1km
  assert.equal(plain(planLocationApply(far, me, "PICKUP", { name: "푸르지오", latitude: 37.6100, longitude: 127.16 })).by, "NEW");
});

test("이름이 안 맞으면 가장 가까운 정류장이어도 합류하지 않는다(길 건너 다른 단지 방지)", () => {
  const stops = [r({ id: "b1" }), other({ stopName: "롯데캐슬 정문", latitude: 37.6101, longitude: 127.16 })];
  const p = plain(planLocationApply(stops, me, "PICKUP", { name: "우리집 앞", latitude: 37.6100, longitude: 127.16 }));
  assert.deepEqual([p.by, p.stopName], ["NEW", "우리집 앞"]);
});

test("이미 같은 이름·좌표인 행은 바꿀 행에서 빠지고, 이 학생 행이 없으면 null", () => {
  const stops = [r({ id: "b1", stopName: "우리집 앞", latitude: 37.61, longitude: 127.16 }), r({ id: "b2", weekday: 3 })];
  const p = plain(planLocationApply(stops, me, "PICKUP", { name: "우리집 앞", latitude: 37.61, longitude: 127.16 }));
  assert.deepEqual([p.rowIds, p.allRowIds], [["b2"], ["b1", "b2"]]);
  assert.equal(planLocationApply([other({})], me, "PICKUP", { name: "x", latitude: 37.61, longitude: 127.16 }), null);
});
