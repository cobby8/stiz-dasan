import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// 공개 홈페이지 UI 가드 (2026-11-13 원장 «사이트도 글자 두께 조정하고 깔끔하게 만들어»)
// 학원 앱 가드(tests/ui-unify-guard.test.mjs)의 공개 사이트 짝이다. 규칙 문서만으로는 안 지켜져서 숫자로 막는다.
//   1) 굵기는 네 단계만(400·500·600·700) — 공개 테마가 Tailwind 굵기 변수를 낮추고, CSS 에 700 보다 굵은 값을 두지 않는다
//   2) 주 버튼은 검정이 아니라 네이비(학원 앱과 같은 값). 어두운 띠·푸터 바탕(dark)과 섞지 않는다
//   3) 우선 세 곳(신청·시간표·로그인/가입)과 공용 부품의 굵은 글자·아이콘은 지금 개수보다 늘지 않는다
// 아래 «빚» 숫자는 지금 남아 있는 개수다. 줄였으면 숫자도 같이 내린다. 🚫 숫자를 올려서 통과시키지 마라.

const THEME_CSS = "src/components/public-sport.css";
// 공개 화면에 걸리는 CSS. globals.css 의 .admin-table-scope 줄은 학원 앱 가드가 본다(여기서는 그 블록만 뺀다).
const PUBLIC_CSS = [THEME_CSS, "src/components/landing/public-home.css", "src/app/annual/annual-months.css", "src/app/globals.css"];

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function walk(p, out = []) {
  if (statSync(p).isFile()) {
    if (p.endsWith(".tsx")) out.push(p);
    return out;
  }
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const q = join(p, entry.name);
    if (entry.isDirectory()) walk(q, out);
    else if (q.endsWith(".tsx")) out.push(q);
  }
  return out;
}
const count = (paths, re) =>
  paths.flatMap((p) => walk(p)).reduce((n, f) => n + (readFileSync(f, "utf8").match(re) || []).length, 0);

const HEAVY = /\bfont-(black|extrabold)\b|\bfont-\[[89]00\]|fontWeight:\s*[89]00/g;
const ICON = /material-symbols-outlined|<FontFreeIcon\b|<SymbolIcon\b|<svg\b/g;
// 그림 이모지(🏀🎓 등)와 시계류(⏰). 닫기 ✕·체크 ✓ 같은 글자 기호는 세지 않는다.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{23E9}-\u{23FA}]/gu;

// 우선 세 곳 + 공용 부품. 갚아야 할 빚(2026-11-13 시점) — 줄어들기만 해야 한다.
const AREAS = {
  // heavy 20 = 페이지·카드 제목(h1~h3)의 font-black. 테마가 700 으로 그린다. 버튼·값·배지에는 쓰지 않는다.
  // icons 2 = 자주 묻는 질문 펼침 화살표 · 약관 펼침 화살표
  apply: { paths: ["src/app/apply"], heavy: 20, icons: 2 },
  // heavy 2 = 페이지 제목 · 필터 창 제목
  schedule: { paths: ["src/app/schedule", "src/components/ScheduleTableView.tsx"], heavy: 2, icons: 0 },
  // icons 4 = 비밀번호 보기/숨기기 눈 2 · Apple 로고(애플 가이드) · 약관 창 닫기
  auth: { paths: ["src/app/login", "src/components/auth"], heavy: 0, icons: 4 },
  // icons 10 = 헤더(사진 올리기·메뉴 펼침·닫기) 3 · 계정 버튼(사진 올리기) 3 · 푸터(주소·전화) 2 · 후기 넘김 화살표 2
  shared: {
    paths: [
      "src/components/landing",
      "src/components/PublicHeader.tsx",
      "src/components/PublicFooter.tsx",
      "src/components/PublicAccountControls.tsx",
      "src/components/PublicPageLayout.tsx",
      "src/components/PublicSiteTheme.tsx",
    ],
    heavy: 0,
    icons: 10,
  },
};

test("공개 테마가 굵기 네 단계를 정한다 — Tailwind 굵기 클래스를 한 번에 낮춘다", () => {
  const css = stripComments(readFileSync(THEME_CSS, "utf8"));
  // 첫 블록(.stiz-public-sport { ... }) = 공개 화면 전체를 감싸는 선택자(PublicSiteTheme 가 붙인다)
  const root = css.slice(css.indexOf(".stiz-public-sport {"), css.indexOf("}", css.indexOf(".stiz-public-sport {")));
  for (const [name, value] of [["medium", 500], ["semibold", 600], ["bold", 600], ["extrabold", 700], ["black", 700]]) {
    assert.match(root, new RegExp(`--font-weight-${name}:\\s*${value};`), `.stiz-public-sport 의 --font-weight-${name} 은 ${value} 여야 한다`);
  }
  // 학원 앱 테마와 같은 값이어야 한다(두 벌이 어긋나면 로그인 전후 글자 굵기가 달라진다)
  const academy = stripComments(readFileSync("src/app/academy-theme.css", "utf8"));
  for (const name of ["medium", "semibold", "bold", "extrabold", "black"]) {
    const pick = (text) => text.match(new RegExp(`--font-weight-${name}:\\s*(\\d+);`))?.[1];
    assert.equal(pick(root), pick(academy), `--font-weight-${name} 이 학원 앱 테마와 다르다`);
  }
});

test("공개 CSS 에 700 보다 굵은 font-weight 숫자가 없다", () => {
  const found = [];
  for (const file of PUBLIC_CSS) {
    let css = stripComments(readFileSync(file, "utf8"));
    // 관리자 표 규칙(.admin-table-scope …{ })은 여기서 보지 않는다 — 학원 앱 쪽 가드 담당
    if (file.endsWith("globals.css")) css = css.replace(/[^{}]*\.admin-table-scope[^{}]*\{[^{}]*\}/g, "");
    for (const m of css.matchAll(/font-weight:\s*(\d+)/g)) {
      if (Number(m[1]) > 700) found.push(`${file}: font-weight ${m[1]}`);
    }
    assert.doesNotMatch(css, /font-weight:\s*(bolder|bold\b)/, `${file}: bold 키워드 대신 숫자(600·700)를 쓴다`);
  }
  assert.deepEqual(found, [], `700 보다 굵은 값:\n${found.join("\n")}`);
});

test("공개 주 버튼 토큰은 검정이 아니라 네이비 — 어두운 바탕 토큰과 따로 둔다", () => {
  const css = stripComments(readFileSync(THEME_CSS, "utf8"));
  const root = css.slice(css.indexOf(".stiz-public-sport {"), css.indexOf("}", css.indexOf(".stiz-public-sport {")));
  const token = (name) => root.match(new RegExp(`--color-public-${name}:\\s*(#[0-9a-fA-F]{6});`))?.[1]?.toLowerCase();
  assert.equal(token("accent"), "#1e3a8a", "주 버튼·링크 = 네이비");
  assert.equal(token("strong"), "#1e40af", "주 버튼 올림 = 한 단계 밝은 네이비");
  assert.notEqual(token("accent"), token("dark"), "주 버튼 색과 어두운 띠·푸터 바탕은 다른 토큰·다른 값이다");
  // 검정·회색 계열(빨강·초록·파랑 값이 거의 같은 색)이면 실패 — «검정·회색 주 버튼 금지»
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(token("accent").slice(i, i + 2), 16));
  assert.ok(Math.max(r, g, b) - Math.min(r, g, b) >= 60, "주 버튼 색이 무채색(검정·회색)이다");
  // 꽉 찬 주 버튼은 accent 로 칠하고, 푸터·어두운 띠는 dark 로 칠한다
  assert.match(css, /\.public-btn-primary\s*\{[^}]*background:\s*var\(--color-public-accent\)/);
  assert.match(css, /\.public-site-footer\s*\{[^}]*background:\s*var\(--color-public-dark\)/);
  assert.match(css, /\.public-utility-bar\s*\{[^}]*background:\s*var\(--color-public-dark\)/);
  // «체험 신청» 입구 주황은 그대로(2026-11-09 원장 결정 4)
  assert.equal(token("trial"), "#b94118");
});

test("공용 버튼 굵기 — 주 버튼 600, 보조·글자 버튼 500", () => {
  const css = stripComments(readFileSync(THEME_CSS, "utf8"));
  const shared = css.match(/:is\(\.public-btn-primary, \.public-btn-secondary, \.public-btn-text\)\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(shared, /font-weight:\s*500;/);
  assert.match(shared, /min-height:\s*44px;/, "터치 영역 44px 은 줄이지 않는다");
  const primary = css.match(/\.stiz-public-sport \.public-btn-primary\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(primary, /font-weight:\s*600;/);
});

for (const [name, area] of Object.entries(AREAS)) {
  test(`${name}: 굵은 글자(font-black·font-extrabold)가 늘지 않는다`, () => {
    const n = count(area.paths, HEAVY);
    assert.ok(n <= area.heavy, `${name} 굵은 글자 ${n}개 — 기준 ${area.heavy}개보다 늘었다. 제목만 700, 버튼·값·배지는 font-medium/font-semibold.`);
  });
  test(`${name}: 아이콘이 늘지 않는다 — 버튼·제목·목록은 글자로 말한다`, () => {
    const n = count(area.paths, ICON);
    assert.ok(n <= area.icons, `${name} 아이콘 ${n}개 — 기준 ${area.icons}개보다 늘었다. 닫기·펼침·비밀번호 보기처럼 글자를 둘 자리가 없는 조작만 남긴다.`);
  });
  test(`${name}: 그림 이모지를 쓰지 않는다`, () => {
    const n = count(area.paths, EMOJI);
    assert.equal(n, 0, `${name} 에 그림 이모지 ${n}개 — 글자로 쓴다`);
  });
}

test("체험 신청 완료 화면 — 주인공은 결제하기(주황) 하나, 홈으로는 테두리 버튼·아이콘 없음", () => {
  const form = readFileSync("src/app/apply/trial/TrialApplicationForm.tsx", "utf8");
  const done = form.slice(form.indexOf("if (completed) {"), form.indexOf("public-form-card"));
  assert.match(done, /bg-\[var\(--color-public-trial\)\][^"]*font-semibold/, "결제하기 버튼은 체험 주황 + 강조 굵기");
  assert.match(done, /<Link href="\/" className="public-btn-secondary">\s*홈으로 돌아가기/, "홈으로 돌아가기는 보조(테두리) 버튼");
  assert.doesNotMatch(done, /bg-\[var\(--color-public-dark\)\]/, "꽉 찬 검정 버튼을 다시 쓰지 않는다");
  assert.doesNotMatch(done, /FontFreeIcon|material-symbols/, "완료 화면에 아이콘을 다시 넣지 않는다");
  // 안내 상자: 라벨은 보조색·보통 굵기, 값은 본문색·라벨 굵기
  const guide = readFileSync("src/app/apply/trial/TrialVisitGuide.tsx", "utf8");
  assert.match(guide, /<dt className="w-14 shrink-0 text-\[var\(--color-public-muted\)\]">/);
  assert.match(guide, /<dd className="min-w-0 break-keep font-medium text-\[var\(--color-public-ink\)\]">/);
  assert.doesNotMatch(guide, /font-(bold|semibold|black|extrabold)/, "안내 상자 값·라벨을 다시 굵게 하지 않는다");
});

test("아이디·비밀번호 찾기 화면도 공개 테마 안이다 — 공개 경로 목록에 없어서 직접 알린다", () => {
  // /login/forgot 은 isPublicSitePath 의 «정확히 /login» 에 안 걸려 테마 클래스(색 토큰·굵기)가 통째로 빠졌었다
  const page = readFileSync("src/app/login/forgot/page.tsx", "utf8");
  assert.match(page, /<PublicSiteTheme className="public-auth-page" publicScope>/);
  // 공개 공용 틀(PublicPageLayout)도 주소 목록에 기대지 않는다 — /account-deletion 처럼 목록에 없는 주소에서 테마가 빠졌었다
  const layout = readFileSync("src/components/PublicPageLayout.tsx", "utf8");
  assert.match(layout, /<PublicSiteTheme publicScope className="min-h-screen/);
});

test("가드 자체 확인 — 아이콘·굵은 글자·이모지를 세고, 글자 기호는 세지 않는다", () => {
  const sample = `<span className="material-symbols-outlined">home</span><FontFreeIcon name="x" /><svg viewBox="0 0 1 1" />
    <b className="font-black font-extrabold font-[800] font-bold">⏰🎓🏀 ✕ ✓ →</b>`;
  assert.equal(sample.match(ICON).length, 3);
  assert.equal(sample.match(HEAVY).length, 3);
  assert.equal(sample.match(EMOJI).length, 3);
});
