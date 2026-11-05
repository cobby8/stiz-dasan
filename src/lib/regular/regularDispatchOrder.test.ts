import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { runAnchorMinutes, runTimelineOrder } from "./regularDispatchOrder.ts";

// 정규 배차 회차 카드 시간순 정렬 — 실제로 돌려서 순서를 확인한다.
test("등원·하원 회차가 하루 시간순으로 섞이고, 같은 시각이면 하원(종료)이 먼저다", () => {
  const cards = [
    { name: "등원 15:00 수업", run: { classStart: "15:00", tripLabel: "15:00 수업" }, isPickup: true, vIdx: 0 },
    { name: "등원 18:00 수업", run: { classStart: "18:00", tripLabel: "18:00 수업" }, isPickup: true, vIdx: 1 },
    { name: "등원 19:20 수업", run: { classStart: "19:20", tripLabel: "19:20 수업" }, isPickup: true, vIdx: 2 },
    { name: "하원 16:00 종료", run: { classEnd: "16:00", tripLabel: "16:00 종료" }, isPickup: false, vIdx: 0 },
    { name: "하원 19:20 종료", run: { classEnd: "19:20", tripLabel: "19:20 종료" }, isPickup: false, vIdx: 1 },
    { name: "하원 20:40 종료", run: { classEnd: "20:40", tripLabel: "20:40 종료" }, isPickup: false, vIdx: 2 },
  ];
  const sorted = [...cards].sort((a, b) => runTimelineOrder(a.run, a.isPickup, a.vIdx) - runTimelineOrder(b.run, b.isPickup, b.vIdx));
  assert.deepEqual(sorted.map((c) => c.name), [
    "등원 15:00 수업", "하원 16:00 종료", "등원 18:00 수업", "하원 19:20 종료", "등원 19:20 수업", "하원 20:40 종료",
  ]);
});

test("같은 시각·같은 방향이면 원래 차량 순서를 지킨다", () => {
  const a = runTimelineOrder({ classStart: "15:00" }, true, 0);
  const b = runTimelineOrder({ classStart: "15:00" }, true, 1);
  assert.ok(a < b);
});

test("기준 시각은 수업시각 → 회차 이름 → 출발 시각 순으로 찾고, 모르면 맨 뒤", () => {
  assert.equal(runAnchorMinutes({ classStart: "09:05", tripLabel: "10:00 수업" }, true), 9 * 60 + 5);
  assert.equal(runAnchorMinutes({ classStart: null, tripLabel: "수업 19:20 종료" }, false), 19 * 60 + 20);
  assert.equal(runAnchorMinutes({ departTime: "14:30" }, true), 14 * 60 + 30);
  // 등원 카드는 classEnd 를, 하원 카드는 classStart 를 기준으로 쓰지 않는다
  assert.equal(runAnchorMinutes({ classEnd: "16:00", tripLabel: "15:00 수업" }, true), 15 * 60);
  const unknown = runTimelineOrder({}, true, 0);
  assert.ok(unknown > runTimelineOrder({ classEnd: "23:59" }, false, 99));
  // 잘못된 시각 문자열은 무시
  assert.equal(runAnchorMinutes({ classStart: "25:00", tripLabel: "18:00 수업" }, true), 18 * 60);
});
