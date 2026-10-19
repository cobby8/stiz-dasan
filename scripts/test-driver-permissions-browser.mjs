import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { getPathMatch } = require('next/dist/shared/lib/router/utils/path-match');
const config = await readFile(new URL('../next.config.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(config, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(output, sandbox);
const rules = await sandbox.exports.default.headers();
const cases = [];
// 실제 Next 경로 matcher와 설정값으로만 응답한다. 앱·DB·실제 위치 전송은 실행하지 않는다.
const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const policyValues = [];
  for (const rule of rules) {
    if (getPathMatch(rule.source)(pathname) === false) continue;
    for (const header of rule.headers) {
      if (header.key.toLowerCase() === 'permissions-policy') policyValues.push(header.value);
      res.setHeader(header.key, header.value);
    }
  }
  // 중복 규칙의 충돌을 브라우저 검사 전에 노출한다.
  if (policyValues.some(value => value.includes('geolocation=()')) && policyValues.some(value => value.includes('geolocation=(self)'))) {
    res.statusCode = 500;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><meta charset="utf-8"><title>격리 위치 권한 검사</title>가상 위치만 사용');
});
let browser;
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const context = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 0, longitude: 0, accuracy: 8 } });
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  const page = await context.newPage();
  for (const [pathname, allowed] of [
    ['/driver/synthetic-only', true], ['/driver/synthetic-only/', true],
    ['/shuttle/run/synthetic-only', true], ['/shuttle/regular/synthetic-only', true],
    ['/mypage', false], ['/driver', false], ['/driver/synthetic-only/extra', false],
    ['/shuttle/run/synthetic-only/extra', false], ['/shuttle/regular/synthetic-only/extra', false],
    ['/shuttle/location/synthetic-only', true], ['/admin/shuttle', true],
    ['/staff/attendance', false], ['/staff/install', false],
  ]) {
    const response = await page.goto(origin + pathname);
    assert.equal(response.status(), 200, pathname);
    const actual = await page.evaluate(() => new Promise(resolve => navigator.geolocation.getCurrentPosition(
      position => resolve({ ok: true, latitude: position.coords.latitude, longitude: position.coords.longitude }),
      error => resolve({ ok: false, code: error.code }), { timeout: 5000, maximumAge: 0 },
    )));
    assert.equal(actual.ok, allowed, pathname);
    if (allowed) { assert.equal(actual.latitude, 0); assert.equal(actual.longitude, 0); }
    else assert.equal(actual.code, 1);
    cases.push({ pathname, allowed, passed: true, policy: response.headers()['permissions-policy'] });
  }
  await context.close();
  await mkdir('.tmp/driver-permissions', { recursive: true });
  await writeFile('.tmp/driver-permissions/browser.json', JSON.stringify({ source: '실제 Next matcher·설정 + Chrome 가상 좌표(0,0), 운영 연결 없음', passed: cases.length, cases }, null, 2));
  console.log(`기사 위치 권한 브라우저 ${cases.length}/${cases.length} 통과`);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
