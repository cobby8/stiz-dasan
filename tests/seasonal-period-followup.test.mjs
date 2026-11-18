import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-18 기간 선택·날짜별 선택 검수 후속(M-1·M-2·L-1·L-2)을 고정한다.

const capacity = await loadTsModule("src/lib/seasonal/date-capacity.ts");
const pricing = await loadTsModule("src/lib/seasonal/period-pricing.ts");
const contracts = await loadTsModule("src/lib/seasonal/contracts.ts");

const routeSource = readFileSync("src/app/api/admin/seasonal/route.ts", "utf8");
const serviceSource = readFileSync("src/lib/seasonal/service.ts", "utf8");
const makeupSource = readFileSync("src/lib/seasonal/makeup-capacity.ts", "utf8");
const attendanceSource = readFileSync("src/lib/seasonal/attendance.ts", "utf8");
const applyClientSource = readFileSync("src/components/seasonal/SeasonalApplyClient.tsx", "utf8");

// ── M-1: 관리자 승인 경로는 APPROVED 만 센다 ─────────────────────────

// 2027-01-04(월) 하루 회차 · 정원 10 · 같은 날 나오는 신청서 10건(대기 PENDING 10건)
const session = { id: "s1", startsAt: "2027-01-04T08:00:00.000Z" };
const rule = { selectionMode: "DATE", selectedWeekdays: ["MON"], selectedDates: ["2027-01-04"], periodStartDate: null, periodEndDate: null };

/** findMany 의 status 조건대로 거르는 가짜 거래 객체 — 실제 DB 를 쓰지 않는다. */
function fakeTx(items) {
  const calls = [];
  return {
    calls,
    specialProgramApplicationItem: {
      async findMany({ where }) {
        calls.push(where.status.in);
        return items.filter((item) => where.status.in.includes(item.status));
      },
    },
  };
}
const pendingTen = Array.from({ length: 10 }, (_, index) => ({
  applicationId: `app-${index}`,
  status: "PENDING",
  application: { ...rule },
}));

test("M-1 공개 신청(기본값)은 PENDING+APPROVED 를 센다 — 대기 10건이면 그날은 가득 참", async () => {
  const tx = fakeTx(pendingTen);
  const full = await capacity.findFullDates(tx, { scopeOfferingIds: ["o1"], capacity: 10, sessionDates: [session], rule });
  assert.deepEqual(full, ["2027-01-04"]);
  assert.deepEqual(tx.calls[0], ["PENDING", "APPROVED"]);
});

test("M-1 관리자 경로(statuses=APPROVED)는 승인만 센다 — 정원 10·대기 10건이어도 승인 가능", async () => {
  const tx = fakeTx(pendingTen);
  const full = await capacity.findFullDates(tx, { scopeOfferingIds: ["o1"], capacity: 10, sessionDates: [session], rule, statuses: ["APPROVED"] });
  assert.deepEqual(full, []);
  assert.deepEqual(tx.calls[0], ["APPROVED"]);
});

test("M-1 관리자 경로도 승인 10건이면 막는다(정원 검사 자체는 살아 있다)", async () => {
  const approvedTen = pendingTen.map((item) => ({ ...item, status: "APPROVED" }));
  const full = await capacity.findFullDates(fakeTx(approvedTen), { scopeOfferingIds: ["o1"], capacity: 10, sessionDates: [session], rule, statuses: ["APPROVED"] });
  assert.deepEqual(full, ["2027-01-04"]);
});

test("M-1 route.ts 날짜 기준 분기는 params.statuses(기본 APPROVED)를 findFullDates 에 넘긴다", () => {
  assert.match(routeSource, /statuses: params\.statuses\?\.length \? params\.statuses : APPROVED_SEAT_STATUSES/);
  assert.match(routeSource, /const APPROVED_SEAT_STATUSES = \["APPROVED"\]/);
});

// ── M-2: «새 기능 시즌인가» 판정 하나로 ─────────────────────────────

test("M-2 기존 시즌(켜진 기간 0·날짜 선택 꺼짐·기간/날짜 신청 없음)은 언제나 false", () => {
  assert.equal(pricing.usesPeriodOrDateFeatures({ dateSelectEnabled: false, activePeriodCount: 0 }), false);
  assert.equal(pricing.usesPeriodOrDateFeatures({ dateSelectEnabled: null, activePeriodCount: 0, applicationsUsePeriodOrDate: false }), false);
});

test("M-2 셋 중 하나만 있어도 true", () => {
  assert.equal(pricing.usesPeriodOrDateFeatures({ dateSelectEnabled: true, activePeriodCount: 0 }), true);
  assert.equal(pricing.usesPeriodOrDateFeatures({ dateSelectEnabled: false, activePeriodCount: 1 }), true);
  assert.equal(pricing.usesPeriodOrDateFeatures({ dateSelectEnabled: false, activePeriodCount: 0, applicationsUsePeriodOrDate: true }), true);
});

test("M-2 꺼진 기간 행(isActive=false)은 세지 않는다 — 꺼진 행만 있으면 기존 시즌과 같다", () => {
  assert.equal(pricing.countActivePeriods([{ isActive: false }, { isActive: false }]), 0);
  assert.equal(pricing.countActivePeriods([{ isActive: true }, { isActive: false }, {}]), 2);
  assert.equal(pricing.countActivePeriods(null), 0);
  assert.equal(pricing.usesPeriodOrDateFeatures({ dateSelectEnabled: false, activePeriodCount: pricing.countActivePeriods([{ isActive: false }]) }), false);
});

test("M-2 신청서가 기간/날짜를 골랐는지", () => {
  assert.equal(pricing.applicationUsesPeriodOrDate({ selectionMode: "WEEKDAY", selectedDates: [], periodStartDate: null, periodEndDate: null }), false);
  assert.equal(pricing.applicationUsesPeriodOrDate(null), false);
  assert.equal(pricing.applicationUsesPeriodOrDate({ selectionMode: "DATE" }), true);
  assert.equal(pricing.applicationUsesPeriodOrDate({ selectedDates: ["2027-01-04"] }), true);
  assert.equal(pricing.applicationUsesPeriodOrDate({ periodStartDate: "2027-01-04" }), true);
});

test("M-2 네 곳이 모두 공용 판정 함수를 쓰고, 기간 행은 isActive=true 만 센다", () => {
  // 공개 신청: 꺼진 기간을 빼고 센다(예전엔 periods.length 로 꺼진 행까지 셌다)
  assert.match(serviceSource, /usesDateCapacity = usesPeriodOrDateFeatures\(/);
  assert.match(serviceSource, /countActivePeriods\(offering\.periods\)/);
  assert.doesNotMatch(serviceSource, /offering\.periods\.length > 0/);
  // 관리자 승인: 켜진 기간 행만 count
  assert.match(routeSource, /specialProgramOfferingPeriod\.count\(\{ where: \{ offeringId: \{ in: scopedOfferingIds \}, isActive: true \} \}\)/);
  assert.match(routeSource, /if \(usesPeriodOrDateFeatures\(\{/);
  // 보강 정원: 공용 함수에 맡기고 SQL 은 isActive=true
  assert.match(makeupSource, /return usesPeriodOrDateFeatures\(\{/);
  assert.match(makeupSource, /p\."isActive" = true/);
  // 출석부: SQL 은 재료만 세고 판정은 공용 함수
  assert.match(attendanceSource, /hasMixedPeriods: usesPeriodOrDateFeatures\(\{/);
  assert.match(attendanceSource, /p\."isActive" = true/);
});

// ── L-1: 섞인 반 안내 ────────────────────────────────────────────

test("L-1 기간 표시가 섞였는지 — 반 하나이거나 모두 같으면 false", () => {
  assert.equal(pricing.hasPeriodMix([null]), false);
  assert.equal(pricing.hasPeriodMix([null, null]), false); // 기존 시즌: 전부 기간 없음
  assert.equal(pricing.hasPeriodMix(["2027-01-04|2027-01-29", "2027-01-04|2027-01-29"]), false);
  assert.equal(pricing.hasPeriodMix(["2027-01-04|2027-01-29", null]), true);
  assert.equal(pricing.hasPeriodMix(["2027-01-04|2027-01-29", "2027-01-04|2027-01-15"]), true);
});

test("L-1 섞인 경우 전용 코드·문구(409 PERIOD_MIXED_OFFERINGS)", () => {
  const error = pricing.periodMixedOfferingsError();
  assert.equal(error.status, 409);
  assert.equal(error.code, "PERIOD_MIXED_OFFERINGS");
  assert.equal(error.message, "같은 수강 기간으로 신청할 수 있는 수업만 함께 골라 주세요.");
});

test("L-1 service.ts 는 섞임을 전용 오류로 막고, 진짜 가격 없음은 기존 코드 그대로", () => {
  assert.match(serviceSource, /throw periodMixedOfferingsError\(\)/);
  // 섞임 검사 자리에서 PERIOD_PRICE_NOT_CONFIGURED 를 더는 직접 던지지 않는다(가격 없음은 application-plan.ts 가 던진다)
  assert.doesNotMatch(serviceSource, /"PERIOD_PRICE_NOT_CONFIGURED"/);
  const plan = readFileSync("src/lib/seasonal/application-plan.ts", "utf8");
  assert.match(plan, /"선택한 기간·요일 수에 맞는 수강료가 아직 설정되지 않았습니다\.", 409, "PERIOD_PRICE_NOT_CONFIGURED"/);
});

// ── L-2: 날짜 선택은 한 반만 ──────────────────────────────────────

function application(overrides = {}) {
  return {
    // contracts.test.ts validApplication 과 같은 모양
    idempotencyKey: "test-key",
    child: { name: "홍길동", birthDate: "2015-01-01" },
    parent: { name: "보호자", phone: "010-1234-5678" },
    agreedTerms: true,
    agreedPrivacy: true,
    selectedWeekdays: ["MON"],
    items: [{ offeringId: "o1" }],
    ...overrides,
  };
}

test("L-2 날짜 모드에서 수업 2개면 400 DATE_SELECT_SINGLE_OFFERING", () => {
  assert.throws(
    () => contracts.parseApplicationInput(application({ selectionMode: "DATE", selectedDates: ["2027-01-04"], items: [{ offeringId: "o1" }, { offeringId: "o2" }] })),
    (error) => error.status === 400
      && error.code === "DATE_SELECT_SINGLE_OFFERING"
      && error.message === "날짜로 고를 때는 수업을 하나만 신청할 수 있습니다.",
  );
});

test("L-2 날짜 모드 한 반은 통과, 요일 모드 여러 반은 그대로 통과", () => {
  const single = contracts.parseApplicationInput(application({ selectionMode: "DATE", selectedDates: ["2027-01-04"] }));
  assert.equal(single.items.length, 1);
  const weekdayMany = contracts.parseApplicationInput(application({ items: [{ offeringId: "o1" }, { offeringId: "o2" }] }));
  assert.equal(weekdayMany.items.length, 2);
  assert.equal(weekdayMany.selectionMode, "WEEKDAY");
});

test("L-2 신청 화면은 날짜 모드에서 수업이 둘 이상이면 안내하고 제출을 막는다", () => {
  assert.match(applyClientSource, /const dateModeTooMany = isDateMode && selectedOfferings\.length > 1/);
  assert.match(applyClientSource, /selectedDates\.length >= minSessionCount && !dateModeTooMany/);
  assert.match(applyClientSource, /날짜로 고를 때는 수업을 하나만 신청할 수 있습니다\./);
});
