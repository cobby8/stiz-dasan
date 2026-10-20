import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const galleryMedia = readFileSync(new URL("../src/lib/galleryMedia.ts", import.meta.url), "utf8");
const landingPage = readFileSync(new URL("../src/app/LandingPageClient.tsx", import.meta.url), "utf8");
const publicGallery = readFileSync(new URL("../src/app/gallery/GalleryPublicClient.tsx", import.meta.url), "utf8");
const homePage = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
const instagramSync = readFileSync(new URL("../src/lib/instagramGallerySync.ts", import.meta.url), "utf8");

test("홈 갤러리는 만료 가능한 인스타 CDN 원본을 썸네일 후보에서 제외한다", () => {
  assert.match(galleryMedia, /isUnstableInstagramMediaUrl/);
  assert.match(galleryMedia, /cdninstagram\.com/);
  assert.match(galleryMedia, /fbcdn\.net/);
  assert.match(landingPage, /isDurableGalleryMediaUrl\(item\.url\)/);
  assert.match(landingPage, /parseGalleryMediaJSON\(post\.mediaJSON\)/);
  assert.match(landingPage, /<img\s+src=\{url\}/);
  assert.doesNotMatch(landingPage, /from "next\/image"/);
});

test("안정 이미지 후보를 충분히 확보한 뒤 8개만 표시한다", () => {
  assert.match(homePage, /getGalleryPosts\(\{ limit: 24, publicOnly: true \}\)/);
  assert.match(landingPage, /\.filter\(\(item\) => item\.type === "image" && isDurableGalleryMediaUrl\(item\.url\)\)/);
  assert.match(landingPage, /\.slice\(0, 8\)/);
});

test("공개 갤러리와 인스타 동기화도 같은 안정 URL 기준을 사용한다", () => {
  assert.match(publicGallery, /parseGalleryMediaJSON\(post\.mediaJSON\)/);
  assert.match(publicGallery, /isDurableGalleryMediaUrl\(item\.url\)/);
  assert.match(instagramSync, /parseGalleryMediaJSON\(mediaJSON\)/);
  assert.match(instagramSync, /isDurableGalleryMediaUrl\(item\.url\)/);
});
