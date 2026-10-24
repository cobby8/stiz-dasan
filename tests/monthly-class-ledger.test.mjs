import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile("src/lib/billing/monthly-class-ledger.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { buildMonthlyClassLedger } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const enrollment = (overrides = {}) => ({
  studentId: "student-a", studentName: "테스트 학생", classId: "class-a", className: "가반", status: "ACTIVE", ...overrides,
});
const payment = (overrides = {}) => ({
  id: "payment-a", studentId: "student-a", studentName: "테스트 학생", classId: "class-a", className: "가반",
  year: 2026, month: 9, type: "MONTHLY", amount: 100000, status: "PAID", ...overrides,
});
const build = (overrides = {}) => buildMonthlyClassLedger({
  year: 2026, month: 9, enrollments: [], payments: [], ...overrides,
});

test("장부가 비어 있으면 확정 청구액이 아닌 알려진 기록 합계만 0이다", () => {
  const result = build();
  assert.deepEqual(result.rows, []);
  assert.equal(result.summary.knownPaidAmount, 0);
  assert.equal(result.amountBasis, "RECORDED_PAYMENTS_ONLY");
  assert.match(result.notice, /최종 청구서가 아니며/);
});

test("동일 학생의 두 반은 별도 행이고 이름이 같아도 학생 ID가 다르면 합치지 않는다", () => {
  const result = build({ enrollments: [enrollment(), enrollment({ classId: "class-b" }), enrollment({ studentId: "student-b" })] });
  assert.equal(result.rows.length, 3);
  assert.equal(result.summary.studentCount, 2);
  assert.equal(result.summary.classRowCount, 3);
  assert.equal(result.rows[0].rowKey, JSON.stringify(["student-a", 2026, 9, "class-a"]));
});

test("기록 없는 현재 수강은 요금 0원이 아니라 미확정이다", () => {
  for (const status of ["ACTIVE", "PAUSED", "WITHDRAWN"]) {
    const row = build({ enrollments: [enrollment({ status })] }).rows[0];
    assert.equal(row.enrollmentStatus, status);
    assert.match(row.enrollmentNotice, /수강 확정 자료가 아닙니다/);
    assert.equal(row.billedAmount, null);
    assert.equal(row.paidAmount, null);
    assert.equal(row.outstandingAmount, null);
    assert.equal(row.canceledAmount, null);
    assert.equal(row.breakdown.MONTHLY.billedAmount, null);
    assert.equal(row.reviewReasons.length, 2);
  }
});

test("반별 청구·납부·미납·취소 및 월수강료·셔틀·유니폼을 구분한다", () => {
  const result = build({ enrollments: [enrollment()], payments: [
    payment(), payment({ id: "pending", amount: 20000, status: "PENDING", type: "SHUTTLE" }),
    payment({ id: "overdue", amount: 30000, status: "OVERDUE", type: "UNIFORM" }),
    payment({ id: "canceled", amount: 50000, status: "CANCELED" }),
    payment({ id: "other", amount: 1000, status: "PAID", type: "OTHER" }),
  ] });
  const row = result.rows[0];
  assert.equal(row.billedAmount, 151000);
  assert.equal(row.paidAmount, 101000);
  assert.equal(row.outstandingAmount, 50000);
  assert.equal(row.canceledAmount, 50000);
  assert.equal(row.breakdown.MONTHLY.billedAmount, 100000);
  assert.equal(row.breakdown.SHUTTLE.outstandingAmount, 20000);
  assert.equal(row.breakdown.OTHER.billedAmount, 31000);
  assert.deepEqual(row.breakdown.OTHER.paymentTypes, ["UNIFORM", "OTHER"]);
  assert.equal(result.summary.knownBilledAmount, 151000);
  assert.equal(result.summary.knownPaidAmount, 101000);
  assert.equal(result.summary.knownOutstandingAmount, 50000);
  assert.equal(result.summary.knownCanceledAmount, 50000);
});

test("반 미지정 납부는 수강 반이 하나여도 별도 행에만 귀속한다", () => {
  const result = build({ enrollments: [enrollment()], payments: [payment({ classId: null, className: null })] });
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find((row) => row.classId === "class-a").paidAmount, null);
  const unassigned = result.rows.find((row) => row.classId === null);
  assert.equal(unassigned.paidAmount, 100000);
  assert.match(unassigned.reviewReasons.join(" "), /자동 배분하지/);
  assert.equal(result.summary.unassignedPaymentCount, 1);
  assert.equal(result.summary.classRowCount, 1);
});

test("현재 수강이 사라진 과거 반의 납부도 보존한다", () => {
  const row = build({ payments: [payment()] }).rows[0];
  assert.equal(row.classId, "class-a");
  assert.equal(row.enrollmentStatus, null);
  assert.equal(row.paidAmount, 100000);
  assert.match(row.reviewReasons.join(" "), /과거 반/);
});

test("대상 연월의 기록만 포함하며 월 미상 기록을 추정하지 않는다", () => {
  const result = build({ payments: [payment(), payment({ id: "old", month: 8 }), payment({ id: "future", year: 2027 }), payment({ id: "unknown", month: null })] });
  assert.equal(result.summary.paymentCount, 1);
  assert.equal(result.summary.knownPaidAmount, 100000);
});

test("내용이 동일한 중복 납부 ID는 한 번만 계산한다", () => {
  const result = build({ payments: [payment(), { ...payment() }] });
  assert.equal(result.summary.paymentCount, 1);
  assert.equal(result.summary.knownPaidAmount, 100000);
});

test("동일 ID 내용 충돌은 전체 계산을 차단한다", () => {
  for (const conflict of [{ amount: 1 }, { studentId: "different" }, { classId: null }, { status: "PENDING" }, { month: 8 }]) {
    assert.throws(() => build({ payments: [payment(), payment(conflict)] }), /충돌/);
  }
  assert.throws(() => build({ enrollments: [enrollment(), enrollment({ status: "PAUSED" })] }), /충돌/);
});

test("음수·소수·무한·NaN·안전범위 초과와 알 수 없는 상태는 합계에서 제외한다", () => {
  const invalid = [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1];
  const result = build({ payments: [
    payment(), ...invalid.map((amount, index) => payment({ id: `invalid-${index}`, amount })),
    payment({ id: "unknown-status", status: "REFUNDED", amount: 99000 }),
  ] });
  const row = result.rows[0];
  assert.equal(row.paidAmount, 100000);
  assert.equal(result.summary.excludedPaymentCount, 6);
  assert.equal(row.breakdown.MONTHLY.excludedPaymentCount, 6);
  assert.equal(row.payments.filter((item) => item.amount === null).length, 5);
  assert.equal(row.payments.filter((item) => item.includedInTotals).length, 1);
  assert.match(row.reviewReasons.join(" "), /합계에서 제외/);
});

test("모든 기록이 제외되면 행 금액은 0으로 확정하지 않는다", () => {
  const row = build({ payments: [payment({ status: "UNKNOWN" })] }).rows[0];
  assert.equal(row.billedAmount, null);
  assert.equal(row.paidAmount, null);
});

test("유효한 0원 기록과 취소 전용 기록은 원본 기록으로 보존한다", () => {
  const zero = build({ payments: [payment({ amount: 0 })] }).rows[0];
  assert.equal(zero.paidAmount, 0);
  assert.equal(zero.payments[0].includedInTotals, true);
  const canceled = build({ payments: [payment({ status: "CANCELED" })] }).rows[0];
  assert.equal(canceled.billedAmount, 0);
  assert.equal(canceled.canceledAmount, 100000);
});

test("행 합계와 여러 행 총합 모두 안전 정수 초과를 차단한다", () => {
  assert.throws(() => build({ payments: [payment({ amount: Number.MAX_SAFE_INTEGER }), payment({ id: "extra", amount: 1 })] }), /정수 범위/);
  assert.throws(() => build({ payments: [payment({ amount: Number.MAX_SAFE_INTEGER }), payment({ id: "other-class", classId: "class-b", amount: 1 })] }), /정수 범위/);
});

test("연월은 2020~2100과 1~12의 정수만 허용한다", () => {
  for (const year of [2019, 2101, 2026.1, NaN, Infinity]) assert.throws(() => build({ year }), /조회 연도/);
  for (const month of [0, 13, 1.1, NaN, Infinity]) assert.throws(() => build({ month }), /조회 연도/);
  assert.doesNotThrow(() => build({ year: 2020, month: 1 }));
  assert.doesNotThrow(() => build({ year: 2100, month: 12 }));
});

test("셔틀만 있는 경우 월수강료를 계산하지 않고 알 수 없는 유형도 이름을 보존한다", () => {
  const row = build({ payments: [payment({ type: "SHUTTLE", amount: 20000 }), payment({ id: "special", type: "SPECIAL", amount: 3000 })] }).rows[0];
  assert.equal(row.breakdown.MONTHLY.billedAmount, null);
  assert.deepEqual(row.breakdown.OTHER.paymentTypes, ["SPECIAL"]);
  assert.match(row.reviewReasons.join(" "), /알 수 없는 청구 항목/);
});

test("입력을 변경하지 않으며 출력에 연락처 같은 추가 속성을 복사하지 않는다", () => {
  const input = { year: 2026, month: 9, enrollments: [enrollment({ phone: "PRIVATE" })], payments: [payment({ phone: "PRIVATE" })] };
  const before = structuredClone(input);
  const result = buildMonthlyClassLedger(input);
  assert.deepEqual(input, before);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.equal(JSON.stringify(result).includes("phone"), false);
});

test("문자열 연결 시 충돌할 수 있는 식별자도 JSON 행 키로 분리한다", () => {
  const result = build({ enrollments: [enrollment({ studentId: "a|b", classId: "c" }), enrollment({ studentId: "a", classId: "b|c" })] });
  assert.equal(new Set(result.rows.map((row) => row.rowKey)).size, 2);
});
