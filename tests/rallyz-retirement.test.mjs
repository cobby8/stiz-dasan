// 랠리즈 확인 은퇴 1단계(2026-11-14 원장 결정) 안전장치.
// 원장: 「이제 랠리즈는 사용하지 않을 거라 랠리즈 반영 확인 같은 부분은 필요 없어.」
// 1) 스위치: 기본 = 은퇴, STIZ_RALLYZ_SYNC_RETIRED 가 "0" 일 때만 옛 방식(랠리즈 칸 PENDING → 사람이 확인)
// 2) 새 원장: 은퇴면 RALLYZ 칸을 처음부터 SKIPPED+표식으로 만들고, 랠리즈 때문에 PENDING·HELD 가 생기지 않는다
// 3) «SKIPPED 인정» 판정이 여러 곳(TS·SQL)에서 같은 결과인지 «실행해서» 대조
// 4) «랠리즈 반영 확인» 서버 액션은 남아 있지만 은퇴 상태에서는 아무것도 바꾸지 않는다
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RALLYZ_RETIRED_REFERENCE, RALLYZ_RETIRED_MESSAGE, isRallyzSyncRetired, isRallyzTargetDone,
  isExternalTargetDone, externalSyncPendingSql, websiteDoneLedgerStatus,
} from '../src/lib/operations-sync/rallyzRetirement.ts';
import { initialSyncAttempt, isSheetSyncRetired, isSheetTargetDone, SHEET_RETIRED_REFERENCE } from '../src/lib/operations-sync/sheetRetirement.ts';
import { hasVerifiedSyncTargets } from '../src/lib/enrollment/finalize-change-sync.ts';
import { syncCheckBadge } from '../src/lib/enrollment/changeRequestRules.ts';
import { registrationReadiness } from '../src/lib/enrollment/registration-readiness.ts';
import { operationsEventPayloadHoldReason, prepareWebsiteOperationsEvent } from '../src/lib/operations-events/policy.ts';

const read = (path) => readFileSync(path, 'utf8');
const STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'SKIPPED'];

test('스위치: 기본값은 은퇴, 정확히 "0" 일 때만 옛 방식', () => {
  for (const value of [undefined, '', '1', 'true', 'false', 'no', '00']) {
    assert.equal(isRallyzSyncRetired({ STIZ_RALLYZ_SYNC_RETIRED: value }), true, String(value));
  }
  assert.equal(isRallyzSyncRetired({}), true);
  for (const value of ['0', ' 0', '0\n', '\t0 ']) assert.equal(isRallyzSyncRetired({ STIZ_RALLYZ_SYNC_RETIRED: value }), false, JSON.stringify(value));
  // 시트 스위치와 서로 영향을 주지 않는다
  assert.equal(isRallyzSyncRetired({ STIZ_SHEET_SYNC_RETIRED: '0' }), true);
  assert.equal(isSheetSyncRetired({ STIZ_RALLYZ_SYNC_RETIRED: '0' }), true);
});

test('생성 상태: 은퇴면 RALLYZ 는 SKIPPED+표식, 스위치 "0" 이면 옛 동작(PENDING)', () => {
  assert.equal(RALLYZ_RETIRED_REFERENCE, 'RALLYZ_RETIRED');
  // sheetRetirement 는 import 를 하지 않아 표식을 글자로 적는다 — 여기서 같은 값인지 대조한다
  assert.deepEqual(initialSyncAttempt('RALLYZ', true, true), { status: 'SKIPPED', externalReference: RALLYZ_RETIRED_REFERENCE });
  assert.deepEqual(initialSyncAttempt('RALLYZ', false, true), { status: 'SKIPPED', externalReference: RALLYZ_RETIRED_REFERENCE });
  assert.deepEqual(initialSyncAttempt('SHEET', true, true), { status: 'SKIPPED', externalReference: SHEET_RETIRED_REFERENCE });
  // 홈페이지는 어느 스위치로도 건너뛰지 않는다(사이트 반영은 실제 일)
  assert.deepEqual(initialSyncAttempt('WEBSITE', true, true), { status: 'PENDING', externalReference: null });
  // 스위치 "0"(옛 방식): 랠리즈 칸은 PENDING 으로 만들어져 사람이 확인한다
  const legacy = isRallyzSyncRetired({ STIZ_RALLYZ_SYNC_RETIRED: '0' });
  assert.deepEqual(initialSyncAttempt('RALLYZ', true, legacy), { status: 'PENDING', externalReference: null });
  // 세 번째 인자를 안 넘긴 옛 호출도 PENDING(시트 쪽 동작 불변)
  assert.deepEqual(initialSyncAttempt('RALLYZ', true), { status: 'PENDING', externalReference: null });
});

test('RALLYZ 를 만드는 곳은 전부 랠리즈 은퇴 분기를 거친다', () => {
  // 생성처 목록 자체는 tests/sheet-retirement.test.mjs 가 고정한다(새 생성처가 생기면 그 테스트가 먼저 깨진다)
  for (const path of [
    'src/app/actions/kakao-parent-intake-admin.ts',
    'src/app/actions/parent-operations-request.ts',
    'src/app/api/operations-events/route.ts',
    'src/lib/enrollment/admin-change-request.ts',
    'src/lib/operations-events/index.ts',
  ]) {
    const text = read(path);
    assert.match(text, /isRallyzSyncRetired\(process\.env\)/, path);
    // 은퇴 분기 없이 시트 스위치만 넘기는 옛 호출이 남아 있으면 랠리즈 칸이 PENDING 으로 만들어진다
    assert.doesNotMatch(text, /initialSyncAttempt\(target, (sheetRetired|isSheetSyncRetired\(process\.env\))\)/, path);
  }
});

test('홈페이지가 이미 반영된 원장: 시트·랠리즈가 둘 다 건너뜀이면 처음부터 SYNCED', () => {
  const statusOf = (sheetRetired, rallyzRetired) => websiteDoneLedgerStatus([
    initialSyncAttempt('SHEET', sheetRetired, rallyzRetired).status,
    initialSyncAttempt('RALLYZ', sheetRetired, rallyzRetired).status,
  ]);
  assert.equal(statusOf(true, true), 'SYNCED');
  // 스위치 "0": 랠리즈(또는 시트) 칸이 PENDING 이라 옛 방식대로 PENDING → 사람이 확인
  assert.equal(statusOf(true, false), 'PENDING');
  assert.equal(statusOf(false, true), 'PENDING');
  assert.equal(statusOf(false, false), 'PENDING');
  assert.equal(websiteDoneLedgerStatus([]), 'PENDING');
  // 그렇게 만든 세 칸은 완료 판정과도 맞는다(SYNCED 로 만든 원장 = hasVerifiedSyncTargets true)
  const rows = (sheetRetired, rallyzRetired) => [
    { target: 'SHEET', status: initialSyncAttempt('SHEET', sheetRetired, rallyzRetired).status, verifiedAt: null },
    { target: 'RALLYZ', status: initialSyncAttempt('RALLYZ', sheetRetired, rallyzRetired).status, verifiedAt: null },
    { target: 'WEBSITE', status: 'SUCCEEDED', verifiedAt: '2026-11-14T01:00:00Z' },
  ];
  assert.equal(hasVerifiedSyncTargets(rows(true, true)), true);
  assert.equal(hasVerifiedSyncTargets(rows(true, false)), false);
});

/** externalSyncPendingSql 을 JS 로 옮겨 «실제로 실행»한다. 남는 토큰이 있으면 실패시켜 조용히 통과하지 않게 한다. */
function compilePending(sql) {
  const js = sql
    .replace(/(\w+)\.target IN \('SHEET','RALLYZ'\)/, "['SHEET','RALLYZ'].includes(r.target)")
    .replace(/(\w+)\.status NOT IN \('SUCCEEDED','SKIPPED'\)/, "!['SUCCEEDED','SKIPPED'].includes(r.status)")
    .replaceAll(' AND ', ' && ');
  assert.match(js, /^\(\['SHEET','RALLYZ'\]\.includes\(r\.target\) && !\['SUCCEEDED','SKIPPED'\]\.includes\(r\.status\)\)$/, `알 수 없는 SQL: ${sql}`);
  return new Function('r', `return ${js};`);
}

test('«확인이 남은 칸» SQL 조각 = TS 판정(전 조합 실행 대조)', () => {
  assert.throws(() => externalSyncPendingSql('a; DROP'));
  for (const alias of ['a', 'pending']) {
    const sql = externalSyncPendingSql(alias);
    assert.ok(sql.includes(`${alias}.target`) && sql.includes(`${alias}.status`));
    const pending = compilePending(sql);
    for (const status of STATUSES) {
      // 시트·랠리즈: SUCCEEDED·SKIPPED 는 끝, 그 밖은 확인 남음
      assert.equal(pending({ target: 'SHEET', status }), !isSheetTargetDone(status), `SHEET ${status}`);
      assert.equal(pending({ target: 'RALLYZ', status }), !isRallyzTargetDone(status), `RALLYZ ${status}`);
      assert.equal(pending({ target: 'RALLYZ', status }), !isExternalTargetDone(status), `RALLYZ ${status}`);
      // 홈페이지 칸은 이 조건이 세지 않는다(옛 조건과 같다)
      assert.equal(pending({ target: 'WEBSITE', status }), false, `WEBSITE ${status}`);
    }
  }
  assert.equal(isRallyzTargetDone('SUCCEEDED'), true);
  assert.equal(isRallyzTargetDone('SKIPPED'), true);
  for (const value of ['PENDING', 'FAILED', null, undefined, '']) assert.equal(isRallyzTargetDone(value), false);
});

test('«SKIPPED 인정» 판정이 곳마다 같다: 배지·완료 판정·확인 필요 조건', () => {
  const pending = compilePending(externalSyncPendingSql('a'));
  for (const sheet of STATUSES) for (const rallyz of STATUSES) {
    const needsCheckSql = pending({ target: 'SHEET', status: sheet }) || pending({ target: 'RALLYZ', status: rallyz });
    // 배지(화면)와 확인 필요 탭·건수(SQL)가 같은 답을 낸다
    assert.equal(syncCheckBadge(sheet, rallyz).needsCheck, needsCheckSql, `${sheet}/${rallyz}`);
    // 재조회 시각이 다 있을 때, 완료 판정도 같은 답(홈페이지는 확인됨)
    const at = '2026-11-14T01:00:00Z';
    const done = hasVerifiedSyncTargets([
      { target: 'SHEET', status: sheet, verifiedAt: at }, { target: 'RALLYZ', status: rallyz, verifiedAt: at },
      { target: 'WEBSITE', status: 'SUCCEEDED', verifiedAt: at },
    ]);
    assert.equal(done, !needsCheckSql, `${sheet}/${rallyz}`);
  }
  // 은퇴 상태의 새 원장(시트·랠리즈 SKIPPED)은 확인 필요가 아니다
  assert.deepEqual(syncCheckBadge('SKIPPED', 'SKIPPED'), { label: '반영 완료', needsCheck: false });
});

test('공용 SQL 조각을 쓰는 곳 3곳 — 옛 «랠리즈는 SUCCEEDED 만» 조건이 남아 있지 않다', () => {
  const admin = read('src/lib/enrollment/admin-change-request.ts');
  const inbox = read('src/lib/requests/admin-inbox.ts');
  const ops = read('src/app/actions/operations-sync.ts');
  assert.match(admin, /AND \$\{externalSyncPendingSql\("a"\)\}\)`;/);
  assert.match(inbox, /'syncPending', EXISTS \([\s\S]*?AND \$\{externalSyncPendingSql\("a"\)\}/);
  assert.match(ops, /AND \$\{externalSyncPendingSql\("pending"\)\}/);
  for (const [name, text] of [['admin-change-request', admin], ['admin-inbox', inbox], ['operations-sync', ops]]) {
    assert.doesNotMatch(text, /target\s*=\s*'RALLYZ' AND \w+\.status <> 'SUCCEEDED'/, name);
  }
  // 완료 판정 SQL·TS(finalize)도 RALLYZ SKIPPED 를 인정하고, WEBSITE SKIPPED 는 인정하지 않는다
  const finalize = read('src/lib/enrollment/finalize-change-sync.ts');
  assert.match(finalize, /OR \(a\.target='RALLYZ' AND a\.status='SKIPPED'\)/);
  assert.doesNotMatch(finalize, /a\.target='WEBSITE' AND a\.status='SKIPPED'/);
  // 대기열 요약(읽기 전용 워커): 랠리즈 칸을 후보에서 빼고, 홈페이지 선행 조건도 공용 판정
  const worker = read('src/lib/operationsSyncWorker.ts');
  assert.match(worker, /AND \(\$3::boolean = false OR a\.target <> 'RALLYZ'\)/);
  assert.match(worker, /const rallyzDone = options\.rallyzRetired \|\| isRallyzTargetDone\(row\.rallyzStatus\);/);
  assert.match(worker, /const rallyzRetired = isRallyzSyncRetired\(process\.env\);/);
});

const EVENT = {
  eventId: 'enrollment:1', eventType: 'ENROLLMENT_STATUS', actorUserId: 'admin-1', studentId: 'student-1', studentName: '합성 학생',
  effectiveDate: '2026-11-14', before: { classId: 'class-1', status: 'PAUSED' }, summary: '합성 변경',
};

test('보류: 시트·랠리즈가 둘 다 은퇴면 «어댑터 없음» 보류가 생기지 않는다(CLASS_ADD·RESUME·CLASS_CHANGE)', () => {
  const cases = [
    ['PAUSE', { classId: 'class-1', status: 'PAUSED' }],
    ['WITHDRAW', { classId: 'class-1', status: 'WITHDRAWN' }],
    ['RESUME', { classId: 'class-1', status: 'ACTIVE' }],
    ['CLASS_ADD', { classId: 'class-2', status: 'ACTIVE' }],
    ['CLASS_CHANGE', { classId: 'class-2', status: 'ACTIVE' }],
  ];
  for (const [kind, after] of cases) {
    const input = { ...EVENT, kind, after };
    // 은퇴(둘 다): 어떤 종류도 보류되지 않는다
    assert.equal(prepareWebsiteOperationsEvent(input, { externalLedgersRetired: true }).holdReason, null, kind);
    // 옛 방식(스위치 "0" 또는 인자 없음): PAUSE·WITHDRAW 외에는 예전처럼 어댑터 보류
    const legacy = prepareWebsiteOperationsEvent(input).holdReason;
    if (kind === 'PAUSE' || kind === 'WITHDRAW') assert.equal(legacy, null, kind);
    else assert.match(legacy ?? '', /전용 동기화 어댑터/, kind);
    assert.equal(prepareWebsiteOperationsEvent(input, { externalLedgersRetired: false }).holdReason, legacy, kind);
  }
});

test('보류: 은퇴해도 다른 사유(학생 식별·종류 불명·적용일 없음)의 보류는 그대로다', () => {
  const event = (change) => ({ eventId: 'e-1', source: 'WEBSITE', occurredAt: '2026-11-14T00:00:00.000Z', change: {
    kind: 'PAUSE', effectiveMonth: '2026-11', effectiveDate: '2026-11-14', studentId: 'student-1', studentName: '합성',
    before: null, after: { classId: 'class-1', status: 'PAUSED' }, ...change,
  } });
  const retired = { externalLedgersRetired: true };
  assert.equal(operationsEventPayloadHoldReason(event({}), retired), null);
  assert.match(operationsEventPayloadHoldReason(event({ studentId: null }), retired) ?? '', /학생 식별값/);
  assert.match(operationsEventPayloadHoldReason(event({ kind: 'UNKNOWN' }), retired) ?? '', /변경 종류/);
  assert.match(operationsEventPayloadHoldReason(event({ effectiveDate: null }), retired) ?? '', /적용일/);
  assert.match(operationsEventPayloadHoldReason(event({ after: { classId: 'class-1', status: 'ACTIVE' } }), retired) ?? '', /PAUSED/);
});

test('등록 준비: 은퇴면 랠리즈 등록·보호자 초대 항목을 만들지 않고, 옛 방식이면 그대로', () => {
  const base = { applicationId: 'app-1', studentId: 'student-1', assignedClassIds: ['class-1'], activeClassIds: ['class-1'], shuttleNeeded: false, commands: [], invoiceCandidates: 0 };
  const retired = registrationReadiness({ ...base, sheetRetired: true, rallyzRetired: true }).checks.map(check => check.key);
  assert.ok(!retired.includes('RALLYZ') && !retired.includes('rallyz-invite') && !retired.includes('SHEET'));
  // 랠리즈와 무관한 확인 항목은 그대로 남는다(약해지지 않음)
  for (const key of ['site', 'invoice', 'invoice-notification', 'uniform', 'teacher']) assert.ok(retired.includes(key), key);
  // 스위치 "0"(옛 방식) 또는 값을 안 넘기면 예전 그대로
  for (const input of [{ ...base, sheetRetired: true, rallyzRetired: false }, { ...base, sheetRetired: true }]) {
    const keys = registrationReadiness(input).checks.map(check => check.key);
    assert.ok(keys.includes('RALLYZ') && keys.includes('rallyz-invite'));
  }
  const command = { id: 'c', studentId: 'student-1', kind: 'CLASS_ADD', status: 'SYNCED', createdAt: new Date('2026-11-14T00:00:00Z'),
    afterJson: {}, syncAttempts: [{ target: 'RALLYZ', status: 'SKIPPED', verifiedAt: null }] };
  const targets = registrationReadiness({ ...base, commands: [command], rallyzRetired: true }).evidence[0].targets;
  assert.equal(targets.find(row => row.target === 'RALLYZ').attempts[0].issue, '랠리즈 사용 종료로 건너뜀');
});

test('«랠리즈 반영 확인» 서버 액션: 남아 있지만 은퇴 상태에서는 아무것도 바꾸지 않는다', () => {
  const ops = read('src/app/actions/operations-sync.ts');
  const check = ops.slice(ops.indexOf('export async function recordOperationsExternalCheck'), ops.indexOf('export async function applyOperationsSheet'));
  // 권한 검사 → 은퇴 분기 → (옛 방식일 때만) DB 조회·수정 순서
  const guardAt = check.indexOf('await requireAdmin()');
  const retiredAt = check.indexOf('if (isRallyzSyncRetired(process.env)) return { ok: true as const, skipped: true as const, retired: true as const };');
  const firstQueryAt = check.indexOf('prisma.$');
  assert.ok(guardAt > 0 && guardAt < retiredAt && retiredAt < firstQueryAt, '권한 검사 뒤·DB 접근 앞에서 끝난다');
  // 건너뜀(SKIPPED)으로 닫힌 칸을 SUCCEEDED/FAILED 로 다시 열지 않는다(옛 방식에서도)
  assert.match(check, /a\.target=\$2 AND a\.status IN \('PENDING','FAILED'\)/);
  // 화면용 래퍼는 지우지 않았다(삭제는 3단계)
  const actions = read('src/app/actions/enrollment-changes.ts');
  assert.match(actions, /export async function confirmEnrollmentChangeRallyz\(commandId: string\)/);
  assert.match(actions, /export async function confirmEnrollmentChangesRallyzBulk\(/);
  // 일괄 확인: 은퇴면 건마다 서버 함수를 부르기 전에 전부 «필요 없음»으로 돌려준다
  const bulk = actions.slice(actions.indexOf('export async function confirmEnrollmentChangesRallyzBulk'), actions.indexOf('export async function confirmEnrollmentChangeSheetManually'));
  assert.ok(bulk.indexOf('await requireAdmin()') < bulk.indexOf('if (isRallyzSyncRetired(process.env)) {'));
  assert.ok(bulk.indexOf('if (isRallyzSyncRetired(process.env)) {') < bulk.indexOf('recordOperationsExternalCheck(row.syncCommandId, "RALLYZ", true)'));
  assert.match(bulk, /reason: RALLYZ_RETIRED_MESSAGE/);
  assert.equal(RALLYZ_RETIRED_MESSAGE, '랠리즈 반영 확인은 더 이상 필요 없습니다.');
  // 신청함 상세가 은퇴 여부를 서버에서 받는다
  assert.match(actions, /rallyzRetired: isRallyzSyncRetired\(process\.env\),/);
});

test('자동 적용 원장(휴원·퇴원·복귀): 은퇴면 요청·명령 SYNCED, 옛 방식이면 APPROVED·PENDING', () => {
  const lib = read('src/lib/enrollment/admin-change-request.ts');
  const ledger = lib.slice(lib.indexOf('async function insertAutoAppliedLedger'), lib.indexOf('export async function issueProrationInvoice'));
  assert.match(ledger, /const rallyzInitial = initialSyncAttempt\("RALLYZ", false, isRallyzSyncRetired\(process\.env\)\);/);
  assert.match(ledger, /const ledgerStatus = websiteDoneLedgerStatus\(\[sheetInitial\.status, rallyzInitial\.status\]\);/);
  assert.match(ledger, /ledgerStatus === "SYNCED" \? "SYNCED" : "APPROVED"/);
  assert.match(ledger, /target === "RALLYZ" \? rallyzInitial/);
  // 감사기록에 실제로 만든 랠리즈 칸 상태를 남긴다(하드코딩 "PENDING" 금지)
  assert.match(ledger, /rallyz: rallyzInitial\.status/);
  assert.doesNotMatch(ledger, /rallyz: "PENDING"/);
  // 반 변경 등 사이트 미반영 보류 원장도 랠리즈 칸은 은퇴 분기를 거친다
  assert.match(lib, /initialSyncAttempt\(target, isSheetSyncRetired\(process\.env\), isRallyzSyncRetired\(process\.env\)\)/);
});
