// 「수강 변경 신청」 확인 필요 화면의 시트·랠리즈 버튼 안전장치 (2026-10-06)
// 1) 오류 이유가 운영 빌드에서 가려지지 않게: 결과 객체 래퍼만 부른다.
// 2) 시트 자동 반영이 끝내 안 되는 건의 탈출구: 「시트 직접 수정 완료」 수동 확인.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const wrapper = await readFile("src/app/actions/enrollment-changes.ts", "utf8");
const client = await readFile("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx", "utf8");
const ops = await readFile("src/app/actions/operations-sync.ts", "utf8");

const manualStart = ops.indexOf("export async function recordOperationsSheetManualCheck");
const manualBody = ops.slice(manualStart, ops.indexOf("async function refreshOperationsStatuses"));

test("래퍼는 throw 대신 { ok } / { ok:false, message } 를 돌려준다", () => {
  assert.match(wrapper, /export type EnrollmentSyncActionResult = \{ ok: true \} \| \{ ok: false; message: string \}/);
  for (const name of ["applyEnrollmentChangeSheet", "confirmEnrollmentChangeRallyz", "confirmEnrollmentChangeSheetManually"]) {
    assert.match(wrapper, new RegExp(`export async function ${name}\\(commandId: string\\)`));
  }
  const runner = wrapper.slice(wrapper.indexOf("async function runEnrollmentSyncAction"), wrapper.indexOf("export async function applyEnrollmentChangeSheet"));
  // 권한 검사는 try 밖(로그인 이동 등은 그대로 전파), 실패는 결과 객체로
  assert.ok(runner.indexOf("await requireAdmin()") < runner.indexOf("try {"));
  assert.match(runner, /return \{ ok: true \}/);
  assert.match(runner, /return \{ ok: false, message \}/);
  // 알려진 업무 안내만 보존하고, 한국어가 섞인 내부 오류도 공통 안전 안내로 바꾼다.
  assert.match(runner, /userFacingError\(error,/);
  assert.doesNotMatch(runner, /\/\[가-힣\]\/\.test\(raw\)/);
  assert.match(wrapper, /recordOperationsSheetManualCheck\(commandId\)/);
});

test("클라이언트는 래퍼만 부르고 실패 이유를 그대로 보여준다", () => {
  assert.doesNotMatch(client, /applyOperationsSheet|recordOperationsExternalCheck|recordOperationsSheetManualCheck/);
  assert.match(client, /confirmEnrollmentChangeSheetManually\(row\.syncCommandId!\)/);
  assert.match(client, /if \(!result\.ok\) setError\(result\.message\)/);
});

test("「시트 직접 수정 완료」 버튼은 확인창을 거치고, 보류 사유는 계속 보인다", () => {
  const fn = client.slice(client.indexOf("function confirmSheetManually"), client.indexOf("function confirmRallyz"));
  assert.match(fn, /window\.confirm\(`[^`]*구글 시트를 직접 고쳤습니까\?/);
  assert.match(client, />\s*시트 직접 수정 완료\s*</);
  assert.match(client, /시트 자동 반영 보류: \{sheetHoldDisplayReason\(row\.kind, row\.syncHoldReason\)\}/);
  // 보류(HELD)여도 버튼 블록 자체는 그려진다(예전엔 보류면 버튼이 사라져 영구 정체)
  assert.doesNotMatch(client, /row\.syncCommandStatus === "HELD" \? \(/);
});

test("SHEET 수동 확인: 사이트 반영 끝난 건만, SUCCEEDED+verifiedAt, 감사기록(누가·수동)", () => {
  assert.notEqual(manualStart, -1);
  assert.match(manualBody, /await requireAdmin\(\)/);
  assert.match(manualBody, /website\?\.status !== "SUCCEEDED"/);
  assert.match(manualBody, /SET status='SUCCEEDED', "verifiedAt"=COALESCE\("verifiedAt", now\(\)\)/);
  assert.match(manualBody, /WHERE "commandId"=\$1 AND target='SHEET'/);
  assert.match(manualBody, /'SYNC_TARGET_MANUALLY_CONFIRMED','ADMIN',\$3/);
  assert.match(manualBody, /admin\.appUserId/);
  assert.match(manualBody, /manual: true/);
  assert.match(manualBody, /previousHoldReason/);
  // 진행 중인 자동 반영과 겹치지 않게
  assert.match(manualBody, /if \(sheet\.processing\) throw/);
  // 적용일 전에는 막는다
  assert.match(manualBody, /command\.effectiveDate > kstTodayYmd\(\)/);
});

test("시트 보류(HELD)는 수동 확인 때 풀려 랠리즈 확인 → SYNCED 로 이어진다", () => {
  assert.match(manualBody, /if \(command\.status === "HELD"\) \{\s*await tx\.\$executeRawUnsafe\(\s*`UPDATE "OperationsCommand" SET status='PENDING', "holdReason"=NULL/);
  // 해제 전에 판정 함수를 통과해야 한다(판정 → 시트 갱신 → 보류 해제 순서)
  const decideAt = manualBody.indexOf("sheetHoldReleaseDecision(");
  assert.ok(decideAt > 0 && decideAt < manualBody.indexOf(`UPDATE "OperationsSyncAttempt"`));
  assert.match(manualBody, /if \(!decision\.ok\) throw new Error\(decision\.reason\)/);
  assert.match(manualBody, /"afterJson"->>'enrollmentChangeRequestId' AS "enrollmentChangeRequestId"/);
  assert.match(manualBody, /await refreshOperationsStatuses\(commandId\)/);
  // 랠리즈 확인은 여전히 시트 SUCCEEDED 와 HELD 아님을 요구한다(순서 보존)
  const rallyz = ops.slice(ops.indexOf("export async function recordOperationsExternalCheck"), ops.indexOf("export async function applyOperationsSheet"));
  assert.match(rallyz, /target: "RALLYZ"/);
  // 2026-10-06 시트 은퇴: 시트 선행 조건은 SUCCEEDED 또는 SKIPPED(isSheetTargetDone). 순서 강제 자체는 유지된다.
  assert.match(rallyz, /!isSheetTargetDone\(sheet\[0\]\.status\)/);
  assert.match(rallyz, /commandStatus === "HELD"/);
});

// ── 보류 해제 판정(순수 함수)을 실제로 실행해 본다 ──
const rulesSource = await readFile("src/lib/enrollment/sheetManualCheckRules.ts", "utf8");
const rules = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(rulesSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`);
const policy = await readFile("src/lib/operations-events/policy.ts", "utf8");
const base = { kind: "PAUSE", studentId: "s1", enrollmentChangeRequestId: "r1", holdReason: null, sheetStatus: "PENDING", sheetError: null };

test("판정: 시트 충돌 보류(시트 FAILED + 같은 오류)만 풀린다", () => {
  const conflict = "선택한 수업 행에 다른 요일 수업도 있어 공통 상태를 자동 변경할 수 없습니다.";
  assert.deepEqual(rules.sheetHoldReleaseDecision({ ...base, holdReason: conflict, sheetStatus: "FAILED", sheetError: conflict }), { ok: true });
  // 시트가 실패가 아니거나 오류가 다르면 시트 쪽 보류로 보지 않는다
  assert.equal(rules.sheetHoldReleaseDecision({ ...base, holdReason: conflict, sheetStatus: "PENDING", sheetError: null }).ok, false);
  assert.equal(rules.sheetHoldReleaseDecision({ ...base, holdReason: conflict, sheetStatus: "FAILED", sheetError: "다른 오류" }).ok, false);
});

test("판정: 복귀 어댑터 미지원 보류는 풀리고, 정책 사유가 섞이면 안 풀린다", () => {
  const resume = { ...base, kind: "RESUME", holdReason: rules.RESUME_ADAPTER_HOLD_REASON };
  assert.deepEqual(rules.sheetHoldReleaseDecision(resume), { ok: true });
  assert.equal(rules.sheetHoldReleaseDecision({ ...resume, holdReason: `정확한 적용일이 없습니다. ${rules.RESUME_ADAPTER_HOLD_REASON}` }).ok, false);
  assert.equal(rules.sheetHoldReleaseDecision({ ...resume, kind: "PAUSE" }).ok, false);
  // 정책 문구와 한 글자도 다르면 판정이 영영 실패하므로 원문 일치를 고정한다
  assert.ok(policy.includes("${event.change.kind} 변경은 시트·랠리즈 전용 동기화 어댑터가 아직 없어 확인보류합니다."));
  assert.equal(rules.RESUME_ADAPTER_HOLD_REASON, "RESUME 변경은 시트·랠리즈 전용 동기화 어댑터가 아직 없어 확인보류합니다.");
});

test("판정: 외부 이벤트 정책 보류·미연결·학생 미확정은 한국어 사유로 거부", () => {
  const policyHold = rules.sheetHoldReleaseDecision({ ...base, holdReason: "안정적인 학생 식별값이 없습니다.", sheetStatus: "FAILED", sheetError: "x" });
  assert.equal(policyHold.ok, false);
  assert.match(policyHold.reason, /시트와 무관한 이유로 보류/);
  assert.match(rules.sheetHoldReleaseDecision({ ...base, studentId: null }).reason, /학생이 확정되지 않은/);
  assert.match(rules.sheetHoldReleaseDecision({ ...base, enrollmentChangeRequestId: null }).reason, /수강 변경 신청과 연결되지 않은/);
});

test("화면: 복귀는 「시트에 반영」을 숨기고 보류 문구를 한국어로 보여준다", () => {
  assert.equal(rules.sheetHoldDisplayReason("RESUME", rules.RESUME_ADAPTER_HOLD_REASON), "복귀는 시트 자동 반영을 지원하지 않습니다");
  assert.equal(rules.sheetHoldDisplayReason("PAUSE", "시트 행 없음"), "시트 행 없음");
  assert.equal(rules.sheetHoldDisplayReason("PAUSE", null), "관리자 확인 필요");
  assert.match(client, /sheetHoldDisplayReason\(row\.kind, row\.syncHoldReason\)/);
  // 2026-10-06 시트 은퇴: 시트 칸이 SKIPPED 인 건도 「시트에 반영」을 숨긴다.
  assert.match(client, /\{row\.kind !== "RESUME" && !sheetSkipped && \(\s*<button[\s\S]*?onClick=\{\(\) => applySheet\(row\)\}/);
});
