import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * 토스 POS «현장 결제» 요청 회귀 테스트 (2026-11-07, 원장 결정 D1·D2).
 *
 * 위험은 셋이다.
 *  ① 조건이 안 맞는 결제(금액 다름·이미 납부·만료·부분취소·중복)를 자동 납부 처리하는 것
 *  ② 플러그인(기기 위 코드라 위조 가능)의 말만 듣고 납부 처리하는 것
 *  ③ 매장 토큰 없이·틀린 토큰으로 API 를 쓰는 것
 * 그래서 규칙은 순수 모듈을 **실행**하고, 매칭·인증은 가짜 prisma 를 끼워 **실행**하고,
 * 계약(DB 제약과 코드 상수가 같은 목록 · 플러그인 API 에 납부 경로 없음)은 소스에서 확인한다.
 */

const RULES = "src/lib/pos/charge-request.mjs";
const SERVICE = "src/lib/pos/chargeRequestService.ts";
const AUTH = "src/lib/pos/pluginAuth.ts";
const HTTP = "src/lib/pos/pluginHttp.ts";
const RATE = "src/lib/seasonal/public-rate-limit.ts";
const MIGRATION = "prisma/migrations/20261107150000_add_pos_charge_request/migration.sql";
const ACTIONS = "src/app/actions/pos-charge.ts";
const FINANCE = "src/app/admin/finance/FinanceClient.tsx";
const NOTICE_SERVICE = "src/lib/pos/paymentNoticeService.ts";
const PLUGIN_API_DIR = "src/app/api/pos-plugin";

const fileUrl = (f) => pathToFileURL(path.resolve(f)).href;
const R = await import(fileUrl(RULES));
const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = async (file) =>
  ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;

// ───────────────────────── 1. 번호 ─────────────────────────

test("번호: S-+6자리(오기입이 다른 요청과 우연히 맞을 확률 100만 분의 1), 0 채움, 범위 밖은 오류", () => {
  assert.equal(R.formatShortCode(7), "S-000007");
  assert.equal(R.formatShortCode(482193), "S-482193");
  assert.throws(() => R.formatShortCode(1_000_000));
  assert.throws(() => R.formatShortCode(-1));
  assert.equal(R.randomShortCode((max) => { assert.equal(max, 1_000_000); return 42; }), "S-000042");
  assert.ok(R.isShortCode("S-482193"));
  assert.ok(!R.isShortCode("S-4821"), "4자리는 더 이상 번호가 아니다");
  assert.ok(!R.isShortCode("s-482193"));
  assert.equal(R.buildChargeMemo("S-482193"), "STIZ:S-482193");
  assert.throws(() => R.buildChargeMemo("482193"));
  assert.throws(() => R.buildChargeMemo("S-4821"));
});

test("번호: 무작위 번호는 항상 DB CHECK 형식(^S-[0-9]{6}$)에 맞는다", () => {
  for (const n of [0, 1, 99, 9999, 100000, 999999]) assert.match(R.randomShortCode(() => n), /^S-[0-9]{6}$/);
});

// ───────────────────────── 2. 메모에서 번호 찾기 ─────────────────────────

test("메모 파싱: 손으로 친 흔한 변형을 받아 S-숫자 로 정리한다", () => {
  for (const memo of ["STIZ:S-482193", "stiz: s-482193", "STIZ S482193", "STIZ：S-482193", "이시윤 / STIZ:S-482193 10월"]) {
    assert.deepEqual(R.extractChargeCodesFromText(memo), ["S-482193"], memo);
  }
  for (const memo of ["STIZ:S-4821", "stiz: s-4821", "STIZ S4821", "STIZ：S-4821", "이시윤 / STIZ:S-4821 10월", "STIZ:S 4821"]) {
    assert.deepEqual(R.extractChargeCodesFromText(memo), ["S-4821"], memo);
  }
});

test("메모 파싱: STIZ 머리말 없는 숫자는 번호가 아니고, 숫자는 4~6자리까지만(플러그인 계약 S-\d{4,6})", () => {
  assert.deepEqual(R.extractChargeCodesFromText("S-4821"), []);
  assert.deepEqual(R.extractChargeCodesFromText("010-4821-1234"), []);
  assert.deepEqual(R.extractChargeCodesFromText("STIZ:S-482"), []);
  assert.deepEqual(R.extractChargeCodesFromText("STIZ:S-48210"), ["S-48210"], "5자리도 읽는다(요청이 없으면 매칭 안 됨)");
  assert.deepEqual(R.extractChargeCodesFromText("STIZ:S-4821001"), [], "7자리 이상은 번호가 아니다");
  assert.deepEqual(R.extractChargeCodesFromText(""), []);
  assert.deepEqual(R.extractChargeCodesFromText(null), []);
});

test("메모 파싱: 주문·품목·상품 메모를 다 보고, 같은 번호는 한 번, 다른 번호는 둘 다", () => {
  const order = { memo: "STIZ:S-1111", lineItems: [{ memo: "STIZ:S-1111" }, { item: { memo: "stiz:s-2222" } }] };
  assert.deepEqual(R.extractChargeCodes(order), ["S-1111", "S-2222"]);
  assert.deepEqual(R.extractChargeCodes({}), []);
});

test("메모 파싱: 플러그인이 넣는 자리(lineItems[].memo · lineItems[].item.code)에서도 찾는다", () => {
  assert.deepEqual(R.extractChargeCodes({ memo: null, lineItems: [{ item: { code: "STIZ:S-4821", title: "수강료(11월)" } }] }), ["S-4821"]);
  assert.deepEqual(R.extractChargeCodes({ lineItems: [{ memo: "STIZ:S-4821", item: { code: "STIZ:S-4821" } }] }), ["S-4821"]);
  assert.deepEqual(R.extractChargeCodes({ lineItems: [{ code: "STIZ:S-0420" }] }), ["S-0420"]);
});

// ───────────────────────── 3. 청구서 판정 ─────────────────────────

test("현장 결제 대상: 수강료·셔틀비 미납만", () => {
  assert.ok(R.chargeEligibility({ type: "MONTHLY", status: "PENDING", amount: 180000 }).ok);
  assert.ok(R.chargeEligibility({ type: "SHUTTLE", status: "OVERDUE", amount: 30000 }).ok);
  assert.ok(!R.chargeEligibility({ type: "UNIFORM", status: "PENDING", amount: 50000 }).ok, "유니폼은 과세라 제외");
  assert.ok(!R.chargeEligibility({ type: "OTHER", status: "PENDING", amount: 1000 }).ok);
  assert.ok(!R.chargeEligibility({ type: "MONTHLY", status: "PAID", amount: 180000 }).ok);
  assert.ok(!R.chargeEligibility({ type: "MONTHLY", status: "CANCELLED", amount: 180000 }).ok);
  assert.ok(!R.chargeEligibility({ type: "MONTHLY", status: "PENDING", amount: 0 }).ok);
  assert.ok(!R.chargeEligibility(null).ok);
});

// ───────────────────────── 4. 매칭 판정 ─────────────────────────

const EXPIRES = "2026-11-07T05:30:00Z"; // KST 14:30
const baseReq = { status: "PENDING", amount: 180000, taxFreeAmount: 180000, tossPaymentId: null, expiresAt: EXPIRES };
const baseSite = { status: "PENDING", amount: 180000, type: "MONTHLY" };
const pay = (over = {}) => ({ tossPaymentId: "tp-1", tossOrderId: "o-1", amount: 180000, approvedAtIso: "2026-11-07T14:20:00+09:00", taxExemptAmount: 180000, sourceType: "CARD", ...over });
const decide = (over = {}) =>
  R.decideChargeMatch({ request: baseReq, site: baseSite, approved: [pay()], others: [], nowMs: Date.parse("2026-11-07T05:20:00Z"), ...over });

test("매칭: 번호·금액·청구서 미납·만료 전이면 자동 납부(PAY)", () => {
  const r = decide();
  assert.equal(r.action, "PAY");
  assert.equal(r.payment.tossPaymentId, "tp-1");
  assert.equal(decide({ request: { ...baseReq, status: "SENT" } }).action, "PAY");
});

test("매칭: 금액 불일치는 보류(HOLD) — 선생님이 POS 에서 금액을 고친 경우", () => {
  const r = decide({ approved: [pay({ amount: 170000 })] });
  assert.equal(r.action, "HOLD");
  assert.match(r.reason, /170000원.*180000원/);
});

test("매칭: 토스 결제 면세 금액(taxExemptAmount)이 요청 면세액과 다르거나 못 읽으면 보류(세금 신고 보호)", () => {
  const taxed = decide({ approved: [pay({ taxExemptAmount: 0 })] });
  assert.equal(taxed.action, "HOLD");
  assert.match(taxed.reason, /면세 금액\(0원\).*180000원/);
  assert.equal(decide({ approved: [pay({ taxExemptAmount: 90000 })] }).action, "HOLD");
  assert.equal(decide({ approved: [pay({ taxExemptAmount: null })] }).action, "HOLD");
  assert.match(decide({ approved: [pay({ taxExemptAmount: undefined })] }).reason, /면세 금액을 확인하지 못했습니다/);
  assert.equal(decide({ approved: [pay({ taxExemptAmount: "180000" })] }).action, "PAY", "문자열 숫자도 읽는다");
});

test("taxExemptAmountsOf: 결제 ID → 면세 금액, 칸이 없으면 null", () => {
  const order = { payments: [{ id: 1, taxExemptAmount: 180000 }, { id: "x", taxExemptAmount: "" }, { id: "y" }] };
  assert.deepEqual(R.taxExemptAmountsOf(order), { 1: 180000, x: null, y: null });
});

test("매칭: 청구서가 이미 납부·금액이 바뀜·취소면 보류", () => {
  assert.equal(decide({ site: { ...baseSite, status: "PAID" } }).action, "HOLD");
  assert.match(decide({ site: { ...baseSite, status: "PAID" } }).reason, /이미 납부완료/);
  assert.equal(decide({ site: { ...baseSite, amount: 200000 } }).action, "HOLD");
  assert.equal(decide({ site: { ...baseSite, status: "CANCELLED" } }).action, "HOLD");
  assert.equal(decide({ site: null }).action, "HOLD");
});

test("매칭: 만료 — 승인 시각이 만료 뒤면 보류, 만료 전 승인이면 스윕이 EXPIRED 로 바꿨어도 납부", () => {
  assert.equal(decide({ approved: [pay({ approvedAtIso: "2026-11-07T14:31:00+09:00" })] }).action, "HOLD");
  assert.match(decide({ approved: [pay({ approvedAtIso: "2026-11-07T14:31:00+09:00" })] }).reason, /30분/);
  // 승인은 14:20(만료 전), 웹훅이 늦게 와서 그 사이 스윕이 EXPIRED 로 바꿈 → 돈은 제때 들어왔다
  assert.equal(decide({ request: { ...baseReq, status: "EXPIRED" } }).action, "PAY");
  assert.equal(decide({ request: { ...baseReq, status: "EXPIRED" }, approved: [pay({ approvedAtIso: "2026-11-07T15:00:00+09:00" })] }).action, "HOLD");
  // 승인 시각을 모르면 지금 시각으로 본다
  assert.equal(decide({ approved: [pay({ approvedAtIso: null })], nowMs: Date.parse("2026-11-07T06:00:00Z") }).action, "HOLD");
  assert.equal(decide({ approved: [pay({ approvedAtIso: null })] }).action, "PAY");
});

test("매칭: 취소/부분취소 결제가 섞이면 보류(분할이어도)", () => {
  const splitPays = [pay({ amount: 100000, taxExemptAmount: 100000 }), pay({ tossPaymentId: "tp-2", amount: 80000, taxExemptAmount: 80000 })];
  assert.equal(decide({ approved: splitPays, others: [{ id: "tp-3", state: "CANCELLED" }] }).action, "HOLD");
  const partial = decide({ others: [{ id: "tp-x", state: "CANCELLED" }] });
  assert.equal(partial.action, "HOLD");
  assert.match(partial.reason, /취소/);
});

test("매칭: 이미 PAID — 같은 결제면 ALREADY_DONE(재전송), 다른 결제면 SKIP(중복 결제 → 기존 슬랙 흐름)", () => {
  const paidReq = { ...baseReq, status: "PAID", tossPaymentId: "tp-1" };
  assert.equal(decide({ request: paidReq }).action, "ALREADY_DONE");
  assert.equal(decide({ request: paidReq, approved: [pay({ tossPaymentId: "tp-9" })] }).action, "SKIP");
});

test("매칭: 취소·보류된 요청, 요청 없음, 승인 결제 없음은 손대지 않는다(SKIP)", () => {
  assert.equal(decide({ request: { ...baseReq, status: "CANCELLED" } }).action, "SKIP");
  assert.equal(decide({ request: { ...baseReq, status: "HELD" } }).action, "SKIP");
  assert.equal(decide({ request: null }).action, "SKIP");
  assert.equal(decide({ approved: [] }).action, "SKIP");
});

test("nonApprovedPayments: 승인 아닌 결제만", () => {
  const order = { payments: [{ id: 1, state: "APPROVED" }, { id: 2, state: "cancelled", sourceType: "card" }] };
  assert.deepEqual(R.nonApprovedPayments(order), [{ id: "2", state: "CANCELLED", sourceType: "CARD" }]);
});

// ───────────────────── 4-2. 결제 방식 무관 · 분할 결제 (2026-11-08 원장 지시) ─────────────────────

const SOURCE_TYPES = ["CARD", "CASH", "BARCODE", "ACCOUNT_TRANSFER", "EXTERNAL", "PREPAID_VALUE"];

test("방식 무관: 카드·현금·QR/토스페이·계좌이체·외부·선불 단건 모두 자동 납부(PAY)", () => {
  for (const sourceType of SOURCE_TYPES) {
    const r = decide({ approved: [pay({ sourceType })] });
    assert.equal(r.action, "PAY", sourceType);
    assert.equal(r.payment.tossPaymentId, "tp-1");
  }
});

test("결제 방식 기록: sourceType → Payment.method (단건 카드는 기존 CARD 그대로), 분할은 «CARD+CASH»", () => {
  assert.equal(R.posMethodOf(["CARD"]), "CARD");
  assert.equal(R.posMethodOf(["CASH"]), "CASH");
  assert.equal(R.posMethodOf(["BARCODE"]), "EASY_PAY");
  assert.equal(R.posMethodOf(["ACCOUNT_TRANSFER"]), "BANK_TRANSFER");
  assert.equal(R.posMethodOf(["EXTERNAL"]), "ETC");
  assert.equal(R.posMethodOf(["PREPAID_VALUE"]), "ETC");
  assert.equal(R.posMethodOf(["card", "CASH", "CARD"]), "CARD+CASH", "소문자도 읽고 중복은 한 번");
  assert.equal(R.posMethodOf([]), "ETC");
  assert.equal(R.posMethodLabel("CARD"), "현장 · 카드");
  assert.equal(R.posMethodLabel("CASH"), "현장 · 현금");
  assert.equal(R.posMethodLabel("EASY_PAY"), "현장 · 간편결제(QR·토스페이)");
  assert.equal(R.posMethodLabel("BANK_TRANSFER"), "현장 · 계좌이체");
  assert.equal(R.posMethodLabel("ETC"), "현장 · 기타");
  assert.equal(R.posMethodLabel("CARD+CASH"), "현장 · 카드+현금");
  assert.equal(R.posMethodLabel("RALLYZ"), null, "모르는 값은 null → 화면이 기존 표시를 쓴다");
  assert.equal(R.posMethodLabel(""), null);
});

test("결제 방식 화면 표시: 수납 목록·상세는 TOSS_POS 면 «현장 · …», 원생 상세 이름표(adminDisplayText)도 같은 이름", async () => {
  const fin = await readFile(FINANCE, "utf8");
  assert.match(fin, /\{methodText\(p\.method, p\.paidProvider\) \?\? "-"\}/, "목록 «수단» 칸");
  assert.match(fin, /label: "결제 수단", value: methodText\(d\.method, d\.paidProvider\)/, "상세 패널");
  const code = await transpile("src/components/admin/adminDisplayText.ts");
  const D = await import(toDataUrl(code));
  for (const key of Object.keys(R.POS_METHOD_LABELS)) assert.equal(D.paymentMethodLabel(key), R.POS_METHOD_LABELS[key], key);
  assert.equal(D.paymentMethodLabel("CARD+CASH"), "카드+현금");
  assert.equal(D.paymentMethodLabel("CARD"), "카드", "기존 CARD 기록 표시 그대로");
});

// 분할 결제: 카드 100,000 (14:10) + 현금 80,000 (14:20) = 180,000 · 면세 합계 180,000
const card1 = pay({ tossPaymentId: "tp-card", amount: 100000, taxExemptAmount: 100000, approvedAtIso: "2026-11-07T14:10:00+09:00" });
const cash2 = pay({ tossPaymentId: "tp-cash", sourceType: "CASH", amount: 80000, taxExemptAmount: 80000, approvedAtIso: "2026-11-07T14:20:00+09:00" });

test("분할 결제: 합계 금액·합계 면세가 요청과 같으면 납부 — 대표 결제 = 먼저 승인, 납부일 = 마지막 승인", () => {
  const r = decide({ approved: [cash2, card1] }); // 순서가 뒤섞여 와도
  assert.equal(r.action, "PAY");
  assert.equal(r.payment.tossPaymentId, "tp-card");
  assert.deepEqual(r.payments.map((p) => p.tossPaymentId), ["tp-card", "tp-cash"]);
  assert.equal(r.paidAtIso, "2026-11-07T14:20:00+09:00");
  assert.match(r.reason, /분할 결제 2건/);
  assert.equal(R.describeChargePayments(r.payments), "분할 결제 2건: tp-card(카드 100,000원) + tp-cash(현금 80,000원)");
});

test("분할 결제: 합계가 모자라면 주문 완료 전엔 SKIP(기다림), 완료 뒤엔 HOLD", () => {
  const waiting = decide({ approved: [card1], orderCompleted: false });
  assert.equal(waiting.action, "SKIP");
  assert.equal(waiting.waiting, true);
  assert.match(waiting.reason, /남은 결제를 기다립니다/);
  assert.deepEqual(waiting.payments.map((p) => p.tossPaymentId), ["tp-card"]);
  const done = decide({ approved: [card1], orderCompleted: true });
  assert.equal(done.action, "HOLD");
  assert.match(done.reason, /100000원.*180000원/);
  // 기본값은 «완료로 본다»(모르면 기다리지 않고 보수적으로 보류)
  assert.equal(decide({ approved: [card1] }).action, "HOLD");
  // 합계가 넘치면 완료 전이어도 바로 보류
  assert.equal(decide({ approved: [card1, cash2, pay({ tossPaymentId: "tp-x", amount: 1000, taxExemptAmount: 1000 })], orderCompleted: false }).action, "HOLD");
});

test("분할 결제: 면세 합계가 다르거나 한 건이라도 면세 정보가 없으면 보류", () => {
  const taxed = decide({ approved: [card1, { ...cash2, taxExemptAmount: 0 }] });
  assert.equal(taxed.action, "HOLD");
  assert.match(taxed.reason, /면세 금액 합계\(100000원\).*180000원/);
  const unknown = decide({ approved: [card1, { ...cash2, taxExemptAmount: null }] });
  assert.equal(unknown.action, "HOLD");
  assert.match(unknown.reason, /면세 금액을 확인하지 못했습니다/);
});

test("분할 결제: 마지막 결제가 만료 뒤면 보류, 이미 PAID(대표 결제 같음)면 ALREADY_DONE 로 결제 전부를 처리 끝", () => {
  assert.equal(decide({ approved: [card1, { ...cash2, approvedAtIso: "2026-11-07T14:31:00+09:00" }] }).action, "HOLD");
  const again = decide({ request: { ...baseReq, status: "PAID", tossPaymentId: "tp-card" }, approved: [card1, cash2] });
  assert.equal(again.action, "ALREADY_DONE");
  assert.deepEqual(again.payments.map((p) => p.tossPaymentId), ["tp-card", "tp-cash"]);
});

test("보류 문구에 «카드» 전제가 없다(방식 무관)", () => {
  assert.doesNotMatch(decide({ approved: [] }).reason, /카드/);
  assert.doesNotMatch(decide({ approved: [card1] }).reason, /카드/);
});

test("주문 완료 판단: 웹훅 종류(order.order.completed) · 주문 상태 · 완료 시각", () => {
  assert.equal(R.isOrderCompleted({}, "order.order.completed.v1"), true);
  assert.equal(R.isOrderCompleted({ orderState: "COMPLETED" }, "payment.approved"), true);
  assert.equal(R.isOrderCompleted({ completedAt: "2026-11-07T14:20:00" }), true);
  assert.equal(R.isOrderCompleted({ orderState: "OPENED" }, "payment.payment.approved.v1"), false);
  assert.equal(R.isOrderCompleted(null, ""), false);
});

test("extractChargePayments: 방식 무관 승인 결제 전부(sourceType 포함), 알림 목록(extractNoticePayments)은 카드·간편결제만 그대로", async () => {
  const N = await import(fileUrl("src/lib/pos/payment-notice.mjs"));
  const order = {
    id: "o-9",
    payments: SOURCE_TYPES.map((sourceType, i) => ({ id: `p${i}`, sourceType, state: "APPROVED", amount: 1000, approvedAt: "2026-11-07T14:20:00+09:00" }))
      .concat([{ id: "p-cancel", sourceType: "CASH", state: "CANCELLED", amount: 1000 }]),
  };
  const all = N.extractChargePayments(order);
  assert.deepEqual(all.map((p) => p.sourceType), SOURCE_TYPES);
  assert.ok(all.every((p) => p.tossOrderId === "o-9" && p.approvedAtIso));
  assert.deepEqual(N.extractNoticePayments(order).map((p) => p.sourceType), ["CARD", "BARCODE"]);
});

// ───────────────────────── 5. 표시 ─────────────────────────

test("이름 가리기·상품명", () => {
  assert.equal(R.maskStudentName("홍길동"), "홍*동");
  assert.equal(R.maskStudentName("홍길"), "홍*");
  assert.equal(R.maskStudentName("남궁민수"), "남**수");
  assert.equal(R.maskStudentName("홍"), "*");
  assert.equal(R.maskStudentName(""), "");
  assert.equal(R.buildChargeItemName({ year: 2026, month: 11, type: "MONTHLY", maskedName: "홍*동" }), "2026년 11월 수강료(홍*동)");
  assert.equal(R.buildChargeItemName({ year: 2026, month: 11, type: "SHUTTLE", maskedName: "" }), "2026년 11월 셔틀비");
});

// ───────────────────────── 6. DB 제약 = 코드 상수 ─────────────────────────

const migration = await readFile(MIGRATION, "utf8");
const listIn = (sqlFragment) => [...sqlFragment.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);

test("마이그레이션: 상태 CHECK 목록 = CHARGE_STATUS, 열린 상태 부분 유일 인덱스 = OPEN_CHARGE_STATUSES", () => {
  const check = /status IN \(([^)]*)\)\)/.exec(migration);
  assert.ok(check, "상태 CHECK 가 있다");
  assert.deepEqual(listIn(check[1]).sort(), Object.values(R.CHARGE_STATUS).sort());
  for (const name of ["PosChargeRequest_open_payment_key", "PosChargeRequest_open_shortCode_key"]) {
    const m = new RegExp(`"${name}"[\\s\\S]*?WHERE status IN \\(([^)]*)\\)`).exec(migration);
    assert.ok(m, `${name} 부분 유일 인덱스`);
    assert.deepEqual(listIn(m[1]).sort(), [...R.OPEN_CHARGE_STATUSES].sort());
  }
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "PosChargeRequest_tossPaymentId_key"[\s\S]*?WHERE "tossPaymentId" IS NOT NULL/);
  assert.match(migration, /CHECK \("taxFreeAmount" BETWEEN 0 AND amount\)/);
  assert.match(migration, /"shortCode" TEXT NOT NULL CHECK \("shortCode" ~ '\^S-\[0-9\]\{6\}\$'\)/);
  assert.equal(R.SHORT_CODE_RE.source, String.raw`^S-\d{6}$`, "코드 형식 = DB CHECK(6자리)");
  assert.match(migration, /"tokenHash" TEXT NOT NULL UNIQUE CHECK \("tokenHash" ~ '\^\[0-9a-f\]\{64\}\$'\)/);
});

test("마이그레이션: 두 표 모두 RLS + anon/authenticated 회수, 되돌림 SQL 이 적혀 있다", () => {
  for (const table of ["PosChargeRequest", "PosPluginToken"]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`REVOKE ALL ON "${table}" FROM PUBLIC`));
    assert.match(migration, new RegExp(`REVOKE ALL ON "${table}" FROM %I`));
    assert.match(migration, new RegExp(`--\\s+DROP TABLE IF EXISTS "${table}";`));
  }
});

test("schema.prisma 사본에 두 표가 있다", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  assert.match(schema, /model PosChargeRequest \{/);
  assert.match(schema, /model PosPluginToken \{/);
});

// ───────────────────────── 7. 웹훅 매칭 실행 (가짜 prisma) ─────────────────────────

const PRISMA_STUB = toDataUrl(`
  const S = () => globalThis.__cs;
  export const prisma = {
    $queryRawUnsafe: async (sql, ...args) => {
      S().calls.push({ sql, args });
      if (/r\\."tossOrderId" = \\$1 AND r\\.status = 'PAID'/.test(sql)) return S().paidRows ?? [];
      if (/r\\."shortCode" = \\$1/.test(sql)) return S().request ? [S().request] : [];
      if (/SET status = 'PAID'/.test(sql)) { if (S().claimThrows) throw new Error(S().claimThrows); return S().claimRows ?? []; }
      if (/SET status = 'HELD'/.test(sql)) return S().holdRows ?? [{ id: "r1" }];
      if (/SELECT status, "tossPaymentId" FROM "PosChargeRequest"/.test(sql)) return S().reread ? [S().reread] : [];
      if (/"slackNotifiedAt" = now\\(\\)|"cancelNotifiedAt" = now\\(\\)/.test(sql)) return [{ id: "r1" }];
      if (/SELECT status FROM "Payment"/.test(sql)) return [{ status: S().paymentStatusAfter ?? "PENDING" }];
      if (/FROM "PosPluginToken"/.test(sql)) return S().tokens ?? [];
      if (/SET status = 'SENT'/.test(sql)) return S().claimViewRows ?? [];
      if (/FROM "PosChargeRequest" r\\s+JOIN "Payment"/.test(sql)) return S().viewRows ?? [];
      if (/SELECT status FROM "PosChargeRequest"/.test(sql)) return [{ status: "SENT" }];
      return [];
    },
    $executeRawUnsafe: async (sql, ...args) => { S().calls.push({ sql, args, exec: true }); return 1; },
  };
`);
const LEDGER_STUB = toDataUrl(`
  export async function markPaymentPaid(input) { globalThis.__cs.paid.push(input); if (globalThis.__cs.ledgerThrows) throw new Error("ledger failed"); }
  export async function recordPaymentAudit(input) { globalThis.__cs.audits.push(input); }
`);
const SLACK_STUB = toDataUrl(`
  export async function postMessage(m) { globalThis.__cs.slack.push(m.text); return { channel: "D1", ts: "1" }; }
`);
const TAXFREE_STUB = toDataUrl(`export function taxFreeAmountFor(amount) { return amount; }`);
const VIS_STUB = toDataUrl(`export function notMergedStudent(a) { return a + '."mergedIntoStudentId" IS NULL'; }`);

let service = null;
async function loadService() {
  if (service) return service;
  const code = (await transpile(SERVICE))
    .split('"@/lib/prisma"').join(`"${PRISMA_STUB}"`)
    .split('"@/lib/payment-ledger"').join(`"${LEDGER_STUB}"`)
    .split('"@/lib/payments/taxFree"').join(`"${TAXFREE_STUB}"`)
    .split('"@/lib/slack/client"').join(`"${SLACK_STUB}"`)
    .split('"@/lib/studentVisibility"').join(`"${VIS_STUB}"`)
    .split('"./charge-request.mjs"').join(`"${fileUrl(RULES)}"`);
  service = await import(toDataUrl(code));
  return service;
}

const reqRow = (over = {}) => ({
  id: "r1", shortCode: "S-482193", paymentId: "p-nov", status: "SENT", amount: 180000, taxFreeAmount: 180000,
  tossPaymentId: null, tossOrderId: null, expiresAtTs: "2026-11-07T05:30:00Z",
  paymentType: "MONTHLY", year: 2026, month: 11, paymentStatus: "PENDING", paymentAmount: 180000, studentName: "홍길동",
  ...over,
});
const ORDER = { id: "o-1", memo: "STIZ:S-482193", payments: [{ id: "tp-1", sourceType: "CARD", state: "APPROVED", amount: 180000, taxExemptAmount: 180000 }] };

async function runMatch(state = {}, { order = ORDER, approved = [pay()] } = {}) {
  const svc = await loadService();
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], request: reqRow(), claimRows: [{ id: "r1", paymentId: "p-nov", shortCode: "S-482193" }], ...state };
  const saved = process.env.SLACK_OWNER_USER_ID;
  process.env.SLACK_OWNER_USER_ID = "U-OWNER";
  try {
    return await svc.matchChargeRequestsForOrder({ order, orderId: "o-1", approved, redact: (m) => m });
  } finally {
    if (saved == null) delete process.env.SLACK_OWNER_USER_ID; else process.env.SLACK_OWNER_USER_ID = saved;
  }
}

test("웹훅 매칭: 조건이 맞으면 선점 1행 뒤 markPaymentPaid 1회(카드·TOSS_POS·토스 주문/결제 ID) + 슬랙 «자동 납부 반영»", async () => {
  const r = await runMatch();
  assert.deepEqual(r.handledTossPaymentIds, ["tp-1"]);
  assert.equal(globalThis.__cs.paid.length, 1);
  const p = globalThis.__cs.paid[0];
  assert.equal(p.paymentId, "p-nov");
  assert.equal(p.method, "CARD");
  assert.equal(p.provider, "TOSS_POS");
  assert.equal(p.providerOrderId, "o-1");
  assert.equal(p.paymentKey, "tp-1");
  assert.equal(p.actorType, "WEBHOOK");
  assert.equal(p.paidAt, "2026-11-07T14:20:00+09:00");
  const claim = globalThis.__cs.calls.find((c) => /SET status = 'PAID'/.test(c.sql));
  // 마지막 인자 = 분할 결제 기록(note). 단건이면 null(기존 note 유지)
  assert.deepEqual(claim.args, ["r1", "o-1", "tp-1", "2026-11-07T14:20:00+09:00", 180000, null]);
  assert.ok(globalThis.__cs.slack.some((t) => /자동 납부 반영/.test(t) && !/랠리즈/.test(t)));
});

test("웹훅 매칭: 금액 불일치(주문 완료) → 납부 안 함, 요청 HELD + 슬랙 «보류», 기존 확인 알림으로 넘김", async () => {
  const r = await runMatch({}, { order: { ...ORDER, orderState: "COMPLETED" }, approved: [pay({ amount: 170000 })] });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
  assert.ok(globalThis.__cs.slack.some((t) => /보류/.test(t)));
});

test("웹훅 매칭: 토스 결제가 과세로 잡힘(taxExemptAmount 0) → 납부 안 함, HELD", async () => {
  const order = { ...ORDER, payments: [{ ...ORDER.payments[0], taxExemptAmount: 0 }] };
  const r = await runMatch({}, { order });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
  const held = globalThis.__cs.calls.find((c) => /SET status = 'HELD'/.test(c.sql));
  assert.match(held.args[2], /면세 금액/);
});

test("웹훅 매칭: 동시에 온 두 웹훅 — 진 쪽(선점 0행·보류 0행)은 요청이 같은 결제로 PAID 면 처리 끝(슬랙 확인 DM 중복 없음)", async () => {
  const r = await runMatch({ claimRows: [], holdRows: [], reread: { status: "PAID", tossPaymentId: "tp-1" } });
  assert.deepEqual(r.handledTossPaymentIds, ["tp-1"]);
  assert.equal(globalThis.__cs.paid.length, 0, "진 쪽은 다시 납부하지 않는다");
  assert.ok(!globalThis.__cs.slack.some((t) => /보류/.test(t)));
});

test("웹훅 매칭: 진 쪽인데 요청이 다른 결제로 PAID(중복 결제) → 처리 끝으로 보지 않고 기존 흐름", async () => {
  const r = await runMatch({ claimRows: [], holdRows: [], reread: { status: "PAID", tossPaymentId: "tp-0" } });
  assert.deepEqual(r.handledTossPaymentIds, []);
});

test("웹훅 매칭: 이미 납부된 청구서 → 납부 안 함, HELD", async () => {
  const r = await runMatch({ request: reqRow({ paymentStatus: "PAID" }) });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
});

test("웹훅 매칭: 만료 뒤 결제 → 납부 안 함, HELD", async () => {
  await runMatch({ request: reqRow({ status: "EXPIRED" }) }, { approved: [pay({ approvedAtIso: "2026-11-07T15:00:00+09:00" })] });
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
});

test("웹훅 매칭: 선점이 0행(그 사이 상태가 바뀜) → 납부 안 함, HELD", async () => {
  const r = await runMatch({ claimRows: [] });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
});

test("웹훅 매칭: 같은 토스 결제가 다른 요청에 이미 붙음(유일 제약) → 납부 안 함, 기존 흐름", async () => {
  const r = await runMatch({ claimThrows: 'duplicate key value violates unique constraint "PosChargeRequest_tossPaymentId_key"' });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
});

test("웹훅 매칭: 주문·결제 알림 두 번 — 두 번째는 ALREADY_DONE 로 처리 끝(알림 안 만들고 납부도 다시 안 함)", async () => {
  const r = await runMatch({ request: reqRow({ status: "PAID", tossPaymentId: "tp-1" }) });
  assert.deepEqual(r.handledTossPaymentIds, ["tp-1"]);
  assert.equal(globalThis.__cs.paid.length, 0);
});

test("웹훅 매칭: 다른 결제로 이미 PAID 인 요청에 또 결제(중복 결제) → 손대지 않고 기존 슬랙 흐름", async () => {
  const r = await runMatch({ request: reqRow({ status: "PAID", tossPaymentId: "tp-0" }) });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.ok(!globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
});

test("웹훅 매칭: 메모에 번호가 없거나 둘 이상이면 아무것도 안 한다(D1: 요청 없는 POS 결제는 슬랙 확인)", async () => {
  let r = await runMatch({}, { order: { ...ORDER, memo: "홍길동 11월" } });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
  r = await runMatch({}, { order: { ...ORDER, memo: "STIZ:S-4821 STIZ:S-1234" } });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
});

test("웹훅 매칭: 원장부 기록 실패 + 청구서가 아직 미납 → 요청을 HELD 로 되돌리고 기존 확인 알림으로", async () => {
  const r = await runMatch({ ledgerThrows: true, paymentStatusAfter: "PENDING" });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'[\s\S]*WHERE id = \$1 AND status = 'PAID'/.test(c.sql)));
});

test("웹훅 매칭: 자동 납부한 결제가 POS 에서 취소되면 되돌리지 않고 원장에게 «POS 에서 취소됨» 알림", async () => {
  const r = await runMatch(
    { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1" })], request: null },
    { order: { id: "o-1", memo: "STIZ:S-4821", payments: [{ id: "tp-1", sourceType: "CARD", state: "CANCELLED", amount: 180000 }] }, approved: [] },
  );
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.ok(globalThis.__cs.slack.some((t) => /POS 에서 취소됨/.test(t)));
  assert.ok(!globalThis.__cs.calls.some((c) => /UPDATE\s+"Payment"/.test(c.sql)), "청구서를 되돌리지 않는다");
});

// ───────────────────── 7-1a. 결제 직후 목록 갱신 (2026-11-08 원장 화면) ─────────────────────

test("관리자 창: 요청 PAID 인데 청구서가 아직 미납(원장부 기록 중·2분 이내)이면 «기다리는 중»으로 보여 계속 읽게 한다", async () => {
  const svc = await loadService();
  const view = (over) => ({
    id: "r1", shortCode: "S-482193", paymentId: "p-nov", status: "PAID", amount: 180000, taxFreeAmount: 180000,
    expiresAtUtc: "2026-11-07T05:30:00Z", expiresKstHm: "14:30", createdAtUtc: "2026-11-07T05:00:00Z", paidKst: "2026-11-07 14:20",
    isExpired: true, justPaid: true, note: null, createdVia: "ADMIN", paymentType: "MONTHLY", year: 2026, month: 11,
    paymentStatus: "PENDING", studentName: "홍길동", ...over,
  });
  const read = async (over) => {
    globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [view(over)] };
    return svc.getChargeRequestForPayment("p-nov");
  };
  let r = await read({});
  assert.equal(r.status, "SENT");
  assert.equal(r.isExpired, false, "만료 시각이 지났어도 기다림을 이어 간다(창이 PAID 를 다시 읽어 목록을 갱신)");
  r = await read({ paymentStatus: "PAID" });
  assert.equal(r.status, "PAID", "청구서까지 납부되면 PAID");
  r = await read({ justPaid: false });
  assert.equal(r.status, "PAID", "2분이 지나면 그대로(끝없이 기다리지 않음)");
  const src = await readFile(SERVICE, "utf8");
  assert.match(src, /\(r\.status = 'PAID' AND r\."updatedAt" > now\(\) - interval '2 minutes'\) AS "justPaid"/, "시각 판단은 DB 시계");
});

test("수납 목록 다시 읽기는 브라우저 캐시를 쓰지 않는다(응답 Cache-Control max-age=30 때문에 납부 직후 옛 목록이 보였다)", async () => {
  const fin = await readFile(FINANCE, "utf8");
  assert.match(fin, /fetch\(`\/api\/admin\/finance\?year=\$\{y\}&month=\$\{m\}`, \{ cache: "no-store" \}\)/);
  assert.match(fin, /onPaid=\{\(\) => void loadMonth\(year, month\)\}/);
});

// ───────────────────── 7-1b. 웹훅 매칭: 방식 무관 · 분할 결제 ─────────────────────

const SPLIT_ORDER = {
  id: "o-1",
  memo: "STIZ:S-482193",
  payments: [
    { id: "tp-card", sourceType: "CARD", state: "APPROVED", amount: 100000, taxExemptAmount: 100000 },
    { id: "tp-cash", sourceType: "CASH", state: "APPROVED", amount: 80000, taxExemptAmount: 80000 },
  ],
};
const splitApproved = [card1, cash2];

test("웹훅 매칭: 방식별 단건 — 실제 방식이 Payment.method 에 기록된다(현금 CASH · QR EASY_PAY · 계좌이체 BANK_TRANSFER · 외부 ETC)", async () => {
  const expected = { CARD: "CARD", CASH: "CASH", BARCODE: "EASY_PAY", ACCOUNT_TRANSFER: "BANK_TRANSFER", EXTERNAL: "ETC", PREPAID_VALUE: "ETC" };
  for (const [sourceType, method] of Object.entries(expected)) {
    const order = { ...ORDER, payments: [{ ...ORDER.payments[0], sourceType }] };
    const r = await runMatch({}, { order, approved: [pay({ sourceType })] });
    assert.deepEqual(r.handledTossPaymentIds, ["tp-1"], sourceType);
    assert.equal(globalThis.__cs.paid.length, 1, sourceType);
    assert.equal(globalThis.__cs.paid[0].method, method, sourceType);
    assert.equal(globalThis.__cs.paid[0].provider, "TOSS_POS");
  }
});

test("웹훅 매칭: 분할 결제 합계 일치 → 납부 1회(대표 결제·마지막 승인 시각·«CARD+CASH»), 결제 둘 다 처리 끝, note·감사 기록에 결제 전부", async () => {
  const r = await runMatch({}, { order: SPLIT_ORDER, approved: splitApproved });
  assert.deepEqual(r.handledTossPaymentIds, ["tp-card", "tp-cash"]);
  assert.equal(globalThis.__cs.paid.length, 1);
  const p = globalThis.__cs.paid[0];
  assert.equal(p.method, "CARD+CASH");
  assert.equal(p.paymentKey, "tp-card");
  assert.equal(p.paidAt, "2026-11-07T14:20:00+09:00");
  const claim = globalThis.__cs.calls.find((c) => /SET status = 'PAID'/.test(c.sql));
  assert.equal(claim.args[2], "tp-card", "유일 칸에는 대표 결제 1건");
  assert.match(claim.args[5], /tp-card.*tp-cash/);
  const audit = globalThis.__cs.audits.find((a) => a.action === "POS_CHARGE_PAYMENTS");
  assert.deepEqual(audit.metadata.payments.map((x) => x.tossPaymentId), ["tp-card", "tp-cash"]);
  assert.ok(globalThis.__cs.slack.some((t) => /현장 · 카드\+현금/.test(t) && /분할 2건/.test(t)));
});

test("웹훅 매칭: 분할 결제 첫 결제만 승인(주문 진행 중) → SKIP·납부/보류 없음, 그 결제의 확인 알림도 미룸 → 주문 완료 후에도 모자라면 HELD", async () => {
  const first = { ...SPLIT_ORDER, orderState: "OPENED", payments: [SPLIT_ORDER.payments[0]] };
  let r = await runMatch({}, { order: first, approved: [card1] });
  assert.deepEqual(r.handledTossPaymentIds, ["tp-card"], "기다리는 동안 슬랙 확인 DM 을 만들지 않는다");
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.ok(!globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
  assert.match(r.note, /기다립니다/);
  // 주문 완료 웹훅(order.order.completed) — 그래도 100,000원뿐이면 보류
  const svc = await loadService();
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], request: reqRow(), claimRows: [{ id: "r1", paymentId: "p-nov", shortCode: "S-482193" }] };
  r = await svc.matchChargeRequestsForOrder({ order: first, orderId: "o-1", approved: [card1], eventType: "order.order.completed.v1", redact: (m) => m });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
});

test("웹훅 매칭: 분할 결제에 취소 결제가 섞임 → HELD", async () => {
  const order = { ...SPLIT_ORDER, payments: [...SPLIT_ORDER.payments, { id: "tp-x", sourceType: "CARD", state: "CANCELLED", amount: 5000 }] };
  const r = await runMatch({}, { order, approved: splitApproved });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
});

test("웹훅 매칭: 분할 결제 면세 합계 불일치 → HELD", async () => {
  const order = { ...SPLIT_ORDER, payments: [SPLIT_ORDER.payments[0], { ...SPLIT_ORDER.payments[1], taxExemptAmount: 0 }] };
  const r = await runMatch({}, { order, approved: splitApproved });
  assert.deepEqual(r.handledTossPaymentIds, []);
  const held = globalThis.__cs.calls.find((c) => /SET status = 'HELD'/.test(c.sql));
  assert.match(held.args[2], /면세 금액 합계/);
});

test("이중 매칭 방지: 선점 SQL 이 «같은 토스 주문이 다른 요청에 이미 PAID» 를 막고, 막히면(0행) 납부 안 함", async () => {
  const src = await readFile(SERVICE, "utf8");
  const sql = src.slice(src.indexOf("const CLAIM_PAY_SQL"), src.indexOf("RETURNING r.id, r.\"paymentId\", r.\"shortCode\""));
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "PosChargeRequest" o\s+WHERE o\.id <> r\.id AND o\."tossOrderId" = \$2 AND o\.status = 'PAID'\)/);
  const r = await runMatch({ claimRows: [] }, { order: SPLIT_ORDER, approved: splitApproved });
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.deepEqual(r.handledTossPaymentIds, []);
});

test("웹훅 매칭: 자동 납부한 분할 결제 중 나머지 결제가 POS 에서 취소되면 «POS 에서 취소됨» 알림", async () => {
  const order = { ...SPLIT_ORDER, payments: [SPLIT_ORDER.payments[0], { ...SPLIT_ORDER.payments[1], state: "CANCELLED" }] };
  await runMatch(
    { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-card", tossOrderId: "o-1" })], request: reqRow({ status: "PAID", tossPaymentId: "tp-card" }) },
    { order, approved: [card1] },
  );
  assert.ok(globalThis.__cs.slack.some((t) => /POS 에서 취소됨/.test(t)));
  assert.equal(globalThis.__cs.paid.length, 0);
});

// ───────────────────────── 7-2. 플러그인 보고·응답 모양 ─────────────────────────

test("보고 event: 플러그인 소문자(paid·cancel·start_failed)와 대문자 모두 받고, 모르는 값은 거부", async () => {
  const svc = await loadService();
  assert.equal(svc.normalizePluginReportEvent("paid"), "PAID");
  assert.equal(svc.normalizePluginReportEvent("cancel"), "CANCELLED");
  assert.equal(svc.normalizePluginReportEvent("start_failed"), "START_FAILED");
  assert.equal(svc.normalizePluginReportEvent("start-failed"), "START_FAILED");
  assert.equal(svc.normalizePluginReportEvent("SENT"), "SENT");
  assert.equal(svc.normalizePluginReportEvent("approve"), null);
  assert.equal(svc.normalizePluginReportEvent(undefined), null);
  // DB CHECK 목록 = 코드 목록
  const m = /"pluginReportedEvent" IN \(([^)]*)\)/.exec(migration);
  assert.deepEqual(listIn(m[1]).sort(), [...svc.PLUGIN_REPORT_EVENTS].sort());
});

test("보고: 같은 요청+같은 event 두 번째는 duplicate(아무것도 안 바꿈), PAID 보고로 납부하지 않음", async () => {
  const svc = await loadService();
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [] };
  const r = await svc.reportChargeRequestFromPlugin({ requestId: "0b8f0f5e-1111-4222-8333-944445555666", tokenId: "t1", event: "PAID", message: "x" });
  // 가짜 DB 는 UPDATE 에 0행 → 중복으로 보고 지금 상태만 읽는다
  assert.equal(r.duplicate, true);
  const upd = globalThis.__cs.calls.find((c) => /UPDATE "PosChargeRequest"/.test(c.sql));
  assert.match(upd.sql, /NOT \(\$2::text = ANY\("pluginReportedEvents"\)\)/);
  assert.match(upd.sql, /array_append\("pluginReportedEvents", \$2::text\)/);
  assert.equal(globalThis.__cs.paid.length, 0);
});

test("claim·charge 응답: taxFreeAmount 가 금액과 같고, 이름은 가린 값(studentName·studentLabel), itemTitle·memo 포함", async () => {
  const svc = await loadService();
  const row = {
    id: "0b8f0f5e-1111-4222-8333-944445555666", shortCode: "S-482193", paymentId: "p-nov", status: "SENT", amount: 180000, taxFreeAmount: 180000,
    expiresAtUtc: "2026-11-07T05:30:00Z", expiresKstHm: "14:30", createdAtUtc: "2026-11-07T05:00:00Z", paidKst: null, isExpired: false,
    note: null, createdVia: "ADMIN", paymentType: "MONTHLY", year: 2026, month: 11, paymentStatus: "PENDING", studentName: "홍길동",
  };
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [row], claimViewRows: [{ id: row.id }] };
  const v = await svc.claimChargeRequestForPlugin(row.id, "t1");
  assert.equal(v.taxFreeAmount, v.amount);
  assert.equal(v.studentName, "홍*동");
  assert.equal(v.studentLabel, "홍*동");
  assert.equal(v.itemTitle, "2026년 11월 수강료(홍*동)");
  assert.equal(v.memo, "STIZ:S-482193");
  assert.equal(v.expiresAt, "2026-11-07T05:30:00Z");
  assert.ok(!JSON.stringify(v).includes("홍길동"), "실명이 응답에 없다");
});

// ───────────────────────── 8. 매장 토큰 인증 실행 ─────────────────────────

const NEXT_STUB = toDataUrl(`
  class Headers2 { constructor(init = {}) { this.m = new Map(Object.entries(init)); } set(k, v) { this.m.set(k, v); } get(k) { return this.m.get(k) ?? null; } }
  export class NextResponse {
    constructor(body, init = {}) { this.body = body; this.status = init.status ?? 200; this.headers = new Headers2(init.headers ?? {}); }
    static json(body, init = {}) { return new NextResponse(body, init); }
  }
`);
let auth = null;
async function loadAuth() {
  if (auth) return auth;
  const rate = await transpile(RATE);
  const code = (await transpile(AUTH))
    .split('"@/lib/prisma"').join(`"${PRISMA_STUB}"`)
    .split('"next/server"').join(`"${NEXT_STUB}"`)
    .split('"@/lib/seasonal/public-rate-limit"').join(`"${toDataUrl(rate)}"`);
  auth = await import(toDataUrl(code));
  return auth;
}
const reqWith = (authorization, ip = "1.1.1.1") => ({
  headers: { get: (k) => ({ authorization, "x-real-ip": ip })[k.toLowerCase()] ?? null },
});

test("토큰: 형식·해시·상수시간 비교", async () => {
  const A = await loadAuth();
  const { token, hash, prefix } = A.generatePosToken();
  assert.match(token, /^stizpos_[A-Za-z0-9_-]{43}$/);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(A.hashPosToken(token), hash);
  assert.ok(token.startsWith(prefix) && prefix.length === 12);
  assert.equal(A.readBearerToken(`Bearer ${token}`), token);
  assert.equal(A.readBearerToken(token), null, "Bearer 없으면 거부");
  assert.equal(A.readBearerToken("Bearer abc"), null, "앞머리 없으면 거부");
  assert.equal(A.readBearerToken(null), null);
  assert.ok(A.sameHash(hash, hash));
  assert.ok(!A.sameHash(hash, hash.slice(0, 63) + "0") || hash.endsWith("0"));
  assert.ok(!A.sameHash(hash, "short"));
});

test("토큰 인증: 없음·틀림은 401, 맞으면 통과, 실패를 반복하면 429", async () => {
  const A = await loadAuth();
  const { token, hash } = A.generatePosToken();
  globalThis.__cs = { calls: [], tokens: [{ id: "t1", tokenHash: hash }] };
  let r = await A.authenticatePosPlugin(reqWith(null, "9.9.9.1"));
  assert.equal(r.response.status, 401);
  assert.equal(r.response.body.error, "UNAUTHORIZED");
  r = await A.authenticatePosPlugin(reqWith(`Bearer ${A.generatePosToken().token}`, "9.9.9.1"));
  assert.equal(r.response.status, 401, "다른(끊긴) 토큰");
  r = await A.authenticatePosPlugin(reqWith(`Bearer ${token}`, "9.9.9.1"));
  assert.equal(r.auth.tokenId, "t1");
  // 같은 주소에서 실패 10회 넘기면 429
  let last;
  for (let i = 0; i < 12; i += 1) last = await A.authenticatePosPlugin(reqWith("Bearer stizpos_wrong", "9.9.9.2"));
  assert.equal(last.response.status, 429);
  assert.equal(last.response.body.error, "RATE_LIMITED");
});

test("토큰 인증: 끊긴 토큰은 조회 대상이 아니다(revokedAt IS NULL 만 읽는다)", async () => {
  const src = await readFile(AUTH, "utf8");
  assert.match(src, /FROM "PosPluginToken" WHERE "revokedAt" IS NULL/);
  assert.match(src, /timingSafeEqual/);
  assert.match(src, /LIMIT \$2::int/, "회전 시 최신 2개만 남긴다");
  assert.equal(await (await loadAuth()).MAX_ACTIVE_POS_TOKENS, 2);
});

// ───────────────────────── 9. 소스 계약 ─────────────────────────

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

test("플러그인 API: 4개 경로가 있고 전부 토큰 인증(handlePluginRequest)을 거치며, 납부 처리 경로가 없다", async () => {
  const files = (await walk(PLUGIN_API_DIR)).map((f) => f.split(path.sep).join("/")).sort();
  assert.deepEqual(files, [
    "src/app/api/pos-plugin/charge-requests/[id]/claim/route.ts",
    "src/app/api/pos-plugin/charge-requests/[id]/report/route.ts",
    "src/app/api/pos-plugin/charge-requests/route.ts",
    "src/app/api/pos-plugin/unpaid/[paymentId]/charge/route.ts",
    "src/app/api/pos-plugin/unpaid/route.ts",
  ]);
  for (const f of files.concat([HTTP])) {
    const code = await readFile(f, "utf8");
    assert.doesNotMatch(code, /markPaymentPaid|matchChargeRequestsForOrder|UPDATE\s+"Payment"/, `${f} 에 납부 경로가 있으면 안 된다`);
    if (f.endsWith("route.ts")) {
      const handlers = [...code.matchAll(/export async function (GET|POST)/g)].length;
      const guarded = [...code.matchAll(/handlePluginRequest\(req/g)].length;
      assert.equal(guarded, handlers, `${f}: 모든 GET/POST 가 인증을 거친다`);
    }
  }
  for (const f of ["src/app/api/pos-plugin/charge-requests/[id]/claim/route.ts", "src/app/api/pos-plugin/unpaid/[paymentId]/charge/route.ts"]) {
    assert.doesNotMatch(await readFile(f, "utf8"), /readJsonBody|req\.json/, `${f} 는 본문(금액)을 받지 않는다`);
  }
  assert.match(await readFile("src/app/api/pos-plugin/unpaid/[paymentId]/charge/route.ts", "utf8"), /createAndClaimForPlugin\(paymentId, auth\.tokenId\)/);
});

test("돈 쓰기: chargeRequestService 의 markPaymentPaid 는 한 곳, 선점(CLAIM_PAY_SQL) 1행 확인 뒤에만", async () => {
  const src = await readFile(SERVICE, "utf8");
  assert.doesNotMatch(src, /UPDATE\s+"Payment"|UPDATE\s+"PaymentInvoice"/);
  const calls = [...src.matchAll(/await markPaymentPaid\(/g)];
  assert.equal(calls.length, 1);
  const claimAt = src.indexOf("prisma.$queryRawUnsafe(CLAIM_PAY_SQL");
  const emptyAt = src.indexOf("claimed.length === 0", claimAt);
  const payAt = src.indexOf("await markPaymentPaid(");
  assert.ok(claimAt > 0 && emptyAt > claimAt && payAt > emptyAt);
  // 선점 SQL 이 재확인 조건을 담는다(청구서 미납·금액 같음·만료 전)
  const sql = src.slice(src.indexOf("const CLAIM_PAY_SQL"), src.indexOf("RETURNING r.id, r.\"paymentId\", r.\"shortCode\""));
  assert.match(sql, /p\.status IN \('PENDING', 'OVERDUE'\)/);
  assert.match(sql, /p\.amount = r\.amount/);
  assert.match(sql, /<= r\."expiresAt"/);
  // 플러그인 보고는 상태 표시만(PAID 로 바꾸지 않는다)
  const report = src.slice(src.indexOf("export async function reportChargeRequestFromPlugin"), src.indexOf("export type PluginUnpaidItem"));
  assert.doesNotMatch(report, /'PAID'|markPaymentPaid/);
  // 금액은 DB 값: 만들 때 Payment.amount 를 복사
  assert.match(src, /SELECT \$1, p\.id, p\.amount, \$2::int/);
  // 면세는 토스페이먼츠와 같은 한 함수
  assert.match(src, /taxFreeAmountFor\(payment\.amount\)/);
});

test("웹훅 처리: 매칭 결과로 처리된 결제만 알림에서 빼고, 매칭 실패는 알림 흐름을 막지 않는다", async () => {
  const src = await readFile(NOTICE_SERVICE, "utf8");
  // 매칭에는 방식 무관 승인 결제(extractChargePayments) + 웹훅 종류(주문 완료 판단)를 넘긴다. 알림 목록은 그대로.
  assert.match(src, /matchChargeRequestsForOrder\(\{ order, orderId, approved: chargePayments, eventType: type, redact \}\)/);
  assert.match(src, /const chargePayments = extractChargePayments\(order\)/);
  assert.match(src, /const payments = extractNoticePayments\(order\)/);
  assert.match(src, /payments\.filter\(\(p\) => !chargeHandled\.has\(p\.tossPaymentId\)\)/);
  assert.match(src, /expireStaleChargeRequests\(null\)/, "10분 스윕이 만료를 처리한다");
});

test("관리자 동작: 원장(ADMIN)만 + 오류는 문구로 돌려준다, ⚡ 메뉴는 수강료·셔틀비 미납에만", async () => {
  const actions = await readFile(ACTIONS, "utf8");
  assert.match(actions, /^"use server";/);
  const exported = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
  assert.equal(exported.length, 6);
  for (const name of exported) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    const head = body.slice(0, body.indexOf("\n}\n"));
    assert.match(head, /await requireFinanceOwner\(\)/, `${name} 첫머리에서 권한 확인`);
  }
  assert.match(actions, /admin\.appUserRole !== "ADMIN"/);
  const finance = await readFile(FINANCE, "utf8");
  assert.match(finance, /\["MONTHLY", "SHUTTLE"\]\.includes\(p\.type\) && \["PENDING", "OVERDUE"\]\.includes\(p\.status\)/);
  assert.match(finance, /key: "pos-charge"/);
});

test("새 코드에 서버 시계 날짜 금지 패턴이 없다(날짜는 DB 에서 KST 로)", async () => {
  for (const f of [RULES, SERVICE, AUTH, HTTP, ACTIONS, "src/app/admin/finance/PosChargeRequestModal.tsx", "src/app/admin/pos-plugin/PosPluginTokensClient.tsx"]) {
    const code = await readFile(f, "utf8");
    assert.doesNotMatch(code, /toISOString\(\)\.slice\(0,\s*10\)|getUTCDay|getDay\(\)|getHours\(\)|getDate\(\)/, f);
  }
});
