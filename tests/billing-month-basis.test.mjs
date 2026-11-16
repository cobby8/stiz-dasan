// 청구 월 기준(2026-11-16): 12월 청구(year=2026, month=12, 기한 11/30)가 관리자 수납 11월에 섞였다 — 청구 월 우선, 빈 것만 기한으로
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const m = await loadTsModule("src/lib/billing/billing-month-sql.ts");

test("조건 모양: 청구 월이 있으면 그것만, 둘 중 하나라도 비었을 때만 기한 범위", () => {
  const sql = m.billingMonthMatchSql("p", { year: "$1", month: "$2", dueStart: "$3", dueEnd: "$4" }).replace(/\s+/g, " ");
  assert.equal(sql, `((p.year = $1 AND p.month = $2) OR ((p.year IS NULL OR p.month IS NULL) AND p."dueDate" >= $3::timestamp AND p."dueDate" < $4::timestamp))`);
  assert.match(m.billingMonthMatchSql("", { year: "$1", month: "$2", dueStart: "$3", dueEnd: "$4" }), /^\(\(year = \$1/);
});

test("관리자 수납 목록·요약·청구서 정리·안내 발송이 모두 청구 월 우선이다(기한만으로 달을 고르는 곳이 없다)", () => {
  const queries = readFileSync("src/lib/queries.ts", "utf8");
  const list = queries.slice(queries.indexOf("export const getPayments = cache"), queries.indexOf("export const getPayments = cache") + 1500);
  assert.match(list, /billingMonthMatchSql\("p", \{ year: "\$1", month: "\$2", dueStart: "\$3", dueEnd: "\$4" \}\)/);
  assert.match(list, /params\.push\(year, month, startStr, endStr\)/);
  const summary = queries.slice(queries.indexOf("export const getPaymentSummary = cache"), queries.indexOf("export const getPaymentSummary = cache") + 1200);
  assert.match(summary, /billingMonthMatchSql\(""/);
  assert.doesNotMatch(summary, /WHERE "dueDate" >= \$1/);
  for (const file of ["src/lib/payment-ledger.ts", "src/app/actions/admin.ts"]) {
    const src = readFileSync(file, "utf8");
    assert.doesNotMatch(src, /OR \(p\."dueDate" >= \$3::timestamp/, `${file}: 청구 월이 있는 청구를 기한으로 다시 끌어오지 않는다`);
  }
});
