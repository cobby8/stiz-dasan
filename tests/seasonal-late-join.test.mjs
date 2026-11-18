import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-18 원장 결정 — 방학특강 «날짜로 고르기»는 이미 시작한 기간에도 중간 합류를 받고, 남은 회차만큼 받는다.
//   필요 횟수 = 오늘(KST, 오늘 포함) 이후 회차로 주마다 min(N, 그 주 남은 회차 수) 합
//   수강료·셔틀비 = 정상 금액 × (남은 필요 횟수 ÷ 시작 전 전체 필요 횟수), 100원 내림
//   마감 뒤에는 날짜 모드만, 마지막 회차 전날까지(내일 이후 수업이 남았을 때)

const plan = await loadTsModule("src/lib/seasonal/application-plan.ts");
const kst = await loadTsModule("src/lib/datetime/kst.ts");
const pricing = await loadTsModule("src/lib/seasonal/period-pricing.ts");
const adminRules = await loadTsModule("src/lib/seasonal/admin-period-rules.ts");
const types = await loadTsModule("src/components/seasonal/types.ts");

const serviceSource = readFileSync("src/lib/seasonal/service.ts", "utf8");
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

// 1차 1/4(월)~1/29(금) 평일 매일 · 4주 기간
const firstSeason = weekdaySessions("2027-01-04", "2027-01-29");
const fourWeeks = { label: "4주", startDate: "2027-01-04", endDate: "2027-01-29" };
// 2차 2/1~2/26 — 설 연휴 주(2/8~2/12) 수업 없음
const secondSeason = weekdaySessions("2027-02-01", "2027-02-26", ["2027-02-08", "2027-02-09", "2027-02-10", "2027-02-11", "2027-02-12"]);
const secondPeriod = { label: "2차", startDate: "2027-02-01", endDate: "2027-02-26" };

test("필요 횟수: 기간 시작 전이면 오늘을 넣어도 예전 값과 같다(4주 주2회 8회)", () => {
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks, "2026-12-30"), 8);
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks, "2027-01-04"), 8); // 첫날 = 오늘 포함이라 그대로
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks), 8);
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks, null), 8);
});

test("필요 횟수: 1/13(수) 신청 = 6회 — 첫 주(1/4 주)는 지나서 빠지고, 1/11 주는 남은 13·14·15 중 min(2,3)=2", () => {
  // 1/11 주 2 + 1/18 주 2 + 1/25 주 2 = 6 (설계 예시의 «8 그대로?»가 아니라 6 — 1/4 주가 통째로 지났기 때문)
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks, "2027-01-13"), 6);
});

test("필요 횟수: 1/22(금) 신청 = 3회 — 그 주 남은 1회 + 마지막 주 2회", () => {
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks, "2027-01-22"), 3);
});

test("필요 횟수: 마지막 날(1/29) = 1회(오늘 포함), 다음 날 = 0회", () => {
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks, "2027-01-29"), 1);
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks, "2027-01-30"), 0);
});

test("필요 횟수: KST 자정 경계 — 1/14 23:59:59 는 6회, 1/15 00:00 은 5회(todayKst 로 오늘을 구한다)", () => {
  // KST 1/14 23:59:59 = UTC 1/14 14:59:59 · KST 1/15 00:00 = UTC 1/14 15:00
  const before = kst.todayKst(Date.parse("2027-01-14T14:59:59.000Z"));
  const after = kst.todayKst(Date.parse("2027-01-14T15:00:00.000Z"));
  assert.equal(before, "2027-01-14");
  assert.equal(after, "2027-01-15");
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks, before), 6); // 1/14·15 → 2 + 4
  assert.equal(plan.requiredDateCount(firstSeason, 2, fourWeeks, after), 5);  // 1/15 → 1 + 4
});

test("필요 횟수: 설 주간을 걸친 2차 — 2/4 신청 6회(그대로), 설 주간(2/10) 신청 4회, 2/22 신청 2회", () => {
  assert.equal(plan.requiredDateCount(secondSeason, 2, secondPeriod), 6);
  assert.equal(plan.requiredDateCount(secondSeason, 2, secondPeriod, "2027-02-04"), 6); // 2/4·2/5 → 2 + 4
  assert.equal(plan.requiredDateCount(secondSeason, 2, secondPeriod, "2027-02-10"), 4); // 설 주간은 수업 없음 → 2/15 주 + 2/22 주
  assert.equal(plan.requiredDateCount(secondSeason, 2, secondPeriod, "2027-02-22"), 2);
});

test("비율 가격: 1/22 신청 240,000 × 3/8 = 90,000 · 1/13 신청 × 6/8 = 180,000 · 시작 전 그대로", () => {
  const full = plan.requiredDateCount(firstSeason, 2, fourWeeks);
  assert.equal(pricing.proratedPrice(240000, plan.requiredDateCount(firstSeason, 2, fourWeeks, "2027-01-22"), full), 90000);
  assert.equal(pricing.proratedPrice(240000, plan.requiredDateCount(firstSeason, 2, fourWeeks, "2027-01-13"), full), 180000);
  assert.equal(pricing.proratedPrice(240000, plan.requiredDateCount(firstSeason, 2, fourWeeks, "2026-12-30"), full), 240000);
  // 2차 설 주간 신청 240,000 × 4/6 = 160,000
  assert.equal(pricing.proratedPrice(240000, 4, 6), 160000);
});

test("비율 가격: 100원 단위 내림 · 비율 1 은 내림도 안 한다 · 0·잘못된 분모", () => {
  assert.equal(pricing.proratedPrice(100000, 1, 3), 33300); // 33,333.3 → 33,300
  assert.equal(pricing.proratedPrice(200000, 2, 3), 133300); // 133,333.3 → 133,300
  assert.equal(pricing.proratedPrice(99950, 8, 8), 99950); // 비율 1 → 정상 금액 그대로
  assert.equal(pricing.proratedPrice(240000, 9, 8), 240000); // 비율이 1을 넘어도 정상 금액까지만
  assert.equal(pricing.proratedPrice(240000, 0, 8), 0);
  assert.equal(pricing.proratedPrice(240000, 3, 0), 240000); // 전체 횟수를 모르면 정상 금액
  assert.equal(pricing.proratedPrice(0, 3, 8), 0);
});

test("비율 가격: 셔틀비도 같은 비율·같은 내림(40,000 × 3/8 = 15,000 · 35,000 × 3/8 = 13,125 → 13,100)", () => {
  assert.equal(pricing.proratedPrice(40000, 3, 8), 15000);
  assert.equal(pricing.proratedPrice(35000, 3, 8), 13100);
  // 서버: 셔틀비 스냅샷도 같은 함수
  assert.match(serviceSource, /proratedPrice\(normalShuttleFee, assignment\.proration\.remainingCount, assignment\.proration\.fullCount\)/);
});

test("중간 합류 마감: 마지막 회차 전날까지(내일 이후 수업이 있을 때만)", () => {
  assert.equal(plan.hasLateJoinDates(firstSeason, "2027-01-22", fourWeeks), true);
  assert.equal(plan.hasLateJoinDates(firstSeason, "2027-01-28", fourWeeks), true); // 전날 → 1/29 남음
  assert.equal(plan.hasLateJoinDates(firstSeason, "2027-01-29", fourWeeks), false); // 마지막 회차 당일
  assert.equal(plan.hasLateJoinDates(firstSeason, "2027-02-01", fourWeeks), false);
  // 기간이 없으면 시즌 전체
  assert.equal(plan.hasLateJoinDates(secondSeason, "2027-02-25", null), true);
  assert.equal(plan.hasLateJoinDates(secondSeason, "2027-02-26", null), false);
  const error = plan.periodEndedError();
  assert.equal(error.code, "PERIOD_ENDED");
  assert.equal(error.status, 409);
  assert.equal(error.message, "이 기간은 남은 수업이 없습니다.");
});

test("서버: 마감 뒤 날짜 모드만 허용, 요일 모드는 그대로 거절, 남은 회차 0 은 PERIOD_ENDED", () => {
  // 시즌 마감 뒤: 날짜 모드 + 날짜 선택 켜짐 + 운영 종료 전만 통과(요일 모드·날짜 선택 꺼짐은 APPLICATION_CLOSED)
  assert.match(serviceSource, /const lateJoinAllowed = input\.selectionMode === "DATE" && season\.dateSelectEnabled && now <= season\.endsAt;/);
  assert.match(serviceSource, /if \(now < season\.applicationOpensAt \|\| \(seasonClosed && !lateJoinAllowed\)\)/);
  // 기간 마감: 요일 모드만 PERIOD_CLOSED
  assert.match(serviceSource, /if \(period && periodClosed && !isDateMode\) throw periodClosedError\(period\.label\)/);
  // 마감 뒤 날짜 모드: 남은 날(내일 이후)이 없으면 PERIOD_ENDED
  assert.match(serviceSource, /if \(\(periodClosed \|\| deadline\.seasonClosed\) && !hasLateJoinDates\(scopeSessionDates, todayYmd, period\)\)/);
  // 남은 회차 0(회차는 있었음) → PERIOD_ENDED
  assert.match(serviceSource, /if \(fullCount > 0 && required === 0\) throw periodEndedError\(\);/);
  // 필요 횟수는 오늘 기준, 비율의 분모는 시작 전 기준
  assert.match(serviceSource, /const required = requiredDateCount\(scopeSessionDates, frequency, period, todayYmd\);/);
  assert.match(serviceSource, /const fullCount = requiredDateCount\(scopeSessionDates, frequency, period\);/);
});

test("공개 응답: status 값은 그대로, lateJoinOpen 은 모집 마감 + 날짜 선택 켜짐 + 남은 날 있을 때만", () => {
  assert.match(serviceSource, /lateJoinOpen: status === "CLOSED"\s*&& season\.dateSelectEnabled\s*&& hasLateJoinDates\(/);
});

// 화면 표시 판정(types.ts) — 모집 마감 뒤 중간 합류
const season = {
  id: "s1", slug: "winter", title: "겨울특강", status: "PUBLISHED",
  applicationOpensAt: "2026-12-01T00:00:00+09:00", applicationClosesAt: "2027-01-01T18:00:00+09:00",
  startsAt: "2027-01-04T00:00:00+09:00", endsAt: "2027-02-26T23:59:59+09:00",
  classes: [{ id: "c1", title: "슈팅 주2회", capacity: 10, seatLevel: "AVAILABLE", price: 240000, sessionDates: [] }],
};
const at = (iso) => Date.parse(iso);

test("화면: 모집 마감 + lateJoinOpen + 날짜 선택 켜짐 → 신청 버튼 살림·«중간 합류 가능»", () => {
  const now = at("2027-01-22T12:00:00+09:00");
  const program = types.normalizeProgram({ ...season, lateJoinOpen: true, dateSelect: { enabled: true } }, now);
  const display = types.seasonalDisplayState(program, now);
  assert.equal(display.status, "CLOSED"); // 상태 값은 그대로
  assert.equal(display.canApply, true);
  assert.equal(display.lateJoin, true);
  assert.equal(display.label, "중간 합류 가능");
  assert.match(display.message, /중간 합류 신청 가능\(날짜로 고르기\)/);
  assert.equal(display.actionLabel, "중간 합류 신청하기");
});

test("화면: 날짜 선택이 꺼진 시즌·lateJoinOpen 없음은 지금처럼 «모집 마감»", () => {
  const now = at("2027-01-22T12:00:00+09:00");
  for (const extra of [{ lateJoinOpen: true, dateSelect: { enabled: false } }, { dateSelect: { enabled: true } }, {}]) {
    const program = types.normalizeProgram({ ...season, ...extra }, now);
    const display = types.seasonalDisplayState(program, now);
    assert.equal(display.canApply, false, JSON.stringify(extra));
    assert.equal(display.lateJoin, false);
    assert.equal(display.label, "모집 마감");
    assert.equal(display.message, "신청 접수가 마감되었습니다.");
  }
  // 모집 중이면 lateJoin 이 아니다(예전과 같은 문구)
  const open = at("2026-12-10T12:00:00+09:00");
  const display = types.seasonalDisplayState(types.normalizeProgram({ ...season, lateJoinOpen: true, dateSelect: { enabled: true } }, open), open);
  assert.equal(display.canApply, true);
  assert.equal(display.lateJoin, false);
  assert.equal(display.actionLabel, "자세히 보고 신청하기");
});

test("신청 화면: 마감이면 «요일로 고르기» 비활성·안내, 필요 횟수·비율은 서버와 같은 함수", () => {
  assert.match(applyClientSource, /요일 신청은 마감되었습니다\. 남은 날짜로 중간 합류할 수 있습니다\./);
  assert.match(applyClientSource, /const disabled = mode === "WEEKDAY" && weekdayModeClosed;/);
  assert.match(applyClientSource, /requiredDateCount\(scopeSessions, weeklyFrequency, appliedPeriod, todayYmd\)/);
  assert.match(applyClientSource, /proratedPrice\(amount, requiredDates, fullDateCount\)/);
  assert.match(applyClientSource, /오늘부터 남은 수업 \{dateOptions\.length\}회 중에서 고릅니다 · 수강료는 남은 회차만큼\(정상/);
});

const routeSource = readFileSync("src/app/api/admin/seasonal/route.ts", "utf8");

test("관리자 재배정: 날짜 모드는 «접수일» 기준 남은 회차 비율 — 같은 함수(requiredDateCount·proratedPrice), 셔틀비도 같은 비율", () => {
  assert.match(routeSource, /import \{ requiredDateCount, ymdKoreanLabel \} from "@\/lib\/seasonal\/application-plan"/);
  assert.match(routeSource, /const remainingCount = requiredDateCount\(sessions, frequency, period, params\.appliedOnYmd\);/);
  assert.match(routeSource, /const fullCount = requiredDateCount\(sessions, frequency, period\);/);
  // 요일 모드(dateCount null)·기준일 없음은 비율을 쓰지 않는다
  assert.match(routeSource, /if \(dateCount === null \|\| !params\.appliedOnYmd \|\| frequency === null\) return null;/);
  // 재배정·새 항목 둘 다 신청서 접수일(KST)을 넘긴다 — 오늘(todayKst)이 아니다
  assert.match(routeSource, /appliedOnYmd: toKstYmd\(before\.application\.createdAt\)/);
  assert.match(routeSource, /appliedOnYmd: toKstYmd\(application\.createdAt\)/);
  assert.match(routeSource, /proratedPrice\(normalShuttleFee, assignment\.proration\.remainingCount, assignment\.proration\.fullCount\)/);
});

test("관리자 재배정 금액: 1/22 접수 신청을 2/1 에 고쳐도 90,000(접수일 기준) · 시작 전 접수는 240,000", () => {
  const full = plan.requiredDateCount(firstSeason, 2, fourWeeks);
  // 접수 KST 1/22 10:00 = UTC 1/22 01:00
  const appliedOn = kst.toKstYmd("2027-01-22T01:00:00.000Z");
  assert.equal(appliedOn, "2027-01-22");
  assert.equal(pricing.proratedPrice(240000, plan.requiredDateCount(firstSeason, 2, fourWeeks, appliedOn), full), 90000);
  // 접수 KST 1/21 23:30(= UTC 1/21 14:30) → 1/21 기준 4회 → 120,000 (자정 경계는 KST 로)
  const lateNight = kst.toKstYmd("2027-01-21T14:30:00.000Z");
  assert.equal(lateNight, "2027-01-21");
  assert.equal(pricing.proratedPrice(240000, plan.requiredDateCount(firstSeason, 2, fourWeeks, lateNight), full), 120000);
  // 시작 전(12/20) 접수 → 비율 1 → 정상 금액
  assert.equal(pricing.proratedPrice(240000, plan.requiredDateCount(firstSeason, 2, fourWeeks, kst.toKstYmd("2026-12-20T03:00:00.000Z")), full), 240000);
});

test("관리자: 기간 시작 뒤 날짜 모드 접수만 «중간 합류»", () => {
  const base = { selectionMode: "DATE", selectedDates: ["2027-01-22"], periodStartDate: "2027-01-04" };
  // 접수 1/21 23:30 KST(= UTC 14:30) → 1/21 > 1/4
  assert.equal(adminRules.isLateJoinApplication({ ...base, createdAt: "2027-01-21T14:30:00.000Z" }), true);
  // 시작 당일 접수는 남은 회차 = 전체라 중간 합류 아님
  assert.equal(adminRules.isLateJoinApplication({ ...base, createdAt: "2027-01-04T01:00:00.000Z" }), false);
  // KST 자정 경계: UTC 1/3 15:00 = KST 1/4 00:00 → 아님, UTC 1/4 15:00 = KST 1/5 → 중간 합류
  assert.equal(adminRules.isLateJoinApplication({ ...base, createdAt: "2027-01-03T15:00:00.000Z" }), false);
  assert.equal(adminRules.isLateJoinApplication({ ...base, createdAt: "2027-01-04T15:00:00.000Z" }), true);
  // 요일 모드는 표시 안 함
  assert.equal(adminRules.isLateJoinApplication({ selectionMode: "WEEKDAY", selectedDates: [], periodStartDate: "2027-01-04", createdAt: "2027-01-21T00:00:00.000Z" }), false);
  // 기간이 없으면 시즌 시작일 기준
  assert.equal(adminRules.isLateJoinApplication({ selectionMode: "DATE", selectedDates: ["2027-01-22"], createdAt: "2027-01-21T00:00:00.000Z" }, "2027-01-03T15:00:00.000Z"), true);
});
