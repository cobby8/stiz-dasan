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

const recoveryHelper = source.match(/#if DEBUG\s+(private func sandboxRecoveryMessage[\s\S]*?)#endif/)?.[1];

test('시험 안내 색은 유효한 Debug 시험 앱에서만 실제 재시도 버튼 색과 맞춘다', () => {
  const assignments = [...source.matchAll(/message\.textColor\s*=/g)];
  assert.equal(assignments.length, 1);
  assert.match(source, /retry\.tintColor = UIColor\(named: "AccentColor"\)\s*#if DEBUG\s*\/\/[^\n]*\n\s*if NavigationPolicy\.sandbox\.origin != nil \{ message\.textColor = retry\.tintColor \}\s*#endif/);
  const release = source.replace(/#if DEBUG\b[\s\S]*?#endif/g, '');
  assert.doesNotMatch(release, /message\.textColor\s*=/);
});

test('상세 오류 안내는 Debug의 유효한 시험 주소에만 한정된다', () => {
  assert.ok(recoveryHelper, '안내 선택 메서드는 Debug 전용이어야 한다');
  assert.match(recoveryHelper, /guard NavigationPolicy\.sandbox\.origin != nil else \{ return nil \}/);
  const release = source.replace(/#if DEBUG\b[\s\S]*?#endif/g, '');
  assert.doesNotMatch(release, /sandboxRecoveryMessage|시험 서버 연결이 보안 설정으로 차단/);
  assert.match(release, /message\.text = "화면을 불러오지 못했습니다\. 인터넷 연결을 확인해 주세요\."/);
});

test('오류 도메인과 코드는 허용 목록과 범위를 통과해야 표시된다', () => {
  assert.match(recoveryHelper, /guard failure\.domain == NSURLErrorDomain \|\| failure\.domain == WKErrorDomain,\s*\(-9999\.\.\.9999\)\.contains\(failure\.code\) else/);
  assert.match(recoveryHelper, /let category = failure\.domain == NSURLErrorDomain \? "NSURLErrorDomain" : "WKErrorDomain"/);
  // 원문/주소/설명/임의 도메인을 보간하면 인증 자료가 안내에 섞일 수 있다.
  assert.doesNotMatch(recoveryHelper, /userInfo|localizedDescription|absoluteString|String\(describing:|print\(|NSLog\(/);
  const interpolations = [...recoveryHelper.matchAll(/\\\(([^)]+)\)/g)].map(m => m[1]);
  assert.deepEqual(interpolations, ['guidance', 'category', 'failure.code']);
});

test('보안 설정·인증서·연결·웹 화면·프로세스 종료 안내를 구분한다', () => {
  assert.match(recoveryHelper, /case -1022:\s*guidance = "[^"\n]*보안 설정[^"\n]*"/);
  assert.match(recoveryHelper, /case -1200, -1202:\s*guidance = "[^"\n]*인증서[^"\n]*"/);
  assert.match(recoveryHelper, /case -1009, -1004, -1001:\s*guidance = "[^"\n]*Wi-Fi[^"\n]*"/);
  assert.match(recoveryHelper, /시험 웹 화면을 표시하지 못했습니다/);
  assert.match(recoveryHelper, /guard let failure = error as NSError\? else \{\s*return "시험 화면이 중단되었습니다/);
});

test('전환 취소 무시와 큰 글자·재시도 버튼 최소 크기를 유지한다', () => {
  const recover = source.slice(source.indexOf('private func recover(_ error: Error?)'));
  assert.ok(recover.indexOf('NSURLErrorCancelled') < recover.indexOf('sandboxRecoveryMessage(error)'));
  assert.match(recover, /NSURLErrorCancelled \{ progress\.stopAnimating\(\); return \}/);
  assert.match(recover, /#if DEBUG\s*if let guidance = sandboxRecoveryMessage\(error\) \{ message\.text = guidance \}\s*#endif/);
  assert.match(source, /retry\.heightAnchor\.constraint\(greaterThanOrEqualToConstant: 44\)/);
  assert.match(source, /message\.adjustsFontForContentSizeCategory = true/);
  assert.match(source, /retry\.titleLabel\?\.adjustsFontForContentSizeCategory = true/);
});
