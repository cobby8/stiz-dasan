// 사용자 브라우저 프로필을 열지 않는 로컬 전용 헤드리스 검사입니다.
import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { startMonthlyRegisterHarness } from '../tests/helpers/monthly-register-browser-harness.mjs';
import { runMonthlyRegisterBrowserTests } from '../tests/monthly-register-browser.integration.mjs';

async function main() {
  if (process.argv.length !== 2) throw new Error('임의 URL·프로필·인증 인수는 지원하지 않습니다.');
  let executablePath;
  for (const candidate of [chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']) {
    try { await access(candidate); executablePath = candidate; break; } catch { /* 설치된 브라우저만 사용 */ }
  }
  if (!executablePath) throw new Error('사용 가능한 설치된 Chromium/Chrome/Edge가 없습니다.');
  let harness; let browser; let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    try { await browser?.close(); } finally { await harness?.close(); }
  })();
  const stop = () => { void cleanup().finally(() => process.exit(1)); };
  try {
    harness = await startMonthlyRegisterHarness();
    console.log('운영 연결 없는 격리 UI 검사 시작');
    browser = await chromium.launch({ executablePath, headless: true, timeout: 20000,
      args: ['--no-proxy-server', '--disable-background-networking', '--disable-component-update'] });
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const result = await runMonthlyRegisterBrowserTests({ browser, ...harness });
    await writeFile(path.join(harness.outputDir, 'result.json'), JSON.stringify({ ...result, scope: 'actual React UI / synthetic API / no production auth or DB' }, null, 2));
    console.log(`기능 검사 ${result.checks.length}개 통과 / 별도 진단 ${result.observations.length}개 / 보완 사항 ${result.findings.length}개`);
    for (const finding of result.findings) console.log(`FINDING ${finding}`);
    console.log(`가상 화면·결과: ${harness.outputDir}`);
  } finally {
    await cleanup();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
