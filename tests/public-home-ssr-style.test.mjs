import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isPublicSitePath } from "../src/lib/public-site-path.ts";

const nativeRequire = createRequire(import.meta.url);
function compile(relativePath, imports) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module, exports: module.exports,
    require: (name) => name in imports ? imports[name] : nativeRequire(name),
    console,
  });
  return module.exports.default;
}
function theme(pathname) {
  return compile("../src/components/PublicSiteTheme.tsx", {
    "next/navigation": { usePathname: () => pathname },
    "@/lib/public-site-path": { isPublicSitePath },
    "./public-sport.css": {},
  });
}
const styled = (component, props = {}) => renderToStaticMarkup(React.createElement(component, props)).includes('class="stiz-public-sport');

test("실제 홈 서버 페이지는 주소가 준비되지 않아도 첫 HTML부터 공개 스타일을 포함한다", async () => {
  const Theme = theme(null);
  const empty = () => null;
  const queries = {
    getAcademySettings: async () => ({}), getPublicTestimonials: async () => [],
    getGalleryPosts: async () => [], getNotices: async () => [],
  };
  const Home = compile("../src/app/page.tsx", Object.fromEntries([
    ["@/lib/queries", queries], ["@/components/PublicSiteTheme", { default: Theme }],
    ["@/lib/publicMetadata", { buildPublicMetadata: () => ({}) }],
    ...["@/components/PublicHeader", "@/components/PublicFooter", "./LandingPageClient",
      "@/components/chat/ChatBotButton", "@/components/guide-tour/GuideTourLazyTrigger"].map((name) => [name, { default: empty }]),
  ]));
  const html = renderToStaticMarkup(await Home());
  assert.match(html, /^<div class="stiz-public-sport min-h-screen flex flex-col">/);
});

test("명시한 공개 범위는 null 주소와 브라우저 주소가 준비된 뒤에도 같다", () => {
  assert.equal(styled(theme(null), { publicScope: true }), true);
  assert.equal(styled(theme("/"), { publicScope: true }), true);
  assert.equal(styled(theme("/"), { publicScope: false }), false);
});

test("기존 호출부의 업무 화면·주소 미준비·설치와 직원 로그인 별칭 판단은 유지한다", () => {
  for (const path of [null, "/admin", "/staff", "/mypage", "/driver/example", "/staff/login", "/mypage/install", "/staff/install"]) {
    assert.equal(styled(theme(path)), false, String(path));
  }
});

test("기존 공개 안내·로그인·설치 페이지의 스타일은 유지한다", () => {
  for (const path of ["/", "/annual", "/about", "/login", "/parent-app", "/teacher-app"]) {
    assert.equal(styled(theme(path)), true, path);
  }
});
