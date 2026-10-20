import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const exports = {};
new Function('exports', ts.transpileModule(readFileSync('src/lib/billing/absence-compensation-guard.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)(exports);
const { assertRegularMakeupAllowed, assertMakeupSessionAllowed, assertAbsenceCompensationEditable, lockCompensation, CompensationConflict } = exports;

function tx({ installed = true, carry = false } = {}) {
  const calls = [];
  return { calls,
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes('to_regclass')) return [{ found: installed ? 'BillingAbsenceResolution' : null }];
      return carry ? [{ id: 'absence-a', absenceId: 'absence-a' }] : [];
    },
    async $executeRawUnsafe(sql) { calls.push({ sql }); return 1; },
  };
}

test('이월 구조 설치 전에는 기존 보강·결석 경로를 막지 않는다', async () => {
  const db = tx({ installed: false });
  await assertRegularMakeupAllowed(db, { studentId: 's', classId: 'c', dateYmd: '2026-10-12' });
  await assertMakeupSessionAllowed(db, 'm');
  await assertAbsenceCompensationEditable(db, 'a');
  assert.equal(db.calls.length, 3);
});

test('이월된 원결석은 기존 관리자 보강 입구에서도 예약을 차단한다', async () => {
  const db = tx({ carry: true });
  await assert.rejects(assertRegularMakeupAllowed(db, { studentId: 's', classId: 'c', dateYmd: '2026-10-12' }), CompensationConflict);
  assert.deepEqual(db.calls[1].values, ['s', 'c', '2026-10-12']);
});

test('이월된 예약을 참석·노쇼·예약 상태로 되살리는 것도 차단한다', async () => {
  const db = tx({ carry: true });
  await assert.rejects(assertMakeupSessionAllowed(db, 'm'), CompensationConflict);
  assert.match(db.calls[1].sql, /AT TIME ZONE 'Asia\/Seoul'/);
});

test('이월 정산된 결석은 기존 취소·확정 해제에서 먼저 정산 확인을 요구한다', async () => {
  await assert.rejects(assertAbsenceCompensationEditable(tx({ carry: true }), 'a'), CompensationConflict);
  await assertAbsenceCompensationEditable(tx(), 'a');
});

test('기존 경로와 청구 저장은 같은 결석 정산 잠금을 사용한다', async () => {
  const db = tx();
  await lockCompensation(db);
  assert.match(db.calls[0].sql, /pg_advisory_xact_lock\(hashtext\('STIZ_BILLING_WORKBENCH'\)\)/);
});

test('회수된 보강권은 기존 예약 상태 동기화에서 부활하지 않는다', async () => {
  const credit = { status: 'REVOKED', makeupSessionId: 'm' };
  const prisma = { async $executeRawUnsafe(sql, ...args) {
    // 실제 SQL 결과 검사는 별도 PostgreSQL 하네스에서 한다. 여기서는 보호 조건의 행동 계약을 검사한다.
    assert.match(sql, /status <> 'REVOKED'/);
    if (credit.status === 'REVOKED') return 0;
    credit.status = args[1] ?? 'AVAILABLE'; return 1;
  } };
  const module = {};
  const js = ts.transpileModule(readFileSync('src/lib/makeup/credit-service.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function('require', 'exports', js)((id) => {
    if (id === '@/lib/prisma') return { prisma };
    if (id === './credit-rules') return {};
    if (id === '@/lib/billing/absence-compensation-guard') return exports;
    throw new Error(`격리하지 않은 의존성: ${id}`);
  }, module);
  for (const status of ['CANCELLED', 'BOOKED', 'ATTENDED', 'NO_SHOW']) {
    assert.equal((await module.syncCreditForMakeupSession({ makeupSessionId: 'm', status })).action, 'none');
    assert.equal(credit.status, 'REVOKED');
  }
});
