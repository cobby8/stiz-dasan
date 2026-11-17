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

test("첫 화면 슬라이드: 첫 사진만 서버 화면에 보이고 우선 불러오며, 나머지는 늦게 불러온다", () => {
    const html = render([
        { url: "https://x/1.jpg", alt: "첫 사진" },
        { url: "https://x/2.jpg", alt: "둘째" },
        { url: "https://x/3.jpg", alt: "셋째" },
    ]);
    assert.match(html, /class="public-home-hero public-home-hero--large"/);
    assert.equal((html.match(/<img /g) || []).length, 3);
    assert.match(html, /<img src="https:\/\/x\/1\.jpg" alt="첫 사진"[^>]*fetchPriority="high"[^>]*loading="eager"[^>]*class="public-home-hero__image is-active"/);
    assert.match(html, /<img src="https:\/\/x\/2\.jpg" alt=""[^>]*aria-hidden="true"[^>]*loading="lazy"/);
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
    assert.match(html, /<img src="\/_next\/image\?url=https%3A%2F%2Fabc\.supabase\.co%2F[^"]*&amp;w=\d+&amp;q=75" srcSet="[^"]+ 1920w" sizes="100vw" alt="첫 사진"/);
    assert.match(html, /fetchPriority="high"[^>]*loading="eager"/);
});
