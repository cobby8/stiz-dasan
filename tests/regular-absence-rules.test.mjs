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
  VALID_REASONS,
  REASON_LABEL,
} = await loadTsModule("src/lib/regular/regularAbsenceRules.ts");
// 이월 대상 사유 ↔ 인정 분류 짝(2026-11-17) — import 없는 순수 파일
const {
  CARRY_REVIEW_REASONS,
  CARRY_NOT_ELIGIBLE_MESSAGE,
  CARRY_PAIR_MISMATCH_MESSAGE,
  isCarryReviewReason,
  carryEligibilityForReason,
  carryPairProblem,
} = await loadTsModule("src/lib/regular/carryReasonRules.ts");

test("사유 검증 — 6종만 허용(2026-11-17 경조사 추가)", () => {
  assert.equal(isValidReason("ILLNESS_INJURY"), true);
  assert.equal(isValidReason("ETC"), true);
  assert.equal(isValidReason("FAMILY_EVENT"), true);
  assert.equal(isValidReason("UNKNOWN"), false);
  assert.equal(isValidReason(""), false);
  assert.equal(isValidReason(null), false);
  assert.equal(VALID_REASONS.length, 6);
  for (const r of VALID_REASONS) assert.ok(REASON_LABEL[r], `${r} 라벨`);
  assert.equal(REASON_LABEL.FAMILY_EVENT, "경조사(직계 가족)");
});

test("사유 순서 — 카카오 번호(1번~5번)가 밀리지 않게 새 사유는 맨 뒤", () => {
  assert.deepEqual([...VALID_REASONS], ["ILLNESS_INJURY", "PERSONAL", "FAMILY_TRIP", "SCHOOL_EVENT", "ETC", "FAMILY_EVENT"]);
});

test("이월 검토 대상 사유 = 질병·부상 · 직계 가족 경조사 둘뿐(약관)", () => {
  assert.deepEqual([...CARRY_REVIEW_REASONS].sort(), ["FAMILY_EVENT", "ILLNESS_INJURY"]);
  assert.equal(isCarryReviewReason("ILLNESS_INJURY"), true);
  assert.equal(isCarryReviewReason("FAMILY_EVENT"), true);
  for (const r of ["PERSONAL", "FAMILY_TRIP", "SCHOOL_EVENT", "ETC", "", null, undefined, "toString", "__proto__"]) {
    assert.equal(isCarryReviewReason(r), false, String(r));
    assert.equal(carryEligibilityForReason(r), null, String(r));
  }
  assert.equal(carryEligibilityForReason("ILLNESS_INJURY"), "ILLNESS_INJURY");
  assert.equal(carryEligibilityForReason("FAMILY_EVENT"), "DIRECT_FAMILY_EVENT");
});

test("사유-분류 짝 — 맞는 짝만 이월 허용, 다른 사유는 분류와 상관없이 거절", () => {
  // 맞는 짝
  assert.equal(carryPairProblem("ILLNESS_INJURY", "ILLNESS_INJURY"), null);
  assert.equal(carryPairProblem("DIRECT_FAMILY_EVENT", "FAMILY_EVENT"), null);
  // 어긋난 짝(둘 다 이월 대상 사유지만 분류가 다름)
  assert.equal(carryPairProblem("DIRECT_FAMILY_EVENT", "ILLNESS_INJURY"), CARRY_PAIR_MISMATCH_MESSAGE);
  assert.equal(carryPairProblem("ILLNESS_INJURY", "FAMILY_EVENT"), CARRY_PAIR_MISMATCH_MESSAGE);
  assert.equal(carryPairProblem("NONE", "FAMILY_EVENT"), CARRY_PAIR_MISMATCH_MESSAGE);
  // 예전 구멍: «직계가족 경조사» 분류로 개인 사정·여행 결석을 이월하던 길 — 모두 거절
  for (const reason of ["PERSONAL", "FAMILY_TRIP", "SCHOOL_EVENT", "ETC", "", null, undefined]) {
    for (const eligibility of ["ILLNESS_INJURY", "DIRECT_FAMILY_EVENT", "NONE"]) {
      assert.equal(carryPairProblem(eligibility, reason), CARRY_NOT_ELIGIBLE_MESSAGE, `${eligibility}/${reason}`);
    }
  }
  assert.equal(CARRY_NOT_ELIGIBLE_MESSAGE, "약관상 이월 대상(질병·부상, 직계 경조사)이 아닌 결석은 보강으로만 처리됩니다");
});

test("짝 규칙 파일은 import 0 — 이월 대상 사유는 모두 결석 사유 목록에 있다", async () => {
  const { readFileSync } = await import("node:fs");
  assert.doesNotMatch(readFileSync("src/lib/regular/carryReasonRules.ts", "utf8"), /^import /m, "청구 준비 테스트 로더가 그대로 끼워 실행한다");
  for (const r of CARRY_REVIEW_REASONS) assert.ok(VALID_REASONS.includes(r), r);
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
