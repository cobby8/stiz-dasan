// 학부모 홈 «오늘 할 일» 판 집계(2026-11-09 원장 결정 D1 안 A) — 순수 함수 실행 테스트.
import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizePendingPayments, countRecentNotices } from "../src/lib/mypage/summary.ts";

test("납부할 청구 합계: 미납·연체만, 형제 합산, 같은 청구는 한 번만, 0원은 뺀다", () => {
  const s = summarizePendingPayments([
    { payments: [
      { id: "p1", amount: 180000, status: "PENDING" },
      { id: "p2", amount: 50000, status: "OVERDUE" },
      { id: "p3", amount: 99000, status: "PAID" },
      { id: "p0", amount: 0, status: "PENDING" },
    ] },
    { payments: [
      { id: "p4", amount: 160000, status: "PENDING", canCheckout: false },
      { id: "p1", amount: 180000, status: "PENDING" },
      { id: "p5", amount: 10000, status: "CANCELED" },
    ] },
  ]);
  assert.deepEqual(s, { count: 3, total: 390000, canCheckoutAny: true });
});

test("납부할 청구가 없거나 전부 추가 가족(대표 보호자 아님) 청구일 때", () => {
  assert.deepEqual(summarizePendingPayments([{ payments: [] }]), { count: 0, total: 0, canCheckoutAny: false });
  assert.deepEqual(
    summarizePendingPayments([{ payments: [{ id: "x", amount: 1000, status: "PENDING", canCheckout: false }] }]),
    { count: 1, total: 1000, canCheckoutAny: false },
  );
});

test("새 공지 수: 최근 7일 경계 포함", () => {
  const now = Date.parse("2026-11-09T03:00:00Z");
  assert.equal(countRecentNotices([
    { createdAt: "2026-11-02T03:00:00Z" }, // 정확히 7일 전 = 포함
    { createdAt: "2026-11-02T02:59:59Z" }, // 7일 넘음
    { createdAt: new Date("2026-11-09T00:00:00Z") },
  ], now), 2);
});
