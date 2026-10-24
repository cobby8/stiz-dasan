import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const contract = readFileSync(new URL("../docs/cafe24-payment-bridge-contract.md", import.meta.url), "utf8");
const cafe24Lib = readFileSync(new URL("../src/lib/cafe24-payment.ts", import.meta.url), "utf8");
const ledger = readFileSync(new URL("../src/lib/payment-ledger.ts", import.meta.url), "utf8");
const checkoutRoute = readFileSync(new URL("../src/app/api/payments/checkout/route.ts", import.meta.url), "utf8");
const webhookRoute = readFileSync(new URL("../src/app/api/payments/cafe24/webhook/route.ts", import.meta.url), "utf8");
const paymentPreflight = readFileSync(new URL("../scripts/payment-preflight.mjs", import.meta.url), "utf8");
const releasePreflight = readFileSync(new URL("../scripts/release-preflight.mjs", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("본사 카페24 브리지 문서는 다산점 코드의 요청 계약과 같은 값을 설명한다", () => {
  for (const token of [
    "PAYMENT_PROVIDER=CAFE24_BRIDGE",
    "CAFE24_PAYMENT_BRIDGE_URL",
    "STIZ_PARTNER_SECRET",
    "NEXT_PUBLIC_SITE_URL",
    "X-STIZ-Partner",
    "X-STIZ-Timestamp",
    "X-STIZ-Signature",
    "partnerRequestId",
    "checkoutUrl",
    "paymentUrl",
    "redirectUrl",
  ]) {
    assert.match(contract, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(cafe24Lib, /DEFAULT_CAFE24_PAYMENT_API_URL = "https:\/\/custom\.stiz\.kr\/api\/payments\/cafe24\/checkout"/);
  assert.match(cafe24Lib, /STIZ_PAYMENT_PARTNER_ID = "dasan"/);
  assert.match(cafe24Lib, /X-STIZ-Partner/);
  assert.match(cafe24Lib, /X-STIZ-Purpose/);
  assert.match(cafe24Lib, /X-STIZ-Timestamp/);
  assert.match(cafe24Lib, /X-STIZ-Signature/);
  assert.match(cafe24Lib, /canonicalCafe24PaymentJson/);
});

test("본사 카페24 웹훅은 서명, 주문번호, 금액을 모두 맞춰야 납부 완료 처리한다", () => {
  assert.match(contract, /https:\/\/www\.stiz-dasan\.kr\/api\/payments\/cafe24\/webhook/);
  assert.match(contract, /금액이 저장 금액과 같을 때만 납부 완료/);
  assert.match(contract, /CAFE24_AMOUNT_MISMATCH/);
  assert.match(webhookRoute, /verifyCafe24PaymentWebhook/);
  assert.match(webhookRoute, /64 \* 1024/);
  assert.match(ledger, /recordCafe24PaymentWebhook/);
  assert.match(ledger, /CAFE24_AMOUNT_MISMATCH/);
  assert.match(ledger, /markPaymentPaid/);
  assert.match(ledger, /provider: CAFE24_PAYMENT_PROVIDER/);
});

test("결제 점검 스크립트는 토스와 카페24 브리지를 결제 제공자별로 나눠 검사한다", () => {
  assert.match(paymentPreflight, /provider === "CAFE24_BRIDGE"/);
  assert.match(paymentPreflight, /CAFE24_PAYMENT_BRIDGE_URL/);
  assert.match(paymentPreflight, /STIZ_CAFE24_PAYMENT_API_URL/);
  assert.match(paymentPreflight, /CAFE24_PAYMENT_BRIDGE_SECRET/);
  assert.match(paymentPreflight, /STIZ_PARTNER_SECRET/);

  assert.match(releasePreflight, /function requirePaymentEnvironment/);
  assert.match(releasePreflight, /selectedPaymentProvider/);
  assert.match(releasePreflight, /PAYMENT_PROVIDER/);
  assert.match(releasePreflight, /CAFE24_PAYMENT_BRIDGE_URL/);
  assert.match(releasePreflight, /STIZ_CAFE24_PAYMENT_API_URL/);
  assert.match(releasePreflight, /TOSS_PAYMENTS_SECRET_KEY/);
  assert.match(releasePreflight, /NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY/);
});

test("README는 상세 계약 문서를 연결하고 결제 API는 제공자 오류를 부모 화면으로 돌려준다", () => {
  assert.match(readme, /docs\/cafe24-payment-bridge-contract\.md/);
  assert.match(checkoutRoute, /providerError/);
  assert.match(checkoutRoute, /result\.retryable \? 503 : 502/);
});
