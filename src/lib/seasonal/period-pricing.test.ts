import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { dateSelectTuition, distinctPeriods, offeringWeeklyFrequency, resolvePeriodPrice, resolvePeriodShuttleFee } from "./period-pricing.ts";

// 4주 주2회 기간 상품(신규 240,000 · 재원 200,000), 셔틀비는 반 값을 따른다(NULL)
const fourWeeks = {
  label: "4주(1/4~1/29)", startDate: "2027-01-04", endDate: "2027-01-29",
  price: 240000, newApplicantPrice: 240000, existingApplicantPrice: 200000, shuttleFee: null,
};

test("기간 수강료: 4주 주2회 신규 240,000 / 재원 200,000, 판정 전은 기본가", () => {
  assert.equal(resolvePeriodPrice(fourWeeks, "NEW"), 240000);
  assert.equal(resolvePeriodPrice(fourWeeks, "EXISTING"), 200000);
  assert.equal(resolvePeriodPrice(fourWeeks), 240000);
  // 재원가가 비어 있으면 기본가
  assert.equal(resolvePeriodPrice({ ...fourWeeks, existingApplicantPrice: null }, "EXISTING"), 240000);
});

test("기간 셔틀비: NULL 이면 반 셔틀비, 기간 값이 있으면 그 값, 무료 거점·미신청·셔틀 불가 반은 0", () => {
  const offering = { shuttleAvailable: true, shuttleFee: 40000 };
  assert.equal(resolvePeriodShuttleFee(fourWeeks, offering, true), 40000);
  assert.equal(resolvePeriodShuttleFee({ shuttleFee: 30000 }, offering, true), 30000);
  assert.equal(resolvePeriodShuttleFee(fourWeeks, offering, true, true), 0);
  assert.equal(resolvePeriodShuttleFee(fourWeeks, offering, false), 0);
  assert.equal(resolvePeriodShuttleFee({ shuttleFee: 30000 }, { shuttleAvailable: false, shuttleFee: 40000 }, true), 0);
});

test("날짜 선택: 5회 재원 25,000 → 125,000 · 4회 신규 30,000 → 120,000", () => {
  const season = { perSessionNewPrice: 30000, perSessionExistingPrice: 25000, minSessionCount: 4 };
  assert.deepEqual(dateSelectTuition(5, season, "EXISTING"), { unitPrice: 25000, tuition: 125000 });
  assert.deepEqual(dateSelectTuition(4, season, "NEW"), { unitPrice: 30000, tuition: 120000 });
  // 판정 전은 재원가가 아니라 신규 단가
  assert.deepEqual(dateSelectTuition(4, season), { unitPrice: 30000, tuition: 120000 });
  // 재원 단가가 없으면 신규 단가
  assert.deepEqual(dateSelectTuition(4, { ...season, perSessionExistingPrice: null }, "EXISTING"), { unitPrice: 30000, tuition: 120000 });
});

test("날짜 선택: 최소 4회에 3회는 거절", () => {
  const season = { perSessionNewPrice: 30000, perSessionExistingPrice: 25000, minSessionCount: 4 };
  assert.throws(() => dateSelectTuition(3, season, "NEW"), (error: { code?: string; status?: number }) => {
    assert.equal(error.code, "DATE_SELECT_MIN_COUNT");
    assert.equal(error.status, 400);
    return true;
  });
  // 0회도 거절(최소 횟수 미설정이어도 1회 이상)
  assert.throws(() => dateSelectTuition(0, { perSessionNewPrice: 30000 }), { code: "DATE_SELECT_MIN_COUNT" });
});

test("날짜 선택: 단가 미설정은 거절", () => {
  assert.throws(() => dateSelectTuition(4, { minSessionCount: 1 }, "NEW"), { code: "DATE_SELECT_PRICE_NOT_CONFIGURED" });
  // 신규 단가가 없으면 판정 전 신청도 거절(재원가로 받지 않는다)
  assert.throws(() => dateSelectTuition(4, { perSessionExistingPrice: 25000 }), { code: "DATE_SELECT_PRICE_NOT_CONFIGURED" });
});

test("distinctPeriods: 반이 달라도 같은 범위는 하나로, 꺼진 기간은 빼고 순서대로", () => {
  const list = distinctPeriods([
    { periods: [fourWeeks, { ...fourWeeks, label: "3주(1/11~1/29)", startDate: "2027-01-11", displayOrder: 1 }] },
    { periods: [{ ...fourWeeks, price: 120000 }, { ...fourWeeks, label: "꺼진 기간", startDate: "2027-01-18", isActive: false }] },
    { periods: null },
  ]);
  assert.deepEqual(list.map((p: { label: string }) => p.label), ["4주(1/4~1/29)", "3주(1/11~1/29)"]);
});

test("offeringWeeklyFrequency: 이름의 «주N회»·코드 끝 «-N» 을 읽는다", () => {
  assert.equal(offeringWeeklyFrequency({ title: "슈팅 주2회", code: "SHOOT" }), 2);
  assert.equal(offeringWeeklyFrequency({ title: "드리블", code: "DRB-3" }), 3);
  assert.equal(offeringWeeklyFrequency({ title: "체험", code: "TRY" }), null);
});
