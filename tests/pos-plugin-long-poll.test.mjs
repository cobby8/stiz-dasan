import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * POS 플러그인 롱폴링(2026-11-08) — 대기 루프를 가짜 시계·가짜 조회로 **실행**해 확인한다.
 * 위험: ① 20초 상한을 넘겨 Vercel 함수가 잘림 ② 이미 본 대기 요청 때문에 매번 즉시 답해 POS 요청 한도 소진
 *       ③ 끊긴 요청을 계속 붙잡아 DB 를 1초마다 두드림 ④ wait 없는 옛 호출(탭 화면)의 동작이 바뀜
 */

const LP = await import(pathToFileURL(path.resolve("src/lib/pos/plugin-long-poll.mjs")).href);
const ROUTE = "src/app/api/pos-plugin/charge-requests/route.ts";

/** 가짜 시계 + 잠자기(잔 만큼 시계가 간다) */
function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms) => (t += ms),
  };
}

const PENDING = (id) => ({ id, status: "PENDING" });
const SENT = (id) => ({ id, status: "SENT" });
const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002";

test("wait 파라미터: 없음·이상한 값 = 0, 소수는 버림, 최대 20초", () => {
  for (const v of [null, undefined, "", "abc", "-5", "0", "NaN", "Infinity"]) assert.equal(LP.parseWaitSeconds(v), 0, String(v));
  assert.equal(LP.parseWaitSeconds("5"), 5);
  assert.equal(LP.parseWaitSeconds("7.9"), 7);
  assert.equal(LP.parseWaitSeconds("20"), 20);
  assert.equal(LP.parseWaitSeconds("999"), 20);
  assert.equal(LP.MAX_WAIT_SEC, 20);
});

test("known 파라미터: 모양 틀린 id·중복은 버리고 최대 20개", () => {
  assert.deepEqual(LP.parseKnownIds(null), []);
  assert.deepEqual(LP.parseKnownIds(`${ID_A}, ${ID_A},'; DROP TABLE x;--,${ID_B}`), [ID_A, ID_B]);
  const many = Array.from({ length: 30 }, (_, i) => `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`).join(",");
  assert.equal(LP.parseKnownIds(many).length, 20);
});

test("wait=0: 기다리지 않고 바로 목록(예전 동작 그대로, 가벼운 조회도 안 부름)", async () => {
  const c = fakeClock();
  let hasNewCalls = 0;
  const r = await LP.waitForChargeRequests({
    waitSec: 0, known: [], listNow: async () => [SENT(ID_A)], hasNew: async () => (hasNewCalls++, true), now: c.now, sleep: c.sleep,
  });
  assert.deepEqual(r, { rows: [SENT(ID_A)], waited: false, woke: "immediate" });
  assert.equal(hasNewCalls, 0);
  assert.deepEqual(c.sleeps, []);
});

test("모르는 대기 요청이 이미 있으면 즉시 답", async () => {
  const c = fakeClock();
  const r = await LP.waitForChargeRequests({
    waitSec: 20, known: [], listNow: async () => [PENDING(ID_A)], hasNew: async () => false, now: c.now, sleep: c.sleep,
  });
  assert.equal(r.woke, "immediate");
  assert.deepEqual(c.sleeps, []);
});

test("이미 본 대기 요청(known)뿐이면 즉시 답하지 않고 기다린다 — 1초 재질문 폭주 방지", async () => {
  const c = fakeClock();
  const r = await LP.waitForChargeRequests({
    waitSec: 5, known: [ID_A], listNow: async () => [PENDING(ID_A)], hasNew: async () => false, now: c.now, sleep: c.sleep,
  });
  assert.equal(r.woke, "timeout");
  assert.deepEqual(r.rows, [PENDING(ID_A)]);
});

test("기다리다 새 요청이 생기면 그 순간 목록을 다시 읽어 답한다(약 1초 간격 확인)", async () => {
  const c = fakeClock();
  let lists = 0;
  let checks = 0;
  const r = await LP.waitForChargeRequests({
    waitSec: 20,
    known: [],
    listNow: async () => (++lists === 1 ? [] : [PENDING(ID_B)]),
    hasNew: async (known) => {
      assert.deepEqual(known, []);
      return ++checks === 3; // 3초째에 새 요청
    },
    now: c.now,
    sleep: c.sleep,
  });
  assert.deepEqual(r, { rows: [PENDING(ID_B)], waited: true, woke: "new" });
  assert.deepEqual(c.sleeps, [1000, 1000, 1000]);
  assert.equal(lists, 2);
});

test("아무것도 안 생기면 wait 초 뒤 처음 목록으로 답하고, 상한(20초)을 넘기지 않는다", async () => {
  const c = fakeClock();
  const start = c.now();
  let checks = 0;
  const r = await LP.waitForChargeRequests({
    waitSec: 999, known: [], listNow: async () => [SENT(ID_A)], hasNew: async () => (checks++, false), now: c.now, sleep: c.sleep,
  });
  assert.equal(r.woke, "timeout");
  assert.deepEqual(r.rows, [SENT(ID_A)]);
  assert.ok(c.now() - start <= 20_000, `${c.now() - start}ms`);
  // DB 부하: 20초 동안 가벼운 확인 약 1초에 1번
  assert.ok(checks <= 20, `${checks}`);
});

test("조회가 느려도 상한을 넘기지 않는다(남은 시간만큼만 잔다)", async () => {
  const c = fakeClock();
  const start = c.now();
  const r = await LP.waitForChargeRequests({
    waitSec: 3,
    known: [],
    listNow: async () => [],
    hasNew: async () => (c.advance(700), false), // 확인 한 번에 0.7초
    now: c.now,
    sleep: c.sleep,
  });
  assert.equal(r.woke, "timeout");
  assert.ok(c.now() - start <= 3_000 + 700, `${c.now() - start}`);
  assert.ok(c.sleeps.every((ms) => ms > 0 && ms <= 1000));
});

test("클라이언트가 끊으면(abort) 바로 멈춘다", async () => {
  const c = fakeClock();
  const signal = { aborted: false };
  let checks = 0;
  const r = await LP.waitForChargeRequests({
    waitSec: 20,
    known: [],
    listNow: async () => [],
    hasNew: async () => {
      if (++checks === 2) signal.aborted = true;
      return false;
    },
    now: c.now,
    sleep: c.sleep,
    signal,
  });
  assert.equal(r.woke, "aborted");
  assert.equal(checks, 2);
});

test("라우트: wait·known 을 순수 모듈로 읽고, 인증(handlePluginRequest)·CORS(OPTIONS) 그대로, maxDuration 30, waitSec 표시", async () => {
  const code = await readFile(ROUTE, "utf8");
  assert.match(code, /parseWaitSeconds\(req\.nextUrl\.searchParams\.get\("wait"\)\)/);
  assert.match(code, /parseKnownIds\(req\.nextUrl\.searchParams\.get\("known"\)\)/);
  assert.match(code, /return handlePluginRequest\(req, async/);
  assert.match(code, /export function OPTIONS\(req: NextRequest\)\s*\{\s*return preflight\(req\)/);
  assert.match(code, /export const maxDuration = 30;/);
  assert.match(code, /signal: req\.signal/);
  assert.match(code, /waitSec > 0 \? \{ requests: rows, waitSec \} : \{ requests: rows \}/);
  // 대기 중 확인은 가벼운 EXISTS(만료 UPDATE·JOIN 없음)
  const svc = await readFile("src/lib/pos/chargeRequestService.ts", "utf8");
  const fn = /export async function hasUnknownPendingChargeRequest[\s\S]*?\n\}/.exec(svc)?.[0] ?? "";
  assert.match(fn, /SELECT EXISTS/);
  assert.match(fn, /NOT \(id = ANY\(\$1::text\[\]\)\)/);
  assert.doesNotMatch(fn, /UPDATE|JOIN/);
});
