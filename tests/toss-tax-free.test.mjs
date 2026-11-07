import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 토스 계약(2026-10-29): 기본 계약은 복합과세라 면세사업자는 결제 요청마다 면세 금액을 넘겨야 한다.
// 빠지면 오류 없이 결제가 되지만 부가세가 잡힌 거래로 기록된다 — 그래서 소스에 박혀 있는지 지킨다.
// 셔틀비도 면세(원장 결정 10-29). 과세 품목이 생기면 taxFreeAmountFor 와 이 테스트를 같이 고친다.
const { taxFreeAmountFor, describeTaxFreeMismatch } = await loadTsModule("src/lib/payments/taxFree.ts");

test("면세 금액 = 결제 금액 전액", () => {
    assert.equal(taxFreeAmountFor(150000), 150000);
    assert.equal(taxFreeAmountFor(1000), 1000);
});

test("승인 응답이 전액 면세면 경고 없음", () => {
    assert.equal(describeTaxFreeMismatch({ totalAmount: 150000, taxFreeAmount: 150000, suppliedAmount: 0, vat: 0 }), null);
});

test("승인 응답에 부가세가 잡히면 경고(복합과세로 처리된 경우)", () => {
    // 토스 문서 예: 면세 0 이면 vat = 10000/11 반올림 = 909, 공급가액 9091
    const warning = describeTaxFreeMismatch({ totalAmount: 10000, taxFreeAmount: 0, suppliedAmount: 9091, vat: 909 });
    assert.match(warning, /면세로 처리되지 않았습니다/);
    assert.match(warning, /vat=909/);
});

test("승인 응답에 taxFreeAmount 가 아예 없으면 경고", () => {
    assert.match(describeTaxFreeMismatch({ totalAmount: 10000 }), /taxFreeAmount=없음/);
});

test("금액을 못 읽으면 판단하지 않는다(다른 검증이 막는다)", () => {
    assert.equal(describeTaxFreeMismatch({}), null);
});

const REQUEST_FILES = [
    "src/app/payments/[invoiceId]/PaymentCheckoutClient.tsx",
    "src/lib/payments/tossReviewClient.ts",
];

for (const file of REQUEST_FILES) {
    test(`${file}: 결제 요청에 면세 금액(taxFreeAmountFor(결제 금액))을 넘긴다`, async () => {
        const source = await readFile(file, "utf8");
        const call = source.slice(source.indexOf("requestPayment({"));
        assert.match(call, /taxFreeAmount:\s*taxFreeAmountFor\(data\.amount\)/);
        assert.match(call, /value:\s*data\.amount\b/);
    });
}

// 승인 쪽: 청구서 결제(승인·복구·웹훅 공통 마무리)와 심사용 결제 승인이 면세 확인을 부른다.
const CONFIRM_FILES = [
    "src/lib/payment-ledger.ts",
    "src/app/payments/review/success/page.tsx",
];

for (const file of CONFIRM_FILES) {
    test(`${file}: 승인 응답의 면세 처리를 확인해 경고를 남긴다`, async () => {
        const source = await readFile(file, "utf8");
        assert.match(source, /import \{ describeTaxFreeMismatch \} from "@\/lib\/payments\/taxFree"/);
        assert.match(source, /describeTaxFreeMismatch\((input\.payment|data)\)/);
        assert.match(source, /console\.warn\(`\[toss-tax-free\]/);
    });
}

test("payment-ledger: 면세 확인은 공통 마무리 함수(finalizeVerifiedTossPayment) 안에 있다", async () => {
    const source = await readFile("src/lib/payment-ledger.ts", "utf8");
    const start = source.indexOf("async function finalizeVerifiedTossPayment(");
    const body = source.slice(start, source.indexOf("prisma.$transaction", start));
    assert.match(body, /describeTaxFreeMismatch\(input\.payment\)/);
});
