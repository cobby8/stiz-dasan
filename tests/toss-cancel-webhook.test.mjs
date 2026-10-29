import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-10-29 실결제 시험에서 상점관리자 취소 알림이 TOSS_PAYMENT_NOT_VERIFIED 로 버려져
// 청구서가 계속 "납부 완료"로 남았다. 전액 취소는 토스 재조회로 확인한 뒤 환불로 반영한다.
const { classifyTossCancel } = await loadTsModule("src/lib/payments/tossCancel.ts");

const tx = { orderId: "ord-1", amount: 1000 };
const base = { orderId: "ord-1", paymentKey: "pk-1", totalAmount: 1000 };

test("전액 취소(CANCELED, 잔액 0)는 FULL_CANCEL", () => {
    assert.deepEqual(classifyTossCancel({ ...base, status: "CANCELED", balanceAmount: 0 }, tx, "pk-1"), { kind: "FULL_CANCEL" });
});

test("잔액이 빠진 취소 응답은 전액 취소로 단정하지 않고 확인 필요로 돌린다", () => {
    assert.equal(classifyTossCancel({ ...base, status: "CANCELED" }, tx, null).kind, "PARTIAL_CANCEL");
});

test("부분 취소는 자동 반영하지 않고 취소 금액만 알린다", () => {
    assert.deepEqual(classifyTossCancel({ ...base, status: "PARTIAL_CANCELED", balanceAmount: 600 }, tx, "pk-1"), { kind: "PARTIAL_CANCEL", canceledAmount: 400 });
});

test("주문·결제키·금액이 다르거나 결제 완료 상태면 취소로 보지 않는다", () => {
    assert.equal(classifyTossCancel({ ...base, status: "DONE", balanceAmount: 1000 }, tx, "pk-1").kind, "NOT_CANCEL");
    assert.equal(classifyTossCancel({ ...base, orderId: "other", status: "CANCELED", balanceAmount: 0 }, tx, "pk-1").kind, "NOT_CANCEL");
    assert.equal(classifyTossCancel({ ...base, status: "CANCELED", balanceAmount: 0 }, tx, "pk-OTHER").kind, "NOT_CANCEL");
    assert.equal(classifyTossCancel({ ...base, totalAmount: 999, status: "CANCELED", balanceAmount: 0 }, tx, null).kind, "NOT_CANCEL");
    assert.equal(classifyTossCancel(null, tx, null).kind, "NOT_CANCEL");
});

test("웹훅 처리는 토스 재조회 결과(verified)로 취소를 판정하고 납부 완료 거래만 환불로 바꾼다", async () => {
    const source = await readFile("src/lib/payment-ledger.ts", "utf8");
    assert.match(source, /classifyTossCancel\(verified, tx, paymentKey\)/);
    assert.match(source, /current\.status !== "DONE" \|\| current\.paymentStatus !== "PAID"/);
    assert.match(source, /SET status = 'REFUNDED', "paidDate" = NULL[^`]*WHERE id = \$1 AND status = 'PAID'/);
});
