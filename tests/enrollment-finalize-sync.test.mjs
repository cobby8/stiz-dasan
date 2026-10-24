import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hasVerifiedSyncTargets, finalizeEnrollmentChangeSync } from '../src/lib/enrollment/finalize-change-sync.ts';

const attempts = ['SHEET', 'RALLYZ', 'WEBSITE'].map(target => ({ target, status: 'SUCCEEDED', verifiedAt: '2026-09-04T01:00:00Z' }));
test('세 시스템 각각의 성공과 재조회가 있어야 완료', () => {
  assert.equal(hasVerifiedSyncTargets(attempts), true);
  for (const rows of [[], attempts.slice(0, 1), attempts.slice(0, 2), [...attempts, attempts[0]], [attempts[0], attempts[0], attempts[2]]]) {
    assert.equal(hasVerifiedSyncTargets(rows), false);
  }
  for (const replacement of [{ target: 'OTHER' }, { status: 'FAILED' }, { status: 'PENDING' }, { verifiedAt: null }, { verifiedAt: 'bad-date' }]) {
    assert.equal(hasVerifiedSyncTargets([{ ...attempts[0], ...replacement }, ...attempts.slice(1)]), false);
  }
});
test('완료 SQL은 정확한 연결과 사이트 상태를 잠가 검증', async () => {
  let query = '';
  const tx = { async $queryRawUnsafe(sql, id) { query = sql; assert.equal(id, 'command-1'); return []; }, async $executeRawUnsafe() { assert.fail('미완료는 감사 생성 금지'); } };
  assert.equal(await finalizeEnrollmentChangeSync(tx, 'command-1'), 0);
  for (const clause of ['FOR UPDATE OF r, e', 'c."studentId"=r."studentId"', 'c.kind=r.kind', "c.kind IN ('PAUSE','WITHDRAW')", 'c."holdReason" IS NULL', "'enrollment-change:' || r.id", 'IS NOT DISTINCT FROM r."toClassId"', "WHEN 'PAUSE' THEN 'PAUSED' ELSE 'WITHDRAWN' END", 'a."processingToken" IS NULL', 'r."appliedAt" IS NULL', 'c."effectiveMonth"=to_char', "'Asia/Seoul'", 'c."afterJson"->>\'effectiveDate\'=to_char']) assert.ok(query.includes(clause), clause);
});
test('성공한 행만 같은 거래의 감사와 연결하고 반복은 no-op', async () => {
  let calls = 0;
  const audits = [];
  const tx = { async $queryRawUnsafe() { return calls++ === 0 ? [{ id: 'change-1', requestId: 'ops-1' }] : []; }, async $executeRawUnsafe(...args) { audits.push(args); return 1; } };
  assert.equal(await finalizeEnrollmentChangeSync(tx, 'command-1'), 1);
  assert.equal(await finalizeEnrollmentChangeSync(tx, 'command-1'), 0);
  assert.equal(audits.length, 1);
  assert.equal(JSON.parse(audits[0][2]).notificationsSent, false);
});
test('감사 저장 오류는 거래 호출자까지 전달되어 완료만 남지 않음', async () => {
  const tx = { async $queryRawUnsafe() { return [{ id: 'change-1', requestId: 'ops-1' }]; }, async $executeRawUnsafe() { throw new Error('AUDIT_FAILED'); } };
  await assert.rejects(finalizeEnrollmentChangeSync(tx, 'command-1'), /AUDIT_FAILED/);
});
test('상태 집계 거래 안에서만 완료 연결 호출', () => {
  const source = readFileSync('src/app/actions/operations-sync.ts', 'utf8').split('async function refreshOperationsStatuses')[1];
  assert.match(source, /hasVerifiedSyncTargets\(attempts\)/);
  assert.match(source, /if \(commandStatus === "SYNCED"\) await finalizeEnrollmentChangeSync\(tx, commandId\)/);
  assert.ok(source.indexOf('finalizeEnrollmentChangeSync(tx') < source.indexOf('if (!changes) return'));
});
