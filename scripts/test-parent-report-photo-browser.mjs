import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { startStatusBrowserHarness } from "../tests/helpers/status-browser-harness.mjs";

// 실제 사진 컴포넌트만 격리한다. 로그인·운영 API·외부 저장소에는 연결하지 않는다.
const harness = await startStatusBrowserHarness({
    entry: `import React from 'react'; import {createRoot} from 'react-dom/client';
import Photo from '@/components/parent/ReportPhoto';
const root=createRoot(document.getElementById('root'));
function render(src='/photo-missing.gif'){root.render(React.createElement(React.Fragment,null,React.createElement(Photo,{key:'ok',src:'/photo-ok.gif',alt:'정상 사진'}),React.createElement(Photo,{key:src,src,alt:'교체 사진'})));}
window.replacePhoto=()=>render('/photo-ok.gif');render();`,
    assets: { "/photo-ok.gif": { contentType: "image/gif", body: Buffer.from("R0lGODlhAQABAAAAACwAAAAAAQABAAA=", "base64") } },
});
const results = [];
let browser;
try {
    browser = await chromium.launch({ executablePath: process.env.STATUS_TEST_BROWSER || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => route.request().url().startsWith(harness.url) ? route.continue() : route.abort());
    await page.goto(harness.url);
    await page.waitForFunction(() => document.querySelector('img[alt="정상 사진"]')?.naturalWidth > 0);
    assert.equal(await page.getByAltText("정상 사진").count(), 1);
    results.push("정상 사진 로드");
    await page.getByAltText("교체 사진").waitFor({ state: "detached" });
    results.push("실패한 사진만 제외하고 리포트 유지");
    await page.evaluate(() => window.replacePhoto());
    await page.waitForFunction(() => document.querySelector('img[alt="교체 사진"]')?.naturalWidth > 0);
    results.push("새 사진 주소로 교체하면 정상 복구");
    assert.deepEqual(errors, []);
    results.push("브라우저 렌더 오류 없음");
    await mkdir(".tmp/parent-report-photo", { recursive: true });
    await writeFile(".tmp/parent-report-photo/browser.json", JSON.stringify({ passed: results.length, results, externalRequests: "blocked", productionData: "none" }, null, 2));
    console.log(`PASS ${results.length}/${results.length}: 학부모 리포트 사진 브라우저`);
} finally {
    await browser?.close();
    await harness.close();
}
