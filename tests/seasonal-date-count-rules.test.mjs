import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-18 원장 결정표 답 반영 — 날짜 선택 = «주N회 총 횟수를 날짜로 채우기»·날짜 정원 대기·기간별 마감·재원 재확인.

const plan = await loadTsModule("src/lib/seasonal/application-plan.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const pricing = await loadTsModule("src/lib/seasonal/period-pricing.ts");

const serviceSource = readFileSync("src/lib/seasonal/service.ts", "utf8");
const routeSource = readFileSync("src/app/api/admin/seasonal/route.ts", "utf8");
const adminClientSource = readFileSync("src/app/admin/seasonal/SeasonalAdminClient.tsx", "utf8");
const applyClientSource = readFileSync("src/components/seasonal/SeasonalApplyClient.tsx", "utf8");

/** 'YYYY-MM-DD' 에 하루씩 더하기(테스트용 — 달력 숫자만) */
function addDays(ymd, days) {
  const [y, m, d] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** 시작~끝 사이 평일(월~금) 회차 — KST 14:00 시작(= UTC 05:00). skip 에 든 날짜는 수업 없음. */
function weekdaySessions(start, end, skip = []) {
  const sessions = [];
  for (let ymd = start; ymd <= end; ymd = addDays(ymd, 1)) {
    const dow = kst.kstDow(ymd);
    if (dow === 0 || dow === 6 || skip.includes(ymd)) continue;
    sessions.push({ id: ymd, startsAt: `${ymd}T05:00:00.000Z` });
  }
  return sessions;
}

// 1차 시즌 1/4(월)~1/29(금) 매일(평일) 수업
const firstSeason = weekdaySessions("2027-01-04", "2027-01-29");
const fourWeeks = { label: "4주", startDate: "2027-01-04", endDate: "2027-01-29" };
const threeWeeks = { label: "3주", startDate: "2027-01-11", endDate: "2027-01-29" };
// 2차 시즌 2/1~2/26 — 설 연휴 주(2/8~2/12)는 수업 없음
const secondSeason = weekdaySessions("2027-02-01", "2027-02-26", ["2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12"]);
const secondPeriod = { label: "2차", startDate: "2027-02-01", endDate: "2027-02-26" };

test("주 시작(월요일) — 일요일은 그 앞 월요일, 연말 경계도 달력 그대로", () => {
  assert.equal(kst.kstWeekMonday("2027-01-04"), "2027-01-04"); // 월
  assert.equal(kst.kstWeekMonday("2027-01-08"), "2027-01-04"); // 금
  assert.equal(kst.kstWeekMonday("2027-01-10"), "2027-01-04"); // 일 → 같은 주
  assert.equal(kst.kstWeekMonday("2027-01-01"), "2026-12-28"); // 금(연초) → 작년 12/28(월)
  assert.equal(kst.kstWeekMonday("2028-02-29"), "2028-02-28"); // 윤년
  assert.equal(kst.kstWeekMonday("2027-02-30"), "");
});

test("필요 횟수: 4주 주2회 = 8회", () => {
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks), 8);
});

test("필요 횟수: 3주 주3회 = 9회", () => {
  assert.equal(plan.requiredDateCount(firstSeason, 3, threeWeeks), 9);
});

test("필요 횟수: 2차(2/1~2/5 + 2/15~2/26) 주2회 = 6회 — 설 주간(수업 없는 주)은 세지 않는다", () => {
  assert.equal(plan.requiredDateCount(secondSeason, 2, secondPeriod), 6);
  // 기간을 안 고른(시즌 전체) 경우도 같은 규칙
  assert.equal(plan.requiredDateCount(secondSeason, 2, null), 6);
});

test("필요 횟수: 주5회(매일)는 기간 전 회차 — 공휴일로 수업이 적은 주는 있는 만큼만", () => {
  assert.equal(plan.requiredDateCount(firstSeason, 5, fourWeeks), 20);
  // 1/6(수) 휴강이면 그 주는 4회 → 19회(= 기간 전 회차)
  const holiday = weekdaySessions("2027-01-04", "2027-01-29", ["2027-01-06"]);
  assert.equal(plan.requiredDateCount(holiday, 5, fourWeeks), 19);
  // 주2회는 그 주도 2회면 충분 → 그대로 8회
  assert.equal(plan.requiredDateCount(holiday, 2, fourWeeks), 8);
});

test("필요 횟수: 같은 날 회차가 둘(주2회·주3회 반이 한 교실)이어도 날짜 하나로 센다 · 주N회 0 이하는 0", () => {
  const doubled = [...firstSeason, ...firstSeason.map((session) => ({ ...session, id: `${session.id}-b`, startsAt: session.startsAt.replace("05:00", "07:00") }))];
  assert.equal(plan.requiredDateCount(doubled, 2, fourWeeks), 8);
  assert.equal(plan.requiredDateCount(firstSeason, 0, fourWeeks), 0);
});

test("필요 횟수: KST 자정 경계 — UTC 로는 전날 15:00 인 회차도 KST 날짜로 센다", () => {
  // KST 1/11(월) 00:30 = UTC 1/10(일) 15:30 → 1/11 주(월요일 1/11)에 들어가야 한다
  const sessions = [{ id: "a", startsAt: "2027-01-10T15:30:00.000Z" }, { id: "b", startsAt: "2027-01-04T05:00:00.000Z" }];
  assert.equal(plan.requiredDateCount(sessions, 1, null), 2);
});

test("개수 불일치는 400 DATE_COUNT_MISMATCH — 모자라도 넘쳐도 거절, 정확하면 통과", () => {
  assert.throws(() => plan.assertDateCount(5, 8, 2, "4주"), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, "DATE_COUNT_MISMATCH");
    assert.equal(error.message, "주2회 4주는 8회를 모두 골라 주세요. 지금 5회");
    return true;
  });
  assert.throws(() => plan.assertDateCount(9, 8, 2, "4주"), { code: "DATE_COUNT_MISMATCH" });
  assert.doesNotThrow(() => plan.assertDateCount(8, 8, 2, "4주"));
  // 기간 이름이 없으면 «주3회는 …»
  assert.throws(() => plan.assertDateCount(1, 9, 3, null), { message: "주3회는 9회를 모두 골라 주세요. 지금 1회" });
  // 고를 날짜가 아예 없으면 409
  assert.throws(() => plan.assertDateCount(0, 0, 2, null), { code: "DATE_NOT_OFFERED" });
});

test("기간 밖 날짜는 409 DATE_OUTSIDE_PERIOD, 기간 없으면 검사 안 함", () => {
  assert.throws(() => plan.assertDatesInPeriod(["2027-01-05", "2027-01-08"], threeWeeks), { code: "DATE_OUTSIDE_PERIOD", status: 409 });
  assert.doesNotThrow(() => plan.assertDatesInPeriod(["2027-01-11", "2027-01-29"], threeWeeks));
  assert.doesNotThrow(() => plan.assertDatesInPeriod(["2027-01-05"], null));
});

test("화면 안내 문구 — «8회 중 5회 선택 · 3회 더 골라 주세요»", () => {
  assert.equal(plan.dateCountProgressText(5, 8), "8회 중 5회 선택 · 3회 더 골라 주세요");
  assert.equal(plan.dateCountProgressText(8, 8), "8회 모두 선택");
  assert.match(applyClientSource, /회까지만 고를 수 있습니다/);
});

test("제목 스냅샷 — 날짜 모드에 기간이 있으면 «(4주)»를 붙인다", () => {
  assert.equal(plan.itemTitleSnapshot("슈팅 주2회", { mode: "DATE", dateCount: 8, periodLabel: "4주" }), "슈팅 날짜 선택 8회 (4주)");
  assert.equal(plan.itemTitleSnapshot("슈팅 주2회", { mode: "DATE", dateCount: 8 }), "슈팅 날짜 선택 8회");
});

test("서버: 날짜 모드도 주N회 반·기간 가격(요일 모드와 같은 코드), 회당 단가 계산은 없다", () => {
  assert.doesNotMatch(serviceSource, /dateSelectTuition/);
  assert.doesNotMatch(routeSource, /dateSelectTuition/);
  assert.doesNotMatch(adminClientSource, /dateSelectTuition/);
  assert.equal(pricing.dateSelectTuition, undefined);
  // 두 모드 공통: N = 날짜 모드는 weeklyFrequency, 요일 모드는 요일 수
  assert.match(serviceSource, /const frequency = isDateMode \? Number\(request\.weeklyFrequency\) : selectedWeekdays\.length/);
  assert.match(serviceSource, /priceSnapshot: period \? resolvePeriodPrice\(period, applicantType\) : resolveOfferingPrice\(offering, applicantType\)/);
  assert.match(serviceSource, /assertDateCount\(request\.selectedDates\.length, required, frequency, period\?\.label\)/);
  assert.match(serviceSource, /unitPrice: null as number \| null/);
});

test("서버: 날짜 모드도 정원이 차면 대기(WAITLISTED)로 접수 — DATES_FULL 로 돌려보내지 않는다", () => {
  assert.doesNotMatch(serviceSource, /"DATES_FULL"/);
  // 찬 날짜가 있으면 full → 아래에서 WAITLISTED·대기 순번
  assert.match(serviceSource, /full = fullDates\.length > 0;/);
  assert.match(serviceSource, /status: full \? "WAITLISTED" : "PENDING"/);
  assert.match(serviceSource, /waitlistOrder: full \? \(maxOrders\.get\(assignment\.offering\.id\) \|\| 0\) \+ 1 : null/);
  // 화면: 마감 날짜도 고를 수 있고, 대기 안내가 있다
  assert.match(applyClientSource, /«마감»된 날짜가 있으면 대기로 접수됩니다\./);
  assert.doesNotMatch(applyClientSource, /disabled=\{option\.full\}/);
  assert.match(applyClientSource, /정원이 차서 대기로 접수되었습니다/);
});

test("서버: 기간 마감은 그 기간 행 시각으로 409 PERIOD_CLOSED", () => {
  assert.match(serviceSource, /if \(period && isPeriodClosed\(period\)\) throw periodClosedError\(period\.label\)/);
  // 18:00 KST 경계(17:59:59 허용 · 18:00:00 거절)
  const closesAt = new Date(kst.kstAt("2027-01-08", "18:00"));
  assert.equal(pricing.isPeriodClosed({ applicationClosesAt: closesAt }, kst.kstAt("2027-01-08", "17:59") + 59_999), false);
  assert.equal(pricing.isPeriodClosed({ applicationClosesAt: closesAt }, kst.kstAt("2027-01-08", "18:00")), true);
});

test("재원 재확인: 공개 신청과 같은 SQL 함수로 판정하고, 승인 화면에 경고만(가격 자동 변경 없음)", () => {
  assert.match(serviceSource, /export async function hasMatchingExistingStudent\(input: ExistingStudentProbe\)/);
  assert.match(routeSource, /import \{ hasMatchingExistingStudent \} from "@\/lib\/seasonal\/service"/);
  assert.match(routeSource, /existingCheck: existingNotActiveIds\.has\(String\(application\.id\)\) \? "NOT_ACTIVE" as const : null/);
  // 재원가(EXISTING)로 접수된 신청만, 청구 연결 전 진행 중 항목이 있을 때만 묻는다
  assert.match(routeSource, /application\.applicantType === "EXISTING"/);
  assert.match(adminClientSource, /재원 확인 필요: 지금 정규반 수강 중이 아님/);
  // 경고 칸이 가격을 건드리지 않는다(재배정으로 처리)
  const block = adminClientSource.slice(adminClientSource.indexOf('application.existingCheck === "NOT_ACTIVE"'), adminClientSource.indexOf("{needsReview.length > 0"));
  assert.doesNotMatch(block, /setPrice|priceSnapshot/);
});

test("재원생 할인 고지 문구가 신청 화면 두 곳(회원 구분·금액 미리보기)에 보인다", () => {
  assert.match(applyClientSource, /재원생 할인은 특강 기간에 정규반을 함께 다니는 학생만 받습니다\. 정규반을 휴원하고 특강만 들으면 신규 수강료가 적용됩니다\./);
  assert.equal(applyClientSource.split("{EXISTING_DISCOUNT_NOTICE}").length - 1, 2);
});
