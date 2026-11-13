// 신청함 «선택 N건 랠리즈 반영 확인» 일괄 처리 (2026-11-13)
// 1) 서버는 건마다 단건과 같은 recordOperationsExternalCheck 를 부른다(검증·감사 기록 한 벌).
// 2) 권한은 단건과 같이 관리자만, 한 번에 100건까지.
// 3) 화면은 «외부 반영 확인 필요»(SYNC_CHECK) 반만 고르고, 확인 창에 대상 이름을 보인다.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const actions = await readFile("src/app/actions/enrollment-changes.ts", "utf8");
const client = await readFile("src/app/admin/inbox/InboxClient.tsx", "utf8");

const bulkStart = actions.indexOf("export async function confirmEnrollmentChangesRallyzBulk");
const bulk = actions.slice(bulkStart, actions.indexOf("\n}\n", bulkStart));

test("일괄 확인은 관리자 권한을 먼저 보고, 건수 상한을 둔다", () => {
  assert.ok(bulkStart > 0);
  assert.ok(bulk.indexOf("await requireAdmin()") >= 0);
  assert.ok(bulk.indexOf("await requireAdmin()") < bulk.indexOf("getEnrollmentChangeRequests"));
  assert.match(bulk, /requestIds\.length > 100/);
});

test("건마다 단건과 같은 서버 함수로 확인하고, 실패는 이름·사유로 모은다", () => {
  assert.match(bulk, /recordOperationsExternalCheck\(row\.syncCommandId, "RALLYZ", true\)/);
  assert.match(bulk, /for \(const id of ids\)/);
  assert.match(bulk, /result\.failed\.push\(\{ requestId: id, name, reason: userFacingError\(error,/);
  // 이미 확인·보류·시트 미완료는 부르기 전에 건너뛴다(단건 버튼이 꺼지는 조건과 같다)
  assert.match(bulk, /row\.rallyzStatus === "SUCCEEDED"/);
  assert.match(bulk, /row\.syncCommandStatus === "HELD"/);
  assert.match(bulk, /!isSheetTargetDone\(row\.sheetStatus\)/);
});

test("화면은 SYNC_CHECK 반만 고르고 확인 창에 대상 이름 목록을 보인다", () => {
  assert.match(client, /member\.rawStatus === "SYNC_CHECK"/);
  assert.match(client, /confirmEnrollmentChangesRallyzBulk\(requestIds\)/);
  assert.match(client, /선택 \$\{targets\.length\}건 랠리즈 반영 확인/);
  assert.match(client, /targets\.map\(\(row\) => \(\s*<li key=\{keyOf\(row\)\}>/);
  // 기존 결석·문의 일괄 처리는 그 종류만 처리한다(수강 변경 줄을 섞어 부르지 않는다)
  assert.match(client, /for \(const row of selectedOther\)/);
});
