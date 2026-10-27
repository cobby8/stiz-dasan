// 정적 보안 회귀 검사다. Swift 컴파일과 실제 Web Inspector 연결은 별도 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../apps/stiz-ios/STIZ/WebViewController.swift', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../apps/stiz-ios/STIZ/NavigationPolicy.swift', import.meta.url), 'utf8');

function availabilityBlock(text) {
  const marker = 'if #available(iOS 16.4, *) {';
  const start = text.indexOf(marker);
  assert.ok(start >= 0, 'iOS 16.4 API 사용 가능 여부 검사가 필요하다');
  let depth = 1;
  for (let i = start + marker.length; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  assert.fail('API 사용 가능 여부 검사 블록이 닫히지 않았다');
}

test('검사 연결 설정은 iOS 16.4 이후 블록과 WebView 생성 이후에만 있다', () => {
  const block = availabilityBlock(source);
  const assignments = source.match(/webView\.isInspectable\s*=/g) ?? [];
  assert.equal(assignments.length, 2);
  assert.equal((block.match(/webView\.isInspectable\s*=/g) ?? []).length, assignments.length);
  assert.ok(source.indexOf(block) > source.indexOf('webView = WKWebView('));
});

test('Release 전처리에서 검사 연결을 켜는 분기가 남지 않는다', () => {
  const block = availabilityBlock(source);
  const release = block.replace(/#if DEBUG\b[\s\S]*?#endif/g, '');
  assert.deepEqual([...release.matchAll(/webView\.isInspectable\s*=\s*([^\n]+)/g)].map(m => m[1].trim()), ['false']);
  assert.equal(release.includes('NavigationPolicy.sandbox'), false);
});

test('Debug도 disabled·invalid 주소에서는 검사 연결을 허용하지 않는다', () => {
  const block = availabilityBlock(source);
  const debug = block.match(/#if DEBUG\b([\s\S]*?)#endif/)?.[1];
  assert.ok(debug, 'Debug 전용 분기가 필요하다');
  assert.match(debug, /webView\.isInspectable\s*=\s*NavigationPolicy\.sandbox\.origin\s*!=\s*nil\s*$/m);
  assert.doesNotMatch(block, /isInspectable\s*=\s*true\b|isInspectable\s*=\s*NavigationPolicy\.sandbox\.isRequested/);
  // isRequested는 invalid에도 true이므로 active origin의 존재를 사용해야 한다.
  assert.match(policy, /var origin: URL\?\s*\{\s*if case \.active\(let value\) = self \{ return value \}; return nil \}/);
});
