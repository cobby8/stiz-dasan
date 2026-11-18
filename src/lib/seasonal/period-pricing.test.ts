import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import * as pricing from "./period-pricing.ts";
// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { kstAt } from "../datetime/kst.ts";

const { distinctPeriods, isPeriodClosed, offeringWeeklyFrequency, periodClosedError, resolvePeriodPrice, resolvePeriodShuttleFee, weeklyFrequencyLabel } = pricing;

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

test("회당 단가 계산(dateSelectTuition)은 없앴다 — 날짜로 골라도 기간 가격 규칙 하나", () => {
  assert.equal(typeof (pricing as Record<string, unknown>).dateSelectTuition, "undefined");
});

test("기간 마감: 1/1(금) 18:00 KST 마감 — 17:59:59 는 받고 18:00:00 부터 닫힌다", () => {
  // 18:00 KST = 09:00 UTC. 9시간 함정 없이 kstAt 으로 만든다.
  const closesAt = new Date(kstAt("2027-01-01", "18:00"));
  assert.equal(closesAt.toISOString(), "2027-01-01T09:00:00.000Z");
  const period = { applicationClosesAt: closesAt };
  assert.equal(isPeriodClosed(period, kstAt("2027-01-01", "17:59") + 59_000), false);
  assert.equal(isPeriodClosed(period, kstAt("2027-01-01", "18:00")), true);
  assert.equal(isPeriodClosed(period, kstAt("2027-01-02")), true);
  // 문자열(ISO)도 같게
  assert.equal(isPeriodClosed({ applicationClosesAt: "2027-01-01T09:00:00.000Z" }, kstAt("2027-01-01", "18:00") - 1), false);
  // 마감 시각이 없으면 시즌 마감을 따른다 → 여기서는 열림
  assert.equal(isPeriodClosed({ applicationClosesAt: null }, kstAt("2030-01-01")), false);
  assert.equal(isPeriodClosed({}, kstAt("2030-01-01")), false);
  const error = periodClosedError("4주");
  assert.equal(error.code, "PERIOD_CLOSED");
  assert.equal(error.status, 409);
});

test("distinctPeriods: 같은 범위의 마감 시각은 가장 이른 값", () => {
  const list = distinctPeriods([
    { periods: [{ ...fourWeeks, applicationClosesAt: "2027-01-01T09:00:00.000Z" }] },
    { periods: [{ ...fourWeeks, applicationClosesAt: new Date("2026-12-31T09:00:00.000Z") }, { ...fourWeeks, label: "3주", startDate: "2027-01-11", displayOrder: 1 }] },
  ]);
  assert.equal(list[0].applicationClosesAt, "2026-12-31T09:00:00.000Z");
  assert.equal(list[1].applicationClosesAt, null);
});

test("주N회 이름: 5회는 «매일(주5회)»", () => {
  assert.equal(weeklyFrequencyLabel(2), "주2회");
  assert.equal(weeklyFrequencyLabel(5), "매일(주5회)");
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
