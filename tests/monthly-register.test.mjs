import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile("src/lib/billing/monthly-register.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { MonthlyRegisterError, validateMonthlyRegisterDraft, calculateMonthlyRegister } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const row = (overrides = {}) => ({
  classId: "class-a", status: "ACTIVE", periodStart: "2026-09-01", periodEnd: "2026-09-30",
  baseAmount: 100000, discountAmount: 10000, carryAmount: 5000, prorationAmount: 2000,
  basis: "승인된 수강료 및 차감 근거", ...overrides,
});
const draft = (overrides = {}) => ({
  studentId: "student-a", month: "2026-09", classes: [row()],
  shuttleAmount: 20000, shuttleBasis: "승인된 월 셔틀비", reason: "월 대장 확인", ...overrides,
});
const excludedRow = (status = "PAUSED", overrides = {}) => row({
  status, baseAmount: 0, discountAmount: 0, carryAmount: 0, prorationAmount: 0, ...overrides,
});
const invalid = (value, pattern) => assert.throws(() => validateMonthlyRegisterDraft(value), (error) => {
  assert.ok(error instanceof MonthlyRegisterError);
  assert.equal(error.status, 400);
  if (pattern) assert.match(error.message, pattern);
  return true;
});

test("관리자가 입력한 차감액만 빼고 월 수강료와 셔틀비를 합산한다", () => {
  assert.deepEqual(calculateMonthlyRegister(draft()), {
    tuitionAmount: 83000, shuttleAmount: 20000, totalAmount: 103000,
    rows: [{ classId: "class-a", amount: 83000 }],
  });
});

test("반 순서·문자열 여백·-0을 정규화하고 입력과 추가 속성은 보존하지 않는다", () => {
  const input = draft({
    studentId: " student-a ", month: " 2026-09 ", reason: " 월 대장 확인 ", shuttleBasis: " 사용하지 않음 ", shuttleAmount: -0,
    privateField: "PRIVATE",
    classes: [row({ classId: " class-b ", basis: " 승인 근거 ", extra: "PRIVATE" }), row({ classId: "class-a" })],
  });
  const before = structuredClone(input);
  const result = validateMonthlyRegisterDraft(input);
  assert.deepEqual(input, before);
  assert.equal(result.studentId, "student-a");
  assert.equal(result.month, "2026-09");
  assert.deepEqual(result.classes.map((item) => item.classId), ["class-a", "class-b"]);
  assert.equal(result.classes[1].basis, "승인 근거");
  assert.equal(Object.is(result.shuttleAmount, -0), false);
  assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  assert.notEqual(result.classes, input.classes);
  assert.notEqual(result.classes[0], input.classes[1]);
  assert.deepEqual(validateMonthlyRegisterDraft(result), result);
});

test("휴원·퇴원·이월 반은 각 행을 보존하되 수강료는 0원이다", () => {
  const classes = [excludedRow("PAUSED"), excludedRow("WITHDRAWN", { classId: "class-b" }), excludedRow("CARRY_OVER", { classId: "class-c" })];
  assert.deepEqual(calculateMonthlyRegister(draft({ classes, shuttleAmount: 0 })), {
    tuitionAmount: 0, shuttleAmount: 0, totalAmount: 0,
    rows: [{ classId: "class-a", amount: 0 }, { classId: "class-b", amount: 0 }, { classId: "class-c", amount: 0 }],
  });
});

test("활성 수강과 제외 반이 섞여도 활성 반만 수강료에 포함한다", () => {
  const result = calculateMonthlyRegister(draft({ classes: [row(), excludedRow("PAUSED", { classId: "class-b" })] }));
  assert.equal(result.tuitionAmount, 83000);
  assert.equal(result.totalAmount, 103000);
});

test("활성 반 없이 셔틀비만 부과하지 않는다", () => {
  invalid(draft({ classes: [excludedRow()] }), /셔틀비만 부과/);
  assert.doesNotThrow(() => validateMonthlyRegisterDraft(draft({ classes: [excludedRow()], shuttleAmount: 0 })));
});

test("비활성 반의 기준액과 모든 차감액은 0이어야 한다", () => {
  for (const status of ["PAUSED", "WITHDRAWN", "CARRY_OVER"]) {
    invalid(draft({ classes: [excludedRow(status, { baseAmount: 10000 })], shuttleAmount: 0 }), /모두 0원/);
    for (const field of ["discountAmount", "carryAmount", "prorationAmount"]) {
      invalid(draft({ classes: [excludedRow(status, { baseAmount: 10000, [field]: 10000 })], shuttleAmount: 0 }), /모두 0원/);
    }
  }
});

test("금액은 숫자형 0~1억원 정수만 허용한다", () => {
  for (const value of [-1, 0.5, 100000001, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER, "1000", null, undefined, true]) {
    for (const field of ["baseAmount", "discountAmount", "carryAmount", "prorationAmount"]) {
      invalid(draft({ classes: [row({ [field]: value })] }), /정수/);
    }
    invalid(draft({ shuttleAmount: value }), /정수/);
  }
});

test("할인·이월·일할 차감 합계는 기준액 이하이며 전액 차감은 허용한다", () => {
  invalid(draft({ classes: [row({ baseAmount: 10000, discountAmount: 6000, carryAmount: 3000, prorationAmount: 2000 })] }), /기준 수강료/);
  const result = calculateMonthlyRegister(draft({ classes: [row({ baseAmount: 10000, discountAmount: 6000, carryAmount: 3000, prorationAmount: 1000 })], shuttleAmount: 0 }));
  assert.equal(result.totalAmount, 0);
});

test("최대 20개 반·금액 상한에서도 정확한 안전 정수 합계를 반환한다", () => {
  const result = calculateMonthlyRegister(draft({
    classes: Array.from({ length: 20 }, (_, index) => row({ classId: `class-${index}`, baseAmount: 100000000, discountAmount: 0, carryAmount: 0, prorationAmount: 0 })),
    shuttleAmount: 100000000,
  }));
  assert.equal(result.tuitionAmount, 2000000000);
  assert.equal(result.totalAmount, 2100000000);
  assert.ok(Number.isSafeInteger(result.totalAmount));
});

test("반은 1~20개이며 공백 정규화 후 ID 중복도 거절한다", () => {
  for (const classes of [[], null, {}, "class", Array.from({ length: 21 }, (_, index) => row({ classId: `class-${index}` }))]) {
    invalid(draft({ classes }), /1~20개/);
  }
  invalid(draft({ classes: [row(), row({ classId: " class-a " })] }), /중복/);
  invalid(draft({ classes: [null] }), /형식/);
  invalid(draft({ classes: [new Date()] }), /형식/);
});

test("알 수 없는 수강 상태나 빠진 필수값은 거절한다", () => {
  for (const status of ["UNKNOWN", "active", "", null, 1]) invalid(draft({ classes: [row({ status })] }));
  for (const key of ["studentId", "month", "classes", "shuttleAmount", "shuttleBasis", "reason"]) {
    const input = draft();
    delete input[key];
    invalid(input);
  }
  for (const key of Object.keys(row())) {
    const item = row();
    delete item[key];
    invalid(draft({ classes: [item] }));
  }
});

test("근거와 사유는 공백만으로 대체할 수 없고 500자까지 허용한다", () => {
  for (const value of ["", " \n\t ", "가".repeat(501), 12, null]) {
    invalid(draft({ reason: value }));
    invalid(draft({ shuttleAmount: 0, shuttleBasis: value }));
    invalid(draft({ classes: [row({ basis: value })] }));
    invalid(draft({ classes: [excludedRow("PAUSED", { basis: value })], shuttleAmount: 0 }));
  }
  assert.doesNotThrow(() => validateMonthlyRegisterDraft(draft({ reason: "가".repeat(500), shuttleBasis: "가".repeat(500), classes: [row({ basis: "가".repeat(500) })] })));
});

test("학생과 반 ID는 빈 값이나 지나치게 긴 값으로 통과하지 않는다", () => {
  for (const value of [" ", "a".repeat(201), 1, null]) {
    invalid(draft({ studentId: value }));
    invalid(draft({ classes: [row({ classId: value })] }));
  }
});

test("대상 월은 2020~2100년의 정확한 YYYY-MM 형식이다", () => {
  for (const month of ["2019-12", "2101-01", "2026-00", "2026-13", "2026-9", "26-09", "2026-09-01", "2026/09"]) invalid(draft({ month }), /대상 월/);
  for (const month of ["2020-01", "2100-12"]) {
    assert.doesNotThrow(() => validateMonthlyRegisterDraft(draft({ month, classes: [row({ periodStart: `${month}-01`, periodEnd: `${month}-01` })] })));
  }
});

test("윤년을 검증하고 2월 30일 등 자동 보정된 잘못된 날짜를 거절한다", () => {
  for (const date of ["2026-02-29", "2026-02-30", "2026-04-31", "2026-09-31", "2026-13-01", "2026-09-00", "0000-01-01", "2026-9-01", "2026-09-01T00:00:00Z"]) {
    invalid(draft({ classes: [row({ periodStart: date })] }));
    invalid(draft({ classes: [row({ periodEnd: date })] }));
  }
  assert.doesNotThrow(() => validateMonthlyRegisterDraft(draft({ month: "2024-02", classes: [row({ periodStart: "2024-02-29", periodEnd: "2024-02-29" })] })));
  invalid(draft({ month: "2100-02", classes: [row({ periodStart: "2100-02-29", periodEnd: "2100-02-29" })] }), /실제 존재/);
});

test("기간은 역순을 거절하고 같은 날의 수강은 허용한다", () => {
  invalid(draft({ classes: [row({ periodStart: "2026-09-30", periodEnd: "2026-09-01" })] }), /늦을 수 없습니다/);
  assert.doesNotThrow(() => validateMonthlyRegisterDraft(draft({ classes: [row({ periodStart: "2026-09-15", periodEnd: "2026-09-15" })] })));
});

test("월을 걸치는 연간 일정은 허용하되 선택 월과 최소 하루 겹쳐야 한다", () => {
  for (const [periodStart, periodEnd] of [["2026-08-20", "2026-09-01"], ["2026-09-30", "2026-10-20"], ["2026-08-20", "2026-10-20"]]) {
    assert.doesNotThrow(() => validateMonthlyRegisterDraft(draft({ classes: [row({ periodStart, periodEnd })] })));
  }
  for (const [periodStart, periodEnd] of [["2026-08-01", "2026-08-31"], ["2026-10-01", "2026-10-31"]]) {
    invalid(draft({ classes: [row({ periodStart, periodEnd })] }), /대상 월과 겹쳐야/);
  }
  assert.doesNotThrow(() => validateMonthlyRegisterDraft(draft({ month: "2020-01", classes: [row({ periodStart: "2019-12-20", periodEnd: "2020-01-20" })] })));
});

test("62일은 시작일과 종료일을 모두 포함한 상한이다", () => {
  assert.doesNotThrow(() => validateMonthlyRegisterDraft(draft({ classes: [row({ periodStart: "2026-08-20", periodEnd: "2026-10-20" })] })));
  invalid(draft({ classes: [row({ periodStart: "2026-08-20", periodEnd: "2026-10-21" })] }), /62일/);
});

test("날짜나 현재 달을 근거로 일할 차감액을 자동 계산하지 않는다", () => {
  const result = calculateMonthlyRegister(draft({ classes: [row({ periodStart: "2026-09-30", periodEnd: "2026-09-30", discountAmount: 0, carryAmount: 0, prorationAmount: 0 })], shuttleAmount: 0 }));
  assert.equal(result.tuitionAmount, 100000);
});

test("계산 직접 호출도 검증하며 임의 객체·누락 값을 허용하지 않는다", () => {
  for (const value of [null, undefined, true, 1, "", [], new Date(), Object.create({ studentId: "student-a" })]) invalid(value, /형식/);
  assert.throws(() => calculateMonthlyRegister(draft({ classes: [row({ baseAmount: -1 })] })), MonthlyRegisterError);
  assert.throws(() => calculateMonthlyRegister(draft({ classes: [row({ discountAmount: 100001 })] })), MonthlyRegisterError);
});

test("모델 오류는 기본 400이며 서버가 지정한 HTTP 상태도 전달한다", () => {
  const error = new MonthlyRegisterError("승인 필요", 409);
  assert.ok(error instanceof Error);
  assert.equal(error.name, "MonthlyRegisterError");
  assert.equal(error.message, "승인 필요");
  assert.equal(error.status, 409);
  assert.equal(new MonthlyRegisterError("잘못된 입력").status, 400);
});
