// 홈 사진을 보이는 크기에 맞춰 줄여 받기(2026-11-18 속도 조치)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const mod = {};
new Function("exports", ts.transpileModule(read("src/lib/ui/optimizedImage.ts"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(mod);
const { optimizedImageProps, OPTIMIZED_WIDTHS } = mod;

const PHOTO = "https://abc.supabase.co/storage/v1/object/public/uploads/quick-post/1 사진.jpg";

test("우리 저장소 사진은 /_next/image 를 거치는 srcSet 으로 바꾼다 — 폭은 Next 기본 허용 폭만", () => {
  const props = optimizedImageProps(PHOTO, "100vw");
  assert.equal(props.sizes, "100vw");
  const candidates = props.srcSet.split(", ").map((c) => c.split(" "));
  assert.deepEqual(candidates.map(([, w]) => w), OPTIMIZED_WIDTHS.map((w) => `${w}w`));
  const allowed = new Set([16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 1080, 1200, 1920, 2048, 3840]);
  for (const [url, w] of candidates) {
    const parsed = new URL(url, "https://www.example.com");
    assert.equal(parsed.pathname, "/_next/image");
    assert.equal(parsed.searchParams.get("url"), PHOTO, "원본 주소가 그대로(한글·공백 포함) 들어간다");
    assert.equal(`${parsed.searchParams.get("w")}w`, w);
    assert.ok(allowed.has(Number(parsed.searchParams.get("w"))), `허용되지 않은 폭 ${w} — 400 이 난다`);
    assert.equal(parsed.searchParams.get("q"), "75");
  }
  assert.match(props.src, /^\/_next\/image\?url=/);
});

test("작게 보이는 사진은 큰 후보를 만들지 않는다", () => {
  const props = optimizedImageProps(PHOTO, "(max-width: 767px) 50vw, 20vw", 828);
  assert.deepEqual(props.srcSet.split(", ").map((c) => c.split(" ")[1]), ["256w", "384w", "640w", "828w"]);
});

test("다른 곳의 주소·잘못된 주소·빈 값은 손대지 않는다", () => {
  for (const url of ["https://x/1.jpg", "https://scontent.cdninstagram.com/a.jpg", "http://abc.supabase.co/a.jpg", "/local.png", "not a url", "", "https://supabase.co.evil.example/a.jpg"]) {
    assert.deepEqual(optimizedImageProps(url, "100vw"), { src: url }, url);
  }
});

test("홈의 사진 세 곳(큰 사진·프로그램 타일·소식 사진)이 이 함수를 쓴다", () => {
  assert.match(read("src/components/landing/HomeHeroSlider.tsx"), /\{\.\.\.optimizedImageProps\(slide\.url, "100vw"\)\}/);
  assert.match(read("src/components/landing/HomeProgramTiles.tsx"), /<img \{\.\.\.optimizedImageProps\(program\.imageUrl, "\(max-width: 767px\) 50vw, 20vw", 828\)\}/);
  assert.match(read("src/app/LandingPageClient.tsx"), /<img \{\.\.\.optimizedImageProps\(url, "\(max-width: 767px\) 50vw, 25vw", 828\)\}/);
});
