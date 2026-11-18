import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const vercel = readFileSync("vercel.json", "utf8");

// 2026-11-18 옛 코드 정리 B: 읽기 전용 요약만 돌려주던 운영 동기화 워커와 그 크론은
// 들어오는 길이 없어(vercel cron 미등록·호출 0건) 파일째 지웠다.
test("운영 동기화 워커·크론 라우트는 지워져 있다", () => {
  assert.equal(existsSync("src/lib/operationsSyncWorker.ts"), false);
  assert.equal(existsSync("src/app/api/cron/operations-sync/route.ts"), false);
});

test("Vercel cron 에 운영 동기화가 등록돼 있지 않다", () => {
  const config = JSON.parse(vercel);
  assert.equal(config.crons.some((item) => item.path === "/api/cron/operations-sync"), false);
});
