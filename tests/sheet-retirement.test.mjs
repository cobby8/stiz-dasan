// 구글 시트 원장 은퇴(Phase 2 시트 종료, 2026-10-06 원장 승인) 안전장치.
// 1) 스위치: 기본 = 은퇴, STIZ_SHEET_SYNC_RETIRED 가 "0" 일 때만 옛 3칸 방식
// 2) 완료 판정 두 벌(TS hasVerifiedSyncTargets · SQL VERIFIED_SYNC_TARGET_SQL)이 같은 결과인지 «실행해서» 대조
// 3) SHEET 시도를 만드는 곳은 전부 initialSyncAttempt 를 거친다(새 생성처가 생겨도 이 테스트가 잡는다)
// 4) 화면: 은퇴 시 시트 버튼·문구 숨김, 랠리즈 잠금 해제
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSheetSyncRetired, isSheetTargetDone, initialSyncAttempt, SHEET_RETIRED_REFERENCE,
} from '../src/lib/operations-sync/sheetRetirement.ts';
import { hasVerifiedSyncTargets, finalizeEnrollmentChangeSync, VERIFIED_SYNC_TARGET_SQL } from '../src/lib/enrollment/finalize-change-sync.ts';
import { syncCheckBadge } from '../src/lib/enrollment/changeRequestRules.ts';
import { registrationReadiness } from '../src/lib/enrollment/registration-readiness.ts';

const read = (path) => readFileSync(path, 'utf8');

test('스위치: 기본값은 은퇴, 정확히 "0" 일 때만 옛 방식', () => {
  for (const value of [undefined, '', '1', 'true', 'false', 'no', '00']) {
    assert.equal(isSheetSyncRetired({ STIZ_SHEET_SYNC_RETIRED: value }), true, String(value));
  }
  assert.equal(isSheetSyncRetired({}), true);
  // 대시보드에 붙여 넣다 섞인 공백·줄바꿈은 무시한다
  for (const value of ['0', ' 0', '0\n', '\t0 ']) assert.equal(isSheetSyncRetired({ STIZ_SHEET_SYNC_RETIRED: value }), false, JSON.stringify(value));
});

test('생성 상태: 은퇴면 SHEET 만 SKIPPED+표식, 스위치 "0" 이면 옛 동작(전부 PENDING)', () => {
  assert.deepEqual(initialSyncAttempt('SHEET', true), { status: 'SKIPPED', externalReference: SHEET_RETIRED_REFERENCE });
  assert.equal(SHEET_RETIRED_REFERENCE, 'SHEET_RETIRED');
  for (const target of ['RALLYZ', 'WEBSITE']) assert.deepEqual(initialSyncAttempt(target, true), { status: 'PENDING', externalReference: null });
  const legacy = isSheetSyncRetired({ STIZ_SHEET_SYNC_RETIRED: '0' });
  for (const target of ['SHEET', 'RALLYZ', 'WEBSITE']) assert.deepEqual(initialSyncAttempt(target, legacy), { status: 'PENDING', externalReference: null });
});

test('isSheetTargetDone: SUCCEEDED·SKIPPED 만 끝난 것', () => {
  assert.equal(isSheetTargetDone('SUCCEEDED'), true);
  assert.equal(isSheetTargetDone('SKIPPED'), true);
  for (const value of ['PENDING', 'FAILED', null, undefined, '']) assert.equal(isSheetTargetDone(value), false);
});

/**
 * VERIFIED_SYNC_TARGET_SQL 을 JS 로 옮겨 «실제로 실행»한다.
 * 허용 문법(괄호·AND·OR·=·IS NOT NULL·문자열)만 번역하고, 남는 토큰이 있으면 실패시켜 조용히 통과하는 일을 막는다.
 */
function compileSqlPredicate(sql) {
  const js = sql
    .replaceAll('a."verifiedAt" IS NOT NULL', '(r.verifiedAt !== null)')
    .replaceAll('a.status', 'r.status')
    .replaceAll('a.target', 'r.target')
    .replaceAll("='", "==='")
    .replaceAll(' AND ', ' && ')
    .replaceAll(' OR ', ' || ');
  assert.ok(!/\ba\./.test(js), `번역 안 된 컬럼: ${js}`);
  assert.match(js, /^[\s()r.\w'=!&|]+$/, `알 수 없는 SQL 토큰: ${js}`);
  return new Function('r', `return ${js};`);
}

/** finalize SQL 의 count 조건을 그대로 흉내 낸다: 전체 3행 + 조건을 만족하는 서로 다른 target 3개(처리 중 아님). */
function sqlVerdict(rows, predicate) {
  if (rows.length !== 3) return false;
  const done = new Set(rows.filter(r => ['SHEET', 'RALLYZ', 'WEBSITE'].includes(r.target) && predicate(r)).map(r => r.target));
  return done.size === 3;
}

test('완료 판정 TS·SQL 일치: SUCCEEDED/SKIPPED/PENDING/FAILED × 재조회 유무 전 조합', () => {
  const predicate = compileSqlPredicate(VERIFIED_SYNC_TARGET_SQL);
  const statuses = ['SUCCEEDED', 'SKIPPED', 'PENDING', 'FAILED'];
  const verified = [null, '2026-10-06T01:00:00Z'];
  const cells = statuses.flatMap(status => verified.map(verifiedAt => ({ status, verifiedAt })));
  let compared = 0;
  let trueCount = 0;
  for (const sheet of cells) for (const rallyz of cells) for (const website of cells) {
    const rows = [{ target: 'SHEET', ...sheet }, { target: 'RALLYZ', ...rallyz }, { target: 'WEBSITE', ...website }];
    const ts = hasVerifiedSyncTargets(rows);
    assert.equal(ts, sqlVerdict(rows, predicate), JSON.stringify(rows));
    compared += 1;
    if (ts) trueCount += 1;
  }
  assert.equal(compared, 512);
  // 끝난 SHEET(SUCCEEDED+재조회 1 · SKIPPED 2) × 끝난 RALLYZ 1 × 끝난 WEBSITE 1 = 3
  assert.equal(trueCount, 3);
});

test('완료 판정 핵심 사례(의도 고정)', () => {
  const at = '2026-10-06T01:00:00Z';
  const row = (target, status, verifiedAt = at) => ({ target, status, verifiedAt });
  // 시트 은퇴: SHEET SKIPPED(재조회 없음) + 랠리즈·홈페이지 확인 = 완료
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED', null), row('RALLYZ', 'SUCCEEDED'), row('WEBSITE', 'SUCCEEDED')]), true);
  // 옛 방식 그대로: 3칸 SUCCEEDED = 완료
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SUCCEEDED'), row('RALLYZ', 'SUCCEEDED'), row('WEBSITE', 'SUCCEEDED')]), true);
  // SKIPPED 는 SHEET 칸만 인정한다 — 랠리즈를 건너뛰면 완료가 아니다
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED', null), row('RALLYZ', 'SKIPPED', null), row('WEBSITE', 'SUCCEEDED')]), false);
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED', null), row('RALLYZ', 'SUCCEEDED'), row('WEBSITE', 'SKIPPED')]), false);
  // 기존 대기 건(시트 PENDING/FAILED)은 코드가 자동으로 완료시키지 않는다
  for (const status of ['PENDING', 'FAILED']) {
    assert.equal(hasVerifiedSyncTargets([row('SHEET', status, null), row('RALLYZ', 'SUCCEEDED'), row('WEBSITE', 'SUCCEEDED')]), false);
  }
});

test('finalize SQL 은 공용 조건 문자열을 그대로 쓴다(두 벌이 갈라지지 않게)', async () => {
  let query = '';
  const tx = { async $queryRawUnsafe(sql) { query = sql; return []; }, async $executeRawUnsafe() { assert.fail('완료 없음'); } };
  await finalizeEnrollmentChangeSync(tx, 'command-1');
  assert.ok(query.includes(VERIFIED_SYNC_TARGET_SQL));
  assert.ok(query.includes('a."processingToken" IS NULL AND a."processingStartedAt" IS NULL'));
  assert.doesNotMatch(query, /a\.status='SUCCEEDED' AND a\."verifiedAt" IS NOT NULL\s+AND a\."processingToken"/);
});

test('배지: SKIPPED 시트는 확인 완료 → "랠리즈 확인 필요" / "반영 완료"', () => {
  assert.deepEqual(syncCheckBadge('SKIPPED', 'PENDING'), { label: '사이트 반영됨 · 랠리즈 확인 필요', needsCheck: true });
  assert.deepEqual(syncCheckBadge('SKIPPED', 'FAILED'), { label: '사이트 반영됨 · 랠리즈 확인 필요', needsCheck: true });
  assert.deepEqual(syncCheckBadge('SKIPPED', 'SUCCEEDED'), { label: '반영 완료', needsCheck: false });
  // 옛 상태는 그대로
  assert.deepEqual(syncCheckBadge('PENDING', 'PENDING'), { label: '사이트 반영됨 · 시트·랠리즈 확인 필요', needsCheck: true });
  assert.deepEqual(syncCheckBadge('FAILED', 'SUCCEEDED'), { label: '사이트 반영됨 · 시트 확인 필요', needsCheck: true });
  // 배지의 시트 완료 규칙 = 공용 isSheetTargetDone (배지 파일은 import 없이 적혀 있어 여기서 대조한다)
  for (const sheet of ['SUCCEEDED', 'SKIPPED', 'PENDING', 'FAILED']) {
    const badge = syncCheckBadge(sheet, 'SUCCEEDED');
    assert.equal(!badge.needsCheck, isSheetTargetDone(sheet), sheet);
  }
});

/** src 아래 .ts/.tsx 파일 전체(테스트 제외) */
function sourceFiles(dir = 'src') {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

test('SHEET 시도를 만드는 곳은 전부 initialSyncAttempt(은퇴 분기)를 거친다', () => {
  const creators = sourceFiles().filter((path) => {
    const text = read(path);
    return /INSERT INTO "OperationsSyncAttempt"/.test(text) || /syncAttempts:\s*\{\s*create:/.test(text);
  }).map((path) => path.replaceAll('\\', '/')).sort();
  // 알려진 생성처 5개 파일(6곳). 새로 생기면 여기에 추가하고 분기를 넣어야 한다.
  assert.deepEqual(creators, [
    'src/app/actions/kakao-parent-intake-admin.ts',
    'src/app/actions/parent-operations-request.ts',
    'src/app/api/operations-events/route.ts',
    'src/lib/enrollment/admin-change-request.ts',
    'src/lib/operations-events/index.ts',
  ]);
  for (const path of creators) {
    const text = read(path);
    assert.match(text, /initialSyncAttempt\(/, path);
    assert.match(text, /isSheetSyncRetired\(process\.env\)/, path);
    // 하드코딩된 'PENDING' 시도 INSERT 가 남아 있으면 은퇴 분기를 우회한다
    assert.doesNotMatch(text, /INSERT INTO "OperationsSyncAttempt" \(id,"commandId",target,status\) VALUES \(\$1,\$2,\$3,'PENDING'\)/, path);
    assert.doesNotMatch(text, /map\(target => \(\{ target, status: "PENDING" \}\)\)/, path);
  }
  // 수강 변경 자동 적용 원장: 두 생성처(자동 적용·HELD) 모두
  const due = read('src/lib/enrollment/admin-change-request.ts');
  assert.equal((due.match(/initialSyncAttempt\(/g) || []).length >= 3, true);
  assert.match(due, /sheet: sheetInitial\.status/);
});

test('순서 강제·확인 필요 판정: SHEET 만 SKIPPED 를 끝난 것으로 본다', () => {
  const ops = read('src/app/actions/operations-sync.ts');
  // 홈페이지 반영 전 선행 조건
  assert.match(ops, /\(pending\.target='SHEET' AND pending\.status NOT IN \('SUCCEEDED','SKIPPED'\)\)\s*OR \(pending\.target='RALLYZ' AND pending\.status <> 'SUCCEEDED'\)/);
  // 랠리즈 확인 전 선행 조건
  const rallyz = ops.slice(ops.indexOf('export async function recordOperationsExternalCheck'), ops.indexOf('export async function applyOperationsSheet'));
  assert.match(rallyz, /!isSheetTargetDone\(sheet\[0\]\.status\)/);
  // 시트 반영: SKIPPED 칸은 시트를 건드리지 않는다
  const sheetApply = ops.slice(ops.indexOf('export async function applyOperationsSheet'), ops.indexOf('export async function recordOperationsSheetManualCheck'));
  assert.ok(sheetApply.indexOf('isSheetTargetDone(row.attemptStatus)') < sheetApply.indexOf('applySheetEnrollmentStatus({'));
  // 수동 확인: SKIPPED 칸은 손대지 않는다. 보류가 아니면 할 일 없음
  // (2-D 검수 수정: 복귀 어댑터 보류만 풀어 준다 — 아래 '서버: SKIPPED 칸은…' 테스트)
  const manual = ops.slice(ops.indexOf('export async function recordOperationsSheetManualCheck'), ops.indexOf('async function refreshOperationsStatuses'));
  assert.match(manual, /if \(sheet\.status === "SKIPPED"\) \{\s*if \(command\.status !== "HELD"\) return \{ changed: false \};/);
  assert.ok(manual.indexOf('sheet.status === "SKIPPED"') < manual.indexOf('UPDATE "OperationsSyncAttempt"'));
  // SYNCED 판정은 공용 판정 함수
  assert.match(ops.slice(ops.indexOf('async function refreshOperationsStatuses')), /hasVerifiedSyncTargets\(attempts\)/);
  // 확인 필요 목록·건수
  const admin = read('src/lib/enrollment/admin-change-request.ts');
  assert.match(admin, /\(a\.target = 'SHEET' AND a\.status NOT IN \('SUCCEEDED','SKIPPED'\)\)\s*OR \(a\.target = 'RALLYZ' AND a\.status <> 'SUCCEEDED'\)/);
  // 대기열 요약(읽기 전용 워커)
  const worker = read('src/lib/operationsSyncWorker.ts');
  assert.equal((worker.match(/isSheetTargetDone\(row\.sheetStatus\)/g) || []).length, 2);
});

test('시트 쓰기 코드는 되돌림용으로 남아 있다', () => {
  assert.match(read('src/lib/googleSheetsOperations.ts'), /export async function applySheetEnrollmentStatus/);
  assert.match(read('src/app/actions/operations-sync.ts'), /import \{ applySheetEnrollmentStatus \} from "@\/lib\/googleSheetsOperations"/);
});

test('등록 준비: 은퇴면 시트 항목을 만들지 않고, 옛 방식이면 그대로', () => {
  const base = { applicationId: 'app-1', studentId: 'student-1', assignedClassIds: ['class-1'], activeClassIds: ['class-1'], shuttleNeeded: false, commands: [], invoiceCandidates: 0 };
  assert.ok(!registrationReadiness({ ...base, sheetRetired: true }).checks.some(check => check.key === 'SHEET'));
  assert.ok(registrationReadiness({ ...base, sheetRetired: true }).checks.some(check => check.key === 'RALLYZ'));
  assert.ok(registrationReadiness({ ...base, sheetRetired: false }).checks.some(check => check.key === 'SHEET'));
  assert.ok(registrationReadiness(base).checks.some(check => check.key === 'SHEET'));
  const command = { id: 'c', studentId: 'student-1', kind: 'CLASS_ADD', status: 'PENDING', createdAt: new Date('2026-10-06T00:00:00Z'),
    afterJson: {}, syncAttempts: [{ target: 'SHEET', status: 'SKIPPED', verifiedAt: null }] };
  const [sheet] = registrationReadiness({ ...base, commands: [command], sheetRetired: true }).evidence[0].targets;
  assert.equal(sheet.attempts[0].issue, '시트 운영 종료로 건너뜀');
  assert.match(read('src/app/admin/registration-readiness/page.tsx'), /sheetRetired: isSheetSyncRetired\(process\.env\)/);
});

test('화면: 서버가 은퇴 여부를 넘기고, 은퇴 시 시트 문구·버튼을 숨기고 랠리즈 잠금을 푼다', () => {
  assert.match(read('src/app/admin/enrollment-changes/page.tsx'), /sheetRetired=\{isSheetSyncRetired\(process\.env\)\}/);
  const client = read('src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx');
  // 안내 문구(은퇴 시) — 원장 승인 문구 그대로
  assert.ok(client.includes("적용일이 된 휴원·퇴원은 사이트에 자동 반영됩니다. 랠리즈에 직접 반영한 뒤 '랠리즈 반영 확인'을 눌러 주세요."));
  assert.match(client, /const externalLabel = sheetRetired \? "랠리즈" : "시트·랠리즈";/);
  assert.match(client, /사이트에만 반영되고 \{externalLabel\} 확인이 남은 건이/);
  // 클라이언트 번들에서 process.env 를 읽지 않는다(서버가 넘긴 값만 쓴다)
  assert.doesNotMatch(client, /process\.env/);
  // SKIPPED 칸: 「시트에 반영」·「시트 직접 수정 완료」 숨김
  assert.match(client, /const sheetSkipped = row\.sheetStatus === "SKIPPED";/);
  assert.match(client, /\{row\.kind !== "RESUME" && !sheetSkipped && \(/);
  assert.match(client, /\{!sheetSkipped && \(row\.sheetStatus !== "SUCCEEDED" \|\| row\.syncCommandStatus === "HELD"\) && \(/);
  // 랠리즈 버튼 잠금 = 시트가 끝났는지(SUCCEEDED 또는 SKIPPED)
  assert.match(client, /disabled=\{pending \|\| !sheetDone \|\| row\.rallyzStatus === "SUCCEEDED" \|\| row\.syncCommandStatus === "HELD"\}/);
  assert.match(client, /const sheetDone = isSheetTargetDone\(row\.sheetStatus\);/);
  // 기존 PENDING/FAILED 시트 칸은 「시트 직접 수정 완료」로 끝낼 수 있다(버튼·확인창 유지)
  assert.match(client, />\s*시트 직접 수정 완료\s*</);
  assert.match(client, /confirmEnrollmentChangeSheetManually\(row\.syncCommandId!\)/);
});

// ── 2-D 검수 필수 수정(2026-10-06): 은퇴 모드의 관리자 직접 복귀(RESUME) 건이 끝까지 가야 한다 ──
// 흐름: 직접 복귀 → 정책 HELD(복귀 어댑터) → 칸 WEBSITE SUCCEEDED · SHEET SKIPPED · RALLYZ PENDING
//      → 「보류 해제 후 랠리즈 확인 진행」(SHEET 는 그대로, 보류만 해제) → 「랠리즈 반영 확인」 → SYNCED
const { sheetHoldReleaseDecision, sheetHoldDisplayReason, RESUME_ADAPTER_HOLD_REASON } = await import('../src/lib/enrollment/sheetManualCheckRules.ts');

test('복귀 건 끝까지: SKIPPED+HELD → 보류 해제 → 랠리즈 확인 → 완료 판정', () => {
  const at = '2026-10-06T01:00:00Z';
  const held = { kind: 'RESUME', studentId: 'student-1', enrollmentChangeRequestId: 'change-1',
    holdReason: RESUME_ADAPTER_HOLD_REASON, sheetStatus: 'SKIPPED', sheetError: null };
  // ① 보류 해제 판정: 복귀 어댑터 사유는 SKIPPED 여도 풀린다
  assert.deepEqual(sheetHoldReleaseDecision(held), { ok: true });
  // ② 해제 전: 랠리즈 미확인이라 완료 아님
  const before = [{ target: 'SHEET', status: 'SKIPPED', verifiedAt: null }, { target: 'RALLYZ', status: 'PENDING', verifiedAt: null }, { target: 'WEBSITE', status: 'SUCCEEDED', verifiedAt: at }];
  assert.equal(hasVerifiedSyncTargets(before), false);
  assert.equal(syncCheckBadge('SKIPPED', 'PENDING').needsCheck, true);
  // ③ 랠리즈 확인(시트 선행 조건은 SKIPPED 로 통과) 후: SHEET 는 여전히 SKIPPED 인 채로 완료
  assert.equal(isSheetTargetDone('SKIPPED'), true);
  const after = [before[0], { target: 'RALLYZ', status: 'SUCCEEDED', verifiedAt: at }, before[2]];
  assert.equal(hasVerifiedSyncTargets(after), true);
  assert.deepEqual(syncCheckBadge('SKIPPED', 'SUCCEEDED'), { label: '반영 완료', needsCheck: false });
  // 화면 문구는 영문 저장 문구 대신 한국어
  assert.equal(sheetHoldDisplayReason('RESUME', RESUME_ADAPTER_HOLD_REASON), '복귀는 시트 자동 반영을 지원하지 않습니다');
});

test('정책 보류는 시트가 SKIPPED 여도 풀리지 않는다', () => {
  const base = { kind: 'RESUME', studentId: 'student-1', enrollmentChangeRequestId: 'change-1',
    holdReason: RESUME_ADAPTER_HOLD_REASON, sheetStatus: 'SKIPPED', sheetError: null };
  for (const patch of [
    { studentId: null },                                   // 학생 식별 불가
    { enrollmentChangeRequestId: null },                    // 수강 변경 신청 미연결
    { holdReason: '학생 식별값이 없어 확인보류합니다.' },        // 다른 정책 사유
    { holdReason: `${RESUME_ADAPTER_HOLD_REASON} 추가 사유` }, // 다른 사유가 섞임
    { kind: 'PAUSE' },                                      // 복귀가 아닌 건
    { holdReason: 'X', sheetError: 'X' },                   // 시트 충돌 분기는 FAILED 조건이라 SKIPPED 엔 해당 없음
  ]) {
    assert.equal(sheetHoldReleaseDecision({ ...base, ...patch }).ok, false, JSON.stringify(patch));
  }
});

test('서버: SKIPPED 칸은 건드리지 않고, 판정 통과 시 보류만 풀고 감사기록을 남긴다', () => {
  const ops = read('src/app/actions/operations-sync.ts');
  const manual = ops.slice(ops.indexOf('export async function recordOperationsSheetManualCheck'), ops.indexOf('async function refreshOperationsStatuses'));
  const skipped = manual.slice(manual.indexOf('if (sheet.status === "SKIPPED") {'), manual.indexOf('if (sheet.status === "SUCCEEDED" && command.status !== "HELD")'));
  assert.ok(skipped.length > 0, 'SKIPPED 분기');
  assert.match(skipped, /if \(command\.status !== "HELD"\) return \{ changed: false \};/);
  // 판정 → 해제 → 감사 순서
  const decideAt = skipped.indexOf('sheetHoldReleaseDecision(');
  const releaseAt = skipped.indexOf(`UPDATE "OperationsCommand" SET status='PENDING', "holdReason"=NULL`);
  const auditAt = skipped.indexOf("'COMMAND_HOLD_RELEASED'");
  assert.ok(decideAt > 0 && decideAt < releaseAt && releaseAt < auditAt);
  assert.match(skipped, /if \(!decision\.ok\) throw new Error\(decision\.reason\)/);
  assert.match(skipped, /WHERE id=\$1 AND status='HELD'/);
  assert.match(skipped, /note: "시트 은퇴 상태에서 보류 해제"/);
  assert.match(skipped, /admin\.appUserId/);
  assert.match(skipped, /previousHoldReason: command\.holdReason/);
  // SHEET 칸은 이 분기에서 바꾸지 않는다
  assert.doesNotMatch(skipped, /UPDATE "OperationsSyncAttempt"/);
  // 함수 끝에서 재집계
  assert.match(manual, /await refreshOperationsStatuses\(commandId\)/);
  // 랠리즈 확인: SKIPPED 시트 통과, HELD 는 여전히 막음
  const rallyz = ops.slice(ops.indexOf('export async function recordOperationsExternalCheck'), ops.indexOf('export async function applyOperationsSheet'));
  assert.match(rallyz, /!isSheetTargetDone\(sheet\[0\]\.status\)/);
  assert.match(rallyz, /commandStatus === "HELD"/);
});

test('화면: 은퇴+복귀 어댑터 보류에만 「보류 해제 후 랠리즈 확인 진행」, 문구는 한국어', () => {
  const client = read('src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx');
  assert.match(client, /const retiredResumeHold = sheetSkipped && row\.syncCommandStatus === "HELD"\s*&& row\.kind === "RESUME" && row\.syncHoldReason\?\.trim\(\) === RESUME_ADAPTER_HOLD_REASON;/);
  assert.match(client, /\{retiredResumeHold && \(\s*<button[\s\S]*?onClick=\{\(\) => releaseRetiredResumeHold\(row\)\}[\s\S]*?보류 해제 후 랠리즈 확인 진행/);
  const fn = client.slice(client.indexOf('function releaseRetiredResumeHold'), client.indexOf('function confirmRallyz'));
  assert.match(fn, /window\.confirm\(/);
  assert.match(fn, /releaseEnrollmentChangeHoldSheetRetired\(row\.syncCommandId!\)/);
  // SKIPPED+HELD 문구도 sheetHoldDisplayReason 경유(영문 원문 노출 금지)
  assert.match(client, /자동 반영 보류: \{sheetHoldDisplayReason\(row\.kind, row\.syncHoldReason\)\}/);
  assert.doesNotMatch(client, /자동 반영 보류: \{row\.syncHoldReason \?\?/);
  // 래퍼는 같은 서버 함수를 부른다
  assert.match(read('src/app/actions/enrollment-changes.ts'), /releaseEnrollmentChangeHoldSheetRetired[\s\S]*?recordOperationsSheetManualCheck\(commandId\)/);
});
