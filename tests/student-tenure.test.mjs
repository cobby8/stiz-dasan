import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 순수 모듈을 실제로 실행해 경계를 확인한다(문자열 매칭이 아니라 계산 결과로)
const { computeStudentTenure, formatTenureMonths } = await loadTsModule("src/lib/student-tenure.ts");

const base = { baselineMonths: null, baselineThrough: null, firstMonth: null, liveMonths: [], currentMonth: "2026-11" };

test("개월 라벨: 12·24·38·11·0", () => {
  assert.equal(formatTenureMonths(12), "1년");
  assert.equal(formatTenureMonths(24), "2년");
  assert.equal(formatTenureMonths(38), "3년 2개월");
  assert.equal(formatTenureMonths(11), "11개월");
  assert.equal(formatTenureMonths(0), "0개월");
});

test("기준월과 같은 달(및 그 이전) 사이트 기록은 두 번 세지 않는다", () => {
  const result = computeStudentTenure({
    ...base,
    baselineMonths: 36,
    baselineThrough: "2026-10",
    firstMonth: "2023-10",
    // 2026-10 은 baseline 에 이미 들어 있고, 2026-09 도 이전 달이라 제외 → 2026-11 만 추가(중복 제거)
    liveMonths: ["2026-09", "2026-10", "2026-10", "2026-11", "2026-11"],
  });
  assert.equal(result.actualMonths, 37);
  assert.equal(result.firstMonth, "2023-10");
  assert.equal(result.spanMonths, 38); // 2023-10 ~ 2026-11 (이번 달 포함)
  assert.equal(result.spanLabel, "3년 2개월");
  assert.equal(result.label, "3년 1개월");
});

test("이번 달보다 뒤(미래) 달은 세지 않는다", () => {
  const result = computeStudentTenure({
    ...base,
    baselineMonths: 10,
    baselineThrough: "2026-10",
    firstMonth: "2025-12",
    liveMonths: ["2026-11", "2026-12", "2027-01"],
  });
  assert.equal(result.actualMonths, 11);
});

test("baseline 이 없으면 사이트 기록 달만 센다, 첫 등록월은 기록 최솟값", () => {
  const result = computeStudentTenure({
    ...base,
    liveMonths: ["2026-03", "2025-12", "2026-01", "bad", "2026-03"],
  });
  assert.equal(result.actualMonths, 3);
  assert.equal(result.firstMonth, "2025-12");
  assert.equal(result.spanMonths, 12); // 2025-12 ~ 2026-11
  assert.equal(result.spanLabel, "1년");
});

test("baseline 개월은 있는데 기준월이 비었으면 baseline 을 쓰지 않는다(두 번 셀 위험)", () => {
  const result = computeStudentTenure({ ...base, baselineMonths: 30, liveMonths: ["2026-11"] });
  assert.equal(result.actualMonths, 1);
});

test("baseline 만 있고 사이트 기록이 없어도 표시된다", () => {
  const result = computeStudentTenure({ ...base, baselineMonths: 24, baselineThrough: "2026-10", firstMonth: "2024-11" });
  assert.equal(result.actualMonths, 24);
  assert.equal(result.label, "2년");
});

test("자료가 하나도 없으면 null (화면 표시 안 함)", () => {
  assert.equal(computeStudentTenure(base), null);
  assert.equal(computeStudentTenure({ ...base, currentMonth: "2026-13" }), null);
});

test("연말 경계: 12월 → 1월도 한 달 차이로 센다", () => {
  const result = computeStudentTenure({
    ...base,
    currentMonth: "2027-01",
    baselineMonths: 5,
    baselineThrough: "2026-12",
    firstMonth: "2026-08",
    liveMonths: ["2026-12", "2027-01"],
  });
  assert.equal(result.actualMonths, 6);
  assert.equal(result.spanMonths, 6);
});

test("첫 등록월이 이번 달보다 뒤(입력 실수)면 기간은 계산하지 않는다", () => {
  const result = computeStudentTenure({ ...base, baselineMonths: 3, baselineThrough: "2026-10", firstMonth: "2027-02" });
  assert.equal(result.spanMonths, null);
  assert.equal(result.spanLabel, null);
  assert.equal(result.actualMonths, 3);
});
