import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { runAnchorMinutes, runTimelineOrder } from "./regularDispatchOrder.ts";

// 정규 배차 회차 카드 시간순 정렬 — 실제로 돌려서 순서를 확인한다.
type Card = { name: string; run: Record<string, string | null>; isPickup: boolean; vIdx: number };
const sortNames = (cards: Card[]) => [...cards]
  .sort((a, b) => runTimelineOrder(a.run, a.isPickup, a.vIdx) - runTimelineOrder(b.run, b.isPickup, b.vIdx))
  .map((c) => c.name);

test("실례(원장 지적): 실제 출발 시각 순 — 16시 등원, 17시 등원, 16시 수업 하원", () => {
  const cards: Card[] = [
    { name: "하원16", run: { classStart: "16:00", classEnd: "17:00", tripLabel: "17:00 종료", departTime: "17:05" }, isPickup: false, vIdx: 0 },
    { name: "등원17", run: { classStart: "17:00", classEnd: "18:00", tripLabel: "17:00 수업", departTime: "16:35" }, isPickup: true, vIdx: 1 },
    { name: "등원16", run: { classStart: "16:00", classEnd: "17:00", tripLabel: "16:00 수업", departTime: "15:35" }, isPickup: true, vIdx: 0 },
  ];
  assert.deepEqual(sortNames(cards), ["등원16", "등원17", "하원16"]);
});

test("출발 시각을 손으로 고치면 순서도 따라간다", () => {
  const pickup17 = { classStart: "17:00", tripLabel: "17:00 수업", departTime: "16:35" };
  const dropoff16 = { classEnd: "17:00", tripLabel: "17:00 종료", departTime: "17:05" };
  const before = runTimelineOrder(pickup17, true, 0) < runTimelineOrder(dropoff16, false, 0);
  assert.equal(before, true);
  // 등원 출발을 17:10 으로 늦추면 하원(17:05) 뒤로 간다
  assert.ok(runTimelineOrder({ ...pickup17, departTime: "17:10" }, true, 0) > runTimelineOrder(dropoff16, false, 0));
});

test("출발 시각이 없으면 등원 = 수업 30분 전, 하원 = 수업 종료, 그다음 회차 이름 시각", () => {
  assert.equal(runAnchorMinutes({ classStart: "17:00" }, true), 16 * 60 + 30);
  assert.equal(runAnchorMinutes({ classStart: "00:10" }, true), 0); // 자정 앞으로는 넘기지 않는다
  assert.equal(runAnchorMinutes({ classStart: "16:00", classEnd: "17:00" }, false), 17 * 60);
  assert.equal(runAnchorMinutes({ tripLabel: "19:20 종료" }, false), 19 * 60 + 20);
  // 폴백만으로도 실례 순서가 맞는다: 등원16(15:30) → 등원17(16:30) → 하원16(17:00)
  assert.deepEqual(sortNames([
    { name: "하원16", run: { classEnd: "17:00" }, isPickup: false, vIdx: 0 },
    { name: "등원17", run: { classStart: "17:00" }, isPickup: true, vIdx: 1 },
    { name: "등원16", run: { classStart: "16:00" }, isPickup: true, vIdx: 0 },
  ]), ["등원16", "등원17", "하원16"]);
  // 잘못된 시각 문자열은 무시하고 다음 기준으로
  assert.equal(runAnchorMinutes({ departTime: "25:00", classStart: "18:00" }, true), 17 * 60 + 30);
  // 아무 시각도 없으면 맨 뒤
  assert.ok(runTimelineOrder({}, true, 0) > runTimelineOrder({ departTime: "23:59" }, false, 99));
});

test("수업시간 없는 회차(「수업시간 확인 필요」)는 출발 시각이 있어도 맨 뒤", () => {
  const missing = { classStart: null, classEnd: null, timeGroupLabel: "수업시간 확인 필요", tripLabel: "수업시간 확인 필요 · 1회차", departTime: "08:00" };
  assert.ok(runTimelineOrder(missing, true, 0) > runTimelineOrder({ departTime: "23:00", classEnd: "23:00" }, false, 99));
  // 회차 이름만 있어도 같은 판정
  assert.ok(runTimelineOrder({ tripLabel: "수업시간 확인 필요", departTime: "08:00" }, false, 0) > runTimelineOrder({ departTime: "22:00" }, true, 0));
});

test("같은 시각이면 등원 먼저, 같은 시각·같은 방향이면 원래 차량 순서", () => {
  assert.ok(runTimelineOrder({ departTime: "17:00" }, true, 5) < runTimelineOrder({ departTime: "17:00" }, false, 0));
  assert.ok(runTimelineOrder({ departTime: "15:00" }, true, 0) < runTimelineOrder({ departTime: "15:00" }, true, 1));
});
