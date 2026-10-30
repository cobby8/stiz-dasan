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

// 화면에 보이는 한국어 문장(JSX 글자·문자열)에서 개발 용어·영어 상태값을 찾는다. console·throw 안의 글은 제외.
const DEV_WORDS = /데이터베이스|웹훅|마이그레이션|스키마|쿼리|캐시|파싱|서버 액션|프리페치|\bAPI\b|JSON|Supabase|Prisma|Vercel|webhook|payload|\bDB\b|\b(PENDING|PAID|REFUNDED|CANCELED|CANCELLED|BOOKED|IN_PROGRESS|HELD|SUCCEEDED|ACTIVE|FAILED|COMPLETED|RUNNING|INSTRUCTOR|DRIVER|VICE_ADMIN|ADMIN|PARENT)\b|Solapi|Rallyz|\bnull\b|undefined|\bID\b|[Cc]ron|크론|토큰|에러 코드|디버그|TODO|테스트용/;
// 판단 보류(기능 변경이 필요한 입력칸) — 갚아야 할 빚. 늘리지 말 것.
const ALLOW = [/^연결 (프로그램|정규 반) ID$/, /^기존 프로그램 ID \(선택\)$/, /^수강·출석에 연결할 반 ID/];
test('관리자 화면 문구에 개발 용어·영어 상태값이 다시 나오지 않는다', () => {
  const found = [];
  for (const path of adminFiles) {
    if (path.endsWith('adminDisplayText.ts')) continue;
    const sf = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node, hidden) => {
      if (ts.isCallExpression(node) && /^console\./.test(node.expression.getText(sf))) hidden = true;
      if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.expression.getText(sf) === 'Error') hidden = true;
      const isText = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node);
      if (isText && !hidden) {
        const value = (ts.isJsxText(node) ? node.getText(sf) : node.text).trim();
        if (/[가-힣]/.test(value) && DEV_WORDS.test(value) && !ALLOW.some(rule => rule.test(value))) found.push(`${path}: ${value.slice(0, 80)}`);
      }
      ts.forEachChild(node, child => visit(child, hidden));
    };
    visit(sf, false);
  }
  assert.deepEqual(found, []);
});

test('대표 화면의 영어 코드·내부 번호 표시는 한국어 이름으로 바뀌었다', () => {
  const import_ = read('src/app/admin/import/ImportClient.tsx');
  assert.doesNotMatch(import_, /\{batch\.status\}/);
  assert.match(import_, /COMPLETED: "완료"/);
  const media = read('src/app/admin/media-revocations/page.tsx');
  assert.doesNotMatch(media, /\{job\.channel\}|리소스: \{job\.resourceId\}/);
  assert.match(media, /GALLERY: "갤러리", INSTAGRAM: "인스타그램"/);
  const kakao = read('src/app/admin/kakao-requests/KakaoRequestsClient.tsx');
  assert.doesNotMatch(kakao, /JSON\.stringify\(row\.structuredJson/);
  assert.match(kakao, /readableDetails\(row\.structuredJson, classes\)/);
  const finance = read('src/app/admin/finance/FinanceClient.tsx');
  assert.match(finance, /SPECIAL: "특강"/);
  assert.match(finance, /MANUAL: "직접 처리"/);
  assert.doesNotMatch(read('src/app/admin/students/[id]/StudentDetailClient.tsx'), /\$\{p\.method\} · /);
  assert.doesNotMatch(read('src/app/admin/settings/AdminSettingsClient.tsx'), />PREVIEW<|Instagram Business Account ID/);
  assert.doesNotMatch(read('src/app/admin/staff/StaffClient.tsx'), /\((INSTRUCTOR|DRIVER)\)/);
  assert.doesNotMatch(read('src/app/admin/sms/SmsClient.tsx'), /배치 번호 \{batch\.batchId\}/);
  assert.doesNotMatch(read('src/app/admin/finance/monthly-ledger/MonthlyLedgerClient.tsx'), /기록 ID: \{payment\.id\}/);
});
