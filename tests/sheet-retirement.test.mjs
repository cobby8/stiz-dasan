// 구글 시트 원장 은퇴(Phase 2 시트 종료, 2026-10-06 원장 승인 → 2026-11-18 결정표 sheet-switch «완전히 지운다») 안전장치.
// 1) 되돌리기 스위치(STIZ_SHEET_SYNC_RETIRED)·시트 쓰기 코드·시트 반영/직접 수정 버튼은 지웠다
// 2) 완료 판정 두 벌(TS hasVerifiedSyncTargets · SQL VERIFIED_SYNC_TARGET_SQL)이 같은 결과인지 «실행해서» 대조
// 3) SHEET 시도를 만드는 곳은 전부 initialSyncAttempt 를 거친다(새 생성처가 생겨도 이 테스트가 잡는다)
// 4) 남은 «보류 해제»(시트 SKIPPED + 복귀 어댑터 보류)가 끝까지 간다
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isExternalTargetDone, initialSyncAttempt, SHEET_RETIRED_REFERENCE } from '../src/lib/operations-sync/externalLedgerRetirement.ts';
import { hasVerifiedSyncTargets, finalizeEnrollmentChangeSync, VERIFIED_SYNC_TARGET_SQL } from '../src/lib/enrollment/finalize-change-sync.ts';
import { syncCheckBadge } from '../src/lib/enrollment/changeRequestRules.ts';
import { registrationReadiness } from '../src/lib/enrollment/registration-readiness.ts';

const read = (path) => readFileSync(path, 'utf8');

test('생성 상태: SHEET 는 언제나 SKIPPED+표식', () => {
  assert.deepEqual(initialSyncAttempt('SHEET'), { status: 'SKIPPED', externalReference: SHEET_RETIRED_REFERENCE });
  assert.equal(SHEET_RETIRED_REFERENCE, 'SHEET_RETIRED');
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
  // 끝난 SHEET(SUCCEEDED+재조회 1 · SKIPPED 2) × 끝난 RALLYZ(SUCCEEDED+재조회 1 · SKIPPED 2) × 끝난 WEBSITE 1 = 9
  assert.equal(trueCount, 9);
});

test('완료 판정 핵심 사례(의도 고정)', () => {
  const at = '2026-10-06T01:00:00Z';
  const row = (target, status, verifiedAt = at) => ({ target, status, verifiedAt });
  // 새 원장: 시트·랠리즈 건너뜀 + 홈페이지 확인 = 완료
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED', null), row('RALLYZ', 'SKIPPED', null), row('WEBSITE', 'SUCCEEDED')]), true);
  // 옛 원장: 3칸 SUCCEEDED = 완료
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SUCCEEDED'), row('RALLYZ', 'SUCCEEDED'), row('WEBSITE', 'SUCCEEDED')]), true);
  // 홈페이지(사이트 반영)는 실제 일이라 SKIPPED 를 끝으로 보지 않는다(약해지지 않음)
  assert.equal(hasVerifiedSyncTargets([row('SHEET', 'SKIPPED', null), row('RALLYZ', 'SUCCEEDED'), row('WEBSITE', 'SKIPPED')]), false);
  // 옛 대기 건(시트 PENDING/FAILED)은 코드가 자동으로 완료시키지 않는다
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

test('배지: SKIPPED 시트는 확인 완료, 배지의 시트 완료 규칙 = 공용 isExternalTargetDone', () => {
  assert.deepEqual(syncCheckBadge('SKIPPED', 'SKIPPED'), { label: '반영 완료', needsCheck: false });
  assert.deepEqual(syncCheckBadge('SKIPPED', 'SUCCEEDED'), { label: '반영 완료', needsCheck: false });
  // 옛 상태는 그대로
  assert.deepEqual(syncCheckBadge('PENDING', 'PENDING'), { label: '사이트 반영됨 · 시트·랠리즈 확인 필요', needsCheck: true });
  assert.deepEqual(syncCheckBadge('FAILED', 'SUCCEEDED'), { label: '사이트 반영됨 · 시트 확인 필요', needsCheck: true });
  // 배지 파일은 import 없이 적혀 있어 여기서 대조한다
  for (const sheet of ['SUCCEEDED', 'SKIPPED', 'PENDING', 'FAILED']) {
    const badge = syncCheckBadge(sheet, 'SUCCEEDED');
    assert.equal(!badge.needsCheck, isExternalTargetDone(sheet), sheet);
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

test('SHEET 시도를 만드는 곳은 전부 initialSyncAttempt 를 거친다', () => {
  const creators = sourceFiles().filter((path) => {
    const text = read(path);
    return /INSERT INTO "OperationsSyncAttempt"/.test(text) || /syncAttempts:\s*\{\s*create:/.test(text);
  }).map((path) => path.replaceAll('\\', '/')).sort();
  // 알려진 생성처 5개 파일(6곳). 새로 생기면 여기에 추가하고 initialSyncAttempt 를 거치게 해야 한다.
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
    assert.doesNotMatch(text, /isSheetSyncRetired|STIZ_SHEET_SYNC_RETIRED/, path);
    // 하드코딩된 'PENDING' 시도 INSERT 가 남아 있으면 은퇴 규칙을 우회한다
    assert.doesNotMatch(text, /INSERT INTO "OperationsSyncAttempt" \(id,"commandId",target,status\) VALUES \(\$1,\$2,\$3,'PENDING'\)/, path);
    assert.doesNotMatch(text, /map\(target => \(\{ target, status: "PENDING" \}\)\)/, path);
  }
  // 수강 변경 자동 적용 원장: 두 생성처(자동 적용·HELD) 모두
  const due = read('src/lib/enrollment/admin-change-request.ts');
  assert.equal((due.match(/initialSyncAttempt\(/g) || []).length >= 3, true);
  assert.match(due, /sheet: sheetInitial\.status/);
});

test('확인 필요 판정·재집계: 바깥 장부(SHEET·RALLYZ)만 SKIPPED 를 끝난 것으로 본다', () => {
  const ops = read('src/app/actions/operations-sync.ts');
  // SYNCED 판정은 공용 판정 함수
  assert.match(ops.slice(ops.indexOf('async function refreshOperationsStatuses')), /hasVerifiedSyncTargets\(attempts\)/);
  const admin = read('src/lib/enrollment/admin-change-request.ts');
  assert.match(admin, /AND \$\{externalSyncPendingSql\("a"\)\}\)`;/);
  assert.equal(existsSync('src/lib/operationsSyncWorker.ts'), false);
});

test('시트 쓰기·읽기 코드와 시트 반영 버튼은 지워졌다', () => {
  for (const path of [
    'src/lib/googleSheetsOperations.ts', 'src/lib/googleSheetsOperations.test.ts', 'src/lib/syncSheetSlots.ts',
    'src/app/api/admin/sync-schedule', 'src/app/api/admin/finance/sheet-reconcile', 'scripts/sync-classes.mjs',
    'src/lib/operations-sync/sheetRetirement.ts',
  ]) assert.equal(existsSync(path), false, path);
  const ops = read('src/app/actions/operations-sync.ts');
  assert.doesNotMatch(ops, /applySheetEnrollmentStatus|applyOperationsSheet|googleSheetsOperations/);
  const client = read('src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx');
  assert.doesNotMatch(client, /시트에 반영|시트 직접 수정 완료|applySheet|confirmSheetManually|sheetRetired/);
  // 클라이언트 번들에서 process.env 를 읽지 않는다
  assert.doesNotMatch(client, /process\.env/);
});

test('등록 준비: 시트 항목을 만들지 않고, 과거 시트 기록은 «건너뜀»으로 보인다', () => {
  const base = { applicationId: 'app-1', studentId: 'student-1', assignedClassIds: ['class-1'], activeClassIds: ['class-1'], shuttleNeeded: false, commands: [], invoiceCandidates: 0 };
  assert.ok(!registrationReadiness(base).checks.some(check => check.key === 'SHEET'));
  const command = { id: 'c', studentId: 'student-1', kind: 'CLASS_ADD', status: 'PENDING', createdAt: new Date('2026-10-06T00:00:00Z'),
    afterJson: {}, syncAttempts: [{ target: 'SHEET', status: 'SKIPPED', verifiedAt: null }] };
  const [sheet] = registrationReadiness({ ...base, commands: [command] }).evidence[0].targets;
  assert.equal(sheet.attempts[0].issue, '시트 운영 종료로 건너뜀');
  assert.doesNotMatch(read('src/app/admin/registration-readiness/page.tsx'), /sheetRetired|isSheetSyncRetired/);
});

// ── 2-D 검수 필수 수정(2026-10-06) → 2026-11-18: 관리자 직접 복귀(RESUME) 건이 끝까지 가야 한다 ──
// 흐름: 직접 복귀 → 정책 HELD(복귀 어댑터) → 칸 WEBSITE SUCCEEDED · SHEET SKIPPED · RALLYZ SKIPPED
//      → 「보류 해제」(SHEET 는 그대로, 보류만 해제) → 재집계에서 바로 SYNCED
const { sheetHoldReleaseDecision, sheetHoldDisplayReason, RESUME_ADAPTER_HOLD_REASON } = await import('../src/lib/enrollment/sheetManualCheckRules.ts');

test('복귀 건 끝까지: SKIPPED+HELD → 보류 해제 → 완료 판정', () => {
  const at = '2026-10-06T01:00:00Z';
  const held = { kind: 'RESUME', studentId: 'student-1', enrollmentChangeRequestId: 'change-1',
    holdReason: RESUME_ADAPTER_HOLD_REASON, sheetStatus: 'SKIPPED', sheetError: null };
  // ① 보류 해제 판정: 복귀 어댑터 사유는 SKIPPED 여도 풀린다
  assert.deepEqual(sheetHoldReleaseDecision(held), { ok: true });
  // ② 칸은 이미 끝난 상태 — 보류만 풀리면 재집계(hasVerifiedSyncTargets)가 완료로 본다
  const rows = [{ target: 'SHEET', status: 'SKIPPED', verifiedAt: null }, { target: 'RALLYZ', status: 'SKIPPED', verifiedAt: null }, { target: 'WEBSITE', status: 'SUCCEEDED', verifiedAt: at }];
  assert.equal(hasVerifiedSyncTargets(rows), true);
  assert.deepEqual(syncCheckBadge('SKIPPED', 'SKIPPED'), { label: '반영 완료', needsCheck: false });
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
  assert.match(manual, /if \(command\.status !== "HELD"\) return \{ changed: false \};/);
  assert.match(manual, /if \(sheet\.status !== "SKIPPED"\) throw/);
  // 판정 → 해제 → 감사 순서
  const decideAt = manual.indexOf('sheetHoldReleaseDecision(');
  const releaseAt = manual.indexOf(`UPDATE "OperationsCommand" SET status='PENDING', "holdReason"=NULL`);
  const auditAt = manual.indexOf("'COMMAND_HOLD_RELEASED'");
  assert.ok(decideAt > 0 && decideAt < releaseAt && releaseAt < auditAt);
  assert.match(manual, /if \(!decision\.ok\) throw new Error\(decision\.reason\)/);
  assert.match(manual, /WHERE id=\$1 AND status='HELD'/);
  assert.match(manual, /note: "시트 은퇴 상태에서 보류 해제"/);
  assert.match(manual, /admin\.appUserId/);
  assert.match(manual, /previousHoldReason: command\.holdReason/);
  // SHEET 칸은 바꾸지 않는다
  assert.doesNotMatch(manual, /UPDATE "OperationsSyncAttempt"/);
  // 함수 끝에서 재집계
  assert.match(manual, /await refreshOperationsStatuses\(commandId\)/);
});

test('화면: 복귀 어댑터 보류에만 «보류 해제», 문구는 한국어', () => {
  const client = read('src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx');
  assert.match(client, /const retiredResumeHold = sheetSkipped && row\.syncCommandStatus === "HELD"\s*&& row\.kind === "RESUME" && row\.syncHoldReason\?\.trim\(\) === RESUME_ADAPTER_HOLD_REASON;/);
  assert.match(client, /\{retiredResumeHold && \(\s*<button[\s\S]*?onClick=\{\(\) => releaseRetiredResumeHold\(row\)\}[\s\S]*?보류 해제/);
  const fn = client.slice(client.indexOf('function releaseRetiredResumeHold'), client.indexOf('function runSyncAction'));
  assert.match(fn, /askConfirm\(/);
  assert.match(fn, /releaseEnrollmentChangeHoldSheetRetired\(row\.syncCommandId!\)/);
  // SKIPPED+HELD 문구도 sheetHoldDisplayReason 경유(영문 원문 노출 금지)
  assert.match(client, /자동 반영 보류: \{sheetHoldDisplayReason\(row\.kind, row\.syncHoldReason\)\}/);
  assert.doesNotMatch(client, /자동 반영 보류: \{row\.syncHoldReason \?\?/);
  // 래퍼는 같은 서버 함수를 부른다
  assert.match(read('src/app/actions/enrollment-changes.ts'), /releaseEnrollmentChangeHoldSheetRetired[\s\S]*?recordOperationsSheetManualCheck\(commandId\)/);
});
