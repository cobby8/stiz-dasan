import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

// 부상·질병 «기간 결석» 복귀 정산 3단계(2026-11-15 원장 결정) — 계산 규칙 실행 테스트.
//
// 여기서 보는 것: 순수 계산 모듈(illnessPeriodSettlementPlan.ts)을 «실제로 실행»한다.
//   · 한 번 값 = 그 달 실제로 낸 수강료 ÷ 그 달 수업 횟수(연간일정 휴무 제외)
//   · 낸 돈이 없는 달은 이월이 아니라 «다닌 횟수만큼만 청구»
//   · 달 경계·연말·휴무·3회 달·반올림·반 여러 개·제외 사유·날짜 빼기 → 지문
// 수업일은 청구와 «같은» 연간 일정 함수(getMonthlyClassDates)로 센다 — 손으로 센 기대값을 옆에 적어 사람이 검산할 수 있게 했다.
// DB 를 지나는 흐름(미리보기 → 확정 → 청구 준비 차감 → 확정 취소)은 실제 PostgreSQL 로 돈다: tests/billing-workbench-postgres.integration.mjs

const plan = await loadTsModule("src/lib/regular/illnessPeriodSettlementPlan.ts");
const rules = await loadTsModule("src/lib/regular/illnessPeriodRules.ts");
const evidenceRules = await loadTsModule("src/lib/billing/carryEvidence.ts");
const workbench = await loadTsModule("src/lib/billing/workbench.ts");
const read = (path) => readFileSync(path, "utf8");

// 연간 일정 함수 — 실제 파일을 그대로 올린다(DB·구글 일정을 읽는 두 import 만 막는다. 계산 함수는 순수하다)
const toUrl = (code) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`;
const calendarSource = read("src/lib/enrollment/monthlyClassDates.ts")
  .replace('import { getAcademySettings, getAnnualEvents } from "@/lib/queries";', "const getAcademySettings = () => { throw new Error('DB 금지'); }, getAnnualEvents = getAcademySettings;")
  .replace('import { fetchGoogleCalendarEvents } from "@/lib/googleCalendar";', "const fetchGoogleCalendarEvents = () => { throw new Error('외부 일정 금지'); };")
  .replace('from "@/lib/classSchedule"', `from "${toUrl(read("src/lib/classSchedule.ts"))}"`);
assert.ok(!/@\/lib\/(queries|googleCalendar)"/.test(calendarSource.replace(/^import type .*$/gm, "")), "외부 읽기 import 를 모두 막았다");
const { getMonthlyClassDates } = await import(toUrl(calendarSource));

const event = (title, date, endDate) => ({ title, date: `${date}T00:00:00.000Z`, ...(endDate ? { endDate: `${endDate}T00:00:00.000Z` } : {}) });
const PAID = (id, amount, monthDates, extra = {}) => evidenceRules.resolveMonthEvidence({
  issuedDraft: null, paidPayments: [{ id, amount, priorReduction: 0 }], monthDates, enrollmentStartsOn: null, ...extra,
});
const UNPAID = (monthDates) => evidenceRules.resolveMonthEvidence({ issuedDraft: null, paidPayments: [], monthDates, enrollmentStartsOn: null });
let seq = 0;
const absence = (classId, className, date, extra = {}) => ({
  absenceId: extra.absenceId ?? `a${++seq}`, classId, className, date, status: "CONFIRMED",
  attendance: null, creditStatus: null, bookingStatus: null, alreadyResolved: null, ...extra,
});
/** 연간 일정으로 그 결석의 수강월을 정한다(연결부와 같은 순서: 달력 월 → 다음 달 → 이전 달) */
const withMonth = (events, dayOfWeek) => (item) => {
  const month = item.date.slice(0, 7);
  const [y, m] = month.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  return { ...item, month: [month, next, prev].find((ym) => getMonthlyClassDates(events, ym, dayOfWeek).includes(item.date)) ?? month };
};

// ── 실제 사례: 윤수영 ─────────────────────────────────────────────────────────────────────
// 기간 2026-11-06 ~ (복귀 미정) · 월요일 6교시(11월 105,000원 납부완료 / 12월 105,000원 미납·보류)
//                              · 금요일 6교시(11월  90,000원 납부완료 / 12월  90,000원 미납·보류)
// 결석: 월 11/9·16·23·30 (4회) · 금 11/6·13·20·27 (4회)
//
// ⚠️ 수업 횟수는 연간 일정이 정한다. 운영 일정을 이 테스트가 읽을 수는 없어, 일정 모양 두 가지를 모두 적어 둔다
//    (운영 반영 전에 원장 화면의 미리보기 숫자를 아래 둘 중 어느 쪽과 같은지 대조하면 된다).

const YOON_ABSENCES = () => [
  ...["2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"].map((date) => absence("mon6", "월요일 6교시", date)),
  ...["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"].map((date) => absence("fri6", "금요일 6교시", date)),
];

test("윤수영 — 일정 A(주차 방식 · 12월 1주차가 11/30 에 시작): 11월 월요반 3회·금요반 4회 이월 168,750원, 11/30 결석은 12월 수강월(미납) → 다닌 만큼만 청구", () => {
  // 11월 = 11/2·11/9·11/16·11/23 주(4주) · 12월 = 11/30·12/7·12/14·12/21 주(4주) — 원장이 월별 요일당 4회로 맞춰 운영하는 모양
  const events = [
    event("11월 1주차", "2026-11-02"), event("11월 2주차", "2026-11-09"), event("11월 3주차", "2026-11-16"), event("11월 4주차", "2026-11-23"),
    event("12월 1주차", "2026-11-30"), event("12월 2주차", "2026-12-07"), event("12월 3주차", "2026-12-14"), event("12월 4주차", "2026-12-21"),
  ];
  const novMon = getMonthlyClassDates(events, "2026-11", "Mon"), novFri = getMonthlyClassDates(events, "2026-11", "Fri");
  const decMon = getMonthlyClassDates(events, "2026-12", "Mon"), decFri = getMonthlyClassDates(events, "2026-12", "Fri");
  // 손으로 센 값
  assert.deepEqual(novMon, ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"], "11월 월요일 수업 4회(11/30 은 12월 1주차)");
  assert.deepEqual(novFri, ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"], "11월 금요일 수업 4회");
  assert.deepEqual(decMon, ["2026-11-30", "2026-12-07", "2026-12-14", "2026-12-21"], "12월 월요일 수업 4회(첫 수업 11/30)");
  assert.deepEqual(decFri, ["2026-12-04", "2026-12-11", "2026-12-18", "2026-12-25"]);

  const absences = YOON_ABSENCES().map((item) => withMonth(events, item.classId === "mon6" ? "Mon" : "Fri")(item));
  assert.equal(absences.find((item) => item.date === "2026-11-30").month, "2026-12", "11/30 결석의 수강월은 12월");
  const evidence = new Map([
    ["mon6|2026-11", PAID("pay-nov-mon", 105000, novMon)], ["fri6|2026-11", PAID("pay-nov-fri", 90000, novFri)],
    ["mon6|2026-12", UNPAID(decMon)], ["fri6|2026-12", UNPAID(decFri)],
  ]);
  // 12/1 복귀(다시 나오는 날), 오늘 = 12/1
  const result = plan.planIllnessPeriodSettlement({ period: { id: "yoon", startDate: "2026-11-06", returnDate: "2026-12-01" }, absences, evidence, todayYmd: "2026-12-01" });
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.rows.map((row) => [row.month, row.className, row.evidence, row.tuition, row.sessions, row.dates.length, row.unitDisplay, row.subtotal]), [
    // 금요반: 90,000 ÷ 4회 = 22,500 × 4회 = 90,000
    ["2026-11", "금요일 6교시", "PAID_PAYMENT", 90000, 4, 4, 22500, 90000],
    // 월요반: 105,000 ÷ 4회 = 26,250 × 3회(11/9·16·23) = 78,750
    ["2026-11", "월요일 6교시", "PAID_PAYMENT", 105000, 4, 3, 26250, 78750],
    // 12월 수강월(미납): 이월 없음
    ["2026-12", "월요일 6교시", "UNPAID", 0, 4, 1, 0, 0],
  ]);
  assert.equal(result.carryTotal, 168750, "이월 합계 = 90,000 + 78,750");
  // 12월 월요반: 4회 중 첫 1회(11/30)가 빠짐 → 앞쪽 — 수강 시작일을 첫 다닌 날(12/7)로
  assert.deepEqual(result.unpaidGuides, [{
    month: "2026-12", classId: "mon6", className: "월요일 6교시", sessions: 4, attended: 3, missedDates: ["2026-11-30"],
    shape: "PREFIX", periodStart: "2026-12-07", periodEnd: "2026-12-21",
  }]);
  // 그 달 청구 제안: 105,000 − round(105,000 × 3 ÷ 4 = 78,750) = 26,250 차감 → 78,750 청구
  assert.equal(workbench.attendedOnlyProration(105000, 0, 4, 3), 26250);
  assert.equal(plan.unpaidGuideParentText(result.unpaidGuides[0]), "12월 월요일 6교시 수강료는 다닌 3회만큼 다시 안내해요");
});

test("윤수영 — 일정 B(개강·종강 방식 · 11월 = 11/2~11/30): 월요일 수업이 5회라 월요반 4회 84,000원 + 금요반 90,000원 = 174,000원", () => {
  const events = [event("11월 개강", "2026-11-02"), event("11월 종강", "2026-11-30"), event("12월 개강", "2026-12-01"), event("12월 종강", "2026-12-28")];
  const novMon = getMonthlyClassDates(events, "2026-11", "Mon"), novFri = getMonthlyClassDates(events, "2026-11", "Fri");
  assert.deepEqual(novMon, ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"], "11월 월요일 수업 5회");
  assert.deepEqual(novFri, ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"], "11월 금요일 수업 4회");
  const absences = YOON_ABSENCES().map((item) => withMonth(events, item.classId === "mon6" ? "Mon" : "Fri")(item));
  const evidence = new Map([["mon6|2026-11", PAID("pay-nov-mon", 105000, novMon)], ["fri6|2026-11", PAID("pay-nov-fri", 90000, novFri)]]);
  const result = plan.planIllnessPeriodSettlement({ period: { id: "yoon", startDate: "2026-11-06", returnDate: "2026-12-01" }, absences, evidence, todayYmd: "2026-12-01" });
  assert.deepEqual(result.rows.map((row) => [row.className, row.sessions, row.dates.length, row.unitDisplay, row.subtotal]), [
    ["금요일 6교시", 4, 4, 22500, 90000],
    // 105,000 ÷ 5회 = 21,000 × 4회(11/9·16·23·30) = 84,000
    ["월요일 6교시", 5, 4, 21000, 84000],
  ]);
  assert.equal(result.carryTotal, 174000);
  assert.deepEqual(result.unpaidGuides, []);
  assert.deepEqual(result.problems, []);
});

test("윤수영 — 결석 중(복귀 미정)의 «지금까지 예상»: 오늘까지만 세고, 앞으로 올 날짜는 넣지 않는다(문제로도 올리지 않는다)", () => {
  const events = [event("11월 개강", "2026-11-02"), event("11월 종강", "2026-11-30")];
  const novMon = getMonthlyClassDates(events, "2026-11", "Mon"), novFri = getMonthlyClassDates(events, "2026-11", "Fri");
  const evidence = new Map([["mon6|2026-11", PAID("m", 105000, novMon)], ["fri6|2026-11", PAID("f", 90000, novFri)]]);
  // 오늘 = 11/15(일): 지난 결석 = 월 11/9 · 금 11/6·13
  const result = plan.planIllnessPeriodSettlement({ period: { id: "yoon", startDate: "2026-11-06", returnDate: null }, absences: YOON_ABSENCES(), evidence, todayYmd: "2026-11-15" });
  assert.deepEqual(result.rows.map((row) => [row.className, row.dates, row.subtotal]), [
    ["금요일 6교시", ["2026-11-06", "2026-11-13"], 45000],
    ["월요일 6교시", ["2026-11-09"], 21000],
  ]);
  assert.equal(result.carryTotal, 66000);
  assert.ok(result.rows.every((row) => row.excluded.every((item) => item.code === "FUTURE" && item.why === "아직 지나지 않은 날")));
  assert.deepEqual(result.problems, [], "복귀일이 없으면 «예상»이라 확정을 막는 문제가 아니다");
  // 오늘 수업은 포함한다(하루짜리 이월과 같은 기준: 오늘보다 뒤만 뺀다)
  const today = plan.planIllnessPeriodSettlement({ period: { id: "yoon", startDate: "2026-11-06", returnDate: null }, absences: YOON_ABSENCES(), evidence, todayYmd: "2026-11-16" });
  assert.ok(today.rows.find((row) => row.classId === "mon6").dates.includes("2026-11-16"));
});

// ── 경계 사례 ─────────────────────────────────────────────────────────────────────────────

test("달 경계·연말: 11/30·12/1 은 다른 달 줄, 12/31·1/1 은 해가 바뀌어도 수강월대로 — 달마다 그 달 금액·그 달 횟수로 나눈다", () => {
  // 화요반(12/1)·수요반(11/25, 12/30)·목요반(12/31)·금요반(1/1 은 휴무)
  const events = [
    event("11월 개강", "2026-11-02"), event("11월 종강", "2026-11-30"), event("12월 개강", "2026-12-01"), event("12월 종강", "2026-12-31"),
    event("1월 개강", "2027-01-01"), event("1월 종강", "2027-01-30"), event("학원 휴무(신정)", "2027-01-01"),
  ];
  const monNov = getMonthlyClassDates(events, "2026-11", "Mon"), tueDec = getMonthlyClassDates(events, "2026-12", "Tue");
  const thuDec = getMonthlyClassDates(events, "2026-12", "Thu"), friJan = getMonthlyClassDates(events, "2027-01", "Fri");
  assert.equal(monNov.at(-1), "2026-11-30"); assert.equal(tueDec[0], "2026-12-01"); assert.equal(thuDec.at(-1), "2026-12-31");
  assert.deepEqual(friJan, ["2027-01-08", "2027-01-15", "2027-01-22", "2027-01-29"], "1/1(금)은 휴무라 1월 금요일 수업은 4회");
  const absences = [
    withMonth(events, "Mon")(absence("mon", "월요반", "2026-11-30")), withMonth(events, "Tue")(absence("tue", "화요반", "2026-12-01")),
    withMonth(events, "Thu")(absence("thu", "목요반", "2026-12-31")), withMonth(events, "Fri")(absence("fri", "금요반", "2027-01-01")),
    withMonth(events, "Fri")(absence("fri", "금요반", "2027-01-08")),
  ];
  assert.deepEqual(absences.map((item) => item.month), ["2026-11", "2026-12", "2026-12", "2027-01", "2027-01"]);
  const evidence = new Map([
    ["mon|2026-11", PAID("p1", 100000, monNov)], ["tue|2026-12", PAID("p2", 100000, tueDec)],
    ["thu|2026-12", PAID("p3", 100000, thuDec)], ["fri|2027-01", PAID("p4", 80000, friJan)],
  ]);
  const result = plan.planIllnessPeriodSettlement({ period: { id: "p", startDate: "2026-11-30", returnDate: "2027-01-15" }, absences, evidence, todayYmd: "2027-01-15" });
  assert.deepEqual(result.rows.map((row) => [row.month, row.className, row.sessions, row.dates, row.subtotal]), [
    ["2026-11", "월요반", 5, ["2026-11-30"], 20000],   // 100,000 ÷ 5
    ["2026-12", "목요반", 5, ["2026-12-31"], 20000],   // 12월 목요일 3·10·17·24·31 = 5회
    ["2026-12", "화요반", 5, ["2026-12-01"], 20000],   // 12월 화요일 1·8·15·22·29 = 5회
    ["2027-01", "금요반", 4, ["2027-01-08"], 20000],   // 80,000 ÷ 4
  ]);
  // 휴무일(1/1)에 잡힌 결석은 수업일이 아니라 값을 매기지 않는다
  assert.deepEqual(result.rows.at(-1).excluded.map((item) => [item.date, item.code]), [["2027-01-01", "NOT_CLASS_DAY"]]);
  assert.equal(result.carryTotal, 80000);
});

test("휴무가 낀 달: 휴무일은 수업 횟수에서 빠져 한 번 값이 커진다 / 3회 달은 3회 달 차감 후 낸 금액 ÷ 3 = 4회 달 한 번 값과 같다", () => {
  // 토요반. 10월: 10/3·10·17·24 중 10/10 휴무 → 3회
  const events = [event("10월 개강", "2026-10-03"), event("10월 종강", "2026-10-24"), event("학원 휴무", "2026-10-10"), event("11월 개강", "2026-11-07"), event("11월 종강", "2026-11-28")];
  const oct = getMonthlyClassDates(events, "2026-10", "Sat"), nov = getMonthlyClassDates(events, "2026-11", "Sat");
  assert.deepEqual(oct, ["2026-10-03", "2026-10-17", "2026-10-24"]); assert.equal(nov.length, 4);
  // 정가 100,000원. 3회 달은 25,000원 빼고 75,000원을 낸다(기존 규칙 shortMonthProration)
  assert.equal(workbench.shortMonthProration(100000, 3), 25000);
  const evidence = new Map([["sat|2026-10", PAID("oct", 75000, oct)], ["sat|2026-11", PAID("nov", 100000, nov)]]);
  const result = plan.planIllnessPeriodSettlement({
    period: { id: "p", startDate: "2026-10-17", returnDate: "2026-11-14" },
    absences: [absence("sat", "토요반", "2026-10-17"), absence("sat", "토요반", "2026-10-24"), absence("sat", "토요반", "2026-11-07")],
    evidence, todayYmd: "2026-11-14",
  });
  assert.deepEqual(result.rows.map((row) => [row.month, row.sessions, row.unitDisplay, row.subtotal]), [["2026-10", 3, 25000, 50000], ["2026-11", 4, 25000, 25000]]);
  assert.equal(result.rows[0].unitDisplay, result.rows[1].unitDisplay, "3회 달과 4회 달의 한 번 값이 같다");
  assert.equal(result.carryTotal, 75000);
});

test("반올림: 결석 한 건 = 분수 하나, 합계는 모두 더해 한 번만 반올림 — 소계 합과 합계 차이는 1원 이내, 달 소계는 그 달 낸 금액을 넘지 않는다", () => {
  const dates = (month) => [`${month}-07`, `${month}-14`, `${month}-21`];
  const evidence = new Map([["c|2026-10", PAID("a", 100000, dates("2026-10"))], ["c|2026-11", PAID("b", 100000, dates("2026-11"))]]);
  const result = plan.planIllnessPeriodSettlement({
    period: { id: "p", startDate: "2026-10-07", returnDate: "2026-12-01" },
    absences: [absence("c", "반", "2026-10-07"), absence("c", "반", "2026-11-07")], evidence, todayYmd: "2026-12-01",
  });
  // 100,000 ÷ 3 = 33,333.33… → 줄마다 33,333 / 합계는 66,666.67 → 66,667
  assert.deepEqual(result.rows.map((row) => row.subtotal), [33333, 33333]);
  assert.equal(result.carryTotal, 66667);
  assert.equal(result.carryTotal, workbench.roundCarryTotal([{ numerator: "100000", denominator: "3" }, { numerator: "100000", denominator: "3" }]), "기존 이월 합계 함수와 같은 값");
  assert.ok(Math.abs(result.rows.reduce((sum, row) => sum + row.subtotal, 0) - result.carryTotal) <= 1);
  // 한 달을 전부 빠져도 소계는 그 달 낸 금액과 같다(넘지 않는다)
  const whole = plan.planIllnessPeriodSettlement({
    period: { id: "p", startDate: "2026-10-07", returnDate: "2026-12-01" },
    absences: dates("2026-10").map((date) => absence("c", "반", date)), evidence, todayYmd: "2026-12-01",
  });
  assert.equal(whole.rows[0].subtotal, 100000); assert.equal(whole.carryTotal, 100000);
  // 금액·횟수를 바꿔 가며: 달 소계 ≤ 낸 금액, |소계 합 − 합계| ≤ ⌈줄 수 ÷ 2⌉
  for (const [tuition, sessions] of [[105000, 4], [90000, 4], [100001, 3], [77777, 5], [1, 3], [0, 4]]) {
    const scheduled = Array.from({ length: sessions }, (_, index) => `2026-10-${String(index + 1).padStart(2, "0")}`);
    for (let missed = 1; missed <= sessions; missed += 1) {
      const two = new Map([["c|2026-10", PAID("a", tuition, scheduled)], ["d|2026-10", PAID("b", tuition, scheduled)]]);
      const made = plan.planIllnessPeriodSettlement({
        period: { id: "p", startDate: "2026-10-01", returnDate: "2026-11-01" }, todayYmd: "2026-11-01", evidence: two,
        absences: [...scheduled.slice(0, missed).map((date) => absence("c", "가", date)), ...scheduled.slice(0, missed).map((date) => absence("d", "나", date))],
      });
      for (const row of made.rows) assert.ok(row.subtotal <= tuition, `${tuition}/${sessions} ${missed}회`);
      assert.ok(Math.abs(made.rows.reduce((sum, row) => sum + row.subtotal, 0) - made.carryTotal) <= 1, `${tuition}/${sessions} ${missed}회`);
    }
  }
});

test("근거 규칙: 발행 초안도 «납부된 것만» — 미납 초안·청구 전은 낸 돈이 없는 달, 납부 2건은 차단, 0원 발행은 인정(하루짜리와 같은 함수)", () => {
  const payload = { baseAmount: 100000, discountAmount: 10000, prorationAmount: 0, carryAmount: 0, shuttleAmount: 20000 };
  const draft = (status, paymentStatus) => ({ status, payload, paymentId: status === "ZERO" ? null : "pay", paymentStatus, periodStart: null, periodEnd: null, scheduledDates: [] });
  const monthDates = ["2026-11-07", "2026-11-14", "2026-11-21", "2026-11-28"];
  const of = (issuedDraft, paidPayments = []) => evidenceRules.resolveMonthEvidence({ issuedDraft, paidPayments, monthDates, enrollmentStartsOn: null });
  // 납부된 발행 초안: 수강료 − 할인 − 기간 조정(셔틀·이월 제외)
  assert.deepEqual([of(draft("ISSUED", "PAID")).kind, of(draft("ISSUED", "PAID")).tuition], ["WORKBENCH_ISSUED", 90000]);
  // 발행됐지만 미납·연체 → 낸 돈이 없는 달
  assert.equal(of(draft("ISSUED", "PENDING")).kind, "UNPAID");
  assert.equal(of(draft("ISSUED", "OVERDUE")).kind, "UNPAID");
  assert.equal(of(null).kind, "UNPAID", "청구 전");
  assert.equal(of(draft("ZERO", null)).kind, "WORKBENCH_ISSUED", "0원 발행(이월로 다 낸 달)은 근거로 인정");
  assert.equal(of(null, [{ id: "a", amount: 90000, priorReduction: 0 }, { id: "b", amount: 90000, priorReduction: 0 }]).kind, "BLOCKED");
  // 하루짜리 이월의 적립부도 같은 규칙: 발행 초안의 청구가 납부완료가 아니면 거절한다(이미 적립된 이월의 유효성 판정은 건드리지 않는다)
  const absenceSource = read("src/lib/billing/workbench-absence.ts");
  assert.match(absenceSource, /if\(p\.status!=="PAID"\) throw new WorkbenchError\(CARRY_UNPAID_MESSAGE,409\);/);
  assert.match(absenceSource, /export const CARRY_UNPAID_MESSAGE = "원기간 수강료가 아직 납부되지 않았습니다\. 납부된 뒤에 이월할 수 있습니다\.";/);
  // 미납 검사는 «청구·납부 정본 불일치» 검사 뒤, 납부 Payment 근거 갈래 앞
  assert.ok(absenceSource.indexOf("원기간 청구·납부 정본이 일치하지 않습니다") < absenceSource.indexOf('if(p.status!=="PAID")'));
  assert.ok(absenceSource.indexOf('if(p.status!=="PAID")') < absenceSource.indexOf("if(!issuedRow && !registeredRow) {"));
  // 청구 준비의 «이미 적립된 이월» 유효성 판정은 납부 여부를 보지 않는다(취소·환불만 무효) — 예전에 미납 초안으로 적립한 이월이 깨지지 않게
  const service = read("src/lib/billing/workbench-service.ts");
  assert.match(service, /if\(!p\|\|!issued\|\|p\.amount!==workbenchTotal\(issued\.payload\)\|\|!invoice\|\|invoice\.amount!==p\.amount\|\|\["CANCELED","CANCELLED","REFUNDED"\]\.includes\(p\.status\)/);
  // 신청함 하루짜리 상세: 미납이면 «납부한 뒤에 승인» 안내로(서버 문구를 그대로 띄우지 않는다)
  assert.match(read("src/lib/regular/illness-carry-admin.ts"), /\} else if \(preview\.reason === CARRY_UNPAID_MESSAGE\) \{[\s\S]{0,160}bill = "UNPAID";/);
});

test("제외 사유: 보강 완료·보강 예약 중·출석 기록·하루씩 이미 결정된 날·휴원 정산·수업일 아님·원장이 뺀 날 — 이유와 함께 빠지고 금액에 들지 않는다", () => {
  const scheduled = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"];
  const evidence = new Map([["m|2026-11", PAID("p", 100000, scheduled)]]);
  const list = [
    absence("m", "월요반", "2026-11-02", { absenceId: "ok" }),
    absence("m", "월요반", "2026-11-09", { absenceId: "used", creditStatus: "USED" }),
    absence("m", "월요반", "2026-11-16", { absenceId: "booked", bookingStatus: "BOOKED" }),
    absence("m", "월요반", "2026-11-23", { absenceId: "present", attendance: "LATE" }),
    absence("m", "월요반", "2026-11-30", { absenceId: "resolved", alreadyResolved: "CARRY" }),
    absence("m", "월요반", "2026-11-03", { absenceId: "holiday" }),
    absence("m", "월요반", "2026-11-10", { absenceId: "cancelled", status: "CANCELLED" }),
  ];
  const result = plan.planIllnessPeriodSettlement({ period: { id: "p", startDate: "2026-11-02", returnDate: "2026-12-01" }, absences: list, evidence, todayYmd: "2026-12-01" });
  assert.deepEqual(result.rows[0].absenceIds, ["ok"]);
  assert.equal(result.carryTotal, 20000);
  assert.deepEqual(Object.fromEntries(result.rows[0].excluded.map((item) => [item.absenceId, item.why])), {
    holiday: "수업일 아님(휴무·수강 기간 밖)", used: "보강 완료", booked: "보강 예약 중", present: "출석 기록 있음", resolved: "이미 처리됨",
  });
  assert.ok(!JSON.stringify(result).includes("cancelled"), "취소된 결석은 표에 오르지 않는다");
  // 그 밖의 값들: 보강 불참·보강 출석·예약된 보강권·출석(PRESENT)·보강권으로 결정·휴원 정산
  const code = (extra) => plan.planIllnessPeriodSettlement({
    period: { id: "p", startDate: "2026-11-02", returnDate: "2026-12-01" }, evidence, todayYmd: "2026-12-01", absences: [absence("m", "월요반", "2026-11-02", extra)],
  }).rows[0].excluded[0]?.code ?? null;
  assert.deepEqual([code({ creditStatus: "NO_SHOW" }), code({ bookingStatus: "ATTENDED" }), code({ bookingStatus: "NO_SHOW" })], ["MAKEUP_DONE", "MAKEUP_DONE", "MAKEUP_DONE"]);
  assert.equal(code({ creditStatus: "RESERVED" }), "MAKEUP_BOOKED");
  assert.equal(code({ attendance: "PRESENT" }), "ATTENDED");
  assert.equal(code({ alreadyResolved: "MAKEUP" }), "RESOLVED");
  assert.equal(code({ pauseSettled: true }), "PAUSE");
  // 넣는 것: 결석 기록·기록 없음·미사용/만료/거둔 보강권
  for (const extra of [{ attendance: "ABSENT" }, { creditStatus: "AVAILABLE" }, { creditStatus: "EXPIRED" }, { creditStatus: "REVOKED" }, { status: "REPORTED" }]) assert.equal(code(extra), null, JSON.stringify(extra));
  // 원장이 뺀 날 — 다른 이유가 있으면 그 이유가 먼저다(뺀 날 표시는 넣을 수 있는 날에만)
  const omitted = plan.planIllnessPeriodSettlement({ period: { id: "p", startDate: "2026-11-02", returnDate: "2026-12-01" }, absences: list, evidence, todayYmd: "2026-12-01", omitAbsenceIds: ["ok", "used"] });
  assert.deepEqual(omitted.rows[0].excluded.filter((item) => ["ok", "used"].includes(item.absenceId)).map((item) => [item.absenceId, item.code]), [["ok", "OMITTED"], ["used", "MAKEUP_DONE"]]);
  assert.equal(omitted.carryTotal, 0);
});

test("복귀일: 복귀일(다시 나오는 날) 이후 결석은 표에 오르지 않는다 / 복귀일 전에 아직 지나지 않은 결석이 남아 있으면 확정을 막는다", () => {
  const scheduled = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"];
  const evidence = new Map([["m|2026-11", PAID("p", 100000, scheduled)]]);
  const all = scheduled.map((date) => absence("m", "월요반", date));
  const of = (returnDate, todayYmd) => plan.planIllnessPeriodSettlement({ period: { id: "p", startDate: "2026-11-02", returnDate }, absences: all, evidence, todayYmd });
  // 11/16 복귀 → 11/2·11/9 만
  const returned = of("2026-11-16", "2026-11-16");
  assert.deepEqual(returned.rows[0].dates, ["2026-11-02", "2026-11-09"]);
  assert.deepEqual(returned.rows[0].excluded, [], "복귀일 이후는 «제외»로도 보이지 않는다(복귀 처리 전 미리보기와 후 확정의 표가 같다)");
  assert.deepEqual(returned.problems, []);
  // 복귀 처리 «전»(결석 5건 살아 있음)과 «후»(복귀일 이후 2건 취소됨)의 지문이 같다
  const after = plan.planIllnessPeriodSettlement({ period: { id: "p", startDate: "2026-11-02", returnDate: "2026-11-16" }, absences: all.slice(0, 2), evidence, todayYmd: "2026-11-16" });
  assert.equal(plan.settlementFingerprint({ id: "p", returnDate: "2026-11-16" }, returned), plan.settlementFingerprint({ id: "p", returnDate: "2026-11-16" }, after));
  // 11/24 복귀 예정인데 오늘은 11/10 → 11/16·11/23 이 아직 안 지남 → 확정 차단
  const early = of("2026-11-24", "2026-11-10");
  assert.deepEqual(early.problems.map((problem) => problem.code), ["FUTURE"]);
  assert.match(early.problems[0].text, /아직 지나지 않은 결석이 2회 있습니다\. 마지막 결석일\(2026-11-23\)이 지난 뒤 확정해 주세요\./);
});

test("낸 돈이 없는 달: 전부 빠짐 → 청구 0원 / 앞쪽 빠짐 → 수강 시작일 제안 / 뒤쪽 빠짐 → 수강 종료일 제안 / 가운데만 빠짐 → 자동 제안 없음", () => {
  const scheduled = ["2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28"];
  const guideOf = (missed) => plan.planIllnessPeriodSettlement({
    period: { id: "p", startDate: "2026-12-07", returnDate: "2027-01-04" }, todayYmd: "2027-01-04",
    absences: missed.map((date) => absence("m", "월요반", date)), evidence: new Map([["m|2026-12", UNPAID(scheduled)]]),
  });
  const whole = guideOf(scheduled);
  assert.equal(whole.carryTotal, 0, "낸 돈이 없는 달은 이월을 만들지 않는다");
  assert.deepEqual([whole.unpaidGuides[0].shape, whole.unpaidGuides[0].attended, whole.unpaidGuides[0].periodStart], ["WHOLE", 0, null]);
  assert.equal(plan.unpaidGuideParentText(whole.unpaidGuides[0]), "12월 월요반 수강료는 다닌 수업이 없어 청구하지 않아요");
  const prefix = guideOf(scheduled.slice(0, 2)).unpaidGuides[0];
  assert.deepEqual([prefix.shape, prefix.attended, prefix.periodStart, prefix.periodEnd], ["PREFIX", 2, "2026-12-21", "2026-12-28"]);
  const suffix = guideOf(scheduled.slice(3)).unpaidGuides[0];
  assert.deepEqual([suffix.shape, suffix.attended, suffix.periodStart, suffix.periodEnd], ["SUFFIX", 3, "2026-12-07", "2026-12-21"]);
  const middle = guideOf([scheduled[1]]).unpaidGuides[0];
  assert.deepEqual([middle.shape, middle.attended, middle.periodStart, middle.periodEnd], ["MIDDLE", 3, null, null]);
  assert.match(plan.unpaidGuideAdminText(middle), /다닌 3회만 청구\(달 가운데가 빠져 수강 기간은 그대로, 기간 조정 금액으로 제안\)/);
  assert.match(plan.unpaidGuideAdminText(prefix), /12월 월요반 · 4회 중 2회 결석 → 다닌 2회만 청구\(수강 시작일 2026-12-21 제안\)/);
  // 모양 판정(순수 함수) — 청구 준비도 같은 함수로 지금 일정에 맞춰 다시 본다
  assert.equal(rules.unpaidGuideShape(scheduled, []).shape, "NONE");
  assert.equal(rules.unpaidGuideShape(scheduled, ["2026-12-01"]).shape, "NONE", "수업일이 아닌 날은 빠진 날로 세지 않는다");
  assert.equal(rules.unpaidGuideShape(scheduled, [scheduled[0], scheduled[3]]).shape, "MIDDLE", "앞뒤가 모두 빠지면 기간 하나로 나타낼 수 없다");
  // 다닌 횟수만큼만 청구할 때의 기간 조정 금액: 한 번 값 = (할인 후 − 3회 달 차감) ÷ 수업 횟수
  assert.equal(workbench.attendedOnlyProration(105000, 0, 4, 0), 105000, "전부 빠짐 → 전액 차감(청구 0원)");
  assert.equal(workbench.attendedOnlyProration(105000, 0, 4, 2), 52500);
  assert.equal(workbench.attendedOnlyProration(105000, 0, 4, 4), 0, "다 다녔으면 차감 없음");
  // 3회 달(정가 100,000 → 25,000 차감 후 75,000): 3회 중 1회 다님 → 25,000 청구 → 기간 조정 75,000
  assert.equal(workbench.attendedOnlyProration(100000, 25000, 3, 1), 75000);
  assert.equal(100000 - workbench.attendedOnlyProration(100000, 25000, 3, 1), 25000, "한 번 값이 4회 달(100,000 ÷ 4)과 같다");
  assert.equal(workbench.attendedOnlyProration(100000, 0, 0, 0), 0, "수업 0회 달은 계산하지 않는다");
});

test("근거를 정할 수 없는 달·수업 0회 달: 넣을 날이 있으면 확정을 막고, 그 달 날짜를 모두 빼면 막지 않는다", () => {
  const scheduled = ["2026-11-02", "2026-11-09"];
  const blocked = new Map([["m|2026-11", { kind: "BLOCKED", reason: evidenceRules.CARRY_EVIDENCE_MULTIPLE_PAID }], ["f|2026-11", PAID("p", 80000, ["2026-11-06", "2026-11-13"])]]);
  const absences = [absence("m", "월요반", "2026-11-02", { absenceId: "m1" }), absence("f", "금요반", "2026-11-06", { absenceId: "f1" })];
  const input = { period: { id: "p", startDate: "2026-11-02", returnDate: "2026-11-20" }, absences, evidence: blocked, todayYmd: "2026-11-20" };
  const stuck = plan.planIllnessPeriodSettlement(input);
  assert.deepEqual(stuck.problems.map((problem) => problem.code), ["EVIDENCE"]);
  assert.match(stuck.problems[0].text, /^11월 월요반: 같은 반·같은 달에 납부된 수강료 청구가 여러 건입니다/);
  assert.equal(stuck.rows.find((row) => row.classId === "m").evidence, "BLOCKED");
  assert.equal(stuck.carryTotal, 40000, "정할 수 있는 달만 합계에 든다");
  const freed = plan.planIllnessPeriodSettlement({ ...input, omitAbsenceIds: ["m1"] });
  assert.deepEqual(freed.problems, []);
  // 근거가 아예 없는 반·달(읽지 못함)도 같은 취급
  const missing = plan.planIllnessPeriodSettlement({ ...input, evidence: new Map([["f|2026-11", blocked.get("f|2026-11")]]) });
  assert.deepEqual(missing.problems.map((problem) => problem.code), ["EVIDENCE"]);
  // 수업 0회 달(연간 일정에 그 달 수업일이 없다)
  const none = plan.planIllnessPeriodSettlement({ ...input, evidence: new Map([["m|2026-11", { kind: "UNPAID", scheduledDates: [] }], ["f|2026-11", blocked.get("f|2026-11")]]) });
  assert.deepEqual(none.problems.map((problem) => problem.code), ["NO_SESSIONS"]);
  assert.equal(scheduled.length, 2);
});

test("지문: 날짜를 빼면 바뀌고 다시 넣으면 처음과 같다 — 결석 취소·근거 금액·복귀일·기간이 달라져도 바뀐다", () => {
  const scheduled = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"];
  const absences = scheduled.map((date, index) => absence("m", "월요반", date, { absenceId: `d${index}` }));
  const make = (extra = {}) => {
    const input = { period: { id: "p", startDate: "2026-11-02", returnDate: "2026-12-01" }, absences, evidence: new Map([["m|2026-11", PAID("pay", 100000, scheduled)]]), todayYmd: "2026-12-01", ...extra };
    return plan.settlementFingerprint({ id: input.period.id, returnDate: input.period.returnDate }, plan.planIllnessPeriodSettlement(input));
  };
  const base = make();
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(make(), base, "같은 입력이면 같은 지문");
  assert.notEqual(make({ omitAbsenceIds: ["d1"] }), base, "날짜 빼기");
  assert.equal(make({ omitAbsenceIds: [] }), base, "다시 넣으면 처음과 같다");
  assert.notEqual(make({ absences: absences.slice(0, 3) }), base, "미리보기 뒤 결석 하나 취소");
  assert.notEqual(make({ evidence: new Map([["m|2026-11", PAID("pay", 90000, scheduled)]]) }), base, "근거 금액 변경");
  assert.notEqual(make({ evidence: new Map([["m|2026-11", PAID("pay", 100000, scheduled.slice(0, 3))]]) }), base, "수업 횟수 변경(휴강 추가)");
  assert.notEqual(make({ absences: absences.map((item, index) => (index === 0 ? { ...item, attendance: "PRESENT" } : item)) }), base, "출석 정정");
  assert.notEqual(make({ period: { id: "p", startDate: "2026-11-02", returnDate: "2026-11-20" } }), base, "복귀일 변경");
  assert.notEqual(make({ period: { id: "other", startDate: "2026-11-02", returnDate: "2026-12-01" } }), base, "다른 기간");
});

test("학부모 미리보기 = 원장 미리보기의 같은 숫자 — 달별 소계·합계가 같고, 근거를 정할 수 없으면 금액을 보이지 않는다", () => {
  const novMon = ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"], novFri = ["2026-11-06", "2026-11-13", "2026-11-20", "2026-11-27"];
  const decMon = ["2026-12-07", "2026-12-14", "2026-12-21", "2026-12-28"];
  const evidence = new Map([["mon6|2026-11", PAID("m", 105000, novMon)], ["fri6|2026-11", PAID("f", 90000, novFri)], ["mon6|2026-12", UNPAID(decMon)]]);
  const absences = [...YOON_ABSENCES(), absence("mon6", "월요일 6교시", "2026-12-07")];
  const admin = plan.planIllnessPeriodSettlement({ period: { id: "yoon", startDate: "2026-11-06", returnDate: "2026-12-14" }, absences, evidence, todayYmd: "2026-12-14" });
  const parent = plan.parentSettlementView(admin);
  assert.equal(parent.pendingCheck, false);
  assert.equal(parent.total, admin.carryTotal);
  assert.equal(parent.total, 174000);
  assert.deepEqual(parent.months, admin.rows.filter((row) => row.evidence === "PAID_PAYMENT").map((row) => ({ month: row.month, className: row.className, missed: row.dates.length, subtotal: row.subtotal })));
  assert.deepEqual(parent.months.map((row) => [row.month, row.className, row.missed, row.subtotal]), [["2026-11", "금요일 6교시", 4, 90000], ["2026-11", "월요일 6교시", 4, 84000]]);
  assert.deepEqual(parent.unpaid.map((row) => row.text), ["12월 월요일 6교시 수강료는 다닌 3회만큼 다시 안내해요"]);
  // 근거를 정할 수 없는 달이 하나라도 있으면 숫자를 보이지 않는다(틀린 숫자를 보이지 않는다)
  const blocked = plan.planIllnessPeriodSettlement({
    period: { id: "yoon", startDate: "2026-11-06", returnDate: "2026-12-14" }, absences, todayYmd: "2026-12-14",
    evidence: new Map([["mon6|2026-11", { kind: "BLOCKED", reason: "직접 확인" }], ["fri6|2026-11", PAID("f", 90000, novFri)], ["mon6|2026-12", UNPAID(decMon)]]),
  });
  assert.deepEqual(plan.parentSettlementView(blocked), { pendingCheck: true, total: null, months: [], unpaid: [] });
  assert.equal(rules.PERIOD_SETTLE_PARENT_PENDING_CHECK, "학원에서 확인한 뒤 알려 드려요.");
  // 아직 안 지난 결석이 남은 것(FUTURE)은 금액을 가리지 않는다 — 오늘까지 기준의 예정 금액
  const future = plan.planIllnessPeriodSettlement({ period: { id: "yoon", startDate: "2026-11-06", returnDate: "2026-12-14" }, absences, evidence, todayYmd: "2026-11-15" });
  assert.equal(plan.parentSettlementView(future).pendingCheck, false);
  assert.equal(plan.parentSettlementView(future).total, 66000);
});

test("순수 모듈: DB·시계·외부 호출이 없고, 식은 이 파일 한 곳 — 연결부·화면은 금액을 다시 계산하지 않는다", () => {
  const source = read("src/lib/regular/illnessPeriodSettlementPlan.ts");
  assert.doesNotMatch(source, /prisma|\$queryRaw|\$executeRaw|Date\.now\(|new Date\(|fetch\(|process\.env/);
  // 날짜는 글자 비교만(금지 패턴 없음)
  assert.doesNotMatch(source, /toISOString\(\)|getDay\(\)|getDate\(\)|getHours\(\)|getUTCDay\(\)/);
  assert.match(source, /import \{ roundCarryTotal \} from "@\/lib\/billing\/workbench";/, "합계는 기존 이월 합계 함수 재사용");
  // 연결부: 금액은 계산 함수의 결과만 쓴다(tuition × … 같은 식이 없다) · 원장·학부모·확정이 같은 읽기 함수
  const service = read("src/lib/regular/illness-period-settlement.ts");
  assert.equal((service.match(/planIllnessPeriodSettlement\(/g) ?? []).length, 1, "계산 호출은 한 곳");
  assert.equal((service.match(/await readSettlementPlan\(/g) ?? []).length, 3, "미리보기·확정·학부모 미리보기가 같은 읽기 함수");
  assert.doesNotMatch(service, /Math\.round|tuition \*|\/ sessions/);
  // 화면: 금액을 계산하지 않는다(받은 숫자를 그대로 보인다)
  for (const path of ["src/app/admin/inbox/IllnessPeriodSettlementBox.tsx", "src/app/mypage/regular-absence/PeriodAbsencePanel.tsx"]) {
    assert.doesNotMatch(read(path), /Math\.round|roundCarryTotal|planIllnessPeriodSettlement/, path);
  }
});
