import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { inspectReadiness, SOURCE_FILES, ALLOWED_PATHS } from '../scripts/native-release-readiness.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'stiz-readiness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => { const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); };
  const sources = {
    vercel: JSON.stringify({ git: { deploymentEnabled: { 'codex/stiz-app-codemagic': false } } }),
    codemagic: 'triggering:\n  events: []\nscript: xcodebuild -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO',
    android: "targetSdk 36\ndebug { buildConfigField 'boolean', 'STIZ_NATIVE_AUTH', providers.gradleProperty('stizNativeAuth').getOrElse('false') }\nrelease { buildConfigField 'boolean', 'STIZ_NATIVE_AUTH', 'false' }",
    manifest: '<manifest><application/></manifest>', debugManifest: '<manifest><application>stiz-academy-android-dev</application></manifest>',
    iosInfo: '<key>STIZNativeAuthDevelopmentEnabled</key><false/>',
    iosProject: 'PRODUCT_BUNDLE_IDENTIFIER = kr.stiz.academy.dev; CODE_SIGNING_ALLOWED = NO;',
    authPolicy: 'if (env.NATIVE_AUTH_ENABLED !== "true" || env.NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED !== "true" || env.NODE_ENV === "production") throw new Error();',
  };
  for (const [key, value] of Object.entries(sources)) put(SOURCE_FILES[key], value);
  return { root, put };
}
const item = (report, id) => report.checks.find(x => x.id === id);

test('정상 기본 차단값도 실제 출시 가능으로 승격하지 않는다', t => {
  const { root } = fixture(t); const report = inspectReadiness(root);
  assert.equal(report.localSafetyPassed, true);
  assert.equal(report.releaseDecision, 'NOT_ESTABLISHED');
  assert.equal(item(report, 'ios-device-build').status, 'BLOCKED');
  assert.equal(item(report, 'four-role-device-tests').status, 'UNVERIFIED');
});
test('누락·잘못된 JSON은 배포 차단 통과가 아니다', t => {
  const { root, put } = fixture(t);
  put(SOURCE_FILES.vercel, '{bad');
  assert.equal(item(inspectReadiness(root), 'verification-branch-deploy').status, 'BLOCKED');
  rmSync(join(root, SOURCE_FILES.authPolicy));
  const report = inspectReadiness(root);
  assert.equal(report.localSafetyPassed, false);
  assert.ok(report.unavailableSources.includes(SOURCE_FILES.authPolicy));
});
test('자동 배포·원격 발행·인증 기본 활성 변경은 로컬 안전 차단 실패', t => {
  const { root, put } = fixture(t);
  put(SOURCE_FILES.vercel, JSON.stringify({ git: { deploymentEnabled: true } }));
  put(SOURCE_FILES.codemagic, 'events: [push]\npublishing:\n  app_store_connect: yes');
  put(SOURCE_FILES.iosInfo, '<key>STIZNativeAuthDevelopmentEnabled</key><true/>');
  const report = inspectReadiness(root);
  for (const id of ['verification-branch-deploy', 'codemagic-manual-unsigned', 'ios-auth-default-off']) assert.equal(item(report, id).status, 'BLOCKED');
});
test('시험 activity나 개발 복귀 주소가 main에 들어오면 경고한다', t => {
  const { root, put } = fixture(t);
  put(SOURCE_FILES.manifest, '<activity android:name=".AttachmentFixtureActivity"/>');
  assert.equal(item(inspectReadiness(root), 'debug-callback-isolation').status, 'BLOCKED');
});
test('APK 내용·임의 비밀 파일을 읽거나 결과로 내보내지 않는다', t => {
  const { root, put } = fixture(t); const secret = 'TEST_ONLY_DO_NOT_REPORT_51';
  put('.env.local', secret); put('AuthKey_TEST.p8', secret);
  put('apps/driver-android/app/build/outputs/apk/debug/app-debug.apk', secret);
  const report = inspectReadiness(root);
  assert.equal(item(report, 'android-install-artifact').status, 'UNVERIFIED');
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(readFileSync(join(root, '.env.local'), 'utf8'), secret);
  assert.ok(ALLOWED_PATHS.every(x => !/\.env|\.p8|\.p12|mobileprovision/.test(x)));
});
test('허용된 설정 파일도 심볼릭 링크면 읽지 않는다', t => {
  const { root, put } = fixture(t);
  put('private-data', 'SECRET_NOT_OUTPUT');
  rmSync(join(root, SOURCE_FILES.vercel));
  try { symlinkSync(join(root, 'private-data'), join(root, SOURCE_FILES.vercel)); }
  catch (error) { if (error.code === 'EPERM') { t.skip('이 OS에서 심볼릭 링크 권한 없음'); return; } throw error; }
  const report = inspectReadiness(root);
  assert.ok(report.unavailableSources.includes(SOURCE_FILES.vercel));
  assert.equal(JSON.stringify(report).includes('SECRET_NOT_OUTPUT'), false);
});
test('크기 제한 초과와 디렉터리를 설정 파일로 취급하지 않는다', t => {
  const { root, put } = fixture(t);
  put(SOURCE_FILES.android, 'x'.repeat(1_000_001));
  rmSync(join(root, SOURCE_FILES.iosInfo));
  mkdirSync(join(root, SOURCE_FILES.iosInfo));
  const report = inspectReadiness(root);
  assert.ok(report.unavailableSources.includes(SOURCE_FILES.android));
  assert.ok(report.unavailableSources.includes(SOURCE_FILES.iosInfo));
  assert.equal(report.localSafetyPassed, false);
});
test('아이콘 목록 파일 존재는 아이콘 검증 통과가 아니다', t => {
  const { root, put } = fixture(t);
  put('apps/stiz-ios/STIZ/Assets.xcassets/AppIcon.appiconset/Contents.json', '{}');
  assert.equal(item(inspectReadiness(root), 'ios-store-icon').status, 'UNVERIFIED');
});
test('두 번째 workflow가 자동 실행되면 첫 빈 events로 통과하지 않는다', t => {
  const { root, put } = fixture(t);
  put(SOURCE_FILES.codemagic, 'workflows:\n  manual:\n    triggering:\n      events: []\n    script: xcodebuild -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO\n  unexpected-auto:\n    triggering:\n      events: [push]');
  assert.equal(item(inspectReadiness(root), 'codemagic-manual-unsigned').status, 'BLOCKED');
});
test('XML 주석의 false와 실제 true 또는 중복 키는 통과하지 않는다', t => {
  const { root, put } = fixture(t);
  const off = '<key>STIZNativeAuthDevelopmentEnabled</key><false/>';
  const on = '<key>STIZNativeAuthDevelopmentEnabled</key><true/>';
  put(SOURCE_FILES.iosInfo, `<!--${off}-->${on}`);
  assert.equal(item(inspectReadiness(root), 'ios-auth-default-off').status, 'BLOCKED');
  put(SOURCE_FILES.iosInfo, off + on);
  assert.equal(item(inspectReadiness(root), 'ios-auth-default-off').status, 'BLOCKED');
});
test('주석으로만 남은 Android·서버 차단 조건은 통과하지 않는다', t => {
  const { root, put } = fixture(t);
  const original = readFileSync(join(root, SOURCE_FILES.android), 'utf8');
  put(SOURCE_FILES.android, `/* ${original} */\nrelease { buildConfigField 'boolean', 'STIZ_NATIVE_AUTH', 'true' }`);
  put(SOURCE_FILES.authPolicy, '// if (env.NATIVE_AUTH_ENABLED !== "true" || env.NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED !== "true" || env.NODE_ENV === "production") throw new Error();\nreturn {};');
  const report = inspectReadiness(root);
  assert.equal(item(report, 'android-auth-default-off').status, 'BLOCKED');
  assert.equal(item(report, 'server-production-auth-block').status, 'BLOCKED');
});
test('중복 JSON 차단 키와 주석에만 있는 수동 실행 설정은 통과하지 않는다', t => {
  const { root, put } = fixture(t);
  put(SOURCE_FILES.vercel, '{"git":{"deploymentEnabled":{"codex/stiz-app-codemagic":true,"codex/stiz-app-codemagic":false}}}');
  put(SOURCE_FILES.codemagic, '# triggering:\n#   events: []\nscript: xcodebuild -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO');
  const report = inspectReadiness(root);
  assert.equal(item(report, 'verification-branch-deploy').status, 'BLOCKED');
  assert.equal(item(report, 'codemagic-manual-unsigned').status, 'BLOCKED');
});
test('main 매니페스트 누락·빈 파일은 개발 기능 분리 검증 통과가 아니다', t => {
  const { root, put } = fixture(t);
  rmSync(join(root, SOURCE_FILES.manifest));
  let report = inspectReadiness(root);
  assert.equal(item(report, 'debug-callback-isolation').status, 'BLOCKED');
  assert.equal(report.localSafetyPassed, false);
  put(SOURCE_FILES.manifest, '');
  report = inspectReadiness(root);
  assert.equal(item(report, 'debug-callback-isolation').status, 'BLOCKED');
  assert.equal(report.localSafetyPassed, false);
});
