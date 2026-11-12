// cron 실패 슬랙 알림 실행 테스트 + «모든 cron 이 래퍼를 쓴다» 정적 가드(d4, 2026-11-13)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { createWithCronAlert, CRON_ALERT_WINDOW_MS, shortReason } from "../src/lib/cron/cronAlertCore.ts";

function fixture(startMs = 1_000_000_000) {
  let now = startMs;
  const sent = [];
  const logs = [];
  const withCronAlert = createWithCronAlert({
    now: () => now,
    async sendOncePerWindow(name, windowKey, text) { sent.push({ name, windowKey, text }); },
    log: (...a) => logs.push(a),
  });
  return { withCronAlert, sent, logs, advance: (ms) => { now += ms; } };
}

test("정상(200)·인증 실패(401)는 알리지 않고 응답을 그대로 돌려준다", async () => {
  const f = fixture();
  const ok = f.withCronAlert("a", async () => Response.json({ ok: true }));
  const unauthorized = f.withCronAlert("b", async () => Response.json({ error: "Unauthorized" }, { status: 401 }));
  assert.equal((await ok()).status, 200);
  assert.equal((await unauthorized()).status, 401);
  assert.equal(f.sent.length, 0);
});

test("500 응답이면 알리고, 응답 본문·상태는 그대로", async () => {
  const f = fixture();
  const route = f.withCronAlert("backup", async () => Response.json({ error: "업로드 실패" }, { status: 500 }));
  const res = await route();
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "업로드 실패" });
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /backup — 응답 500: 업로드 실패/);
});

test("예외면 알리고 같은 예외를 다시 던진다", async () => {
  const f = fixture();
  const boom = new Error("DB 연결 끊김");
  const route = f.withCronAlert("billing", async () => { throw boom; });
  await assert.rejects(route(), (e) => e === boom);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /billing — 예외: Error: DB 연결 끊김/);
});

test("같은 cron 은 1시간에 1번만, 다른 cron 은 따로, 1시간 지나면 다시", async () => {
  const f = fixture();
  const a = f.withCronAlert("push-outbox", async () => new Response("x", { status: 503 }));
  const b = f.withCronAlert("scheduled-messages", async () => new Response("x", { status: 500 }));
  for (let i = 0; i < 60; i++) { await a(); f.advance(59_000); }
  assert.equal(f.sent.filter((s) => s.name === "push-outbox").length, 1);
  await b();
  assert.equal(f.sent.filter((s) => s.name === "scheduled-messages").length, 1);
  f.advance(CRON_ALERT_WINDOW_MS);
  await a();
  assert.equal(f.sent.filter((s) => s.name === "push-outbox").length, 2);
});

test("알림 보내기가 실패해도 cron 응답은 그대로", async () => {
  const logs = [];
  const withCronAlert = createWithCronAlert({
    now: () => 0,
    async sendOncePerWindow() { throw new Error("slack down"); },
    log: (...a) => logs.push(a),
  });
  const res = await withCronAlert("x", async () => new Response("err", { status: 500 }))();
  assert.equal(res.status, 500);
  assert.equal(logs.length, 1);
});

test("긴 오류 문구는 한 줄로 줄인다", () => {
  assert.equal(shortReason("a\n\nb"), "a b");
  assert.ok(shortReason("가".repeat(500)).length <= 161);
});

test("모든 cron 경로가 withCronAlert 로 GET 을 내보낸다(payment-overdue 는 담당 세션이 추가)", () => {
  const dir = new URL("../src/app/api/cron/", import.meta.url);
  const missing = [];
  for (const name of readdirSync(dir)) {
    const file = new URL(`${name}/route.ts`, dir);
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    if (name === "payment-overdue" && !src.includes("withCronAlert")) continue; // 다른 담당이 새로 만드는 중
    if (!new RegExp(`export const GET = withCronAlert\\("${name}", `).test(src) || /export async function GET\(/.test(src)) {
      missing.push(name);
    }
  }
  assert.deepEqual(missing, []);
});
