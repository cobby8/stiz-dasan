import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { pickServiceMonthFor } from "./serviceMonth.ts";

test("빈 목록이면 undefined (호출부 기존 동작으로)", () => {
  assert.equal(pickServiceMonthFor([], "2026-10-15"), undefined);
});

test("미래 달만 있으면 undefined", () => {
  assert.equal(pickServiceMonthFor(["2026-11", "2026-12"], "2026-10-15"), undefined);
});

test("기준일과 정확히 같은 달을 고른다", () => {
  assert.equal(pickServiceMonthFor(["2026-10"], "2026-10-01"), "2026-10");
  assert.equal(pickServiceMonthFor(["2026-10"], "2026-10-31"), "2026-10");
});

test("여러 달 중 기준 달 이하의 최신 달 (다음 달 명단이 먼저 생겨도 이번 달 유지)", () => {
  // getRegularShuttleMonths 는 최신순(DESC)이지만 순서와 무관하게 동작해야 한다.
  assert.equal(pickServiceMonthFor(["2026-11", "2026-10", "2026-09"], "2026-10-02"), "2026-10");
  assert.equal(pickServiceMonthFor(["2026-08", "2026-11", "2026-06"], "2026-10-02"), "2026-08");
});

test("연말 경계 — 12월 기준이면 다음 해 1월 명단은 제외", () => {
  assert.equal(pickServiceMonthFor(["2027-01", "2026-12"], "2026-12-31"), "2026-12");
  assert.equal(pickServiceMonthFor(["2027-01", "2026-12"], "2027-01-01"), "2027-01");
});

test("YYYY-MM 기준값과 이상한 입력도 처리", () => {
  assert.equal(pickServiceMonthFor(["2026-10", "2026-09"], "2026-09"), "2026-09");
  assert.equal(pickServiceMonthFor(["2026-10"], ""), undefined);
  assert.equal(pickServiceMonthFor(["bad", "2026-09"], "2026-10-01"), "2026-09");
});
