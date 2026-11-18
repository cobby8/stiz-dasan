import assert from "node:assert/strict";
import { test } from "node:test";
import { dismissUnpaidOrder } from "../src/core/dismiss.ts";
import { API_PATHS, parseStartAllowed, parseWaitList } from "../src/core/contract.ts";
import type { DraftOrderLike, OrderLike, PosSdkLike } from "../src/core/pos-types.ts";

const job = { id: "request-1", shortCode: "S-745589" };
const now = Date.parse("2026-11-11T18:05:41+09:00");
const recent = { at: now - 2_000, amount: 112_500 };
const line = { key: "x", quantity: 1, memo: "STIZ:S-745589" };
const exact: OrderLike = {
  id: "order-1", createdAt: "2026-11-11T18:05:40+09:00", lineItems: [line],
  orderState: "OPENED", paymentState: "OPENED", payments: [], paymentPrice: { paymentPaidValue: 0 },
  chargePrice: { chargePriceValue: 112_500 },
};

function harness(draft: DraftOrderLike, orders: OrderLike[]) {
  const log: string[] = [];
  const sdk = {
    draftOrder: {
      async get() { return draft; },
      async clear() { log.push("draft.clear"); draft = { lineItems: [] }; },
    },
    order: {
      async getOrders() { return orders; },
      async getOrder(id: string) { return orders.find((order) => order.id === id)!; },
      async cancel(id: string) {
        log.push(`order.cancel:${id}`);
        orders = orders.map((order) => order.id === id ? { ...order, orderState: "CANCELLED" } : order);
      },
    },
    payment: { async cancel() { assert.fail("미결제 요청 취소에서 환불 호출 금지"); } },
  } as unknown as PosSdkLike;
  return { sdk, log };
}

test("계약: 취소 요청 opt-in, 응답 해석, POS 확인 보고와 시작 확인 주소", () => {
  assert.match(API_PATHS.chargeRequestsWait(20), /dismiss=1/);
  assert.deepEqual(parseWaitList({ data: { dismissals: [{ id: job.id, short_code: job.shortCode }, { id: "x", short_code: "other" }] } }).dismissals, [job]);
  assert.deepEqual(parseWaitList({ requests: [] }).dismissals, []);
  assert.match(API_PATHS.dismissReport(job.id), /request-1\/dismiss\/report$/);
  assert.match(API_PATHS.startCheck(job.id), /request-1\/start-check$/);
  assert.equal(parseStartAllowed({ data: { allowed: true } }), true);
  assert.equal(parseStartAllowed({ data: { allowed: false } }), null);
});

test("결제창 열기 전 사이트 취소: 우리 항목만 있는 미저장 주문을 비우고 확인", async () => {
  const h = harness({ lineItems: [line] }, []);
  const result = await dismissUnpaidOrder({ sdk: h.sdk, job, now, stoppedBeforeCheckout: true });
  assert.deepEqual(result, { outcome: "DONE", reason: "CHECKOUT_NOT_STARTED" });
  assert.deepEqual(h.log, ["draft.clear"]);
});

test("미결제 주문을 목록에서 찾고 취소 상태를 재조회, 재시도는 중복 취소하지 않음", async () => {
  const h = harness({ lineItems: [] }, [exact, { ...exact, id: "old", createdAt: "2026-11-10T18:05:40+09:00" }]);
  const originalList = h.sdk.order.getOrders!;
  h.sdk.order.getOrders = async (params) => {
    assert.equal(params.start, "2026-11-11T18:05:29");
    assert.equal(params.end, "2026-11-11T18:05:51");
    return originalList(params);
  };
  const input = { sdk: h.sdk, job, now, recent, stoppedBeforeCheckout: false };
  assert.deepEqual(await dismissUnpaidOrder(input), { outcome: "DONE", reason: "POS_ORDER_CANCELLED" });
  assert.deepEqual(await dismissUnpaidOrder(input), { outcome: "DONE", reason: "POS_ORDER_CANCELLED" });
  assert.deepEqual(h.log, ["order.cancel:order-1"]);
});

test("저장된 주문이 없고 결제창이 열렸을 수 있으면 임시 주문을 비우지 않고 현장 확인으로 남김(2026-11-18 흰 화면)", async () => {
  const draft = { lineItems: [line], price: { orderPriceValue: recent.amount } };
  const input = { job, now, recent, stoppedBeforeCheckout: false };
  const h = harness(draft, []);
  assert.deepEqual(await dismissUnpaidOrder({ ...input, sdk: h.sdk }), {
    outcome: "NEEDS_LOCAL_CANCEL", reason: "POS_CHECKOUT_OPEN_CLOSE_SCREEN",
  });
  // 결제창 밑 장바구니를 비우면 다음 요청이 «비었다»고 보고 결제창을 겹쳐 연다 — 지우지 않는다
  assert.deepEqual(h.log, []);
  const changed = harness({ ...draft, price: { orderPriceValue: 1 } }, []);
  assert.deepEqual(await dismissUnpaidOrder({ ...input, sdk: changed.sdk }), {
    outcome: "NEEDS_LOCAL_CANCEL", reason: "POS_ORDER_NOT_IDENTIFIED",
  });
  assert.deepEqual(changed.log, []);
});

test("결제 화면에 남은 임시 주문: 우리 탭으로 이동해 결제 화면을 벗어난 «뒤에»만 비우고 완료(2026-11-18 S-621853)", async () => {
  const draft = { lineItems: [line], price: { orderPriceValue: recent.amount } };
  const h = harness(draft, []);
  const waits: number[] = [];
  h.sdk.navigation = { navigate: (page, pkg) => { h.log.push(`navigate:${page}:${pkg}`); } };
  const result = await dismissUnpaidOrder({ sdk: h.sdk, job, now, recent, stoppedBeforeCheckout: false, wait: async (ms) => { waits.push(ms); } });
  assert.deepEqual(result, { outcome: "DONE", reason: "POS_CHECKOUT_LEFT_DRAFT_CLEARED" });
  assert.deepEqual(h.log, ["navigate:plugin-setting-tab:stiz-pos-charge-tab", "draft.clear"], "이동이 비우기보다 먼저");
  assert.equal(waits.length, 1);
});

test("이동이 오류면 장바구니를 건드리지 않고 현장 확인으로 남김", async () => {
  const draft = { lineItems: [line], price: { orderPriceValue: recent.amount } };
  const h = harness(draft, []);
  h.sdk.navigation = { navigate: () => { throw new Error("unsupported"); } };
  assert.deepEqual(await dismissUnpaidOrder({ sdk: h.sdk, job, now, recent, stoppedBeforeCheckout: false, wait: async () => undefined }), {
    outcome: "NEEDS_LOCAL_CANCEL", reason: "POS_CHECKOUT_OPEN_CLOSE_SCREEN",
  });
  assert.deepEqual(h.log, []);
});

test("저장된 주문을 취소한 뒤에도 결제 화면에서 먼저 벗어난다(결제창을 열기 전 취소면 이동 안 함)", async () => {
  const h = harness({ id: exact.id, lineItems: [line] }, [exact]);
  h.sdk.navigation = { navigate: (page) => { h.log.push(`navigate:${page}`); } };
  const opts = { sdk: h.sdk, job, now, recent, wait: async () => undefined };
  assert.deepEqual(await dismissUnpaidOrder({ ...opts, stoppedBeforeCheckout: false }), { outcome: "DONE", reason: "POS_ORDER_CANCELLED" });
  assert.deepEqual(h.log, ["order.cancel:order-1", "navigate:plugin-setting-tab", "draft.clear"]);
  const early = harness({ lineItems: [line] }, []);
  early.sdk.navigation = { navigate: () => { early.log.push("navigate"); } };
  await dismissUnpaidOrder({ sdk: early.sdk, job, now, stoppedBeforeCheckout: true, wait: async () => undefined });
  assert.ok(!early.log.includes("navigate"));
});

test("카드 승인·중복 주문·다른 주문 섞임·주문 식별 불가: POS 확인 요청으로 남기고 아무것도 지우지 않음", async () => {
  for (const orders of [
    [{ ...exact, paymentState: "PAID", payments: [{ id: "p" }], paymentPrice: { paymentPaidValue: 1 } }],
    [exact, { ...exact, id: "duplicate" }],
    [{ ...exact, lineItems: [line, { memo: "다른 상품" }] }],
    [],
  ]) {
    const h = harness({ lineItems: [line, { key: "other", quantity: 1, memo: "다른 상품" }] }, orders);
    assert.equal((await dismissUnpaidOrder({ sdk: h.sdk, job, now, recent, stoppedBeforeCheckout: false })).outcome, "NEEDS_LOCAL_CANCEL");
    assert.deepEqual(h.log, []);
  }
});

test("SDK 주문 취소가 끝났지만 주문 상태 미변경이면 사이트 완료로 보고하지 않음", async () => {
  const h = harness({ id: exact.id, lineItems: [line] }, [exact]);
  h.sdk.order.cancel = async () => undefined;
  assert.deepEqual(await dismissUnpaidOrder({ sdk: h.sdk, job, now, recent, stoppedBeforeCheckout: false }), {
    outcome: "NEEDS_LOCAL_CANCEL", reason: "POS_ORDER_CANCEL_UNVERIFIED",
  });
  assert.deepEqual(h.log, []);
});
