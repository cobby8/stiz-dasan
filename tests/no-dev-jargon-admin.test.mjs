// 관리자 화면에 «개발 언어»(영어 상태값·개발 용어·오류 원문)가 다시 나오지 않게 막는 회귀 테스트.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const read = path => readFileSync(path, 'utf8');
function compile(source) {
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'console', result)(require, module, module.exports, { error() {} });
  return module.exports;
}
function walk(dir) {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
const adminFiles = [...walk('src/app/admin'), ...walk('src/components/admin')];
const text = compile(read('src/components/admin/adminDisplayText.ts'));

test('오류 원문은 한국어 업무 안내만 통과하고 기술 문구·영어는 작업별 안내로 바꾼다', () => {
  const fallback = '저장하지 못했습니다.';
  // 한국어 업무 안내는 그대로
  assert.equal(text.adminErrorText(new Error('이미 등록된 학생입니다.'), fallback), '이미 등록된 학생입니다.');
  // 권한 코드 괄호는 떼어낸다
  assert.equal(text.adminErrorText(new Error('원장 권한이 필요합니다. (ADMIN만 가능)'), fallback), '원장 권한이 필요합니다.');
  for (const raw of [
    'Failed to load classes.',
    'Unique constraint failed on the fields: (`phone`)',
    'Invalid `prisma.$queryRawUnsafe()` invocation: relation "Student" does not exist',
    '저장 실패: duplicate key value violates unique constraint',
    '서버 오류(500)',
    'HTTP 401',
    '데이터베이스 연결 실패',
    '상태가 PENDING 이라 처리할 수 없습니다.',
    'TypeError: Cannot read properties of undefined',
    '[object Object]',
    '',
  ]) assert.equal(text.adminErrorText(new Error(raw), fallback), fallback, raw);
  assert.equal(text.adminErrorText({ message: '이건 Error 가 아님' }, fallback), fallback);
  assert.equal(text.adminMessageText(undefined, fallback), fallback);
});

test('결제 수단은 저장값을 바꾸지 않고 화면 이름만 한국어로 보인다', () => {
  assert.equal(text.paymentMethodLabel('CARD'), '카드');
  assert.equal(text.paymentMethodLabel('CASH'), '현금');
  assert.equal(text.paymentMethodLabel('BANK_TRANSFER'), '계좌이체');
  assert.equal(text.paymentMethodLabel('RALLYZ'), '랠리즈');
  assert.equal(text.paymentMethodLabel('MANUAL'), '직접 처리');
  assert.equal(text.paymentMethodLabel('카드(현장)'), '카드(현장)');
  assert.equal(text.paymentMethodLabel('SOMETHING_NEW'), '수단 미확인');
  assert.equal(text.paymentMethodLabel(null), '');
});

test('관리자 화면은 catch 오류 원문을 그대로 화면에 띄우지 않는다', () => {
  const offenders = [];
  for (const path of adminFiles) {
    if (path.endsWith('adminDisplayText.ts')) continue;
    const source = read(path);
    // «오류 instanceof Error ? 오류.message : …» 와 «e.message || "…"» 를 화면 표시용으로 쓰지 않는다
    if (/\b(\w+) instanceof Error \? \1\.message\b/.test(source) || /\b(?:e|err|error)\.message \|\| "/.test(source)) offenders.push(path);
    // «오류: ${data.error}» 처럼 서버 원문을 붙여 보여주지 않는다
    if (/`오류: \$\{\w+\.error\}`/.test(source)) offenders.push(path);
  }
  assert.deepEqual(offenders, []);
});
