import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const ledger = readFileSync(new URL("../src/lib/payment-ledger.ts", import.meta.url), "utf8");
const checkoutRoute = readFileSync(new URL("../src/app/api/payments/checkout/route.ts", import.meta.url), "utf8");
const checkoutClient = readFileSync(
  new URL("../src/app/payments/[invoiceId]/PaymentCheckoutClient.tsx", import.meta.url),
  "utf8",
);
const invoicePage = readFileSync(new URL("../src/app/payments/[invoiceId]/page.tsx", import.meta.url), "utf8");
const successClient = readFileSync(
  new URL("../src/app/payments/success/PaymentSuccessClient.tsx", import.meta.url),
  "utf8",
);
const failPage = readFileSync(new URL("../src/app/payments/fail/page.tsx", import.meta.url), "utf8");
const financeClient = readFileSync(new URL("../src/app/admin/finance/FinanceClient.tsx", import.meta.url), "utf8");
const adminPayload = readFileSync(new URL("../src/lib/adminReadPayloads.ts", import.meta.url), "utf8");
const paymentPreflight = readFileSync(new URL("../scripts/payment-preflight.mjs", import.meta.url), "utf8");
const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");

test("토스 결제 세션은 운영 준비와 결제 가능 상태를 먼저 확인한다", () => {
  assert.match(ledger, /getPaymentProviderPublicStatus/);
  assert.match(ledger, /getSelectedPaymentProvider/);
  assert.match(ledger, /CAFE24_PAYMENT_PROVIDER/);
  assert.match(ledger, /clientKeyConfigured/);
  assert.match(ledger, /secretKeyConfigured/);
  assert.match(ledger, /inferTossKeyMode/);
  assert.match(ledger, /keyPairReady/);
  assert.match(ledger, /siteUrlConfigured/);
  assert.match(ledger, /webhookUrl/);
  assert.match(ledger, /PUBLIC_SITE_URL/);
  assert.match(ledger, /\["REFUNDED", "CANCELED"\]\.includes\(invoice\.paymentStatus\)/);
  assert.match(ledger, /Number\(invoice\.amount\) <= 0/);
  assert.match(ledger, /configurationMissing: true/);
  assert.match(checkoutRoute, /configurationMissing" in result/);
  assert.match(checkoutRoute, /providerError" in result/);
  assert.match(checkoutRoute, /\?\s*503/);
});

test("토스 결제 요청 URL과 고객키는 재사용 가능하고 개인정보를 직접 노출하지 않는다", () => {
  assert.match(ledger, /createHash/);
  assert.match(ledger, /makeTossCustomerKey/);
  assert.match(ledger, /digest\("base64url"\)/);
  assert.match(ledger, /return `stiz_\$\{digest\}`/);
  assert.match(ledger, /config\.provider === CAFE24_PAYMENT_PROVIDER \? "\/payments\/cafe24\/success" : "\/payments\/success"/);
  assert.match(ledger, /makePaymentReturnUrl\(cleanOrigin, "\/payments\/fail", invoice\.invoiceId\)/);
  assert.match(ledger, /searchParams\.set\("invoiceId", invoiceId\)/);
  assert.match(ledger, /AND amount = \$2/);
});

test("토스 승인 처리에는 멱등키와 재시도 보호가 있다", () => {
  assert.match(ledger, /Idempotency-Key/);
  assert.match(ledger, /isUuidLike/);
  assert.match(ledger, /makeUuidFromSeed/);
  assert.match(ledger, /makeTossIdempotencyKey\(tx\.id, input\.orderId\)/);
  assert.match(ledger, /SET status = 'IN_PROGRESS'/);
  assert.match(ledger, /status = CASE WHEN \$6::boolean THEN status ELSE 'FAILED' END/);
  assert.match(ledger, /retryable/);
});

test("학부모 결제 화면은 토스 SDK 결과를 검증하고 안내 화면으로 복귀시킨다", () => {
  assert.match(checkoutClient, /https:\/\/js\.tosspayments\.com\/v2\/standard/);
  assert.match(checkoutClient, /requestPayment/);
  assert.match(checkoutClient, /CARD/);
  assert.match(checkoutClient, /TRANSFER/);
  assert.match(checkoutClient, /data\.orderId/);
  assert.match(checkoutClient, /data\.amount/);
  assert.match(checkoutClient, /data\.successUrl/);
  assert.match(checkoutClient, /data\.failUrl/);
  assert.match(successClient, /api\/payments\/toss\/confirm/);
  assert.match(successClient, /paymentKey/);
  assert.match(successClient, /orderId/);
  assert.match(successClient, /amount/);
  assert.match(successClient, /invoiceId/);
  assert.match(successClient, /MAX_CONFIRM_RETRIES/);
  assert.match(successClient, /retryable/);
  assert.match(successClient, /다시 확인/);
  assert.match(failPage, /params\.invoiceId/);
  assert.match(invoicePage, /PaymentCheckoutClient/);
});

test("학부모 결제 화면은 본사 카페24 결제 링크로 분기할 수 있다", () => {
  assert.match(checkoutClient, /CAFE24_BRIDGE/);
  assert.match(checkoutClient, /checkoutUrl/);
  assert.match(checkoutClient, /window\.location\.assign\(data\.checkoutUrl\)/);
  assert.match(checkoutClient, /본사 카페24 결제창으로 이동합니다/);
  assert.match(invoicePage, /provider=\{providerConfig\.provider\}/);
  assert.match(invoicePage, /providerLabel=\{providerConfig\.providerLabel\}/);
});

test("본사 카페24 결제 브리지는 서명된 요청과 서명된 웹훅만 허용한다", () => {
  assert.match(ledger, /postCafe24PaymentCheckout/);
  assert.match(ledger, /buildCafe24PaymentBridgePayload/);
  assert.match(ledger, /verifyCafe24PaymentWebhook/);
  assert.match(ledger, /recordCafe24PaymentWebhook/);
  assert.match(ledger, /CAFE24_AMOUNT_MISMATCH/);
  assert.match(ledger, /provider:\s*CAFE24_PAYMENT_PROVIDER/);
  assert.match(paymentPreflight, /CAFE24_PAYMENT_BRIDGE_URL/);
  assert.match(paymentPreflight, /STIZ_CAFE24_PAYMENT_API_URL/);
  assert.match(paymentPreflight, /STIZ_PARTNER_SECRET/);
});

test("결제 승인과 웹훅은 청구서 소유권과 중복 처리를 더 좁게 검증한다", () => {
  assert.match(checkoutRoute, /configurationMissing" in result/);
  assert.match(ledger, /invoiceId\?: string \| null/);
  assert.match(ledger, /tx\."invoiceId" = \$3/);
  assert.match(ledger, /amount: Number\(tx\.amount\)/);
  assert.match(ledger, /TOSS_CONFIRM_VERIFICATION_FAILED/);
  assert.match(ledger, /makeTossWebhookEventId/);
  assert.match(ledger, /generated:\$\{digest\}/);
});

test("관리자는 온라인 결제 운영 준비 상태를 개발 메시지 없이 확인한다", () => {
  assert.match(adminPayload, /getPaymentProviderPublicStatus/);
  assert.match(financeClient, /paymentProviderMissing/);
  assert.match(financeClient, /clientKeyConfigured/);
  assert.match(financeClient, /secretKeyConfigured/);
  assert.match(financeClient, /siteUrlConfigured/);
  assert.match(financeClient, /keyPairReady/);
  assert.match(financeClient, /webhookUrl/);
  assert.match(financeClient, /CAFE24_BRIDGE/);
  assert.match(financeClient, /본사 카페24/);
  assert.match(financeClient, /cafe24BridgeReady/);
});

test("관리자는 수납 목록에서 청구서 링크를 바로 열고 복사할 수 있다", () => {
  assert.match(financeClient, /getInvoiceHref/);
  assert.match(financeClient, /toAbsoluteHref/);
  assert.match(financeClient, /navigator\.clipboard\.writeText/);
  assert.match(financeClient, /window\.open/);
});

test("결제 전용 프리플라이트는 비밀값 없이 키 종류와 URL만 점검한다", () => {
  assert.match(packageJson, /"payments:preflight"/);
  assert.match(paymentPreflight, /inferTossKeyMode/);
  assert.match(paymentPreflight, /결제 제공자/);
  assert.match(paymentPreflight, /NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY/);
  assert.match(paymentPreflight, /TOSS_PAYMENTS_SECRET_KEY/);
  assert.match(paymentPreflight, /CAFE24_PAYMENT_BRIDGE_URL/);
  assert.match(paymentPreflight, /NEXT_PUBLIC_SITE_URL/);
  assert.match(paymentPreflight, /DEFAULT_PUBLIC_SITE_URL/);
  assert.match(paymentPreflight, /콜백\/웹훅 등록 주소/);
  assert.match(paymentPreflight, /운영 배포에는 토스 실거래 키가 필요합니다/);
  assert.match(paymentPreflight, /서버키: \$\{secretKey \? "있음" : "없음"\}/);
  assert.doesNotMatch(paymentPreflight, /서버키: \$\{secretKey\}/);
});
