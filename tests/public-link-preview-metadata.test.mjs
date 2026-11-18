import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const publicMetadataSource = await readFile("src/lib/publicMetadata.ts", "utf8");
const layoutSource = await readFile("src/app/layout.tsx", "utf8");
const ogImageSource = await readFile("src/app/opengraph-image.tsx", "utf8");
const adminActionSource = await readFile("src/app/actions/admin.ts", "utf8");
const robotsSource = await readFile("src/app/robots.ts", "utf8");
const sitemapSource = await readFile("src/app/sitemap.ts", "utf8");

const publicPages = [
  ["src/app/page.tsx", 'path: "/"'],
  ["src/app/apply/page.tsx", 'path: "/apply"'],
  ["src/app/apply/trial/page.tsx", 'path: "/apply/trial"'],
  ["src/app/apply/enroll/page.tsx", 'path: "/apply/enroll"'],
  ["src/app/about/page.tsx", 'path: "/about"'],
  ["src/app/programs/page.tsx", 'path: "/programs"'],
  ["src/app/schedule/page.tsx", 'path: "/schedule"'],
  ["src/app/notices/page.tsx", 'path: "/notices"'],
  ["src/app/gallery/page.tsx", 'path: "/gallery"'],
  ["src/app/faq/page.tsx", 'path: "/faq"'],
  ["src/app/annual/page.tsx", 'path: "/annual"'],
  ["src/app/seasonal/page.tsx", 'path: "/seasonal"'],
  ["src/app/simulator/page.tsx", 'path: "/simulator"'],
  ["src/app/privacy/page.tsx", 'path: "/privacy"'],
  ["src/app/terms/page.tsx", 'path: "/terms"'],
  ["src/app/teacher-app/page.tsx", 'path: "/teacher-app"'],
];

test("public metadata uses the production domain and a large preview image", () => {
  assert.match(publicMetadataSource, /PUBLIC_SITE_URL = "https:\/\/www\.stiz-dasan\.kr"/);
  assert.match(publicMetadataSource, /DEFAULT_OG_IMAGE = "\/opengraph-image"/);
  assert.match(publicMetadataSource, /metadataBase: new URL\(PUBLIC_SITE_URL\)/);
  assert.match(publicMetadataSource, /openGraph:\s*\{/);
  assert.match(publicMetadataSource, /twitter:\s*\{/);
  assert.match(publicMetadataSource, /summary_large_image/);
  assert.match(publicMetadataSource, /alternates:\s*\{\s*canonical/);
  assert.match(layoutSource, /buildPublicMetadata\(/);
});

test("generated share image is sized for messenger previews", () => {
  assert.match(ogImageSource, /export const size = \{\s*width: 1200,\s*height: 630,\s*\}/);
  assert.match(ogImageSource, /export const contentType = "image\/png"/);
  assert.match(ogImageSource, /ImageResponse/);
});

test("application links prefer the public site domain instead of Vercel preview URLs", () => {
  // 2026-11-18 옛 코드 정리 C: 수강 안내 링크 생성(generateEnrollLink·buildEnrollLink)은 부르는 곳이 없어 지웠다
  assert.doesNotMatch(adminActionSource, /function (buildEnrollLink|generateEnrollLink)\b/);
});

test("public pages opt into shared link preview metadata", async () => {
  for (const [file, expectedPath] of publicPages) {
    const source = await readFile(file, "utf8");
    assert.match(source, /buildPublicMetadata\(/, `${file} should use buildPublicMetadata`);
    assert.ok(source.includes(expectedPath), `${file} should set ${expectedPath}`);
  }
});

test("robots and sitemap use the same canonical public domain", () => {
  assert.match(robotsSource, /PUBLIC_SITE_URL/);
  assert.match(sitemapSource, /PUBLIC_SITE_URL/);
});
