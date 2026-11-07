// 요청 → 주문 항목 변환·메모 형식·금액 검증 실행 테스트
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildLineItem,
  findShortCodeInOrder,
  formatMemo,
  formatWon,
  isValidShortCode,
  itemTitleFor,
  notificationMessage,
  parseMemo,
  validateForPos,
} from "../src/core/order.ts";
import type { ChargeRequest } from "../src/core/contract.ts";

const NOW = Date.parse("2026-11-07T10:00:00+09:00");

function req(over: Partial<ChargeRequest> = {}): ChargeRequest {
  return {
    id: "req-1",
    shortCode: "S-4821",
    studentName: "김○○",
    title: "수강료(11월)",
    amount: 100000,
    taxFreeAmount: 100000,
    expiresAt: "2026-11-07T10:30:00+09:00",
    status: "PENDING",
    ...over,
  };
}

test("메모 형식은 STIZ:S-4821", () => {
  assert.equal(formatMemo("S-4821"), "STIZ:S-4821");
  assert.throws(() => formatMemo("4821"));
  assert.throws(() => formatMemo("S-48"));
  assert.ok(isValidShortCode("S-482100"));
  assert.ok(!isValidShortCode("S-4821000"));
});

test("메모 파싱: 앞뒤 글자가 있어도 번호만 뽑고, 7자리 이상·소문자는 무시", () => {
  assert.equal(parseMemo("STIZ:S-4821"), "S-4821");
  assert.equal(parseMemo("요청 STIZ:S-4821 김"), "S-4821");
  assert.equal(parseMemo("STIZ:S-1234567"), null);
  assert.equal(parseMemo("stiz:s-4821"), null);
  assert.equal(parseMemo(""), null);
  assert.equal(parseMemo(undefined), null);
});

test("주문 항목 변환: 미등록 상품(id 0)·면세·금액·메모·수량 잠금", () => {
  const li = buildLineItem(req());
  assert.equal(li.item.id, 0);
  assert.equal(li.item.title, "수강료(11월)");
  assert.equal(li.item.type, "ITEM");
  assert.equal(li.item.code, "STIZ:S-4821");
  assert.equal(li.itemPrice.isTaxFree, true);
  assert.equal(li.itemPrice.priceValue, 100000);
  assert.equal(li.itemPrice.priceType, "FIXED");
  assert.equal(li.quantity, 1);
  assert.equal(li.memo, "STIZ:S-4821");
  assert.equal(li.diningOption, "HERE");
  assert.deepEqual(li.discount, []);
  assert.deepEqual(li.optionChoices, []);
  assert.deepEqual(li.metadata, { disableMemoEdit: true, disableOptionEdit: true, disableQuantityEdit: true });
  assert.equal(li.key, "stiz-S-4821");
});

test("상품명: 비면 «수강료», 40자 넘으면 자름", () => {
  assert.equal(itemTitleFor({ title: "" }), "수강료");
  assert.equal(itemTitleFor({ title: "  " }), "수강료");
  assert.equal(itemTitleFor({ title: "가".repeat(50) }).length, 40);
});

test("검증: 정상 요청은 통과", () => {
  assert.deepEqual(validateForPos(req(), NOW), { ok: true });
  assert.deepEqual(validateForPos(req({ expiresAt: null }), NOW), { ok: true });
});

test("검증: 면세 금액이 금액과 다르거나 비면 막는다(과세로 잘못 결제 방지)", () => {
  assert.equal(validateForPos(req({ taxFreeAmount: 0 }), NOW).ok, false);
  assert.equal(validateForPos(req({ taxFreeAmount: 90000 }), NOW).ok, false);
  assert.equal(validateForPos(req({ taxFreeAmount: Number.NaN }), NOW).ok, false);
});

test("검증: 금액 0·음수·소수·상한 초과·번호 형식 오류·만료는 막는다", () => {
  for (const amount of [0, -1000, 1000.5, 5_000_001, Number.NaN]) {
    assert.equal(validateForPos(req({ amount, taxFreeAmount: amount }), NOW).ok, false, String(amount));
  }
  assert.equal(validateForPos(req({ amount: 5_000_000, taxFreeAmount: 5_000_000 }), NOW).ok, true);
  assert.equal(validateForPos(req({ shortCode: "X-1" }), NOW).ok, false);
  // 만료 경계: 정확히 그 시각이면 만료
  assert.equal(validateForPos(req({ expiresAt: "2026-11-07T10:00:00+09:00" }), NOW).ok, false);
  assert.equal(validateForPos(req({ expiresAt: "2026-11-07T01:00:01Z" }), NOW).ok, true);
});

test("원 표시: 기기 언어와 무관하게 쉼표", () => {
  assert.equal(formatWon(100000), "100,000원");
  assert.equal(formatWon(1000), "1,000원");
  assert.equal(formatWon(999), "999원");
  assert.equal(formatWon(1234567), "1,234,567원");
  assert.equal(formatWon(-5000), "-5,000원");
});

test("알림 문구", () => {
  assert.equal(notificationMessage(req()), "김○○ 수강료(11월) 100,000원 현장 결제 요청 (S-4821)");
});

test("결제된 주문에서 번호 찾기: 항목 메모 → 상품 코드 → 주문 메모", () => {
  assert.equal(findShortCodeInOrder({ id: "o", lineItems: [{ memo: "STIZ:S-1111" }] }), "S-1111");
  assert.equal(findShortCodeInOrder({ id: "o", lineItems: [{ memo: "", item: { code: "STIZ:S-2222" } }] }), "S-2222");
  assert.equal(findShortCodeInOrder({ id: "o", lineItems: [], memo: "STIZ:S-3333" }), "S-3333");
  assert.equal(findShortCodeInOrder({ id: "o", lineItems: [{ memo: "아메리카노" }] }), null);
  assert.equal(findShortCodeInOrder(null), null);
});
