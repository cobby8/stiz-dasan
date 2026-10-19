import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// 운영 화면에 접근하지 않는, 합성 계정 격리 서버 전용 검사입니다.
const base = process.argv[2];
assert.ok(base, "사용법: node scripts/test-navigation-hydration-browser.mjs http://127.0.0.1:PORT [반복수] [결과파일]");
const origin = new URL(base);
assert.equal(origin.hostname, "127.0.0.1", "격리 loopback 서버만 허용합니다.");
assert.equal(origin.protocol, "http:");
const rounds = Number(process.argv[3] || 5);
assert.ok(Number.isInteger(rounds) && rounds >= 1 && rounds <= 20);
const output = path.resolve(process.argv[4] || ".tmp/navigation-hydration/browser.json");
const paths = ["/admin", "/admin/apply", "/admin/attendance", "/staff", "/staff/quick-post", "/staff/seasonal"];
const results = [];
const blocked = { external: 0, writes: 0 };
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
try {
  for (const width of [390, 834, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: "block" });
    await context.route("**/*", (route) => {
      const request = route.request();
      if (new URL(request.url()).origin !== origin.origin) { blocked.external++; return route.abort(); }
      if (request.method() !== "GET") { blocked.writes++; return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    for (const mode of ["document", "link"]) {
      for (let round = 0; round < rounds; round++) {
        for (const routePath of paths) {
          const role = routePath.startsWith("/admin") ? "admin" : "teacher";
          await context.addCookies([{ name: "qa-role", value: role, url: origin.origin }]);
          const errors = [];
          const onError = (error) => errors.push(error.message);
          page.on("pageerror", onError);
          try {
            const link = page.locator(`a[href="${routePath}"]`).first();
            // 실제 Link의 클릭 처리와 문서 전체 이동을 각각 검사합니다.
            // 접힌 모바일 메뉴의 링크도 클릭하되 업무 저장 버튼은 누르지 않습니다.
            const viaLink = mode === "link" && new URL(page.url()).pathname.split("/")[1] === routePath.split("/")[1] && await link.count() > 0;
            if (viaLink) {
              await link.evaluate((element) => element.click());
              await page.waitForURL((url) => url.pathname === routePath);
            } else {
              await page.goto(origin.origin + routePath, { waitUntil: "load" });
            }
            await page.waitForTimeout(800);
            const fixture = await page.locator("body").textContent();
            assert.ok(fixture.includes(`합성 ${role}`), "합성 역할 화면이 아니므로 검사를 중단합니다.");
            results.push({ width, mode, round, path: routePath, viaLink, errors });
          } finally {
            page.off("pageerror", onError);
          }
        }
      }
    }
    await context.close();
  }
} finally {
  await browser.close();
  await mkdir(path.dirname(output), { recursive: true });
  const summary = { attempts: results.length, failed: results.filter((result) => result.errors.length > 0).length, linkTransitions: results.filter((result) => result.viaLink).length };
  await writeFile(output, JSON.stringify({ scope: "격리 합성 계정, GET 전용, 운영 로그인·실기기와 별개", summary, blocked, results }, null, 2));
  console.log(JSON.stringify(summary));
}
assert.ok(results.length > 0 && results.every((result) => result.errors.length === 0), "화면 전환 오류가 남아 있습니다.");
