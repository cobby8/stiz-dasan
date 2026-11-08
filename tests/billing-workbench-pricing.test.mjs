// 청구 준비 «제안값» 순수 계산 테스트 — 주N회 요금·셔틀비·형제할인.
// 값은 2026-11-08 운영 DB(랠리즈 11월 청구 사본)에서 확인한 실제 사례를 그대로 쓴다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("src/lib/billing/workbench-pricing.ts", "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const {
  weeklyTierPrice, splitTierPrice, planWeeklyTuition, planShuttleFee, COMPETITION_PACKAGE_FEE, FREE_SHUTTLE_HUB_STOPS,
  siblingDiscountStudents, siblingDiscountAmount, REGULAR_SIBLING_DISCOUNT_TARGET,
} = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

// 운영 요금표(2026-11-08)
const hobby = { price: 100000, priceWeek1: 100000, priceWeek2: 160000, priceWeek3: 210000, priceDaily: null };
const game = { price: 120000, priceWeek1: 120000, priceWeek2: 180000, priceWeek3: 240000, priceDaily: null };
const weekend = { price: 110000, priceWeek1: 110000, priceWeek2: null, priceWeek3: null, priceDaily: null };
const enroll = (studentId, classId, programId, prices, programName = programId, dayOfWeek = null) => ({ key: `${studentId}:${classId}`, studentId, programId, programName, dayOfWeek, ...prices });

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

// 원장 결정(2026-11-09): 여러 프로그램이면 학생 전체 주 횟수 N 으로 «각 프로그램의 주N회 요금 ÷ N».
test("여러 프로그램: 원장 예시 — 주중경기 1회 + 주말경기 1회 = 주2회, 각 프로그램 주2회 요금 ÷ 2", () => {
  const weekendWith2 = { ...weekend, priceWeek2: 180000 }; // 주말경기반 주2회 칸이 채워졌다고 가정(→ 9만)
  const game2 = { ...game, priceWeek2: 160000 }; // 원장 예시의 «주중경기반 8만»
  const plan = planWeeklyTuition([enroll("s", "tue", "game", game2, "치열한 주중경기반"), enroll("s", "sat", "weekend", weekendWith2, "통쾌한 주말경기반")]);
  assert.equal(plan.get("s:tue").baseAmount, 80000);
  assert.equal(plan.get("s:sat").baseAmount, 90000);
  assert.equal(plan.get("s:tue").baseAmount + plan.get("s:sat").baseAmount, 170000);
  assert.match(plan.get("s:tue").basis, /여러 프로그램 합산 주2회\(치열한 주중경기반 주1회 \+ 통쾌한 주말경기반 주1회\)/);
  assert.match(plan.get("s:sat").basis, /통쾌한 주말경기반 주2회 요금 180,000원 ÷ 2/);
  assert.equal(plan.get("s:tue").warning, null); // 예전 «여러 프로그램 수강» 경고는 근거 설명으로 바뀌었다
});

test("여러 프로그램: 주말경기 1 + 주중취미 2 = 주3회, 주말경기 주3회 칸이 비면 그 반만 기존 방식 + 경고", () => {
  const plan = planWeeklyTuition([enroll("s", "sat", "weekend", weekend, "주말경기반"), enroll("s", "mon", "hobby", hobby, "주중취미반"), enroll("s", "wed", "hobby", hobby, "주중취미반")]);
  assert.equal(plan.get("s:sat").baseAmount, 110000);
  assert.match(plan.get("s:sat").warning, /주말경기반 주3회 요금이 비어/);
  assert.equal(plan.get("s:mon").baseAmount, 70000); // 주중취미 주3회 210,000 ÷ 3
  assert.equal(plan.get("s:wed").baseAmount, 70000);
  assert.equal(plan.get("s:mon").warning, null);
  assert.match(plan.get("s:mon").basis, /주중취미반 주3회 요금 210,000원 ÷ 3/);
});

test("여러 프로그램: 나누어떨어지지 않으면 프로그램별 절사로 남는 원을 학생 첫 행에 붙인다", () => {
  const a = { ...hobby, priceWeek3: 100000 }, b = { ...game, priceWeek3: 200000 };
  const plan = planWeeklyTuition([enroll("s", "1", "a", a), enroll("s", "2", "b", b), enroll("s", "3", "b", b)]);
  // a 몫 floor(100000/3)=33333, b 몫 floor(200000×2/3)=133333 → 합 166666, 반별 33333+66666+66666=166665 → 1원은 첫 행
  assert.deepEqual(["s:1", "s:2", "s:3"].map(k => plan.get(k).baseAmount), [33334, 66666, 66666]);
});

// 원장 결정(2026-11-09): 대회준비반 월 30만원 고정 = 주말·수요일 대회준비반 훈련 + 일반 반 1회.
const comp = { price: 300000, priceWeek1: null, priceWeek2: null, priceWeek3: null, priceDaily: null };
const compRow = (studentId, classId, day) => enroll(studentId, classId, "comp", comp, "대회준비반", day);

test("대회준비반: 주말+수요일+일반 반 1개 = 합계 300,000원, 첫 대회준비반 행에 몰고 나머지 0원", () => {
  const plan = planWeeklyTuition([compRow("s", "sun8", "Sun"), compRow("s", "wed7", "Wed"), enroll("s", "fri5", "hobby", hobby, "주중취미반", "Fri")]);
  assert.equal(COMPETITION_PACKAGE_FEE, 300000);
  assert.deepEqual(["s:sun8", "s:wed7", "s:fri5"].map(k => plan.get(k).baseAmount), [300000, 0, 0]);
  assert.match(plan.get("s:sun8").basis, /대회준비반 월 300,000원 고정/);
  assert.match(plan.get("s:fri5").basis, /포함된 일반 반/);
  assert.equal(plan.get("s:sun8").warning, null);
});

test("대회준비반: 일반 반이 2개 이상이면 1개만 포함, 나머지는 일반 규칙 + 경고", () => {
  const plan = planWeeklyTuition([compRow("s", "sun8", "Sun"), compRow("s", "wed7", "Wed"),
    enroll("s", "mon", "hobby", hobby, "주중취미반", "Mon"), enroll("s", "tue", "game", game, "주중경기반", "Tue")]);
  assert.equal(plan.get("s:sun8").baseAmount, 300000);
  assert.equal(plan.get("s:mon").baseAmount, 0);
  assert.equal(plan.get("s:tue").baseAmount, 120000); // 남은 1개 = 주1회 → 주중경기 주1회 요금
  assert.match(plan.get("s:tue").warning, /일반 반을 2개 수강/);
});

test("대회준비반: 수요일 훈련이 없으면 묶음은 적용하되 경고, 주말 훈련 없이 수요일만이면 묶음 미적용 + 경고", () => {
  const sunOnly = planWeeklyTuition([compRow("s", "sun8", "Sun")]);
  assert.equal(sunOnly.get("s:sun8").baseAmount, 300000);
  assert.match(sunOnly.get("s:sun8").warning, /수요일 7교시 훈련\(필수\) 등록이 없습니다/);
  const wedOnly = planWeeklyTuition([compRow("w", "wed7", "Wed")]);
  assert.equal(wedOnly.get("w:wed7").baseAmount, 300000); // 프로그램 주1회 요금 그대로(일반 규칙) — 금액은 사람이 확인
  assert.match(wedOnly.get("w:wed7").warning, /주말 훈련 없이 평일 대회준비반만 수강/);
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

// 원장(2026-11-09) «1호점 앞 버스정류장에서 타는 학생은 무료거점에서 타는 거라 셔틀비 안 받아» + 코덱스 지식 2026-09-02.
const hubBoard = { direction: "BOARD", stopName: "1호점 앞 버스정류장" };
const hubAlight = { direction: "ALIGHT", stopName: "새봄중학교 앞 버스정류장" };

test("무료 거점: 승차가 전부 1호점 앞 버스정류장이고 하차가 거점 하차뿐이면 셔틀비 0원", () => {
  assert.deepEqual(FREE_SHUTTLE_HUB_STOPS.board, ["1호점 앞 버스정류장"]);
  const both = planShuttleFee(true, [weekday("Mon"), weekday("Wed")], [hubBoard, hubAlight]);
  assert.equal(both.amount, 0);
  assert.match(both.basis, /무료 거점\(1호점 앞 버스정류장\) 승차/);
  assert.equal(both.warning, null);
  // 김루나·김루희처럼 승차만 있는 경우, 띄어쓰기가 달라도 같은 정류장으로 본다
  assert.equal(planShuttleFee(true, [weekday("Thu")], [{ direction: "BOARD", stopName: "1호점앞 버스정류장" }]).amount, 0);
});

test("무료 거점: 거점 승차와 다른 정류장 이용이 섞이면 일반 셔틀비를 제안하고 경고", () => {
  const mixed = planShuttleFee(true, [weekday("Mon"), weekday("Tue"), weekday("Fri")],
    [{ direction: "BOARD", stopName: "플루리움 3단지 놀이터" }, { direction: "ALIGHT", stopName: "플루리움 3단지 놀이터" }, hubBoard, hubAlight]);
  assert.equal(mixed.amount, 20000);
  assert.match(mixed.warning, /무료 거점\(1호점 앞 버스정류장\) 승차와 다른 정류장 이용이 섞여/);
});

test("무료 거점: 거점 승차가 없으면 거점 하차 정류장에서 내려도 일반 셔틀비(경고 없음), 일8 면제는 그대로", () => {
  const alightOnly = planShuttleFee(true, [weekday("Wed")], [{ direction: "BOARD", stopName: "다산별빛초등학교 후문" }, hubAlight]);
  assert.equal(alightOnly.amount, 10000);
  assert.equal(alightOnly.warning, null);
  assert.equal(planShuttleFee(true, [weekday("Mon")], []).amount, 10000); // 정류장 정보가 없으면 기존 동작
  assert.match(planShuttleFee(true, [weekday("Mon"), weekday("Sun", { slotKey: "Sun-8" })], [hubBoard]).basis, /일8 대표팀/);
  assert.equal(planShuttleFee(false, [weekday("Mon")], [hubBoard]).amount, 0);
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
