import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 색 토큰 대비 가드 (2026-11-09 색상 정리 2단계)
// 토큰 파일을 «실제로 읽어» 글자/바탕 쌍은 4.5:1, 선(입력칸·위험 테두리)은 3:1 이상인지 잰다.
// 값만 바꾸고 눈으로 확인하지 않으면 «흐린 글자 3.5:1» 같은 일이 다시 생긴다 — 그래서 숫자로 막는다.
// 기준: WCAG 2.x 상대 휘도 대비(작은 글자 AA 4.5, 그래픽·경계 3.0). 디자인 교과서 6장 «연한 회색 작은 글자는 대비 검사».

/** 최상위 블록(선택자 { 선언 })에서 --이름: 값 을 모은다. 같은 이름은 나중 것이 이긴다. */
function collectTokens(file, selectors) {
  const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const map = {};
  for (const m of css.matchAll(/(^|\n)([^{}\n][^{}]*?)\{([^{}]*)\}/g)) {
    const sel = m[2].trim().split(",").map((s) => s.trim());
    if (!sel.some((s) => selectors.includes(s))) continue;
    for (const d of m[3].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) map[d[1]] = d[2].trim();
  }
  return map;
}

function resolve(map, value, depth = 0) {
  assert.ok(depth < 10, `토큰 참조가 너무 깊다: ${value}`);
  const v = value.trim();
  const ref = v.match(/^var\((--[\w-]+)(?:\s*,\s*(.+))?\)$/);
  if (ref) {
    if (map[ref[1]] !== undefined) return resolve(map, map[ref[1]], depth + 1);
    assert.ok(ref[2], `정의되지 않은 토큰: ${ref[1]}`);
    return resolve(map, ref[2], depth + 1);
  }
  return v;
}

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  assert.ok(/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h), `불투명 hex 가 아니다: ${hex}`);
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// 학원 앱 = :root(상태색) + .academy-app(나머지). 공개 홈페이지 = .stiz-public-sport 첫 블록(밝은 화면).
const academy = { ...collectTokens("src/app/academy-theme.css", [":root"]), ...collectTokens("src/app/academy-theme.css", [".academy-app"]) };
const publicTokens = collectTokens("src/components/public-sport.css", [".stiz-public-sport"]);
const A = (name) => resolve(academy, `var(--color-academy-${name})`);
const P = (name) => resolve(publicTokens, `var(--color-public-${name})`);

const TEXT = 4.5;
const LINE = 3;

// [설명, 글자(또는 선), 바탕, 기준]
const academyPairs = [
  ["본문 글자 / 카드", A("ink"), A("surface"), TEXT],
  ["본문 글자 / 화면 바탕", A("ink"), A("canvas"), TEXT],
  ["보조 글자 / 카드", A("muted"), A("surface"), TEXT],
  ["보조 글자 / 화면 바탕", A("muted"), A("canvas"), TEXT],
  ["보조 글자 / 옅은 면", A("muted"), A("soft"), TEXT],
  ["흐린 글자 / 카드", A("faint"), A("surface"), TEXT],
  ["흐린 글자 / 옅은 면", A("faint"), A("soft"), TEXT], // 11-09 마무리: #6b7280(4.39) → #636a75(4.96)
  ["주 버튼 글자 / 주 버튼", A("on-primary"), A("primary"), TEXT],
  ["주 버튼 글자 / 주 버튼 올림", A("on-primary"), A("primary-hover"), TEXT],
  ["행 안 작업·고른 칩 글자 / 그 바탕", A("primary"), A("primary-soft"), TEXT],
  ["입력칸·보조 버튼 테두리 / 카드", A("line-input"), A("surface"), LINE],
  // 입력선: 옛 #8a919c 는 연회색 바탕 위 2.96 이라 기준(3) 미달 → 11-09 마무리에서 #848b96(3.20)으로 진하게.
  ["입력칸·보조 버튼 테두리 / 화면 바탕", A("line-input"), A("canvas"), LINE],
  ["달력 오늘 테두리 / 카드", A("cal-today"), A("surface"), LINE],
  // 2026-11-09 위험색 역할 나누기 — 꽉 찬 위험 버튼은 맑은 빨강(#dc2626), 글자는 진한 빨강(#b91c1c) 그대로
  ["흰 글자 / 위험 채움 버튼(danger-fill)", A("on-primary"), A("danger-fill"), TEXT],
  ["흰 글자 / 위험 채움 버튼 올림", A("on-primary"), A("danger-fill-hover"), TEXT],
  ["확인 상자 왼쪽 위험 띠 / 카드", A("danger-fill"), A("surface"), LINE],
  ["확인 상자 왼쪽 위험 띠 / 화면 바탕", A("danger-fill"), A("canvas"), LINE],
];
for (const tone of ["success", "warning", "danger", "info", "neutral"]) {
  academyPairs.push(
    [`상태 ${tone} 글자 / 상태 바탕(배지)`, A(tone), A(`${tone}-soft`), TEXT],
    [`상태 ${tone} 글자 / 카드`, A(tone), A("surface"), TEXT],
    [`상태 ${tone} 글자 / 화면 바탕`, A(tone), A("canvas"), TEXT],
    [`흰 글자 / 상태 ${tone} 채움(눌린 상태 버튼)`, A("on-primary"), A(tone), TEXT],
  );
}
for (const cal of ["cal-present", "cal-late", "cal-absent", "cal-event", "cal-closed"]) {
  academyPairs.push([`달력 ${cal} / 카드`, A(cal), A("surface"), LINE]);
}

const publicPairs = [
  ["홈페이지 본문 / 종이", P("ink"), P("paper"), TEXT],
  ["홈페이지 보조 글자 / 종이", P("muted"), P("paper"), TEXT],
  ["홈페이지 보조 글자 / 옅은 띠", P("muted"), P("tint"), TEXT],
  ["홈페이지 주 버튼 글자 / 주 버튼(검정)", P("white"), P("accent"), TEXT],
  ["홈페이지 주 버튼 글자 / 주 버튼 올림", P("white"), P("strong"), TEXT],
  ["체험 신청 글자 / STIZ 주황", P("white"), P("trial"), TEXT],
  ["체험 신청 글자 / STIZ 주황 올림", P("white"), P("trial-hover"), TEXT],
  ["보조 버튼 테두리 / 종이", P("muted"), P("paper"), LINE],
];

test("학원 앱 색 토큰 — 글자/바탕 4.5:1, 선 3:1 이상", () => {
  const fails = academyPairs
    .map(([label, fg, bg, min]) => ({ label, fg, bg, min, ratio: contrast(fg, bg) }))
    .filter((p) => p.ratio < p.min)
    .map((p) => `${p.label}: ${p.fg} / ${p.bg} = ${p.ratio.toFixed(2)} (기준 ${p.min})`);
  assert.deepEqual(fails, [], `대비 미달:\n${fails.join("\n")}`);
});

test("홈페이지 색 토큰 — 주 버튼 검정·체험 신청 주황 포함 대비 기준 통과", () => {
  const fails = publicPairs
    .map(([label, fg, bg, min]) => ({ label, fg, bg, min, ratio: contrast(fg, bg) }))
    .filter((p) => p.ratio < p.min)
    .map((p) => `${p.label}: ${p.fg} / ${p.bg} = ${p.ratio.toFixed(2)} (기준 ${p.min})`);
  assert.deepEqual(fails, [], `대비 미달:\n${fails.join("\n")}`);
});

test("원장 결정 값(2026-11-09)이 토큰에 그대로 있다 — 주 버튼 검정·바탕 연회색·체험 신청 주황", () => {
  assert.equal(A("primary"), "#15181c");
  assert.equal(A("primary-hover"), "#2f343b");
  assert.equal(A("canvas"), "#f6f7f9");
  assert.equal(P("accent"), "#15181c");
  assert.equal(P("trial"), "#b94118");
  // 상태 다섯 갈래 — 같은 뜻은 어디서나 같은 색
  assert.deepEqual(
    ["success", "warning", "danger", "info", "neutral"].map((t) => [A(t), A(`${t}-soft`)]),
    [["#15803d", "#f0fdf4"], ["#b45309", "#fffbeb"], ["#b91c1c", "#fef2f2"], ["#1d4ed8", "#eff6ff"], ["#4b5563", "#f3f4f6"]],
  );
  // 위험 채움·테두리(2026-11-09 2차): 맑은 빨강 채움 · 올림 진한 빨강 · 연한 빨강 장식선
  assert.deepEqual([A("danger-fill"), A("danger-fill-hover"), A("danger-line")], ["#dc2626", "#b91c1c", "#fecaca"]);
});

test("대비 계산기 자체 확인 — 검정/흰 21:1, 같은 색 1:1, 교과서 값(#6b7280 4.8)", () => {
  assert.equal(contrast("#000000", "#ffffff").toFixed(1), "21.0");
  assert.equal(contrast("#777", "#777"), 1);
  assert.equal(contrast("#6b7280", "#ffffff").toFixed(1), "4.8");
});
