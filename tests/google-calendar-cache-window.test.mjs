// 구글 달력 일정 보관 시간 = 1시간(2026-11-18 원장 결정 · 속도 개선) — 정적 테스트
//
// 왜: 5분 보관일 때 학부모 홈을 여는 5번 중 1번이 구글 응답(약 0.45초)을 기다렸다.
//     누가 다시 짧게 줄이거나, 반대로 청구 계산까지 보관본을 쓰게 만들지 않도록 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../src/lib/googleCalendar.ts", import.meta.url), "utf8");

test("일반 화면은 1시간 보관본을 쓴다 — 달력 API 길과 ICS 길 둘 다", () => {
  assert.match(src, /export const CALENDAR_CACHE_SECONDS = 3600;/);
  assert.equal(src.split("{ next: { revalidate: CALENDAR_CACHE_SECONDS } }").length - 1, 2);
  assert.doesNotMatch(src, /revalidate: \d/, "보관 시간을 숫자로 따로 적지 않는다");
});

test("청구처럼 fresh 로 부르면 보관본을 쓰지 않는다(두 길 모두)", () => {
  assert.equal(src.split('options.fresh ? { cache: "no-store" } : { next: { revalidate: CALENDAR_CACHE_SECONDS } }').length - 1, 2);
});
