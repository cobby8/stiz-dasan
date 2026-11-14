import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const require = createRequire(import.meta.url);
function compile(path, imports = {}) {
  const source = readFileSync(path, "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: (name) => name in imports ? imports[name] : require(name) });
  return module.exports.default;
}
// default 가 아닌 이름 붙은 내보내기가 필요한 순수 모듈용
function compileModule(path) {
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require, Intl, Date, Number, Math });
  return module.exports;
}
function compileModuleWith(path, imports) {
  const compiled = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, require: (name) => name in imports ? imports[name] : require(name) });
  return module.exports;
}
const Link = ({ children, ...props }) => React.createElement("a", props, children);
const Empty = compile("src/components/account/EmptyParentState.tsx", { "next/link": { default: Link }, "@/components/account/child-link-api": {}, "./child-link-api": {}, "@/components/parent/customerMessage": { customerMessage: (_raw, fallback) => fallback }, "@/components/pwa/useInstalledApp": { useInstalledApp: () => false } });
const AccountLinks = compile("src/components/account/AccountLinks.tsx", { "next/link": { default: Link } });

test("비로그인 가족 연결 진입은 로그인 화면이 읽는 복귀 주소를 보존한다", async () => {
  let location = "";
  const Page = compile("src/app/account/children/page.tsx", {
    "next/image": { default: () => null }, "next/link": { default: Link },
    "next/navigation": { redirect: (href) => { location = href; throw new Error("TEST_REDIRECT"); } },
    "@/lib/auth-guard": { requireAuth: async () => { throw new Error("NOT_SIGNED_IN"); } },
    "@/lib/account-view-access": { getAccountViewAccess: async () => { throw new Error("로그인 전 조회 금지"); } },
    "@/components/academy/AcademyTheme": { default: () => null },
    "@/components/AccountViewSwitcher": { default: () => null },
    "@/app/mypage/children/ChildConnectionsClient": { default: () => null },
  });
  await assert.rejects(Page(), /TEST_REDIRECT/);
  const target = new URL(location, "https://fixture.invalid");
  assert.equal(target.pathname, "/login");
  assert.equal(target.searchParams.get("redirect"), "/account/children");
  assert.match(readFileSync("src/app/login/page.tsx", "utf8"), /searchParams\.get\("redirect"\)/);
});

test("자녀가 없어도 신규 신청과 기존 등록 연결을 구분해 제공한다", () => {
  const html = renderToStaticMarkup(React.createElement(Empty, { pendingSeasonalChildren: [] }));
  for (const href of ["/apply/enroll", "/apply/trial", "/mypage/children"]) assert.ok(html.includes(`href="${href}"`));
  assert.ok(!html.includes("방학특강 신청 내역"));
  assert.ok(!html.includes("연결되었습니다"));
});

test("정식 자녀가 없고 특강만 신청한 경우 신청 내역과 연결 경로가 함께 표시된다", () => {
  const child = { childName: "합성 학생", childGrade: "초4", offeringTitles: ["합성 특강"], upcomingCount: 2, pastCount: 0, attendance: { present: 0, late: 0, absent: 0, excused: 0 } };
  const html = renderToStaticMarkup(React.createElement(Empty, { pendingSeasonalChildren: [child] }));
  assert.match(html, /방학특강 신청 내역/);
  assert.match(html, /합성 학생/);
  assert.match(html, /학생 등록 대기/);
  assert.match(html, /href="\/mypage\/seasonal"/);
});

test("공통 계정 메뉴는 연결·간편로그인·역할·탈퇴의 실제 링크를 모두 제공한다", () => {
  const html = renderToStaticMarkup(React.createElement(AccountLinks));
  for (const path of ["children", "login-methods", "roles", "withdraw"]) assert.ok(html.includes(`href="/mypage/${path}"`));
  const layout = readFileSync("src/app/mypage/layout.tsx", "utf8");
  assert.match(layout, /\{children\}\s*<AccountLinks\s*\/>/);
  assert.doesNotMatch(readFileSync("src/app/mypage/MyPageClient.tsx", "utf8"), /href="\/mypage\/withdraw"/);
});

test("서버 홈은 빈 자녀 판정 전에 특강 내역을 조회하고 해당 계정만 전달한다", async () => {
  const calls = [];
  const Dashboard = compile("src/app/mypage/page.tsx", {
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "auth-fixture" } } }) } }) },
    "@/lib/queries": { getMyPageData: async (id) => { calls.push(id); return { children: [] }; } },
    "@/lib/auth-guard": { requireVerifiedParent: async () => ({ appUserId: "verified-app-fixture" }) },
    "@/lib/shuttle/parent": {},
    // 홈 «처리할 일»(보강권·방학특강 회차) — 자녀가 없으면 부르지 않는다
    "@/lib/makeup/parent-makeup": {},
    "@/lib/seasonal/parent-absence": {},
    // 홈 청구 합계(청구 탭과 같은 목록) — 자녀가 없으면 부르지 않는다
    "@/lib/payments/parent-payment-request": {},
    // 홈 반 상태 한 줄(휴원 예정·검토 중) — 자녀가 없으면 부르지 않는다
    "@/lib/enrollment/parent-change-request": {},
    // 홈 «아이 기록» 한 줄(다닌 기간·올해 출석률, 2026-11-14) — 자녀가 없으면 부르지 않는다
    "@/lib/parent/childRecordQuery": {},
    // 홈 «최신 수업 피드» 후보(2026-11-14) — 자녀가 없으면 부르지 않는다
    "@/lib/feed/server": {},
    "@/lib/seasonal/parent-pending": { getPendingSeasonalChildren: async (id, students) => { calls.push([id, students]); return []; } },
    "@/components/account/EmptyParentState": { default: Empty },
    "./MyPageClient": { default: () => null },
    "next/link": { default: Link },
  });
  const html = renderToStaticMarkup(await Dashboard({ searchParams: Promise.resolve({}) }));
  assert.equal(calls[0], "verified-app-fixture");
  assert.equal(calls[1][0], "verified-app-fixture");
  assert.equal(calls[1][1].length, 0);
  assert.match(html, /본인인증·자녀 연결/);
});

test("업무 스포츠 테마는 네 역할 공통 경계와 성공·경고·실패 상태색 및 조작 크기를 보존한다", () => {
  const css = readFileSync("src/app/academy-theme.css", "utf8");
  // 2026-11-13 원장 재결정: 주 색 네이비(옛 검정 #15181c 폐기) · 상태 다섯 갈래(정상·주의·위험·정보·중립)
  assert.match(css, /--color-academy-primary: #1e3a8a/);
  assert.match(css, /--color-academy-ink: #111827/);
  assert.match(css, /--color-academy-success: #15803d/);
  assert.match(css, /--color-academy-warning: #b45309/);
  assert.match(css, /--color-academy-danger: #b91c1c/);
  assert.match(css, /--color-academy-info: #6d28d9/); // 11-13 파랑 → 보라(주 색 네이비와 구분)
  assert.match(css, /--color-academy-neutral: #4b5563/);
  assert.match(css, /min-height: 44px/);
  assert.doesNotMatch(css, /#7444a3|#f7f4fb/);
});

test("학부모 권한이 없는 단일 직원 역할도 가족 연결 온보딩으로 이동할 수 있다", () => {
  const Switcher = compile("src/components/AccountViewSwitcher.tsx", {
    "next/link": { default: Link }, "next/navigation": { usePathname: () => "/staff" },
    "@/components/pwa/useInstalledApp": { useInstalledApp: () => true },
    // 2026-11-15 아이콘 예외(화살표·종·톱니): 공용 아이콘 부품은 실제 코드를 그대로 쓴다
    "@/components/common/UiIcon": { default: compile("src/components/common/UiIcon.tsx") },
  });
  const html = renderToStaticMarkup(React.createElement(Switcher, { views: [{ key: "teacher", label: "선생님", href: "/staff" }], variant: "list" }));
  assert.match(html, /href="\/account\/children"/);
  assert.match(html, /앱 밖의 브라우저 화면으로 이동/);
  assert.equal(renderToStaticMarkup(React.createElement(Switcher, { views: [], variant: "list" })), "");
  const source = readFileSync("src/components/AccountViewSwitcher.tsx", "utf8");
  assert.match(source, /onNavigate\?\.\(event, familyOption\)/);
});

test("직원 연결 페이지는 로그인만 요구하고 자녀 목록의 기존 학부모 가드는 유지한다", async () => {
  const EmptyClient = () => React.createElement("div", null, "연결 관리");
  let authenticated = 0;
  const Page = compile("src/app/account/children/page.tsx", {
    "next/link": { default: Link }, "next/image": { default: () => null },
    "next/navigation": { redirect: () => { throw new Error("로그인 필요"); } },
    "@/lib/auth-guard": { requireAuth: async () => { authenticated++; return { id: "auth-fixture" }; } },
    "@/lib/account-view-access": { getAccountViewAccess: async () => ({ views: [{ key: "teacher", label: "선생님", href: "/staff" }] }) },
    "@/components/academy/AcademyTheme": { default: ({ children }) => React.createElement("div", { className: "academy-app" }, children) },
    "@/components/AccountViewSwitcher": { default: () => null },
    "@/app/mypage/children/ChildConnectionsClient": { default: EmptyClient },
  });
  const html = renderToStaticMarkup(await Page());
  assert.equal(authenticated, 1);
  assert.match(html, /연결 관리/);
  assert.match(readFileSync("src/app/mypage/layout.tsx", "utf8"), /requireVerifiedParent\(\)/);
});

test("기존 설치 학부모 앱의 신규 신청은 앱 화면을 남기고 브라우저에서 연다", () => {
  const InstalledEmpty = compile("src/components/account/EmptyParentState.tsx", {
    "next/link": { default: Link }, "./child-link-api": {},
    "@/components/parent/customerMessage": { customerMessage: (_raw, fallback) => fallback },
    "@/components/pwa/useInstalledApp": { useInstalledApp: () => true },
  });
  const html = renderToStaticMarkup(React.createElement(InstalledEmpty, { pendingSeasonalChildren: [] }));
  assert.match(html, /href="\/apply\/enroll" target="_blank"/);
  assert.match(html, /href="\/apply\/trial" target="_blank"/);
  assert.match(html, /신청 후에는 스티즈 앱 아이콘/);
});

test("일정 탭에는 수납 기록이 없다 — 청구·납부·영수증은 청구 탭에서만(2026-11-09 원장 지시)", () => {
  // 예전 «출결·수납 히스토리»(HistoryClient)의 수납 탭은 청구 탭과 겹쳐 지웠다.
  // 추가 가족에게 결제·영수증 링크를 숨기는 판정은 청구 탭 쪽에 그대로 있다.
  assert.equal(existsSync("src/app/mypage/history/HistoryClient.tsx"), false);
  const schedule = readFileSync("src/app/mypage/history/ScheduleHub.tsx", "utf8") + readFileSync("src/app/mypage/history/page.tsx", "utf8");
  assert.doesNotMatch(schedule, /\/payments\/|receiptUrl|canCheckout|VirtualAccountNotice/);
});
