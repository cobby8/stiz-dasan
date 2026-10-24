import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const worker = readFileSync("src/lib/operationsSyncWorker.ts", "utf8");
const route = readFileSync("src/app/api/cron/operations-sync/route.ts", "utf8");
const vercel = readFileSync("vercel.json", "utf8");

test("운영 동기화 워커는 첫 단계에서 읽기 전용 점검만 제공한다", () => {
  assert.match(worker, /mode: "read-only"/);
  assert.match(worker, /summarizeOperationsSyncQueue/);
  assert.match(worker, /getOperationsSyncWorkItems/);
  assert.doesNotMatch(worker, /applySheetEnrollmentStatus|applyOperationsSheet|applyOperationsWebsite|recordOperationsExternalCheck/);
  assert.doesNotMatch(worker, /\$executeRawUnsafe/);
});

test("작업 후보는 시트 → 랠리즈 → 홈페이지 순서로 분류한다", () => {
  assert.match(worker, /CASE a\.target WHEN 'SHEET' THEN 0 WHEN 'RALLYZ' THEN 1 ELSE 2 END/);
  assert.match(worker, /a\.status = ANY\(\$1::text\[\]\)/);
  assert.match(worker, /OPEN_ATTEMPT_STATUSES = \["PENDING", "FAILED"\]/);
});

test("시트·랠리즈·홈페이지의 선행 조건을 분리한다", () => {
  assert.match(worker, /SUPPORTED_SHEET_KINDS = new Set\(\["PAUSE", "WITHDRAW"\]\)/);
  assert.match(worker, /READY_FOR_SHEET_APPLY/);
  assert.match(worker, /WAITING_FOR_SHEET/);
  assert.match(worker, /READY_FOR_RALLYZ_CHECK/);
  assert.match(worker, /WAITING_FOR_EXTERNALS/);
  assert.match(worker, /READY_FOR_WEBSITE_APPLY/);
});

test("보류·미래 적용일·진행 중 임대를 자동 실행 대상으로 보지 않는다", () => {
  assert.match(worker, /row\.commandStatus === "HELD" \|\| row\.holdReason/);
  assert.match(worker, /effectiveDate > kstTodayYmd\(now\)/);
  assert.match(worker, /ACTIVE_LEASE_MINUTES = 10/);
  assert.match(worker, /return item\("BUSY"/);
  assert.match(worker, /return item\("NOT_DUE"/);
});

test("크론 라우트는 CRON_SECRET 인증 후에도 요약만 반환한다", () => {
  assert.match(route, /process\.env\.CRON_SECRET/);
  assert.match(route, /authorization/);
  assert.match(route, /summarizeOperationsSyncQueue\(limit\)/);
  assert.doesNotMatch(route, /applySheetEnrollmentStatus|applyOperationsSheet|applyOperationsWebsite/);
});

test("자동 외부 쓰기가 준비되기 전까지 Vercel cron에는 등록하지 않는다", () => {
  const config = JSON.parse(vercel);
  assert.equal(config.crons.some((item) => item.path === "/api/cron/operations-sync"), false);
});
