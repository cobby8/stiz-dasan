import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * 토스POS 결제 «자동 매칭» 회귀 테스트 (2026-11-12 사용자 확인 규칙).
 *
 * 위험은 둘이다. ① 엉뚱한 학생·달·반을 납부 처리하는 것 ② 일부만 납부 처리하는 것.
 * 그래서 판정 규칙은 실제 11월 사례(반드시 처리 / 반드시 보류)를 순수 모듈로 **실행**하고,
 * 쓰기 경로는 가짜 prisma 로 **실행**해 «잠금 → 다시 판정 → 조건부 쓰기 → 0행이면 전부 되돌림»을 본다.
 */

const MODULE = "src/lib/pos/auto-match.mjs";
const SERVICE = "src/lib/pos/autoMatchService.ts";
const NOTICE_SERVICE = "src/lib/pos/paymentNoticeService.ts";
const ROUTE = "src/app/api/cron/pos-auto-match/route.ts";

const M = await import(pathToFileURL(path.resolve(MODULE)).href);

// ───────────────────────── 실제 사례 데이터 ─────────────────────────

const B2 = "2호점 : 행정복지센터";
const students = [
  { id: "s-sangwon", name: "김상원", parentId: "pa-1", branch: B2 },
  { id: "s-luna", name: "김루나", parentId: "pa-2", branch: B2 },
  { id: "s-luhee", name: "김루희", parentId: "pa-2", branch: B2 },
  { id: "s-dokyung", name: "이도경", parentId: "pa-3", branch: B2 },
  { id: "s-jiyu", name: "정지유", parentId: "pa-4", branch: B2 },
  { id: "s-woojun", name: "정우준", parentId: "pa-4", branch: B2 },
  { id: "s-jihu", name: "박지후", parentId: "pa-5", branch: B2 },
  { id: "s-chanmin", name: "박찬민", parentId: "pa-6", branch: B2 },
  { id: "s-other8", name: "최다온", parentId: "pa-7", branch: B2 },
  { id: "s-siwoo1", name: "강시우", parentId: "pa-8", branch: B2 },
  { id: "s-siwoo2", name: "김시우", parentId: "pa-9", branch: B2 },
  { id: "s-b1", name: "윤하람", parentId: "pa-10", branch: "1호점 : 다산" },
];

let seq = 0;
const charge = (studentId, className, amount, over = {}) => ({
  id: `p-${studentId}-${className.replace(/\s/g, "")}-${over.month ?? 11}-${(seq += 1)}`,
  studentId, className, amount, status: "PENDING", type: "MONTHLY", year: 2026, month: 11,
  invoiceStatus: "ISSUED", invoiceAmount: amount, staffPending: false, chargeRequestOpen: false, rallyzMirror: false, otherNotice: false,
  ...over,
});

const baseCharges = () => [
  charge("s-sangwon", "목요일 6교시", 90000),
  charge("s-sangwon", "화요일 6교시", 90000),
  charge("s-sangwon", "목요일 6교시", 90000, { month: 10, status: "PAID" }),
  charge("s-luna", "목요일 3교시", 90000),
  charge("s-luhee", "목요일 3교시", 90000),
  // 10월 미납 사본이 남아 있어도(메모에 달 없음 → 승인일 11월) 10월로 넘어가지 않는다
  charge("s-luna", "목요일 3교시", 90000, { month: 10 }),
  charge("s-luhee", "목요일 3교시", 90000, { month: 10 }),
  charge("s-dokyung", "수요일 3교시", 110000),
  ...["금요일 6교시", "수요일 6교시", "월요일 6교시"].flatMap((c) => [charge("s-jiyu", c, 72000), charge("s-woojun", c, 72000)]),
  charge("s-jihu", "화요일 4교시", 110000), // 수강료 100,000 + 셔틀비 10,000
  charge("s-chanmin", "화요일 8교시", 120000),
  charge("s-other8", "화요일 8교시", 100000),
];

const order = ({ id = "o-1", payId = "pay-1", amount, items, memo = "", state = "APPROVED", sourceType = "CARD", payments }) => ({
  id, memo,
  lineItems: items.map(([title, itemMemo = "", quantity = 1]) => ({ item: { title }, memo: itemMemo, quantity })),
  payments: payments ?? [{ id: payId, amount, state, sourceType, approvedAt: "2026-11-12T05:56:19Z" }],
});

const decide = (o, over = {}) =>
  M.decideAutoMatch({
    order: o,
    tossPaymentId: o.payments[0]?.id ?? "pay-1",
    amount: o.payments[0]?.amount ?? 0,
    kstDate: "2026-11-12",
    students,
    charges: baseCharges(),
    ...over,
  });

const allocs = (r) => r.allocations.map((a) => `${a.studentName}|${a.className}|${a.amount}`);

// ───────────────────────── 반드시 자동 처리 ─────────────────────────

test("김상원 180,000 — 목6(메모 «김상원 11월») + 화6(메모 없음) ⇒ 11월 목6·화6 두 청구", () => {
  const r = decide(order({ amount: 180000, items: [["목요일 6교시", "김상원 11월"], ["화요일 6교시", ""]] }), { kstDate: "2026-11-10" });
  assert.equal(r.decision, "MATCH", r.reason);
  assert.equal(r.rule, "NAMED");
  assert.deepEqual([r.year, r.month], [2026, 11]);
  assert.deepEqual(allocs(r), ["김상원|목요일 6교시|90000", "김상원|화요일 6교시|90000"]);
});

test("«루나루희» 목3×2 180,000 ⇒ 형제 김루나·김루희 각 목3 90,000 (10월 미납 사본으로 넘어가지 않음)", () => {
  const r = decide(order({ amount: 180000, items: [["목요일 3교시", "루나루희", 2]] }));
  assert.equal(r.decision, "MATCH", r.reason);
  assert.deepEqual(allocs(r), ["김루나|목요일 3교시|90000", "김루희|목요일 3교시|90000"]);
  assert.ok(r.allocations.every((a) => !a.paymentId.includes("-10-")), "11월 청구만");
});

test("«도경» 수3 110,000 ⇒ 이도경(이름만, 명단에 한 명) 수3 110,000", () => {
  const r = decide(order({ amount: 110000, items: [["수요일 3교시", "도경"]] }), { kstDate: "2026-11-11" });
  assert.equal(r.decision, "MATCH", r.reason);
  assert.deepEqual(allocs(r), ["이도경|수요일 3교시|110000"]);
});

test("«정지유 11월\\n정우준 11월» 432,000 ⇒ 형제 6개 청구(각 72,000)", () => {
  const r = decide(
    order({ amount: 432000, memo: "정지유 11월\n정우준 11월", items: [["금요일 6교시", "", 2], ["수요일 6교시", "", 2], ["월요일 6교시", "", 2]] }),
    { kstDate: "2026-11-06" },
  );
  assert.equal(r.decision, "MATCH", r.reason);
  assert.equal(r.allocations.length, 6);
  assert.equal(r.allocations.reduce((s, a) => s + a.amount, 0), 432000);
  assert.deepEqual([...new Set(r.allocations.map((a) => a.studentName))].sort(), ["정우준", "정지유"]);
});

test("박찬민형 — 메모 없이 반·금액만: 그 반·월에 금액 맞는 미납이 정확히 하나 ⇒ 처리", () => {
  const r = decide(order({ amount: 120000, items: [["화요일 8교시", ""]] }), { kstDate: "2026-11-10" });
  assert.equal(r.decision, "MATCH", r.reason);
  assert.equal(r.rule, "ANONYMOUS");
  assert.deepEqual(allocs(r), ["박찬민|화요일 8교시|120000"]);
});

test("성 + 형제 이어 쓰기(«김루나루희»)도 같은 보호자면 처리", () => {
  const r = decide(order({ amount: 180000, items: [["목요일 3교시", "김루나루희", 2]] }));
  assert.equal(r.decision, "MATCH", r.reason);
  assert.equal(r.allocations.length, 2);
});

test("메모 달이 승인일과 달라도 메모 달이 우선(10/28 결제 «11월»)", () => {
  const r = decide(order({ amount: 110000, items: [["수요일 3교시", "이도경 11월"]] }), { kstDate: "2026-10-28" });
  assert.equal(r.decision, "MATCH", r.reason);
  assert.equal(r.month, 11);
});

// ───────────────────────── 반드시 보류 ─────────────────────────

const assertHold = (r, pattern) => {
  assert.equal(r.decision, "HOLD", `보류여야 함: ${JSON.stringify(r.allocations ?? [])}`);
  if (pattern) assert.match(r.reason, pattern);
};

test("박지후 100,000 vs 청구 110,000(수강료+셔틀비) ⇒ 보류(금액 불일치)", () => {
  assertHold(decide(order({ amount: 100000, items: [["화요일 4교시", "박지후 11월"]] })), /맞는 묶음이 없습니다/);
});

test("후보 둘 이상 ⇒ 보류: 같은 반·같은 달 미납이 두 건", () => {
  const charges = [...baseCharges(), charge("s-sangwon", "목요일 6교시", 90000)];
  assertHold(decide(order({ amount: 180000, items: [["목요일 6교시", "김상원 11월"], ["화요일 6교시"]] }), { charges }), /둘 이상/);
});

test("후보 둘 이상 ⇒ 보류: 메모 없이 반·금액만인데 맞는 학생이 둘", () => {
  const charges = [...baseCharges(), charge("s-other8", "화요일 8교시", 120000, { id: "p-dup" })].filter((c) => c.amount !== 100000);
  assertHold(decide(order({ amount: 120000, items: [["화요일 8교시"]] }), { charges }), /둘 이상/);
});

test("메모 없는 결제는 한 학생 청구로만 — 두 학생 청구를 합쳐 맞추지 않는다", () => {
  // 목3 2칸 180,000 은 김루나+김루희로만 맞출 수 있다 → 이름이 없으면 보류
  assertHold(decide(order({ amount: 180000, items: [["목요일 3교시", "", 2]] })));
});

test("이름만(«시우») 같은 이름 학생 둘 ⇒ 보류", () => {
  assertHold(decide(order({ amount: 90000, items: [["목요일 3교시", "시우"]] })), /이름이 같은 학생 2명/);
});

test("형제 이어 쓰기인데 보호자가 다르면 ⇒ 보류", () => {
  const list = students.map((s) => (s.id === "s-luhee" ? { ...s, parentId: "pa-x" } : s));
  assertHold(decide(order({ amount: 180000, items: [["목요일 3교시", "루나루희", 2]] }), { students: list }));
});

test("다른 지점 학생 ⇒ 보류", () => {
  const charges = [...baseCharges(), charge("s-b1", "월요일 3교시", 90000)];
  assertHold(decide(order({ amount: 90000, items: [["월요일 3교시", "윤하람 11월"]] }), { charges }), /다산2호점 학생이 아닙니다/);
});

test("병합된 학생(명단에 없음) ⇒ 보류", () => {
  const list = students.filter((s) => s.id !== "s-dokyung");
  assertHold(decide(order({ amount: 110000, items: [["수요일 3교시", "이도경 11월"]] }), { students: list }));
});

test("취소·부분취소·분할 결제 ⇒ 보류", () => {
  assertHold(decide(order({ amount: 110000, state: "CANCELLED", items: [["수요일 3교시", "이도경 11월"]] })), /취소/);
  assertHold(decide(order({ amount: 110000, state: "PARTIAL_CANCELLED", items: [["수요일 3교시", "이도경 11월"]] })), /취소/);
  const split = order({
    amount: 0, items: [["수요일 3교시", "이도경 11월"]],
    payments: [
      { id: "pay-a", amount: 60000, state: "APPROVED", sourceType: "CARD" },
      { id: "pay-b", amount: 50000, state: "APPROVED", sourceType: "CARD" },
    ],
  });
  assertHold(M.decideAutoMatch({ order: split, tossPaymentId: "pay-a", amount: 60000, kstDate: "2026-11-12", students, charges: baseCharges() }), /결제가 2건/);
});

test("적용월 불명확(메모에 달 둘) ⇒ 보류", () => {
  assertHold(decide(order({ amount: 110000, items: [["수요일 3교시", "이도경 10월, 11월"]] })), /달이 여럿/);
});

test("메모 조각을 이름으로 못 읽으면(«박주원 주2회», «이현준 A») ⇒ 보류", () => {
  assertHold(decide(order({ amount: 160000, items: [["목요일 3교시", "박주원 주2회"]] })), /이름으로 읽지 못함/);
  assertHold(decide(order({ amount: 180000, items: [["토요일 3교시", "이현준 A 11월"]] })), /이름으로 읽지 못함/);
});

test("메모 이름 학생 중 한 명이 배정에서 빠지면 ⇒ 보류", () => {
  // 정지유 11월 + 정우준 11월 인데 결제가 정지유 3과목(216,000)뿐
  assertHold(
    decide(order({ amount: 216000, memo: "정지유 11월\n정우준 11월", items: [["금요일 6교시"], ["수요일 6교시"], ["월요일 6교시"]] })),
  );
});

test("이미 납부된 달(11/8~12 수동 처리분) ⇒ 미납이 없어 보류(재처리 없음)", () => {
  const charges = baseCharges().map((c) => (c.studentId === "s-luna" || c.studentId === "s-luhee") && c.month === 11 ? { ...c, status: "PAID" } : c);
  assertHold(decide(order({ amount: 180000, items: [["목요일 3교시", "루나루희", 2]] }), { charges }));
});

test("고른 청구가 막혀 있으면 ⇒ 보류(청구서 없음·직원 확인 대기·현장 결제 요청·랠리즈 사본·다른 알림)", () => {
  for (const block of [
    { invoiceStatus: null },
    { invoiceStatus: "PAID" },
    { invoiceAmount: 100000 },
    { staffPending: true },
    { chargeRequestOpen: true },
    { rallyzMirror: true },
    { otherNotice: true },
  ]) {
    const charges = baseCharges().map((c) => (c.studentId === "s-dokyung" ? { ...c, ...block } : c));
    assertHold(decide(order({ amount: 110000, items: [["수요일 3교시", "도경"]] }), { charges }));
  }
});

test("막힌 청구도 후보로 센다 — 막힌 것을 빼서 남은 하나가 «유일»해 보이지 않게", () => {
  const charges = [...baseCharges(), charge("s-sangwon", "목요일 6교시", 90000, { staffPending: true })];
  assertHold(decide(order({ amount: 180000, items: [["목요일 6교시", "김상원 11월"], ["화요일 6교시"]] }), { charges }), /둘 이상/);
});

test("1건 200만원 초과·현금 결제 ⇒ 보류", () => {
  assertHold(decide(order({ amount: 2_100_000, items: [["수요일 3교시", "도경"]] })), /상한/);
  assertHold(decide(order({ amount: 110000, sourceType: "CASH", items: [["수요일 3교시", "도경"]] })), /카드/);
});

test("품목 칸이 너무 많으면 ⇒ 보류", () => {
  assertHold(decide(order({ amount: 90000, items: [["목요일 3교시", "도경", 9]] })), /품목이 9칸/);
});

test("순수: 형제 이어 쓰기·이름만·동명이인 해석", () => {
  assert.deepEqual(M.resolveMemoToken("루나루희", students).students.map((s) => s.id), ["s-luna", "s-luhee"]);
  assert.equal(M.resolveMemoToken("도경", students).how, "GIVEN");
  assert.equal(M.resolveMemoToken("이도경", students).how, "FULL");
  assert.equal(M.resolveMemoToken("시우", students).ok, false);
  assert.equal(M.resolveMemoToken("없는이름", students).ok, false);
});

test("순수: 품목 수량 펼치기·결과 줄", () => {
  assert.deepEqual(M.orderSlots(order({ amount: 1, items: [["목요일 3교시", "", 2], ["화요일 6교시"]] })), ["목요일 3교시", "목요일 3교시", "화요일 6교시"]);
  assert.equal(M.orderSlots({ lineItems: [{ item: { title: "x" }, quantity: 0 }] }), null);
  const r = decide(order({ amount: 180000, items: [["목요일 3교시", "루나루희", 2]] }));
  assert.equal(
    M.buildAutoMatchResultLine(r, "11-12 15:00"),
    "✅ POS 결제 확인 — 사이트 11월 청구 자동 매칭 납부 반영: 김루나 목요일 3교시 ₩90,000 · 김루희 목요일 3교시 ₩90,000 (11-12 15:00)",
  );
  assert.equal(M.autoMatchIdempotencyKey("775962094446645961", "p-1"), "toss-pos:775962094446645961:p-1");
});

// ───────────────────────── 쓰기 경로 (가짜 prisma · 실행) ─────────────────────────

const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = async (file) =>
  ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const fileUrl = (f) => pathToFileURL(path.resolve(f)).href;

const PRISMA_STUB = toDataUrl(`
  const S = () => globalThis.__state;
  const log = (kind, sql, args) => { globalThis.__calls.push({ kind, sql, args }); };
  const answer = (sql, args) => {
    if (/pg_advisory_xact_lock/.test(sql)) return [];
    if (/providerPaymentKey" = \\$1\\s+UNION ALL/.test(sql)) return S().synced ? [{ hit: 1 }] : [];
    if (/SELECT status, "siteMarkedPaid" FROM "PosPaymentNotice"/.test(sql)) return [S().notice ?? { status: "NOTIFIED", siteMarkedPaid: false }];
    if (/FROM "Student" s WHERE s."mergedIntoStudentId" IS NULL/.test(sql)) return S().students;
    if (/FOR UPDATE OF p/.test(sql)) return S().charges.filter((c) => c.year === args[0] && c.month === args[1] && c.status === "PENDING");
    if (/^UPDATE "Payment" p/.test(sql.trim())) return S().paymentZero === args[0] ? [] : [{ id: args[0] }];
    if (/^UPDATE "PaymentInvoice"/.test(sql.trim())) return [{ id: "inv-" + args[0] }];
    if (/^UPDATE "PosPaymentNotice"/.test(sql.trim())) return [{ id: args[0] }];
    if (/FROM "PosPaymentNotice" n/.test(sql)) return S().sweepRows ?? [];
    return [];
  };
  export const prisma = {
    $queryRawUnsafe: async (sql, ...args) => { log("query", sql, args); return answer(sql, args); },
    $executeRawUnsafe: async (sql, ...args) => { log("execute", sql, args); return 1; },
    $transaction: async (fn) => {
      log("tx", "BEGIN", []);
      try { const r = await fn(prisma); log("tx", "COMMIT", []); return r; }
      catch (e) { log("tx", "ROLLBACK", []); throw e; }
    },
  };
`);
const LEDGER_STUB = toDataUrl(`export function revalidatePaymentCaches() { globalThis.__revalidated = (globalThis.__revalidated ?? 0) + 1; }`);
const TOSS_STUB = toDataUrl(`export async function fetchTossOrderById(p) { globalThis.__toss.push(p); return { order: globalThis.__state.orders[p.orderId], eventId: "e" }; }`);
const PAY_STUB = toDataUrl(`export const AUTO_DECIDER = "SYSTEM:auto";`);

let svc = null;
async function loadService() {
  if (svc) return svc;
  const guardUrl = toDataUrl(await transpile("src/lib/billing/parentSendGuard.ts"));
  let code = await transpile(SERVICE);
  code = code
    .split('"@/lib/prisma"').join(`"${PRISMA_STUB}"`)
    .split('"@/lib/payment-ledger"').join(`"${LEDGER_STUB}"`)
    .split('"@/lib/billing/parentSendGuard"').join(`"${guardUrl}"`)
    .split('"./tossplaceClient"').join(`"${TOSS_STUB}"`)
    .split('"./paymentNoticePay"').join(`"${PAY_STUB}"`)
    .split('"./payment-notice.mjs"').join(`"${fileUrl("src/lib/pos/payment-notice.mjs")}"`)
    .split('"./auto-match.mjs"').join(`"${fileUrl(MODULE)}"`)
    .split('"./tossplace-match.mjs"').join(`"${fileUrl("src/lib/pos/tossplace-match.mjs")}"`);
  svc = await import(toDataUrl(code));
  return svc;
}

const LUNA = order({ id: "o-luna", payId: "pay-luna", amount: 180000, items: [["목요일 3교시", "루나루희", 2]] });

async function runMatch(state = {}, input = {}) {
  const service = await loadService();
  globalThis.__state = { students, charges: baseCharges(), ...state };
  globalThis.__calls = [];
  globalThis.__toss = [];
  globalThis.__revalidated = 0;
  let result;
  let error = null;
  try {
    result = await service.autoMatchPosPayment({ order: LUNA, tossPaymentId: "pay-luna", noticeId: "n-luna", ...input });
  } catch (e) {
    error = e;
  }
  return { result, error, calls: globalThis.__calls };
}
const writesOf = (calls) => calls.filter((c) => /^\s*(UPDATE|INSERT)/i.test(c.sql));

test("쓰기: 잠금 → 이미 반영 확인 → 행 잠금 읽기 → 다시 판정 → 청구·청구서·감사기록·알림 (한 트랜잭션)", async () => {
  const { result, calls } = await runMatch();
  assert.equal(result.outcome, "PAID");
  assert.match(result.resultLine, /김루나 목요일 3교시 ₩90,000 · 김루희 목요일 3교시 ₩90,000/);
  const sqls = calls.map((c) => c.sql);
  const idx = (re) => sqls.findIndex((s) => re.test(s));
  assert.ok(idx(/pg_advisory_xact_lock/) < idx(/UNION ALL/));
  assert.ok(idx(/UNION ALL/) < idx(/FOR UPDATE OF p/));
  assert.ok(idx(/FOR UPDATE OF p/) < idx(/^\s*UPDATE "Payment"/));
  assert.equal(calls.find((c) => /pg_advisory_xact_lock/.test(c.sql)).args[0], "toss-pos:pay-luna");

  const pays = calls.filter((c) => /^\s*UPDATE "Payment"/.test(c.sql));
  assert.equal(pays.length, 2);
  for (const p of pays) {
    assert.match(p.sql, /status IN \('PENDING', 'OVERDUE'\)/);
    assert.match(p.sql, /"paidProvider" = 'TOSS_POS'/);
    assert.deepEqual(p.args.slice(2, 4), ["o-luna", "pay-luna"], "토스 주문·결제 ID");
    assert.equal(p.args[4], 90000);
  }
  assert.equal(calls.filter((c) => /^\s*UPDATE "PaymentInvoice"/.test(c.sql)).length, 2);
  const audits = calls.filter((c) => /INSERT INTO "PaymentAuditLog"/.test(c.sql));
  assert.equal(audits.length, 2);
  const keys = audits.map((a) => JSON.parse(a.args[4]).idempotencyKey);
  assert.ok(keys.every((k) => k.startsWith("toss-pos:pay-luna:")));
  assert.equal(new Set(keys).size, 2);
  assert.ok(audits.every((a) => a.args[2] === "pos-auto-match:pay-luna"));
  const close = calls.find((c) => /^\s*UPDATE "PosPaymentNotice"/.test(c.sql));
  assert.equal(close.args[0], "n-luna");
  assert.equal(close.args[2], null, "학생이 둘이면 대표 학생을 비운다");
  assert.equal(close.args[5], "SYSTEM:auto");
  assert.ok(calls.some((c) => c.sql === "COMMIT"));
  assert.equal(globalThis.__revalidated, 1);
});

test("쓰기: 이미 이 토스 결제로 반영된 청구가 있으면(수동 동기화분) 아무것도 쓰지 않는다", async () => {
  const { result, calls } = await runMatch({ synced: true });
  assert.equal(result.outcome, "SKIPPED");
  assert.equal(writesOf(calls).length, 0);
});

test("쓰기: 원장이 원생을 고른 알림·닫힌 알림은 건드리지 않는다", async () => {
  for (const notice of [{ status: "STUDENT_CHOSEN", siteMarkedPaid: false }, { status: "CONFIRMED", siteMarkedPaid: true }, { status: "IGNORED", siteMarkedPaid: false }]) {
    const { result, calls } = await runMatch({ notice });
    assert.equal(result.outcome, "SKIPPED");
    assert.equal(writesOf(calls).length, 0);
  }
});

test("쓰기: 잠근 뒤 다시 판정해 보류면 아무것도 쓰지 않는다", async () => {
  const charges = baseCharges().map((c) => (c.studentId === "s-luhee" && c.month === 11 ? { ...c, status: "PAID" } : c));
  const { result, calls } = await runMatch({ charges });
  assert.equal(result.outcome, "HELD");
  assert.equal(writesOf(calls).length, 0);
  assert.ok(calls.some((c) => c.sql === "ROLLBACK"));
});

test("쓰기: 두 번째 청구가 0행(그 사이 다른 경로가 납부)이면 예외 → 트랜잭션 전부 되돌림(부분 반영 없음)", async () => {
  const target = baseCharges().find((c) => c.studentId === "s-luhee" && c.month === 11);
  const charges = baseCharges().map((c) => (c.studentId === "s-luhee" && c.month === 11 ? { ...c, id: "p-luhee-11" } : c));
  void target;
  const { result, error, calls } = await runMatch({ charges, paymentZero: "p-luhee-11" });
  assert.equal(result, undefined);
  assert.match(String(error?.message), /전부 되돌림/);
  assert.ok(calls.some((c) => c.sql === "ROLLBACK"));
  assert.ok(!calls.some((c) => c.sql === "COMMIT"));
  assert.equal(globalThis.__revalidated, 0);
});

test("쓰기: 승인 카드 결제가 아니면 DB 를 보지도 않는다", async () => {
  const cash = order({ id: "o-c", payId: "pay-c", amount: 110000, sourceType: "CASH", items: [["수요일 3교시", "도경"]] });
  const { result, calls } = await runMatch({}, { order: cash, tossPaymentId: "pay-c" });
  assert.equal(result.outcome, "HELD");
  assert.equal(calls.length, 0);
});

test("크론: 열린 알림을 토스에 다시 조회해 맞추고, 성공만 결과 DM · 1회 상한 10건·200만원", async () => {
  const service = await loadService();
  const doKyung = order({ id: "o-dk", payId: "pay-dk", amount: 110000, items: [["수요일 3교시", "도경"]] });
  const jihu = order({ id: "o-jh", payId: "pay-jh", amount: 100000, items: [["화요일 4교시", "박지후 11월"]] });
  globalThis.__state = {
    students, charges: baseCharges(),
    sweepRows: [
      { id: "n-dk", tossPaymentId: "pay-dk", tossOrderId: "o-dk", amount: 110000 },
      { id: "n-jh", tossPaymentId: "pay-jh", tossOrderId: "o-jh", amount: 100000 },
      { id: "n-big", tossPaymentId: "pay-big", tossOrderId: "o-big", amount: 1_950_000 },
    ],
    orders: { "o-dk": doKyung, "o-jh": jihu },
  };
  globalThis.__calls = []; globalThis.__toss = [];
  const env = { TOSS_PLACE_ACCESS_KEY: "k", TOSS_PLACE_ACCESS_SECRET: "s", TOSS_PLACE_MERCHANT_ID: "324744" };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  const paidDm = [];
  let stats;
  try {
    stats = await service.runPosAutoMatchSweep({ onPaid: async (id, line) => { paidDm.push([id, line]); }, redact: (m) => m });
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
  assert.equal(stats.paid, 1);
  assert.equal(stats.held, 1);
  assert.equal(stats.capped, true, "누적 200만원을 넘는 건은 이번 회차에 시도하지 않는다");
  assert.deepEqual(globalThis.__toss.map((t) => t.orderId), ["o-dk", "o-jh"]);
  assert.equal(paidDm.length, 1);
  assert.equal(paidDm[0][0], "n-dk");
  assert.match(paidDm[0][1], /이도경 수요일 3교시 ₩110,000/);
});

// ───────────────────────── 계약 (소스) ─────────────────────────

test("계약: 크론 SQL 은 7일·열린 알림·이미 반영된 결제 제외, 크론 라우트는 CRON_SECRET + vercel.json 매시간", async () => {
  const service = await loadService();
  assert.match(service.AUTO_MATCH_SWEEP_SQL, /interval '7 days'/);
  assert.match(service.AUTO_MATCH_SWEEP_SQL, /status IN \('PENDING', 'NOTIFIED', 'FAILED'\)/);
  assert.match(service.AUTO_MATCH_SWEEP_SQL, /NOT EXISTS \(SELECT 1 FROM "Payment" p WHERE p."providerPaymentKey" = n."tossPaymentId"\)/);
  assert.match(service.AUTO_MATCH_CHARGES_SQL, /FOR UPDATE OF p/);
  assert.match(service.AUTO_MATCH_CHARGES_SQL, /RALLYZ_APPROVED_EXISTING_INVOICE_MIRROR/);
  const route = await readFile(ROUTE, "utf8");
  assert.match(route, /CRON_SECRET/);
  assert.match(route, /runPosAutoMatchCron/);
  const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
  assert.ok(vercel.crons.some((c) => c.path === "/api/cron/pos-auto-match" && c.schedule === "7 * * * *"));
});

test("계약: 웹훅은 단건 자동이 아닌 결제만 DM 보내기 전에 자동 매칭한다", async () => {
  const src = await readFile(NOTICE_SERVICE, "utf8");
  const at = src.indexOf("autoMatchPosPayment({ order");
  const dm = src.indexOf("if (ids[0]) await sendNotice(ids[0].id);");
  assert.ok(at > 0 && dm > at, "자동 매칭이 버튼 DM 보다 먼저");
  assert.match(src.slice(at - 300, at), /result\.kind !== NOTICE_KIND\.AUTO_CANDIDATE/);
});

test("계약: 자동 매칭은 토스 조회(GET)만 하고 Payment 를 INSERT·DELETE 하지 않는다", async () => {
  const src = await readFile(SERVICE, "utf8");
  assert.ok(!/INSERT INTO "Payment"\s/.test(src));
  assert.ok(!/DELETE FROM/.test(src));
  assert.ok(!/(POST|PUT|PATCH|DELETE)"?\s*,\s*`\/merchants/.test(src));
});
