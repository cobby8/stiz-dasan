import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const cache = new Map();
function loadSource(file) {
  const resolved = path.resolve(file);
  if (cache.has(resolved)) return cache.get(resolved);
  const exports = {};
  cache.set(resolved, exports);
  const code = ts.transpileModule(readFileSync(resolved, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  new Function("require", "exports", code)((id) => {
    if (id === "next/link") return { default: ({ children, ...props }) => React.createElement("a", props, children), __esModule: true };
    if (id.startsWith("@/")) {
      const base = path.resolve("src", id.slice(2));
      return loadSource([base + ".tsx", base + ".ts"].find(existsSync));
    }
    return require(id);
  }, exports);
  return exports;
}
const Home = loadSource("src/app/LandingPageClient.tsx").default;
const galleryMedia = readFileSync("src/lib/galleryMedia.ts", "utf8");
const publicGallery = readFileSync("src/app/gallery/GalleryPublicClient.tsx", "utf8");
const homePage = readFileSync("src/app/page.tsx", "utf8");
const instagramSync = readFileSync("src/lib/instagramGallerySync.ts", "utf8");
const render = (props = {}) => renderToStaticMarkup(React.createElement(Home, { initialSettings: null, ...props }));
const post = (items) => ({ id: "public-gallery", title: "공개 수업 사진", caption: null, mediaJSON: JSON.stringify(items), createdAt: "2026-10-01" });

test("홈은 안정 이미지에서 대표 1장과 중복 없는 활동 사진 4장만 표시한다", () => {
  const images = Array.from({ length: 9 }, (_, i) => ({ url: `/public-${i}.jpg`, type: "image" }));
  const html = render({ galleryPosts: [post([{ url: "https://scontent.cdninstagram.com/expired.jpg" }, ...images, images[0]])] });
  assert.equal((html.match(/<img /g) || []).length, 5);
  for (let i = 0; i < 5; i++) assert.equal((html.match(new RegExp(`<img src="/public-${i}.jpg"`, "g")) || []).length, 1);
  assert.doesNotMatch(html, /expired.jpg|public-5.jpg/);
  assert.match(html, /공개 수업 사진/);
});

test("소개 직후 체험·프로그램 연결을 제공하고 근거 없는 수치를 노출하지 않는다", () => {
  const html = render();
  assert.match(html, /href="\/apply\/trial"/);
  assert.match(html, /href="\/programs"/);
  assert.ok(html.indexOf("체험 수업 신청") < html.indexOf("처음 시작하는 농구 수업"));
  assert.doesNotMatch(html, /No\.1|2,000|90%|5명\+|Since 2021|아직 등록된 후기가 없습니다/);
});

test("기존 설정의 미확인 홍보 수치도 공개에서 제외하고 긴 소개는 신청 뒤에 접는다", () => {
  const html=render({initialSettings:{introductionTitle:"다산신도시 No.1 스티즈농구교실",introductionText:"체험수업 등록률 90%가 보여주는 압도적인 신뢰도!\n"+"함께 즐겁게 성장하는 농구 수업입니다. ".repeat(20)}});
  assert.doesNotMatch(html,/No\.1|90%/);assert.match(html,/학원의 교육 방향 더 보기/);assert.ok(html.indexOf('체험 수업 신청')<html.indexOf('<details'));
});

test("등록된 소개 HTML은 정화하고 미등록 사진·영상·후기 섹션을 만들지 않는다", () => {
  const html = render({ initialSettings: { introductionTitle: "실제 제목", introductionText: '<p>실제 소개</p><script>bad()</script>' } });
  assert.match(html, /실제 제목|실제 소개/);
  assert.doesNotMatch(html, /bad\(\)|<script|<iframe|우리 학원의 수업 현장|학부모님이 전하는 이야기/);
});

test("실제 공지 2개·공개 후기 전체와 설정 영상을 간결하게 유지한다", () => {
  const html = render({
    initialSettings: { youtubeUrl: "https://youtu.be/abcdefghijk" },
    notices: Array.from({ length: 4 }, (_, i) => ({ id: `n${i}`, title: `실제공지${i}`, isPinned: i === 0, createdAt: "2026-10-01" })),
    testimonials: Array.from({ length: 5 }, (_, i) => ({ name: `후기작성자${i}`, info: "학부모", text: `공개후기${i}`, rating: 5 })),
  });
  assert.match(html, /실제공지0|실제공지1|공개후기4/);
  assert.doesNotMatch(html, /실제공지2/);
  assert.match(html, /<details[^>]*><summary/);
  assert.match(html, /https:\/\/www.youtube.com\/embed\/abcdefghijk/);
});

test("조회 범위·공개 갤러리·인스타 동기화의 안정 URL 기준은 유지한다", () => {
  assert.match(homePage, /getGalleryPosts\(\{ limit: 24, publicOnly: true \}\)/);
  assert.match(galleryMedia, /cdninstagram\.com/);
  assert.match(galleryMedia, /fbcdn\.net/);
  assert.match(publicGallery, /parseGalleryMediaJSON\(post\.mediaJSON\)/);
  assert.match(publicGallery, /isDurableGalleryMediaUrl\(item\.url\)/);
  assert.match(instagramSync, /parseGalleryMediaJSON\(mediaJSON\)/);
  assert.match(instagramSync, /isDurableGalleryMediaUrl\(item\.url\)/);
});
