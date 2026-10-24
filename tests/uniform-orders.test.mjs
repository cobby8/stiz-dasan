import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const source = fs.readFileSync(path.resolve("src/lib/uniformOrders.ts"), "utf8")
  .replace(/import[^;]+;\s*/g, "")
  .replace(/export /g, "")
  .replace(/type UniformOrderStatus[\s\S]*?;\n\n/, "")
  .replace(/type UniformOrderRow[\s\S]*?;\n\n/, "");
// (2026-10-06) 시트 직접 읽기 함수 readUniformOrderSheet 를 지워서(호출처 0), 그 함수를 잘라내던 replace 도 뺐다.
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const moduleBox = { exports: {} };
new Function("module", "exports", `${js}; module.exports = { parseUniformOrderRows };`)(moduleBox, moduleBox.exports);
const { parseUniformOrderRows } = moduleBox.exports;

const header = Array.from({ length: 15 }, () => "");
function row({ submitted = "2026. 8. 26", order = "", paid = "", amount = "", arrived = "" } = {}) {
  const value = Array.from({ length: 15 }, () => "");
  value[0] = submitted; value[1] = "2호점"; value[3] = "테스트학생"; value[6] = "XS"; value[7] = "XS";
  value[10] = order; value[11] = paid; value[12] = amount; value[14] = arrived;
  return value;
}

test("입금 근거가 없는 최신 신청은 입금 확인으로 분류한다", () => {
  assert.equal(parseUniformOrderRows([header, row()])[0].status, "PAYMENT_REVIEW");
});

test("발주일과 도착일을 단계 상태로 우선 반영한다", () => {
  assert.equal(parseUniformOrderRows([header, row({ order: "260830", amount: "90000" })])[0].status, "ORDERED");
  assert.equal(parseUniformOrderRows([header, row({ order: "260830", arrived: "260901" })])[0].status, "ARRIVED");
});

test("오래된 미처리 응답은 신규 주문이 아니라 과거자료 확인으로 분리한다", () => {
  assert.equal(parseUniformOrderRows([header, row({ submitted: "2025. 8. 1" })])[0].status, "LEGACY_REVIEW");
});
