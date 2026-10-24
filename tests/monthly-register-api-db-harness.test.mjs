import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMonthlyRegisterApiDbHarness } from './helpers/monthly-register-api-db-harness.mjs';

const url = 'http://localhost:12345/api/admin/finance/monthly-register';
const identity = { id: 'synthetic-auth', email: 'admin@harness.invalid' };

// 이 파일은 연결 도구 자체의 회귀 검사다. 실제 DB 통합 결과와 따로 집계한다.
function fixture() {
  const calls = { queries: 0, transactions: 0 };
  const database = {
    async $queryRawUnsafe() { calls.queries++; return [{ id: 'synthetic-db-admin', name: '가상 관리자', role: 'ADMIN' }]; },
    async $transaction() { calls.transactions++; throw new Error('SYNTHETIC_TRANSACTION_BOUNDARY'); },
  };
  return { calls, harness: createMonthlyRegisterApiDbHarness({ database }) };
}

test('격리 브리지는 익명 요청을 DB 접속 전 차단한다', async () => {
  const { calls, harness } = fixture();
  assert.equal((await harness.handle(new Request(url))).status, 403);
  assert.deepEqual(calls, { queries: 0, transactions: 0 });
});

test('격리 브리지는 운영 URL과 허용되지 않은 API 경로를 실행하지 않는다', async () => {
  const { calls, harness } = fixture();
  for (const target of ['https://example.invalid/api/admin/finance/monthly-register', 'http://localhost:12345/api/other']) {
    await assert.rejects(harness.handle(new Request(target)), /localhost API/);
  }
  assert.deepEqual(calls, { queries: 0, transactions: 0 });
});

test('정상 JSON은 실제 일반 객체 검증을 통과해 거래 경계까지 도달한다', async () => {
  const { calls, harness } = fixture();
  const reason = '합성 저장 검증';
  const payload = { studentId: 'student-test', month: '2026-10', reason,
    classes: [{ classId: 'class-test', status: 'ACTIVE', periodStart: '2026-10-01', periodEnd: '2026-10-28',
      baseAmount: 100000, discountAmount: 0, carryAmount: 0, prorationAmount: 0, basis: reason }],
    shuttleAmount: 0, shuttleBasis: '셔틀 미이용' };
  const request = new Request(url, { method: 'POST', headers: { origin: 'http://localhost:12345', 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'SAVE_DRAFT', studentId: payload.studentId, month: payload.month, expectedVersion: 0, reason, payload }) });
  const response = await harness.handle(request, { identity });
  // 합성 DB가 의도적으로 던진 500이어야 한다. VM 원형 불일치로 400이면 회귀다.
  assert.equal(response.status, 500);
  assert.equal(calls.transactions, 1);
  assert.doesNotMatch(await response.text(), /SYNTHETIC_TRANSACTION_BOUNDARY/);
});

test('요청별 저장 플래그는 실제 프로세스 환경을 변경하지 않는다', async () => {
  const { harness } = fixture();
  const before = process.env.MONTHLY_REGISTER_WRITES_ENABLED;
  const response = await harness.handle(new Request(url, { method: 'POST' }), { identity, writesEnabled: false });
  assert.equal(response.status, 503);
  assert.equal(process.env.MONTHLY_REGISTER_WRITES_ENABLED, before);
});
