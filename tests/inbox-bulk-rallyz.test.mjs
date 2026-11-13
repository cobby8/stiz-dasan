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

// 2026-11-14 랠리즈 은퇴: 기본(은퇴) 화면은 랠리즈 일괄 확인 버튼·고르기 칸을 그리지 않는다.
// 위 옛 화면 코드는 스위치 "0"(rallyzRetired false)일 때만 쓰인다.
test("랠리즈 은퇴(기본)면 랠리즈 확인 줄은 일괄 처리 대상이 아니고, 서버가 스위치 값을 내려 준다", async () => {
  assert.match(client, /rallyzRetired = true \}: Props\)/, "기본값 = 은퇴");
  assert.match(client, /function isBulkable\(row: InboxRow, rallyzRetired: boolean\): boolean \{\s*if \(!rallyzRetired && rallyzCheckIds\(row\)\.length > 0\) return true;/);
  assert.match(client, /const rallyzIds = \(row: InboxRow\) => \(rallyzRetired \? \[\] : rallyzCheckIds\(row\)\);/);
  // 버튼·«랠리즈 확인 필요 N건» 문구는 rallyzIds(은퇴면 빈 배열) 결과에만 달려 있다
  assert.match(client, /const selectedRallyz = selectedRows\.filter\(\(row\) => rallyzIds\(row\)\.length > 0\);/);
  assert.match(client, /const bulkRallyzCount = bulkRows\.filter\(\(row\) => rallyzIds\(row\)\.length > 0\)\.length;/);
  assert.doesNotMatch(client, /process\.env/, "화면 번들에서 환경변수를 읽지 않는다");
  // 상세(수강 변경 화면)에도 같은 값을 넘긴다
  assert.match(client, /<EnrollmentChangeInboxDetail [^\n]*rallyzRetired=\{rallyzRetired\} \/>/);
  const page = await readFile("src/app/admin/inbox/page.tsx", "utf8");
  assert.match(page, /rallyzRetired=\{isRallyzSyncRetired\(process\.env\)\}/);
  const changesPage = await readFile("src/app/admin/enrollment-changes/page.tsx", "utf8");
  assert.match(changesPage, /const rallyzRetired = isRallyzSyncRetired\(process\.env\);/);
  assert.match(changesPage, /rallyzRetired=\{rallyzRetired\}/);
  const changesClient = await readFile("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx", "utf8");
  assert.match(changesClient, /rallyzRetired = true,/, "기본값 = 은퇴");
  assert.match(changesClient, /\{!rallyzRetired && \(\s*<button[\s\S]*?onClick=\{\(\) => confirmRallyz\(row\)\}/, "«랠리즈 반영 확인» 버튼은 옛 방식에서만");
});
