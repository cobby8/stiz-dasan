import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
const Link = ({ children, ...props }) => React.createElement("a", props, children);
const Empty = compile("src/components/account/EmptyParentState.tsx", { "next/link": { default: Link }, "@/components/account/child-link-api": {}, "./child-link-api": {}, "@/components/pwa/useInstalledApp": { useInstalledApp: () => false } });
const AccountLinks = compile("src/components/account/AccountLinks.tsx", { "next/link": { default: Link } });

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
    "@/lib/seasonal/parent-pending": { getPendingSeasonalChildren: async (id, students) => { calls.push([id, students]); return []; } },
    "@/components/account/EmptyParentState": { default: Empty },
    "./MyPageClient": { default: () => null },
    "next/link": { default: Link },
  });
  const html = renderToStaticMarkup(await Dashboard());
  assert.equal(calls[0], "verified-app-fixture");
  assert.equal(calls[1][0], "verified-app-fixture");
  assert.equal(calls[1][1].length, 0);
  assert.match(html, /본인인증·자녀 연결/);
});

test("업무 스포츠 테마는 네 역할 공통 경계와 성공·경고·실패 상태색 및 조작 크기를 보존한다", () => {
  const css = readFileSync("src/app/academy-theme.css", "utf8");
  assert.match(css, /--color-academy-primary: #b94118/);
  assert.match(css, /--color-academy-ink: #15181c/);
  assert.match(css, /--color-academy-success: #3f6754/);
  assert.match(css, /--color-academy-warning: #80581d/);
  assert.match(css, /--color-academy-danger: #a44052/);
  assert.match(css, /min-height: 44px/);
  assert.doesNotMatch(css, /#7444a3|#f7f4fb/);
});

test("학부모 권한이 없는 단일 직원 역할도 가족 연결 온보딩으로 이동할 수 있다", () => {
  const Switcher = compile("src/components/AccountViewSwitcher.tsx", {
    "next/link": { default: Link }, "next/navigation": { usePathname: () => "/staff" },
    "@/components/pwa/useInstalledApp": { useInstalledApp: () => true },
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
    "@/components/pwa/useInstalledApp": { useInstalledApp: () => true },
  });
  const html = renderToStaticMarkup(React.createElement(InstalledEmpty, { pendingSeasonalChildren: [] }));
  assert.match(html, /href="\/apply\/enroll" target="_blank"/);
  assert.match(html, /href="\/apply\/trial" target="_blank"/);
  assert.match(html, /신청 후에는 스티즈 앱 아이콘/);
});

test("추가 가족의 수납 히스토리는 금액·상태를 유지하고 대표 보호자의 결제·개인 영수증 링크를 숨긴다", () => {
  const History = compile("src/app/mypage/history/HistoryClient.tsx", {
    "next/link": { default: Link },
    react: { ...React, useState: (initial) => React.useState(initial === "attendance" ? "payments" : initial) },
  });
  const render = (canCheckout) => renderToStaticMarkup(React.createElement(History, { children: [{
    id: "child-fixture", name: "합성 학생", attendance: { total: 0, present: 0, absent: 0, late: 0, rate: null, records: [] },
    payments: ["PENDING", "PAID"].map((status, index) => ({ id: `payment-${index}`, status, amount: 120000, description: "합성 수강료", dueDate: "2026-10-27", paidDate: status === "PAID" ? "2026-10-26" : null, invoiceId: `invoice-${index}`, canCheckout, receiptUrl: "https://example.test/private-receipt" })),
  }] }));
  const secondary = render(false);
  assert.match(secondary, /120,000원/);
  assert.match(secondary, /미납/);
  assert.match(secondary, /납부완료/);
  assert.match(secondary, /온라인 결제는 대표 보호자 계정/);
  assert.doesNotMatch(secondary, /href="\/payments\//);
  assert.doesNotMatch(secondary, /href="https:\/\/example.test\/private-receipt"/);
  for (const value of [true, undefined]) {
    const primary = render(value);
    assert.match(primary, /href="\/payments\/invoice-0"/);
    assert.match(primary, /href="\/payments\/invoice-1"/);
    assert.match(primary, /href="https:\/\/example.test\/private-receipt"/);
  }
});
