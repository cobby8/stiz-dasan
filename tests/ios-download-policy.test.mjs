// Swift/UIKit 실행 검사가 아닌 소스 경계 회귀 검사. 실제 기기·네이티브 컴파일은 별도다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const view = readFileSync(new URL('../apps/stiz-ios/STIZ/WebViewController.swift', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../apps/stiz-ios/STIZ/NavigationPolicy.swift', import.meta.url), 'utf8');
const fixtures = readFileSync(new URL('../apps/stiz-ios/tools/NavigationPolicyTests.swift', import.meta.url), 'utf8');
const download = view.slice(view.indexOf('private final class NativeFileDownloads'));

test('다운로드 전환은 메인 프레임·사용자 링크와 현재 HTTPS 원점의 기존 WK 요청만 사용한다', () => {
  assert.match(view, /navigationAction\.sourceFrame\.isMainFrame,[\s\S]*?navigationAction\.targetFrame\?\.isMainFrame != false,[\s\S]*?navigationAction\.navigationType == \.linkActivated/);
  assert.match(view, /navigationAction\.shouldPerformDownload/);
  assert.equal((view.match(/didBecome download: WKDownload/g) ?? []).length, 2);
  assert.match(download, /download\.originalRequest\?\.url == target/);
  assert.match(policy, /url\.host\?\.lowercased\(\) == page\.host\?\.lowercased\(\)/);
  assert.match(policy, /\(url\.port \?\? 443\) == \(page\.port \?\? 443\)/);
  assert.doesNotMatch(download, /URLSession\(|shared\.data|HTTPCookie|URLCredential\(|\.load\(|webView\.isHidden|localizedDescription|print\(|NSLog\(/);
});

test('MIME·확장자·파일명·양수의 알려진 길이를 제한하고 위험 형식의 반례를 보존한다', () => {
  assert.match(policy, /maximumBytes: Int64 = 10 \* 1024 \* 1024/);
  assert.match(policy, /length > 0, length <= maximumBytes/);
  assert.match(policy, /parts\.count == 2/);
  assert.match(download, /response\.mimeType/);
  assert.match(download, /length: response\.expectedContentLength/);
  assert.match(download, /statusCode == 200/);
  assert.match(download, /Content-Encoding[\s\S]*?== "identity"/);
  for (const value of ['sample.html', 'sample.js', 'sample.exe', 'sample.zip', 'sample.xlsx', 'sample.html.png', 'blob:https:', 'data:image/png']) assert.ok(fixtures.includes(value));
  assert.match(policy, /filename\.unicodeScalars\.allSatisfy/);
  assert.match(policy, /filename == filename\.precomposedStringWithCanonicalMapping/);
});

test('수신 중 Progress와 디스크 크기를 감시하고 완료한 파일도 다시 검증한다', () => {
  assert.match(download, /progress\.observe\(\\\.completedUnitCount/);
  assert.match(download, /download\.progress\.completedUnitCount > DownloadPolicy\.maximumBytes/);
  assert.match(download, /Int64\(actual\) > DownloadPolicy\.maximumBytes/);
  assert.match(download, /Int64\(size\) == declaredLength/);
  assert.match(download, /DownloadPolicy\.contentMatches\(bytes, mime: mime\)/);
  assert.match(download, /values\.isRegularFile == true, values\.isSymbolicLink == false/);
  assert.match(download, /file\.resolvingSymlinksInPath\(\) == file\.standardizedFileURL/);
});

test('모든 리디렉션을 거부하고 OS 기본 인증서 검증을 유지한다', () => {
  const redirect = download.slice(download.indexOf('willPerformHTTPRedirection'), download.indexOf('didReceive challenge:'));
  assert.match(redirect, /decisionHandler\(\.cancel\)/);
  assert.doesNotMatch(redirect, /decisionHandler\(\.allow\)/);
  assert.match(download, /completionHandler\(\.performDefaultHandling, nil\)/);
  assert.doesNotMatch(view, /serverTrust|NSAllowsArbitraryLoads|NSAppTransportSecurity/);
});

test('단일 작업·취소 세대·공유 완료와 화면 이탈의 임시 파일 정리 경계를 유지한다', () => {
  assert.match(download, /guard !isBusy, owner\?\.presentedViewController == nil/);
  assert.match(download, /self\.generation == token/);
  assert.match(download, /generation = UUID\(\)/);
  assert.match(download, /UIActivityViewController\(activityItems: \[file\]/);
  assert.match(download, /completionWithItemsHandler[\s\S]*?finishCleanup\(message: nil\)/);
  assert.match(download, /self\?\.sharing == false \{ self\?\.cancel\(nil\) \}/);
  assert.match(download, /directory\.deletingLastPathComponent\(\) == base/);
  assert.match(download, /UUID\(uuidString: directory\.lastPathComponent\) != nil/);
  assert.match(download, /value\.isRegularFile == true, value\.isSymbolicLink == false/);
  assert.match(download, /purgeOldFiles\(\)/);
  assert.match(view, /let allowed = approve\(navigationAction\)\s*if allowed \{ fileDownloads\.cancelForPageExit\(\) \}/);
  assert.match(view, /let downloads = fileDownloads\s*Task \{ @MainActor in downloads\?\.shutdown\(\) \}/);
  assert.doesNotMatch(view, /fileDownloads\?\.shutdown\(\)/);
  assert.doesNotMatch(download, /resumeData\s*=|write\(resumeData|UserDefaults|Documents|createDirectory[^\n]*withIntermediateDirectories: true/);
});
