import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { assertDatesAreSessionDates, describeApplicationSelection, hasSamePeriodRange, isDateModeApplication, kstDateTimeParts, parseAdminSelectedDates, parseDateSelectSettings, parseKstDateTime, parseOfferingPeriodInput, planPeriodCopy, shortDateLabel, weekdaysFromDates } from "./admin-period-rules.ts";

// 관리자 «기간별 수강료 · 날짜별 선택» 판단 규칙(2026-11-18)

test("기간 추가: 이름·날짜·기본 수강료 필수, 비운 신입생/재원생/셔틀비는 NULL", () => {
  const period = parseOfferingPeriodInput({ label: " 4주 ", startDate: "2027-01-04", endDate: "2027-01-29", price: "240000", newApplicantPrice: "", shuttleFee: null });
  assert.deepEqual(period, {
    label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", price: 240000,
    newApplicantPrice: null, existingApplicantPrice: null, shuttleFee: null, displayOrder: 0, isActive: true,
    applicationClosesAt: null,
  });
});

test("기간 추가: 잘못된 날짜·종료<시작·음수·소수 가격은 400", () => {
  const base = { label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", price: 1000 };
  assert.throws(() => parseOfferingPeriodInput({ ...base, startDate: "2027-1-4" }), { code: "INVALID_PERIOD_DATE" });
  assert.throws(() => parseOfferingPeriodInput({ ...base, endDate: "2027-02-30" }), { code: "INVALID_PERIOD_DATE" });
  assert.throws(() => parseOfferingPeriodInput({ ...base, endDate: "2027-01-03" }), { code: "INVALID_PERIOD_RANGE" });
  assert.throws(() => parseOfferingPeriodInput({ ...base, price: -1 }), { code: "INVALID_PERIOD_PRICE" });
  assert.throws(() => parseOfferingPeriodInput({ ...base, price: 1.5 }), { code: "INVALID_PERIOD_PRICE" });
  assert.throws(() => parseOfferingPeriodInput({ ...base, price: "" }), { code: "INVALID_PERIOD_PRICE" });
  assert.throws(() => parseOfferingPeriodInput({ ...base, existingApplicantPrice: -5 }), { code: "INVALID_PERIOD_PRICE" });
  assert.throws(() => parseOfferingPeriodInput({ ...base, label: "  " }), { code: "PERIOD_LABEL_REQUIRED" });
  // 하루짜리 기간(시작=종료)은 허용
  assert.equal(parseOfferingPeriodInput({ ...base, endDate: "2027-01-04" }).endDate, "2027-01-04");
});

test("기간 수정: 보낸 칸만 바뀌고 최종 날짜 범위를 다시 검사한다", () => {
  const before = parseOfferingPeriodInput({ label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", price: 240000, shuttleFee: 30000 });
  const changed = parseOfferingPeriodInput({ price: 200000 }, before);
  assert.equal(changed.price, 200000);
  assert.equal(changed.shuttleFee, 30000);
  assert.equal(changed.label, "4주");
  // 셔틀비를 비우면 NULL(반 셔틀비를 따른다)
  assert.equal(parseOfferingPeriodInput({ shuttleFee: "" }, before).shuttleFee, null);
  // 시작일만 종료일 뒤로 옮기면 거절
  assert.throws(() => parseOfferingPeriodInput({ startDate: "2027-02-01" }, before), { code: "INVALID_PERIOD_RANGE" });
});

test("같은 반·같은 범위 중복만 막고, 겹치는 기간(4주 / 앞 3주)은 허용", () => {
  const rows = [{ id: "a", startDate: "2027-01-04", endDate: "2027-01-29" }];
  assert.equal(hasSamePeriodRange(rows, { startDate: "2027-01-04", endDate: "2027-01-29" }), true);
  assert.equal(hasSamePeriodRange(rows, { startDate: "2027-01-04", endDate: "2027-01-22" }), false);
  // 자기 자신을 고치는 경우는 중복이 아니다
  assert.equal(hasSamePeriodRange(rows, { startDate: "2027-01-04", endDate: "2027-01-29" }, "a"), false);
});

test("다른 반에 복사: 날짜·이름만 복사, 값은 받는 반의 반 수강료, 셔틀비 NULL, 같은 범위는 건너뜀", () => {
  const sources = [
    { label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", displayOrder: 0, isActive: true },
    { label: "앞 3주", startDate: "2027-01-04", endDate: "2027-01-22", displayOrder: 1, isActive: false },
  ];
  const plan = planPeriodCopy(sources, [
    { id: "twice", price: 300000, newApplicantPrice: 300000, existingApplicantPrice: 260000, periods: [] },
    { id: "thrice", price: 400000, newApplicantPrice: null, existingApplicantPrice: null, periods: [{ startDate: "2027-01-04", endDate: "2027-01-29" }] },
  ]);
  assert.equal(plan.creates.length, 3);
  assert.deepEqual(plan.creates[0], {
    offeringId: "twice", label: "4주", startDate: "2027-01-04", endDate: "2027-01-29",
    price: 300000, newApplicantPrice: 300000, existingApplicantPrice: 260000, shuttleFee: null, displayOrder: 0, isActive: true,
    applicationClosesAt: null,
  });
  assert.equal(plan.creates[1].isActive, false); // 사용 여부도 복사
  assert.deepEqual(plan.creates[2], {
    offeringId: "thrice", label: "앞 3주", startDate: "2027-01-04", endDate: "2027-01-22",
    price: 400000, newApplicantPrice: null, existingApplicantPrice: null, shuttleFee: null, displayOrder: 1, isActive: false,
    applicationClosesAt: null,
  });
  assert.deepEqual(plan.skipped, [{ offeringId: "thrice", label: "4주", reason: "SAME_RANGE_EXISTS" }]);
});

test("시즌 날짜별 선택: 켜기만 하면 된다(회당 단가 없이도) — 보낸 칸만 돌려준다", () => {
  assert.deepEqual(parseDateSelectSettings({}), {});
  // 2026-11-18 원장 결정: 날짜로 골라도 기간 가격을 받으므로 단가 없이 켜도 된다
  assert.deepEqual(parseDateSelectSettings({ dateSelectEnabled: true }), { dateSelectEnabled: true });
  assert.deepEqual(parseDateSelectSettings({ dateSelectEnabled: "on" }, { perSessionNewPrice: null }), { dateSelectEnabled: true });
  // 옛 화면이 단가 칸을 보내면 검사만 해서 저장한다(DB 칸은 남아 있다)
  assert.deepEqual(
    parseDateSelectSettings({ dateSelectEnabled: true, perSessionNewPrice: "30000", perSessionExistingPrice: "", minSessionCount: "4" }),
    { dateSelectEnabled: true, perSessionNewPrice: 30000, perSessionExistingPrice: null, minSessionCount: 4 },
  );
  assert.deepEqual(parseDateSelectSettings({ dateSelectEnabled: false, perSessionNewPrice: "" }), { dateSelectEnabled: false, perSessionNewPrice: null });
  assert.throws(() => parseDateSelectSettings({ perSessionNewPrice: -1 }), { code: "INVALID_PERIOD_PRICE" });
  assert.throws(() => parseDateSelectSettings({ minSessionCount: 2.5 }), { code: "INVALID_PERIOD_PRICE" });
  assert.deepEqual(parseDateSelectSettings({ minSessionCount: "" }), { minSessionCount: 1 });
});

test("기간 신청 마감: «YYYY-MM-DDTHH:MM»(KST) → 절대 시각, 비우면 NULL(시즌 마감), 안 보내면 그대로", () => {
  const base = { label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", price: 240000 };
  // 1/1(금) 18:00 KST = 09:00 UTC (날짜만 new Date 로 만들면 09:00 KST 가 되는 함정을 피한다)
  const withDeadline = parseOfferingPeriodInput({ ...base, applicationClosesAt: "2027-01-01T18:00" });
  assert.equal(withDeadline.applicationClosesAt?.toISOString(), "2027-01-01T09:00:00.000Z");
  // 3주 = 1/8(금) 18:00
  assert.equal(parseOfferingPeriodInput({ ...base, startDate: "2027-01-11", applicationClosesAt: "2027-01-08 18:00" }).applicationClosesAt?.toISOString(), "2027-01-08T09:00:00.000Z");
  // 자정 경계: 00:00 KST = 전날 15:00 UTC
  assert.equal(parseOfferingPeriodInput({ ...base, applicationClosesAt: "2027-01-01T00:00" }).applicationClosesAt?.toISOString(), "2026-12-31T15:00:00.000Z");
  assert.equal(parseOfferingPeriodInput({ ...base, applicationClosesAt: "" }).applicationClosesAt, null);
  // 수정: 안 보내면 지금 값 유지, 빈 값이면 지움
  assert.equal(parseOfferingPeriodInput({ price: 1 }, withDeadline).applicationClosesAt?.toISOString(), "2027-01-01T09:00:00.000Z");
  assert.equal(parseOfferingPeriodInput({ applicationClosesAt: "" }, withDeadline).applicationClosesAt, null);
  for (const bad of ["2027-01-01", "2027-02-30T18:00", "2027-01-01T25:00", "내일"]) {
    assert.throws(() => parseOfferingPeriodInput({ ...base, applicationClosesAt: bad }), { code: "INVALID_DATETIME" }, bad);
  }
});

test("KST 날짜+시각 입력 — 시즌 모집 시작/마감 칸(기본 시작 00:00 · 마감 18:00)", () => {
  assert.equal(parseKstDateTime("2027-01-01", "18:00", "18:00", "마감")?.toISOString(), "2027-01-01T09:00:00.000Z");
  // 시각을 비우면 기본값
  assert.equal(parseKstDateTime("2027-01-01", "", "18:00", "마감")?.toISOString(), "2027-01-01T09:00:00.000Z");
  assert.equal(parseKstDateTime("2026-12-01", undefined, "00:00", "시작")?.toISOString(), "2026-11-30T15:00:00.000Z");
  assert.equal(parseKstDateTime("", "18:00", "18:00", "마감"), null);
  assert.throws(() => parseKstDateTime("2027-13-01", "18:00", "18:00", "마감"), { code: "INVALID_DATETIME" });
  // 저장값 → 입력칸(KST). 옛 시즌처럼 UTC 자정으로 저장된 값은 «09:00»으로 정직하게 보인다
  assert.deepEqual(kstDateTimeParts("2027-01-01T09:00:00.000Z", "18:00"), { date: "2027-01-01", time: "18:00" });
  assert.deepEqual(kstDateTimeParts("2026-12-31T00:00:00.000Z", "18:00"), { date: "2026-12-31", time: "09:00" });
  assert.deepEqual(kstDateTimeParts("2026-12-31T15:00:00.000Z", "18:00"), { date: "2027-01-01", time: "00:00" });
  assert.deepEqual(kstDateTimeParts(null, "18:00"), { date: "", time: "18:00" });
});

test("다른 반에 복사: 신청 마감 시각도 그대로 복사", () => {
  const closes = new Date("2027-01-01T09:00:00.000Z");
  const plan = planPeriodCopy([{ label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", displayOrder: 0, isActive: true, applicationClosesAt: closes }], [
    { id: "thrice", price: 400000, periods: [] },
  ]);
  assert.equal(plan.creates[0].applicationClosesAt, closes);
});

test("날짜 모드 배정: 날짜 검사·정렬·요일 채우기(KST 달력 그대로, 연말 경계)", () => {
  assert.deepEqual(parseAdminSelectedDates(["2027-01-06", "2027-01-04", "2027-01-04"]), ["2027-01-04", "2027-01-06"]);
  assert.throws(() => parseAdminSelectedDates("2027-01-04"), { code: "INVALID_SELECTED_DATES" });
  assert.throws(() => parseAdminSelectedDates(["2027-02-29"]), { code: "INVALID_SELECTED_DATES" });
  assert.throws(() => parseAdminSelectedDates([]), { code: "SELECTED_DATES_REQUIRED" });
  // 2027-01-04 = 월, 2027-01-06 = 수, 2026-12-31 = 목, 2027-01-03 = 일
  assert.deepEqual(weekdaysFromDates(["2027-01-06", "2027-01-04", "2027-01-11"]), ["MON", "WED"]);
  assert.deepEqual(weekdaysFromDates(["2027-01-03", "2026-12-31"]), ["THU", "SUN"]);
  assert.doesNotThrow(() => assertDatesAreSessionDates(["2027-01-04"], ["2027-01-04", "2027-01-06"]));
  assert.throws(() => assertDatesAreSessionDates(["2027-01-05"], ["2027-01-04"]), { code: "DATE_NOT_SESSION" });
});

test("목록 문구: 요일 선택 · 기간 · 요일 / 날짜 선택 N회", () => {
  assert.equal(describeApplicationSelection({ selectionMode: "WEEKDAY", selectedDates: [], selectedWeekdays: ["MON", "WED"], periodLabel: "4주" }), "요일 선택 · 4주 · 월·수");
  assert.equal(describeApplicationSelection({ selectedWeekdays: ["TUE"] }), "요일 선택 · 화");
  assert.equal(describeApplicationSelection({ selectedWeekdays: [] }), "요일 선택");
  assert.equal(describeApplicationSelection({ selectionMode: "DATE", selectedDates: ["2027-01-04", "2027-01-05", "2027-01-06", "2027-01-07", "2027-01-08"], selectedWeekdays: ["MON"] }), "날짜 선택 5회");
  assert.equal(isDateModeApplication({ selectionMode: "WEEKDAY", selectedDates: ["2027-01-04"] }), true);
  assert.equal(isDateModeApplication({ selectionMode: "WEEKDAY", selectedDates: [] }), false);
  assert.equal(shortDateLabel("2027-01-04"), "1/4(월)");
  assert.equal(shortDateLabel("엉뚱한 값"), "엉뚱한 값");
});
