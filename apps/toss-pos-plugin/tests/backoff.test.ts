// 폴링 간격·지수 백오프·요청 제한 검산
import { test } from "node:test";
import assert from "node:assert/strict";
import { POLL_BASE_MS, POLL_MAX_MS, RATE_LIMIT_MIN_MS, maxPollsIn, nextPollDelay } from "../src/core/backoff.ts";

const MID = { random: 0.5 }; // 흔들기 없음(×1.0)

test("정상이면 기본 30초", () => {
  assert.equal(nextPollDelay(0, MID), 30_000);
});

test("실패할수록 2배씩 늘고 10분에서 멈춘다", () => {
  assert.equal(nextPollDelay(1, MID), 60_000);
  assert.equal(nextPollDelay(2, MID), 120_000);
  assert.equal(nextPollDelay(3, MID), 240_000);
  assert.equal(nextPollDelay(4, MID), 480_000);
  assert.equal(nextPollDelay(5, MID), POLL_MAX_MS);
  assert.equal(nextPollDelay(100, MID), POLL_MAX_MS);
});

test("흔들기는 ±20% 안, 상한은 넘지 않음", () => {
  assert.equal(nextPollDelay(0, { random: 0 }), 24_000);
  assert.equal(nextPollDelay(0, { random: 1 }), 36_000);
  assert.equal(nextPollDelay(10, { random: 1 }), POLL_MAX_MS);
});

test("요청 제한에 걸리면 최소 2분", () => {
  assert.ok(nextPollDelay(0, { random: 0, rateLimited: true }) >= RATE_LIMIT_MIN_MS * 0.8);
  assert.equal(nextPollDelay(0, { ...MID, rateLimited: true }), RATE_LIMIT_MIN_MS);
});

test("음수·소수 실패 횟수도 안전", () => {
  assert.equal(nextPollDelay(-3, MID), 30_000);
  assert.equal(nextPollDelay(1.9, MID), 60_000);
});

test("요청 제한 검산: 워커 폴링(30초)+탭(60초)이 30분 200번·60초 100번 안", () => {
  const worker30m = maxPollsIn(30 * 60_000, POLL_BASE_MS);
  const tab30m = Math.ceil((30 * 60_000) / 60_000);
  // 폴링 외 SDK 호출(알림·주문 조작·결제 조회)에 최소 50번 여유를 남긴다
  assert.ok(worker30m + tab30m <= 150, `${worker30m}+${tab30m}`);
  assert.ok(maxPollsIn(60_000, POLL_BASE_MS) <= 3);
});
