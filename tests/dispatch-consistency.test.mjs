import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('배차 응답 역전·저장 확인·추가 편집 보존 회귀', () => {
  const safe = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|HOMEDRIVE|HOMEPATH|NUMBER_OF_PROCESSORS)$/i.test(key)));
  const result = execFileSync(process.execPath, ['scripts/test-dispatch-consistency.mjs'], { env: safe, windowsHide: true, encoding: 'utf8', timeout: 30_000 });
  const report = JSON.parse(result.trim());
  assert.equal(report.passed, true);
  assert.ok(report.checks >= 13);
});
