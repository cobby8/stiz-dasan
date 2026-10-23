import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const adminAction = readFileSync("src/app/actions/admin.ts", "utf8");
const financeClient = readFileSync("src/app/admin/finance/FinanceClient.tsx", "utf8");
const policySource = readFileSync("src/lib/billing/notification-policy.ts", "utf8");

const policyModule = { exports: {} };
new Function("module", "exports", ts.transpile(policySource, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
}))(policyModule, policyModule.exports);
const { isMonthlyInvoiceNotificationEligible } = policyModule.exports;

test("월 청구 생성은 0원 템플릿을 원장에 만들지 않는다", () => {
  const targetSql = adminAction.slice(
    adminAction.indexOf("const MONTHLY_INVOICE_TARGETS_SQL"),
    adminAction.indexOf("export async function previewMonthlyInvoices"),
  );

  assert.match(targetSql, /WHERE "isActive" = true\s+AND amount > 0/);
});

test("학부모 청구 알림은 0원과 명시적 HELD 건을 제외한다", () => {
  const sendAction = adminAction.slice(
    adminAction.indexOf("export async function sendInvoiceLinksForMonth"),
    adminAction.indexOf("export async function sendUnpaidReminders"),
  );

  assert.match(sendAction, /AND p\.amount > 0/);
  assert.match(sendAction, /command\.status = 'HELD'/);
  assert.match(sendAction, /command\."notificationStatus" = 'HELD'/);
  assert.match(sendAction, /AND i\."sentAt" IS NULL/);
  assert.equal(isMonthlyInvoiceNotificationEligible({ amount: 130000, notificationHeld: false }), true);
  assert.equal(isMonthlyInvoiceNotificationEligible({ amount: 0, notificationHeld: false }), false);
  assert.equal(isMonthlyInvoiceNotificationEligible({ amount: 130000, notificationHeld: true }), false);
});

// 2026-10-06 B안: 학부모 청구 안내는 랠리즈 전담 — "발송 필수" 안내를 "사이트 청구는 장부용" 으로 바꿨다.
test("청구 생성과 알림 발송은 분리하고, 청구 안내는 랠리즈 전담임을 안내한다", () => {
  assert.doesNotMatch(financeClient, /링크 발송 \(필수\)/);
  assert.doesNotMatch(financeClient, /링크 발송이 필수|반드시 링크 발송|반드시 발송해야/);
  const workbench = readFileSync('src/app/admin/finance/prepare/BillingWorkbench.tsx', 'utf8');
  assert.match(workbench, /랠리즈 발행·학부모 전달은 별도로 확인합니다/);
  assert.match(workbench, /사이트 청구/);
  assert.doesNotMatch(workbench, /sendInvoiceLinksForMonth\(|sendUnpaidReminders\(/);
  assert.match(financeClient, /sendInvoiceLinksForMonth\(year, month\)/);
});
