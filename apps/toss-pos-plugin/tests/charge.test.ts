// 결제 흐름 테스트 — 가짜 SDK 로 «다른 주문 담김 · 중복 클릭 · 선점 실패 · 정상 · 결제 신호»를 확인
import { test } from "node:test";
import assert from "node:assert/strict";
import { RECENT_KEY, addRecent, createChargeFlow, parseRecent } from "../src/core/charge.ts";
import type { ServerApi, ApiResult } from "../src/core/api.ts";
import type { ChargeRequest, DismissReport, ReportBody } from "../src/core/contract.ts";
import type { DraftLineItemInput, DraftOrderLike, OrderLike, PosSdkLike } from "../src/core/pos-types.ts";
import { pickNotifications } from "../src/core/notify.ts";
import type { NotifyLog } from "../src/core/notify.ts";
import { createTokenStore, maskToken, normalizeToken } from "../src/core/token.ts";

const NOW = Date.parse("2026-11-07T10:00:00+09:00");

const REQ: ChargeRequest = {
  id: "req-1",
  shortCode: "S-4821",
  studentName: "김○○",
  title: "수강료(11월)",
  amount: 100000,
  taxFreeAmount: 100000,
  expiresAt: "2026-11-07T10:30:00+09:00",
  status: "PENDING",
};

/** 가짜 POS: 호출 순서를 log 에 남긴다 */
function fakeSdk(
  opts: {
    draftItems?: number;
    secondDraftItems?: number;
    orders?: Record<string, OrderLike>;
    /** 담은 뒤 다시 읽을 때 POS 가 보여 줄 주문(회차별). 없으면 담은 그대로 + 합계 = 항목가 */
    afterAdd?: (item: DraftLineItemInput, readNo: number) => DraftOrderLike;
  } = {},
) {
  const log: string[] = [];
  const store = new Map<string, string>();
  let draft: DraftOrderLike = { lineItems: Array.from({ length: opts.draftItems ?? 0 }, (_, i) => ({ key: `k${i}`, quantity: 1 })) };
  let gets = 0;
  let added: DraftLineItemInput | null = null;
  let readsAfterAdd = 0;
  const sdk: PosSdkLike = {
    draftOrder: {
      async get() {
        gets += 1;
        log.push("draft.get");
        if (gets === 2 && opts.secondDraftItems) {
          draft = { lineItems: Array.from({ length: opts.secondDraftItems }, (_, i) => ({ key: `x${i}`, quantity: 1 })) };
        }
        if (added && opts.afterAdd) return opts.afterAdd(added, ++readsAfterAdd);
        return draft;
      },
      async clear() {
        log.push("draft.clear");
        draft = { lineItems: [] };
        added = null;
      },
      async addLineItem(item: DraftLineItemInput) {
        log.push(`draft.add:${item.memo}:${item.itemPrice.priceValue}:${item.itemPrice.isTaxFree}`);
        added = item;
        draft = {
          lineItems: [{ key: item.key, memo: item.memo, quantity: item.quantity, item: { code: item.item.code }, itemPrice: { ...item.itemPrice } }],
          price: { orderPriceValue: item.itemPrice.priceValue },
        };
        // 운영(2026-11-08 S-704715)처럼 반환값은 합계가 재계산 전(0)이다 — 판단에 쓰지 않아야 한다
        return { ...draft, price: { orderPriceValue: 0 } };
      },
      async startPayment() {
        log.push("draft.startPayment");
      },
    },
    order: {
      async getOrder(id: string) {
        log.push(`order.get:${id}`);
        return opts.orders?.[id] ?? { id, lineItems: [{ memo: "아메리카노" }] };
      },
    },
    payment: {
      async getPayment(id: string) {
        return { id, orderId: "o", amountMoney: 100000, taxExemptMoney: 100000 };
      },
      async cancel() {
        log.push("payment.cancel");
      },
    },
    toast: {
      success: (p) => log.push(`toast.success:${p.message}`),
      warn: (p) => log.push(`toast.warn:${p.message}`),
      error: (p) => log.push(`toast.error:${p.message}`),
    },
    alert: { open: (p) => log.push(`alert:${p.message}`) },
    storage: {
      async get(k: string) {
        return store.get(k);
      },
      async set(k: string, v: string) {
        store.set(k, v);
      },
    },
  };
  return { sdk, log, store };
}

const sleep0 = async () => undefined;

/** 다시 읽은 주문 모양 만들기 */
function readback(item: DraftLineItemInput, over: { total?: number; price?: number; qty?: number; taxFree?: boolean; extra?: number; memo?: string } = {}): DraftOrderLike {
  const li = {
    key: item.key,
    memo: over.memo ?? item.memo,
    quantity: over.qty ?? item.quantity,
    itemPrice: { priceValue: over.price ?? item.itemPrice.priceValue, priceUnit: 1, isTaxFree: over.taxFree ?? item.itemPrice.isTaxFree },
  };
  const extra = Array.from({ length: over.extra ?? 0 }, (_, i) => ({ key: `o${i}`, quantity: 1 }));
  return { lineItems: [li, ...extra], price: { orderPriceValue: over.total ?? 0 } };
}

function fakeApi(claimResult: ApiResult<ChargeRequest> = { ok: true, data: REQ }, reportStatus = "SENT") {
  const calls: string[] = [];
  const reports: { id: string; body: ReportBody }[] = [];
  const api = {
    async listRequests() {
      return { ok: true as const, data: [] };
    },
    async claim(id: string) {
      calls.push(`claim:${id}`);
      return claimResult;
    },
    async chargeUnpaid(pid: string) {
      calls.push(`chargeUnpaid:${pid}`);
      return claimResult;
    },
    async report(id: string, body: ReportBody) {
      calls.push(`report:${id}:${body.event}`);
      reports.push({ id, body });
      return { ok: true as const, data: reportStatus };
    },
    async startCheck() {
      return { ok: true as const, data: true as const };
    },
    async searchUnpaid() {
      return { ok: true as const, data: [] };
    },
  } as unknown as ServerApi;
  return { api, calls, reports };
}

test("장바구니 준비 중 사이트 취소를 받으면 결제창을 열지 않고 POS 확인 후 결과를 한 번 보고", async () => {
  const { sdk, log } = fakeSdk();
  const { api } = fakeApi();
  const receipts: DismissReport[] = [];
  api.dismissReport = async (_id, body) => { receipts.push(body); return { ok: true, data: true }; };
  let entered!: () => void;
  let proceed!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const pause = new Promise<void>((resolve) => { proceed = resolve; });
  const originalAdd = sdk.draftOrder.addLineItem;
  sdk.draftOrder.addLineItem = async (item) => { entered(); await pause; return originalAdd(item); };
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  const started = flow.startCharge(REQ);
  await waiting;
  await flow.dismissUnpaid(REQ);
  assert.deepEqual(receipts, []);
  proceed();
  assert.equal(await started, "dismissed");
  await flow.dismissUnpaid(REQ);
  assert.deepEqual(receipts, [{ outcome: "DONE", reason: "CHECKOUT_NOT_STARTED" }]);
  assert.equal(log.filter((entry) => entry === "draft.clear").length, 2);
  assert.ok(!log.includes("draft.startPayment"));
});

test("시작 직전 서버 확인이 거절되면 결제창을 열지 않고 해당 장바구니를 비움", async () => {
  const { sdk, log } = fakeSdk();
  const { api, reports } = fakeApi();
  api.startCheck = async () => ({ ok: false, kind: "conflict", code: 409, message: "취소된 요청" });
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  assert.equal(await flow.startCharge(REQ), "claim_failed");
  assert.ok(!log.includes("draft.startPayment"));
  assert.deepEqual((await sdk.draftOrder.get()).lineItems, []);
  assert.equal(reports[0].body.reason, "start_check_conflict");
});

test("POS 결제창 응답을 기다리는 동안 미결제 주문 취소와 결과 보고를 처리하고, 보고만 재시도", async () => {
  const { sdk } = fakeSdk();
  const { api } = fakeApi();
  let entered!: () => void;
  let proceed!: () => void;
  const waiting = new Promise<void>((resolve) => { entered = resolve; });
  const pause = new Promise<void>((resolve) => { proceed = resolve; });
  let cancelCalls = 0;
  let order: OrderLike = {
    id: "order-1", orderState: "OPENED", paymentState: "OPENED", createdAt: new Date(NOW).toISOString(),
    payments: [], paymentPrice: { paymentPaidValue: 0 }, chargePrice: { chargePriceValue: REQ.amount },
    lineItems: [{ memo: `STIZ:${REQ.shortCode}` }],
  };
  sdk.order.getOrders = async () => [order];
  sdk.order.getOrder = async () => order;
  sdk.order.cancel = async () => { cancelCalls++; order = { ...order, orderState: "CANCELLED" }; };
  sdk.draftOrder.startPayment = async () => { entered(); await pause; };
  const receipts: DismissReport[] = [];
  api.dismissReport = async (_id, body) => {
    receipts.push(body);
    return receipts.length === 1 ? { ok: false, kind: "network", code: 0, message: "네트워크" } : { ok: true, data: true };
  };
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  const started = flow.startCharge(REQ);
  await waiting;
  await flow.dismissUnpaid(REQ);
  await flow.dismissUnpaid(REQ);
  assert.equal(cancelCalls, 1);
  assert.deepEqual(receipts.map((r) => r.outcome), ["DONE", "DONE"]);
  proceed();
  assert.equal(await started, "started");
});

test("정상: 선점 → 비우기 → 면세 항목 추가 → 결제 시작, 최근 목록에 기록", async () => {
  const { sdk, log, store } = fakeSdk();
  const { api, calls } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  assert.equal(await flow.startCharge(REQ), "started");
  assert.deepEqual(calls, ["claim:req-1"]);
  // 담은 뒤 반환값(합계 0)이 아니라 «다시 읽은» 주문으로 판단한다
  assert.deepEqual(log, ["draft.get", "draft.get", "draft.clear", "draft.add:STIZ:S-4821:100000:true", "draft.get", "draft.startPayment"]);
  assert.equal(parseRecent(store.get(RECENT_KEY))[0].id, "req-1");
});

test("다른 주문이 담겨 있으면: 서버를 부르지 않고 덮어쓰지 않는다", async () => {
  const { sdk, log } = fakeSdk({ draftItems: 2 });
  const { api, calls } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  assert.equal(await flow.startCharge(REQ), "draft_not_empty");
  assert.deepEqual(calls, []);
  assert.ok(!log.includes("draft.clear"));
  assert.ok(log.some((l) => l.startsWith("alert:결제 화면에 다른 상품")));
});

test("선점하는 사이 상품이 담기면: 덮어쓰지 않고 서버에 start_failed 보고", async () => {
  const { sdk, log } = fakeSdk({ secondDraftItems: 1 });
  const { api, calls } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  assert.equal(await flow.startCharge(REQ), "draft_not_empty");
  assert.deepEqual(calls, ["claim:req-1", "report:req-1:start_failed"]);
  assert.ok(!log.includes("draft.clear"));
});

test("선점 실패(이미 가져감): 주문을 건드리지 않음", async () => {
  const { sdk, log } = fakeSdk();
  const { api } = fakeApi({ ok: false, kind: "conflict", code: 409, message: "이미 다른 곳에서" });
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  assert.equal(await flow.startCharge(REQ), "claim_failed");
  assert.ok(!log.some((l) => l.startsWith("draft.add")));
  assert.ok(log.includes("toast.warn:이미 다른 곳에서"));
});

test("과세 섞인 요청: 결제 화면을 열지 않고 start_failed 보고", async () => {
  const { sdk, log } = fakeSdk();
  const { api, calls } = fakeApi({ ok: true, data: { ...REQ, taxFreeAmount: 0 } });
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  assert.equal(await flow.startCharge(REQ), "invalid");
  assert.ok(calls.includes("report:req-1:start_failed"));
  assert.ok(!log.includes("draft.startPayment"));
});

test("중복 클릭: 준비 중 두 번째 클릭은 무시(선점 1번만)", async () => {
  const { sdk } = fakeSdk();
  const { api, calls } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  const [a, b] = await Promise.all([flow.startCharge(REQ), flow.startCharge(REQ)]);
  assert.deepEqual([a, b].sort(), ["busy", "started"]);
  assert.equal(calls.filter((c) => c.startsWith("claim")).length, 1);
  assert.equal(flow.isBusy(), false);
});

test("POS 오류: 토스트로 안내하고 잠금 풀림", async () => {
  const { sdk, log } = fakeSdk();
  sdk.draftOrder.startPayment = async () => {
    throw new Error("boom");
  };
  const { api, calls } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW, sleep: sleep0 });
  assert.equal(await flow.startCharge(REQ), "error");
  assert.ok(log.some((l) => l.startsWith("toast.error:")));
  assert.ok(calls.includes("report:req-1:start_failed"));
  assert.equal(flow.isBusy(), false);
});

test("결제가 끝난 뒤 startPayment 가 오류(2026-11-08 실측): 결제 신호를 받았으면 오류 안내·실패 보고 없이 started", async () => {
  const { sdk, log } = fakeSdk({ orders: { o9: { id: "o9", lineItems: [{ memo: "STIZ:S-4821" }] } } });
  const { api, calls } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW, sleep: sleep0 });
  sdk.draftOrder.startPayment = async () => {
    // 결제 화면에서 결제가 끝나고(결제 신호) 나서야 오류로 돌아온다
    await flow.handlePaymentEvent("paid", "p9", "o9");
    throw new Error("closed");
  };
  assert.equal(await flow.startCharge(REQ), "started");
  assert.ok(!log.some((l) => l.startsWith("toast.error:")));
  assert.ok(!calls.includes("report:req-1:start_failed"));
  assert.ok(calls.includes("report:req-1:paid"));
});

test("startPayment 오류인데 우리 항목이 장바구니에서 빠짐: 다시 결제하라고 하지 않고 확인 안내만", async () => {
  const { sdk, log } = fakeSdk();
  const { api, calls } = fakeApi();
  sdk.draftOrder.startPayment = async () => {
    await sdk.draftOrder.clear(); // 결제 단계로 넘어가며 장바구니가 비었다
    throw new Error("closed");
  };
  const flow = createChargeFlow({ sdk, api, now: () => NOW, sleep: sleep0 });
  assert.equal(await flow.startCharge(REQ), "started");
  assert.ok(!log.some((l) => l.startsWith("toast.error:")));
  assert.ok(log.some((l) => l.startsWith("toast.warn:S-4821 결제 화면 상태를 확인")));
  assert.ok(!calls.includes("report:req-1:start_failed"));
});

test("미납 목록에서 결제: chargeUnpaid 로 선점", async () => {
  const { sdk } = fakeSdk();
  const { api, calls } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  assert.equal(await flow.startChargeForUnpaid("pay-9"), "started");
  assert.deepEqual(calls, ["chargeUnpaid:pay-9"]);
});

test("결제 신호: 우리 주문이 아니면 무시, 우리 주문이면 1번만 보고", async () => {
  const { sdk, store } = fakeSdk({ orders: { o1: { id: "o1", lineItems: [{ memo: "STIZ:S-4821" }] } } });
  store.set(RECENT_KEY, JSON.stringify([{ id: "req-1", shortCode: "S-4821", amount: 100000, at: NOW }]));
  const { api, reports } = fakeApi(undefined, "PAID");
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  assert.equal(await flow.handlePaymentEvent("paid", "pX", "other"), "ignored");
  assert.equal(await flow.handlePaymentEvent("paid", "p1", "o1"), "reported");
  assert.equal(await flow.handlePaymentEvent("paid", "p1", "o1"), "ignored");
  assert.deepEqual(reports, [
    { id: "req-1", body: { event: "paid", tossOrderId: "o1", tossPaymentId: "p1", amount: 100000, taxExemptAmount: 100000 } },
  ]);
  assert.equal(await flow.handlePaymentEvent("cancel", "p1", "o1"), "reported");
  assert.equal(reports[1].body.event, "cancel");
});

test("결제 신호: 이 기기에서 시작하지 않은 번호면 보고하지 않음(서버 웹훅이 맞춘다)", async () => {
  const { sdk } = fakeSdk({ orders: { o1: { id: "o1", lineItems: [{ memo: "STIZ:S-9999" }] } } });
  const { api, reports } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW });
  assert.equal(await flow.handlePaymentEvent("paid", "p1", "o1"), "unknown");
  assert.equal(reports.length, 0);
});

test("최근 목록: 망가진 값은 빈 목록, 같은 번호는 교체, 최대 20건", () => {
  assert.deepEqual(parseRecent("{깨짐"), []);
  assert.deepEqual(parseRecent(undefined), []);
  let list = addRecent([], { id: "a", shortCode: "S-0001", amount: 1, at: 1 });
  list = addRecent(list, { id: "b", shortCode: "S-0001", amount: 1, at: 2 });
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "b");
  for (let i = 0; i < 30; i++) list = addRecent(list, { id: `x${i}`, shortCode: `S-${1000 + i}`, amount: 1, at: i });
  assert.equal(list.length, 20);
});

test("알림 고르기: 새 요청 1번, 5분 뒤 다시, 최대 3번, 사라지면 기록 삭제", () => {
  const log: NotifyLog = new Map();
  const reqs = [REQ, { ...REQ, id: "sent", status: "SENT" }, { ...REQ, id: "old", expiresAt: "2026-11-07T00:00:00Z" }];
  assert.deepEqual(pickNotifications(reqs, log, NOW).map((r) => r.id), ["req-1"]);
  assert.deepEqual(pickNotifications(reqs, log, NOW + 60_000), []);
  assert.deepEqual(pickNotifications(reqs, log, NOW + 5 * 60_000).map((r) => r.id), ["req-1"]);
  assert.deepEqual(pickNotifications(reqs, log, NOW + 10 * 60_000).map((r) => r.id), ["req-1"]);
  assert.deepEqual(pickNotifications(reqs, log, NOW + 15 * 60_000), []);
  pickNotifications([], log, NOW + 16 * 60_000);
  assert.equal(log.size, 0);
});

test("토큰: 모양 검사·마스킹·캐시(secureStore 를 매번 읽지 않음)", async () => {
  assert.equal(normalizeToken("  " + "a".repeat(32) + " "), "a".repeat(32));
  assert.equal(normalizeToken("짧음"), null);
  // 서버가 발급하는 실제 모양(stizpos_ + base64url)
  assert.equal(normalizeToken("stizpos_AbC-12_xyz" + "Q".repeat(30)), "stizpos_AbC-12_xyz" + "Q".repeat(30));
  assert.equal(normalizeToken("a".repeat(31) + " b"), null);
  assert.equal(normalizeToken(123), null);
  assert.equal(maskToken("abcdefgh"), "••••efgh");
  assert.equal(maskToken(undefined), "없음");
  let reads = 0;
  const mem = new Map<string, string>();
  const store = createTokenStore({
    async get(k) {
      reads += 1;
      return mem.get(k);
    },
    async set(k, v) {
      mem.set(k, v);
    },
    async del(k) {
      mem.delete(k);
    },
  });
  assert.equal(await store.get(), undefined);
  assert.equal(await store.set("bad"), false);
  assert.equal(await store.set("T".repeat(40)), true);
  await store.get();
  await store.get();
  assert.equal(reads, 1);
  store.reload();
  assert.equal(await store.get(), "T".repeat(40));
  assert.equal(reads, 2);
  await store.clear();
  assert.equal(await store.get(), undefined);
});

test("운영 사고 재현(S-704715): 합계가 0(재계산 전)이어도 항목가×수량이 맞으면 결제 화면을 연다", async () => {
  const { sdk, log } = fakeSdk({ afterAdd: (item) => readback(item, { total: 0 }) });
  const { api, calls } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW, sleep: sleep0 });
  assert.equal(await flow.startCharge(REQ), "started");
  assert.deepEqual(calls, ["claim:req-1"]);
  assert.ok(log.includes("draft.startPayment"));
});

test("담은 직후 아직 안 보이면 짧게 다시 읽고(최대 3번) 열린다", async () => {
  const { sdk, log } = fakeSdk({ afterAdd: (item, n) => (n < 3 ? { lineItems: [], price: { orderPriceValue: 0 } } : readback(item)) });
  const { api } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW, sleep: sleep0 });
  assert.equal(await flow.startCharge(REQ), "started");
  assert.equal(log.filter((l) => l === "draft.get").length, 2 + 3);
});

test("합계가 처음엔 0이었다가 뒤늦게 할인이 붙으면: 끝까지 다시 읽어 잡아내고 결제 화면을 열지 않는다", async () => {
  const { sdk, log } = fakeSdk({ afterAdd: (item, n) => readback(item, { total: n < 2 ? 0 : 90000 }) });
  const { api } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW, sleep: sleep0 });
  assert.equal(await flow.startCharge(REQ), "invalid");
  assert.ok(!log.includes("draft.startPayment"));
});

test("합계가 처음부터 계산돼 있으면(금액과 같음) 다시 읽지 않고 바로 연다", async () => {
  const { sdk, log } = fakeSdk({ afterAdd: (item) => readback(item, { total: REQ.amount }) });
  const { api } = fakeApi();
  const flow = createChargeFlow({ sdk, api, now: () => NOW, sleep: sleep0 });
  assert.equal(await flow.startCharge(REQ), "started");
  assert.equal(log.filter((l) => l === "draft.get").length, 2 + 1);
});

test("금액 불일치: 비우고 멈추며, 서버 보고에 실제 값(항목가·수량·합계·면세)을 남긴다", async () => {
  const cases: Array<[string, Parameters<typeof readback>[1], string]> = [
    ["자동 할인으로 합계가 다름", { total: 90000 }, "total=90000"],
    ["항목가가 다름", { price: 1000, total: 0 }, "item=1000x1"],
    ["수량이 2", { qty: 2 }, "item=100000x2"],
    ["면세가 꺼짐", { taxFree: false }, "taxFree=false"],
    ["다른 항목이 섞임", { extra: 1 }, "n=2"],
    ["메모 번호가 없음", { memo: "다른 메모" }, "memo=no"],
  ];
  for (const [name, over, expect] of cases) {
    const { sdk, log } = fakeSdk({ afterAdd: (item) => readback(item, over) });
    const { api, reports } = fakeApi();
    const flow = createChargeFlow({ sdk, api, now: () => NOW, sleep: sleep0 });
    assert.equal(await flow.startCharge(REQ), "invalid", name);
    assert.ok(!log.includes("draft.startPayment"), name);
    assert.equal(log.at(-2), "draft.clear", name);
    const reason = reports[0]?.body.reason ?? "";
    assert.match(reason, /^draft_mismatch n=\d+ item=/, name);
    assert.ok(reason.includes(expect), `${name}: ${reason}`);
    assert.ok(reason.length <= 300, name);
    assert.ok(log.some((l) => l.startsWith("alert:주문 금액이 요청과 달라")), name);
  }
});

test("자동 시작(silent): 화면을 막는 alert 를 띄우지 않는다 — 다른 주문은 조용히, 금액 문제는 경고 토스트", async () => {
  {
    const { sdk, log } = fakeSdk({ draftItems: 1 });
    const flow = createChargeFlow({ sdk, api: fakeApi().api, now: () => NOW });
    assert.equal(await flow.startCharge(REQ, { silent: true }), "draft_not_empty");
    assert.ok(!log.some((l) => l.startsWith("alert:") || l.startsWith("toast.")), log.join("|"));
  }
  {
    const { sdk, log } = fakeSdk({ afterAdd: (item) => readback(item, { total: 90000 }) });
    const flow = createChargeFlow({ sdk, api: fakeApi().api, now: () => NOW, sleep: sleep0 });
    assert.equal(await flow.startCharge(REQ, { silent: true }), "invalid");
    assert.ok(!log.some((l) => l.startsWith("alert:")));
    assert.ok(log.some((l) => l.startsWith("toast.warn:주문 금액이 요청과 달라")));
  }
  {
    const { sdk, log } = fakeSdk();
    const flow = createChargeFlow({ sdk, api: fakeApi().api, now: () => NOW });
    const [a, b] = await Promise.all([flow.startCharge(REQ), flow.startCharge(REQ, { silent: true })]);
    assert.deepEqual([a, b], ["started", "busy"]);
    assert.ok(!log.some((l) => l.startsWith("toast.warn:결제를 준비하고")), "자동 경로 busy 는 안내를 겹치지 않는다");
  }
});
