import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readMonthlyClassLedger, parseMonthlyLedgerMonth, MONTHLY_LEDGER_READ_LIMIT } from '../src/lib/billing/monthly-class-ledger-read.ts';

test('월 입력을 엄격히 검사하고 잘못된 요청은 조회하지 않는다', async () => {
  assert.deepEqual(parseMonthlyLedgerMonth('2026-09'), { year: 2026, month: 9 });
  for (const month of ['', '2026-9', '2026-00', '2026-13', '2019-12', '2101-01', '2026-09x']) {
    await assert.rejects(readMonthlyClassLedger({ $queryRawUnsafe() { assert.fail('조회 금지'); } }, month), /INVALID_MONTH/);
  }
});

test('월별 납부와 현재 수강은 읽기만 하며 반 없는 납부를 임의 연결하지 않는다', async () => {
  const calls = [];
  const db = { async $queryRawUnsafe(sql, ...values) {
    calls.push({ sql, values });
    return calls.length === 1
      ? [{ studentId: 'student-a', studentName: '테스트 학생', classId: 'class-a', className: '테스트 반', status: 'ACTIVE' }]
      : [{ id: 'payment-a', studentId: 'student-a', studentName: '테스트 학생', classId: null, className: null,
        year: 2026, month: 9, type: 'MONTHLY', amount: 50000, status: 'PAID' }];
  } };
  const result = await readMonthlyClassLedger(db, '2026-09');
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows.find(row => row.classId === 'class-a').paidAmount, null);
  assert.equal(result.rows.find(row => row.classId === null).paidAmount, 50000);
  assert.deepEqual(calls[1].values, [2026, 9, MONTHLY_LEDGER_READ_LIMIT + 1]);
  assert.match(calls[1].sql, /LEFT JOIN "Class"/);
  for (const { sql } of calls) {
    assert.match(sql.trim(), /^SELECT/);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|ALTER|CREATE)\b/i);
    assert.doesNotMatch(sql, /parentPhone|birthDate|email|receiptUrl|providerPaymentKey/);
  }
});

test('조회 상한을 넘으면 잘린 합계 대신 실패한다', async () => {
  const rows = Array.from({ length: MONTHLY_LEDGER_READ_LIMIT + 1 }, () => ({}));
  await assert.rejects(readMonthlyClassLedger({ async $queryRawUnsafe() { return rows; } }, '2026-09'), /MONTHLY_LEDGER_LIMIT/);
});

test('API는 관리자 인증·읽기 거래·캐시 금지 및 쓰기 경로 미노출', () => {
  const route = readFileSync('src/app/api/admin/finance/monthly-ledger/route.ts', 'utf8');
  assert.ok(route.indexOf('await requireAdmin()') < route.indexOf('prisma.$transaction'));
  assert.match(route, /SET TRANSACTION READ ONLY/);
  assert.match(route, /isolationLevel: "RepeatableRead"/);
  assert.match(route, /private, no-store/);
  assert.doesNotMatch(route, /export async function (POST|PATCH|DELETE)|ensure.*Table|sendSMS|notify/);
});

test('화면은 현재 명부와 월 확정 장부 차이·미배정·알 수 없는 금액을 명시한다', () => {
  const ui = readFileSync('src/app/admin/finance/monthly-ledger/MonthlyLedgerClient.tsx', 'utf8');
  assert.match(ui, /조회 월의 확정 명부가 아닙니다/);
  assert.match(ui, /반 미연결 — 임의 배분 안 함/);
  assert.match(ui, /value === null \? "기록 없음"/);
  assert.match(ui, /controller.abort\(\)/);
  assert.doesNotMatch(ui, /generateMonthlyInvoices|method: "POST"/);
});
