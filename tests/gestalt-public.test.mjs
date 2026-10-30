// 게슈탈트 디자인 점검(공개 홈페이지) 약속을 소스 수준에서 못박는다.
// 화면을 띄우지 않고 파일 글자를 읽어 확인하는 가벼운 테스트다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sportCss = read("src/components/public-sport.css");
const homeCss = read("src/components/landing/public-home.css");

// 폴더 안의 .tsx 파일 목록(하위 폴더 포함)
function walk(dir) {
  const root = new URL(`../${dir}`, import.meta.url);
  const out = [];
  for (const name of readdirSync(root)) {
    const rel = join(dir, name).replaceAll("\\", "/");
    if (statSync(new URL(`../${rel}`, import.meta.url)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx$/.test(name)) out.push(rel);
  }
  return out;
}

test("C-P1 버튼 3등급(주인공·보조·글자)이 44px 이상으로 정의돼 있다", () => {
  for (const name of ["public-btn-primary", "public-btn-secondary", "public-btn-text"]) {
    assert.ok(sportCss.includes(`.${name}`), name);
  }
  assert.match(sportCss, /:is\(\.public-btn-primary, \.public-btn-secondary, \.public-btn-text\) \{[^}]*min-height: 44px/);
  assert.match(sportCss, /\.public-btn-primary \{[^}]*background: var\(--color-public-accent\)/);
  assert.match(sportCss, /\.public-btn-secondary \{[^}]*background: transparent/);
  assert.match(sportCss, /\.public-btn-secondary--on-dark \{[^}]*border-color: var\(--color-public-white\)/);
});

test("P-02 홈 히어로·하단 CTA 의 두 번째 버튼은 보조(투명+흰 테두리)다", () => {
  assert.match(homeCss, /\.public-home-hero__actions a\+a\{background:transparent;color:var\(--color-public-white\);border:1px solid var\(--color-public-white\)\}/);
  assert.match(homeCss, /\.public-cta__actions>\*\+\*\{background:transparent;color:var\(--color-public-white\);border:1px solid var\(--color-public-white\)\}/);
});

test("P-05 /apply 두 신청 버튼은 같은 주인공 모양, 카드 머리는 같은 중립색", () => {
  const src = read("src/app/apply/ApplyPageClient.tsx");
  assert.equal(src.match(/className="public-btn-primary/g)?.length, 2);
  assert.equal(src.match(/bg-\[var\(--color-public-tint\)\] px-6 py-4/g)?.length, 2);
  assert.doesNotMatch(src, /bg-brand-navy-900 px-6 py-5/);
  // 기능 보존: 두 신청 경로와 투어 표적
  assert.ok(src.includes('href="/apply/trial"') && src.includes('href="/apply/enroll"'));
  assert.ok(src.includes('data-tour-target="trial-apply-btn"'));
});

test("C-P1 오류·404·시뮬레이터 버튼이 등급 클래스를 쓴다", () => {
  const error = read("src/app/error.tsx");
  assert.match(error, /onClick=\{\(\) => reset\(\)\}\s*className="public-btn-primary/);
  assert.match(error, /href="\/"\s*className="public-btn-secondary/);
  assert.match(read("src/app/not-found.tsx"), /href="\/"\s*className="public-btn-primary/);
  const sim = read("src/app/simulator/SimulatorClient.tsx");
  assert.match(sim, /href=\{`tel:\$\{phone\.replace\(\/-\/g, ""\)\}`\}\s*className="public-btn-primary/);
  assert.match(sim, /href="\/apply\/enroll"\s*className="public-btn-secondary/);
});
