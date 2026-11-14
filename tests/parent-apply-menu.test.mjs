// 학부모 앱 «신청» 메뉴 (2026-11-14 원장 결정표 c9) — 유니폼 신청·체육관 대관·방학특강 신청으로 가는 길.
//  ① 메뉴: 한 줄 행 3개 · 앱 안 주소는 전부 /mypage 아래(설치 앱이 범위 밖으로 새지 않게) · 그 주소의 화면이 실제로 있다
//  ② 유니폼: 본사 쇼핑몰 직접 구매(공개 /apply/uniform 과 같은 주소) · 바깥 링크 규칙으로 연다
//  ③ 대관·방학특강: 공개 화면의 신청 부품을 그대로 쓴다(중복 구현 없음) · 화면 사이 이동도 앱 안
//  ④ 미리 채움: 로그인한 학부모 이름·연락처 · 아이는 한 명일 때만 · 임시 생일 제외
//  ⑤ 공개 화면(/seasonal·/rental)의 동작은 그대로
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

// TS/TSX 파일을 CommonJS 로 올린다. mocks 에 없는 «@/…»·상대 경로는 진짜 파일을 같은 방식으로 따라간다.
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const mod = new Module(absolute);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(resolve("."));
  mod.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.endsWith(".css")) return {};
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? `src/${name.slice(2)}` : resolve(absolute, "..", name);
      const file = [".ts", ".tsx", ""].map((ext) => base + ext).find((p) => existsSync(p) && statSync(p).isFile());
      if (file) return load(file, mocks);
    }
    return require(name);
  };
  mod._compile(compiled, absolute);
  return mod.exports;
}

const Link = ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children);
const menu = load("src/lib/mypage/parentApplyMenu.ts");

/** 앱 안 주소 → 그 화면 파일(동적 칸 [slug] 포함) */
const pageFileOf = (href) => `src/app${href}/page.tsx`;

// ── ① 메뉴 ───────────────────────────────────────────────────────────────────

test("① 신청 메뉴 = 유니폼 신청·체육관 대관·방학특강 신청, 앱 안 주소는 전부 /mypage 아래", () => {
  assert.deepEqual(menu.PARENT_APPLY_ITEMS.map((item) => item.label), ["유니폼 신청", "체육관 대관", "방학특강 신청"]);
  for (const item of menu.PARENT_APPLY_ITEMS) {
    if (item.outside) {
      assert.match(item.href, /^https:\/\//, `${item.label}: 바깥 주소는 https`);
      continue;
    }
    assert.ok(item.href.startsWith("/mypage/"), `${item.label}: 앱 범위 밖 주소 ${item.href}`);
    assert.ok(existsSync(pageFileOf(item.href)), `${item.label}: 화면이 없다 ${pageFileOf(item.href)}`);
  }
  assert.equal(menu.PARENT_APPLY_ITEMS.filter((item) => item.outside).length, 1, "바깥 주소는 유니폼 하나뿐");
  assert.ok(existsSync(pageFileOf(menu.PARENT_APPLY_HOME)));
  for (const tail of ["", "/[slug]", "/[slug]/apply"]) assert.ok(existsSync(pageFileOf(`${menu.PARENT_SEASONAL_APPLY_BASE}${tail}`)), tail);
});

test("① 메뉴 화면: 한 줄 행 3개 · 홈으로 돌아가는 길 · 아이콘·색 코드 없음", async () => {
  const Page = load("src/app/mypage/apply/page.tsx", {
    "next/link": { default: Link, __esModule: true },
    "next/navigation": { redirect: (to) => { throw new Error(`REDIRECT ${to}`); } },
    "@/lib/auth-guard": { requireVerifiedParent: async () => ({ appUserId: "parent-a" }) },
  }).default;
  const html = renderToStaticMarkup(await Page());
  assert.equal((html.match(/<li>/g) ?? []).length, 3);
  assert.match(html, /<a href="\/mypage"[^>]*aria-label="홈으로"/);
  assert.match(html, /<a href="\/mypage\/rental"[^>]*>.*?체육관 대관.*?재원생 2시간 무료/s);
  assert.match(html, /<a href="\/mypage\/seasonal\/apply"[^>]*>.*?방학특강 신청/s);
  // 유니폼 = 바깥 링크 규칙(새 창 + data-outside-link — 스토어 앱이 못 열면 주소 복사 안내)
  assert.match(html, /<a href="https:\/\/stiz\.kr\/[^"]+" target="_blank" rel="noopener noreferrer" data-outside-link="true"[^>]*>.*?유니폼 신청.*?본사 쇼핑몰/s);
  const source = read("src/app/mypage/apply/page.tsx");
  assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b|font-(extrabold|black)|material-symbols|UiIcon/);
  assert.match(source, /min-h-12/, "터치 44px 이상");
  // 로그인이 풀렸으면 화면을 그리지 않는다
  const Out = load("src/app/mypage/apply/page.tsx", {
    "next/link": { default: Link, __esModule: true },
    "next/navigation": { redirect: (to) => { throw new Error(`REDIRECT ${to}`); } },
    "@/lib/auth-guard": { requireVerifiedParent: async () => { throw new Error("UNAUTHORIZED"); } },
  }).default;
  await assert.rejects(Out(), /REDIRECT \/mypage\/continue\?bounced=1/);
});

test("① 홈에 «신청» 줄이 늘 있다 · 아래 탭은 홈이 켜진다", () => {
  const home = read("src/app/mypage/MyPageClient.tsx");
  const always = home.slice(home.indexOf('<ul aria-label="더 보기"'));
  assert.match(always.slice(0, 1800), /<Link href="\/mypage\/apply" className=\{TODO_ROW\}>\s*<span[^>]*>신청<\/span>/);
  const nav = load("src/app/mypage/MyPageBottomNav.tsx", { "next/link": { default: Link }, "next/navigation": { usePathname: () => "/mypage" } });
  const tabOf = (path) => nav.PARENT_TABS.find((tab) => nav.isParentTabActive(tab, path))?.label;
  // 신청 메뉴에서 들어간 화면은 모두 «홈» — 방학특강 신청은 더 긴 주소가 이겨 수업 탭(/mypage/seasonal 결석·보강)에 먹히지 않는다
  assert.deepEqual([tabOf("/mypage/apply"), tabOf("/mypage/rental"), tabOf("/mypage/seasonal/apply"), tabOf("/mypage/seasonal/apply/winter-2027/apply")], ["홈", "홈", "홈", "홈"]);
  assert.deepEqual([tabOf("/mypage/seasonal"), tabOf("/mypage"), tabOf("/mypage/payments/checkout"), tabOf("/mypage/settings")], ["수업", "홈", "청구", undefined]);
  // 어느 경로에서도 탭은 하나만 켜진다
  for (const path of ["/mypage", "/mypage/seasonal", "/mypage/seasonal/apply/x", "/mypage/news/1", "/mypage/requests/r1", "/mypage/history"]) {
    assert.equal(nav.PARENT_TABS.filter((tab) => nav.isParentTabActive(tab, path)).length, 1, path);
  }
});

// ── ② 유니폼 ─────────────────────────────────────────────────────────────────

test("② 유니폼 = 본사 직접 구매: 공개 /apply/uniform 이 보내는 주소와 같다", () => {
  const uniform = menu.PARENT_APPLY_ITEMS.find((item) => item.key === "uniform");
  const publicRedirect = read("src/app/apply/uniform/page.tsx").match(/permanentRedirect\("([^"]+)"\)/)?.[1];
  assert.ok(publicRedirect, "공개 유니폼 신청은 본사 쇼핑몰로 넘긴다");
  assert.equal(uniform.href, publicRedirect);
  // 앱 안에서 /apply/uniform 을 거치지 않는다(범위 밖 주소라 주소창이 뜬다)
  assert.doesNotMatch(read("src/lib/mypage/parentApplyMenu.ts").replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ""), /"\/apply/);
});

// ── ③ 대관·방학특강 ──────────────────────────────────────────────────────────

test("③ 앱 안 화면은 공개 신청 부품을 그대로 그린다(신청 로직을 다시 만들지 않는다)", () => {
  const rental = read("src/app/mypage/rental/page.tsx");
  assert.match(rental, /import RentalClient from "@\/app\/rental\/RentalClient";/);
  assert.match(rental, /import RentalGuide from "@\/app\/rental\/RentalGuide";/);
  assert.match(rental, /<RentalClient homeHref="\/mypage" \/>/);
  assert.doesNotMatch(rental, /submitRentalRequest|calculateRentalFee|prisma/, "저장·요금 계산을 여기서 하지 않는다");

  const list = read("src/app/mypage/seasonal/apply/page.tsx");
  assert.match(list, /<SeasonalListClient basePath=\{PARENT_SEASONAL_APPLY_BASE\} \/>/);
  const detail = read("src/app/mypage/seasonal/apply/[slug]/page.tsx");
  assert.match(detail, /<SeasonalDetailClient slug=\{slug\} basePath=\{PARENT_SEASONAL_APPLY_BASE\} \/>/);
  const form = read("src/app/mypage/seasonal/apply/[slug]/apply/page.tsx");
  assert.match(form, /<SeasonalApplyClient\s+slug=\{slug\}\s+basePath=\{PARENT_SEASONAL_APPLY_BASE\}\s+homeHref="\/mypage"\s+prefill=\{seasonalApplyPrefill\(home\)\}/);
  assert.match(form, /getMyPageData\(parent\.appUserId\)/, "미리 채움은 서버가 확인한 로그인 사용자 것만");
  for (const source of [rental, list, detail, form]) {
    assert.match(source, /requireVerifiedParent\(\)/);
    assert.match(source, /<ParentEmbeddedPublic /);
    assert.doesNotMatch(source, /PublicPageLayout/, "공개 머리줄·바닥글(앱 밖 링크)을 들이지 않는다");
    assert.doesNotMatch(source, /fetch\(|\$queryRawUnsafe|\$executeRawUnsafe/);
  }
});

test("③ 신청 부품 안의 이동 주소는 넘겨받은 값만 쓴다(앱 안에서 공개 주소로 새지 않는다)", () => {
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
  const list = strip(read("src/components/seasonal/SeasonalListClient.tsx"));
  const detail = strip(read("src/components/seasonal/SeasonalDetailClient.tsx"));
  const form = strip(read("src/components/seasonal/SeasonalApplyClient.tsx"));
  const rental = strip(read("src/app/rental/RentalClient.tsx"));
  for (const [name, source] of [["목록", list], ["상세", detail], ["신청서", form]]) {
    assert.doesNotMatch(source, /href=\{`\/seasonal|href="\/seasonal|href="\/"/, `${name}: 박아 둔 공개 주소`);
    assert.match(source, /basePath = "\/seasonal"/, `${name}: 공개 화면 기본값은 그대로`);
  }
  assert.match(list, /href=\{`\$\{basePath\}\/\$\{program\.slug\}`\}/);
  assert.match(detail, /href=\{basePath\}/);
  assert.match(detail, /href=\{`\$\{basePath\}\/\$\{slug\}\/apply`\}/);
  assert.equal((form.match(/href=\{`\$\{basePath\}\/\$\{slug\}`\}/g) ?? []).length, 4);
  assert.match(form, /<Link href=\{homeHref\} className="public-btn-primary">홈으로<\/Link>/);
  assert.match(form, /homeHref = "\/"/);
  assert.match(form, /<DoneView slug=\{slug\} basePath=\{basePath\} homeHref=\{homeHref\} /);
  // 접수 API 는 공개 화면과 같은 주소(신청 로직 한 벌)
  assert.match(form, /fetch\(`\/api\/seasonal\/\$\{encodeURIComponent\(slug\)\}\/applications`/);
  assert.match(rental, /RentalClient\(\{ homeHref = "\/" \}/);
  assert.match(rental, /<Link href=\{homeHref\} className="public-btn-text mt-2">홈으로<\/Link>/);
  assert.doesNotMatch(rental, /href="\/"/);
});

test("③ 앱 안 틀: 공개 테마를 틀 안에만 걸고, 하단 고정 바를 아래 탭 위로 올린다", () => {
  const Frame = load("src/components/parent/ParentEmbeddedPublic.tsx", {
    "next/link": { default: Link, __esModule: true },
    "next/navigation": { usePathname: () => "/mypage/rental" },
  }).default;
  const html = renderToStaticMarkup(React.createElement(Frame, { backHref: "/mypage/apply", backLabel: "신청 메뉴로", title: "체육관 대관" }, React.createElement("p", null, "내용")));
  assert.match(html, /<a href="\/mypage\/apply"[^>]*aria-label="신청 메뉴로"/);
  assert.match(html, /<h1[^>]*>체육관 대관<\/h1>/);
  assert.match(html, /class="stiz-public-sport parent-embedded-public[^"]*"><p>내용<\/p>/, "/mypage 주소에서도 공개 테마 클래스가 붙는다");
  assert.match(html, /@media \(max-width: 767\.98px\)\{\.parent-embedded-public \[data-public-bottom-bar\]\{bottom:calc\(3rem \+ env\(safe-area-inset-bottom\)\) !important\}\}/);
  // 아래 탭 높이(48px = 3rem)·휴대폰에서만 보임(md:hidden)과 같은 기준
  const nav = read("src/app/mypage/MyPageBottomNav.tsx");
  assert.match(nav, /md:hidden fixed bottom-0/);
  assert.match(nav, /flex h-12 w-full/);
  // 고정 바는 이 표식을 단다
  assert.match(read("src/components/public-floating.tsx"), /data-public-bottom-bar=""/);
});

// ── ④ 미리 채움 ──────────────────────────────────────────────────────────────

test("④ 미리 채움: 보호자 이름·연락처 · 아이는 한 명일 때만 · 임시 생일은 비운다", () => {
  const { seasonalApplyPrefill } = load("src/lib/mypage/parentApplyPrefill.ts");
  assert.deepEqual(
    seasonalApplyPrefill({ parent: { name: " 김보호 ", phone: "01012345678" }, children: [{ name: "김하늘", birthDate: new Date("2016-03-04T15:00:00Z") }] }),
    { parentName: "김보호", parentPhone: "010-1234-5678", childName: "김하늘", childBirthDate: "2016-03-05" },
    "생년월일은 KST 달력 날짜(자정 경계 — UTC 15:00 = 다음 날)",
  );
  // 형제면 누구 신청인지 모른다 → 아이 칸은 비운다
  assert.deepEqual(
    seasonalApplyPrefill({ parent: { name: "김보호", phone: "010-1234-5678" }, children: [{ name: "첫째", birthDate: "2015-01-01" }, { name: "둘째", birthDate: "2017-01-01" }] }),
    { parentName: "김보호", parentPhone: "010-1234-5678" },
  );
  // 임시 생일(2000-01-01)은 채우지 않는다
  assert.deepEqual(seasonalApplyPrefill({ parent: { name: "김보호", phone: null }, children: [{ name: "김하늘", birthDate: "2000-01-01T00:00:00.000Z" }] }), { parentName: "김보호", childName: "김하늘" });
  for (const empty of [null, undefined, {}, { parent: null, children: null }, { parent: { name: " ", phone: "" }, children: [] }]) assert.deepEqual(seasonalApplyPrefill(empty), {});
  // 신청서는 넘겨받은 값을 처음 값으로만 쓴다(고칠 수 있다)
  assert.match(read("src/components/seasonal/SeasonalApplyClient.tsx"), /useState<FormState>\(\(\) => \(\{ \.\.\.EMPTY_FORM, \.\.\.prefill \}\)\)/);
});

// ── ⑤ 공개 화면 ──────────────────────────────────────────────────────────────

test("⑤ 공개 화면은 그대로: /seasonal·/rental 은 속성을 넘기지 않고(기본값), 대관 안내는 같은 부품", () => {
  assert.match(read("src/app/seasonal/page.tsx"), /<SeasonalListClient \/>/);
  assert.match(read("src/app/seasonal/[slug]/page.tsx"), /<SeasonalDetailClient slug=\{slug\} \/>/);
  assert.match(read("src/app/seasonal/[slug]/apply/page.tsx"), /<SeasonalApplyClient slug=\{slug\} \/>/);
  const rental = read("src/app/rental/page.tsx");
  assert.match(rental, /<RentalGuide \/>\s*<RentalClient \/>/);
  assert.match(rental, /export const revalidate = 3600;/);
  const guide = read("src/app/rental/RentalGuide.tsx");
  for (const text of ["요금", "이용 규칙", "진행 순서", "재원생 가족은 2시간까지 무료", "RENTAL_FEE.firstHour"]) assert.ok(guide.includes(text), text);
  assert.doesNotMatch(guide, /^"use client"/, "훅 없는 서버 부품");
});
