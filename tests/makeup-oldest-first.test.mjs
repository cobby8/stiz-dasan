import test from "node:test";
import assert from "node:assert/strict";
import { makeupCreditTryOrder } from "../src/lib/makeup/credit-rules.ts";

// 2026-11-20 원장 지시: 보강 예약은 오래된 결석의 보강권부터 쓴다.
const D = (s) => new Date(`${s}T00:00:00Z`);
const c = (id, absence, expires, extra = {}) => ({ id, absenceDate: D(absence), expiresAt: D(expires), status: "AVAILABLE", sourceType: "REGULAR", ...extra });

test("최근 보강권을 골라도 더 오래된 보강권을 먼저 시도한다", () => {
  const picked = c("thu", "2026-11-18", "2027-01-18");
  const order = makeupCreditTryOrder(picked, [c("tue", "2026-11-16", "2027-01-16")], D("2026-11-19"));
  assert.deepEqual(order, ["tue", "thu"]);
});

test("여러 장이면 결석일이 이른 순, 고른 것은 마지막", () => {
  const picked = c("p", "2026-11-18", "2027-01-18");
  const order = makeupCreditTryOrder(picked, [c("b", "2026-10-01", "2026-12-01"), c("a", "2026-09-25", "2026-11-25"), c("newer", "2026-11-19", "2027-01-19")], D("2026-11-20"));
  assert.deepEqual(order, ["a", "b", "p"], "고른 것보다 최근 결석은 후보가 아니다");
});

test("보강 날짜에 기한이 지나는 보강권·다른 종류·사용 불가 보강권은 건너뛴다", () => {
  const picked = c("p", "2026-11-18", "2027-01-18");
  const order = makeupCreditTryOrder(picked, [
    c("expiring", "2026-09-21", "2026-11-21"),
    c("seasonal", "2026-10-01", "2026-12-01", { sourceType: "SEASONAL" }),
    c("reserved", "2026-10-02", "2026-12-02", { status: "RESERVED" }),
  ], D("2026-11-25"));
  assert.deepEqual(order, ["p"]);
});

test("후보가 없으면 고른 보강권 그대로", () => {
  assert.deepEqual(makeupCreditTryOrder(c("p", "2026-11-18", "2027-01-18"), [], D("2026-11-20")), ["p"]);
});
