// 묶음(같은 학생 여러 건을 POS 결제 한 번, 2026-11-08 원장 결정) 테스트 —
// 서버 items[] 해석 · 항목 N개 담기 · «항목마다 금액·면세·메모 + 합계» 확인 · 단건 회귀
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChargeFlow } from "../src/core/charge.ts";
import type { ApiResult, ServerApi } from "../src/core/api.ts";
import { parseChargeRequest, type ChargeRequest, type ReportBody } from "../src/core/contract.ts";
import { MAX_ITEMS, buildLineItem, buildLineItems, checkDraftAfterAdd, itemsOf, lineKey, validateForPos } from "../src/core/order.ts";
import type { DraftLineItemInput, DraftOrderLike, PosSdkLike } from "../src/core/pos-types.ts";

const NOW = Date.parse("2026-11-07T10:00:00+09:00");

/** 묶음 요청: 10월 수강료 140,000 + 11월 셔틀비 30,000 = 170,000 */
const BUNDLE: ChargeRequest = {
  id: "req-b",
  shortCode: "S-482193",
  studentName: "홍*동",
  title: "2026년 10월 수강료 외 1건(홍*동)",
  amount: 170000,
  taxFreeAmount: 170000,
  expiresAt: "2026-11-07T10:30:00+09:00",
  status: "SENT",
  items: [
    { title: "2026년 10월 수강료(홍*동)", amount: 140000, taxFreeAmount: 140000 },
    { title: "2026년 11월 셔틀비(홍*동)", amount: 30000, taxFreeAmount: 30000 },
  ],
};
const SINGLE: ChargeRequest = { ...BUNDLE, id: "req-s", title: "2026년 11월 수강료(홍*동)", amount: 180000, taxFreeAmount: 180000, items: undefined };
const EQUAL_PRICES: ChargeRequest = {
  ...BUNDLE,
  amount: 260000,
  taxFreeAmount: 260000,
  items: [80000, 80000, 100000].map((amount, i) => ({ title: `수강료 ${i + 1}`, amount, taxFreeAmount: amount })),
};

/** 담긴 결과(항목들)를 그대로 다시 읽은 주문 모양 */
function draftOf(lines: DraftLineItemInput[], total?: number): DraftOrderLike {
  return {
    lineItems: lines.map((l) => ({
      key: l.key,
      memo: l.memo,
      quantity: l.quantity,
      item: { code: l.item.code },
      itemPrice: { priceValue: l.itemPrice.priceValue, priceUnit: 1, isTaxFree: l.itemPrice.isTaxFree },
    })),
    price: { orderPriceValue: total ?? lines.reduce((s, l) => s + l.itemPrice.priceValue * l.quantity, 0) },
  };
}

test("계약: 서버 items[](camel·snake) 를 읽고, 칸이 비면 NaN · 없으면(옛 서버) items 없음", () => {
  const r = parseChargeRequest({
    id: "r", shortCode: "S-482193", amount: 170000, taxFreeAmount: 170000, itemName: "묶음",
    items: [
      { itemName: "2026년 10월 수강료(홍*동)", amount: 140000, taxFreeAmount: 140000, memo: "STIZ:S-482193" },
      { item_title: "2026년 11월 셔틀비(홍*동)", amount: "30000", tax_free_amount: 30000 },
    ],
  });
  assert.deepEqual(r?.items, BUNDLE.items);
  const broken = parseChargeRequest({ id: "r", shortCode: "S-482193", amount: 170000, taxFreeAmount: 170000, items: [{ amount: 140000 }, "x"] });
  assert.ok(Number.isNaN(broken!.items![0].taxFreeAmount));
  assert.ok(Number.isNaN(broken!.items![1].amount));
  assert.equal(parseChargeRequest({ id: "r", shortCode: "S-482193", amount: 1000, taxFreeAmount: 1000 })?.items, undefined);
  // 옛 서버(항목 없음) → 요청 하나 = 항목 하나
  assert.deepEqual(itemsOf(SINGLE), [{ title: SINGLE.title, amount: 180000, taxFreeAmount: 180000 }]);
});

test("검증: 묶음은 항목마다 금액·면세(전액)·합계·면세 합계가 맞을 때만, 항목 수 상한", () => {
  assert.deepEqual(validateForPos(BUNDLE, NOW), { ok: true });
  const item = BUNDLE.items!;
  const bad = (items: ChargeRequest["items"], over: Partial<ChargeRequest> = {}) => validateForPos({ ...BUNDLE, items, ...over }, NOW).ok;
  assert.equal(bad([item[0], { ...item[1], taxFreeAmount: 0 }]), false, "한 항목이라도 과세면 막는다");
  assert.equal(bad([item[0], { ...item[1], amount: 0 }]), false);
  assert.equal(bad([item[0], { ...item[1], taxFreeAmount: Number.NaN }]), false);
  assert.equal(bad([item[0], { ...item[1], amount: 20000, taxFreeAmount: 20000 }]), false, "합계가 요청 금액과 다르면 막는다");
  assert.equal(bad(item, { taxFreeAmount: 160000 }), false, "면세 합계가 다르면 막는다(요청 면세 ≠ 금액이라 먼저 걸림)");
  const many = Array.from({ length: MAX_ITEMS + 1 }, () => ({ title: "x", amount: 1000, taxFreeAmount: 1000 }));
  assert.equal(bad(many, { amount: 1000 * many.length, taxFreeAmount: 1000 * many.length }), false);
  assert.equal(MAX_ITEMS, 10, "서버 MAX_CHARGE_ITEMS 와 같은 값");
});

test("담기: 청구마다 항목 1개 — 같은 STIZ:번호 메모·상품 코드, 항목별 금액·면세, key 는 stiz-번호 / stiz-번호-2", () => {
  const lines = buildLineItems(BUNDLE);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.key), ["stiz-S-482193", "stiz-S-482193-2"]);
  assert.deepEqual(lines.map((l) => l.memo), ["STIZ:S-482193", "STIZ:S-482193"]);
  assert.deepEqual(lines.map((l) => l.item.code), ["STIZ:S-482193", "STIZ:S-482193"]);
  assert.deepEqual(lines.map((l) => l.item.title), ["2026년 10월 수강료(홍*동)", "2026년 11월 셔틀비(홍*동)"]);
  assert.deepEqual(lines.map((l) => l.itemPrice.priceValue), [140000, 30000]);
  assert.ok(lines.every((l) => l.itemPrice.isTaxFree && l.quantity === 1 && l.metadata?.disableQuantityEdit));
  assert.equal(lineKey("S-482193", 0), "stiz-S-482193");
  // 단건 회귀: 예전 buildLineItem(req) 하나와 같다(서버가 items 1개를 줘도 같다)
  assert.deepEqual(buildLineItems(SINGLE), [buildLineItem(SINGLE)]);
  const singleWithItem = { ...SINGLE, items: [{ title: SINGLE.title, amount: 180000, taxFreeAmount: 180000 }] };
  assert.deepEqual(buildLineItems(singleWithItem), [buildLineItem(SINGLE)]);
});

test("담은 뒤 확인(묶음): 항목 N개 각각 금액·면세·메모 + 합계가 맞아야 통과", () => {
  const lines = buildLineItems(BUNDLE);
  let c = checkDraftAfterAdd(draftOf(lines), BUNDLE);
  assert.deepEqual({ ok: c.ok, settled: c.settled }, { ok: true, settled: true });
  assert.match(c.detail, /^n=2\/2 items=140000x1,30000x1 total=170000 taxFree=true,true memo=ok$/);
  // 합계가 아직 0(재계산 전)이어도 항목 기준으로 통과, settled=false(다시 읽기 계속)
  c = checkDraftAfterAdd(draftOf(lines, 0), BUNDLE);
  assert.deepEqual({ ok: c.ok, settled: c.settled }, { ok: true, settled: false });
  // 하나 빠짐
  assert.equal(checkDraftAfterAdd(draftOf(lines.slice(0, 1)), BUNDLE).ok, false);
  assert.match(checkDraftAfterAdd(draftOf(lines.slice(0, 1)), BUNDLE).detail, /^n=1\/2/);
  // 한 항목 금액이 다름
  const wrongPrice = draftOf(lines);
  wrongPrice.lineItems[1].itemPrice!.priceValue = 3000;
  wrongPrice.price!.orderPriceValue = 0;
  assert.equal(checkDraftAfterAdd(wrongPrice, BUNDLE).ok, false);
  // 한 항목이 과세로 들어감
  const taxed = draftOf(lines);
  taxed.lineItems[0].itemPrice!.isTaxFree = false;
  assert.equal(checkDraftAfterAdd(taxed, BUNDLE).ok, false);
  // 한 항목 메모가 빠짐(번호 없음)
  const noMemo = draftOf(lines);
  noMemo.lineItems[1].memo = "";
  noMemo.lineItems[1].item = { code: "" };
  assert.equal(checkDraftAfterAdd(noMemo, BUNDLE).ok, false);
  assert.match(checkDraftAfterAdd(noMemo, BUNDLE).detail, /memo=no$/);
  // 매장 자동 할인이 붙어 합계가 다름
  assert.equal(checkDraftAfterAdd(draftOf(lines, 160000), BUNDLE).ok, false);
  // 다른 상품이 하나 더 담김
  const extra = draftOf(lines);
  extra.lineItems.push({ key: "x", quantity: 1 });
  assert.equal(checkDraftAfterAdd(extra, BUNDLE).ok, false);
  // key 를 안 돌려줘도 담은 순서로 확인
  const noKey = draftOf(lines);
  noKey.lineItems.forEach((l) => (l.key = ""));
  assert.equal(checkDraftAfterAdd(noKey, BUNDLE).ok, true);
  // 순서가 바뀌어도 단가·면세·수량으로 확인한다
  const swapped = draftOf([lines[1], lines[0]]);
  assert.equal(checkDraftAfterAdd(swapped, BUNDLE).ok, true);
  // 합계가 같아도 항목의 단가·면세를 확인하지 못하면 멈춘다.
  const unknown = draftOf(lines);
  unknown.lineItems.forEach((l) => delete l.itemPrice);
  assert.equal(checkDraftAfterAdd(unknown, BUNDLE).ok, false);
  unknown.price!.orderPriceValue = 0;
  assert.equal(checkDraftAfterAdd(unknown, BUNDLE).ok, false);
});

test("POS가 80,000원 두 줄을 한 줄로 합쳐도 요청 번호·단가·면세·수량이 일치하면 통과", () => {
  const [first, , third] = buildLineItems(EQUAL_PRICES);
  const merged = () => draftOf([{ ...first, quantity: 2 }, third]);
  assert.deepEqual(checkDraftAfterAdd(merged(), EQUAL_PRICES), {
    ok: true,
    settled: true,
    detail: "n=2/3 items=80000x2,100000x1 total=260000 taxFree=true,true memo=ok",
  });

  const foreign = merged();
  foreign.lineItems[0].item = { code: "STIZ:S-482194" };
  assert.equal(checkDraftAfterAdd(foreign, EQUAL_PRICES).ok, false);
  const missingTax = merged();
  delete missingTax.lineItems[0].itemPrice!.isTaxFree;
  assert.equal(checkDraftAfterAdd(missingTax, EQUAL_PRICES).ok, false);
  const wrongQuantity = merged();
  wrongQuantity.lineItems[0].quantity = 1;
  wrongQuantity.lineItems[0].itemPrice!.priceValue = 160000;
  assert.equal(checkDraftAfterAdd(wrongQuantity, EQUAL_PRICES).ok, false);
  const discount = { ...merged(), discounts: [{ id: "auto" }] };
  assert.equal(checkDraftAfterAdd(discount, EQUAL_PRICES).ok, false);
});

test("담은 뒤 확인(단건 회귀): detail 모양·판단이 예전과 같다", () => {
  const [line] = buildLineItems(SINGLE);
  const c = checkDraftAfterAdd(draftOf([line]), SINGLE);
  assert.equal(c.ok, true);
  assert.equal(c.detail, "n=1 item=180000x1 unit=1 total=180000 taxFree=true memo=ok");
});

// ── 결제 흐름(가짜 POS: 담을 때마다 항목이 «쌓인다») ──

function fakePos(readback?: (lines: DraftLineItemInput[]) => DraftOrderLike) {
  const log: string[] = [];
  const store = new Map<string, string>();
  let lines: DraftLineItemInput[] = [];
  const sdk: PosSdkLike = {
    draftOrder: {
      async get() {
        log.push("draft.get");
        return lines.length === 0 ? { lineItems: [] } : readback ? readback(lines) : draftOf(lines);
      },
      async clear() {
        log.push("draft.clear");
        lines = [];
      },
      async addLineItem(item: DraftLineItemInput) {
        log.push(`draft.add:${item.key}:${item.itemPrice.priceValue}`);
        lines = [...lines, item];
        return { lineItems: [], price: { orderPriceValue: 0 } };
      },
      async startPayment() {
        log.push("draft.startPayment");
      },
    },
    order: { async getOrder(id: string) { return { id }; } },
    payment: {
      async getPayment(id: string) { return { id, orderId: "o" }; },
      async cancel() { /* 쓰지 않음 */ },
    },
    toast: { success: (p) => log.push(`toast:${p.message}`), warn: (p) => log.push(`warn:${p.message}`), error: (p) => log.push(`error:${p.message}`) },
    alert: { open: (p) => log.push(`alert:${p.message}`) },
    storage: { async get(k) { return store.get(k); }, async set(k, v) { store.set(k, v); } },
  };
  return { sdk, log };
}

function api(claimed: ChargeRequest) {
  const reports: { id: string; body: ReportBody }[] = [];
  const a = {
    async claim() { return { ok: true, data: claimed } as ApiResult<ChargeRequest>; },
    async chargeUnpaid() { return { ok: true, data: claimed } as ApiResult<ChargeRequest>; },
    async startCheck() { return { ok: true as const, data: true as const }; },
    async report(id: string, body: ReportBody) { reports.push({ id, body }); return { ok: true as const, data: "SENT" }; },
  } as unknown as ServerApi;
  return { api: a, reports };
}

test("결제 흐름(묶음): 항목 2개를 차례로 담고, 다시 읽어 확인한 뒤 결제창 1번", async () => {
  const { sdk, log } = fakePos();
  const { api: a, reports } = api(BUNDLE);
  const flow = createChargeFlow({ sdk, api: a, now: () => NOW, sleep: async () => undefined });
  assert.equal(await flow.startCharge(BUNDLE), "started");
  assert.deepEqual(log, [
    "draft.get", "draft.get", "draft.clear",
    "draft.add:stiz-S-482193:140000", "draft.add:stiz-S-482193-2:30000",
    "draft.get", "draft.startPayment",
  ]);
  assert.equal(reports.length, 0);
});

test("결제 흐름(묶음): POS가 같은 단가를 합쳐도 실제 결제 시작 호출까지 진행", async () => {
  const { sdk, log } = fakePos(([first, , third]) => draftOf([{ ...first, quantity: 2 }, third]));
  const { api: a, reports } = api(EQUAL_PRICES);
  const flow = createChargeFlow({ sdk, api: a, now: () => NOW, sleep: async () => undefined });
  assert.equal(await flow.startCharge(EQUAL_PRICES), "started");
  assert.equal(log.filter((line) => line === "draft.startPayment").length, 1);
  assert.equal(reports.length, 0);
});

test("결제 흐름(묶음): 담긴 결과가 하나 모자라면 비우고 멈춤 + 서버에 실제 값(n=1/2) 보고", async () => {
  const { sdk, log } = fakePos((lines) => draftOf(lines.slice(0, 1)));
  const { api: a, reports } = api(BUNDLE);
  const flow = createChargeFlow({ sdk, api: a, now: () => NOW, sleep: async () => undefined });
  assert.equal(await flow.startCharge(BUNDLE), "invalid");
  assert.ok(!log.includes("draft.startPayment"));
  assert.equal(log.filter((l) => l === "draft.clear").length, 2, "담기 전 1번 + 멈출 때 1번");
  assert.equal(reports[0].body.event, "start_failed");
  assert.match(String(reports[0].body.reason), /^draft_mismatch n=1\/2 /);
});

test("결제 흐름(묶음): 서버 항목 합계가 요청 금액과 다르면 담지도 않는다", async () => {
  const wrong = { ...BUNDLE, items: [BUNDLE.items![0], { ...BUNDLE.items![1], amount: 20000, taxFreeAmount: 20000 }] };
  const { sdk, log } = fakePos();
  const { api: a, reports } = api(wrong);
  const flow = createChargeFlow({ sdk, api: a, now: () => NOW, sleep: async () => undefined });
  assert.equal(await flow.startCharge(wrong), "invalid");
  assert.ok(!log.some((l) => l.startsWith("draft.add")));
  assert.equal(reports[0].body.event, "start_failed");
});
