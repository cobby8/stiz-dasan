import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 원장 결정(2026-10-05, 선택지 A): 승인된 휴원·퇴원은 적용일에 크론이 사이트 수강 상태를 바꾼다.
// 시트·랠리즈는 "확인 필요"로 남기고, 반 변경은 사람 확인(HELD)을 유지한다.
// 판정은 순수 함수(due-change-plan.ts)라 여기서 실제로 실행해 확인한다.

const planSource = await readFile("src/lib/enrollment/due-change-plan.ts", "utf8");
const transpiled = ts.transpileModule(planSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { planDueEnrollmentChange, DEFAULT_HOLD_REASON } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

const adminLib = await readFile("src/lib/enrollment/admin-change-request.ts", "utf8");
const finalize = await readFile("src/lib/enrollment/finalize-change-sync.ts", "utf8");

const base = { studentId: "s1", fromClassId: "c1", parentConfirmed: true };
const enrollment = (status) => ({ studentId: "s1", classId: "c1", status });

test("휴원: 다니는 중이면 PAUSED 로 적용한다(기대 상태 ACTIVE)", () => {
  assert.deepEqual(
    planDueEnrollmentChange({ ...base, kind: "PAUSE", enrollment: enrollment("ACTIVE") }),
    { action: "APPLY", expectedStatus: "ACTIVE", nextStatus: "PAUSED" },
  );
});

test("퇴원: 다니는 중이거나 휴원 중이면 WITHDRAWN 으로 적용한다", () => {
  for (const status of ["ACTIVE", "PAUSED"]) {
    assert.deepEqual(
      planDueEnrollmentChange({ ...base, kind: "WITHDRAW", enrollment: enrollment(status) }),
      { action: "APPLY", expectedStatus: status, nextStatus: "WITHDRAWN" },
    );
  }
});

test("이미 목표 상태면 두 번 적용하지 않고 보류한다", () => {
  const pause = planDueEnrollmentChange({ ...base, kind: "PAUSE", enrollment: enrollment("PAUSED") });
  assert.equal(pause.action, "HOLD");
  assert.match(pause.reason, /이미 휴원 상태/);
  const withdraw = planDueEnrollmentChange({ ...base, kind: "WITHDRAW", enrollment: enrollment("WITHDRAWN") });
  assert.equal(withdraw.action, "HOLD");
  assert.match(withdraw.reason, /이미 퇴원 상태/);
});

test("예상 밖 상태면 보류한다(휴원 중인 학생의 휴원 신청 외)", () => {
  const odd = planDueEnrollmentChange({ ...base, kind: "PAUSE", enrollment: enrollment("WITHDRAWN") });
  assert.equal(odd.action, "HOLD");
  assert.match(odd.reason, /예상 밖 수강 상태\(WITHDRAWN\)/);
});

test("반 변경은 조건이 다 맞아도 자동 적용하지 않는다", () => {
  const ok = planDueEnrollmentChange({ ...base, kind: "CLASS_CHANGE", enrollment: enrollment("ACTIVE") });
  assert.deepEqual(ok, { action: "HOLD", reason: DEFAULT_HOLD_REASON });
  const full = planDueEnrollmentChange({
    ...base, kind: "CLASS_CHANGE", enrollment: enrollment("ACTIVE"), classChangeProblem: "희망 반 정원 초과: 관리자 재확인 필요",
  });
  assert.equal(full.action, "HOLD");
  assert.match(full.reason, /정원 초과/);
});

test("보호자 연결이 끊겼거나 수강이 신청과 다르면 보류한다", () => {
  assert.match(
    planDueEnrollmentChange({ ...base, parentConfirmed: false, kind: "PAUSE", enrollment: enrollment("ACTIVE") }).reason,
    /보호자/,
  );
  for (const snapshot of [null, { studentId: "other", classId: "c1", status: "ACTIVE" }, { studentId: "s1", classId: "c2", status: "ACTIVE" }]) {
    const plan = planDueEnrollmentChange({ ...base, kind: "WITHDRAW", enrollment: snapshot });
    assert.equal(plan.action, "HOLD");
    assert.match(plan.reason, /현재 수강 상태가 변경됨/);
  }
});

test("모르는 종류는 보류한다", () => {
  assert.equal(planDueEnrollmentChange({ ...base, kind: "RESUME", enrollment: enrollment("PAUSED") }).action, "HOLD");
});

test("적용 경로는 판정 함수 결과로만 사이트를 바꾸고 원장 키를 유지한다", () => {
  assert.match(adminLib, /planDueEnrollmentChange\(/);
  assert.match(adminLib, /if \(plan\.action === "APPLY" && enrollment\)/);
  // idempotencyKey 는 예전과 같은 `enrollment-change:<id>` — 크론 조회의 NOT EXISTS 와 유일 제약이 같은 키를 본다
  assert.match(adminLib, /`enrollment-change:\$\{row\.id\}`/);
  assert.match(adminLib, /'enrollment-change:' \|\| r\.id/);
  // 반환값 = 실제 적용 건수
  assert.match(adminLib, /return \(await applyDueEnrollmentChangesWithSummary\(\)\)\.applied;/);
  // 승인 직후 호출도 같은 함수(같은 잠금)를 탄다 → 크론과 겹쳐도 한 번만 적용
  assert.match(adminLib, /input\.approve \? await applyDueEnrollmentChangesWithSummary\(\)/);
});

// ── 검수 보완(2026-10-05): 자동 적용 뒤 "시트·랠리즈 확인 필요"가 화면에 보여야 한다 ─────────
// 사이트만 바뀐 채 "반영 완료"로 보이면 퇴원생에게 랠리즈 청구가 계속 나간다(2026-10-04 사고와 같은 종류).
const rulesSource = await readFile("src/lib/enrollment/changeRequestRules.ts", "utf8");
const rulesModule = await import(`data:text/javascript;base64,${Buffer.from(ts.transpileModule(rulesSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText).toString("base64")}`);
const client = await readFile("src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx", "utf8");
const page = await readFile("src/app/admin/enrollment-changes/page.tsx", "utf8");
const cronRoute = await readFile("src/app/api/cron/enrollment-changes/route.ts", "utf8");
const decideAction = await readFile("src/app/actions/enrollment-changes.ts", "utf8");
const cacheLib = await readFile("src/lib/enrollment/change-cache.ts", "utf8");

test("배지: 시트·랠리즈가 둘 다 확인돼야만 '반영 완료'", () => {
  const { syncCheckBadge } = rulesModule;
  assert.deepEqual(syncCheckBadge("PENDING", "PENDING"), { label: "사이트 반영됨 · 시트·랠리즈 확인 필요", needsCheck: true });
  assert.deepEqual(syncCheckBadge("SUCCEEDED", "PENDING"), { label: "사이트 반영됨 · 랠리즈 확인 필요", needsCheck: true });
  assert.deepEqual(syncCheckBadge("SUCCEEDED", "FAILED"), { label: "사이트 반영됨 · 랠리즈 확인 필요", needsCheck: true });
  assert.deepEqual(syncCheckBadge("FAILED", "SUCCEEDED"), { label: "사이트 반영됨 · 시트 확인 필요", needsCheck: true });
  assert.deepEqual(syncCheckBadge("SUCCEEDED", "SUCCEEDED"), { label: "반영 완료", needsCheck: false });
  assert.equal(syncCheckBadge(null, null), null);
});

test("목록이 연결 원장의 시트·랠리즈 상태를 읽고 '확인 필요' 탭·건수를 낸다", () => {
  // 연결 원장은 LATERAL LIMIT 1 로 붙인다(키 연결 + 직접 변경의 afterJson 연결 둘 다 인정).
  assert.match(adminLib, /LEFT JOIN LATERAL \(SELECT c\.id, c\.status, c\."holdReason" FROM "OperationsCommand" c/);
  assert.match(adminLib, /c\."idempotencyKey" = 'enrollment-change:' \|\| r\.id/);
  assert.match(adminLib, /a\.target = 'RALLYZ'/);
  assert.match(adminLib, /\$1 = 'NEEDS_CHECK' AND r\.status = 'APPLIED'/);
  assert.match(adminLib, /export async function countEnrollmentChangesNeedingCheck/);
  assert.match(page, /params\?\.status === "NEEDS_CHECK"/);
  assert.match(page, /countEnrollmentChangesNeedingCheck\(\)/);
  assert.match(client, /\{ value: "NEEDS_CHECK", label: "확인 필요" \}/);
  assert.match(client, /syncCheckBadge\(row\.sheetStatus, row\.rallyzStatus\)/);
});

test("확인 버튼은 기존 서버 액션을 쓰고, 누르기 전 확인창을 띄운다", () => {
  // 2026-10-06 변경: 클라이언트는 운영 동기화 함수를 직접 부르지 않고 결과 객체 래퍼만 부른다
  // (throw 메시지가 운영 빌드에서 가려지기 때문). 래퍼 안에서 기존 서버 액션을 그대로 호출한다.
  assert.doesNotMatch(client, /from "@\/app\/actions\/operations-sync"/);
  assert.match(client, /confirmEnrollmentChangeRallyz\(row\.syncCommandId!\)/);
  assert.match(client, /applyEnrollmentChangeSheet\(row\.syncCommandId!\)/);
  assert.match(decideAction, /recordOperationsExternalCheck\(commandId, "RALLYZ", true\)/);
  assert.match(decideAction, /applyOperationsSheet\(commandId\)/);
  assert.match(client, />\s*랠리즈 반영 확인\s*</);
  // 두 버튼 함수 모두 confirm 을 먼저 통과해야 한다
  const sheetFn = client.slice(client.indexOf("function applySheet"), client.indexOf("function confirmRallyz"));
  const rallyzFn = client.slice(client.indexOf("function confirmRallyz"), client.indexOf("function runSyncAction"));
  assert.match(sheetFn, /window\.confirm\(/);
  assert.match(rallyzFn, /window\.confirm\(/);
});

test("안내문이 실제 동작(사이트 자동 · 랠리즈·시트 수동 확인)과 같다", () => {
  assert.match(client, /적용일이 된 휴원·퇴원은 사이트에 자동 반영됩니다\(적용일이 이미 지난 건은 승인 즉시\)\. 랠리즈·시트는 직접 반영한 뒤 '랠리즈 반영 확인'을 눌러 주세요\./);
  assert.doesNotMatch(client, /세 시스템 확인 전에는 반이 바뀌거나 적용 완료로 표시되지 않습니다/);
  assert.match(client, /승인하면 적용일\(\{row\.effectiveFrom\}\)에 사이트에 자동 반영됩니다/);
  // 폐기된 운영 동기화 화면으로 안내하지 않는다
  assert.doesNotMatch(adminLib, /운영 동기화 화면에서 바로/);
});

test("캐시: 관리자 즉시 변경과 같은 범위를, 한 건이라도 적용되면 비운다", () => {
  for (const tag of ["admin-students", "admin-student-options", "admin-waitlist", "admin-makeup", "admin-dashboard",
    "admin-finance", "admin-stats", "admin-classes", "admin-apply"]) {
    assert.match(cacheLib, new RegExp(`"${tag}"`));
  }
  assert.match(cronRoute, /if \(applied > 0\) revalidateEnrollmentStatusCaches\(\)/);
  assert.match(decideAction, /result\.appliedCount > 0\) revalidateEnrollmentStatusCaches\(\)/);
  for (const source of [cronRoute, decideAction, cacheLib]) assert.doesNotMatch(source, /\/admin\/operations-sync/);
});

test("자동 적용 건은 finalize(세 시스템 완료 후 appliedAt)와 겹치지 않는다", () => {
  // 자동 적용은 이미 APPLIED + appliedAt 이라 finalize 의 대상 조건(APPROVED, appliedAt NULL)에서 빠진다 → 덮어쓰기 없음
  assert.match(finalize, /r\.status='APPROVED' AND r\."appliedAt" IS NULL/);
});
