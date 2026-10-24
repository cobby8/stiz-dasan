import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { operationsRequestKey } from "../src/lib/operationsSync.ts";
import { createHash } from "node:crypto";

const action = readFileSync("src/app/actions/operations-sync.ts", "utf8");
const adminShell = readFileSync("src/app/admin/AdminShellClient.tsx", "utf8");
const retiredPage = readFileSync("src/app/admin/operations-sync/page.tsx", "utf8");

test("구조화된 대상·적용일이 다르면 멱등 키도 다르다", () => {
  const base = { sourceText: "수업 변경", studentName: "김민서", kind: "CLASS_CHANGE", effectiveMonth: "2026-09", scope: "PARENT_LINK:l1" };
  const first = operationsRequestKey({ ...base, effectiveDate: "2026-09-03", fromClassId: "a", toClassId: "b" });
  assert.notEqual(first, operationsRequestKey({ ...base, effectiveDate: "2026-09-10", fromClassId: "a", toClassId: "b" }));
  assert.notEqual(first, operationsRequestKey({ ...base, effectiveDate: "2026-09-03", fromClassId: "a", toClassId: "c" }));
});

test("구조화 필드가 없는 기존 관리자 명령의 멱등 키는 유지한다", () => {
  const input = { sourceText: "김민서 휴원", studentName: "김민서", kind: "PAUSE", effectiveMonth: "2026-09" };
  const legacy = createHash("sha256").update("ADMIN|김민서 휴원|김민서|PAUSE|2026-09").digest("hex");
  assert.equal(operationsRequestKey(input), legacy);
});

test("승인은 확정한 반 하나만 조회하고 기존 구조화 계획을 보존한다", () => {
  assert.match(action, /e\."studentId"=\$1 AND e\."classId"=\$2/);
  assert.match(action, /if \(enrollments\.length !== 1\)/);
  assert.match(action, /JSON\.stringify\(\{ \.\.\.plan, enrollments \}\)/);
  assert.match(action, /JSON\.stringify\(\{ \.\.\.plan, enrollments: enrollments\.map/);
});

test("Sheet·Rallyz·Website 모두 KST 적용일 이전 실행을 막는다", () => {
  assert.match(action, /적용일\(\$\{row\.effectiveDate\}\) 이전에는 시트에 반영할 수 없습니다/);
  assert.match(action, /적용일\(\$\{sheet\[0\]\.effectiveDate\}\) 이전에는 랠리즈 반영을 확인할 수 없습니다/);
  assert.match(action, /적용일\(\$\{notDue\[0\]\.effectiveDate/);
});

test("구조화 필드가 없는 기존 명령은 추론하지 않고 보류한다", () => {
  assert.match(action, /!plan\?\.parentConfirmed \|\| !effectiveDate/);
  assert.match(action, /확정된 적용일 또는 필수 대상 수업이 없는 기존 요청/);
});

test("잘못된 parentConfirmed 문자열도 boolean cast 예외 없이 false로 처리한다", () => {
  assert.doesNotMatch(action, /parentConfirmed'\)::boolean/);
  assert.match(action, /parentConfirmed' = 'true'/);
});

test("관리자 직접 자연어 입력은 생성 전에 명확히 중단한다", () => {
  const createBody = action.slice(action.indexOf("function createOperationsRequest"), action.indexOf("function getOperationsRequests"));
  assert.match(createBody, /관리자 직접 입력은 안전한 적용일·대상 수업을 확정할 수 없어 중단되었습니다/);
  assert.doesNotMatch(createBody, /INSERT INTO "OperationsRequest"/);
});

test("폐기된 관리자 화면은 메뉴에서 제거하고 기존 URL은 관리자 홈으로 보낸다", () => {
  assert.doesNotMatch(adminShell, /href="\/admin\/operations-sync"/);
  assert.doesNotMatch(adminShell, /3중 동기화/);
  assert.match(retiredPage, /redirect\("\/admin"\)/);
  assert.doesNotMatch(retiredPage, /OperationsSyncClient/);
});

test("화면 폐기 후에도 백엔드는 적용일 전 실행을 차단한다", () => {
  assert.match(action, /canExecute: Boolean\(command\.effectiveDate && command\.effectiveDate <= serverToday\)/);
});

test("시트 공통 상태 충돌은 명령을 명확히 HELD로 전환한다", () => {
  assert.match(action, /rawMessage\.startsWith\("SHEET_SHARED_STATUS_CONFLICT:"\)/);
  assert.match(action, /UPDATE "OperationsCommand" SET status='HELD'/);
});
