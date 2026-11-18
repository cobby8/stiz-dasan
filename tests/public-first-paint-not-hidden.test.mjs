// 공개 화면 첫 글이 «스크립트가 끝날 때까지 투명»으로 숨지 않게(2026-11-19 전 화면 속도 1회차)
//
// 왜: AnimateOnScroll 이 서버 화면을 opacity 0 으로 그려, 휴대폰에서 스크립트가 끝날 때까지(4~5초)
//     글이 이미 도착했는데도 빈 화면이었다(Lighthouse 모바일 LCP 5.4~5.9초, 92%가 그리기 지연).
//     같은 부품을 공개 화면 20곳이 쓴다 — 다시 스크립트로 숨기는 방식으로 돌아가지 않게 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("AnimateOnScroll — 스크립트 없이 처음부터 보이고, 효과는 CSS 가 맡는다", () => {
  // 주석(이유 설명)은 빼고 코드만 본다
  const src = readFileSync("src/components/ui/AnimateOnScroll.tsx", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(src, /['"]use client['"]/, "브라우저 부품이 되면 다시 스크립트 실행을 기다린다");
  assert.doesNotMatch(src, /opacity/, "서버 화면에서 투명하게 시작하지 않는다");
  assert.doesNotMatch(src, /IntersectionObserver|useEffect|useState/);
  assert.match(src, /aos-reveal/);
});

test("스크롤 진입 효과 CSS — 기능을 아는 브라우저에서만, 움직임 줄이기 설정은 존중", () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const at = css.indexOf("@supports (animation-timeline: view())");
  assert.ok(at > 0, "스크롤 연동 기능이 없는 브라우저는 효과 없이 바로 보여야 한다");
  const block = css.slice(at, at + 400);
  assert.match(block, /prefers-reduced-motion: no-preference/);
  assert.match(block, /\.aos-reveal\s*\{[\s\S]*animation-timeline: view\(\)/);
  // @supports 밖에서 .aos-reveal 을 숨기는 규칙이 없어야 한다
  const outside = css.slice(0, at);
  assert.doesNotMatch(outside, /\.aos-reveal\s*\{[^}]*opacity\s*:\s*0/);
});

test("갤러리 칸 사진은 줄여 받고, 크게 보기는 원본 주소", () => {
  const src = readFileSync("src/app/gallery/GalleryPublicClient.tsx", "utf8");
  assert.match(src, /optimizedImageProps\(item\.url, "\(max-width: 767px\) 50vw, \(max-width: 1023px\) 33vw, 25vw", 828\)/);
  assert.doesNotMatch(src, /src=\{item\.url\}\s*\n\s*alt=/, "칸 사진에 원본을 그대로 쓰지 않는다");
});
