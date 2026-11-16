// 글자 크기·굵기 가드 (2026-11-16 «코드로 남은 정리 모두 해결» — 원장 지시)
// 1) 12px 미만 글자 금지 — 휴대폰에서 읽히지 않는다. 최소는 text-xs(12px)·.75rem.
// 2) 굵기는 네 단계(본문 400 · 라벨 500 · 강조 600 · 제목 700)만 — 800·900(font-black·font-extrabold) 금지.
//    제목에 700 을 주려면 font-[700] 을 쓴다(테마가 font-bold 를 600 으로 그리기 때문).
// 정리 시점에 src 전체에서 0건이 됐다. 다시 생기면 이 테스트가 깨진다.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 다른 작업이 고치는 중이라 이번 정리에서 뺀 폴더(지금은 위반 0건이지만 검사 범위에서 제외 — 그 작업이 끝나면 지운다)
const EXCLUDED = ["src/app/rental/", "src/app/mypage/rental/"];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) walk(path, out);
    else if (/\.(tsx?|css)$/.test(entry.name) && !EXCLUDED.some((prefix) => path.startsWith(prefix))) out.push(path);
  }
  return out;
}

// 주석 안의 설명 글(예: «font-black → 700»)은 세지 않는다. 주소의 «https://» 는 앞이 공백이 아니라 지워지지 않는다.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const FILES = walk("src").map((path) => ({ path, text: stripComments(readFileSync(path, "utf8")) }));

// 글자 크기 값을 px 로 바꿔 12 미만인지 본다(em 은 부모 크기에 따라 달라 세지 않는다).
const toPx = (value, unit) => (unit === "rem" ? Number(value) * 16 : Number(value));
const SIZE_PATTERNS = [
  /\btext-\[(\d*\.?\d+)(px|rem)\]/g, // Tailwind 임의 값 text-[11px] · text-[0.6875rem]
  /font-size\s*:\s*(\d*\.?\d+)(px|rem)/g, // CSS · 인라인 HTML 문자열
  /fontSize\s*:\s*["'`](\d*\.?\d+)(px|rem)/g, // React style 객체
];

export function findSmallText(files) {
  const hits = [];
  for (const { path, text } of files) {
    for (const re of SIZE_PATTERNS) {
      for (const m of text.matchAll(re)) if (toPx(m[1], m[2]) < 12) hits.push(`${path}: ${m[0]}`);
    }
  }
  return hits;
}

const HEAVY = /\bfont-(black|extrabold)\b|\bfont-\[[89]00\]|font-weight\s*:\s*[89]00\b|fontWeight\s*[:=]\s*["'{]?\s*[89]00\b/g;
export function findHeavyWeight(files) {
  return files.flatMap(({ path, text }) => [...text.matchAll(HEAVY)].map((m) => `${path}: ${m[0]}`));
}

test("src 에 12px 미만 글자 크기가 없다(text-[11px]·font-size:.7rem 등)", () => {
  const hits = findSmallText(FILES);
  assert.deepEqual(hits, [], `12px 미만 글자 ${hits.length}곳 — 최소 text-xs(12px)·.75rem 로 올린다. 좁은 칸은 여백·배치로 맞춘다.\n${hits.join("\n")}`);
});

test("src 에 800·900 굵기가 없다(font-black·font-extrabold·font-weight:800)", () => {
  const hits = findHeavyWeight(FILES);
  assert.deepEqual(hits, [], `굵기 800·900 ${hits.length}곳 — 제목은 font-[700], 그 외 강조는 font-semibold.\n${hits.join("\n")}`);
});

test("가드가 실제로 잡는다(거짓 통과 방지)", () => {
  const sample = [{ path: "x.tsx", text: stripComments(`
    <p className="text-[11px] text-[10px] text-[0.6875rem] text-xs text-[12px] text-[0.75rem]" />
    const css = "font-size:11px;font-size: .7rem;font-size:.75rem;font-size:12px";
    <b style={{ fontSize: "10px", fontWeight: 900 }} className="font-black font-extrabold font-[800] font-[700] font-bold" />
    /* font-black 설명 주석은 세지 않는다 */
  `) }];
  assert.equal(findSmallText(sample).length, 6); // 11px·10px·0.6875rem·11px·.7rem·"10px"
  assert.equal(findHeavyWeight(sample).length, 4);
});

test("제외 폴더는 대관 두 곳뿐이다(늘리지 않는다)", () => {
  assert.deepEqual(EXCLUDED, ["src/app/rental/", "src/app/mypage/rental/"]);
});
