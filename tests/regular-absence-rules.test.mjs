import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-15 마감 통일·날짜 바꾸기: 규칙 파일이 마감 공용 모듈(@/lib/parent/changeDeadline)을 import 하게 됐다.
// «@/» 별칭은 node 가 직접 못 풀어 공용 로더로 올린다 — 아래 단언은 한 줄도 바꾸지 않았다.
const {
  isValidReason,
  ymdToDayIndex,
  addDaysYmd,
  isFutureYmd,
  computeUpcomingDates,
  isReportableDate,
  dayIndexOf,
} = await loadTsModule("src/lib/regular/regularAbsenceRules.ts");

test("사유 검증 — 5종만 허용", () => {
  assert.equal(isValidReason("ILLNESS_INJURY"), true);
  assert.equal(isValidReason("ETC"), true);
  assert.equal(isValidReason("UNKNOWN"), false);
  assert.equal(isValidReason(""), false);
  assert.equal(isValidReason(null), false);
});

test("dayIndexOf / ymdToDayIndex — 요일 인덱스", () => {
  assert.equal(dayIndexOf("Mon"), 1);
  assert.equal(dayIndexOf("Sun"), 0);
  assert.equal(dayIndexOf("Xyz"), null);
  // 2026-07-27 은 월요일
  assert.equal(ymdToDayIndex("2026-07-27"), 1);
  // 2026-07-26 은 일요일
  assert.equal(ymdToDayIndex("2026-07-26"), 0);
  assert.equal(ymdToDayIndex("bad"), null);
});

test("addDaysYmd — 월말/연말 넘김", () => {
  assert.equal(addDaysYmd("2026-07-27", 7), "2026-08-03");
  assert.equal(addDaysYmd("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysYmd("2026-07-27", 0), "2026-07-27");
});

test("isFutureYmd — 문자열 사전순 비교", () => {
  assert.equal(isFutureYmd("2026-07-28", "2026-07-27"), true);
  assert.equal(isFutureYmd("2026-07-27", "2026-07-27"), false); // 오늘은 미래 아님
  assert.equal(isFutureYmd("2026-07-26", "2026-07-27"), false);
});

test("computeUpcomingDates — 오늘 이후, 요일 일치, N개", () => {
  // 오늘=월(2026-07-27), 반 요일=화(Tue) → 다음 화요일부터 4개
  const dates = computeUpcomingDates("2026-07-27", "Tue", 4);
  assert.deepEqual(dates, ["2026-07-28", "2026-08-04", "2026-08-11", "2026-08-18"]);
  // 전부 화요일인지 확인
  for (const d of dates) assert.equal(ymdToDayIndex(d), 2);
});

test("computeUpcomingDates — 오늘이 그 요일이면 오늘 제외(다음 주부터)", () => {
  // 오늘=월(2026-07-27), 반 요일=월(Mon) → 오늘 제외 → 다음 월요일부터
  const dates = computeUpcomingDates("2026-07-27", "Mon", 3);
  assert.deepEqual(dates, ["2026-08-03", "2026-08-10", "2026-08-17"]);
  assert.equal(dates.includes("2026-07-27"), false);
});

test("computeUpcomingDates — 잘못된 입력이면 빈 배열", () => {
  assert.deepEqual(computeUpcomingDates("bad", "Mon", 4), []);
  assert.deepEqual(computeUpcomingDates("2026-07-27", "Xyz", 4), []);
  assert.deepEqual(computeUpcomingDates("2026-07-27", "Mon", 0), []);
});

test("isReportableDate — 미래 + 요일 일치 모두 만족해야 true", () => {
  // 2026-07-28 = 화요일
  assert.equal(isReportableDate("2026-07-28", "Tue", "2026-07-27"), true);
  // 요일 불일치(수요일 반인데 화요일 날짜)
  assert.equal(isReportableDate("2026-07-28", "Wed", "2026-07-27"), false);
  // 과거
  assert.equal(isReportableDate("2026-07-21", "Tue", "2026-07-27"), false);
  // 오늘(미래 아님)
  assert.equal(isReportableDate("2026-07-27", "Mon", "2026-07-27"), false);
});
