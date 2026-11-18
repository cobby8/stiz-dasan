// 「수강 변경 신청」 확인 필요 화면의 «보류 해제» 안전장치 (2026-10-06 → 2026-11-18 정리)
// 1) 오류 이유가 운영 빌드에서 가려지지 않게: 결과 객체 래퍼만 부른다.
// 2) 2026-11-18 결정표(rallyz-switch·sheet-switch «완전히 지운다»): 시트 반영·랠리즈 확인·«시트 직접 수정 완료»는 지웠다.
//    남은 것은 시트 칸이 건너뜀(SKIPPED)인 복귀 보류를 푸는 «보류 해제» 하나다.
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
  assert.match(wrapper, /export async function releaseEnrollmentChangeHoldSheetRetired\(commandId: string\)/);
  // 지운 래퍼는 돌아오지 않는다
  for (const name of ["applyEnrollmentChangeSheet", "confirmEnrollmentChangeRallyz", "confirmEnrollmentChangeSheetManually", "confirmEnrollmentChangesRallyzBulk"]) {
    assert.ok(!wrapper.includes(name), `${name} 는 지워져 있어야 합니다`);
  }
  const runner = wrapper.slice(wrapper.indexOf("async function runEnrollmentSyncAction"), wrapper.indexOf("export async function releaseEnrollmentChangeHoldSheetRetired"));
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
  assert.match(client, /releaseEnrollmentChangeHoldSheetRetired\(row\.syncCommandId!\)/);
  assert.match(client, /if \(!result\.ok\) setError\(result\.message\)/);
});

test("«보류 해제» 버튼은 확인창을 거치고, 보류 사유는 계속 보인다", () => {
  const fn = client.slice(client.indexOf("function releaseRetiredResumeHold"), client.indexOf("function runSyncAction"));
  assert.match(fn, /askConfirm\(`[^`]*보류를 풀까요\?/);
  assert.match(client, />\s*보류 해제\s*</);
  assert.match(client, /자동 반영 보류: \{sheetHoldDisplayReason\(row\.kind, row\.syncHoldReason\)\}/);
  // 지운 버튼은 화면에 없다
  assert.doesNotMatch(client, /시트 직접 수정 완료|시트에 반영|랠리즈 반영 확인/);
  // 보류(HELD)여도 버튼 블록 자체는 그려진다(예전엔 보류면 버튼이 사라져 영구 정체)
  assert.doesNotMatch(client, /row\.syncCommandStatus === "HELD" \? \(/);
});

test("보류 해제: 사이트 반영 끝난 건 + 시트 칸 SKIPPED 만, 시트 칸은 건드리지 않고 감사기록(누가·수동)", () => {
  assert.notEqual(manualStart, -1);
  assert.match(manualBody, /await requireAdmin\(\)/);
  assert.match(manualBody, /website\?\.status !== "SUCCEEDED"/);
  // 시트 칸이 건너뜀이 아닌 옛 기록은 거부(운영 0건)
  assert.match(manualBody, /if \(sheet\.status !== "SKIPPED"\) throw/);
  // 시트 칸을 SUCCEEDED 로 바꾸던 옛 갈래는 지웠다
  assert.doesNotMatch(manualBody, /UPDATE "OperationsSyncAttempt"/);
  assert.doesNotMatch(manualBody, /SYNC_TARGET_MANUALLY_CONFIRMED/);
  assert.match(manualBody, /'COMMAND_HOLD_RELEASED','ADMIN',\$3/);
  assert.match(manualBody, /admin\.appUserId/);
  assert.match(manualBody, /manual: true/);
  assert.match(manualBody, /previousHoldReason/);
  // 적용일 전에는 막는다
  assert.match(manualBody, /command\.effectiveDate > kstTodayYmd\(\)/);
});

test("보류(HELD)는 판정 함수를 통과해야만 풀리고, 재집계로 이어진다", () => {
  const decideAt = manualBody.indexOf("sheetHoldReleaseDecision(");
  const releaseAt = manualBody.indexOf(`UPDATE "OperationsCommand" SET status='PENDING', "holdReason"=NULL`);
  assert.ok(decideAt > 0 && decideAt < releaseAt, "판정 → 보류 해제 순서");
  assert.match(manualBody, /if \(!decision\.ok\) throw new Error\(decision\.reason\)/);
  assert.match(manualBody, /WHERE id=\$1 AND status='HELD'/);
  assert.match(manualBody, /"afterJson"->>'enrollmentChangeRequestId' AS "enrollmentChangeRequestId"/);
  assert.match(manualBody, /await refreshOperationsStatuses\(commandId\)/);
  // 랠리즈 확인·시트 자동 반영 서버 함수는 지워졌다
  for (const name of ["recordOperationsExternalCheck", "applyOperationsSheet", "claimSyncAttempt", "finishSyncAttempt", "applySheetEnrollmentStatus"]) {
    assert.ok(!ops.includes(name), `${name} 는 지워져 있어야 합니다`);
  }
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

test("화면: 보류 문구를 한국어로 보여주고, 복귀 보류만 «보류 해제»를 띄운다", () => {
  assert.equal(rules.sheetHoldDisplayReason("RESUME", rules.RESUME_ADAPTER_HOLD_REASON), "복귀는 시트 자동 반영을 지원하지 않습니다");
  assert.equal(rules.sheetHoldDisplayReason("PAUSE", "시트 행 없음"), "시트 행 없음");
  assert.equal(rules.sheetHoldDisplayReason("PAUSE", null), "관리자 확인 필요");
  assert.match(client, /sheetHoldDisplayReason\(row\.kind, row\.syncHoldReason\)/);
  assert.match(client, /const retiredResumeHold = sheetSkipped && row\.syncCommandStatus === "HELD"\s*&& row\.kind === "RESUME" && row\.syncHoldReason\?\.trim\(\) === RESUME_ADAPTER_HOLD_REASON;/);
  assert.match(client, /\{retiredResumeHold && \(\s*<button[\s\S]*?onClick=\{\(\) => releaseRetiredResumeHold\(row\)\}/);
});
