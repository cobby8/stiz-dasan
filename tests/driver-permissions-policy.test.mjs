import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match');
const source = readFileSync(new URL('../next.config.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(output, sandbox);
const rules = JSON.parse(JSON.stringify(await sandbox.exports.default.headers()));
const matching = pathname => rules.filter(rule => getPathMatch(rule.source)(pathname) !== false);
const policies = pathname => matching(pathname).flatMap(rule => rule.headers).filter(header => header.key.toLowerCase() === 'permissions-policy').map(header => header.value);

for (const prefix of ['/driver', '/shuttle/run', '/shuttle/regular']) {
  for (const suffix of ['/synthetic-token', '/synthetic-token/']) {
    test(`${prefix}${suffix} 위치 권한은 단 하나의 self 허용 규칙`, () => {
      assert.deepEqual(policies(`${prefix}${suffix}`), ['camera=(), microphone=(), geolocation=(self)']);
      const headers = Object.fromEntries(matching(`${prefix}${suffix}`).flatMap(rule => rule.headers).map(header => [header.key, header.value]));
      assert.equal(headers['X-Frame-Options'], 'DENY');
      assert.equal(headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(headers['Referrer-Policy'], 'no-referrer');
      assert.match(headers['X-Robots-Tag'], /noindex/);
    });
  }
}
for (const pathname of ['/', '/mypage', '/login', '/driver', '/driver/', '/driver/token/extra', '/driverish/token', '/shuttle/run', '/shuttle/regular', '/shuttle/run/token/extra', '/shuttle/regular/token/extra', '/shuttle/regularity/token', '/api/shuttle/regular-order']) {
  test(`${pathname} 위치 권한 차단 유지`, () => assert.deepEqual(policies(pathname), ['camera=(), microphone=(), geolocation=()']));
}
for (const [pathname, expected] of [
  ['/staff/attendance', 'camera=(self), microphone=(self), geolocation=()'],
  ['/api/staff/test', 'camera=(self), microphone=(self), geolocation=()'],
  ['/admin/shuttle', 'camera=(self), microphone=(), geolocation=(self)'],
  ['/shuttle/location/token', 'camera=(), microphone=(), geolocation=(self)'],
  ['/staff/install', 'camera=(), microphone=(), geolocation=()'],
  ['/teacher-app', 'camera=(), microphone=(), geolocation=()'],
]) {
  test(`${pathname} 기존 예외 정책 최종값 유지`, () => assert.equal(policies(pathname).at(-1), expected));
}
