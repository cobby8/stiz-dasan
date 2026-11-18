import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

function load(path, dependencies) {
  const output = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.compileFunction(output, ['require', 'exports'])(id => {
    assert.ok(Object.hasOwn(dependencies, id), `운영 모듈 접근 금지: ${id}`);
    return dependencies[id];
  }, exports);
  return exports;
}

function fixture(unauthorized = false) {
  const calls = [];
  const commands = [{ id: 'cmd-1', studentId: 'student-1', kind: 'CLASS_ADD', status: 'PARTIAL',
    effectiveMonth: '2026-09', createdAt: new Date('2026-09-01T00:00:00Z'),
    afterJson: { enrollmentApplicationId: 'app-1', classId: 'class-1', enrollmentId: 'enroll-1', effectiveDate: '2026-09-01',
      operationsEvent: { source: 'WEBSITE' }, privateUnusedField: 'DO_NOT_RENDER_RAW_PAYLOAD' },
    syncAttempts: [{ target: 'SHEET', status: 'SUCCEEDED', verifiedAt: new Date('2026-09-01T01:00:00Z') },
      { target: 'RALLYZ', status: 'FAILED', verifiedAt: null }] }];
  const rows = {
    enrollmentApplication: [{ id: 'app-1', childName: '가상학생', convertedStudentId: 'student-1', assignedClassId: 'class-1', shuttleNeeded: false }],
    enrollment: [{ studentId: 'student-1', classId: 'class-1' }], operationsCommand: commands, paymentInvoice: [],
  };
  // 2026-11-16 ORM 금지 규칙 정리: 페이지가 $queryRawUnsafe 로 읽으므로, SQL 의 FROM 테이블 이름으로 가짜 행을 고른다.
  // 재조회 기록은 별도 테이블(OperationsSyncAttempt)에서 명령 번호(commandId)와 함께 온다.
  const attempts = commands.flatMap(command => command.syncAttempts.map(attempt => ({ commandId: command.id, ...attempt })));
  const tables = { EnrollmentApplication: 'enrollmentApplication', Enrollment: 'enrollment', OperationsCommand: 'operationsCommand',
    PaymentInvoice: 'paymentInvoice', OperationsSyncAttempt: 'operationsSyncAttempt' };
  const prisma = {
    async $queryRawUnsafe(sql, ...args) {
      const key = tables[sql.match(/FROM "(\w+)"/)?.[1]];
      assert.ok(key, `모르는 조회: ${sql}`);
      calls.push({ key, sql, args });
      if (key === 'operationsSyncAttempt') return attempts;
      // 페이지가 받는 행에는 관계 묶음(syncAttempts)이 없다 — 페이지가 직접 붙여야 한다.
      if (key === 'operationsCommand') return commands.map(({ syncAttempts, ...row }) => row);
      return rows[key];
    },
  };
  const model = load('src/lib/enrollment/registration-readiness.ts', {});
  const page = load('src/app/admin/registration-readiness/page.tsx', {
    'react/jsx-runtime': jsx,
    'next/link': { default: ({ children, ...props }) => jsx.jsx('a', { ...props, children }) },
    '@/lib/auth-guard': { requireAdmin: async () => { if (unauthorized) throw new Error('unauthorized'); } },
    '@/lib/prisma': { prisma }, '@/lib/enrollment/registration-readiness': model,
    '@/lib/enrollment/shuttle-progress-query': { getEnrollmentShuttleProgress: async () => ({}) },
  });
  return { calls, render: async () => renderToStaticMarkup(await page.default()) };
}

// 2026-11-14 랠리즈 은퇴 → 2026-11-18 결정표(rallyz-switch «완전히 지운다»): 되돌리기 스위치 없이
// 화면은 랠리즈 등록·재조회·보호자 초대 칸을 그리지 않는다(과거 시트 재조회 기록·출처 표시는 그대로).
test('랠리즈 재조회·초대 항목을 그리지 않고, 조회한 원장 출처·시트 기록·시작일 보류는 유지한다', async () => {
  const f = fixture();
  const html = await f.render();
  for (const value of ['cmd-1', 'enroll-1', 'app-1', 'class-1', '성공', '확정 수강 시작일 근거 없음', '현재 수강 확인', '시트 재조회 기록']) {
    assert.ok(html.includes(value), value);
  }
  assert.ok(!html.includes('랠리즈 재조회 기록'));
  assert.ok(!/Rallyz/i.test(html), '랠리즈 등록·초대 항목 없음');
  // 랠리즈 칸(실패)이 가려져도 다른 확인 필요 항목은 그대로 남는다
  assert.ok(html.includes('최초 청구서') && html.includes('확인 필요'));
  assert.ok(!html.includes('DO_NOT_RENDER_RAW_PAYLOAD'));
  assert.ok(!html.includes('SUCCEEDED') && !html.includes('FAILED'));
  const query = f.calls.find(call => call.key === 'operationsCommand');
  assert.match(query.sql, /"afterJson"/);
  assert.match(query.sql, /"createdAt"/);
  assert.deepEqual(query.args[0], ['student-1']);
  // 신청·수강·명령·청구서 4번 + 재조회 기록 1번
  assert.equal(f.calls.length, 5);
  assert.deepEqual(f.calls.find(call => call.key === 'operationsSyncAttempt').args[0], ['cmd-1']);
  const source = readFileSync('src/app/admin/registration-readiness/page.tsx', 'utf8');
  // 스위치·환경변수를 다시 읽지 않는다
  assert.doesNotMatch(source, /process\.env|isRallyzSyncRetired|isSheetSyncRetired/);
  // ORM 기본 메서드(findMany 등)를 다시 쓰지 않는다 — PgBouncer 트랜잭션 모드 규칙
  assert.doesNotMatch(source, /prisma\.\w+\.(findMany|findFirst|findUnique|count|create|update|upsert|delete)\(/);
});

test('관리자 권한 실패는 페이지 자료 조회 전에 차단한다', async () => {
  const f = fixture(true);
  await assert.rejects(f.render(), /unauthorized/);
  assert.equal(f.calls.length, 0);
});
