import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const css = await readFile('src/components/shuttle/DriverGpsIndicator.module.css', 'utf8');
const classNames = Object.fromEntries([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => [match[1], match[1]]));
function compile(source, customRequire = require) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(customRequire, loaded, loaded.exports);
  return loaded.exports.default;
}
// 상세창은 가짜 컴포넌트로 치환하지 않고 기존 GPS 안내를 실제 렌더링한다.
const GpsShareBar = compile(await readFile('src/components/shuttle/GpsShareBar.tsx', 'utf8'));
const DriverGpsIndicator = compile(await readFile('src/components/shuttle/DriverGpsIndicator.tsx', 'utf8'), (id) => {
  if (id === './GpsShareBar') return { default: GpsShareBar };
  if (id === './DriverGpsIndicator.module.css') return { default: classNames };
  return require(id);
});
function render(values = {}) {
  return renderToStaticMarkup(React.createElement(DriverGpsIndicator, {
    gpsState: 'active', lastSentAt: new Date(), accuracy: 8, transmission: 'sent', mode: 'web', ...values,
  }));
}
function headerButton(html) { return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/)?.[0] ?? ''; }
function buttonText(html) { return headerButton(html).replace(/<[^>]*>/g, ''); }

test('정상 위치 공유는 한 개의 작은 아이콘과 접근 가능한 상태 설명을 표시한다', () => {
  const html = render();
  assert.match(headerButton(html), /class="trigger active"/);
  assert.equal(buttonText(html), 'my_location');
  assert.match(headerButton(html), /aria-label="위치 공유 중 · 위치 공유 상세 보기"/);
  assert.match(html, /class="srOnly" role="status">위치 공유 중/);
  assert.doesNotMatch(html, /role="alert"/);
});
test('권한 거부는 정상 아이콘 대신 권한 확인과 경고를 표시한다', () => {
  const html = render({ gpsState: 'denied', onRetry() {} });
  assert.match(headerButton(html), /trigger error/);
  assert.match(buttonText(html), /location_disabled권한 확인/);
  assert.match(html, /role="alert">위치 권한을 허용해 주세요/);
  assert.match(html, /위치 연결 다시 시도/);
});
test('기기 위치 오류는 전송 오류와 구분한다', () => {
  const html = render({ gpsState: 'error', transmission: 'idle', onRetry() {} });
  assert.match(buttonText(html), /위치 확인/);
  assert.match(headerButton(html), /기기 위치를 확인해 주세요/);
  assert.match(html, /위치를 가져오지 못했습니다/);
});
test('전송 실패는 마지막 정상 접수를 보존하고 전송 확인을 표시한다', () => {
  const html = render({ transmission: 'error' });
  assert.match(buttonText(html), /전송 확인/);
  assert.match(headerButton(html), /위치 전송 실패/);
  assert.match(html, /role="alert"/);
  assert.match(html, /마지막 서버 접수/);
  assert.match(html, /다음 전송에서 재시도합니다/);
});
test('접수 29초는 정상이고 31초는 위치 지연으로 표시한다', () => {
  const now = Date.now();
  assert.equal(buttonText(render({ lastSentAt: new Date(now - 29_000) })), 'my_location');
  const stale = render({ lastSentAt: new Date(now - 31_000) });
  assert.match(buttonText(stale), /location_searching위치 지연/);
  assert.match(headerButton(stale), /trigger warning/);
  assert.match(stale, /30초 이상 지났습니다/);
  assert.doesNotMatch(stale, /role="alert"/);
});
test('최초 권한·위치 요청 대기는 오류로 처리하지 않는다', () => {
  const html = render({ gpsState: 'requesting', lastSentAt: null, transmission: 'idle' });
  assert.match(buttonText(html), /위치 대기/);
  assert.match(headerButton(html), /trigger warning/);
  assert.doesNotMatch(html, /role="alert"/);
});
test('기기 위치를 얻어도 서버 최초 접수 전에는 정상 공유로 표시하지 않는다', () => {
  const html = render({ lastSentAt: null, transmission: 'sending' });
  assert.match(buttonText(html), /위치 대기/);
  assert.match(html, /GPS 위치 획득 · 서버 접수 대기/);
  assert.match(html, /위치 전송 중/);
});
test('오래된 접수가 있어도 공유 꺼짐은 지연으로 표시하지 않는다', () => {
  const html = render({ gpsState: 'off', transmission: 'idle', lastSentAt: new Date(Date.now() - 90_000) });
  assert.equal(buttonText(html), 'location_off');
  assert.match(headerButton(html), /trigger neutral/);
  assert.match(headerButton(html), /위치 공유 꺼짐/);
  assert.doesNotMatch(html, /30초 이상|위치 지연/);
});
test('수집 중단 후 서버 확인 중인 상태는 위치 대기·지연과 구분한다', () => {
  const html = render({ gpsState: 'off', transmission: 'stopping', lastSentAt: new Date(Date.now() - 90_000) });
  assert.match(buttonText(html), /location_off중단 중/);
  assert.match(headerButton(html), /위치 공유 중단 확인 중/);
  assert.match(html, /서버 중단 접수 확인 중/);
  assert.doesNotMatch(html, /30초 이상|위치 대기/);
});
test('중단 완료는 이전 active 상태가 남아도 정상 공유 아이콘을 표시하지 않는다', () => {
  const html = render({ transmission: 'stopped' });
  assert.equal(buttonText(html), 'location_off');
  assert.match(headerButton(html), /trigger neutral/);
  assert.match(headerButton(html), /위치 공유 중단 완료/);
  assert.match(html, /서버 중단 접수 완료/);
});
test('중단 미확인은 수집 중단과 서버 확인 필요를 동시에 보존한다', () => {
  const html = render({ gpsState: 'off', transmission: 'stop-unknown', lastSentAt: new Date(Date.now() - 90_000) });
  assert.match(buttonText(html), /location_disabled중단 확인/);
  assert.match(html, /role="alert">공유 중단 확인 필요/);
  assert.match(html, /기기 위치 수집은 중단됨 · 서버 공유 중단은 확인 필요/);
  assert.doesNotMatch(html, /30초 이상/);
});
test('기존 상세창의 정확도·서버 접수 시간과 웹 중단 제약을 보존한다', () => {
  const html = render();
  assert.match(html, /마지막 서버 접수/);
  assert.match(html, /정확도 8m/);
  assert.match(html, /웹에서는 화면 잠금·다른 앱 이동 시 위치 공유가 멈출 수 있습니다/);
  assert.doesNotMatch(html, /화면을 끄거나 길안내 앱으로 이동해도 위치 공유를 계속합니다/);
});
test('네이티브 앱 상세창은 백그라운드 공유와 종료 시 중단을 안내한다', () => {
  const html = render({ mode: 'native' });
  assert.match(html, /화면을 끄거나 길안내 앱으로 이동해도 위치 공유를 계속합니다/);
  assert.match(html, /운행 종료 시 수집을 멈춥니다/);
  assert.doesNotMatch(html, /웹에서는 화면 잠금/);
});
test('네이티브 대기 사유와 앱 권한 설정 안내를 보존한다', () => {
  const waiting = render({ mode: 'native', gpsState: 'requesting', lastSentAt: null, nativeMessage: '위치 갱신이 지연되고 있습니다.' });
  assert.match(headerButton(waiting), /위치 갱신이 지연되고 있습니다/);
  const denied = render({ mode: 'native', gpsState: 'denied', onRetry() {} });
  assert.match(denied, /앱 설정에서 허용해주세요/);
  assert.doesNotMatch(denied, /브라우저 설정/);
});
test('native dialog와 제목 연결·닫기 버튼·자동 초점 마크업을 제공한다', () => {
  const html = render();
  const labelledBy = html.match(/<dialog[^>]*aria-labelledby="([^"]+)"/)?.[1];
  assert.ok(labelledBy);
  assert.ok(html.includes(`<h2 id="${labelledBy}">위치 공유 상태</h2>`));
  assert.match(headerButton(html), /aria-haspopup="dialog"/);
  assert.match(html, /<button[^>]*autofocus=""[^>]*aria-label="위치 공유 상세 닫기"/);
  assert.doesNotMatch(html, /<dialog[^>]*\sopen(?:=|\s|>)/);
});
test('CSS는 트리거·닫기·기존 상세 재시도 버튼에 최소 44px을 지정한다', () => {
  assert.match(css, /\.trigger, \.close\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/);
  assert.match(css, /\.details button\s*\{[^}]*min-width:\s*44px;[^}]*min-height:\s*44px;/);
});
test('CSS는 좁은 가로 화면에서 viewport 경계와 상세 스크롤을 제공한다', () => {
  assert.match(css, /max-width:\s*calc\(100vw - 24px\)/);
  assert.match(css, /max-height:\s*calc\(100dvh - 24px\)/);
  assert.match(css, /\.dialog\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /:focus-visible[^}]*outline:\s*3px solid var\(--color-academy-primary\)/);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i);
});
