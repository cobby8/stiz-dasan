import test from "node:test";
import assert from "node:assert/strict";

// @ts-expect-error -- Node의 타입 제거 실행기는 런타임 확장자를 요구한다.
import { summarizeStudentBilling, classifyPaymentMethod, isExcludedFromBilling, studentGroupKey } from "./studentBilling.ts";

type Row = {
  rowNumber: number;
  paymentMethodRaw: string | null;
  tuitionAmount: number | null;
  shuttleFee: number | null;
  carryOverAmount: number | null;
  slotKeys?: readonly string[];
  isFreeShuttle?: boolean;
};

function row(partial: Partial<Row> & { rowNumber: number }): Row {
  return {
    paymentMethodRaw: "미결제",
    tuitionAmount: null,
    shuttleFee: null,
    carryOverAmount: null,
    ...partial,
  };
}

test("주1회 학생(1행)은 금액이 그대로 유지된다 — 82명 회귀 방어", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 10, tuitionAmount: 80000 }),
  ]);

  assert.equal(result.tuitionTotal, 80000);
  assert.equal(result.shuttleFeeTotal, 0);
  assert.equal(result.billableAmount, 80000);
  assert.equal(result.paymentMethod, "UNPAID");
});

test("김루하 실사례: 주3회 70,000 × 3행 = 수강료 210,000", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 8, tuitionAmount: 70000, shuttleFee: 20000 }),
    row({ rowNumber: 89, tuitionAmount: 70000 }),
    row({ rowNumber: 159, tuitionAmount: 70000 }),
  ]);

  assert.equal(result.tuitionTotal, 210000, "다행 학생의 수강료는 합계여야 한다");
  assert.equal(result.shuttleFeeTotal, 20000, "셔틀비는 첫 행 값 1건만");
  assert.equal(result.billableAmount, 230000);
  assert.deepEqual(result.countedRowNumbers, [8, 89, 159]);
});

test("김용준 실사례: 주2회 90,000 × 2행 = 180,000", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 90000 }),
    row({ rowNumber: 2, tuitionAmount: 90000 }),
  ]);

  assert.equal(result.billableAmount, 180000);
});

test("신강민 실사례: 같은 요일 2행 125,000 × 2 = 250,000", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 125000 }),
    row({ rowNumber: 2, tuitionAmount: 125000 }),
  ]);

  assert.equal(result.billableAmount, 250000);
});

test("김태훈A 실사례: 행마다 금액이 달라도 그대로 합산한다 (80,000 + 120,000)", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 80000 }),
    row({ rowNumber: 2, tuitionAmount: 120000 }),
  ]);

  assert.equal(result.billableAmount, 200000, "평균이나 최댓값이 아니라 합계다");
});

test("셔틀비가 모든 행에 중복 기재돼도 두 번 청구하지 않는다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 70000, shuttleFee: 15000 }),
    row({ rowNumber: 2, tuitionAmount: 70000, shuttleFee: 15000 }),
    row({ rowNumber: 3, tuitionAmount: 70000, shuttleFee: 15000 }),
  ]);

  assert.equal(result.shuttleFeeTotal, 15000, "합산 45,000이 되면 안 된다");
  assert.equal(result.billableAmount, 225000);
});

test("셔틀비는 첫 행에만 적혀도 청구에 포함된다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 70000, shuttleFee: 10000 }),
    row({ rowNumber: 2, tuitionAmount: 70000 }),
  ]);

  assert.equal(result.shuttleFeeTotal, 10000);
  assert.equal(result.billableAmount, 150000);
});

test("무료셔틀로 확정된 학생은 시트에 셔틀비가 있어도 0원으로 계산한다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 90000, shuttleFee: 15000, isFreeShuttle: true }),
    row({ rowNumber: 2, tuitionAmount: 90000 }),
  ]);

  assert.equal(result.tuitionTotal, 180000);
  assert.equal(result.shuttleFeeTotal, 0);
  assert.equal(result.billableAmount, 180000);
});

test("일8 대표팀 수강생은 다른 정규반을 함께 타도 월 셔틀비가 전액 면제된다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 100000, shuttleFee: 15000, slotKeys: ["Wed-7"] }),
    row({ rowNumber: 2, tuitionAmount: 100000, slotKeys: ["Sun-8"] }),
  ]);

  assert.equal(result.tuitionTotal, 200000);
  assert.equal(result.shuttleFeeTotal, 0);
  assert.equal(result.billableAmount, 200000);
});

test("휴원인 일8 행은 셔틀비 면제 근거로 쓰지 않는다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 100000, shuttleFee: 10000, slotKeys: ["Wed-7"] }),
    row({ rowNumber: 2, paymentMethodRaw: "휴원", tuitionAmount: 100000, slotKeys: ["Sun-8"] }),
  ]);

  assert.equal(result.shuttleFeeTotal, 10000);
  assert.equal(result.billableAmount, 110000);
});

test("다른 일요일 반은 일8 대표팀 면제 규칙을 적용하지 않는다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 100000, shuttleFee: 10000, slotKeys: ["Sun-7"] }),
  ]);

  assert.equal(result.shuttleFeeTotal, 10000);
  assert.equal(result.billableAmount, 110000);
});

test("휴원 행은 이번 달 청구에서 빠진다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, paymentMethodRaw: "미결제", tuitionAmount: 80000 }),
    row({ rowNumber: 2, paymentMethodRaw: "휴원", tuitionAmount: 80000 }),
  ]);

  assert.equal(result.tuitionTotal, 80000);
  assert.deepEqual(result.countedRowNumbers, [1]);
  assert.deepEqual(result.excludedRowNumbers, [2]);
});

test("전 행이 휴원/퇴원이면 청구를 만들지 않는다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, paymentMethodRaw: "휴원", tuitionAmount: 80000 }),
    row({ rowNumber: 2, paymentMethodRaw: "퇴원", tuitionAmount: 80000 }),
  ]);

  assert.equal(result.billableAmount, 0);
  assert.equal(result.paymentMethod, null);
});

test("결제방법이 `이월` 라벨인 행은 금액을 깎는 게 아니라 행째로 빠진다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, paymentMethodRaw: "미결제", tuitionAmount: 80000 }),
    row({ rowNumber: 2, paymentMethodRaw: "이월", tuitionAmount: 80000 }),
  ]);

  assert.equal(result.tuitionTotal, 80000, "이월 행 수강료는 합산하지 않는다");
  assert.equal(result.carryOverTotal, 0, "이월은 차감이 아니라 제외다");
  assert.deepEqual(result.countedRowNumbers, [1]);
  assert.deepEqual(result.excludedRowNumbers, [2]);
  assert.equal(result.billableAmount, 80000);
});

test("이월 행만 있으면 청구액 0, 결제수단 없음", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, paymentMethodRaw: "이월", tuitionAmount: 80000 }),
  ]);

  assert.equal(result.billableAmount, 0);
  assert.equal(result.paymentMethod, null);
});

test("이월 금액 칸이 나중에 채워지면 그때는 차감한다 (현재 시트에서는 항상 0)", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 80000, carryOverAmount: 30000 }),
    row({ rowNumber: 2, tuitionAmount: 80000 }),
  ]);

  assert.equal(result.carryOverTotal, 30000);
  assert.equal(result.billableAmount, 130000);
});

test("이월 금액이 총액보다 커도 청구액은 0 미만이 되지 않는다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 80000, carryOverAmount: 500000 }),
  ]);

  assert.equal(result.billableAmount, 0);
  assert.equal(result.paymentMethod, "UNPAID", "미결제 라벨은 그대로 유지된다");
});

test("배수호 실사례: 첫 행이 `추가수강`이어도 청구가 사라지지 않는다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 6, paymentMethodRaw: "추가수강", tuitionAmount: null }),
    row({ rowNumber: 120, paymentMethodRaw: "추가수강", tuitionAmount: null }),
    row({ rowNumber: 212, paymentMethodRaw: "미결제", tuitionAmount: 300000 }),
  ]);

  assert.equal(result.billableAmount, 300000);
  assert.equal(result.paymentMethod, "UNPAID");
});

test("`추가수강` 라벨만 있고 금액이 남으면 미납으로 청구한다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, paymentMethodRaw: "추가수강", tuitionAmount: 150000 }),
  ]);

  assert.equal(result.billableAmount, 150000);
  assert.equal(result.paymentMethod, "UNPAID", "청구 누락(0원)보다 미납 청구가 안전하다");
});

test("우지율 실사례: 3행 전부 `추가수강`+수강료 공란이면 0원 — 청구서를 만들지 않는다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 107, paymentMethodRaw: "추가수강", tuitionAmount: null }),
    row({ rowNumber: 151, paymentMethodRaw: "추가수강", tuitionAmount: 0 }),
    row({ rowNumber: 214, paymentMethodRaw: "추가수강", tuitionAmount: null }),
  ]);

  assert.equal(result.billableAmount, 0, "원장 확답: 0원이 맞다");
  assert.equal(result.paymentMethod, null, "결제수단이 없어야 Payment가 생성되지 않는다");
});

test("납부 완료 행 단독이면 그 결제수단을 유지한다 — 이도훈 실사례", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 64, paymentMethodRaw: "카드결제", tuitionAmount: 120000 }),
  ]);

  assert.equal(result.billableAmount, 120000);
  assert.equal(result.paymentMethod, "CARD");
  assert.equal(result.mixedPaymentMethods, false);
});

test("납부 행과 미납 행이 섞이면 미납으로 잡고 수동 확인 플래그를 세운다", () => {
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, paymentMethodRaw: "랠리즈", tuitionAmount: 80000 }),
    row({ rowNumber: 2, paymentMethodRaw: "미결제", tuitionAmount: 80000 }),
  ]);

  assert.equal(result.paymentMethod, "UNPAID");
  assert.equal(result.mixedPaymentMethods, true);
});

test("형제할인을 코드에서 다시 곱하지 않는다 — 시트 값 그대로", () => {
  // 72,000은 80,000에 형제할인 10%가 이미 수기 반영된 값이다.
  const result = summarizeStudentBilling([
    row({ rowNumber: 1, tuitionAmount: 72000 }),
    row({ rowNumber: 2, tuitionAmount: 72000 }),
  ]);

  assert.equal(result.billableAmount, 144000, "이중 할인(129,600)이 되면 안 된다");
});

test("결제수단 분류는 운영 라벨만 인정한다", () => {
  assert.equal(classifyPaymentMethod("랠리즈"), "RALLYZ");
  assert.equal(classifyPaymentMethod("카드결제"), "CARD");
  assert.equal(classifyPaymentMethod("현금영수증"), "CASH");
  assert.equal(classifyPaymentMethod("미결제"), "UNPAID");
  assert.equal(classifyPaymentMethod("추가수강"), null);
  assert.equal(classifyPaymentMethod("이월"), null);
  assert.equal(classifyPaymentMethod("휴원"), null);
  assert.equal(classifyPaymentMethod(null), null);
});

test("학부모 전화번호가 행마다 달라도 같은 학생으로 묶는다 — 김용준 실사례", () => {
  // 시트에 부/모 번호가 갈려 적혀 있어도 이름+생년월일이 같으면 한 사람이다.
  // 이게 갈리면 180,000이 90,000 두 건으로 쪼개진다.
  const a = studentGroupKey({ name: "김용준", birthDateISO: "2013-06-19", parentPhone: "01037753570" });
  const b = studentGroupKey({ name: "김용준", birthDateISO: "2013-06-19", parentPhone: "01089898264" });

  assert.equal(a, b);
});

test("이름이 같아도 생년월일이 다르면 다른 학생이다", () => {
  const a = studentGroupKey({ name: "여민재", birthDateISO: "2014-05-01", parentPhone: "01011112222" });
  const b = studentGroupKey({ name: "여민재", birthDateISO: "2016-09-09", parentPhone: "01011112222" });

  assert.notEqual(a, b);
});

test("생년월일이 없으면 예전처럼 학부모 전화번호로 묶는다", () => {
  const a = studentGroupKey({ name: "김루나", birthDateISO: null, parentPhone: "010-1111-2222" });
  const b = studentGroupKey({ name: "김루나", birthDateISO: null, parentPhone: "01011112222" });
  const c = studentGroupKey({ name: "김루나", birthDateISO: null, parentPhone: "01099998888" });

  assert.equal(a, b, "전화번호 표기(하이픈)는 무시한다");
  assert.notEqual(a, c);
});

test("청구 대상/제외 판정 — 원장 확답 규칙", () => {
  // 청구 대상
  assert.equal(isExcludedFromBilling("미결제"), false);
  assert.equal(isExcludedFromBilling("카드결제"), false);
  assert.equal(isExcludedFromBilling("추가수강"), false);
  assert.equal(isExcludedFromBilling("랠리즈"), false);
  assert.equal(isExcludedFromBilling(null), false);
  // 청구 제외
  assert.equal(isExcludedFromBilling("휴원"), true);
  assert.equal(isExcludedFromBilling("퇴원"), true);
  assert.equal(isExcludedFromBilling("이월"), true);
});
