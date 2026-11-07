// 결제 취소 흐름 테스트 — 가짜 SDK·가짜 서버로 «취소 · 이미 취소된 결제 건너뜀 · 분할 결제 · 실패 보고 · 남의 주문 보호 · 중복 방지»
import { test } from "node:test";
import assert from "node:assert/strict";
import { CANCEL_RETRY_MS, createCancelFlow } from "../src/core/cancel.ts";
import type { ApiResult, ServerApi } from "../src/core/api.ts";
import type { CancelClaim, CancelJob, CancelReportBody } from "../src/core/contract.ts";
import { API_PATHS, parseCancelClaim, parseCancelReport, parseWaitList } from "../src/core/contract.ts";
import type { PaymentLike, PosSdkLike } from "../src/core/pos-types.ts";

const JOB: CancelJob = { id: "req-1", shortCode: "S-482193", amount: 180000, studentName: "홍*동", title: "2026년 11월 수강료(홍*동)" };
const CLAIM: CancelClaim = { ...JOB, tossOrderId: "o-1", tossPaymentIds: ["tp-1"] };

/** 가짜 POS — 결제 상태를 들고 있다가 cancel 하면 CANCELLED 로 바꾼다 */
function fakeSdk(states: Record<string, { state: string; orderId?: string }>, opts: { cancelThrows?: Record<string, string>; cancelNoop?: boolean } = {}) {
  const log: string[] = [];
  const toasts: string[] = [];
  const sdk = {
    payment: {
      async getPayment(id: string): Promise<PaymentLike> {
        log.push(`get:${id}`);
        const s = states[id];
        if (!s) throw new Error("not found");
        return { id, orderId: s.orderId ?? "o-1", state: s.state };
      },
      async cancel(order: { id: string }, payment: { id: string }) {
        log.push(`cancel:${order.id}:${payment.id}`);
        if (opts.cancelThrows?.[payment.id]) throw new Error(opts.cancelThrows[payment.id]);
        // cancelNoop = POS 확인 창에서 사람이 거절(오류 없이 끝났지만 결제는 그대로)
        if (!opts.cancelNoop) states[payment.id] = { ...states[payment.id], state: "CANCELLED" };
      },
    },
    toast: {
      success: (p: { message: string }) => void toasts.push(`ok:${p.message}`),
      warn: (p: { message: string }) => void toasts.push(`warn:${p.message}`),
      error: (p: { message: string }) => void toasts.push(`err:${p.message}`),
    },
  } as unknown as PosSdkLike;
  return { sdk, log, toasts };
}

/** 가짜 서버 — 선점 결과와 보고 본문을 기록 */
function fakeApi(claim: ApiResult<CancelClaim> = { ok: true, data: CLAIM }) {
  const reports: { id: string; body: CancelReportBody }[] = [];
  let claims = 0;
  const api = {
    async cancelClaim() {
      claims += 1;
      return claim;
    },
    async cancelReport(id: string, body: CancelReportBody) {
      reports.push({ id, body });
      return { ok: true, data: "SENT" } as ApiResult<string>;
    },
  } as unknown as ServerApi;
  return { api, reports, claimCount: () => claims };
}

test("취소: 승인 결제를 payment.cancel({id:주문},{id:결제}) 로 취소하고 done 보고 + 안내", async () => {
  const { sdk, log, toasts } = fakeSdk({ "tp-1": { state: "APPROVED" } });
  const { api, reports } = fakeApi();
  const flow = createCancelFlow({ sdk, api });
  const r = await flow.run(JOB);
  assert.equal(r.result, "cancelled");
  assert.deepEqual(log, ["get:tp-1", "cancel:o-1:tp-1", "get:tp-1"], "취소 전 상태 확인 → 취소 → 다시 확인");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].id, "req-1");
  assert.equal(reports[0].body.result, "done");
  assert.ok(toasts.some((t) => t.startsWith("ok:") && /환불/.test(t)));
  assert.equal(flow.wasCancelledHere("tp-1"), true, "이 기기가 취소한 결제 — 취소 신호 안내를 겹치지 않게");
});

test("취소: 이미 취소된 결제는 다시 취소하지 않는다(건너뛰고 done)", async () => {
  const { sdk, log } = fakeSdk({ "tp-1": { state: "CANCELLED" } });
  const { api, reports } = fakeApi();
  const r = await createCancelFlow({ sdk, api }).run(JOB);
  assert.equal(r.result, "cancelled");
  assert.ok(!log.some((l) => l.startsWith("cancel:")), "payment.cancel 을 부르지 않는다");
  assert.equal(reports[0].body.result, "done");
  assert.match(reports[0].body.message ?? "", /이미 취소 1건/);
});

test("취소: 분할 결제 — 결제마다 취소(이미 취소된 건 건너뜀)", async () => {
  const { sdk, log } = fakeSdk({ "tp-card": { state: "APPROVED" }, "tp-cash": { state: "CANCELLED" } });
  const { api } = fakeApi({ ok: true, data: { ...CLAIM, tossPaymentIds: ["tp-card", "tp-cash"] } });
  const r = await createCancelFlow({ sdk, api }).run(JOB);
  assert.equal(r.result, "cancelled");
  assert.deepEqual(log.filter((l) => l.startsWith("cancel:")), ["cancel:o-1:tp-card"]);
});

test("취소 실패: POS 가 거절하면 failed 보고(사유 포함) + «POS 에서 직접 취소» 안내, 나머지 결제는 계속 시도", async () => {
  const { sdk, log, toasts } = fakeSdk({ "tp-a": { state: "APPROVED" }, "tp-b": { state: "APPROVED" } }, { cancelThrows: { "tp-a": "카드사 거절" } });
  const { api, reports } = fakeApi({ ok: true, data: { ...CLAIM, tossPaymentIds: ["tp-a", "tp-b"] } });
  const r = await createCancelFlow({ sdk, api }).run(JOB);
  assert.equal(r.result, "failed");
  assert.ok(log.includes("cancel:o-1:tp-b"), "하나가 실패해도 나머지는 시도");
  assert.equal(reports[0].body.result, "failed");
  assert.match(reports[0].body.message ?? "", /tp-a: 카드사 거절/);
  assert.ok(toasts.some((t) => t.startsWith("err:") && /POS 결제 내역에서 직접 취소/.test(t)));
});

test("취소 실패: cancel 이 오류 없이 끝났는데 결제가 여전히 승인(사람이 확인 창에서 거절) → failed", async () => {
  const { sdk } = fakeSdk({ "tp-1": { state: "APPROVED" } }, { cancelNoop: true });
  const { api, reports } = fakeApi();
  const r = await createCancelFlow({ sdk, api }).run(JOB);
  assert.equal(r.result, "failed");
  assert.match(reports[0].body.message ?? "", /확인되지 않았어요/);
});

test("안전: 서버가 준 주문과 다른 주문의 결제면 절대 취소하지 않는다", async () => {
  const { sdk, log } = fakeSdk({ "tp-1": { state: "APPROVED", orderId: "other-order" } });
  const { api, reports } = fakeApi();
  const r = await createCancelFlow({ sdk, api }).run(JOB);
  assert.equal(r.result, "failed");
  assert.ok(!log.some((l) => l.startsWith("cancel:")));
  assert.match(reports[0].body.message ?? "", /다른 주문/);
});

test("선점 실패(다른 POS 가 가져감)면 아무것도 취소하지 않고, 같은 일을 곧바로 다시 하지 않는다", async () => {
  const { sdk, log } = fakeSdk({ "tp-1": { state: "APPROVED" } });
  const { api, reports, claimCount } = fakeApi({ ok: false, kind: "conflict", code: 409, message: "x" });
  const flow = createCancelFlow({ sdk, api });
  assert.equal((await flow.run(JOB)).result, "claim_failed");
  assert.equal((await flow.run(JOB)).result, "skipped");
  assert.equal(claimCount(), 1);
  assert.equal(log.length, 0);
  assert.equal(reports.length, 0);
});

test("중복 방지: 같은 요청이 롱폴링에 다시 실려 와도 처리 직후엔 건너뛰고, CANCEL_RETRY_MS 뒤엔 다시 한다", async () => {
  let t = 0;
  const { sdk } = fakeSdk({ "tp-1": { state: "APPROVED" } });
  const { api, claimCount } = fakeApi();
  const flow = createCancelFlow({ sdk, api, now: () => t });
  await flow.run(JOB);
  assert.equal((await flow.run(JOB)).result, "skipped");
  t += CANCEL_RETRY_MS;
  await flow.run(JOB);
  assert.equal(claimCount(), 2);
});

test("계약: 롱폴링은 cancels=1 을 보내고, 응답 cancels[] 를 읽는다(없으면 빈 목록 = 옛 서버)", () => {
  assert.match(API_PATHS.chargeRequestsWait(20, ["a"]), /\?wait=20&cancels=1&known=a$/);
  assert.equal(API_PATHS.cancelClaim("r/1"), "/api/pos-plugin/charge-requests/r%2F1/cancel/claim");
  assert.equal(API_PATHS.cancelReport("r1"), "/api/pos-plugin/charge-requests/r1/cancel/report");
  const w = parseWaitList({ ok: true, requests: [], waitSec: 20, cancels: [{ id: "r1", shortCode: "S-1", amount: 1000, studentName: "홍*동", itemName: "x" }, { id: "" }] });
  assert.equal(w.cancels.length, 1);
  assert.equal(w.cancels[0].id, "r1");
  assert.deepEqual(parseWaitList({ requests: [] }).cancels, []);
});

test("계약: 취소 선점 응답 — 주문 ID·결제 ID 가 없으면 null(취소하지 않음), snake_case 도 읽는다", () => {
  const ok = parseCancelClaim({ ok: true, cancel: { id: "r1", shortCode: "S-1", amount: 1, tossOrderId: "o-1", tossPaymentIds: ["a", "b"] } });
  assert.deepEqual(ok?.tossPaymentIds, ["a", "b"]);
  assert.equal(parseCancelClaim({ cancel: { id: "r1", short_code: "S-1", toss_order_id: "o", toss_payment_ids: ["a"] } })?.tossOrderId, "o");
  assert.equal(parseCancelClaim({ cancel: { id: "r1", shortCode: "S-1", tossOrderId: "o-1", tossPaymentIds: [] } }), null);
  assert.equal(parseCancelClaim({ cancel: { id: "r1", shortCode: "S-1", tossPaymentIds: ["a"] } }), null);
  assert.equal(parseCancelReport({ ok: true, cancelState: "SENT", refunded: false }), "SENT");
  assert.equal(parseCancelReport({ ok: true, cancelState: "DONE", refunded: true }), "DONE");
});

test("안전: 결제를 못 읽거나 주문 번호가 비어 있으면 취소하지 않고 failed 보고(사이트 «POS 에서 직접 취소»)", async () => {
  // 결제 조회 실패(가짜 POS 에 없는 결제)
  let f = fakeSdk({});
  let a = fakeApi();
  let r = await createCancelFlow({ sdk: f.sdk, api: a.api }).run(JOB);
  assert.equal(r.result, "failed");
  assert.ok(!f.log.some((l) => l.startsWith("cancel:")), "취소를 시도하지 않는다");
  assert.match(a.reports[0].body.message ?? "", /읽지 못했어요/);
  // 주문 번호 없음
  f = fakeSdk({ "tp-1": { state: "APPROVED", orderId: "" } });
  a = fakeApi();
  r = await createCancelFlow({ sdk: f.sdk, api: a.api }).run(JOB);
  assert.equal(r.result, "failed");
  assert.ok(!f.log.some((l) => l.startsWith("cancel:")));
  assert.match(a.reports[0].body.message ?? "", /주문 번호를 확인하지 못했어요/);
});
