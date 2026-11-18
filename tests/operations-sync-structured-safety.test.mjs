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

// 2026-11-18 옛 코드 정리 C: 부르는 곳이 없던 운영 요청 생성·목록·승인·홈페이지 반영 액션을 지웠다
test("부르는 곳 없던 운영 요청 생성·목록·승인·홈페이지 반영 액션은 없어졌다", () => {
  assert.doesNotMatch(action, /export async function (createOperationsRequest|getOperationsRequests|approveOperationsRequest|applyOperationsWebsite)\b/);
});

test("Sheet·Rallyz 는 KST 적용일 이전 실행을 막는다", () => {
  assert.match(action, /적용일\(\$\{row\.effectiveDate\}\) 이전에는 시트에 반영할 수 없습니다/);
  assert.match(action, /적용일\(\$\{sheet\[0\]\.effectiveDate\}\) 이전에는 랠리즈 반영을 확인할 수 없습니다/);
});

test("잘못된 parentConfirmed 문자열도 boolean cast 예외 없이 false로 처리한다", () => {
  assert.doesNotMatch(action, /parentConfirmed'\)::boolean/);
  assert.match(action, /parentConfirmed' = 'true'/);
});

test("폐기된 관리자 화면은 메뉴에서 제거하고 기존 URL은 관리자 홈으로 보낸다", () => {
  assert.doesNotMatch(adminShell, /href="\/admin\/operations-sync"/);
  assert.doesNotMatch(adminShell, /3중 동기화/);
  assert.match(retiredPage, /redirect\("\/admin"\)/);
  assert.doesNotMatch(retiredPage, /OperationsSyncClient/);
});

test("시트 공통 상태 충돌은 명령을 명확히 HELD로 전환한다", () => {
  assert.match(action, /rawMessage\.startsWith\("SHEET_SHARED_STATUS_CONFLICT:"\)/);
  assert.match(action, /UPDATE "OperationsCommand" SET status='HELD'/);
});
