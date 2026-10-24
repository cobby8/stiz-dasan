import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const publicErrors = {};
new Function('exports', ts.transpileModule(readFileSync('src/lib/user-facing-error.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(publicErrors);
const source = readFileSync('src/app/api/admin/finance/sheet-reconcile/route.ts', 'utf8');
function loadRoute(authorized = true) {
  const calls = [];
  const exports = {};
  const require = (name) => {
    if (name === '@/lib/user-facing-error') return publicErrors;
    if (name === 'next/server') return { NextResponse: { json: (body, options) => ({ body, status: options?.status ?? 200 }) } };
    if (name === '@/lib/auth-guard') return { requireAdmin: async () => { if (!authorized) throw Error('DENIED'); } };
    if (name === '@/lib/prisma') return { prisma: new Proxy({}, { get: (_, key) => async (...args) => { calls.push([key, ...args]); throw Error('Unexpected database access'); } }) };
    throw Error('Unexpected dependency: ' + name);
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, require, console });
  return { route: exports, calls };
}

test('stale clients cannot overwrite payments or create invoices', async () => {
  const { route, calls } = loadRoute();
  const result = await route.POST({ nextUrl: new URL('https://example.test/?year=2026&month=9') });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'RECONCILE_REVIEW_REQUIRED');
  assert.equal(calls.length, 0);
});

test('authorization and invalid periods fail without database access', async () => {
  for (const [authorized, url] of [[false, '?year=2026&month=9'], [true, '?year=2026&month=13']]) {
    const { route, calls } = loadRoute(authorized);
    const result = await route.POST({ nextUrl: new URL('https://example.test/' + url) });
    assert.equal(result.status, 400);
    assert.equal(calls.length, 0);
  }
});

test('preview includes all monthly payment rows and holds ambiguous matches', () => {
  assert.doesNotMatch(source, /DISTINCT ON/);
  assert.match(source, /SUM\(p.amount\)/);
  assert.match(source, /e\."paymentCount" > 1 OR t\."rowCount" > 1 THEN 'REVIEW'/);
  assert.match(source, /e\."studentId" IS NULL THEN 'REVIEW'/);
  assert.doesNotMatch(source, /THEN '(CREATE|UPDATE)'/);
});

test('reconciliation has no mutation or global overdue side effects', () => {
  assert.doesNotMatch(source, /\$executeRaw|\$transaction|ensureInvoicesForMonth|markOverduePayments|syncInvoiceStatusesForMonth/);
  assert.doesNotMatch(source, /UPDATE "Payment"|INSERT INTO "Payment"/);
});

test('missing month data cannot be presented as a clean reconciliation', () => {
  assert.match(source, /!batch \|\| summaryRows.length === 0/);
  assert.match(source, /선택한 월의 저장된 시트 대조 자료가 없습니다/);
});
