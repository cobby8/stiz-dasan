import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// UI 통일 가드 (2026-11-13 원장 «UI가 개발 단계처럼 어설프다 · 흑백이다 · 아이콘 빼자 · 글자가 두껍다»)
// 규칙 문서만으로는 안 지켜져서(실측: 공용 버튼 등급을 만들고도 관리자 화면 사용률 15%) 숫자로 막는다.
// 아래 «빚» 숫자는 지금 남아 있는 옛 방식의 개수다. 화면을 고칠 때마다 줄이고, 줄였으면 이 숫자도 같이 내린다.
// 🚫 숫자를 올려서 통과시키지 마라 — 새 코드는 공용 부품(academy-button-*, AdminPageHeader)을 쓰면 늘지 않는다.

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const count = (dirs, re) =>
  dirs.flatMap((d) => walk(d)).reduce((n, f) => n + (readFileSync(f, "utf8").match(re) || []).length, 0);

// 학원 앱(관리자·학부모·선생님) 화면과 그 공용 부품
const ACADEMY_DIRS = [
  "src/app/admin",
  "src/app/mypage",
  "src/app/staff",
  "src/app/driver",
  "src/components/admin",
  "src/components/parent",
  "src/components/staff",
  "src/components/academy",
  "src/components/shuttle",
];

// 갚아야 할 빚(2026-11-13 1단계 시점 804·645·54 → 2단계 «원생» 화면 정리 뒤 766·612·51). 줄어들기만 해야 한다.
const DEBT = {
  heavyWeight: 766, // font-black · font-extrabold · font-[800] · fontWeight: 800 — 화면에서는 테마가 700 으로 낮춰 그리지만 코드에서도 걷어낸다
  icons: 612, // material-symbols-outlined · <FontFreeIcon · <SymbolIcon(파일마다 따로 만든 아이콘 부품) — 글자를 둘 자리가 없는 조작만 남긴다
  adminRawH1: 51, // 관리자 화면의 직접 쓴 <h1> — AdminPageHeader 로 옮긴다
};

test("굵은 글자(font-black·font-extrabold)가 늘지 않는다", () => {
  const n = count(ACADEMY_DIRS, /\bfont-(black|extrabold)\b|\bfont-\[[89]00\]|fontWeight:\s*[89]00/g);
  assert.ok(n <= DEBT.heavyWeight, `font-black/extrabold ${n}개 — 기준 ${DEBT.heavyWeight}개보다 늘었다. 굵기는 400·500·600·700 네 단계만 쓴다.`);
});

test("아이콘이 늘지 않는다 — 메뉴·버튼·탭은 글자로 말한다", () => {
  const n = count(ACADEMY_DIRS, /material-symbols-outlined|<FontFreeIcon\b|<SymbolIcon\b/g);
  assert.ok(n <= DEBT.icons, `아이콘 ${n}개 — 기준 ${DEBT.icons}개보다 늘었다. 닫기·뒤로·펼침처럼 글자를 둘 자리가 없는 조작만 아이콘을 쓴다.`);
});

test("관리자 화면에 직접 쓴 <h1> 이 늘지 않는다 — AdminPageHeader 를 쓴다", () => {
  const n = count(["src/app/admin"], /<h1\b/g);
  assert.ok(n <= DEBT.adminRawH1, `관리자 <h1> ${n}개 — 기준 ${DEBT.adminRawH1}개보다 늘었다.`);
});

test("관리자 옆 메뉴는 아이콘 없이 글자만, 지금 있는 메뉴는 보조 색으로 표시한다", () => {
  const shell = readFileSync("src/app/admin/AdminShellClient.tsx", "utf8");
  assert.doesNotMatch(shell, /material-symbols-outlined/, "옆 메뉴에 아이콘 글꼴이 다시 들어갔다");
  assert.doesNotMatch(shell, /NAV_SYMBOLS/, "이모지→아이콘 표가 다시 생겼다");
  const navItem = shell.slice(shell.indexOf("function NavItem"));
  assert.match(navItem, /color-academy-secondary-soft/, "활성 메뉴 바탕은 보조 색(하늘색)이다");
  assert.match(navItem, /aria-current=\{active \? "page" : undefined\}/, "색만으로 알리지 않는다 — aria-current 를 유지한다");
});

test("테마가 굵기 네 단계와 주 색·보조 색을 정한다", () => {
  const css = readFileSync("src/app/academy-theme.css", "utf8");
  // Tailwind v4 는 font-bold 등을 var(--font-weight-*) 로 그린다 — .academy-app 안에서 이 변수를 낮춰 한 번에 가볍게 한다
  for (const [name, value] of [["medium", 500], ["semibold", 600], ["bold", 600], ["extrabold", 700], ["black", 700]]) {
    assert.match(css, new RegExp(`--font-weight-${name}:\\s*${value};`), `--font-weight-${name} 은 ${value} 여야 한다`);
  }
  // 테마 파일 자체에도 700 보다 굵은 값을 두지 않는다
  const heavier = [...css.matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1])).filter((w) => w > 700);
  assert.deepEqual(heavier, [], `700 보다 굵은 font-weight: ${heavier.join(", ")}`);
  for (const token of ["secondary", "secondary-strong", "secondary-soft", "secondary-ink"]) {
    assert.match(css, new RegExp(`--color-academy-${token}:\\s*#[0-9a-f]{6};`), `--color-academy-${token} 토큰이 없다`);
  }
  // 고른 칩은 보조 색 — 꽉 찬 주 색은 주 버튼만
  const choice = css.slice(css.indexOf('.academy-choice[aria-pressed="true"]'));
  assert.match(choice.slice(0, 400), /border: 2px solid var\(--color-academy-secondary-strong\)/);
});

test("학원 앱 CSS(전역·모듈)에 700 보다 굵은 글자를 숫자로 박지 않는다", () => {
  // 테마 변수 덮어쓰기는 font-* 클래스에만 닿는다 — 숫자로 직접 적은 굵기는 여기서 막는다
  const files = [
    "src/app/admin/finance/prepare/workbench.module.css",
    "src/components/shuttle/DriverWorkspace.module.css",
    "src/components/shuttle/DriverGpsIndicator.module.css",
  ];
  for (const file of files) {
    const heavier = [...readFileSync(file, "utf8").matchAll(/font-weight:\s*(\d+)/g)].map((m) => Number(m[1])).filter((w) => w > 700);
    assert.deepEqual(heavier, [], `${file}: 700 보다 굵은 font-weight ${heavier.join(", ")}`);
  }
  const globals = readFileSync("src/app/globals.css", "utf8");
  assert.match(globals, /\.admin-table-scope th \{[^}]*font-weight:\s*600/, "관리자 표 머리글은 600(옛 900)");
});

test("보기 전환의 고른 칸은 옅은 바탕만이 아니라 테두리로도 구분된다", () => {
  const toggle = readFileSync("src/components/admin/list/ListViewToggle.tsx", "utf8");
  assert.match(toggle, /aria-pressed=\{selected\}/);
  assert.match(toggle, /ring-1 ring-inset ring-\[var\(--color-academy-secondary-strong\)\]/);
});

test("페이지 머리말 부품이 제목 모양 한 곳(.academy-page-title)을 쓴다", () => {
  const header = readFileSync("src/components/admin/AdminPageHeader.tsx", "utf8");
  assert.match(header, /<h1 className="academy-page-title">/);
  assert.doesNotMatch(header, /font-(black|extrabold|bold)/, "굵기는 테마 클래스가 정한다");
  const css = readFileSync("src/app/academy-theme.css", "utf8");
  assert.match(css, /\.academy-app \.academy-page-title \{[^}]*font-weight: 700;/);
  assert.match(css, /\.academy-app \.academy-button-sm \{[^}]*min-height: 2\.25rem;/);
  assert.match(css, /@media \(any-pointer: coarse\) \{\s*\.academy-app \.academy-button-sm \{ min-height: 2\.75rem; \}/, "터치 화면에서는 작은 버튼도 44px");
});
