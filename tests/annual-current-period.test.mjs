import test from "node:test";
import assert from "node:assert/strict";
import { getKoreanAnnualPeriod, isSameAnnualPeriod } from "../src/app/annual/annualPeriod.ts";

test("연간 일정의 기본 월은 UTC가 아닌 한국 날짜의 월을 사용한다", () => {
    assert.deepEqual(getKoreanAnnualPeriod(new Date("2026-09-30T14:59:59.999Z")), { year: 2026, month: 8 });
    assert.deepEqual(getKoreanAnnualPeriod(new Date("2026-09-30T15:00:00.000Z")), { year: 2026, month: 9 });
});

test("연말에도 한국의 1월로 연도와 월을 함께 넘긴다", () => {
    assert.deepEqual(getKoreanAnnualPeriod(new Date("2026-12-31T14:59:59.999Z")), { year: 2026, month: 11 });
    assert.deepEqual(getKoreanAnnualPeriod(new Date("2026-12-31T15:00:00.000Z")), { year: 2027, month: 0 });
    assert.equal(isSameAnnualPeriod({ year: 2026, month: 0 }, { year: 2027, month: 0 }), false);
    assert.equal(isSameAnnualPeriod({ year: 2026, month: 9 }, { year: 2026, month: 9 }), true);
});
