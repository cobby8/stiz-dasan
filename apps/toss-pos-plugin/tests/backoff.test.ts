// 폴링 간격·지수 백오프·요청 제한 검산
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EARLY_RETURN_MS,
  LONG_POLL_WAIT_SEC,
  POLL_BASE_MS,
  POLL_MAX_MS,
  RATE_LIMIT_MIN_MS,
  maxLongPollsIn,
  maxPollsIn,
  nextAfterLongPoll,
  nextPollDelay,
} from "../src/core/backoff.ts";

const MID = { random: 0.5 }; // 흔들기 없음(×1.0)

test("옛 서버(롱폴링 모름)·실패 백오프의 기본 간격은 14초", () => {
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

test("롱폴링: 대기를 다 채우고 답하면 곧바로(0초) 다음 대기, 일찍 답하면 0→1→2→4→8→14초", () => {
  assert.equal(LONG_POLL_WAIT_SEC, 20);
  assert.deepEqual(nextAfterLongPoll({ longPoll: true, elapsedMs: 20_050, earlyStreak: 3 }), { delayMs: 0, earlyStreak: 0 });
  assert.deepEqual(nextAfterLongPoll({ longPoll: true, elapsedMs: EARLY_RETURN_MS, earlyStreak: 0 }), { delayMs: 0, earlyStreak: 0 });
  const delays: number[] = [];
  let streak = 0;
  for (let k = 0; k < 8; k++) {
    const n = nextAfterLongPoll({ longPoll: true, elapsedMs: 1_200, earlyStreak: streak });
    delays.push(n.delayMs);
    streak = n.earlyStreak;
  }
  assert.deepEqual(delays, [0, 1_000, 2_000, 4_000, 8_000, 14_000, 14_000, 14_000]);
});

test("롱폴링: 옛 서버면(응답에 waitSec 없음) 예전처럼 14초(±10%) 간격", () => {
  assert.deepEqual(nextAfterLongPoll({ longPoll: false, elapsedMs: 50, earlyStreak: 4 }, MID), { delayMs: 14_000, earlyStreak: 0 });
});

test("요청 제한 검산(롱폴링): 정상 30분 90번, 최악(계속 일찍 답함)에도 30분 200번·60초 100번 안에서 결제 처리 몫을 남긴다", () => {
  // 토스 POS 한도: 이벤트 제외 모든 요청(http 포함) 60초 100번 · 30분 200번. 결제 1건 ≈ SDK 호출 13번(charge.ts 머리말)
  const PER_CHARGE = 13;
  const normal30m = maxLongPollsIn(30 * 60_000, "normal");
  assert.equal(normal30m, 90);
  assert.ok(Math.floor((200 - normal30m) / PER_CHARGE) >= 8, "정상이면 30분에 결제 8건 이상 처리 몫");
  const worst30m = maxLongPollsIn(30 * 60_000, "worst");
  assert.ok(worst30m <= 135, `${worst30m}`);
  assert.ok(Math.floor((200 - worst30m) / PER_CHARGE) >= 4, `최악에도 결제 4건 몫: ${worst30m}`);
  const worst60s = maxLongPollsIn(60_000, "worst");
  assert.ok(worst60s + 3 * PER_CHARGE <= 100, `60초 최악 ${worst60s}번 + 결제 3건`);
});

test("요청 제한 검산(옛 서버 대비 14초 폴링): 워커 폴링이 30분 200번·60초 100번 안에서 결제 처리 몫 50번 이상을 남긴다", () => {
  // 탭 화면은 개발자센터에 별도 플러그인(stiz-pos-charge-tab)으로 등록돼 한도를 따로 쓴다
  const worker30m = maxPollsIn(30 * 60_000, POLL_BASE_MS);
  assert.ok(worker30m <= 150, `${worker30m}`);
  assert.ok(maxPollsIn(60_000, POLL_BASE_MS) <= 5);
});
