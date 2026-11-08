// 학부모 «청구·수납» 화면 — 미납 청구에 결제 버튼, 결제가 안 되면 눌리지 않는 버튼 대신 안내.
// 새 결제 로직을 만들지 않고 기존 결제 화면(/payments/[invoiceId])과 기존 판정(getPaymentProviderConfig)을 재사용하는지 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const client = read("../src/app/mypage/payments/PaymentRequestClient.tsx");
const page = read("../src/app/mypage/payments/page.tsx");
const query = read("../src/lib/payments/parent-payment-request.ts");

test("결제 버튼은 기존 결제 화면으로만 연결한다", () => {
  assert.match(client, /href=\{`\/payments\/\$\{encodeURIComponent\(row\.invoiceId!\)\}`\}/);
  assert.match(client, /const canPayOnline = payReady && Boolean\(row\.invoiceId\) && row\.canCheckout;/);
  // 이 화면에서 결제 API 를 직접 부르지 않는다
  assert.doesNotMatch(client, /\/api\/payments\/checkout/);
});

test("결제 가능 판정은 결제 화면과 같은 함수", () => {
  assert.match(page, /getPaymentProviderConfig\(\)\.providerReady/);
});

test("대표 보호자 판정은 마이페이지 홈과 같은 기준(parentId 본인)", () => {
  assert.match(query, /\(s\."parentId" = \$1\) AS "canCheckout"/);
  assert.match(query, /i\.id AS "invoiceId"/);
});

test("결제 불가 안내에는 기존 «입금했어요 알리기» 흐름이 남는다", () => {
  assert.match(client, /지금은 온라인 결제를 쓸 수 없어요/);
  assert.match(client, /입금했어요 알리기/);
});
