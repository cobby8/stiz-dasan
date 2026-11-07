// 폴링 간격·지수 백오프·요청 제한 검산
import { test } from "node:test";
import assert from "node:assert/strict";
import { POLL_BASE_MS, POLL_MAX_MS, RATE_LIMIT_MIN_MS, maxPollsIn, nextPollDelay } from "../src/core/backoff.ts";

const MID = { random: 0.5 }; // 흔들기 없음(×1.0)

test("정상이면 기본 14초", () => {
  assert.equal(POLL_BASE_MS, 14_000);
  assert.equal(nextPollDelay(0, MID), 14_000);
});

test("실패할수록 2배씩 늘고 10분에서 멈춘다", () => {
  assert.equal(nextPollDelay(1, MID), 28_000);
  assert.equal(nextPollDelay(2, MID), 56_000);
  assert.equal(nextPollDelay(3, MID), 112_000);
  assert.equal(nextPollDelay(4, MID), 224_000);
  assert.equal(nextPollDelay(5, MID), 448_000);
  assert.equal(nextPollDelay(6, MID), POLL_MAX_MS);
  assert.equal(nextPollDelay(100, MID), POLL_MAX_MS);
});

test("흔들기는 ±10% 안, 상한은 넘지 않음", () => {
  assert.equal(nextPollDelay(0, { random: 0 }), 12_600);
  assert.equal(nextPollDelay(0, { random: 1 }), 15_400);
  assert.equal(nextPollDelay(10, { random: 1 }), POLL_MAX_MS);
});

test("요청 제한에 걸리면 최소 2분", () => {
  assert.ok(nextPollDelay(0, { random: 0, rateLimited: true }) >= RATE_LIMIT_MIN_MS * 0.9);
  assert.equal(nextPollDelay(0, { ...MID, rateLimited: true }), RATE_LIMIT_MIN_MS);
});

test("음수·소수 실패 횟수도 안전", () => {
  assert.equal(nextPollDelay(-3, MID), 14_000);
  assert.equal(nextPollDelay(1.9, MID), 28_000);
});

test("요청 제한 검산: 워커 폴링이 30분 200번·60초 100번 안에서 결제 처리 몫 50번 이상을 남긴다", () => {
  // 탭 화면은 개발자센터에 별도 플러그인(stiz-pos-charge-tab)으로 등록돼 한도를 따로 쓴다
  const worker30m = maxPollsIn(30 * 60_000, POLL_BASE_MS);
  assert.ok(worker30m <= 150, `${worker30m}`);
  assert.ok(maxPollsIn(60_000, POLL_BASE_MS) <= 5);
});
