import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

function harness({ authorized = true, result = {}, failure = null } = {}) {
  const events = [];
  const source = readFileSync('src/app/api/admin/finance/monthly-ledger/route.ts', 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const modules = {
    'next/server': { NextResponse: { json: (body, init) => ({ body, ...init }) } },
    '@/lib/auth-guard': { requireAdmin: async () => { events.push('auth'); if (!authorized) throw new Error('private-auth-detail'); } },
    '@/lib/prisma': { prisma: { $transaction: async (fn, options) => {
      events.push(options);
      return fn({ $executeRawUnsafe: async sql => { events.push(sql); } });
    } } },
    '@/lib/billing/monthly-class-ledger-read': {
      parseMonthlyLedgerMonth: value => { if (value !== '2026-09') throw new Error('INVALID_MONTH'); },
      readMonthlyClassLedger: async (_tx, month) => {
        events.push(month);
        if (failure) throw new Error(failure);
        return result;
      },
    },
  };
  const exports = {};
  new Function('require', 'exports', js)(id => {
    assert.ok(id in modules, `예상하지 않은 의존성 ${id}`);
    return modules[id];
  }, exports);
  return { get: month => exports.GET({ nextUrl: new URL(`https://example.test/?month=${month}`) }), events };
}

test('미인증과 잘못된 월은 데이터 조회 전에 차단', async () => {
  const denied = harness({ authorized: false });
  const response = await denied.get('2026-09');
  assert.equal(response.status, 403);
  assert.deepEqual(denied.events, ['auth']);
  assert.doesNotMatch(JSON.stringify(response), /private-auth-detail/);
  const invalid = harness();
  assert.equal((await invalid.get('2026-13')).status, 400);
  assert.deepEqual(invalid.events, ['auth']);
});

test('인증 뒤 일관된 읽기 전용 거래로 조회하고 캐시하지 않는다', async () => {
  const app = harness({ result: { rows: [] } });
  const response = await app.get('2026-09');
  assert.deepEqual(app.events, ['auth', { isolationLevel: 'RepeatableRead' }, 'SET TRANSACTION READ ONLY', '2026-09']);
  assert.deepEqual(response.body, { rows: [] });
  assert.match(response.headers['Cache-Control'], /no-store/);
});

test('DB 오류·과다 조회는 정상 0건으로 위장하지 않고 내부 내용은 숨긴다', async () => {
  for (const [failure, status] of [['DATABASE_SECRET_DETAIL', 500], ['MONTHLY_LEDGER_LIMIT', 422]]) {
    const response = await harness({ failure }).get('2026-09');
    assert.equal(response.status, status);
    assert.ok(response.body.error);
    assert.doesNotMatch(JSON.stringify(response), /DATABASE_SECRET_DETAIL/);
    assert.match(response.headers['Cache-Control'], /no-store/);
  }
});
