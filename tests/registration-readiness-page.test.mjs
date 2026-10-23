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
  const prisma = Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, {
    async findMany(options) { calls.push({ key, options }); return value; },
  }]));
  const model = load('src/lib/enrollment/registration-readiness.ts', {});
  const page = load('src/app/admin/registration-readiness/page.tsx', {
    'react/jsx-runtime': jsx,
    'next/link': { default: ({ children, ...props }) => jsx.jsx('a', { ...props, children }) },
    '@/lib/auth-guard': { requireAdmin: async () => { if (unauthorized) throw new Error('unauthorized'); } },
    '@/lib/prisma': { prisma }, '@/lib/enrollment/registration-readiness': model,
    // 시트 은퇴 스위치(순수 판정 모듈, DB·외부 접근 없음) — 2026-10 시트 종료로 페이지가 읽는다.
    '@/lib/operations-sync/sheetRetirement': load('src/lib/operations-sync/sheetRetirement.ts', {}),
  });
  return { calls, render: async () => renderToStaticMarkup(await page.default()) };
}

test('실제 페이지가 조회한 원장 출처를 표시하고 실패 타깃과 시작일 보류를 유지한다', async () => {
  const f = fixture();
  const html = await f.render();
  for (const value of ['cmd-1', 'enroll-1', 'app-1', 'class-1', '성공', '실패', '확정 수강 시작일 근거 없음', '현재 수강 확인']) {
    assert.ok(html.includes(value), value);
  }
  assert.ok(!html.includes('DO_NOT_RENDER_RAW_PAYLOAD'));
  assert.ok(!html.includes('SUCCEEDED') && !html.includes('FAILED'));
  const query = f.calls.find(call => call.key === 'operationsCommand');
  assert.equal(query.options.select.afterJson, true);
  assert.equal(query.options.select.createdAt, true);
  assert.deepEqual(query.options.where.studentId.in, ['student-1']);
  assert.equal(f.calls.length, 4);
});

test('관리자 권한 실패는 페이지 자료 조회 전에 차단한다', async () => {
  const f = fixture(true);
  await assert.rejects(f.render(), /unauthorized/);
  assert.equal(f.calls.length, 0);
});
