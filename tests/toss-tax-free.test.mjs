import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 토스 계약(2026-10-29): 기본 계약은 복합과세라 면세사업자는 결제 요청마다 면세 금액을 넘겨야 한다.
// 빠지면 오류 없이 결제가 되지만 부가세가 잡힌 거래로 기록된다 — 그래서 소스에 박혀 있는지 지킨다.
const FILES = [
    "src/app/payments/[invoiceId]/PaymentCheckoutClient.tsx",
    "src/lib/payments/tossReviewClient.ts",
];

for (const file of FILES) {
    test(`${file}: 결제 요청에 전액 면세(taxFreeAmount = 결제 금액)를 넘긴다`, async () => {
        const source = await readFile(file, "utf8");
        const call = source.slice(source.indexOf("requestPayment({"));
        assert.match(call, /taxFreeAmount:\s*data\.amount\b/);
        assert.match(call, /value:\s*data\.amount\b/);
    });
}
