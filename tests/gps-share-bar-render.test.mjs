import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// 실제 TSX를 React로 렌더링해 사용자가 읽는 안내 조합을 검증한다.
const source = await readFile('src/components/shuttle/GpsShareBar.tsx', 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = { exports: {} };
new Function('require', 'module', 'exports', compiled)(createRequire(import.meta.url), loaded, loaded.exports);
const GpsShareBar = loaded.exports.default;
function render(values = {}) {
  return renderToStaticMarkup(React.createElement(GpsShareBar, {
    mode: 'native', gpsState: 'requesting', lastSentAt: null, accuracy: null, transmission: 'idle', ...values,
  }));
}

test('최초 기기 위치 대기는 오류나 권한 거부로 표시하지 않는다', () => {
  const html = render();
  assert.match(html, /새 기기 위치를 기다리는 중/);
  assert.doesNotMatch(html, /role="alert"|가져오지 못|전송 확인 필요|권한 요청 중/);
});
test('갱신 지연은 기기 안내를 그대로 표시하고 마지막 접수도 유지한다', () => {
  const html = render({ nativeMessage: '위치 갱신이 지연되고 있습니다.', lastSentAt: new Date(Date.now() - 60_000), accuracy: 9 });
  assert.match(html, /위치 갱신이 지연되고 있습니다/);
  assert.match(html, /마지막 서버 접수/);
  assert.match(html, /현재 위치는 확인이 필요/);
  assert.doesNotMatch(html, /가져오지 못|role="alert"/);
});
test('실제 전송 실패는 구체적인 원인과 마지막 정상 접수를 함께 표시한다', () => {
  const html = render({ gpsState: 'error', transmission: 'error', nativeMessage: '서버 연결에 실패했습니다.', lastSentAt: new Date() });
  assert.match(html, /role="alert"/);
  assert.match(html, /서버 연결에 실패했습니다/);
  assert.match(html, /마지막 서버 접수/);
  assert.match(html, /다음 전송에서 재시도/);
  assert.doesNotMatch(html, /가져오지 못|위치 공유 중/);
  assert.equal((html.match(/서버 연결에 실패했습니다/g) || []).length, 1);
});
test('기기 원인 메시지가 없어도 전송 실패를 정상 공유로 표시하지 않는다', () => {
  const html = render({ gpsState: 'active', transmission: 'error', lastSentAt: new Date() });
  assert.match(html, /위치 전송을 확인해 주세요/);
  assert.doesNotMatch(html, /위치 공유 중/);
});
test('정상 접수는 접수 시간과 정확도를 표시한다', () => {
  const html = render({ gpsState: 'active', transmission: 'sent', lastSentAt: new Date(), accuracy: 8 });
  assert.match(html, /위치 공유 중/);
  assert.match(html, /마지막 서버 접수/);
  assert.match(html, /정확도 8m/);
  assert.doesNotMatch(html, /role="alert"|가져오지 못/);
});
test('네이티브 권한 오류는 앱 설정을 안내하고 재시도 버튼을 유지한다', () => {
  const html = render({ gpsState: 'denied', onRetry() {} });
  assert.match(html, /앱 설정에서 허용/);
  assert.match(html, /위치 연결 다시 시도/);
  assert.doesNotMatch(html, /브라우저 설정/);
});
test('웹 위치 오류·재시도와 백그라운드 제약 안내는 유지한다', () => {
  assert.match(render({ mode: 'web', gpsState: 'error', onRetry() {} }), /위치를 가져오지 못했습니다/);
  assert.match(render({ mode: 'web', gpsState: 'denied' }), /브라우저 설정/);
  const html = render({ mode: 'web', gpsState: 'active', transmission: 'sending' });
  assert.match(html, /위치 전송 중/);
  assert.match(html, /다른 앱 이동 시 위치 공유가 멈출 수/);
});
test('중단 확인 중과 미확인은 접수 이력을 보존하되 갱신 지연과 혼동하지 않는다', () => {
  for (const transmission of ['stopping', 'stopped', 'stop-unknown']) {
    const html = render({ gpsState: 'off', transmission, lastSentAt: new Date(Date.now() - 90_000) });
    assert.match(html, /마지막 서버 접수/);
    assert.match(html, /기기 위치 수집/);
    assert.doesNotMatch(html, /현재 위치는 확인이 필요|30초 이상/);
  }
});
