import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const read = path => readFileSync(path, 'utf8');
function compile(source) {
  const result = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result)(require, module, module.exports);
  return module.exports;
}
const display = compile(read('src/lib/application-display-format.ts'));
test('전화번호 표시 통합은 기존 두 화면의 빈값·경계 길이·혼합 문자 표시를 보존한다', () => {
  const examples = [['',''], ['1','1'], ['010','010'], ['0101','010-1'], ['0101234','010-1234'], ['01012345','010-1234-5'], ['01012345678','010-1234-5678'], ['010123456789999','010-1234-5678'], ['abc010-1234-5678 한글','010-1234-5678']];
  for (const [input, expected] of examples) assert.equal(display.formatPhoneInput(input), expected);
  for (const path of ['src/app/admin/apply/ApplyAdminModals.tsx','src/app/admin/trial/TrialCrmModals.tsx']) {
    assert.doesNotMatch(read(path), /function formatPhoneInput\(/);
    assert.match(read(path), /import \{[^}]*formatPhoneInput[^}]*\} from "@\/lib\/application-display-format"/);
  }
});
test('수업 표시 통합은 알려진 요일·미등록 요일·프로그램 빈값의 기존 표시를 보존한다', () => {
  for (const [dayOfWeek, expectedDay] of [['Mon','월'],['Sun','일'],['미정','미정'],['','']]) {
    for (const program of [undefined,null,{name:''},{name:'성장반'}]) {
      const value = { dayOfWeek, startTime:'15:00',endTime:'16:00',name:'합성 반',program };
      assert.equal(display.formatClassLabel(value), expectedDay+' 15:00~16:00 · 합성 반'+(program?.name ? ' · 성장반' : ''));
    }
  }
  for (const path of ['src/app/admin/apply/ApplyAdminClient.tsx','src/app/admin/apply/ApplyAdminModals.tsx']) {
    assert.doesNotMatch(read(path), /function formatClassLabel\(/);
    assert.match(read(path), /import \{[^}]*formatClassLabel[^}]*\} from "@\/lib\/application-display-format"/);
  }
});
test('공통 특강 헤더는 부제가 없으면 빈 문단도 만들지 않고 명시된 안내는 표시한다', () => {
  const Header = compile(read('src/app/admin/seasonal/SeasonalHeader.tsx')).default;
  const plain = renderToStaticMarkup(React.createElement(Header));
  assert.equal((plain.match(/<p\b/g)||[]).length, 1);
  assert.doesNotMatch(plain, /모집부터|한곳에서/);
  const explicit = renderToStaticMarkup(React.createElement(Header,{subtitle:'확인해야 할 안내'}));
  assert.match(explicit, /확인해야 할 안내/);
});
test('정규·특강 결석 안내는 자동 배차 제외를 약속하지 않고 전달 범위를 명확히 한다', () => {
  const home = read('src/app/mypage/MyPageClient.tsx');
  const absence = read('src/app/mypage/regular-absence/RegularAbsenceClient.tsx');
  assert.equal((home.match(/신고한 결석은 선생님과 기사님에게 표시됩니다/g)||[]).length, 2);
  assert.match(absence, /신고한 결석은 선생님과 기사님에게 표시됩니다/);
  assert.doesNotMatch(home, /그날 셔틀 배차에서 자동 제외돼요|그날 셔틀에서도 자동으로 빠집니다/);
  assert.doesNotMatch(absence, /다음 단계에서 연동 예정|자동으로 제외되도록 준비 중/);
});
test('접수함은 내부 처리 코드를 안내하지 않고 외부 변경·발송 보류를 보존한다', () => {
  const source=read('src/app/admin/kakao-requests/KakaoRequestsClient.tsx');
  assert.match(source, /외부 서비스 반영과 알림 발송은 별도 승인 전까지 보류됩니다/);
  assert.doesNotMatch(source, /승인 대기\(PENDING\)|별도 승인 전 HELD|새 migration 적용|관리자 검토용 DB 적용/);
  assert.match(source, /KIND_LABEL\[row.kind\] \?\? "기타 문의"/);
});
