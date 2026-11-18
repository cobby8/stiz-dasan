import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync("src/app/actions/operations-sync.ts", "utf8");
const infrastructure = readFileSync("src/lib/operationsSyncInfrastructure.ts", "utf8");
const migration = readFileSync("prisma/migrations/20260827223000_add_operations_sync_processing_lease/migration.sql", "utf8");
const schema = readFileSync("prisma/schema.prisma", "utf8");

// 2026-11-18 결정표(rallyz-switch·sheet-switch «완전히 지운다»): 시트 자동 반영(임대 토큰 claim/finish)·랠리즈 확인을 지웠다.
// 남는 것은 «보류 해제»와 상태 집계(refreshOperationsStatuses)뿐이다.
test("시트 자동 반영·랠리즈 확인과 그 임대 토큰 함수는 지워졌다", () => {
  for (const name of ["claimSyncAttempt", "finishSyncAttempt", "applyOperationsSheet", "recordOperationsExternalCheck", "applySheetEnrollmentStatus", "googleSheetsOperations"]) {
    assert.ok(!action.includes(name), `${name} 는 지워져 있어야 합니다`);
  }
  // 바깥 장부 칸에 다시 쓰는 SQL 이 없다(보류 해제는 명령 행만 바꾼다)
  assert.doesNotMatch(action, /UPDATE "OperationsSyncAttempt"/);
  assert.doesNotMatch(action, /"processingToken"=\$3/);
});

test("상태 변경을 감사로그에 남긴다", () => {
  for (const event of ["COMMAND_HOLD_RELEASED", "COMMAND_STATUS_CHANGED", "REQUEST_STATUS_CHANGED"]) {
    assert.match(action, new RegExp(event));
  }
});

// 2026-11-18 옛 코드 정리 C: 부르는 곳이 없던 승인(approveOperationsRequest)·홈페이지 반영(applyOperationsWebsite)을 지웠다
test("부르는 곳 없던 운영 요청 승인·홈페이지 반영 액션은 없어졌다", () => {
  assert.doesNotMatch(action, /export async function (approveOperationsRequest|applyOperationsWebsite)\b/);
  assert.doesNotMatch(action, /async function markWebsiteConflict\b/);
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

test("감사로그 장애는 best-effort 로 관측만 한다", () => {
  const auditStart = action.indexOf("async function recordOperationsAuditBestEffort");
  assert.ok(auditStart > 0);
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

test("보류 해제는 끝난 뒤 집계 상태를 다시 맞춘다", () => {
  const manual = action.slice(action.indexOf("export async function recordOperationsSheetManualCheck"), action.indexOf("async function refreshOperationsStatuses"));
  assert.match(manual, /await refreshOperationsStatuses\(commandId\)/);
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
