// 학부모 청구 «월 카드 + 세부 시트»(2026-11-14 원장 지시) — 실제로 실행·렌더해서 확인한다.
//  ① 순수 규칙: 청구 달(달 경계·빈 연월)·상태 한 단어·형제/종류 한 카드·환불 제외 합계·할인 해석(운영 글 형식 5가지)
//  ② 렌더: 미납 섞인 달·전부 납부·금액 없음(결제 권한 없음)·할인 있음·영수증 없음
//  ③ 소스 가드: 결제하기 링크·한 번에 결제가 시트 안에 같은 모양으로, 두 화면이 같은 부품, 아이콘 없음, 뒤로가기 닫기
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

// TS/TSX 를 CommonJS 로 올린다. mocks 에 없는 «@/…»·상대 경로는 진짜 파일을 같은 방식으로 따라간다.
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
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? `src/${name.slice(2)}` : resolve(absolute, "..", name);
      const file = [".ts", ".tsx", ""].map((ext) => base + ext).find((p) => existsSync(p));
      if (file) return load(file, mocks);
    }
    return require(name);
  };
  mod._compile(compiled, absolute);
  return mod.exports;
}

const mb = load("src/lib/payments/monthBills.ts");
const item = (id, extra = {}) => ({
  id, studentId: "s1", studentName: "첫째", type: "MONTHLY", status: "PAID", amount: 100000,
  year: 2026, month: 11, dueYmd: "2026-11-10", paidYmd: "2026-11-05", description: "11월 수강료", receiptUrl: null,
  method: null, paidProvider: null, ...extra,
});

// ── ① 순수 규칙 ────────────────────────────────────────────────────────────

test("① 청구 달: 청구 대상 연·월이 먼저, 없거나 틀리면 납기일(KST)의 달, 둘 다 없으면 «날짜 미정»", () => {
  // 12월분을 11/30 납기로 발행(청구 작업대) → 12월 카드(예전 청구 탭은 납기일로 묶어 11월에 들어갔다)
  assert.equal(mb.billMonth(item("a", { year: 2026, month: 12, dueYmd: "2026-11-30" })), "2026-12");
  assert.equal(mb.billMonth(item("b", { year: null, month: null, dueYmd: "2026-12-01" })), "2026-12", "달 경계(1일)");
  assert.equal(mb.billMonth(item("c", { year: null, month: null, dueYmd: "2026-11-30" })), "2026-11", "달 경계(말일)");
  assert.equal(mb.billMonth(item("d", { year: 2026, month: 13, dueYmd: "2025-12-31" })), "2025-12", "13월은 버리고 납기일(연말)");
  assert.equal(mb.billMonth(item("e", { year: null, month: null, dueYmd: null })), "");
  assert.equal(mb.billMonthLabel("2026-12", "2026"), "12월");
  assert.equal(mb.billMonthLabel("2025-12", "2026"), "2025년 12월", "다른 해는 연도까지");
  assert.equal(mb.billMonthLabel("", "2026"), "날짜 미정");
});

test("① 상태 한 단어: 미납·연체·일부 납부·납부 완료·환불(환불은 판정에서 뺀다)", () => {
  const s = (...statuses) => mb.monthBillStatus(statuses.map((status) => ({ status })));
  assert.equal(s("PENDING", "PENDING"), "UNPAID");
  assert.equal(s("PENDING", "OVERDUE"), "OVERDUE");
  assert.equal(s("PENDING", "PAID"), "PARTIAL");
  assert.equal(s("PAID", "PAID"), "PAID");
  assert.equal(s("PAID", "REFUNDED"), "PAID", "환불 섞여도 나머지가 납부면 납부 완료");
  assert.equal(s("REFUNDED"), "REFUNDED");
  assert.equal(s("PENDING", "REFUNDED"), "UNPAID");
  assert.equal(mb.MONTH_BILL_STATUS_LABEL.PARTIAL, "일부 납부");
  assert.equal(mb.billItemStatusLabel("CANCELED"), "확인 중", "영어 코드를 그대로 보이지 않는다");
});

test("① 월 묶음: 형제·종류가 섞여도 한 달 = 카드 하나, 합계는 환불 제외, 미납 먼저, 날짜 미정은 맨 뒤, 취소는 안 보임", () => {
  const bills = mb.groupBillsByMonth([
    item("p1", { status: "PAID" }),
    item("p2", { studentId: "s2", studentName: "둘째", type: "SHUTTLE", status: "PENDING", amount: 40000, paidYmd: null }),
    item("p3", { type: "UNIFORM", status: "REFUNDED", amount: 30000 }),
    item("p4", { type: "SPECIAL", status: "CANCELED", amount: 999999 }),
    item("p5", { year: 2026, month: 12, dueYmd: "2026-11-30", status: "PENDING", amount: 72000, description: "2026-12 월요일 6교시 수강료 · 수강료 80000 · 할인 8000 · 기간조정 0 · 이월 0 · 셔틀 0" }),
    item("p6", { year: null, month: null, dueYmd: null }),
    item("p7", { year: 2025, month: 12, dueYmd: "2025-12-10" }),
  ], "2026");
  assert.deepEqual(bills.map((b) => b.ym), ["2026-12", "2026-11", "2025-12", ""], "최신 달부터, 날짜 미정 맨 뒤");
  assert.deepEqual(bills.map((b) => b.label), ["12월", "11월", "2025년 12월", "날짜 미정"]);
  const nov = bills[1];
  assert.equal(nov.items.length, 3, "형제(첫째·둘째)·종류(수강료·셔틀·유니폼) 한 카드, 취소 제외");
  assert.equal(nov.total, 140000, "환불(유니폼 30,000) 제외");
  assert.equal(nov.unpaidTotal, 40000);
  assert.equal(nov.unpaidCount, 1);
  assert.equal(nov.status, "PARTIAL");
  assert.equal(nov.studentCount, 2);
  assert.equal(nov.items[0].id, "p2", "미납 먼저");
  const dec = bills[0];
  assert.equal(dec.status, "UNPAID");
  assert.equal(dec.discountTotal, 8000, "할인 합계");
  // 결제 권한이 없어 금액이 null 이면 합계도 null(금액을 보이지 않는다)
  const hidden = mb.groupBillsByMonth([item("h", { amount: null })], "2026")[0];
  assert.equal(hidden.total, null);
  assert.equal(hidden.discountTotal, 0);
});

test("① 할인 해석: 운영 글 형식 5가지를 «원래 − 할인(사유) = 낼 금액»으로, 실제 금액과 다르면 안 보인다", () => {
  // 청구 작업대 발행분
  assert.deepEqual(mb.parseBillBreakdown("2026-12 월요일 6교시 수강료 · 수강료 80000 · 할인 8000 · 기간조정 0 · 이월 0 · 셔틀 0", 72000),
    { original: 80000, deductions: [{ label: "할인", amount: 8000 }], payable: 72000 });
  assert.deepEqual(mb.parseBillBreakdown("2026-12 월요일 5교시 수강료 · 수강료 100000 · 할인 10000 · 기간조정 0 · 이월 0 · 셔틀 10000", 100000),
    { original: 110000, deductions: [{ label: "할인", amount: 10000 }], payable: 100000 }, "셔틀은 원래 금액에 더한다");
  assert.deepEqual(mb.parseBillBreakdown("x · 수강료 100000 · 할인 0 · 기간조정 25000 · 이월 5000 · 셔틀 0", 70000).deductions,
    [{ label: "기간 조정", amount: 25000 }, { label: "이월 차감", amount: 5000 }], "할인 0 은 줄에서 뺀다");
  // 옛 장부 이관분(금액 = 할인 뒤)
  assert.deepEqual(mb.parseBillBreakdown("랠리즈 2026년 1월 청구 사본(목요일 8교시). 금액 60000원(할인 60000, 셔틀·기타 0). 랠리즈 납부 2026-02-24.", 60000),
    { original: 120000, deductions: [{ label: "할인", amount: 60000 }], payable: 60000 });
  // 11월 사본(사유·회차)
  assert.deepEqual(mb.parseBillBreakdown("[랠리즈 11월 발행 사본] 5. 금요일 7교시. 교습비 120,000 - 개시 할인 30,000(4회 중 3회) + 셔틀비 10,000. 미납.", 100000),
    { original: 130000, deductions: [{ label: "개시 할인 (4회 중 3회)", amount: 30000 }], payable: 100000 });
  assert.deepEqual(mb.parseBillBreakdown("1. 월요일 4교시. 정가 100,000 - 주3회 할인 30,000. 미납.", 70000).deductions, [{ label: "주3회 할인", amount: 30000 }]);
  // 비율 할인
  assert.deepEqual(mb.parseBillBreakdown("2026-11 화요일 6교시 수강료 · 교습비 108,000(정가 120,000 − 형제할인 10%) + 셔틀비 10,000(11월)", 118000),
    { original: 130000, deductions: [{ label: "형제할인 10%", amount: 12000 }], payable: 118000 });
  // 손으로 적은 사본
  assert.deepEqual(mb.parseBillBreakdown("최윤호 화요일6 수강료120000-주2회할인30000+셔틀15000. 관리자 장부용", 105000),
    { original: 135000, deductions: [{ label: "주2회할인", amount: 30000 }], payable: 105000 });
  // 안 보이는 경우
  assert.equal(mb.parseBillBreakdown("x · 수강료 80000 · 할인 8000 · 기간조정 0 · 이월 0 · 셔틀 0", 80000), null, "계산이 실제 금액과 다르면 안 보인다");
  assert.equal(mb.parseBillBreakdown("x · 수강료 80000 · 할인 0 · 기간조정 0 · 이월 0 · 셔틀 0", 80000), null, "할인이 없으면 줄 없음");
  assert.equal(mb.parseBillBreakdown("신청 금액 135,000(형제할인 15,000)인데 150,000 납부", 150000), null);
  assert.equal(mb.parseBillBreakdown("x · 수강료 80000 · 할인 8000 · 기간조정 0 · 이월 0 · 셔틀 0", null), null, "금액을 볼 수 없으면 할인도 없음");
  assert.equal(mb.parseBillBreakdown(null, 1000), null);
});

test("① 항목 이름·결제수단: 관리자 장부 글은 숨기고 종류·반으로, 결제수단은 한국어로", () => {
  assert.equal(mb.billItemLabel({ type: "MONTHLY", description: "2026-12 월요일 6교시 수강료 · 수강료 80000 · 할인 8000 · 기간조정 0 · 이월 0 · 셔틀 0" }), "수강료 · 월요일 6교시");
  assert.equal(mb.billItemLabel({ type: "MONTHLY", description: "2026-12 주말 대표팀 수강료 · 수강료 1 · 할인 0 · 기간조정 0 · 이월 0 · 셔틀 0" }), "수강료 · 주말 대표팀");
  assert.equal(mb.billItemLabel({ type: "MONTHLY", description: "랠리즈 기존 2026년 10월 청구 사본. 연간 수강기간 … 관리자 장부용;" }), "수강료");
  assert.equal(mb.billItemLabel({ type: "SHUTTLE", description: "[랠리즈 11월 발행 사본] 6. 토요일 3교시. 수강기간" }), "셔틀 · 토요일 3교시");
  assert.equal(mb.billItemLabel({ type: "UNIFORM", description: "유니폼 상의" }), "유니폼 상의", "짧고 깨끗한 글은 그대로");
  assert.equal(mb.billItemLabel({ type: "OTHER", description: "2026-09-08 카드결제" }), "기타");
  assert.equal(mb.billItemLabel({ type: "SPECIAL", description: null }), "특강");
  assert.equal(mb.billMethodLabel("CARD", "TOSS_POS"), "현장 카드");
  assert.equal(mb.billMethodLabel(null, "TOSS"), "온라인 결제");
  assert.equal(mb.billMethodLabel("온라인 카드수납(삼성카드)", "RALLYZ"), "온라인 카드수납(삼성카드)");
  assert.equal(mb.billMethodLabel("CASH", null), "현금");
  assert.equal(mb.billMethodLabel("UNPAID", null), null, "모르는 값은 안 보인다");
  assert.equal(mb.billMethodLabel(null, null), null);
});

// ── ② 렌더 ─────────────────────────────────────────────────────────────────

const Card = load("src/components/parent/billing/MonthBillCard.tsx").default;
const Sheet = load("src/components/parent/billing/BillDetailSheet.tsx").default;
const cardHtml = (bill) => renderToStaticMarkup(React.createElement("ul", null, React.createElement(Card, { bill, onOpen() {} })));

test("② 월 카드: 청구월·합계·상태 한 단어만, 미납 섞인 달은 주의 바탕, 전부 납부는 보통 바탕, 금액 없음은 금액 생략", () => {
  const [mixed] = mb.groupBillsByMonth([item("a", { status: "PENDING" }), item("b", { description: "· 수강료 1 · 할인 1" })], "2026");
  const html = cardHtml(mixed);
  assert.match(html, /data-month-bill="2026-11"/);
  assert.match(html, /min-h-\[52px\]/, "한 줄 52px");
  assert.match(html, /bg-\[var\(--color-academy-warning-soft\)\]/, "미납이 있는 달은 눈에 띄게(토큰 색)");
  assert.match(html, />11월</);
  assert.match(html, />200,000원</);
  assert.match(html, />일부 납부</);
  assert.doesNotMatch(html, /11월 수강료|납기|첫째/, "카드에는 세부 내역이 없다");
  const [paid] = mb.groupBillsByMonth([item("a"), item("b")], "2026");
  const paidHtml = cardHtml(paid);
  assert.doesNotMatch(paidHtml, /warning-soft/);
  assert.match(paidHtml, /text-\[var\(--color-academy-success\)\][^>]*>납부 완료</);
  const [hidden] = mb.groupBillsByMonth([item("a", { amount: null })], "2026");
  assert.doesNotMatch(cardHtml(hidden), /원</, "결제 권한이 없으면 금액 없음");
});

test("② 세부 시트: 할인 있음 «원래 − 할인 = 낼 금액»·상태·납기·납부일·결제수단, 영수증 없음이면 링크 없음, 화면이 넘긴 버튼·맨 아래 칸", () => {
  const [bill] = mb.groupBillsByMonth([
    item("d", { year: 2026, month: 12, status: "PENDING", amount: 72000, paidYmd: null, dueYmd: "2026-11-30", description: "2026-12 월요일 6교시 수강료 · 수강료 80000 · 할인 8000 · 기간조정 0 · 이월 0 · 셔틀 0" }),
    item("p", { year: 2026, month: 12, studentId: "s2", studentName: "둘째", type: "SHUTTLE", amount: 15000, method: "CARD", paidProvider: "TOSS_POS", receiptUrl: "https://r.example/p", description: "셔틀비" }),
  ], "2026");
  const html = renderToStaticMarkup(React.createElement(Sheet, {
    bill,
    onClose() {},
    renderItemActions: (it) => React.createElement("a", { href: `/pay/${it.id}` }, `행동 ${it.id}`),
    footer: React.createElement("p", null, "맨 아래 칸"),
  }));
  assert.match(html, /role="dialog"/);
  assert.match(html, /aria-labelledby="bill-sheet-2026-12"/);
  assert.match(html, /<h2 id="bill-sheet-2026-12"[^>]*>12월 청구<\/h2>/);
  assert.match(html, /합계 <b[^>]*>87,000원<\/b> · 할인 8,000원/);
  assert.match(html, /미납 1건 72,000원/);
  assert.match(html, />닫기</, "닫기는 글자 버튼");
  assert.match(html, /<h3[^>]*>첫째<\/h3>[^]*<h3[^>]*>둘째<\/h3>/, "형제면 아이별");
  assert.match(html, /수강료 · 월요일 6교시/);
  assert.match(html, /data-bill-discount[^>]*>원래 80,000원[^]*?− 할인 8,000원[^]*?= <b[^>]*>72,000원<\/b>/, "할인 표시");
  assert.match(html, />미납<\/span> · 납기 26\.11\.30/);
  assert.match(html, />납부 완료<\/span> · 납기 26\.11\.10 · 납부 26\.11\.05 · 현장 카드/);
  assert.match(html, /href="https:\/\/r\.example\/p"[^>]*>영수증 보기</);
  assert.equal((html.match(/영수증 보기/g) || []).length, 1, "영수증 없는 항목엔 링크 없음");
  assert.match(html, /href="\/pay\/d"[^>]*>행동 d</, "화면이 넘긴 버튼이 항목 아래");
  assert.match(html, /맨 아래 칸/);
  assert.doesNotMatch(html, /material-symbols/);
});

// ── ③ 소스 가드 ─────────────────────────────────────────────────────────────

test("③ 결제 흐름 보존: 결제하기 링크·한 번에 결제·입금했어요·영수증 요청이 시트 안에 같은 모양으로", () => {
  const client = read("src/app/mypage/payments/PaymentRequestClient.tsx");
  const actions = client.slice(client.indexOf("function itemActions("), client.indexOf("// 처리 결과·오류 안내"));
  assert.match(actions, /href=\{`\/payments\/\$\{encodeURIComponent\(row\.invoiceId!\)\}`\}/, "결제하기 = 기존 결제 화면 링크 그대로");
  assert.match(actions, />\s*결제하기\s*</, "버튼 문구 «결제하기» 그대로(심사 중)");
  assert.match(actions, /const canPayOnline = payReady && Boolean\(row\.invoiceId\) && row\.canCheckout;/);
  assert.match(actions, /이미 계좌로 입금했어요/);
  assert.match(actions, /입금했어요 알리기/);
  assert.match(actions, /submitClaim\(row\.paymentId\)/);
  assert.match(actions, /<VirtualAccountNotice compact account=\{row\.virtualAccount\} \/>/, "가상계좌 안내 같은 부품");
  assert.match(actions, /영수증 요청/);
  assert.match(client, /renderItemActions=\{\(item\) => itemActions\(item\.row\)\}/, "시트 항목마다 같은 함수");
  // «한 번에 결제»는 모든 달 미납을 묶으므로 화면 위쪽 칸 하나만(시트 안에 «이 달 합계»처럼 두면 금액이 어긋난다 — 검수 11-14)
  assert.equal((client.match(/href="\/mypage\/payments\/checkout"/g) || []).length, 1, "한 번에 결제는 위쪽 칸 하나");
  assert.match(client, /footer=\{messages\}/);
  assert.match(client, /navigate=\{\(href\) => router\.push\(href\)\}/, "시트 안 결제하기는 칸을 되돌린 뒤 같은 화면 이동");
  assert.doesNotMatch(client, /groupByKstMonth/, "월 묶음은 공용 규칙(groupBillsByMonth) 하나");
});

test("③ 같은 부품: 청구 탭·아이 기록이 월 카드·세부 시트·월 묶음 규칙을 함께 쓴다, 아이콘 없음, 뒤로가기로 닫힘", () => {
  for (const file of ["src/app/mypage/payments/PaymentRequestClient.tsx", "src/app/mypage/record/ChildRecordClient.tsx"]) {
    const src = read(file);
    assert.match(src, /from "@\/components\/parent\/billing\/MonthBillCard"/, file);
    assert.match(src, /from "@\/components\/parent\/billing\/BillDetailSheet"/, file);
    assert.match(src, /groupBillsByMonth/, file);
  }
  const sheet = read("src/components/parent/billing/BillDetailSheet.tsx");
  assert.match(sheet, /attachSheetHistory\(window,/, "기록 칸 관리는 sheetHistory 한 곳");
  assert.match(sheet, /controller\.detach\(\)/, "사라질 때 남은 칸 정리");
  assert.match(sheet, /onClickCapture=\{onClickCapture\}/, "시트 안 링크는 칸을 되돌린 뒤 이동");
  assert.match(sheet, /<ListDetailPanel onClose=\{requestClose\}/, "Esc·바깥 누르기도 같은 닫기");
  assert.doesNotMatch(sheet, /history\.state\?\.billSheet/, "router.refresh 가 지우는 표시에 기대지 않는다");
  assert.doesNotMatch(sheet, /academy-success/, "할인 금액은 상태색(완료 초록)을 쓰지 않는다");
  for (const file of ["src/components/parent/billing/BillDetailSheet.tsx", "src/components/parent/billing/MonthBillCard.tsx"]) {
    assert.doesNotMatch(read(file), /material-symbols|lucide|#[0-9a-fA-F]{6}\b/, file);
  }
  // 아이 기록: 결제는 청구 탭 한 곳에서(결제 권한자에게만 버튼)
  const record = read("src/app/mypage/record/ChildRecordClient.tsx");
  assert.match(record, /record\.student\.canPay && openBill\.unpaidCount > 0/);
  // 청구 탭 날짜도 아이 기록과 같은 «두 번» 변환
  const query = read("src/lib/payments/parent-payment-request.ts");
  assert.match(query, /to_char\(\(\(p\."dueDate" AT TIME ZONE 'UTC'\) AT TIME ZONE 'Asia\/Seoul'\),'YYYY-MM-DD'\) AS "dueDate"/);
  assert.match(query, /p\.type, p\.year, p\.month, p\.method, p\."paidProvider"/);
});

// ── ④ 뒤로가기 기록 칸(가짜 history 로 실행) ────────────────────────────────

const sh = load("src/components/parent/billing/sheetHistory.ts");
/** 같은 주소 기록 더미 — back() 은 실제 브라우저처럼 «나중에» popstate 를 보낸다 */
function fakeWindow() {
  const entries = [{ state: { __NA: true, tree: "t" } }];
  let index = 0;
  const listeners = new Set();
  const timers = [];
  const win = {
    history: {
      get state() { return entries[index].state; },
      pushState(state) { entries.splice(index + 1); entries.push({ state }); index += 1; },
      back() { timers.push(() => { if (index > 0) { index -= 1; for (const fn of [...listeners]) fn(); } }); },
    },
    location: { href: "https://x.example/mypage/payments" },
    addEventListener: (_type, fn) => listeners.add(fn),
    removeEventListener: (_type, fn) => listeners.delete(fn),
    setTimeout: (fn) => timers.push(fn),
  };
  // Next 16 router.refresh() 흉내 — 지금 칸의 상태를 라우터 값으로 갈아 끼운다(billSheet 표시가 사라짐)
  const refresh = () => { entries[index].state = { __NA: true, tree: "t2" }; };
  const flush = () => { while (timers.length) timers.shift()(); };
  return { win, refresh, flush, length: () => entries.length, index: () => index, listeners };
}

test("④ 기록 칸: 열면 한 칸, 닫기·뒤로가기·refresh 뒤 닫기·링크 이동·저절로 사라짐 모두 정확히 한 번 되돌린다", () => {
  sh.resetSheetHistoryForTest();
  // 닫기 버튼
  {
    const f = fakeWindow(); let closed = 0;
    const c = sh.attachSheetHistory(f.win, { onClose: () => closed++, navigate() {} });
    assert.equal(f.index(), 1, "열면 한 칸");
    assert.equal(f.win.history.state.billSheet, true);
    assert.equal(f.win.history.state.tree, "t", "라우터 값을 품은 채");
    c.requestClose(); f.flush();
    assert.equal(f.index(), 0); assert.equal(closed, 1);
    c.detach(); f.flush();
    assert.equal(f.index(), 0, "닫힌 뒤 정리에서 더 되돌리지 않는다");
  }
  // 입금 알림·영수증 요청 뒤 router.refresh() 로 표시가 지워져도 닫기 = 칸 되돌림(검수 지적 1)
  {
    const f = fakeWindow(); let closed = 0;
    const c = sh.attachSheetHistory(f.win, { onClose: () => closed++, navigate() {} });
    f.refresh();
    assert.equal(f.win.history.state.billSheet, undefined);
    c.requestClose(); f.flush();
    assert.equal(f.index(), 0, "남는 칸 없음"); assert.equal(closed, 1);
  }
  // 휴대폰 뒤로가기
  {
    const f = fakeWindow(); let closed = 0;
    const c = sh.attachSheetHistory(f.win, { onClose: () => closed++, navigate() {} });
    f.win.history.back(); f.flush();
    assert.equal(closed, 1); assert.equal(f.index(), 0);
    c.detach(); f.flush();
    assert.equal(f.index(), 0);
  }
  // 시트 안 결제하기 → 칸을 먼저 되돌리고 이동(돌아왔을 때 헛걸음 없음)
  {
    const f = fakeWindow(); const went = []; let closed = 0;
    const c = sh.attachSheetHistory(f.win, { onClose: () => closed++, navigate: (href) => went.push(href) });
    c.leaveTo("/payments/i-1");
    assert.deepEqual(went, [], "칸을 되돌리기 전에는 이동하지 않는다");
    f.flush();
    assert.equal(f.index(), 0); assert.deepEqual(went, ["/payments/i-1"]); assert.equal(closed, 1);
  }
  // 열린 달이 목록에서 사라져 저절로 닫힘 → 정리 단계에서 남은 칸 되돌림
  {
    const f = fakeWindow(); let closed = 0;
    const c = sh.attachSheetHistory(f.win, { onClose: () => closed++, navigate() {} });
    c.detach(); f.flush();
    assert.equal(f.index(), 0, "남는 칸 없음");
    assert.equal(closed, 0, "이미 사라진 시트에 닫기를 다시 부르지 않는다");
    assert.equal(f.listeners.size, 0);
  }
  // 개발 모드(StrictMode) 붙였다 떼었다 다시 붙임 → 칸 하나를 이어 쓰고, 열린 채 유지
  {
    const f = fakeWindow(); let closed = 0;
    const first = sh.attachSheetHistory(f.win, { onClose: () => closed++, navigate() {} });
    first.detach();
    const second = sh.attachSheetHistory(f.win, { onClose: () => closed++, navigate() {} });
    f.flush();
    assert.equal(f.length(), 2, "칸은 하나만"); assert.equal(f.index(), 1, "열린 채"); assert.equal(closed, 0);
    second.requestClose(); f.flush();
    assert.equal(f.index(), 0); assert.equal(closed, 1);
  }
});
