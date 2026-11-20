// 방학특강 신청 판단(기간 가격 선택·제목 스냅샷·요일 채우기·날짜 검사) 실행 테스트(2026-11-18).
import assert from "node:assert/strict";
import test from "node:test";
import {
  activePeriods,
  assertPeriodHasWeekdays,
  assertSelectableDates,
  datesFullMessage,
  fullDateKeysFromOccupancy,
  itemTitleSnapshot,
  peakOccupancy,
  occupiedDateKeys,
  pickOfferingPeriod,
  stripWeeklyFrequency,
  weekdaysFromDates,
  ymdKoreanLabel,
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
} from "./application-plan.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { SeasonalError } from "./contracts.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { countOccupancyByDate } from "./attendance-rule.ts";
// @ts-expect-error -- Node 타입 제거 기반 단위 테스트는 런타임 확장자를 요구한다.
import { seatLevel } from "../seats/seatLevel.ts";

// 2027-01-04 = 월요일. 회차 시각은 KST 09:30 = UTC 00:30.
const session = (ymd: string, id = ymd) => ({ id, startsAt: `${ymd}T00:30:00.000Z` });
// 1월 4일(월)~1월 29일(금) 월·수·금 회차 12개
const JAN = [
  "2027-01-04", "2027-01-06", "2027-01-08",
  "2027-01-11", "2027-01-13", "2027-01-15",
  "2027-01-18", "2027-01-20", "2027-01-22",
  "2027-01-25", "2027-01-27", "2027-01-29",
].map((ymd) => session(ymd));

const period = (label: string, startDate: string, endDate: string, extra: Record<string, unknown> = {}) => ({
  id: `p-${label}`, label, startDate, endDate, price: 300000, newApplicantPrice: null, existingApplicantPrice: null,
  shuttleFee: null, displayOrder: 0, isActive: true, ...extra,
});

test("고른 날짜의 요일을 월→일 순으로 채운다(중복 제거) — KST 달력 기준", () => {
  assert.deepEqual(weekdaysFromDates(["2027-01-08", "2027-01-04", "2027-01-11", "2027-01-06"]), ["MON", "WED", "FRI"]);
  // 일요일·토요일
  assert.deepEqual(weekdaysFromDates(["2027-01-10", "2027-01-09"]), ["SAT", "SUN"]);
  // 잘못된 값은 조용히 버린다
  assert.deepEqual(weekdaysFromDates(["엉뚱", "2027-01-04"]), ["MON"]);
  assert.deepEqual(weekdaysFromDates([]), []);
});

test("제목 스냅샷 — 날짜 모드는 주N회를 빼고 «날짜 선택 N회», 기간은 «(기간 이름)», 그 밖은 그대로", () => {
  assert.equal(itemTitleSnapshot("슈팅 클래스 주2회", { mode: "DATE", dateCount: 5 }), "슈팅 클래스 날짜 선택 5회");
  assert.equal(itemTitleSnapshot("주3회 드리블", { mode: "DATE", dateCount: 3 }), "드리블 날짜 선택 3회");
  assert.equal(itemTitleSnapshot("슈팅 주2회", { mode: "WEEKDAY", periodLabel: "4주" }), "슈팅 주2회 (4주)");
  assert.equal(itemTitleSnapshot("슈팅 주2회", { mode: "WEEKDAY" }), "슈팅 주2회");
  assert.equal(itemTitleSnapshot("슈팅 주2회", { mode: "WEEKDAY", periodLabel: null }), "슈팅 주2회");
  assert.equal(stripWeeklyFrequency("주 2 회"), "주 2 회", "이름이 전부 지워지면 원래 이름");
});

test("기간 고르기 — 보낸 기간과 같은 줄, 없으면 409 PERIOD_PRICE_NOT_CONFIGURED", () => {
  const periods = [period("4주", "2027-01-04", "2027-01-29"), period("2주", "2027-01-04", "2027-01-15", { displayOrder: 1 })];
  assert.equal(pickOfferingPeriod(periods, { startDate: "2027-01-04", endDate: "2027-01-15" })?.label, "2주");
  assert.throws(
    () => pickOfferingPeriod(periods, { startDate: "2027-01-18", endDate: "2027-01-29" }),
    (error) => error instanceof SeasonalError && error.status === 409 && error.code === "PERIOD_PRICE_NOT_CONFIGURED"
      && error.message === "선택한 기간·요일 수에 맞는 수강료가 아직 설정되지 않았습니다.",
  );
});

test("기간 고르기 — 안 보냈을 때 1개면 자동, 2개 이상이면 400 PERIOD_REQUIRED, 꺼진 기간은 안 센다", () => {
  assert.equal(pickOfferingPeriod([period("4주", "2027-01-04", "2027-01-29")], {})?.label, "4주");
  assert.equal(
    pickOfferingPeriod([period("4주", "2027-01-04", "2027-01-29"), period("2주", "2027-01-04", "2027-01-15", { isActive: false })], {})?.label,
    "4주",
  );
  assert.throws(
    () => pickOfferingPeriod([period("4주", "2027-01-04", "2027-01-29"), period("2주", "2027-01-04", "2027-01-15")], {}),
    (error) => error instanceof SeasonalError && error.status === 400 && error.code === "PERIOD_REQUIRED",
  );
  // 꺼진 기간으로는 신청할 수 없다
  assert.throws(
    () => pickOfferingPeriod([period("2주", "2027-01-04", "2027-01-15", { isActive: false })], { startDate: "2027-01-04", endDate: "2027-01-15" }),
    (error) => error instanceof SeasonalError && error.code === "PERIOD_PRICE_NOT_CONFIGURED",
  );
});

test("기간 고르기 — 기간 상품이 없는 반은 예전처럼 null, 그런데 기간을 보냈으면 409", () => {
  assert.equal(pickOfferingPeriod([], {}), null);
  assert.equal(pickOfferingPeriod(null, { startDate: null, endDate: null }), null);
  assert.throws(
    () => pickOfferingPeriod([], { startDate: "2027-01-04", endDate: "2027-01-29" }),
    (error) => error instanceof SeasonalError && error.code === "PERIOD_PRICE_NOT_CONFIGURED",
  );
});

test("켜진 기간만 표시 순서대로", () => {
  const list = activePeriods([
    period("나중", "2027-01-18", "2027-01-29", { displayOrder: 2 }),
    period("꺼짐", "2027-01-04", "2027-01-08", { isActive: false }),
    period("먼저", "2027-01-04", "2027-01-15", { displayOrder: 1 }),
  ]);
  assert.deepEqual(list.map((p) => p.label), ["먼저", "나중"]);
});

test("날짜 모드 검사 — 실제 회차 날짜만, 오늘(KST) 이전은 거절, 오늘은 된다", () => {
  assert.doesNotThrow(() => assertSelectableDates(["2027-01-04", "2027-01-06"], JAN, "2027-01-01"));
  assert.doesNotThrow(() => assertSelectableDates(["2027-01-04"], JAN, "2027-01-04"));
  assert.throws(
    () => assertSelectableDates(["2027-01-05"], JAN, "2027-01-01"),
    (error) => error instanceof SeasonalError && error.status === 409 && error.code === "DATE_NOT_OFFERED",
  );
  assert.throws(
    () => assertSelectableDates(["2027-01-04", "2027-01-06"], JAN, "2027-01-05"),
    (error) => error instanceof SeasonalError && error.status === 400 && error.code === "DATE_IN_PAST",
  );
});

test("날짜 모드 검사 — 회차 날짜는 KST 로 읽는다(UTC 15:00 = KST 다음 날)", () => {
  // KST 1월 5일 00:10 회차 = UTC 1월 4일 15:10
  const lateNight = [{ id: "x", startsAt: "2027-01-04T15:10:00.000Z" }];
  assert.doesNotThrow(() => assertSelectableDates(["2027-01-05"], lateNight, "2027-01-01"));
  assert.throws(() => assertSelectableDates(["2027-01-04"], lateNight, "2027-01-01"));
});

test("요일 + 기간 검사 — 고른 요일마다 그 기간 안에 회차가 있어야 한다", () => {
  assert.doesNotThrow(() => assertPeriodHasWeekdays(JAN, ["MON", "WED"], { startDate: "2027-01-04", endDate: "2027-01-15" }));
  // 1월 18~19일(월·화)엔 수요일 회차가 없다
  assert.throws(
    () => assertPeriodHasWeekdays(JAN, ["MON", "WED"], { startDate: "2027-01-18", endDate: "2027-01-19" }),
    (error) => error instanceof SeasonalError && error.code === "PERIOD_WEEKDAY_NOT_OFFERED",
  );
  // 화요일 회차는 아예 없다
  assert.throws(() => assertPeriodHasWeekdays(JAN, ["TUE"], { startDate: "2027-01-04", endDate: "2027-01-29" }));
});

test("이 신청서가 차지할 날짜 — 요일+기간 / 고른 날짜", () => {
  assert.deepEqual(
    occupiedDateKeys(JAN, { selectedWeekdays: ["MON", "WED"], periodStartDate: "2027-01-04", periodEndDate: "2027-01-15" }),
    ["2027-01-04", "2027-01-06", "2027-01-11", "2027-01-13"],
  );
  assert.deepEqual(
    occupiedDateKeys(JAN, { selectionMode: "DATE", selectedWeekdays: ["MON"], selectedDates: ["2027-01-25", "2027-01-04"] }),
    ["2027-01-04", "2027-01-25"],
  );
  // 같은 날 회차가 두 개여도 날짜는 한 번
  assert.deepEqual(occupiedDateKeys([session("2027-01-04", "a"), session("2027-01-04", "b")], { selectedWeekdays: [] }), ["2027-01-04"]);
});

test("날짜별 정원 — 차지할 날짜 중 정원 이상인 날만, 정원 없음(null)이면 없음", () => {
  // 정원 2: 1/4 에 요일 신청 2명(월) + 날짜 신청 1명(1/6)
  const apps = [
    { selectedWeekdays: ["MON"] },
    { selectedWeekdays: ["MON"], periodStartDate: "2027-01-04", periodEndDate: "2027-01-08" },
    { selectionMode: "DATE", selectedWeekdays: ["WED"], selectedDates: ["2027-01-06"] },
  ];
  const occupancy = countOccupancyByDate(apps, JAN);
  assert.equal(occupancy.get("2027-01-04"), 2);
  assert.equal(occupancy.get("2027-01-11"), 1, "기간이 끝난 신청은 셋째 주에 안 센다");
  assert.deepEqual(fullDateKeysFromOccupancy(occupancy, 2, ["2027-01-04", "2027-01-06", "2027-01-11"]), ["2027-01-04"]);
  assert.deepEqual(fullDateKeysFromOccupancy(occupancy, 1, ["2027-01-11", "2027-01-06"]), ["2027-01-06", "2027-01-11"]);
  assert.deepEqual(fullDateKeysFromOccupancy(occupancy, null, ["2027-01-04"]), []);
  // 날짜를 안 주면 전체 날짜에서 찾는다(공개 화면 «마감» 표시용)
  assert.ok(fullDateKeysFromOccupancy(occupancy, 2).includes("2027-01-04"));
});

test("묶음 남은 자리(2026-11-19 검수) — 정원 12, 주2회 4·주3회 4·매일 4명이 같은 요일이면 «마감»(서버 대기 판정과 같은 인원표)", () => {
  // 반 하나씩 세면 4명뿐이라 «여유»로 보였지만, 서버는 묶음 전체(12명)로 대기 판정한다
  const twice = Array.from({ length: 4 }, () => ({ selectedWeekdays: ["MON", "WED"] }));
  const thrice = Array.from({ length: 4 }, () => ({ selectedWeekdays: ["MON", "WED", "FRI"] }));
  const daily = Array.from({ length: 4 }, () => ({ selectedWeekdays: [] }));
  const occupancy = countOccupancyByDate([...twice, ...thrice, ...daily], JAN);
  const peak = peakOccupancy(occupancy);
  assert.equal(peak, 12, "월·수는 12명 모두 나온다");
  assert.equal(seatLevel(12 - peak), "FULL");
  // 서버 대기 판정(정원 이상인 날짜)과 같은 결과
  assert.ok(fullDateKeysFromOccupancy(occupancy, 12).includes("2027-01-04"));
  // 금요일만 보면 8명 — 단계는 가장 찬 날 기준이라 여전히 마감
  assert.equal(occupancy.get("2027-01-08"), 8);
  // 기준 날짜 이후만(날짜별 정원 시즌): 지나간 날은 빼고 본다
  assert.equal(peakOccupancy(new Map([["2027-01-04", 12], ["2027-01-29", 3]]), "2027-01-10"), 3);
  assert.equal(peakOccupancy(new Map()), 0);
});

test("안내 문구 — «1월 12일(화), 1월 14일(목)은 정원이 찼습니다. …»", () => {
  assert.equal(ymdKoreanLabel("2027-01-12"), "1월 12일(화)");
  assert.equal(ymdKoreanLabel("엉뚱"), "엉뚱");
  assert.equal(
    datesFullMessage(["2027-01-12", "2027-01-14"]),
    "1월 12일(화), 1월 14일(목)은 정원이 찼습니다. 이 날짜를 빼고 다시 신청해 주세요.",
  );
});
