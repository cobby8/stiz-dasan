/** 로컬 출처만 읽는 출시 준비 목록. 빌드·운영 설정·기기·키의 검증을 대신하지 않는다. */
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_FILES = Object.freeze({
  vercel: 'vercel.json',
  codemagic: 'codemagic.yaml',
  android: 'apps/driver-android/app/build.gradle',
  manifest: 'apps/driver-android/app/src/main/AndroidManifest.xml',
  debugManifest: 'apps/driver-android/app/src/debug/AndroidManifest.xml',
  iosInfo: 'apps/stiz-ios/STIZ/Info.plist',
  iosProject: 'apps/stiz-ios/STIZ.xcodeproj/project.pbxproj',
  authPolicy: 'src/lib/native-auth/policy.ts',
});
const PRESENCE_FILES = Object.freeze({
  iosIcon: 'apps/stiz-ios/STIZ/Assets.xcassets/AppIcon.appiconset/Contents.json',
  iosPrivacy: 'apps/stiz-ios/STIZ/PrivacyInfo.xcprivacy',
  androidDebug: 'apps/driver-android/app/build/outputs/apk/debug/app-debug.apk',
  androidUnsigned: 'apps/driver-android/app/build/outputs/apk/release/app-release-unsigned.apk',
});
export const ALLOWED_PATHS = Object.freeze([...Object.values(SOURCE_FILES), ...Object.values(PRESENCE_FILES)]);

// 실행하지 않고 주석만 제외한다. 인용 문자열 안의 URL(https://)은 보존한다.
function withoutCodeComments(text) {
  let result = ''; let quote = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; const next = text[i + 1];
    if (quote) {
      result += c;
      if (c === '\\') result += text[++i] ?? '';
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') { quote = c; result += c; }
    else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      result += '\n';
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) return '';
      result += ' '; i = end + 1;
    } else result += c;
  }
  return quote ? '' : result;
}
const occurrences = (text, pattern) => [...text.matchAll(pattern)].length;
const withoutXmlComments = text => text.replace(/<!--[\s\S]*?-->/g, '');

// 허용 경로라도 심볼릭 링크를 거치면 읽지 않는다. 인증 파일로 우회하는 것을 막는다.
function safePath(root, name) {
  if (!ALLOWED_PATHS.includes(name)) throw new Error('허용되지 않은 경로');
  const base = resolve(root);
  if (lstatSync(base).isSymbolicLink()) throw new Error('연결 경로 제외');
  let current = base;
  for (const part of name.split('/')) {
    current = join(current, part);
    const rel = relative(base, current);
    if (isAbsolute(rel) || rel.startsWith('..')) throw new Error('경로 범위 제외');
    if (lstatSync(current).isSymbolicLink()) throw new Error('연결 경로 제외');
  }
  if (!lstatSync(current).isFile()) throw new Error('일반 파일 아님');
  return current;
}

export function inspectReadiness(root) {
  const files = {};
  const unavailable = [];
  for (const [key, name] of Object.entries(SOURCE_FILES)) {
    try {
      const path = safePath(root, name);
      if (lstatSync(path).size > 1_000_000) throw new Error('크기 제한');
      files[key] = readFileSync(path, 'utf8');
    } catch { files[key] = ''; unavailable.push(name); }
  }
  const present = {};
  for (const [key, name] of Object.entries(PRESENCE_FILES)) {
    try { safePath(root, name); present[key] = true; } catch { present[key] = false; }
  }
  const checks = [];
  const add = (id, status, detail, scope = 'release') => checks.push({ id, status, scope, detail });
  const guard = (id, ok, detail) => add(id, ok ? 'PASS' : 'BLOCKED', detail, 'local-safety');
  let deploymentBlocked = false;
  try {
    // 중복 키·이스케이프 키처럼 의미가 모호한 JSON은 통과시키지 않는다.
    deploymentBlocked = !files.vercel.includes('\\') &&
      occurrences(files.vercel, /"git"\s*:/g) === 1 &&
      occurrences(files.vercel, /"deploymentEnabled"\s*:/g) === 1 &&
      occurrences(files.vercel, /"codex\/stiz-app-codemagic"\s*:/g) === 1 &&
      JSON.parse(files.vercel).git?.deploymentEnabled?.['codex/stiz-app-codemagic'] === false;
  } catch { /* 누락·손상은 차단 확인 실패다. */ }
  const yaml = files.codemagic.replace(/^\s*#.*$/gm, '');
  const eventLines = [...yaml.matchAll(/^\s*events\s*:(.*)$/gm)];
  const manualOnly = eventLines.length > 0 && eventLines.length === occurrences(yaml, /^\s*triggering\s*:/gm) &&
    eventLines.every(match => /^\s*\[\s*\]\s*(?:#.*)?$/.test(match[1]));
  const signingLines = [...yaml.matchAll(/CODE_SIGNING_ALLOWED\s*=\s*([^\s]+)/g)];
  const android = withoutCodeComments(files.android);
  const auth = withoutCodeComments(files.authPolicy);
  const info = withoutXmlComments(files.iosInfo);
  const mainManifest = withoutXmlComments(files.manifest);
  const debugManifest = withoutXmlComments(files.debugManifest);
  guard('verification-branch-deploy', deploymentBlocked, '검증 브랜치 자동 배포 차단값의 정적 확인. 현재 운영 배포 상태는 조회하지 않음.');
  guard('codemagic-manual-unsigned', manualOnly && signingLines.length > 0 && signingLines.every(match => match[1] === 'NO') && /-sdk iphonesimulator/.test(yaml) && !/^\s*(publishing|integrations):/m.test(yaml), '모든 events 선언이 빈 배열인지와 무서명 선언 확인. 복수·모호한 설정은 차단하며 YAML 전체 실행 의미 검증은 하지 않음.');
  guard('android-auth-default-off', occurrences(android, /'STIZ_NATIVE_AUTH'/g) === 2 && occurrences(android, /'stizNativeAuth'/g) === 1 && /stizNativeAuth'\)\.getOrElse\('false'\)/.test(android) && /release\s*\{[^}]*'STIZ_NATIVE_AUTH',\s*'false'/.test(android), '주석 제외 후 Android 개발 인증 기본 비활성·release 비활성 소스 확인. 실제 APK 설정은 미검증.');
  guard('ios-auth-default-off', occurrences(info, /<key>\s*STIZNativeAuthDevelopmentEnabled\s*<\/key>/g) === 1 && /<key>\s*STIZNativeAuthDevelopmentEnabled\s*<\/key>\s*<false\s*\/>/.test(info) && !/<!--|-->/.test(info), 'XML 주석 제외·해당 키 유일성·false 값 확인. 설치 앱 상태는 미검증.');
  guard('server-production-auth-block', occurrences(auth, /env\.NODE_ENV/g) === 1 && /if\s*\(\s*env\.NATIVE_AUTH_ENABLED\s*!==\s*["']true["']\s*\|\|\s*env\.NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED\s*!==\s*["']true["']\s*\|\|\s*env\.NODE_ENV\s*===\s*["']production["']\s*\)\s*(?:\{\s*)?throw\s+new\s+\w+/.test(auth), '주석 제외 후 세 차단 조건이 같은 if에서 거부하는지 정적 확인. 서버 코드를 실행하거나 환경 값을 읽지 않음.');
  guard('debug-callback-isolation', /<manifest\b/.test(mainManifest) && /<application\b/.test(mainManifest) && /<\/manifest>/.test(mainManifest) && /<manifest\b/.test(debugManifest) && /<application\b/.test(debugManifest) && /<\/manifest>/.test(debugManifest) && /stiz-academy-android-dev/.test(debugManifest) && !/stiz-academy-android-dev|AttachmentFixtureActivity/.test(mainManifest), 'main·debug 매니페스트 기본 구조와 개발 복귀 주소·시험 화면의 main 제외 확인. 최종 패키지 검사는 별도.');
  add('android-target', occurrences(android, /targetSdk\b/g) === 1 && /targetSdk\s+36\b/.test(android) ? 'PASS' : 'UNVERIFIED', 'targetSdk 36 선언의 정적 확인만 수행. 스토어 전체 요구 충족 의미 아님.', 'source');
  add('android-install-artifact', present.androidDebug ? 'UNVERIFIED' : 'BLOCKED', present.androidDebug ? 'debug APK 파일 존재만 확인. 무결성·서명·설치·실기기 동작 미검증.' : '예정 경로에 debug APK 없음. 이 도구는 빌드하지 않음.');
  add('android-release-package', 'UNVERIFIED', `배포용 최종 앱 ID·서명 확인 필요. unsigned APK 파일 ${present.androidUnsigned ? '존재' : '없음'}; 내용은 열지 않음.`);
  add('ios-device-build', 'BLOCKED', /kr\.stiz\.academy\.dev/.test(files.iosProject) && /CODE_SIGNING_ALLOWED\s*=\s*NO/.test(files.iosProject) ? '개발 ID·무서명 프로젝트. 시뮬레이터 zip은 아이폰 설치 파일이 아님. 승인된 Team·프로파일·서명 기기 빌드 필요.' : '프로젝트 설정이 기존 개발 ID·무서명 기준과 다름 또는 누락. 별도 검토 필요.');
  add('ios-store-icon', present.iosIcon ? 'UNVERIFIED' : 'BLOCKED', present.iosIcon ? 'AppIcon 목록 존재만 확인. 실제 크기·투명도·모든 슬롯 검토 필요.' : '예정 위치에 AppIcon 목록 없음. 공식 로고 기반 스토어 아이콘 준비 필요.');
  add('ios-privacy-audit', 'UNVERIFIED', `예정 위치의 PrivacyInfo 목록 ${present.iosPrivacy ? '존재' : '없음'}. 필수 사유 API·SDK 사용 조사 후 필요 여부 판단; 파일 없음만으로 정책 위반을 단정하지 않음.`);
  for (const [id, detail] of [
    ['isolated-device-environment', '합성 자료 전용 HTTPS 환경·시험 계정과 앱 복귀 경로 확인 필요. 운영 URL로 대체 시험하지 않음.'],
    ['four-role-device-tests', '네 역할 로그인·전환·자녀 접근권한·사진·음성·다운로드·외부 지도·키보드·회전 및 기사 장기 운행 실기기 시험 미확인.'],
    ['identity-payment-provider', 'STIZ 전용 본인인증 정보·토스 운영 키 발급과 설정은 외부 확인 사항. 파일이나 키 값을 읽지 않음.'],
    ['family-billing-delivery', '자녀 연결 요청의 실제 부모 전달·승인, 청구 계산·일괄 발행과 전달은 별도 검증 필요. DB·발송 실행하지 않음.'],
    ['store-review', '개발자 계정 유형·스토어 등록·개인정보/탈퇴·권한 설명·심사 자료·서명은 외부 확인 필요.'],
  ]) add(id, 'UNVERIFIED', detail);
  return {
    schemaVersion: 1,
    mode: 'local-source-only',
    releaseDecision: 'NOT_ESTABLISHED',
    localSafetyPassed: checks.filter(x => x.scope === 'local-safety').every(x => x.status === 'PASS'),
    counts: Object.fromEntries(['PASS', 'BLOCKED', 'UNVERIFIED'].map(s => [s, checks.filter(x => x.status === s).length])),
    unavailableSources: unavailable,
    checks,
    limits: '정적 문자열·파일 존재 점검이며 안전성 증명이나 출시 승인 아님. 키·인증 파일·환경 값·네트워크·DB·기기·외부 명령 접근 및 파일 쓰기 없음.',
  };
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json')) {
    console.error('사용법: node scripts/native-release-readiness.mjs [--json]');
    process.exitCode = 2;
  } else {
    const report = inspectReadiness(resolve(dirname(self), '..'));
    if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('STIZ 로컬 출시 준비 점검 — 출시 가능 여부 미확정');
      for (const item of report.checks) console.log(`[${item.status}] ${item.id}: ${item.detail}`);
      console.log(report.limits);
    }
    // 0은 점검 수행·로컬 차단값 확인일 뿐, 출시 가능 또는 외부 작업 승인 의미가 아니다.
    process.exitCode = report.localSafetyPassed ? 0 : 2;
  }
}
