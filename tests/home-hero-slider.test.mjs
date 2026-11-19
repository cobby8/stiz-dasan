import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const code = ts.transpileModule(readFileSync("src/components/landing/HomeHeroSlider.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const exports = {};
// 사진 주소 줄이기 함수(@/lib/ui/optimizedImage)는 실제 코드를 그대로 올려 쓴다 — 순수 함수라 따로 준비할 것이 없다
const transpile = (file) => ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const optimizedImage = {};
new Function("exports", transpile("src/lib/ui/optimizedImage.ts"))(optimizedImage);
const requireWithAlias = (id) => (id === "@/lib/ui/optimizedImage" ? optimizedImage : require(id));
new Function("require", "exports", code)(requireWithAlias, exports);
const Slider = exports.default;
const render = (slides) => renderToStaticMarkup(React.createElement(Slider, { slides }, React.createElement("h1", { id: "public-home-title" }, "제목")));

test("첫 화면 슬라이드: 서버 화면에는 첫 사진만 넣고 우선 불러온다(둘째 장부터는 페이지가 다 뜬 뒤 한 장씩)", () => {
    const html = render([
        { url: "https://x/1.jpg", alt: "첫 사진" },
        { url: "https://x/2.jpg", alt: "둘째" },
        { url: "https://x/3.jpg", alt: "셋째" },
    ]);
    assert.match(html, /class="public-home-hero public-home-hero--large"/);
    // 2026-11-19 속도 7회차: 겹친 사진은 lazy 가 안 들어 첫 화면에 2·3번째 장까지 받았다 → 첫 장만
    assert.equal((html.match(/<img /g) || []).length, 1);
    assert.doesNotMatch(html, /x\/2\.jpg|x\/3\.jpg/);
    assert.match(html, /<img src="https:\/\/x\/1\.jpg" alt="첫 사진"[^>]*fetchPriority="high"[^>]*loading="eager"[^>]*class="public-home-hero__image is-active"/);
    // 다음 장은 load 뒤에 하나(고른 장 + 그다음 장), 넣은 장은 계속 둔다
    const src = readFileSync("src/components/landing/HomeHeroSlider.tsx", "utf8");
    assert.match(src, /window\.addEventListener\("load", onLoad, \{ once: true \}\)/);
    assert.match(src, /const want = \[index, \.\.\.\(pageLoaded \? \[\(index \+ 1\) % count\] : \[\]\)\];/);
    assert.match(src, /slides\.map\(\(slide, i\) => !mounted\.has\(i\) \? null :/);
    // 건너뛴 장은 다 받은 뒤에야 보인다(빈 화면 방지) — 보이는 장(shown)은 ready 일 때만 index 로 바뀐다
    assert.match(src, /if \(ready\.has\(index\)\) setShown\(index\);/);
    assert.match(src, /className=\{`public-home-hero__image\$\{i === shown \? " is-active" : ""\}`\}/);
    assert.match(src, /onError=\{i === 0 \? undefined : \(\) => markReady\(i\)\}/);
    // 둘째 장부터는 여전히 낮은 우선순위, lazy 는 쓰지 않는다(넣는 시점을 코드가 정한다)
    assert.match(src, /fetchPriority=\{i === 0 \? "high" : "low"\}/);
    assert.doesNotMatch(src, /loading=\{i === 0 \? "eager" : "lazy"\}/);
    // 넘김 버튼 3개, 첫 번째가 현재
    assert.equal((html.match(/번째 사진 보기/g) || []).length, 3);
    assert.match(html, /aria-label="1번째 사진 보기" aria-current="true"/);
    assert.match(html, /<h1 id="public-home-title">제목<\/h1>/);
});

test("사진이 1장이면 넘김 버튼을 두지 않고, 0장이어도 제목은 보인다", () => {
    assert.doesNotMatch(render([{ url: "https://x/1.jpg", alt: "한 장" }]), /번째 사진 보기/);
    const empty = render([]);
    assert.doesNotMatch(empty, /<img /);
    assert.match(empty, /제목/);
});

test("우리 저장소 사진은 화면 폭에 맞는 크기로 줄여 받는다(다른 주소는 그대로)", () => {
    const html = render([{ url: "https://abc.supabase.co/storage/v1/object/public/uploads/a.jpg", alt: "첫 사진" }]);
    assert.match(html, /<img src="\/_next\/image\?url=https%3A%2F%2Fabc\.supabase\.co%2F[^"]*&amp;w=\d+&amp;q=75" srcSet="[^"]+ 1920w" sizes="\(max-width: 767px\) 220vw, 100vw" alt="첫 사진"/);
    assert.match(html, /fetchPriority="high"[^>]*loading="eager"/);
});
