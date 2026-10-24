import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync("src/app/actions/operations-sync.ts", "utf8");
const infrastructure = readFileSync("src/lib/operationsSyncInfrastructure.ts", "utf8");
const migration = readFileSync("prisma/migrations/20260827223000_add_operations_sync_processing_lease/migration.sql", "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");

test("외부 반영은 만료 가능한 임대 토큰으로 동시 실행을 막는다", () => {
  assert.match(action, /a\.status IN \('PENDING','FAILED'\)/);
  assert.match(action, /"processingStartedAt" < now\(\) - interval '10 minutes'/);
  assert.match(action, /SET "processingToken"=\$3, "processingStartedAt"=now\(\)/);
  assert.match(action, /같은 반영 작업이 이미 진행 중입니다/);
});

test("성공 대상은 재호출하지 않고 실패 대상만 재시도한다", () => {
  assert.match(action, /if \(current\[0\]\?\.status === "SUCCEEDED"\) return \{ token: null, skipped: true/);
  assert.match(action, /a\.status IN \('PENDING','FAILED'\)/);
  assert.match(action, /previousStatus === "FAILED" \? "SYNC_TARGET_RETRIED"/);
  assert.match(action, /a\.status <> 'SUCCEEDED'/);
});

test("성공·실패·재시도·상태 변경을 감사로그에 남긴다", () => {
  for (const event of [
    "SYNC_TARGET_STARTED",
    "SYNC_TARGET_RETRIED",
    "SYNC_TARGET_SUCCEEDED",
    "SYNC_TARGET_FAILED",
    "COMMAND_STATUS_CHANGED",
    "REQUEST_STATUS_CHANGED",
  ]) assert.match(action, new RegExp(event));
});

test("승인은 요청과 명령을 잠가 동시에 두 번 승인되지 않는다", () => {
  const approveBody = action.slice(action.indexOf("function approveOperationsRequest"), action.indexOf("function applyOperationsWebsite"));
  assert.match(approveBody, /SELECT id FROM "OperationsRequest" WHERE id=\$1 FOR UPDATE/);
  assert.match(approveBody, /ORDER BY "createdAt" FOR UPDATE/);
});

test("임대 컬럼은 런타임 보장과 마이그레이션 양쪽에 존재한다", () => {
  for (const column of ['"processingToken"', '"processingStartedAt"']) {
    assert.match(infrastructure, new RegExp(column));
    assert.match(migration, new RegExp(column));
  }
  assert.match(schema, /model OperationsSyncAttempt[\s\S]*processingToken\s+String\?/);
  assert.match(schema, /model OperationsSyncAttempt[\s\S]*processingStartedAt\s+DateTime\?/);
});

test("raw SQL 운영 원장 모델을 Prisma 스키마에도 유지한다", () => {
  for (const model of ["ParentOperationsRequestLink", "OperationsRequest", "OperationsCommand", "OperationsSyncAttempt", "OperationsAuditLog"]) {
    assert.match(schema, new RegExp(`model ${model}\\s*\\{`));
  }
  assert.match(schema, /model OperationsCommand[\s\S]*idempotencyKey\s+String\s+@unique/);
  assert.match(schema, /model OperationsSyncAttempt[\s\S]*@@unique\(\[commandId, target\]\)/);
});

test("외부 완료 CAS와 감사로그는 분리되어 감사 장애가 성공 상태를 롤백하지 않는다", () => {
  const finishStart = action.indexOf("async function finishSyncAttempt");
  const auditStart = action.indexOf("async function recordOperationsAuditBestEffort");
  const finishBody = action.slice(finishStart, auditStart);
  assert.match(finishBody, /const rows = await prisma\.\$queryRawUnsafe/);
  assert.doesNotMatch(finishBody, /prisma\.\$transaction/);
  assert.match(finishBody, /await recordOperationsAuditBestEffort/);
  assert.match(action.slice(auditStart), /console\.error\("\[operations-sync\] 감사로그 저장 실패"/);
});

test("상태 집계도 먼저 커밋하고 감사로그는 best-effort로 분리한다", () => {
  const refreshStart = action.indexOf("async function refreshOperationsStatuses");
  const refreshBody = action.slice(refreshStart);
  const transactionEnd = refreshBody.indexOf("if (!changes) return");
  assert.ok(transactionEnd > 0);
  assert.doesNotMatch(refreshBody.slice(0, transactionEnd), /INSERT INTO "OperationsAuditLog"/);
  assert.match(refreshBody.slice(transactionEnd), /recordOperationsAuditBestEffort/);
  assert.match(refreshBody, /commandChange:/);
  assert.match(refreshBody, /requestChange:/);
});

test("성공 skip은 외부 재호출 없이 집계 상태를 자가 복구한다", () => {
  // 2026-10-06 시트 은퇴: 성공(SUCCEEDED)뿐 아니라 건너뜀(SKIPPED)도 시트를 다시 부르지 않고 집계만 복구한다.
  assert.match(action, /if \(isSheetTargetDone\(row\.attemptStatus\)\) \{\s*await refreshOperationsStatuses\(commandId\)/);
  assert.match(action, /if \(!changed\) \{\s*await refreshOperationsStatuses\(commandId\)/);
  assert.match(action, /claim\.skipped \|\| !claim\.token\) \{\s*await refreshOperationsStatuses\(commandId\)/);
});

test("Website 커밋 직후 중단된 재호출은 성공 attempt 집계만 복구한다", () => {
  const websiteStart = action.indexOf("export async function applyOperationsWebsite");
  const websiteEnd = action.indexOf("async function markWebsiteConflict");
  const websiteBody = action.slice(websiteStart, websiteEnd);
  assert.match(websiteBody, /a\.status='SUCCEEDED' AND c\.status <> 'HELD'/);
  assert.match(websiteBody, /for \(const command of succeeded\) await refreshOperationsStatuses\(command\.id\)/);
  assert.match(websiteBody, /return \{ ok: true as const, applied: 0, skipped: true as const \}/);
  const recoveryStart = websiteBody.indexOf("const succeeded =");
  const recoveryEnd = websiteBody.indexOf("throw new Error", recoveryStart);
  assert.doesNotMatch(websiteBody.slice(recoveryStart, recoveryEnd), /UPDATE "Enrollment"/);
});

test("운영 원장의 모든 FK와 삭제 동작을 Prisma 관계에도 반영한다", () => {
  const noAction = "onDelete: NoAction, onUpdate: NoAction";
  assert.match(schema, new RegExp(`requestedBy\\s+User\\s+@relation\\("OperationsRequestRequester", fields: \\[requestedByUserId\\], references: \\[id\\], ${noAction}\\)`));
  assert.match(schema, new RegExp(`approvedBy\\s+User\\?\\s+@relation\\("OperationsRequestApprover", fields: \\[approvedByUserId\\], references: \\[id\\], ${noAction}\\)`));
  assert.match(schema, /parentRequestLink\s+ParentOperationsRequestLink\?\s+@relation\(fields: \[parentRequestLinkId\], references: \[id\], onDelete: SetNull, onUpdate: NoAction\)/);
  assert.match(schema, /request\s+OperationsRequest\s+@relation\(fields: \[requestId\], references: \[id\], onDelete: Cascade, onUpdate: NoAction\)/);
  assert.match(schema, new RegExp(`student\\s+Student\\?\\s+@relation\\(fields: \\[studentId\\], references: \\[id\\], ${noAction}\\)`));
  assert.match(schema, /command\s+OperationsCommand\s+@relation\(fields: \[commandId\], references: \[id\], onDelete: Cascade, onUpdate: NoAction\)/);
  assert.match(schema, /student\s+Student\s+@relation\(fields: \[studentId\], references: \[id\], onDelete: Cascade, onUpdate: NoAction\)/);
  assert.match(schema, new RegExp(`createdBy\\s+User\\s+@relation\\("ParentOperationsLinkCreator", fields: \\[createdByUserId\\], references: \\[id\\], ${noAction}\\)`));
  assert.match(schema, /request\s+OperationsRequest\?\s+@relation\(fields: \[requestId\], references: \[id\], onDelete: Cascade, onUpdate: NoAction\)/);
  assert.match(schema, /link\s+ParentOperationsRequestLink\?\s+@relation\(fields: \[linkId\], references: \[id\], onDelete: SetNull, onUpdate: NoAction\)/);
  assert.match(schema, new RegExp(`actor\\s+User\\?\\s+@relation\\("OperationsAuditActor", fields: \\[actorUserId\\], references: \\[id\\], ${noAction}\\)`));
});
