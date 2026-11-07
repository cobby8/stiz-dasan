// 자동 결제창 열기 판단 — 처음 받은 요청만 자동, 못 열었을 때만 버튼 알림
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFirstNotice, needsManualFallback, pickNotifications } from "../src/core/notify.ts";
import type { NotifyLog } from "../src/core/notify.ts";
import type { ChargeRequest } from "../src/core/contract.ts";

const req = (id: string, status = "PENDING") =>
  ({ id, status, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() }) as unknown as ChargeRequest;

test("처음 받은 요청만 자동 결제 대상, 5분 뒤 다시 알릴 때는 자동으로 열지 않는다", () => {
  const log: NotifyLog = new Map();
  const t0 = Date.now();
  const first = pickNotifications([req("a")], log, t0);
  assert.deepEqual(first.map((r) => r.id), ["a"]);
  assert.equal(isFirstNotice(log, "a"), true);
  const again = pickNotifications([req("a")], log, t0 + 5 * 60_000);
  assert.deepEqual(again.map((r) => r.id), ["a"]);
  assert.equal(isFirstNotice(log, "a"), false);
});

test("SENT(이미 가져간) 요청은 자동으로도 알림으로도 다시 열지 않는다", () => {
  const log: NotifyLog = new Map();
  assert.deepEqual(pickNotifications([req("b", "SENT")], log, Date.now()), []);
  assert.equal(isFirstNotice(log, "b"), false);
});

test("못 열었을 때만 [결제하기] 알림을 남긴다", () => {
  for (const r of ["busy", "draft_not_empty", "error"]) assert.equal(needsManualFallback(r), true, r);
  for (const r of ["started", "claim_failed", "invalid"]) assert.equal(needsManualFallback(r), false, r);
});
