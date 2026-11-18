// 랠리즈 은퇴 안전장치 (2026-11-14 원장 결정 → 2026-11-18 결정표 rallyz-switch «완전히 지운다»).
// 원장: 「이제 랠리즈는 사용하지 않을 거라 랠리즈 반영 확인 같은 부분은 필요 없어.」
// 1) 되돌리기 스위치(STIZ_RALLYZ_SYNC_RETIRED)·«랠리즈 반영 확인» 서버 액션·화면은 지웠다
// 2) 새 원장: RALLYZ 칸은 언제나 처음부터 SKIPPED+표식, 랠리즈 때문에 PENDING·HELD 가 생기지 않는다
// 3) «SKIPPED 인정» 판정이 여러 곳(TS·SQL)에서 같은 결과인지 «실행해서» 대조(불변식 — 옛 PENDING 행이 남아도 같은 답)
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  RALLYZ_RETIRED_REFERENCE, SHEET_RETIRED_REFERENCE, initialSyncAttempt,
  isExternalTargetDone, externalSyncPendingSql, websiteDoneLedgerStatus,
} from '../src/lib/operations-sync/externalLedgerRetirement.ts';
import { hasVerifiedSyncTargets } from '../src/lib/enrollment/finalize-change-sync.ts';
import { syncCheckBadge } from '../src/lib/enrollment/changeRequestRules.ts';
import { registrationReadiness } from '../src/lib/enrollment/registration-readiness.ts';
import { operationsEventPayloadHoldReason, prepareWebsiteOperationsEvent } from '../src/lib/operations-events/policy.ts';

const read = (path) => readFileSync(path, 'utf8');
const STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED', 'SKIPPED'];

test('스위치 모듈·환경변수 판정은 지워졌다', () => {
  assert.equal(existsSync('src/lib/operations-sync/rallyzRetirement.ts'), false);
  assert.equal(existsSync('src/lib/operations-sync/sheetRetirement.ts'), false);
  const mod = read('src/lib/operations-sync/externalLedgerRetirement.ts');
  // 순수 모듈 — 다른 모듈을 import 하지 않고 process.env 를 읽지 않는다
  assert.doesNotMatch(mod, /^import /m);
  assert.doesNotMatch(mod, /process\.env|isRallyzSyncRetired|isSheetSyncRetired/);
});

test('생성 상태: RALLYZ·SHEET 는 언제나 SKIPPED+표식, WEBSITE 는 PENDING', () => {
  assert.equal(RALLYZ_RETIRED_REFERENCE, 'RALLYZ_RETIRED');
  assert.equal(SHEET_RETIRED_REFERENCE, 'SHEET_RETIRED');
  assert.deepEqual(initialSyncAttempt('RALLYZ'), { status: 'SKIPPED', externalReference: RALLYZ_RETIRED_REFERENCE });
  assert.deepEqual(initialSyncAttempt('SHEET'), { status: 'SKIPPED', externalReference: SHEET_RETIRED_REFERENCE });
  // 홈페이지는 건너뛰지 않는다(사이트 반영은 실제 일)
  assert.deepEqual(initialSyncAttempt('WEBSITE'), { status: 'PENDING', externalReference: null });
});

test('RALLYZ 를 만드는 곳은 전부 공용 initialSyncAttempt(target) 하나를 쓴다', () => {
  for (const path of [
    'src/app/actions/kakao-parent-intake-admin.ts',
    'src/app/actions/parent-operations-request.ts',
    'src/app/api/operations-events/route.ts',
    'src/lib/enrollment/admin-change-request.ts',
    'src/lib/operations-events/index.ts',
  ]) {
    const text = read(path);
    assert.match(text, /from "(@\/lib|\.\.)\/operations-sync\/externalLedgerRetirement"/, path);
    assert.match(text, /initialSyncAttempt\((target|"RALLYZ")\)/, path);
    assert.doesNotMatch(text, /isRallyzSyncRetired|isSheetSyncRetired|STIZ_RALLYZ_SYNC_RETIRED|STIZ_SHEET_SYNC_RETIRED/, path);
  }
});

test('홈페이지가 이미 반영된 원장: 시트·랠리즈가 둘 다 건너뜀이라 처음부터 SYNCED', () => {
  assert.equal(websiteDoneLedgerStatus([initialSyncAttempt('SHEET').status, initialSyncAttempt('RALLYZ').status]), 'SYNCED');
  // 옛 PENDING 칸이 섞이면 PENDING(사람이 확인) — 판정 규칙 자체는 그대로
  assert.equal(websiteDoneLedgerStatus(['SKIPPED', 'PENDING']), 'PENDING');
  assert.equal(websiteDoneLedgerStatus([]), 'PENDING');
  // 그렇게 만든 세 칸은 완료 판정과도 맞는다(SYNCED 로 만든 원장 = hasVerifiedSyncTargets true)
  assert.equal(hasVerifiedSyncTargets([
    { target: 'SHEET', status: initialSyncAttempt('SHEET').status, verifiedAt: null },
    { target: 'RALLYZ', status: initialSyncAttempt('RALLYZ').status, verifiedAt: null },
    { target: 'WEBSITE', status: 'SUCCEEDED', verifiedAt: '2026-11-14T01:00:00Z' },
  ]), true);
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
      assert.equal(pending({ target: 'SHEET', status }), !isExternalTargetDone(status), `SHEET ${status}`);
      assert.equal(pending({ target: 'RALLYZ', status }), !isExternalTargetDone(status), `RALLYZ ${status}`);
      // 홈페이지 칸은 이 조건이 세지 않는다
      assert.equal(pending({ target: 'WEBSITE', status }), false, `WEBSITE ${status}`);
    }
  }
  assert.equal(isExternalTargetDone('SUCCEEDED'), true);
  assert.equal(isExternalTargetDone('SKIPPED'), true);
  for (const value of ['PENDING', 'FAILED', null, undefined, '']) assert.equal(isExternalTargetDone(value), false);
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
  // 새 원장(시트·랠리즈 SKIPPED)은 확인 필요가 아니다
  assert.deepEqual(syncCheckBadge('SKIPPED', 'SKIPPED'), { label: '반영 완료', needsCheck: false });
});

test('공용 SQL 조각을 쓰는 곳 2곳 — 옛 «랠리즈는 SUCCEEDED 만» 조건이 남아 있지 않다', () => {
  const admin = read('src/lib/enrollment/admin-change-request.ts');
  const inbox = read('src/lib/requests/admin-inbox.ts');
  const ops = read('src/app/actions/operations-sync.ts');
  assert.match(admin, /AND \$\{externalSyncPendingSql\("a"\)\}\)`;/);
  assert.match(inbox, /'syncPending', EXISTS \([\s\S]*?AND \$\{externalSyncPendingSql\("a"\)\}/);
  for (const [name, text] of [['admin-change-request', admin], ['admin-inbox', inbox], ['operations-sync', ops]]) {
    assert.doesNotMatch(text, /target\s*=\s*'RALLYZ' AND \w+\.status <> 'SUCCEEDED'/, name);
  }
  // 완료 판정 SQL·TS(finalize)도 RALLYZ SKIPPED 를 인정하고, WEBSITE SKIPPED 는 인정하지 않는다
  const finalize = read('src/lib/enrollment/finalize-change-sync.ts');
  assert.match(finalize, /OR \(a\.target='RALLYZ' AND a\.status='SKIPPED'\)/);
  assert.doesNotMatch(finalize, /a\.target='WEBSITE' AND a\.status='SKIPPED'/);
  assert.equal(existsSync('src/lib/operationsSyncWorker.ts'), false);
});

const EVENT = {
  eventId: 'enrollment:1', eventType: 'ENROLLMENT_STATUS', actorUserId: 'admin-1', studentId: 'student-1', studentName: '합성 학생',
  effectiveDate: '2026-11-14', before: { classId: 'class-1', status: 'PAUSED' }, summary: '합성 변경',
};

// 보류 판정(policy.ts)의 externalLedgersRetired 옵션은 남긴다: 사이트 내부 경로는 true 로 고정하고,
// 바깥 주소 /api/operations-events 는 옵션 없이 불러 CLASS_ADD·RESUME 를 보류하는 지금 동작을 유지한다(2026-11-18 결정).
test('보류: 사이트 내부 경로(externalLedgersRetired)에서는 «어댑터 없음» 보류가 생기지 않는다', () => {
  const cases = [
    ['PAUSE', { classId: 'class-1', status: 'PAUSED' }],
    ['WITHDRAW', { classId: 'class-1', status: 'WITHDRAWN' }],
    ['RESUME', { classId: 'class-1', status: 'ACTIVE' }],
    ['CLASS_ADD', { classId: 'class-2', status: 'ACTIVE' }],
    ['CLASS_CHANGE', { classId: 'class-2', status: 'ACTIVE' }],
  ];
  for (const [kind, after] of cases) {
    const input = { ...EVENT, kind, after };
    assert.equal(prepareWebsiteOperationsEvent(input, { externalLedgersRetired: true }).holdReason, null, kind);
    // 옵션 없음(바깥 주소와 같은 판정): PAUSE·WITHDRAW 외에는 어댑터 보류
    const outside = prepareWebsiteOperationsEvent(input).holdReason;
    if (kind === 'PAUSE' || kind === 'WITHDRAW') assert.equal(outside, null, kind);
    else assert.match(outside ?? '', /전용 동기화 어댑터/, kind);
  }
  assert.match(read('src/lib/operations-events/index.ts'), /\{ externalLedgersRetired: true \}/);
  assert.match(read('src/app/api/operations-events/route.ts'), /operationsEventPayloadHoldReason\(event\)/);
});

test('보류: 다른 사유(학생 식별·종류 불명·적용일 없음)의 보류는 그대로다', () => {
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

test('등록 준비: 랠리즈 등록·보호자 초대·시트 등록 항목이 없고, 다른 확인 항목은 그대로', () => {
  const base = { applicationId: 'app-1', studentId: 'student-1', assignedClassIds: ['class-1'], activeClassIds: ['class-1'], shuttleNeeded: false, commands: [], invoiceCandidates: 0 };
  const keys = registrationReadiness(base).checks.map(check => check.key);
  assert.ok(!keys.includes('RALLYZ') && !keys.includes('rallyz-invite') && !keys.includes('SHEET'));
  for (const key of ['site', 'invoice', 'invoice-notification', 'uniform', 'teacher']) assert.ok(keys.includes(key), key);
  // 증거 목록에도 랠리즈 칸을 보이지 않는다
  const command = { id: 'c', studentId: 'student-1', kind: 'CLASS_ADD', status: 'SYNCED', createdAt: new Date('2026-11-14T00:00:00Z'),
    afterJson: {}, syncAttempts: [{ target: 'RALLYZ', status: 'SKIPPED', verifiedAt: null }] };
  const targets = registrationReadiness({ ...base, commands: [command] }).evidence[0].targets;
  assert.ok(!targets.some(row => row.target === 'RALLYZ'));
});

test('«랠리즈 반영 확인» 서버 액션·래퍼·일괄 확인·신청함 버튼은 지워졌다', () => {
  const ops = read('src/app/actions/operations-sync.ts');
  const actions = read('src/app/actions/enrollment-changes.ts');
  const inbox = read('src/app/admin/inbox/InboxClient.tsx');
  const client = read('src/app/admin/enrollment-changes/EnrollmentChangesClient.tsx');
  assert.doesNotMatch(ops, /recordOperationsExternalCheck|isRallyzSyncRetired/);
  for (const name of ['confirmEnrollmentChangeRallyz', 'confirmEnrollmentChangesRallyzBulk', 'RALLYZ_RETIRED_MESSAGE', 'rallyzRetired', 'sheetRetired']) {
    assert.ok(!actions.includes(name), `enrollment-changes: ${name}`);
  }
  for (const name of ['confirmEnrollmentChangesRallyzBulk', 'rallyzCheckIds', 'rallyzRetired', '랠리즈 반영 확인']) {
    assert.ok(!inbox.includes(name), `InboxClient: ${name}`);
  }
  for (const name of ['confirmRallyz', 'rallyzRetired', '랠리즈 반영 확인']) {
    assert.ok(!client.includes(name), `EnrollmentChangesClient: ${name}`);
  }
});

test('자동 적용 원장(휴원·퇴원·복귀): 요청·명령 SYNCED, 감사기록에 실제 만든 랠리즈 칸 상태', () => {
  const lib = read('src/lib/enrollment/admin-change-request.ts');
  const ledger = lib.slice(lib.indexOf('async function insertAutoAppliedLedger'), lib.indexOf('export async function issueProrationInvoice'));
  assert.match(ledger, /const rallyzInitial = initialSyncAttempt\("RALLYZ"\);/);
  assert.match(ledger, /const ledgerStatus = websiteDoneLedgerStatus\(\[sheetInitial\.status, rallyzInitial\.status\]\);/);
  assert.match(ledger, /ledgerStatus === "SYNCED" \? "SYNCED" : "APPROVED"/);
  assert.match(ledger, /target === "RALLYZ" \? rallyzInitial/);
  // 감사기록에 실제로 만든 랠리즈 칸 상태를 남긴다(하드코딩 "PENDING" 금지)
  assert.match(ledger, /rallyz: rallyzInitial\.status/);
  assert.doesNotMatch(ledger, /rallyz: "PENDING"/);
  // 반 변경 등 사이트 미반영 보류 원장도 같은 공용 함수로 칸을 만든다
  assert.match(lib, /\.\.\.initialSyncAttempt\(target\)/);
});
