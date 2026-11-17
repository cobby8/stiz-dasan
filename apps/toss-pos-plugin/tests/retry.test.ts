// 자동 시작 재시도(2026-11-17) — 바빠서 못 연 새 요청을 POS 가 비면 다시 연다 + 학생별 미납 묶음
import { test } from "node:test";
import assert from "node:assert/strict";
import { AUTO_RETRY_WINDOW_MS, createAutoRetryQueue, isNotReady } from "../src/core/retry.ts";
import { groupUnpaidByStudent, monthRangeText } from "../src/core/unpaid-groups.ts";
import type { ChargeRequest, UnpaidItem } from "../src/core/contract.ts";

const T0 = Date.parse("2026-11-17T10:26:46Z");
const req = (id: string, expiresInMs = 30 * 60_000) =>
  ({ id, status: "PENDING", expiresAt: new Date(T0 + expiresInMs).toISOString() }) as unknown as ChargeRequest;

test("재시도: 바쁨·다른 주문만 다시 시도할 대상", () => {
  assert.equal(isNotReady("busy"), true);
  assert.equal(isNotReady("draft_not_empty"), true);
  for (const r of ["started", "unconfirmed", "claim_failed", "dismissed", "invalid", "error"]) assert.equal(isNotReady(r), false);
});

test("재시도: 먼저 넣은 요청부터, 2분 지나면 그만둔다(다시 넣어도 기한은 안 늘어남)", () => {
  let now = T0;
  const q = createAutoRetryQueue(() => now);
  q.add(req("a"));
  q.add(req("b"));
  assert.equal(q.next()?.id, "a");
  now += 60_000;
  q.add(req("a")); // 같은 요청 다시 → 기한 그대로
  now = T0 + AUTO_RETRY_WINDOW_MS + 1;
  assert.equal(q.next(), null);
  assert.equal(q.size(), 0);
});

test("재시도: 대기 목록에서 사라진 요청(결제·취소·다른 POS)과 만료된 요청은 뺀다", () => {
  const now = T0;
  const q = createAutoRetryQueue(() => now);
  q.add(req("a"));
  q.add(req("b"));
  q.add(req("c", -1)); // 이미 만료
  q.sync(["b", "c"]);
  assert.equal(q.has("a"), false);
  assert.equal(q.next()?.id, "b");
  q.remove("b");
  assert.equal(q.next(), null);
});

test("재시도: 같은 요청·같은 사유는 서버에 한 번만 알린다", () => {
  const q = createAutoRetryQueue(() => T0);
  assert.equal(q.shouldReport("a", "busy"), false); // 대기열에 없으면 안 알림
  q.add(req("a"));
  assert.equal(q.shouldReport("a", "busy"), true);
  assert.equal(q.shouldReport("a", "busy"), false);
  assert.equal(q.shouldReport("a", "draft_not_empty"), true);
});

const unpaid = (paymentId: string, studentKey: string, title: string, amount: number, hasOpenRequest = false): UnpaidItem => ({
  paymentId, studentKey, studentName: studentKey === "s1" ? "최*호" : "김*수", className: "화8", title, amount, hasOpenRequest,
});

test("미납 묶음: 같은 학생은 한 묶음, 합계·달 범위 «10~12월» (2026-11-17 최윤호 6건 사례)", () => {
  const items = [
    unpaid("o1", "s1", "2026년 10월 수강료", 90_000), unpaid("o2", "s1", "2026년 10월 셔틀비", 105_000),
    unpaid("n1", "s1", "2026년 11월 수강료", 90_000), unpaid("n2", "s1", "2026년 11월 셔틀비", 105_000),
    unpaid("d1", "s1", "2026년 12월 수강료", 90_000), unpaid("d2", "s1", "2026년 12월 셔틀비", 105_000),
    unpaid("x1", "s2", "2026년 11월 수강료", 120_000),
  ];
  const [g1, g2] = groupUnpaidByStudent(items);
  assert.equal(g1.items.length, 6);
  assert.equal(g1.payable.length, 6);
  assert.equal(g1.payableTotal, 585_000);
  assert.equal(g1.capped, false);
  assert.equal(g1.rangeText, "10~12월");
  assert.equal(g2.items.length, 1);
});

test("미납 묶음: 열린 요청 건은 빼고, 10건·500만원 넘으면 앞에서 자르고 표시", () => {
  const many = Array.from({ length: 12 }, (_, i) => unpaid(`p${i}`, "s1", `2026년 ${(i % 12) + 1}월 수강료`, 100_000, i === 0));
  const [g] = groupUnpaidByStudent(many);
  assert.equal(g.payable.length, 10);
  assert.equal(g.payable[0].paymentId, "p1");
  assert.equal(g.capped, true);
  const big = [unpaid("a", "s1", "2026년 1월 수강료", 3_000_000), unpaid("b", "s1", "2026년 2월 수강료", 3_000_000)];
  const [h] = groupUnpaidByStudent(big);
  assert.deepEqual(h.payable.map((u) => u.paymentId), ["a"]);
  assert.equal(h.capped, true);
});

test("미납 묶음: 학생 열쇠가 없는 옛 서버 응답은 묶지 않는다", () => {
  const gs = groupUnpaidByStudent([unpaid("a", "", "2026년 1월 수강료", 1), unpaid("b", "", "2026년 2월 수강료", 1)]);
  assert.equal(gs.length, 2);
});

test("달 범위 글자", () => {
  assert.equal(monthRangeText(["2026년 11월 수강료"]), "11월");
  assert.equal(monthRangeText(["2026년 12월 수강료", "2027년 1월 수강료"]), "2026년 12월~2027년 1월");
  assert.equal(monthRangeText(["수강료"]), "");
});
