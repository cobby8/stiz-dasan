import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const ledger = await readFile(new URL("../src/lib/payment-ledger.ts", import.meta.url), "utf8");
const paymentPage = await readFile(new URL("../src/app/payments/[invoiceId]/page.tsx", import.meta.url), "utf8");
const checkout = await readFile(new URL("../src/app/api/payments/checkout/route.ts", import.meta.url), "utf8");
const confirm = await readFile(new URL("../src/app/api/payments/toss/confirm/route.ts", import.meta.url), "utf8");
// 결제 권한 판정 한 곳(2026-11-13 f8) — 청구서 조회·결제 시작·승인 직전이 같이 쓴다
const payerAccess = await readFile(new URL("../src/lib/payments/payerAccess.ts", import.meta.url), "utf8");

test("활성화된 보호자는 인증 sub가 연결된 자신의 청구서만 조회한다", () => {
  // 청구서 조회는 로그인 sub → 앱 계정 → «그 학생과 연결»(payerAccess) 순서로 본다
  assert.match(payerAccess, /u\."authUserId" = \$1/);
  assert.match(ledger, /const payer = await resolveLinkedPayer\(prisma, owner\.authUserId, \[row\.studentId\]\);\s*if \(!payer\) return null;/);
  assert.match(paymentPage, /authUserId: user\.id, email: user\.email \?\? null/);
});

test("checkout과 confirm도 같은 sub 우선 소유권 계약을 전달한다", () => {
  assert.match(checkout, /owner: \{ authUserId: user\.id, email: user\.email \?\? null \}/);
  assert.match(confirm, /owner: \{ authUserId: user\.id, email: user\.email \?\? null \}/);
  // 승인: 주문을 만든 계정(sub) 확인 1곳 + 승인 직전 연결 재확인(payerAccess)
  assert.equal((ledger.match(/u\."authUserId" = \$2/g) ?? []).length, 1);
  assert.match(ledger, /const confirmPayer = await resolveLinkedPayer\(\s*prisma,\s*input\.owner\.authUserId,/);
});

test("기존 보호자 fallback도 이메일이 아니라 동일한 인증 sub만 허용한다", () => {
  assert.equal((ledger.match(/u\."authUserId" IS NULL AND u\.id = \$2/g) ?? []).length, 1);
  assert.match(payerAccess, /u\."authUserId" IS NULL AND u\.id = \$1/);
  assert.doesNotMatch(payerAccess, /email\) = LOWER/);
  assert.doesNotMatch(ledger, /LOWER\(u\.email\) = LOWER\(\$3\)/);
});
