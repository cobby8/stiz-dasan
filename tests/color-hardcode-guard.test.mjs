import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

// 하드코딩 색 가드 (2026-11-09 색상 정리 2단계) — KST 가드와 같은 방식.
// 화면 파일에 직접 쓴 Tailwind 색 클래스(bg-red-50·text-gray-500·border-brand-orange-500 …)와 hex(#b91c1c)를
// 파일별로 세어, 기준선보다 «늘면» 실패한다. 색은 토큰(var(--color-academy-*))·공용 부품(StatusBadge·statusTones)으로 쓴다.
//
// ⚠️ 기준선(tests/fixtures/color-hardcode-baseline.json)은 «괜찮다»는 뜻이 아니라 **갚아야 할 빚**이다.
//    새 파일은 0 이어야 하고, 기존 파일도 늘리면 안 된다. 줄였으면 기준선을 낮춘다:
//      UPDATE_COLOR_BASELINE=1 node --test tests/color-hardcode-guard.test.mjs
//    (줄어든 쪽만 반영된다 — 늘어난 파일이 있으면 갱신 모드에서도 실패한다.)

const SRC = "src";
const BASELINE = "tests/fixtures/color-hardcode-baseline.json";
// 색 «정의» 파일 — 값이 여기 모여 있어야 한다(세지 않는다).
// src/lib/ui/colorValues.ts = CSS 변수를 못 쓰는 곳(OG 이미지·theme-color)의 hex 한 곳(색상 7단계).
// (SVG 차트 색은 src/components/charts/chartColors.ts — var() 토큰이라 hex 가 없어 따로 뺄 필요가 없다.)
const TOKEN_FILES = new Set(["src/app/academy-theme.css", "src/app/globals.css", "src/components/public-sport.css", "src/lib/ui/colorValues.ts"]);

const PALETTE = "red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone";
const UTIL = "bg|text|border|border-[trblxy]|ring|ring-offset|from|via|to|fill|stroke|outline|divide|placeholder|accent|caret|decoration|shadow";
// 단어 앞이 영문·숫자·하이픈이 아니어야 클래스 시작이다(hover:·dark:·md: 접두는 허용 = 같이 센다).
const TW_COLOR = new RegExp(`(?<![\\w-])(?:${UTIL})-(?:(?:${PALETTE})-\\d{2,3}|brand-[a-z]+(?:-[a-z]+)?-\\d{2,3})(?![\\w-])`, "g");
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;

/** 주석 안의 색 이름은 세지 않는다(설명문). 문자열은 남긴다 — 클래스는 문자열 안에 있다. */
function stripComments(code, isCss) {
  if (isCss) return code.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  let out = "", i = 0, quote = null;
  while (i < code.length) {
    const c = code[i], n = code[i + 1];
    if (quote) {
      if (c === "\\") { out += code.slice(i, i + 2); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/" && code[i - 1] !== ":") { while (i < code.length && code[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") {
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) { out += code[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2; continue;
    }
    out += c; i++;
  }
  return out;
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

export async function countHardcodedColors() {
  const counts = {};
  for (const file of (await walk(SRC)).sort()) {
    if (TOKEN_FILES.has(file)) continue;
    const isCss = file.endsWith(".css");
    const code = stripComments(await readFile(file, "utf8"), isCss);
    const n = (code.match(TW_COLOR)?.length ?? 0) + (code.match(HEX)?.length ?? 0);
    if (n > 0) counts[file] = n;
  }
  return counts;
}

test("하드코딩 색은 파일별 기준선보다 늘지 않는다 (새 파일은 0)", async () => {
  const now = await countHardcodedColors();
  const base = JSON.parse(await readFile(BASELINE, "utf8")).files;
  const grew = Object.entries(now)
    .filter(([f, n]) => n > (base[f] ?? 0))
    .map(([f, n]) => `${f}: 기준선 ${base[f] ?? 0} → 지금 ${n} — 색은 토큰 var(--color-academy-*)·StatusBadge·src/lib/ui/statusTones.ts 로`);
  if (process.env.UPDATE_COLOR_BASELINE === "1" && grew.length === 0) {
    // 줄어든 파일만 낮춘다(없어진 파일은 지운다). 늘어난 파일이 있으면 여기 오지 않는다.
    const files = Object.fromEntries(Object.entries(now).filter(([f]) => base[f] !== undefined).map(([f, n]) => [f, Math.min(n, base[f])]));
    const total = Object.values(files).reduce((a, b) => a + b, 0);
    await writeFile(BASELINE, JSON.stringify({ note: "갚아야 할 빚 — 늘리지 말 것. 줄였으면 UPDATE_COLOR_BASELINE=1 로 낮춘다.", total, files }, null, 2) + "\n");
  }
  assert.deepEqual(grew, [], `하드코딩 색이 늘었다:\n${grew.join("\n")}`);
});

test("가드 자체 확인 — 클래스·hex 는 세고, 토큰·주석·비색 단어는 세지 않는다", () => {
  const sample = `
    // bg-red-50 주석은 안 센다
    const a = "bg-red-50 text-gray-500 hover:border-brand-orange-500 dark:bg-gray-800/50 ring-offset-sky-100";
    const b = "bg-[var(--color-academy-danger-soft)] text-red text-red-xl border-gray rounded-full bg-white";
    const c = { color: "#b91c1c", bg: "#fff", url: "a.html#top", ent: "&#123;" };`;
  const code = stripComments(sample, false);
  assert.equal(code.match(TW_COLOR)?.length, 5);
  assert.equal(code.match(HEX)?.length, 2);
  assert.equal(stripComments("/* #fff */ .a{color:#000}", true).match(HEX)?.length, 1);
});
