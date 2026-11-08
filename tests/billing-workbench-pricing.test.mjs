// 청구 준비 «제안값» 순수 계산 테스트 — 주N회 요금·셔틀비·형제할인.
// 값은 2026-11-08 운영 DB(랠리즈 11월 청구 사본)에서 확인한 실제 사례를 그대로 쓴다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("src/lib/billing/workbench-pricing.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const {
  weeklyTierPrice, splitTierPrice, planWeeklyTuition, planShuttleFee,
  siblingDiscountStudents, siblingDiscountAmount, REGULAR_SIBLING_DISCOUNT_TARGET,
} = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

// 운영 요금표(2026-11-08)
const hobby = { price: 100000, priceWeek1: 100000, priceWeek2: 160000, priceWeek3: 210000, priceDaily: null };
const game = { price: 120000, priceWeek1: 120000, priceWeek2: 180000, priceWeek3: 240000, priceDaily: null };
const weekend = { price: 110000, priceWeek1: 110000, priceWeek2: null, priceWeek3: null, priceDaily: null };
const enroll = (studentId, classId, programId, prices, programName = programId) => ({ key: `${studentId}:${classId}`, studentId, programId, programName, ...prices });

test("주N회 요금: 1회는 기존 price, 2·3회는 주N회 칸, 빈 칸·4회는 null", () => {
  assert.equal(weeklyTierPrice(hobby, 1), 100000);
  assert.equal(weeklyTierPrice(hobby, 2), 160000);
  assert.equal(weeklyTierPrice(game, 3), 240000);
  assert.equal(weeklyTierPrice(weekend, 2), null);
  assert.equal(weeklyTierPrice(hobby, 4), null);
  assert.equal(weeklyTierPrice({ ...hobby, priceDaily: 260000 }, 5), 260000);
  assert.equal(weeklyTierPrice(hobby, 0), null);
});

test("요금 분배: 나누어떨어지지 않으면 남는 원은 첫 행 — 합계는 요금과 같다", () => {
  assert.deepEqual(splitTierPrice(160000, 2), [80000, 80000]);
  assert.deepEqual(splitTierPrice(210000, 3), [70000, 70000, 70000]);
  const odd = splitTierPrice(100001, 3);
  assert.deepEqual(odd, [33335, 33333, 33333]);
  assert.equal(odd.reduce((a, b) => a + b, 0), 100001);
});

test("주중취미 주2회 학생은 200,000원이 아니라 160,000원(80,000 × 2)", () => {
  const plan = planWeeklyTuition([enroll("s", "mon", "hobby", hobby), enroll("s", "wed", "hobby", hobby)]);
  assert.equal(plan.get("s:mon").baseAmount + plan.get("s:wed").baseAmount, 160000);
  assert.equal(plan.get("s:mon").baseAmount, 80000);
  assert.match(plan.get("s:mon").basis, /주2회 요금 160,000원 ÷ 2반/);
  assert.equal(plan.get("s:mon").warning, null);
});

test("주중경기 주3회 학생은 240,000원(80,000 × 3), 주1회 학생은 그대로", () => {
  const plan = planWeeklyTuition([
    enroll("a", "mon", "game", game), enroll("a", "thu", "game", game), enroll("a", "fri", "game", game),
    enroll("b", "tue", "game", game),
  ]);
  assert.deepEqual(["a:mon", "a:thu", "a:fri"].map(k => plan.get(k).baseAmount), [80000, 80000, 80000]);
  assert.equal(plan.get("b:tue").baseAmount, 120000);
  assert.equal(plan.get("b:tue").basis, null);
});

test("주N회 요금이 비어 있으면 기존 방식(주1회 × 반 수)으로 두고 경고를 남긴다", () => {
  const plan = planWeeklyTuition([enroll("s", "sat1", "weekend", weekend, "주말경기반"), enroll("s", "sat2", "weekend", weekend, "주말경기반")]);
  assert.equal(plan.get("s:sat1").baseAmount, 110000);
  assert.equal(plan.get("s:sat2").baseAmount, 110000);
  assert.match(plan.get("s:sat1").warning, /주말경기반 주2회 요금이 비어/);
  assert.match(plan.get("s:sat1").basis, /요금 미설정/);
});

test("프로그램을 모르는 등록은 묶지 않는다(기존 동작 유지)", () => {
  const plan = planWeeklyTuition([enroll("s", "a", null, hobby), enroll("s", "b", null, hobby)]);
  assert.equal(plan.get("s:a").baseAmount, 100000);
  assert.equal(plan.get("s:b").baseAmount, 100000);
});

test("여러 프로그램을 함께 다니면 프로그램별 요금으로 두되 합산 여부 확인 경고", () => {
  const plan = planWeeklyTuition([enroll("s", "sat", "weekend", weekend, "주말경기반"), enroll("s", "mon", "hobby", hobby, "주중취미반"), enroll("s", "wed", "hobby", hobby, "주중취미반")]);
  assert.equal(plan.get("s:sat").baseAmount, 110000);
  assert.equal(plan.get("s:mon").baseAmount + plan.get("s:wed").baseAmount, 160000);
  assert.match(plan.get("s:mon").warning, /여러 프로그램/);
});

const weekday = (dayOfWeek, extra = {}) => ({ dayOfWeek, slotKey: null, runsShuttle: true, shuttleFeeOverride: null, ...extra });

test("셔틀비: 명단에 없으면 0, 있으면 셔틀 운행 평일 반 주 횟수로 10,000/15,000/20,000", () => {
  assert.equal(planShuttleFee(false, [weekday("Mon")]).amount, 0);
  assert.equal(planShuttleFee(true, [weekday("Mon")]).amount, 10000);
  assert.equal(planShuttleFee(true, [weekday("Mon"), weekday("Wed")]).amount, 15000);
  assert.equal(planShuttleFee(true, [weekday("Mon"), weekday("Wed"), weekday("Fri")]).amount, 20000);
  assert.equal(planShuttleFee(true, [weekday("Mon"), weekday("Tue"), weekday("Wed"), weekday("Thu")]).amount, 20000);
});

test("셔틀비: 주말 반·셔틀 미운행 반·셔틀비 0 지정 반은 횟수에서 뺀다", () => {
  // 이건희 사례: 주말경기반 + 주중취미 주2회 → 15,000
  assert.equal(planShuttleFee(true, [weekday("Sat", { runsShuttle: false, shuttleFeeOverride: 0 }), weekday("Wed"), weekday("Fri")]).amount, 15000);
  const none = planShuttleFee(true, [weekday("Sat", { runsShuttle: false })]);
  assert.equal(none.amount, 0);
  assert.match(none.warning, /셔틀을 운행하는 평일 반이 없어/);
  assert.equal(planShuttleFee(true, [weekday("Sun"), weekday("Mon")]).amount, 10000);
});

test("셔틀비: 프로그램 직접 입력 셔틀비가 있으면 그 값, 일8 대표팀은 전액 면제", () => {
  assert.equal(planShuttleFee(true, [weekday("Mon", { shuttleFeeOverride: 12000 }), weekday("Wed")]).amount, 12000);
  const exempt = planShuttleFee(true, [weekday("Mon"), weekday("Sun", { slotKey: "Sun-8" })]);
  assert.equal(exempt.amount, 0);
  assert.match(exempt.basis, /일8 대표팀/);
});

const kid = (studentId, parentId, birthDate = null, name = studentId) => ({ studentId, parentId, birthDate, name });

test("형제할인: 같은 학부모 재원 자녀 2명 이상이면 기본은 전원 대상", () => {
  assert.equal(REGULAR_SIBLING_DISCOUNT_TARGET, "ALL");
  const set = siblingDiscountStudents([kid("루나", "p1"), kid("루희", "p1"), kid("혼자", "p2"), kid("미연결", null), kid("미연결2", null)]);
  assert.deepEqual([...set].sort(), ["루나", "루희"]);
});

test("형제할인: 한 아이가 반을 여러 개 다녀도 형제로 세지 않는다", () => {
  const set = siblingDiscountStudents([kid("a", "p"), kid("a", "p"), kid("a", "p")]);
  assert.equal(set.size, 0);
});

test("형제할인: «둘째부터» 설정이면 생일이 가장 빠른 첫째를 뺀다", () => {
  const set = siblingDiscountStudents([kid("동생", "p", "2018-05-01"), kid("형", "p", "2015-03-01"), kid("막내", "p", null)], "SECOND_AND_LATER");
  assert.deepEqual([...set].sort(), ["동생", "막내"]);
});

test("형제할인액은 수강료의 10%, 원 단위 절사, 0 이하는 0", () => {
  assert.equal(siblingDiscountAmount(100000), 10000);
  assert.equal(siblingDiscountAmount(80000), 8000);
  assert.equal(siblingDiscountAmount(33335), 3333);
  assert.equal(siblingDiscountAmount(0), 0);
  assert.equal(siblingDiscountAmount(-1), 0);
});
