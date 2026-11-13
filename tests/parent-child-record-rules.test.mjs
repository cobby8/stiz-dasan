// 학부모 «아이 기록»(/mypage/record, 2026-11-14 원장 결정 w1~w4·q1~q4) — 실제로 실행·렌더해서 확인한다.
//  ① 순수 규칙: 청구 달(빈 year/month)·월말·연말·환불/취소 제외·분모 0·보강 대체·타임라인 정렬
//  ② IDOR: 남의 아이 id 면 첫 SQL 0행 → null, 다른 조회(다닌 기간 포함)는 돌지 않는다
//  ③ 렌더: 빈 데이터·형제·미납 있음 / 청구 탭 요약 줄·월 묶음·한 줄 행
//  ④ 소스 가드: 캐시 금지·비밀값 미조회·시간대 두 번 변환·탭 소속
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

const link = { __esModule: true, default: ({ children, prefetch, ...props }) => React.createElement("a", props, children) };
const rules = load("src/lib/parent/childRecordRules.ts");

// ── ① 순수 규칙 ────────────────────────────────────────────────────────────

const pay = (id, extra = {}) => ({
  id, type: "MONTHLY", status: "PAID", amount: 100000, year: 2026, month: 11,
  dueYmd: "2026-11-10", paidYmd: "2026-11-05", description: "11월 수강료", receiptUrl: null, ...extra,
});

test("① 청구 달: year/month 가 비면 납기일(KST)의 달, 틀린 값도 납기일로", () => {
  assert.equal(rules.billingYm(pay("a")), "2026-11");
  assert.equal(rules.billingYm(pay("b", { year: null, month: null, dueYmd: "2026-01-31" })), "2026-01");
  assert.equal(rules.billingYm(pay("c", { year: 2026, month: 13, dueYmd: "2025-12-31" })), "2025-12", "13월은 버리고 납기일");
  assert.equal(rules.billingYm(pay("d", { year: null, month: null, dueYmd: null })), null);
  assert.equal(rules.paymentKind("TUITION"), "TUITION");
  assert.equal(rules.paymentKind("MONTHLY"), "TUITION");
  assert.equal(rules.paymentKind("SPECIAL"), "SPECIAL");
  assert.equal(rules.paymentKind("무엇"), "OTHER", "모르는 종류는 기타");
  assert.equal(rules.paymentStatusLabel("CANCELED"), "확인 중", "영어 코드를 그대로 보이지 않는다");
});

test("① 합계: 환불·취소는 납부 합계·종류 구성에서 빠지고, 미납은 해와 상관없이 전부", () => {
  const rows = [
    pay("p1"),
    pay("p2", { status: "REFUNDED", amount: 50000 }),
    pay("p3", { status: "CANCELED", amount: 70000 }),
    pay("p4", { status: "PENDING", amount: 30000, year: 2025, month: 12, dueYmd: "2025-12-10", paidYmd: null }),
    pay("p5", { status: "OVERDUE", amount: 20000, type: "SHUTTLE" }),
  ];
  const s = rules.summarizePayments(rows, 2026);
  assert.equal(s.paidTotal, 100000);
  assert.equal(s.paidCount, 1);
  assert.equal(s.unpaidCount, 2, "작년 미납도 센다");
  assert.equal(s.unpaidTotal, 50000);
  assert.deepEqual(s.kindCounts, { TUITION: 1, SHUTTLE: 1, SPECIAL: 0, UNIFORM: 0, OTHER: 0 });
  assert.equal(rules.summarizePayments([], 2026).paidTotal, 0);
});

test("① 월 묶음: 최신 달부터, 이번 달·미납 달만 펼침, 머리줄 합계는 환불 제외, 취소는 안 보인다", () => {
  const rows = [
    pay("a", { month: 9, dueYmd: "2026-09-10" }),
    pay("b", { status: "PENDING", month: 10, dueYmd: "2026-10-10", paidYmd: null }),
    pay("c", { month: 10, dueYmd: "2026-10-01" }),
    pay("d", { month: 11 }),
    pay("e", { status: "REFUNDED", month: 11, amount: 9000 }),
    pay("f", { status: "CANCELED", month: 11 }),
    pay("g", { year: 2025, month: 12, dueYmd: "2025-12-10" }),
  ];
  const groups = rules.groupPaymentsByMonth(rows, 2026, "2026-11");
  assert.deepEqual(groups.map((g) => g.ym), ["2026-11", "2026-10", "2026-09"]);
  assert.deepEqual(groups.map((g) => g.defaultOpen), [true, true, false]);
  assert.equal(groups[0].count, 2, "취소 제외");
  assert.equal(groups[0].total, 100000, "환불 금액 제외");
  assert.equal(groups[0].label, "11월");
  assert.equal(groups[1].rows[0].id, "b", "같은 달 안에서는 미납 먼저");
  assert.deepEqual(rules.groupPaymentsByMonth(rows, 2025, "2026-11").map((g) => g.ym), ["2025-12"]);
  // 필터: 종류·상태
  assert.deepEqual(rules.filterPayments(rows, { kinds: [], statuses: ["UNPAID"] }).map((r) => r.id), ["b"]);
  assert.deepEqual(rules.filterPayments(rows, { kinds: ["SHUTTLE"], statuses: [] }), []);
  assert.equal(rules.activeFilterCount({ kinds: ["TUITION"], statuses: ["PAID", "REFUNDED"] }), 3);
});

test("① 연도 칩: 청구·출석이 있는 해 + 올해, 최신부터, 미래 해는 없음 / 주소 연도는 목록 안에서만", () => {
  const years = rules.recordYears({
    payments: [pay("a", { year: 2025, month: 3 }), pay("b", { year: 2027, month: 1 }), pay("c", { status: "CANCELED", year: 2023, month: 1 })],
    attendanceMonths: [{ ym: "2024-09" }],
    currentYear: 2026,
  });
  assert.deepEqual(years, [2026, 2025, 2024]);
  assert.equal(rules.pickRecordYear("2025", years, 2026), 2025);
  assert.equal(rules.pickRecordYear("2019", years, 2026), 2026);
  assert.equal(rules.pickRecordYear(undefined, years, 2026), 2026);
});

test("① 출석률: (출석+지각) ÷ (출석+지각+결석−보강 대체), 분모 0 이면 null(0% 아님)", () => {
  assert.equal(rules.attendanceRate({ present: 7, late: 1, absent: 2, makeupReplaced: 0 }), 80);
  assert.equal(rules.attendanceRate({ present: 7, late: 1, absent: 2, makeupReplaced: 2 }), 100, "보강으로 대체된 미리 알린 결석은 분모에서 뺀다");
  assert.equal(rules.attendanceRate({ present: 0, late: 0, absent: 0, makeupReplaced: 0 }), null);
  assert.equal(rules.attendanceRate({ present: 0, late: 0, absent: 1, makeupReplaced: 1 }), null, "결석이 전부 대체되면 기록 없음");
  assert.equal(rules.attendanceRate({ present: 0, late: 0, absent: 3, makeupReplaced: 0 }), 0);
  const y = rules.yearAttendance([
    { ym: "2025-12", present: 9, late: 0, absent: 0, makeupReplaced: 0 },
    { ym: "2026-01", present: 3, late: 1, absent: 0, makeupReplaced: 0 },
    { ym: "2026-02", present: 2, late: 0, absent: 2, makeupReplaced: 0 },
  ], 2026);
  assert.equal(y.rate, 75, "그해 달만 합친다(작년 12월 제외)");
});

test("① 최근 12개월 막대: 연말을 넘어 이어지고, 기록 없는 달은 null + 묶음 글", () => {
  const bars = rules.recentAttendanceBars([
    { ym: "2025-12", present: 4, late: 0, absent: 0, makeupReplaced: 0 },
    { ym: "2026-01", present: 3, late: 0, absent: 1, makeupReplaced: 0 },
  ], "2026-01", 12);
  assert.equal(bars.length, 12);
  assert.equal(bars[0].ym, "2025-02");
  assert.equal(bars[11].ym, "2026-01");
  assert.equal(bars[10].rate, 100);
  assert.equal(bars[11].rate, 75);
  assert.equal(bars[0].rate, null);
  assert.equal(bars[11].label, "1월");
  assert.equal(rules.missingMonthsText(bars), "25년 2월~25년 11월");
  // 월말 기준: 3월 31일이 «이번 달»이어도 달 단위로만 센다
  const march = rules.recentAttendanceBars([], "2026-03", 3);
  assert.deepEqual(march.map((b) => b.ym), ["2026-01", "2026-02", "2026-03"]);
});

test("① 다닌 기간 글: 기준값 있으면 «실제 수강 · 첫 등록», 없으면 «사이트 기록 기준»", () => {
  assert.deepEqual(rules.tenureText({ label: "3년 2개월", firstMonth: "2022-09" }, true), { main: "실제 수강 3년 2개월", sub: "첫 등록 2022.09" });
  assert.deepEqual(rules.tenureText({ label: "8개월", firstMonth: "2026-04" }, false), { main: "사이트 기록 기준 8개월", sub: "첫 기록 2026.04" });
  assert.equal(rules.tenureText(null, true), null);
  assert.equal(rules.homeRecordLine({ tenureLabel: "3년 2개월", hasBaseline: true, yearRate: 92 }), "다닌 지 3년 2개월 · 올해 출석 92%");
  assert.equal(rules.homeRecordLine({ tenureLabel: null, hasBaseline: false, yearRate: null }), "전체 기록");
});

test("① 타임라인: 최신부터·같은 날은 퇴원→복귀→휴원→반 변경→입반 / 반 변경으로 생긴 등록은 입반 줄 없음 / 상태만 바뀐 등록", () => {
  const ev = rules.buildTimeline({
    today: "2026-11-14",
    enrollments: [
      { id: "e1", classId: "A", className: "월 4시", status: "WITHDRAWN", startsOn: null, createdYmd: "2025-03-02", updatedYmd: "2026-05-01" },
      { id: "e2", classId: "B", className: "수 5시", status: "PAUSED", startsOn: "2026-05-01", createdYmd: "2026-04-28", updatedYmd: "2026-09-01" },
      { id: "e3", classId: "C", className: "토 10시", status: "WITHDRAWN", startsOn: null, createdYmd: "2025-01-05", updatedYmd: "2025-08-31" },
    ],
    changes: [
      { id: "r1", enrollmentId: "e1", kind: "CLASS_CHANGE", status: "APPLIED", effectiveFrom: "2026-05-01", resumeOn: null, fromClassId: "A", toClassId: "B", fromClassName: "월 4시", toClassName: "수 5시" },
      { id: "r2", enrollmentId: "e2", kind: "PAUSE", status: "APPLIED", effectiveFrom: "2026-09-01", resumeOn: "2026-12-01", fromClassId: "B", toClassId: null, fromClassName: "수 5시", toClassName: null },
      { id: "r3", enrollmentId: "e2", kind: "RESUME", status: "APPROVED", effectiveFrom: "2026-12-01", resumeOn: null, fromClassId: "B", toClassId: null, fromClassName: "수 5시", toClassName: null },
    ],
  });
  assert.deepEqual(ev.map((e) => `${e.ymd} ${e.kind}`), [
    "2026-12-01 RESUME",
    "2026-09-01 PAUSE",
    "2026-05-01 CLASS_CHANGE",
    "2025-08-31 WITHDRAW",
    "2025-03-02 JOIN",
    "2025-01-05 JOIN",
  ]);
  assert.equal(ev[0].scheduled, true, "승인됐지만 적용 전 = 예정");
  assert.equal(ev[1].title, "수 5시 · 12/1 복귀 예정");
  assert.equal(ev[2].title, "월 4시 → 수 5시");
  assert.ok(!ev.some((e) => e.key === "j-e2"), "반 변경으로 생긴 등록은 입반 줄이 따로 없다");
  assert.ok(!ev.some((e) => e.key === "w-e1"), "반 변경으로 빠진 옛 반은 퇴원 줄이 따로 없다");
  assert.ok(!ev.some((e) => e.key === "p-e2"), "휴원 신청이 있으면 상태 휴원 줄을 또 만들지 않는다");
  // 같은 날 정렬(최신 일부터 보이므로 같은 날은 뒤 단계가 위)
  const same = rules.buildTimeline({
    today: "2026-11-14",
    enrollments: [{ id: "x", classId: "X", className: "X반", status: "WITHDRAWN", startsOn: "2026-03-02", createdYmd: "2026-03-01", updatedYmd: "2026-03-02" }],
    changes: [],
  });
  assert.deepEqual(same.map((e) => e.kind), ["WITHDRAW", "JOIN"]);
});

test("① 유니폼: 상태 글은 기록 값 그대로, 무료 링크는 상태만", () => {
  assert.equal(rules.uniformStatusText(" 보유 "), "보유");
  assert.equal(rules.uniformStatusText(null), null);
  assert.equal(rules.freeUniformText({ status: "USED", expired: false }), "3년 무료 유니폼 신청 완료");
  assert.equal(rules.freeUniformText({ status: "ISSUED", expired: true }), "3년 무료 유니폼 링크 기간 지남");
  assert.equal(rules.freeUniformText(null), null);
});

// ── ② IDOR — 남의 아이 id ────────────────────────────────────────────────────

function loadQuery(fakeRows, tenureCalls) {
  const calls = [];
  const db = {
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      return fakeRows(sql, values);
    },
  };
  const q = load("src/lib/parent/childRecordQuery.ts", {
    "@/lib/prisma": { prisma: db },
    "@/lib/account/child-access": { childAccessSql: async (alias, expr) => `${alias}."parentId" = ${expr}` },
    "@/lib/payments/payerAccess": { payerAccessSql: async (alias, expr) => `${alias}."parentId" = ${expr}` },
    "@/lib/student-tenure-query": { getStudentTenure: async (id) => { tenureCalls.push(id); return { label: "1년", firstMonth: "2025-11", actualMonths: 12, spanMonths: 13, spanLabel: "1년 1개월" }; } },
    // 2026-11-14 아이 정보·셔틀 칸 — 서버 전용 셔틀 조회·연간일정은 가짜로(셔틀 상세는 parent-child-profile-shuttle 테스트)
    "@/lib/shuttle/parent": { getParentShuttleOverview: async () => [], getShuttleDriverContact: async () => null },
    "@/lib/enrollment/monthlyClassDates": { loadAnnualPlanEvents: async () => [], getMonthlyClassDates: () => [] },
  });
  return { q, db, calls };
}

test("② 남의 아이 id → 첫 SQL(학생 id + 보호자 연결 + 병합 제외) 0행 → null, 다른 조회·다닌 기간은 돌지 않는다", async () => {
  const tenureCalls = [];
  const { q, calls } = loadQuery(() => [], tenureCalls);
  const result = await q.getChildRecord("parent-me", "child-of-someone-else");
  assert.equal(result, null);
  assert.equal(calls.length, 1, "권한 확인 한 번만");
  assert.match(calls[0].sql, /WHERE s\.id = \$2 AND s\."parentId" = \$1 AND s\."mergedIntoStudentId" IS NULL/);
  assert.deepEqual(calls[0].values, ["parent-me", "child-of-someone-else"]);
  assert.equal(tenureCalls.length, 0, "getStudentTenure 는 권한 확인 뒤에만");
  assert.equal(await q.getChildRecord("", "x"), null);
  assert.equal(await q.getChildRecord("parent-me", ""), null);
});

test("② 내 아이 → 섹션별 조회, 결제 권한이 없으면 금액·영수증 비움, 섹션 하나가 실패해도 나머지는 그대로", async () => {
  const tenureCalls = [];
  const make = (canPay) => loadQuery((sql) => {
    if (sql.includes(`WHERE s.id = $2`)) return [{ id: "kid", name: "합성", hasBaseline: true, uniformStatus: "보유", uniformReceivedYmd: "2026-03-02", canPay }];
    if (sql.includes(`FROM "Payment" p`)) return [{ id: "p1", type: "MONTHLY", status: "PAID", amount: 255000, year: 2026, month: 11, dueYmd: "2026-11-10", paidYmd: "2026-11-03", description: "11월", receiptUrl: "https://r.example/1" }];
    if (sql.includes(`FROM "Attendance" a`)) return [{ ym: "2026-11", present: 3, late: 1, absent: 0, makeupReplaced: 0 }];
    if (sql.includes(`FROM "SpecialProgramEnrollmentDate"`)) throw new Error("boom");
    if (sql.includes(`FROM "UniformFreeGrant"`)) return [{ status: "ISSUED", expired: false }];
    if (sql.includes(`FROM "Feedback"`)) return [{ reports: 4, feedbacks: 2 }];
    return [];
  }, tenureCalls);
  const mine = await make(true).q.getChildRecord("parent-me", "kid");
  assert.equal(mine.student.id, "kid");
  assert.equal(mine.payments[0].amount, 255000);
  assert.equal(mine.payments[0].receiptUrl, "https://r.example/1");
  assert.equal(mine.attendance[0].present, 3);
  assert.equal(mine.seasonal, null, "실패한 섹션만 null");
  assert.deepEqual(mine.reports, { reports: 4, feedbacks: 2 });
  assert.deepEqual(mine.uniform.freeGrant, { status: "ISSUED", expired: false });
  assert.deepEqual(tenureCalls, ["kid"]);
  const family = await make(false).q.getChildRecord("parent-me", "kid");
  assert.equal(family.payments[0].amount, null, "결제 권한 없으면 금액 없음");
  assert.equal(family.payments[0].receiptUrl, null);
});

// ── ③ 렌더 ─────────────────────────────────────────────────────────────────

const charts = {
  "next/link": link,
  "@/components/admin/list/ListDetailPanel": { __esModule: true, default: ({ children }) => React.createElement("div", { "data-sheet": "1" }, children) },
};
const ChildRecordClient = load("src/app/mypage/record/ChildRecordClient.tsx", charts).default;
const today = load("src/lib/datetime/kst.ts").todayKst();
const thisYear = Number(today.slice(0, 4));
const thisMonth = Number(today.slice(5, 7));
const baseRecord = (extra = {}) => ({
  student: { id: "kid", name: "합성", canPay: true, hasBaseline: true },
  today,
  payments: [], attendance: [], timeline: { enrollments: [], changes: [] }, seasonal: [],
  uniform: { status: null, receivedYmd: null, freeGrant: null }, reports: { reports: 0, feedbacks: 0 }, tenure: null,
  ...extra,
});

test("③ 빈 데이터: 요약 4칸·옛 기록 안내·빈 칸 문구, 0% 대신 «기록 없음»", () => {
  const html = renderToStaticMarkup(React.createElement(ChildRecordClient, { record: baseRecord(), childList: [{ id: "kid", name: "합성" }], initialYear: null }));
  assert.match(html, /합성 기록/);
  for (const label of ["다닌 기간", "올해 출석률", "올해 납부", "미납"]) assert.ok(html.includes(label), label);
  assert.match(html, /2026년 4월 이전 출석·일부 청구는 기록이 없어요/);
  assert.match(html, /최근 12개월 출석 기록이 없어요/);
  assert.match(html, /청구가 없어요/);
  assert.match(html, /수강 기록이 없어요/);
  assert.doesNotMatch(html, /0%/);
  assert.doesNotMatch(html, /자녀 선택/, "아이가 하나면 칩 없음");
  assert.doesNotMatch(html, /material-symbols/, "아이콘 대신 글자");
});

test("③ 형제 + 미납 있음: 아이 칩(지금 아이 표시)·미납 칸 경고·월 카드(청구월·합계·상태)·영수증은 시트·막대", () => {
  const ym = `${thisYear}-${String(thisMonth).padStart(2, "0")}`;
  const record = baseRecord({
    payments: [
      { id: "p1", type: "MONTHLY", status: "PENDING", amount: 255000, year: thisYear, month: thisMonth, dueYmd: `${ym}-10`, paidYmd: null, description: "이번 달 수강료", receiptUrl: null },
      { id: "p2", type: "SHUTTLE", status: "PAID", amount: 40000, year: thisYear, month: thisMonth, dueYmd: `${ym}-10`, paidYmd: `${ym}-02`, description: "셔틀비", receiptUrl: "https://r.example/2" },
    ],
    attendance: [{ ym, present: 3, late: 1, absent: 0, makeupReplaced: 0 }],
    timeline: { enrollments: [{ id: "e", classId: "A", className: "월 4시", status: "ACTIVE", startsOn: null, createdYmd: "2025-03-02", updatedYmd: "2025-03-02" }], changes: [] },
    tenure: { label: "1년 8개월", firstMonth: "2025-03" },
  });
  const html = renderToStaticMarkup(React.createElement(ChildRecordClient, {
    record, childList: [{ id: "kid", name: "합성" }, { id: "kid2", name: "합성 둘째" }], initialYear: null,
  }));
  assert.match(html, /aria-label="자녀 선택"/);
  assert.match(html, /href="\/mypage\/record\?child=kid2"/);
  assert.match(html, /aria-current="page"[^>]*>합성</);
  assert.match(html, /실제 수강 1년 8개월/);
  assert.match(html, /첫 등록 2025\.03/);
  assert.match(html, /100%/, "올해 출석률(출석3+지각1 / 4)");
  assert.match(html, /href="\/mypage\/payments"/, "미납 칸은 청구 탭으로");
  // 2026-11-14 월 카드: 한 달 = 한 줄 «11월 · 295,000원 · 일부 납부» — 세부(항목·영수증)는 누르면 시트
  assert.match(html, new RegExp(`data-month-bill="${ym}"[^>]*>[^]*?${thisMonth}월[^]*?295,000원[^]*?일부 납부`), "월 카드");
  assert.doesNotMatch(html, /r\.example\/2/, "영수증은 세부 시트에서");
  assert.doesNotMatch(html, /이번 달 수강료/, "항목 줄은 카드에 없다");
  assert.match(html, /입반/);
  assert.match(html, new RegExp(`href="/mypage/classes\\?child=kid&amp;month=${ym}"`), "달력 보기 ▸");
  assert.match(html, /<svg/, "출석 막대");
});

test("③ 청구 탭: 요약 줄(올해 납부·미납·연도별 보기)·형제 칩·월 카드 한 줄, 누르면 시트에 결제하기·입금·영수증", () => {
  const Client = load("src/app/mypage/payments/PaymentRequestClient.tsx", {
    "next/link": link,
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/components/parent/VirtualAccountNotice": { __esModule: true, default: () => null },
  }).default;
  const ym = `${thisYear}-${String(thisMonth).padStart(2, "0")}`;
  const row = (id, extra = {}) => ({ paymentId: id, studentId: "s1", studentName: "첫째", description: "수강료", amount: 100000, status: "PAID", dueDate: `${ym}-10`, paidDate: `${ym}-03`, invoiceNo: null, invoiceId: `i-${id}`, canCheckout: true, receiptUrl: null, virtualAccount: null, pending: [], resolved: [], ...extra });
  const rows = [row("a", { status: "PENDING", paidDate: null }), row("b", { receiptUrl: "https://r.example/b" }), row("c", { studentId: "s2", studentName: "둘째" })];
  const html = renderToStaticMarkup(React.createElement(Client, { payReady: true, rows }));
  assert.match(html, /올해 납부 <b class="font-semibold">200,000원<\/b>/);
  assert.match(html, /미납 1건/);
  assert.match(html, /href="\/mypage\/record\?child=s1"[\s\S]*연도별 보기 ▸/);
  assert.match(html, /aria-label="자녀 선택"[\s\S]*전체[\s\S]*첫째[\s\S]*둘째/);
  // 형제·종류가 섞여도 한 달 = 카드 한 줄(청구월·합계·상태) — 세부는 시트
  assert.equal((html.match(/data-month-bill=/g) || []).length, 1, "한 달에 카드 하나");
  assert.match(html, new RegExp(`${thisMonth}월[^]*?300,000원[^]*?일부 납부`));
  assert.doesNotMatch(html, /href="\/payments\/i-a"/, "결제하기는 카드가 아니라 시트 안");
  // 시트를 연 상태: 아이별 항목 · 기존 결제하기 링크 그대로 · 입금 알림 · 영수증 보기/요청
  const sheet = renderToStaticMarkup(React.createElement(Client, { payReady: true, rows, initialOpenYm: ym }));
  assert.match(sheet, /role="dialog"/);
  assert.match(sheet, new RegExp(`${thisMonth}월 청구`));
  assert.match(sheet, /<h3[^>]*>첫째<\/h3>[\s\S]*<h3[^>]*>둘째<\/h3>/, "형제면 아이별로 나눈다");
  assert.match(sheet, /href="\/payments\/i-a"[^>]*>결제하기</, "미납 항목의 결제하기 그대로");
  assert.match(sheet, /이미 계좌로 입금했어요/);
  assert.match(sheet, /href="https:\/\/r\.example\/b"[^>]*>영수증 보기</, "납부 완료 항목의 영수증");
  assert.match(sheet, />영수증 요청</, "영수증이 없으면 요청 버튼");
  assert.doesNotMatch(sheet, /영수증 요청하기/);
});

// ── ④ 소스 가드 ─────────────────────────────────────────────────────────────

test("④ 화면·조회 가드: 인증·되돌림·캐시 금지·비밀값 미조회·시간대 두 번 변환·탭 소속·진입 3곳", () => {
  const page = read("src/app/mypage/record/page.tsx");
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /requireVerifiedParent\(\)\.catch\(\(\) => null\)/);
  assert.match(page, /redirect\("\/mypage\/continue\?bounced=1"\)/);
  const query = read("src/lib/parent/childRecordQuery.ts");
  // 주석(설명 문장)은 빼고 코드만 본다
  const code = query.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
  assert.doesNotMatch(code, /unstable_cache|depositSecretHash|"token"|\btoken\b/);
  assert.doesNotMatch(query, /UniformOrderItem/);
  assert.match(query, /const kstNaive = \(col: string\) => `\(\(\$\{col\} AT TIME ZONE 'UTC'\) AT TIME ZONE 'Asia\/Seoul'\)`/);
  for (const col of [`se.date`, `p."dueDate"`, `p."paidDate"`, `e."createdAt"`, `e."updatedAt"`]) {
    assert.ok(query.includes(`kstNaive(\`${col}\`)`) || query.includes(`kstNaive("${col}")`), `${col} 은 두 번 변환`);
  }
  assert.doesNotMatch(query, /prisma\.\w+\.(findMany|findFirst|findUnique|create|update|upsert)/);
  const nav = load("src/app/mypage/MyPageBottomNav.tsx", { "next/link": link, "next/navigation": { usePathname: () => "/" } });
  const activeAt = (path) => nav.PARENT_TABS.filter((t) => nav.isParentTabActive(t, path)).map((t) => t.label);
  assert.deepEqual(activeAt("/mypage/record"), ["홈"]);
  assert.deepEqual(activeAt("/mypage"), ["홈"]);
  assert.deepEqual(activeAt("/mypage/payments"), ["청구"], "다른 탭 화면에서 홈이 켜지지 않는다");
  assert.equal(nav.PARENT_TABS.length, 4);
  assert.match(read("src/app/mypage/MyPageClient.tsx"), /href=\{`\/mypage\/record\?child=\$\{encodeURIComponent\(child\.id\)\}`\}/);
  assert.match(read("src/app/mypage/classes/ClassesClient.tsx"), /\/mypage\/record\?child=/);
  assert.match(read("src/app/mypage/payments/PaymentRequestClient.tsx"), /연도별 보기 ▸/);
  // 홈 영수증도 결제 권한자 기준(대표만 → payerAccess)
  const q = read("src/lib/queries.ts");
  assert.doesNotMatch(q, /receiptUrl: s\.parentId === parent\.id/);
  assert.equal((q.match(/receiptUrl: s\.canPay === true \?/g) || []).length, 2);
});
