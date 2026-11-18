import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const admin = readFileSync("src/app/actions/admin.ts", "utf8");
const ui = readFileSync("src/app/admin/finance/FinanceClient.tsx", "utf8");

// 2026-11-18 옛 코드 정리 C: 구형 고정액 월 일괄 생성(generateMonthlyInvoices)·미리보기(previewMonthlyInvoices)와
// 그 전용 SQL(MONTHLY_INVOICE_TARGETS_SQL)은 부르는 곳이 없어 지웠다. 월 청구는 반별 청구 검토표(/admin/finance/prepare)만 쓴다.
test("구형 고정액 월 일괄 생성·미리보기와 전용 SQL 은 없어졌다", () => {
  assert.doesNotMatch(admin, /export async function (generateMonthlyInvoices|previewMonthlyInvoices)\b/);
  assert.doesNotMatch(admin, /const MONTHLY_INVOICE_TARGETS_SQL\b/);
});

test("구형 고정액 생성 입구 대신 반별 청구 검토표로 이동한다", () => {
  assert.doesNotMatch(ui, /handleGenerateInvoices|handleSmartBillingRun|generateMonthlyInvoices\(/);
  assert.match(ui, /\/admin\/finance\/prepare\?month=/);
  const workbench = readFileSync('src/app/admin/finance/prepare/BillingWorkbench.tsx', 'utf8');
  assert.match(workbench, /selectedRows\.some/);
  assert.match(workbench, /hasHardBlock\(row\)/);
});
