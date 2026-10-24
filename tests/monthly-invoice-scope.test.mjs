import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// 운영 연결 없이 실제 함수 본문을 실행하여 모든 쿼리의 대상 범위를 확인한다.
function harness() {
  const source = readFileSync('src/lib/payment-ledger.ts', 'utf8');
  const start = source.indexOf('export async function ensureInvoicesForMonth(');
  const end = source.indexOf('export async function ensureInvoiceForPayment(', start);
  const js = ts.transpileModule(source.slice(start, end).replace('export async', 'async'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const calls = [];
  let infrastructureCalls = 0;
  const db = {
    async $executeRawUnsafe(sql, ...values) { calls.push({ sql, values }); return 1; },
    async $queryRawUnsafe(sql, ...values) { calls.push({ sql, values }); return [{ count: 2 }]; },
  };
  const execute = new Function('prisma', 'ensurePaymentInfrastructure', `${js}; return ensureInvoicesForMonth;`)(
    db, async () => { infrastructureCalls += 1; },
  );
  return { execute, calls, infrastructureCalls: () => infrastructureCalls };
}

test('선택 발행은 생성·Payment 갱신·합계 모두 같은 ID 배열로 제한한다', async () => {
  const { execute, calls } = harness();
  assert.deepEqual(await execute(2026, 9, ['payment-a', 'payment-b']), { invoiceCount: 2 });
  assert.equal(calls.length, 3);
  for (const { sql, values } of calls) {
    assert.match(sql, /AND \(\$5::text\[\] IS NULL OR p.id = ANY\(\$5::text\[\]\)\)/);
    assert.deepEqual(values, [2026, 9, '2026-09-01', '2026-10-01', ['payment-a', 'payment-b']]);
  }
});

test('빈 발행 선택은 월 전체 발행으로 확대하지 않고 아무 조회·쓰기도 하지 않는다', async () => {
  const fixture = harness();
  assert.deepEqual(await fixture.execute(2026, 9, []), { invoiceCount: 0 });
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.infrastructureCalls(), 0);
});

test('명시적 ID 범위가 없는 기존 호출의 인수 호환성을 유지한다', async () => {
  const { execute, calls } = harness();
  await execute(2026, 12);
  for (const { values } of calls) assert.deepEqual(values, [2026, 12, '2026-12-01', '2027-01-01', null]);
});

test('호출자가 전달한 거래 안에서만 세 쿼리를 수행한다', async () => {
  const app = harness();
  const calls = [];
  const tx = {
    async $executeRawUnsafe(...args) { calls.push(args); return 1; },
    async $queryRawUnsafe(...args) { calls.push(args); return [{ count: 1 }]; },
  };
  assert.deepEqual(await app.execute(2026, 9, ['payment-a'], tx), { invoiceCount: 1 });
  assert.equal(calls.length, 3);
  assert.equal(app.calls.length, 0);
  assert.equal(app.infrastructureCalls(), 0);
  for (const args of calls) assert.deepEqual(args.at(-1), ['payment-a']);
});

test('청구서 저장 실패를 삼키거나 전역 연결로 재시도하지 않는다', async () => {
  const app = harness();
  await assert.rejects(app.execute(2026, 9, ['payment-a'], {
    async $executeRawUnsafe() { throw new Error('INVOICE_FAILED'); },
    async $queryRawUnsafe() { assert.fail('실패 후 조회 금지'); },
  }), /INVOICE_FAILED/);
  assert.equal(app.calls.length, 0);
  assert.equal(app.infrastructureCalls(), 0);
});
