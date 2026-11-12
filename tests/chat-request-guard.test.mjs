// 상담 챗봇(/api/chat) 횟수·길이 제한 실행 테스트(d3, 2026-11-13)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CHAT_MAX_HISTORY,
  CHAT_MAX_INPUT_CHARS,
  CHAT_RATE_LIMITS,
  sanitizeChatMessages,
} from "../src/lib/chat/chatRequestGuard.ts";
import { resetPublicRateLimitsForTests, takePublicRateLimit } from "../src/lib/seasonal/public-rate-limit.ts";

test("빈 값·배열 아님은 거절", () => {
  assert.equal(sanitizeChatMessages(undefined).ok, false);
  assert.equal(sanitizeChatMessages([]).ok, false);
  assert.equal(sanitizeChatMessages("hi").ok, false);
});

test("이번 질문이 너무 길면 거절, 딱 한도면 통과", () => {
  assert.equal(sanitizeChatMessages([{ role: "user", content: "가".repeat(CHAT_MAX_INPUT_CHARS + 1) }]).ok, false);
  assert.equal(sanitizeChatMessages([{ role: "user", content: "가".repeat(CHAT_MAX_INPUT_CHARS) }]).ok, true);
});

test("마지막이 챗봇 답이거나 공백이면 거절", () => {
  assert.equal(sanitizeChatMessages([{ role: "model", content: "안녕" }]).ok, false);
  assert.equal(sanitizeChatMessages([{ role: "user", content: "   " }]).ok, false);
});

test("이상한 role·content 는 버리고, 앞 대화는 최근 20개·사용자 글로 시작", () => {
  const long = [];
  for (let i = 0; i < 41; i++) long.push({ role: i % 2 === 0 ? "user" : "model", content: `m${i}` });
  long.push({ role: "system", content: "무시" }, { role: "user", content: 123 });
  const r = sanitizeChatMessages(long);
  assert.equal(r.ok, true);
  // 마지막 m40(user) 앞의 20개 = m20..m39 → m20 은 user 라 그대로
  assert.equal(r.messages.length, CHAT_MAX_HISTORY + 1);
  assert.equal(r.messages[0].role, "user");
  assert.equal(r.messages.at(-1).content, "m40");

  const startsWithModel = [{ role: "model", content: "인사" }, { role: "user", content: "질문" }];
  const r2 = sanitizeChatMessages(startsWithModel);
  assert.deepEqual(r2.messages, [{ role: "user", content: "질문" }]);
});

test("IP 횟수 제한: 1분에 5번까지, 6번째는 막힌다 · 1분 뒤 다시 열린다", () => {
  resetPublicRateLimitsForTests();
  const minute = CHAT_RATE_LIMITS.find((r) => r.scope === "minute");
  assert.equal(minute.limit, 5);
  const now = 1_000_000;
  for (let i = 0; i < 5; i++) assert.equal(takePublicRateLimit("chat:minute:1.1.1.1", { ...minute, now }).allowed, true);
  assert.equal(takePublicRateLimit("chat:minute:1.1.1.1", { ...minute, now }).allowed, false);
  // 다른 IP 는 영향 없음
  assert.equal(takePublicRateLimit("chat:minute:2.2.2.2", { ...minute, now }).allowed, true);
  assert.equal(takePublicRateLimit("chat:minute:1.1.1.1", { ...minute, now: now + 60_001 }).allowed, true);
});

test("하루 한도는 50번", () => {
  const day = CHAT_RATE_LIMITS.find((r) => r.scope === "day");
  assert.equal(day.limit, 50);
  assert.equal(day.windowMs, 86_400_000);
});

test("/api/chat 이 제한을 실제로 쓴다", () => {
  const src = readFileSync(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");
  assert.match(src, /takePublicRateLimit\(`chat:\$\{rule\.scope\}:\$\{ipKey\}`/);
  assert.match(src, /status: 429/);
  assert.match(src, /sanitizeChatMessages\(body\?\.messages\)/);
});

test("챗봇 IP: x-forwarded-for 첫 값 → x-real-ip, cf-connecting-ip 는 믿지 않는다", async () => {
  const { chatClientIpKey } = await import("../src/lib/chat/chatRequestGuard.ts");
  const h = (o) => ({ get: (k) => o[k] ?? null });
  assert.equal(chatClientIpKey(h({ "x-forwarded-for": "1.1.1.1, 9.9.9.9", "x-real-ip": "2.2.2.2", "cf-connecting-ip": "3.3.3.3" })), "1.1.1.1");
  assert.equal(chatClientIpKey(h({ "x-real-ip": "2.2.2.2", "cf-connecting-ip": "3.3.3.3" })), "2.2.2.2");
  assert.equal(chatClientIpKey(h({ "cf-connecting-ip": "3.3.3.3" })), "unknown");
  const src = readFileSync(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");
  assert.match(src, /chatClientIpKey\(request\.headers\)/);
  assert.doesNotMatch(src, /clientIpKey\(request\)/);
});
