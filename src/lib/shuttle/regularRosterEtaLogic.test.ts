import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { buildRosterEtas, dowToRosterWeekday, regularEtaKey } from "./regularRosterEtaLogic.ts";

// 학부모 «확정 승/하차 시각» = 셔틀 명단 arriveTime (6단계). 라벨 모양은 저장 노선 시절과 같다.
const M = "2026-11";
const row = (o: Partial<{ studentId: string | null; weekday: number; direction: string; arriveTime: string | null; sortOrder: number }>) =>
  ({ studentId: "s1", weekday: 1, direction: "BOARD", arriveTime: "14:38", sortOrder: 0, ...o });

test("등원 행 → «HH:MM 승차», 하원 행 → «HH:MM 하차» (요일·달까지 키에 넣는다)", () => {
  const out = buildRosterEtas([{ studentId: "s1", dayOfWeek: "Mon" }], [row({}), row({ direction: "ALIGHT", arriveTime: "17:05" })], M);
  assert.deepEqual(out.get(regularEtaKey("s1", "Mon", M)), { pickupEtaLabel: "14:38 승차", dropoffEtaLabel: "17:05 하차" });
  assert.equal(regularEtaKey("s1", "Mon", M), "s1::Mon::2026-11");
});

test("시각이 비었거나 형식이 아니면 null, 한 자리 시는 두 자리로 맞춘다", () => {
  const out = buildRosterEtas([{ studentId: "s1", dayOfWeek: "Mon" }], [row({ arriveTime: null }), row({ direction: "ALIGHT", arriveTime: "8:05" })], M);
  assert.deepEqual(out.get("s1::Mon::2026-11"), { pickupEtaLabel: null, dropoffEtaLabel: "08:05 하차" });
  const bad = buildRosterEtas([{ studentId: "s1", dayOfWeek: "Mon" }], [row({ arriveTime: "25:00" }), row({ direction: "ALIGHT", arriveTime: "미정" })], M);
  assert.deepEqual(bad.get("s1::Mon::2026-11"), { pickupEtaLabel: null, dropoffEtaLabel: null });
});

test("요청하지 않은 학생·요일 행, 운영 정차(PIVOT/RETURN)는 반영하지 않는다", () => {
  const out = buildRosterEtas([{ studentId: "s1", dayOfWeek: "Mon" }], [
    row({ weekday: 2, arriveTime: "09:00" }), row({ studentId: "s2", arriveTime: "09:10" }), row({ direction: "PIVOT", arriveTime: "09:20" }),
  ], M);
  assert.deepEqual([...out.keys()], ["s1::Mon::2026-11"]);
  assert.deepEqual(out.get("s1::Mon::2026-11"), { pickupEtaLabel: null, dropoffEtaLabel: null });
});

test("같은 학생·요일·방향이 여러 행이면 명단 순서(sortOrder) 첫 행, 입력 배열은 바꾸지 않는다", () => {
  const rows = [row({ sortOrder: 5, arriveTime: "15:40" }), row({ sortOrder: 1, arriveTime: "14:20" })];
  const out = buildRosterEtas([{ studentId: "s1", dayOfWeek: "Mon" }], rows, M);
  assert.equal(out.get("s1::Mon::2026-11")?.pickupEtaLabel, "14:20 승차");
  assert.equal(rows[0].sortOrder, 5);
});

test("모르는 요일·빈 학생 쌍은 결과에서 빠지고, 일요일(0)·토요일(6)도 맞게 짝짓는다", () => {
  assert.equal(dowToRosterWeekday("Sun"), 0);
  assert.equal(dowToRosterWeekday("Sat"), 6);
  assert.equal(dowToRosterWeekday("월"), -1);
  const out = buildRosterEtas([{ studentId: "", dayOfWeek: "Mon" }, { studentId: "s1", dayOfWeek: "월" }, { studentId: "s1", dayOfWeek: "Sat" }], [row({ weekday: 6, arriveTime: "10:00" })], M);
  assert.deepEqual([...out.keys()], ["s1::Sat::2026-11"]);
  assert.equal(out.get("s1::Sat::2026-11")?.pickupEtaLabel, "10:00 승차");
});
