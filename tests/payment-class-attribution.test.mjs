import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const ledger = readFileSync(new URL("../src/lib/payment-ledger.ts", import.meta.url), "utf8");
const actions = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../prisma/sql/add_g5_payment_class_attribution.sql", import.meta.url), "utf8");

test("payment and invoice class attribution remains nullable for historical fail-closed rows", () => {
  assert.match(schema, /model Payment[\s\S]*?classId\s+String\?/);
  assert.match(schema, /model PaymentInvoice[\s\S]*?classId\s+String\?/);
  assert.doesNotMatch(migration, /UPDATE\s+"(?:Payment|PaymentInvoice)"[\s\S]*SET\s+"classId"/i);
});

test("new invoices copy only the payment's explicit class", () => {
  assert.match(ledger, /p\."classId"/);
  assert.match(ledger, /"classId"\s*=\s*EXCLUDED\."classId"/);
});

test("manual and monthly creation require unambiguous active enrollment attribution", () => {
  assert.match(actions, /"studentId" = \$1 AND "classId" = \$2 AND status = 'ACTIVE'/);
  // 옛 월 일괄 생성(generateMonthlyInvoices·previewMonthlyInvoices)은 2026-11-18 옛 코드 정리 C 로 지웠다(부르는 곳 없음)
  assert.doesNotMatch(actions, /export async function (generateMonthlyInvoices|previewMonthlyInvoices)\b/);
  assert.match(actions, /INSERT INTO "Payment" \([\s\S]*?"classId"/);
});

test("database enforces class and enrollment integrity without exposing billing tables", () => {
  assert.doesNotMatch(migration, /REFERENCES "Enrollment"\("studentId", "classId"\)/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "Payment_classId_fkey"/);
  assert.match(migration, /FOREIGN KEY \("paymentId", "classId"\) REFERENCES "Payment"\(id, "classId"\)/);
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE "Payment" FROM anon, authenticated/);
});
