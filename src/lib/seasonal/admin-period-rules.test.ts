import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { assertDatesAreSessionDates, describeApplicationSelection, hasSamePeriodRange, isDateModeApplication, parseAdminSelectedDates, parseDateSelectSettings, parseOfferingPeriodInput, planPeriodCopy, shortDateLabel, weekdaysFromDates } from "./admin-period-rules.ts";

// 관리자 «기간별 수강료 · 날짜별 선택» 판단 규칙(2026-11-18)

test("기간 추가: 이름·날짜·기본 수강료 필수, 비운 신규/재원/셔틀비는 NULL", () => {
  const period = parseOfferingPeriodInput({ label: " 4주 ", startDate: "2027-01-04", endDate: "2027-01-29", price: "240000", newApplicantPrice: "", shuttleFee: null });
  assert.deepEqual(period, {
    label: "4주", startDate: "2027-01-04", endDate: "2027-01-29", price: 240000,
    newApplicantPrice: null, existingApplicantPrice: null, shuttleFee: null, displayOrder: 0, isActive: true,
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
  });
  assert.equal(plan.creates[1].isActive, false); // 사용 여부도 복사
  assert.deepEqual(plan.creates[2], {
    offeringId: "thrice", label: "앞 3주", startDate: "2027-01-04", endDate: "2027-01-22",
    price: 400000, newApplicantPrice: null, existingApplicantPrice: null, shuttleFee: null, displayOrder: 1, isActive: false,
  });
  assert.deepEqual(plan.skipped, [{ offeringId: "thrice", label: "4주", reason: "SAME_RANGE_EXISTS" }]);
});

test("시즌 날짜별 선택: 켜면 회당 신규 단가 필수, 보낸 칸만 돌려준다", () => {
  assert.deepEqual(parseDateSelectSettings({}), {});
  assert.throws(() => parseDateSelectSettings({ dateSelectEnabled: true }), { code: "DATE_SELECT_PRICE_REQUIRED" });
  assert.throws(() => parseDateSelectSettings({ dateSelectEnabled: true, perSessionNewPrice: "" }), { code: "DATE_SELECT_PRICE_REQUIRED" });
  assert.deepEqual(
    parseDateSelectSettings({ dateSelectEnabled: true, perSessionNewPrice: "30000", perSessionExistingPrice: "", minSessionCount: "4" }),
    { dateSelectEnabled: true, perSessionNewPrice: 30000, perSessionExistingPrice: null, minSessionCount: 4 },
  );
  // 이미 단가가 있는 시즌은 켜기만 보내도 된다
  assert.deepEqual(parseDateSelectSettings({ dateSelectEnabled: true }, { perSessionNewPrice: 25000 }), { dateSelectEnabled: true });
  // 켠 시즌에서 단가만 지우면 거절
  assert.throws(() => parseDateSelectSettings({ perSessionNewPrice: "" }, { dateSelectEnabled: true, perSessionNewPrice: 25000 }), { code: "DATE_SELECT_PRICE_REQUIRED" });
  // 꺼 둔 시즌은 단가가 비어도 된다
  assert.deepEqual(parseDateSelectSettings({ dateSelectEnabled: false, perSessionNewPrice: "" }), { dateSelectEnabled: false, perSessionNewPrice: null });
  assert.throws(() => parseDateSelectSettings({ perSessionNewPrice: -1 }), { code: "INVALID_PERIOD_PRICE" });
  assert.throws(() => parseDateSelectSettings({ minSessionCount: 2.5 }), { code: "INVALID_PERIOD_PRICE" });
  assert.deepEqual(parseDateSelectSettings({ minSessionCount: "" }), { minSessionCount: 1 });
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
