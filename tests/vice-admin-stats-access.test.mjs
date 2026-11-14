import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsModule } from "./_ts-module.mjs";
import { loadAdminModule } from "./helpers/admin-navigation-render.mjs";

// 2026-11-14 부원장(VICE_ADMIN) 금액·통계 가림 — 원장 결정.
// 부원장은 «통계»와 «학원 돈 규모(합계·납부 완료 금액·수납률·미납 합계)»를 보지 못한다.
// 화면만 숨기면 개발자도구로 응답이 보이므로 «서버에서 빼는지»를 함께 못박는다.
// 순수 규칙은 실제로 실행하고, 서버 파일(prisma·next 의존)은 문자열로 «역할 확인이 데이터 조회보다 먼저»인지 본다.

const read = (path) => readFileSync(path, "utf8");
const money = await loadTsModule("src/lib/auth/moneyAccess.ts");
const staffRules = await loadTsModule("src/lib/staff-session-rules.ts");
const sections = await loadTsModule("src/lib/admin-sections.ts");
const digest = await loadTsModule("src/lib/admin-daily-digest.ts");

// ── 공용 규칙(moneyAccess) ─────────────────────────────────────

test("moneyAccess: 원장만 돈 전체·통계를 본다", () => {
  assert.equal(money.canSeeAllMoney("ADMIN"), true);
  assert.equal(money.canSeeAllMoney("VICE_ADMIN"), false);
  assert.equal(money.canSeeStats("ADMIN"), true);
  assert.equal(money.canSeeStats("VICE_ADMIN"), false);
  assert.equal(money.canSeeStats(null), false);
});

test("moneyAccess: 부원장은 미납(PENDING·OVERDUE) 1건 금액만, 납부 완료·환불은 null", () => {
  assert.equal(money.canSeePaymentAmount("VICE_ADMIN", "PENDING"), true);
  assert.equal(money.canSeePaymentAmount("VICE_ADMIN", "OVERDUE"), true);
  assert.equal(money.canSeePaymentAmount("VICE_ADMIN", "PAID"), false);
  assert.equal(money.canSeePaymentAmount("VICE_ADMIN", "REFUNDED"), false);
  assert.equal(money.canSeePaymentAmount("ADMIN", "PAID"), true);

  const paid = { id: "p1", amount: 180000, status: "PAID", paidAmount: 180000 };
  assert.deepEqual(money.maskPaymentAmount(paid, "VICE_ADMIN", ["paidAmount"]), { ...paid, amount: null, paidAmount: null });
  assert.equal(money.maskPaymentAmount(paid, "ADMIN"), paid, "원장은 원본 그대로");
  const unpaid = { id: "p2", amount: 150000, status: "PENDING" };
  assert.equal(money.maskPaymentAmount(unpaid, "VICE_ADMIN"), unpaid, "미납 1건은 부원장도 본다");
});

// ── 직원 포털(/staff) 금액 ─────────────────────────────────────

test("직원 화면: 부원장만 납부 완료 금액을 가리고, 선생님·원장 동작은 그대로", () => {
  const paid = { id: "p1", amount: 180000, invoiceAmount: 180000, status: "PAID" };
  const unpaid = { id: "p2", amount: 150000, invoiceAmount: 150000, status: "OVERDUE" };
  assert.deepEqual(staffRules.maskStaffBillAmounts(paid, "VICE_ADMIN", "PAID"), { ...paid, amount: null, invoiceAmount: null });
  assert.equal(staffRules.maskStaffBillAmounts(unpaid, "VICE_ADMIN", "OVERDUE"), unpaid);
  // 선생님 청구 탭(/staff/billing)은 원래 금액을 보던 화면 — 이번 작업으로 바꾸지 않는다
  assert.equal(staffRules.maskStaffBillAmounts(paid, "INSTRUCTOR", "PAID"), paid);
  assert.equal(staffRules.maskStaffBillAmounts(paid, "ADMIN", "PAID"), paid);
  // 출석부·홈 수강료는 여전히 원장·부원장만(선생님은 f3 대로 아예 못 받음)
  assert.equal(staffRules.canSeeStaffFees("VICE_ADMIN"), true);
  assert.equal(staffRules.canSeeStaffFees("INSTRUCTOR"), false);
});

test("출석부 월 수강료 요약: 부원장은 납부 완료 줄 금액을 받지 않는다", () => {
  const row = (status) => ({ rosterId: "r", amount: 180000, status });
  assert.equal(staffRules.maskStaffMonthlyFeeAmount(row("PAID"), "VICE_ADMIN").amount, null);
  assert.equal(staffRules.maskStaffMonthlyFeeAmount(row("REVIEW"), "VICE_ADMIN").amount, null);
  assert.equal(staffRules.maskStaffMonthlyFeeAmount(row("UNPAID"), "VICE_ADMIN").amount, 180000);
  assert.equal(staffRules.maskStaffMonthlyFeeAmount(row("PENDING_CONFIRMATION"), "VICE_ADMIN").amount, 180000);
  assert.equal(staffRules.maskStaffMonthlyFeeAmount(row("PAID"), "ADMIN").amount, 180000);
});

test("직원 조회·액션이 서버에서 부원장 가림을 거친다", () => {
  const portal = read("src/lib/staff-portal-queries.ts");
  assert.match(portal, /maskStaffBillAmounts\(\{[\s\S]*?\}, role, row\.status\)/);
  const actions = read("src/app/actions/staff-billing.ts");
  assert.match(actions, /maskStaffMonthlyFeeAmount\(item, access\.staff\.appUserRole\)/, "출석부 월 수강료");
  assert.match(actions, /summary: maskStaffMonthlyFeeAmount\(result\.summary, role\)/, "출석부 학생 청구 요약");
  assert.match(actions, /maskStaffBillAmounts\(item, role, item\.paymentStatus\)/, "출석부 학생 청구 건별");
  assert.match(actions, /access\.staff\.appUserRole, item\.paymentStatus\)\)/, "반별 청구 시트");
  const people = read("src/app/actions/staff-class-people.ts");
  assert.match(people, /staffMasksSettledAmounts\(access\.staff\.appUserRole\)[\s\S]*unpaidAmount: null/, "학생별 미납 합계");
});

// ── 사이드바·탭 줄 ─────────────────────────────────────────────

test("탭 줄: POS 대사는 원장 전용 — 부원장 탭 줄에서 빠지고 나머지 청구·수납 탭은 남는다", () => {
  const finance = sections.ADMIN_SECTIONS.finance.tabs;
  const vice = sections.visibleSectionTabs(finance, false).map((t) => t.href);
  assert.deepEqual(vice, ["/admin/finance", "/admin/payment-requests", "/admin/payment-confirmations"]);
  assert.equal(sections.visibleSectionTabs(finance, true).length, finance.length);
  // 다른 묶음에는 통계·월장부·청구준비로 가는 탭이 없다(생기면 ownerOnly 를 붙여야 한다)
  for (const section of Object.values(sections.ADMIN_SECTIONS)) {
    for (const tab of section.tabs) {
      if (/\/admin\/(stats|finance\/(monthly-ledger|monthly-register|prepare))/.test(tab.href)) assert.equal(tab.ownerOnly, true, tab.href);
    }
  }
});

function renderShell(pathname, props) {
  const Shell = loadAdminModule("src/app/admin/AdminShellClient.tsx", pathname).default;
  return renderToStaticMarkup(React.createElement(Shell, { initialUserName: "시험", initialUserEmail: "masked@preview.invalid", ...props }, "본문"));
}

test("사이드바: 부원장에게는 통계 메뉴·시스템 도구·POS 대사 탭을 그리지 않는다", () => {
  const vice = renderShell("/admin/finance", { canSeeStats: false, isOwner: false });
  assert.doesNotMatch(vice, /href="\/admin\/stats"/);
  assert.doesNotMatch(vice, /시스템 도구/);
  assert.doesNotMatch(vice, /href="\/admin\/pos-reconcile"/);
  assert.match(vice, /href="\/admin\/payment-confirmations"/);

  const owner = renderShell("/admin/finance", { canSeeStats: true, isOwner: true });
  assert.match(owner, /href="\/admin\/stats"/);
  assert.match(owner, /시스템 도구/);
  assert.match(owner, /href="\/admin\/pos-reconcile"/);
});

test("레이아웃이 역할로 메뉴 불리언을 내려 보낸다", () => {
  const layout = read("src/app/admin/layout.tsx");
  assert.match(layout, /canSeeStats=\{canSeeStats\(adminUser\.appUserRole\)\}/);
  assert.match(layout, /isOwner=\{canSeeAllMoney\(adminUser\.appUserRole\)\}/);
});

// ── 통계·대시보드 서버 차단 ────────────────────────────────────

test("/admin/stats: 부원장이면 데이터를 읽기 전에 대시보드로 돌려보낸다", () => {
  const page = read("src/app/admin/stats/page.tsx");
  const guard = page.indexOf('if (!canSeeStats(admin.appUserRole)) redirect("/admin")');
  assert.ok(guard > 0, "역할 확인");
  assert.ok(guard < page.indexOf("getCachedAdminStatsTab(tab"), "조회보다 먼저");
  // 통계 조회 함수를 부르는 곳은 이 화면 하나뿐이어야 한다(다른 곳이 생기면 거기도 막아야 한다)
  const users = ["src/app/admin/page.tsx", "src/app/api/admin/dashboard/route.ts", "src/app/admin/AdminDashboardClient.tsx"]
    .filter((path) => read(path).includes("getCachedAdminStatsTab"));
  assert.deepEqual(users, []);
});

test("대시보드: 부원장이면 요약 카드 6개를 조회 자체를 하지 않는다", () => {
  const page = read("src/app/admin/page.tsx");
  assert.match(page, /const showSummary = canSeeStats\(admin\.appUserRole\)/);
  assert.match(page, /showSummary\s*\?\s*getCachedAdminDashboardSummary\(\)[\s\S]*?:\s*Promise\.resolve\(null\)/);
  // 통계로 가는 링크는 요약 카드 안에만 있다 → summary=null 이면 같이 사라진다
  assert.doesNotMatch(read("src/app/admin/AdminDashboardClient.tsx"), /href="\/admin\/stats/);
  assert.match(read("src/app/admin/AdminDashboardClient.tsx"), /\{summary && <DashboardSummaryCards/);
});

test("/api/admin/dashboard: 공유 캐시에서 꺼낸 «뒤»에 역할로 매출·미납 칸을 뺀다", () => {
  const route = read("src/app/api/admin/dashboard/route.ts");
  assert.match(route, /role = \(await requireTimedAdmin\(timing\)\)\.appUserRole/);
  const cachedAt = route.indexOf("getCachedAdminDashboardPayload()");
  const stripAt = route.indexOf("stripDashboardMoneyForRole(cached, role)");
  assert.ok(cachedAt > 0 && stripAt > cachedAt, "캐시 조회 뒤 거르기");
});

test("대시보드 거르기 함수: 부원장에게는 extendedStats(매출·미납·추이)를 통째로 뺀다", async () => {
  const { stripDashboardMoneyForRole } = await loadTsModule("src/lib/auth/dashboardMoneyStrip.ts");
  const cached = { stats: { studentCount: 3 }, extendedStats: { thisMonthRevenue: 1000, unpaidAmount: 500, unpaidCount: 1, monthlyRevenue: [] } };
  const vice = stripDashboardMoneyForRole(cached, "VICE_ADMIN");
  assert.equal(vice.extendedStats, null);
  assert.equal(vice.stats.studentCount, 3);
  assert.equal(cached.extendedStats.thisMonthRevenue, 1000, "공유 캐시 원본은 건드리지 않는다");
  assert.equal(stripDashboardMoneyForRole(cached, "ADMIN"), cached);
});

// ── 알림 ──────────────────────────────────────────────────────

test("아침 요약: 부원장용 문구에는 미납 금액이 없고, 원장용에는 있다", () => {
  const input = {
    todayYmd: "2026-11-14",
    unpaid: [
      { year: 2026, month: 11, count: 3, amount: 450000, overdueCount: 1 },
      { year: 2026, month: 6, count: 1, amount: 150000, overdueCount: 1 },
    ],
    needsCheckCount: 0,
    pendingChangeCount: 0,
  };
  const owner = digest.buildAdminDailyDigest(input);
  const vice = digest.buildAdminDailyDigest({ ...input, showMoney: false });
  assert.match(owner.message, /600,000원/);
  assert.match(owner.message, /450,000원/);
  assert.doesNotMatch(vice.message, /원(\s|$|\n)/m, vice.message);
  assert.match(vice.message, /\[사이트 장부 미납\] 4건 \(기한 지남 2건\)/);
  assert.equal(vice.title, owner.title, "제목(건수)은 같다");
});

test("아침 요약 발송: 받는 사람 역할로 문구 벌을 고른다", () => {
  const service = read("src/lib/admin-daily-digest-service.ts");
  assert.match(service, /SELECT id, role FROM "User" WHERE role IN \('ADMIN', 'VICE_ADMIN'\)/);
  assert.match(service, /canSeeAllMoney\(admin\.role\) \? digest : digestWithoutMoney/);
});

test("POS 경고 알림 벨(이미 납부된 금액)은 원장에게만", () => {
  const pay = read("src/lib/pos/paymentNoticePay.ts");
  const fn = pay.slice(pay.indexOf("export async function notifyAdminBell"), pay.indexOf("async function alertConflict"));
  assert.match(fn, /WHERE u\.role = 'ADMIN'/);
  assert.doesNotMatch(fn, /VICE_ADMIN/);
});
