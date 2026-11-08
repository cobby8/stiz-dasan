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

test("현장 결제 대상: 수강료·셔틀비·기타 미납만(기타는 2026-11-08 추가)", () => {
  assert.ok(R.chargeEligibility({ type: "MONTHLY", status: "PENDING", amount: 180000 }).ok);
  assert.ok(R.chargeEligibility({ type: "SHUTTLE", status: "OVERDUE", amount: 30000 }).ok);
  assert.ok(!R.chargeEligibility({ type: "UNIFORM", status: "PENDING", amount: 50000 }).ok, "유니폼은 과세라 제외");
  assert.ok(R.chargeEligibility({ type: "OTHER", status: "PENDING", amount: 1000 }).ok, "기타도 면세로 허용");
  assert.equal(R.paymentTypeLabel("OTHER"), "기타");
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
      // 묶음 항목 읽기(없으면 [] → 서비스가 대표 청구 1건으로 채운다 = 단건·옛 요청)
      if (/^SELECT i\\."requestId"/.test(sql)) return S().items ?? [];
      if (/INSERT INTO "PosChargeRequest" \\(/.test(sql)) return S().insertRows ?? [];
      if (/INSERT INTO "PosChargeRequestItem"/.test(sql)) { if (S().itemInsertThrows) throw new Error(S().itemInsertThrows); return S().itemInsertRows ?? []; }
      if (/FROM "Payment" WHERE id = ANY/.test(sql)) return S().payments ?? [];
      if (/SET status = 'CANCELLED', "cancelledAt" = now\\(\\), "cancelledBy" = \\$2/.test(sql)) return S().cancelRows ?? [];
      if (/SET "cancelState" = 'DONE'/.test(sql)) return S().markRefundRows ?? [{ id: "r1" }];
      if (/SELECT action, "actorType", "actorId" FROM "PaymentAuditLog"/.test(sql)) return S().lastLedger ? [S().lastLedger] : [];
      if (/FROM "PaymentAuditLog"/.test(sql)) return S().auditIds ? [{ ids: S().auditIds }] : [];
      if (/AS "tooSoon"/.test(sql)) return S().why ? [S().why] : [];
      if (/AS "ledgerMayRun"/.test(sql)) return [S().cur ?? { paymentStatus: null, ledgerMayRun: false }];
      if (/SELECT "cancelState", "tossOrderId" FROM "PosChargeRequest" WHERE id = \\$1/.test(sql)) return S().cancelStateAfter ? [{ cancelState: S().cancelStateAfter, tossOrderId: "o-1" }] : [{ cancelState: null, tossOrderId: "o-1" }];
      if (/SET "updatedAt" = now\\(\\)\\s+WHERE r\\.id = \\$1 AND r\\.status = 'PAID' AND r\\."cancelState" IS NULL/.test(sql)) return S().leaseRows ?? [];
      if (/SET "cancelState" = 'REQUESTED'/.test(sql)) return S().requestCancelRows ?? [{ id: "r1" }];
      if (/SET "cancelState" = 'SENT'/.test(sql)) return S().cancelClaimRows ?? [{ id: "r1" }];
      if (/SET "cancelReportedAt" = now\\(\\)/.test(sql)) return S().cancelReportRows ?? [];
      if (/r\\."tossOrderId" = \\$1 AND r\\.status = 'PAID'/.test(sql)) return S().paidRows ?? [];
      if (/r\\."shortCode" = \\$1/.test(sql)) return S().request ? [S().request] : [];
      if (/SET status = 'PAID'/.test(sql)) { if (S().claimThrows) throw new Error(S().claimThrows); return S().claimRows ?? []; }
      if (/SET status = 'HELD'/.test(sql)) return S().holdRows ?? [{ id: "r1" }];
      if (/SELECT status, "tossPaymentId" FROM "PosChargeRequest"/.test(sql)) return S().reread ? [S().reread] : [];
      if (/"slackNotifiedAt" = now\\(\\)|"cancelNotifiedAt" = now\\(\\)|"refundNotifiedAt" = now\\(\\)/.test(sql)) return [{ id: "r1" }];
      if (/SELECT status FROM "Payment"/.test(sql)) return [{ status: S().paymentStatusAfter ?? "PENDING" }];
      if (/FROM "PosPluginToken"/.test(sql)) return S().tokens ?? [];
      if (/SET status = 'SENT'/.test(sql)) return S().claimViewRows ?? [];
      if (/FROM "PosChargeRequest" r\\s+JOIN "Payment"/.test(sql)) return (typeof S().viewRows === "function" ? S().viewRows(sql, args) : S().viewRows) ?? [];
      if (/SELECT status FROM "PosChargeRequest"/.test(sql)) return [{ status: "SENT" }];
      return [];
    },
    $executeRawUnsafe: async (sql, ...args) => { S().calls.push({ sql, args, exec: true }); return 1; },
    // 트랜잭션은 같은 가짜를 그대로 넘긴다(환불 = 요청 DONE 표시 + 원장부 환불이 한 트랜잭션)
    $transaction: async (fn) => { S().transactions = (S().transactions ?? 0) + 1; return fn(prisma); },
  };
`);
const LEDGER_STUB = toDataUrl(`
  export async function markPaymentPaid(input) { globalThis.__cs.paid.push(input); if (globalThis.__cs.ledgerThrows) throw new Error("ledger failed"); }
  // 묶음 납부(한 트랜잭션) — 부른 기록만 남긴다. bundleThrows 면 «하나라도 못 바꿈 → 전부 되돌림»을 흉내 낸다
  export async function markPaymentsPaidTogether(input) { (globalThis.__cs.bundlePaid ??= []).push(input); if (globalThis.__cs.bundleThrows) throw new Error("묶음 납부 중단: 전부 되돌림"); }
  export async function recordPaymentAudit(input) { globalThis.__cs.audits.push(input); }
  export async function refundPaidPaymentInTx(db, input) { (globalThis.__cs.refunds ??= []).push(input); return globalThis.__cs.refundResult ?? true; }
  export function revalidatePaymentCaches() { globalThis.__cs.revalidated = (globalThis.__cs.revalidated ?? 0) + 1; }
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
  tossPaymentId: null, tossOrderId: null, expiresAtTs: "2026-11-07T05:30:00Z", isExpiredNow: false, cancelState: null, note: null,
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

test("웹훅 매칭: POS 에서 직접 취소(사이트 요청 없음) → 토스 재조회로 전부 취소 확인되면 청구서 환불(원장부 함수·한 트랜잭션) + 슬랙", async () => {
  const r = await runMatch(
    { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID" })], request: null },
    { order: { id: "o-1", memo: "STIZ:S-4821", payments: [{ id: "tp-1", sourceType: "CARD", state: "CANCELLED", amount: 180000 }] }, approved: [] },
  );
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.equal(globalThis.__cs.paid.length, 0, "납부는 다시 쓰지 않는다");
  assert.equal(globalThis.__cs.transactions, 1, "요청 DONE 표시와 환불이 한 트랜잭션");
  assert.equal(globalThis.__cs.refunds.length, 1);
  assert.equal(globalThis.__cs.refunds[0].paymentId, "p-nov");
  assert.deepEqual(globalThis.__cs.refunds[0].metadata.cancelledPaymentIds, ["tp-1"]);
  assert.equal(globalThis.__cs.revalidated, 1, "수납 목록 즉시 갱신");
  assert.ok(globalThis.__cs.slack.some((t) => /POS 결제 취소 확인/.test(t) && /환불로 바꿨습니다/.test(t)));
  assert.match(r.note, /환불 처리/);
  assert.ok(!globalThis.__cs.calls.some((c) => /UPDATE\s+"Payment"/.test(c.sql)), "청구서는 이 파일이 직접 바꾸지 않는다(원장부 함수)");
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
  // 납부 «기록» 시각 기준(취소 알림 note 등으로 updatedAt 이 바뀌어도 영향 없게 — 2026-11-08 검수)
  assert.match(src, /\(r\.status = 'PAID' AND COALESCE\(r\."paidRecordedAt", r\."paidAt"\) > now\(\) - interval '2 minutes'\) AS "justPaid"/, "시각 판단은 DB 시계");
  assert.doesNotMatch(src, /r\."updatedAt" > now\(\) - interval '2 minutes'/);
  // PAID 로 바뀌는 그 문장에서 기록 시각을 남긴다
  const claimSql = src.slice(src.indexOf("const CLAIM_PAY_SQL"), src.indexOf("RETURNING r.id, r.\"paymentId\", r.\"shortCode\""));
  assert.match(claimSql, /"paidRecordedAt" = now\(\)/);
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

test("웹훅 매칭: 자동 납부한 분할 결제 중 일부만 취소 → 환불하지 않고 PARTIAL(보류) + «일부만 취소됨» 알림", async () => {
  const order = { ...SPLIT_ORDER, payments: [SPLIT_ORDER.payments[0], { ...SPLIT_ORDER.payments[1], state: "CANCELLED" }] };
  const r = await runMatch(
    { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-card", tossOrderId: "o-1", paymentStatus: "PAID" })], request: reqRow({ status: "PAID", tossPaymentId: "tp-card" }), auditIds: ["tp-card", "tp-cash"] },
    { order, approved: [card1] },
  );
  assert.ok(globalThis.__cs.slack.some((t) => /일부만 취소됨/.test(t)));
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.equal((globalThis.__cs.refunds ?? []).length, 0, "일부 취소는 환불하지 않는다");
  const partial = globalThis.__cs.calls.find((c) => /SET "cancelState" = 'PARTIAL'/.test(c.sql));
  assert.ok(partial, "요청을 PARTIAL 로 표시");
  assert.match(partial.sql, /"cancelState" IS DISTINCT FROM 'DONE'/, "이미 환불된 요청은 되돌리지 않는다");
  assert.match(r.note, /일부 취소/);
});

test("웹훅 매칭: 분할 결제가 전부 취소 → 환불(결제 ID 는 감사 기록에서)", async () => {
  const order = { ...SPLIT_ORDER, payments: SPLIT_ORDER.payments.map((p) => ({ ...p, state: "CANCELLED" })) };
  await runMatch(
    { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-card", tossOrderId: "o-1", paymentStatus: "PAID" })], request: null, auditIds: ["tp-card", "tp-cash"] },
    { order, approved: [] },
  );
  assert.equal(globalThis.__cs.refunds.length, 1);
  assert.deepEqual(globalThis.__cs.refunds[0].metadata.cancelledPaymentIds, ["tp-card", "tp-cash"]);
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
    "src/app/api/pos-plugin/charge-requests/[id]/cancel/claim/route.ts",
    "src/app/api/pos-plugin/charge-requests/[id]/cancel/report/route.ts",
    "src/app/api/pos-plugin/charge-requests/[id]/claim/route.ts",
    "src/app/api/pos-plugin/charge-requests/[id]/report/route.ts",
    "src/app/api/pos-plugin/charge-requests/route.ts",
    "src/app/api/pos-plugin/unpaid/[paymentId]/charge/route.ts",
    "src/app/api/pos-plugin/unpaid/route.ts",
  ]);
  for (const f of files.concat([HTTP])) {
    const code = await readFile(f, "utf8");
    assert.doesNotMatch(code, /markPaymentPaid|matchChargeRequestsForOrder|refundPaidPaymentInTx|UPDATE\s+"Payment"/, `${f} 에 납부·환불 경로가 있으면 안 된다`);
    if (f.endsWith("route.ts")) {
      const handlers = [...code.matchAll(/export async function (GET|POST)/g)].length;
      const guarded = [...code.matchAll(/handlePluginRequest\(req/g)].length;
      assert.equal(guarded, handlers, `${f}: 모든 GET/POST 가 인증을 거친다`);
    }
  }
  for (const f of ["src/app/api/pos-plugin/charge-requests/[id]/claim/route.ts", "src/app/api/pos-plugin/charge-requests/[id]/cancel/claim/route.ts", "src/app/api/pos-plugin/unpaid/[paymentId]/charge/route.ts"]) {
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
  // 선점 SQL 이 재확인 조건을 담는다(묶인 청구 «전부» 미납·금액 같음·항목 합계 = 요청 금액 · 만료 전)
  const sql = src.slice(src.indexOf("const CLAIM_PAY_SQL"), src.indexOf("RETURNING r.id, r.\"paymentId\", r.\"shortCode\""));
  assert.match(sql, /AND \$\{ALL_ITEMS_UNPAID_SQL\}/);
  assert.match(sql, /<= r\."expiresAt"/);
  const all = src.slice(src.indexOf("const ALL_ITEMS_UNPAID_SQL"), src.indexOf("function hasPaymentSql"));
  assert.match(all, /NOT EXISTS \(SELECT 1 FROM \$\{ITEMS_OF_R\} it LEFT JOIN "Payment" p ON p\.id = it\."paymentId"/);
  assert.match(all, /NOT COALESCE\(p\.status IN \('PENDING', 'OVERDUE'\) AND p\.amount = it\.amount AND p\.type IN \('MONTHLY', 'SHUTTLE', 'OTHER'\), false\)/, "청구가 지워졌으면(NULL) 어긋남으로 센다");
  assert.match(all, /\(SELECT sum\(it\.amount\) FROM \$\{ITEMS_OF_R\} it\) = r\.amount/);
  // 항목이 없는 옛 요청은 대표 청구 1건으로 본다(마이그레이션 적용 전후 틈)
  const itemsOf = src.slice(src.indexOf("const ITEMS_OF_R"), src.indexOf("const ALL_ITEMS_UNPAID_SQL"));
  assert.match(itemsOf, /UNION ALL\s+SELECT r\."paymentId", r\.amount\s+WHERE NOT EXISTS \(SELECT 1 FROM "PosChargeRequestItem" i0 WHERE i0\."requestId" = r\.id\)/);
  // 플러그인 보고는 상태 표시만(PAID 로 바꾸지 않는다)
  const report = src.slice(src.indexOf("export async function reportChargeRequestFromPlugin"), src.indexOf("export type PluginUnpaidItem"));
  assert.doesNotMatch(report, /'PAID'|markPaymentPaid/);
  // 금액은 DB 값: 만들 때 Payment.amount 합계(그 문장에서 미납·금액·같은 학생 재확인)
  const insert = src.slice(src.indexOf("const INSERT_SQL"), src.indexOf("const INSERT_ITEMS_SQL"));
  assert.match(insert, /JOIN "Payment" p ON p\.id = w\.pid AND p\.amount = w\.amt/);
  assert.match(insert, /WHERE p\.status IN \('PENDING', 'OVERDUE'\) AND p\.type IN \('MONTHLY', 'SHUTTLE', 'OTHER'\)/);
  assert.match(insert, /\(SELECT sum\(ok\.amount\) FROM ok\)::int/);
  assert.match(insert, /\(SELECT count\(\*\) FROM ok\) = cardinality\(\$9::text\[\]\)/, "청구가 하나라도 빠지면 0행");
  assert.match(insert, /\(SELECT count\(DISTINCT ok\."studentId"\) FROM ok\) = 1/, "학생이 섞이면 0행");
  // 면세는 토스페이먼츠와 같은 한 함수(청구마다)
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
  assert.equal(exported.length, 8);
  for (const name of exported) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    const head = body.slice(0, body.indexOf("\n}\n"));
    assert.match(head, /await requireFinanceOwner\(\)/, `${name} 첫머리에서 권한 확인`);
  }
  assert.match(actions, /admin\.appUserRole !== "ADMIN"/);
  const finance = await readFile(FINANCE, "utf8");
  assert.match(finance, /\["MONTHLY", "SHUTTLE", "OTHER"\]\.includes\(p\.type\) && \["PENDING", "OVERDUE"\]\.includes\(p\.status\)/);
  assert.match(finance, /key: "pos-charge"/);
});

test("새 코드에 서버 시계 날짜 금지 패턴이 없다(날짜는 DB 에서 KST 로)", async () => {
  for (const f of [RULES, SERVICE, AUTH, HTTP, ACTIONS, "src/app/admin/finance/PosChargeRequestModal.tsx", "src/app/admin/pos-plugin/PosPluginTokensClient.tsx"]) {
    const code = await readFile(f, "utf8");
    assert.doesNotMatch(code, /toISOString\(\)\.slice\(0,\s*10\)|getUTCDay|getDay\(\)|getHours\(\)|getDate\(\)/, f);
  }
});

// ───────────────────────── 9. 결제 취소(사이트 → POS) · 환불 확정 (2026-11-08) ─────────────────────────
//
// 원장 지시 «사이트에서 결제 취소하면 POS 결제도 취소되게». 위험은 넷이다.
//  ① 플러그인 말(위조 가능)만 듣고 환불하는 것 → 환불은 토스 재조회 주문으로만
//  ② 분할 결제 일부만 취소됐는데 환불하는 것 → 전부 취소일 때만
//  ③ 남의 청구서 요청을 취소하게 만드는 것(IDOR) → 청구서 id 로만 찾고, UPDATE 가 같은 청구서를 다시 확인
//  ④ 웹훅이 4초를 넘겨 함수가 멈추면 «요청 PAID + 청구서 미납»이 남는 것 → ALREADY_DONE 때 복구

const CANCEL_MIGRATION = "prisma/migrations/20261108120000_pos_charge_cancel/migration.sql";
const CANCEL_MODAL = "src/app/admin/finance/PosChargeCancelModal.tsx";

test("취소 규칙: decideChargeCancel — 전부 취소=FULL, 일부·부분취소·사라짐=PARTIAL, 전부 승인=NONE", async () => {
  const R = await import(fileUrl(RULES));
  const order = (states) => ({ payments: Object.entries(states).map(([id, state]) => ({ id, state })) });
  assert.equal(R.decideChargeCancel({ paymentIds: ["a"], order: order({ a: "CANCELLED" }) }).action, "FULL");
  assert.equal(R.decideChargeCancel({ paymentIds: ["a", "b"], order: order({ a: "CANCELED", b: "REFUNDED" }) }).action, "FULL");
  assert.equal(R.decideChargeCancel({ paymentIds: ["a", "b"], order: order({ a: "CANCELLED", b: "APPROVED" }) }).action, "PARTIAL");
  assert.equal(R.decideChargeCancel({ paymentIds: ["a"], order: order({ a: "PARTIAL_CANCELLED" }) }).action, "PARTIAL", "부분취소는 전부 취소가 아니다");
  assert.equal(R.decideChargeCancel({ paymentIds: ["a", "b"], order: order({ a: "CANCELLED" }) }).action, "PARTIAL", "주문에서 사라진 결제는 취소로 보지 않는다");
  assert.equal(R.decideChargeCancel({ paymentIds: ["a", "b"], order: order({ a: "APPROVED", b: "APPROVED" }) }).action, "NONE");
  assert.equal(R.decideChargeCancel({ paymentIds: [], order: order({}) }).action, "NONE");
});

test("취소 규칙: chargePaymentIdsOf — 감사 기록 → note(분할 결제 문구) → 대표 결제, 대표 결제는 항상 포함·중복 없음", async () => {
  const R = await import(fileUrl(RULES));
  assert.deepEqual(R.chargePaymentIdsOf({ tossPaymentId: "tp-card", auditPaymentIds: ["tp-card", "tp-cash"] }), ["tp-card", "tp-cash"]);
  const note = R.describeChargePayments([
    { tossPaymentId: "tp-card", sourceType: "CARD", amount: 100000 },
    { tossPaymentId: "tp-cash", sourceType: "CASH", amount: 80000 },
  ]);
  assert.deepEqual(R.chargePaymentIdsOf({ tossPaymentId: "tp-card", note }), ["tp-card", "tp-cash"], "note 문구를 다시 읽는다");
  assert.deepEqual(R.chargePaymentIdsOf({ tossPaymentId: "tp-1", note: "보류 사유 (토스 결제 tp-9)" }), ["tp-1"], "분할 문구가 아니면 대표 결제만");
  assert.deepEqual(R.chargePaymentIdsOf({ tossPaymentId: null, note: null }), []);
});

test("취소 규칙: cancelEligibility — 토스 POS 납부완료·PAID 요청만, 진행 중·환불 끝은 거부, 실패·일부 취소는 다시 가능", async () => {
  const R = await import(fileUrl(RULES));
  const ok = (cancelState = null, site = { status: "PAID", paidProvider: "TOSS_POS" }, status = "PAID") =>
    R.cancelEligibility({ request: { status, cancelState }, site });
  assert.equal(ok().ok, true);
  assert.equal(ok("FAILED").ok, true);
  assert.equal(ok("PARTIAL").ok, true);
  assert.equal(ok("REQUESTED").ok, false);
  assert.equal(ok("SENT").ok, false);
  assert.equal(ok("DONE").ok, false);
  assert.equal(ok(null, { status: "REFUNDED", paidProvider: "TOSS_POS" }).ok, false, "이미 환불된 청구서");
  assert.equal(ok(null, { status: "PAID", paidProvider: "TOSS" }).ok, false, "온라인 결제(토스페이먼츠)는 이 길이 아니다");
  assert.equal(ok(null, undefined, "HELD").ok, false, "자동 납부된 요청만");
  assert.equal(R.cancelEligibility({ request: null, site: null }).ok, false);
});

test("마이그레이션(취소): 칸 추가만 · cancelState CHECK = CANCEL_STATE · 되돌림 SQL · schema.prisma 사본", async () => {
  const R = await import(fileUrl(RULES));
  const sql = await readFile(CANCEL_MIGRATION, "utf8");
  const m = /"cancelState" IN \(([^)]*)\)/.exec(sql);
  assert.ok(m, "cancelState CHECK 가 있다");
  const inDb = m[1].split(",").map((x) => x.trim().replace(/'/g, "")).sort();
  assert.deepEqual(inDb, Object.values(R.CANCEL_STATE).sort());
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE|ALTER COLUMN/, "데이터를 지우거나 바꾸지 않는다");
  assert.match(sql, /--\s+ALTER TABLE "PosChargeRequest" DROP CONSTRAINT IF EXISTS "PosChargeRequest_cancelState_check";/);
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const block = schema.slice(schema.indexOf("model PosChargeRequest {"), schema.indexOf("model PosPluginToken {"));
  for (const col of [...sql.matchAll(/ADD COLUMN IF NOT EXISTS "(\w+)"/g)].map((x) => x[1])) {
    assert.match(block, new RegExp(`\\n\\s+${col}\\s`), `schema.prisma 에 ${col} 이 있다`);
  }
});

test("결제 취소 흐름: 사이트 요청(SENT) 중 토스 웹훅이 전부 취소를 알리면 REFUNDED(환불), 같은 웹훅이 또 와도 두 번 환불하지 않는다", async () => {
  const paidRow = reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID", cancelState: "SENT" });
  const order = { id: "o-1", memo: "STIZ:S-482193", payments: [{ id: "tp-1", sourceType: "CARD", state: "CANCELLED", amount: 180000 }] };
  await runMatch({ paidRows: [paidRow], request: null }, { order, approved: [] });
  assert.equal(globalThis.__cs.refunds.length, 1, "첫 웹훅 = 환불");
  const mark = globalThis.__cs.calls.find((c) => /SET "cancelState" = 'DONE'/.test(c.sql));
  assert.match(mark.sql, /WHERE id = \$1 AND status = 'PAID' AND "cancelState" IS DISTINCT FROM 'DONE'/, "조건부 UPDATE 한 문장");
  // 재전송: 요청이 이미 DONE(선점 0행)·청구는 이미 환불 → 원장부 조건부 UPDATE 가 0행(false) → 목록 갱신·«환불로 바꿨습니다» 없음
  await runMatch(
    { paidRows: [{ ...paidRow, cancelState: "DONE", paymentStatus: "REFUNDED" }], request: null, markRefundRows: [], refundResult: false, cur: { paymentStatus: "REFUNDED", ledgerMayRun: false } },
    { order, approved: [] },
  );
  assert.ok(!globalThis.__cs.revalidated, "두 번째는 청구를 바꾸지 않는다");
  assert.ok(!globalThis.__cs.slack.some((t) => /환불로 바꿨습니다/.test(t)));
});

test("결제 취소 흐름: 청구가 PAID 가 아니면 요청만 DONE, 슬랙 문구는 실제 청구 상태대로(환불 상태 / 그대로 두었습니다)", async () => {
  const order = { id: "o-1", memo: "STIZ:S-482193", payments: [{ id: "tp-1", sourceType: "CARD", state: "CANCELLED", amount: 180000 }] };
  const row = reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "REFUNDED" });
  await runMatch({ paidRows: [row], request: null, refundResult: false, cur: { paymentStatus: "REFUNDED", ledgerMayRun: false } }, { order, approved: [] });
  assert.ok(globalThis.__cs.slack.some((t) => /이미 환불 상태입니다/.test(t)), "관리자가 먼저 환불한 경우");
  assert.ok(!globalThis.__cs.revalidated, "청구서가 안 바뀌었으면 갱신할 것도 없다");
  await runMatch({ paidRows: [row], request: null, refundResult: false, cur: { paymentStatus: "CANCELED", ledgerMayRun: false } }, { order, approved: [] });
  assert.ok(globalThis.__cs.slack.some((t) => /CANCELED이라 그대로 두었습니다/.test(t)));
});

// ── 검수 P-1: «요청 PAID → 청구서 납부 기록» 틈에 취소 웹훅이 먼저 온 경우 ──

test("P-1 틈: 취소 웹훅이 납부 기록보다 먼저 옴(청구 아직 미납·방금 PAID) → 환불할 게 없으니 알림 미루고 retryLater(스윕 재확인)", async () => {
  const order = { id: "o-1", memo: "STIZ:S-482193", payments: [{ id: "tp-1", sourceType: "CARD", state: "CANCELLED", amount: 180000 }] };
  const r = await runMatch(
    { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PENDING" })], request: null, refundResult: false, cur: { paymentStatus: "PENDING", ledgerMayRun: true } },
    { order, approved: [] },
  );
  assert.equal(r.retryLater, true, "웹훅을 처리 완료로 두지 않는다");
  assert.ok(!globalThis.__cs.slack.some((t) => /POS 결제 취소 확인/.test(t)), "실제 상태가 정해지기 전에는 알리지 않는다");
  assert.ok(globalThis.__cs.calls.some((c) => /SET "cancelState" = 'DONE'/.test(c.sql)), "요청은 취소 확정");
});

test("P-1 틈: 그 뒤 원래 처리의 납부 기록이 끝남 → 직후 재확인에서 요청 DONE 이면 바로 환불(«납부 반영» 알림 대신 «환불»)", async () => {
  const r = await runMatch({ cancelStateAfter: "DONE" });
  assert.equal(globalThis.__cs.paid.length, 1, "납부 기록은 이미 썼다");
  assert.equal(globalThis.__cs.refunds.length, 1, "곧바로 환불로 되돌린다");
  assert.equal(globalThis.__cs.refunds[0].paymentId, "p-nov");
  assert.equal(globalThis.__cs.revalidated, 1);
  assert.ok(globalThis.__cs.slack.some((t) => /POS 결제 취소 확인/.test(t) && /환불로 바꿨습니다/.test(t)));
  assert.ok(!globalThis.__cs.slack.some((t) => /자동 납부 반영/.test(t)), "납부 반영 알림은 보내지 않는다");
  assert.match(r.note, /납부 기록 중 POS 취소 확인 → 환불/);
});

test("P-1 틈: 재확인마저 못 했어도(함수가 멈춤) 다음 스윕의 취소 확정이 «요청 DONE + 청구 PAID» 를 환불로 바로잡는다", async () => {
  const order = { id: "o-1", memo: "STIZ:S-482193", payments: [{ id: "tp-1", sourceType: "CARD", state: "CANCELLED", amount: 180000 }] };
  await runMatch(
    {
      paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID", cancelState: "DONE" })], request: null, markRefundRows: [],
      // 청구의 마지막 납부 기록 = 이 현장 결제의 자동 납부
      lastLedger: { action: "PAYMENT_MARK_PAID", actorType: "WEBHOOK", actorId: "pos-charge:S-482193" },
    },
    { order, approved: [] },
  );
  assert.equal(globalThis.__cs.refunds.length, 1, "이미 DONE 이어도 마지막 납부 기록이 이 현장 결제면 환불");
  assert.ok(globalThis.__cs.slack.some((t) => /환불로 바꿨습니다/.test(t)));
});

test("P-1 틈: 납부 기록 전에 취소됐고 기록이 끝내 안 됨(2분 지남) → 청구는 미납 그대로라는 실제 상태로 알림", async () => {
  const order = { id: "o-1", memo: "STIZ:S-482193", payments: [{ id: "tp-1", sourceType: "CARD", state: "CANCELLED", amount: 180000 }] };
  const r = await runMatch(
    { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PENDING" })], request: null, refundResult: false, cur: { paymentStatus: "PENDING", ledgerMayRun: false } },
    { order, approved: [] },
  );
  assert.equal(r.retryLater, false);
  assert.ok(globalThis.__cs.slack.some((t) => /미납 그대로입니다/.test(t)));
});

test("P-1: 납부 직후 재확인은 정상·복구 두 경로 모두, 원장부 환불 함수로만(Payment 직접 UPDATE 없음)", async () => {
  const src = await readFile(SERVICE, "utf8");
  assert.equal([...src.matchAll(/await refundIfCancelledDuringLedger\(/g)].length, 2);
  const fn = src.slice(src.indexOf("async function refundIfCancelledDuringLedger"));
  assert.match(fn.slice(0, fn.indexOf("\n}\n")), /refundPaidPaymentInTx\(db,/);
  assert.doesNotMatch(src, /UPDATE\s+"Payment"/);
});

test("P-2: 토스 POS 납부 건은 기존 «환불» 메뉴를 숨기고 «결제 취소»만", async () => {
  const finance = await readFile(FINANCE, "utf8");
  assert.match(finance, /canManageCriticalFinance && p\.status === "PAID" && p\.paidProvider !== "TOSS_POS" \? \[\s*\{\s*key: "refund"/);
});

test("P-4: POS 취소 보고 뒤 3분 넘게 토스 확인이 없으면 창에 늦어진다는 안내(판단은 DB 시계)", async () => {
  const svc = await loadService();
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [cancelView({ cancelState: "SENT", cancelReported: true, cancelConfirmLate: true })] };
  const v = await svc.getChargeCancelForPayment("p-nov");
  assert.equal(v.confirmLate, true);
  const src = await readFile(SERVICE, "utf8");
  assert.match(src, /\(r\."cancelState" = 'SENT' AND r\."cancelReportedAt" < now\(\) - interval '\$\{CANCEL_CONFIRM_LATE_MIN\} minutes'\) AS "cancelConfirmLate"/);
  assert.match(src, /const CANCEL_CONFIRM_LATE_MIN = 3;/);
  const modal = await readFile(CANCEL_MODAL, "utf8");
  assert.match(modal, /POS 취소는 됐지만 토스 확인이 늦어요\. 잠시 후 수납 화면에서 확인해 주세요\./);
});

test("결제 취소 흐름: 결제가 아직 승인 상태면(취소 전) 아무것도 하지 않는다", async () => {
  const r = await runMatch(
    { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID", cancelState: "SENT" })], request: reqRow({ status: "PAID", tossPaymentId: "tp-1", paymentStatus: "PAID" }) },
  );
  assert.equal((globalThis.__cs.refunds ?? []).length, 0);
  assert.ok(!globalThis.__cs.calls.some((c) => /"cancelState" = 'PARTIAL'/.test(c.sql)));
  assert.match(r.note, /이미 자동 반영됨/);
});

test("원장부 환불 함수: 청구 PAID 일 때만 REFUNDED(조건부)·납부일 비움·청구서 CANCELED·감사 기록, 트랜잭션 db 로만 쓴다", async () => {
  const src = await readFile("src/lib/payment-ledger.ts", "utf8");
  const fn = /export async function refundPaidPaymentInTx[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  assert.match(fn, /UPDATE "Payment" SET status = 'REFUNDED', "paidDate" = NULL[\s\S]*WHERE id = \$1 AND status = 'PAID'/);
  assert.match(fn, /if \(changed\.length === 0\) return false;/, "이미 바뀌었으면 청구서·감사 기록도 건드리지 않는다");
  assert.match(fn, /UPDATE "PaymentInvoice" SET status = 'CANCELED'/);
  assert.match(fn, /'PAYMENT_REFUNDED'/);
  assert.doesNotMatch(fn, /prisma\./, "넘겨받은 db(트랜잭션)만 쓴다");
  // 서비스: 환불은 settleCancelForRow 안, 트랜잭션 안에서만
  const svc = await readFile(SERVICE, "utf8");
  // 두 곳(취소 확정 · 납부 직후 재확인) — 둘 다 트랜잭션 안에서 묶인 청구마다 부른다
  assert.equal([...svc.matchAll(/await refundPaidPaymentInTx\(/g)].length, 2);
  const during = svc.slice(svc.indexOf("async function refundIfCancelledDuringLedger"));
  assert.match(during.slice(0, during.indexOf("\n}\n")), /prisma\.\$transaction\(async \(db\) => \{[\s\S]*await refundPaidPaymentInTx\(db,/);
  const settle = svc.slice(svc.indexOf("async function settleCancelForRow"), svc.indexOf("// ───────────────────────────── 관리자 «결제 취소»"));
  assert.match(settle, /prisma\.\$transaction\(async \(db\) => \{[\s\S]*MARK_REFUND_SQL[\s\S]*refundPaidPaymentInTx\(db,/);
  // 플러그인 보고 경로에는 환불이 없다
  const report = svc.slice(svc.indexOf("export async function reportCancelFromPlugin"));
  assert.doesNotMatch(report, /refundPaidPaymentInTx|'DONE'|REFUNDED/);
});

// ── ALREADY_DONE 복구(웹훅 4초 응답 뒤 함수가 멈춘 경우) ──

test("ALREADY_DONE 복구: 요청 PAID + 청구서 미납 → 임대 1행이면 원장부 납부를 다시 쓴다(같은 결제·방식·주문)", async () => {
  const r = await runMatch({
    request: reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PENDING" }),
    leaseRows: [{ id: "r1", paymentId: "p-nov", shortCode: "S-482193" }],
  });
  assert.deepEqual(r.handledTossPaymentIds, ["tp-1"], "슬랙 확인 DM 은 만들지 않는다");
  assert.equal(globalThis.__cs.paid.length, 1, "원장부 기록 1회");
  assert.equal(globalThis.__cs.paid[0].paymentKey, "tp-1");
  assert.equal(globalThis.__cs.paid[0].provider, "TOSS_POS");
  assert.equal(r.retryLater, false);
  assert.match(r.note, /멈췄던 납부 기록 복구/);
  const lease = globalThis.__cs.calls.find((c) => /r\."cancelState" IS NULL AND r\."tossOrderId" = \$2/.test(c.sql));
  assert.match(lease.sql, /COALESCE\(r\."paidRecordedAt", r\."paidAt"\) < now\(\) - interval '30 seconds'/, "원래 처리가 진행 중일 틈은 건드리지 않는다");
  assert.match(lease.sql, /r\."updatedAt" < now\(\) - interval '30 seconds'/, "동시에 두 곳이 복구하지 않게 임대");
  assert.match(lease.sql, /p\.status IN \('PENDING', 'OVERDUE'\)/);
});

test("ALREADY_DONE 복구: 아직 30초 안이면 복구하지 않고 retryLater(스윕이 다시) · 청구서가 이미 납부면 할 일 없음", async () => {
  let r = await runMatch({ request: reqRow({ status: "PAID", tossPaymentId: "tp-1", paymentStatus: "PENDING" }), leaseRows: [], why: { tooSoon: true, paymentStatus: "PENDING" } });
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.equal(r.retryLater, true);
  r = await runMatch({ request: reqRow({ status: "PAID", tossPaymentId: "tp-1", paymentStatus: "PAID" }) });
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.equal(r.retryLater, false);
  assert.ok(!globalThis.__cs.calls.some((c) => /r\."cancelState" IS NULL AND r\."tossOrderId" = \$2/.test(c.sql)), "청구서가 납부면 임대도 안 한다");
});

test("ALREADY_DONE 복구: 결제 취소가 걸린 요청은 납부를 다시 쓰지 않는다(환불을 덮어쓰지 않게)", async () => {
  await runMatch({ request: reqRow({ status: "PAID", tossPaymentId: "tp-1", paymentStatus: "PENDING", cancelState: "REQUESTED" }), leaseRows: [{ id: "r1", paymentId: "p-nov", shortCode: "S-482193" }] });
  assert.equal(globalThis.__cs.paid.length, 0);
});

test("ALREADY_DONE 복구: markPaymentPaid 는 writeLedgerPaid 한 곳에서만, 부르는 곳은 선점 1행 뒤·임대 1행 뒤 둘뿐", async () => {
  const src = await readFile(SERVICE, "utf8");
  assert.equal([...src.matchAll(/await markPaymentPaid\(/g)].length, 1);
  const calls = [...src.matchAll(/await writeLedgerPaid\(/g)].map((m) => m.index);
  assert.equal(calls.length, 2);
  const claimAt = src.indexOf("prisma.$queryRawUnsafe(CLAIM_PAY_SQL");
  assert.ok(calls[0] > src.indexOf("claimed.length === 0", claimAt), "정상 경로: 선점 0행 확인 뒤");
  const repair = src.slice(src.indexOf("async function repairLedgerPaid"));
  assert.ok(repair.indexOf("leased.length === 0") < repair.indexOf("await writeLedgerPaid("), "복구 경로: 임대 0행 확인 뒤");
});

// ── 분할 결제 대기 중 주문이 버려지는 경우(검수 2026-11-08) ──

test("분할 결제 대기: 유효 시간 안이면 SKIP(waiting) + retryLater(웹훅을 처리 완료로 두지 않음) → 지나면 HOLD+알림", async () => {
  const first = { ...SPLIT_ORDER, orderState: "OPENED", payments: [SPLIT_ORDER.payments[0]] };
  let r = await runMatch({}, { order: first, approved: [card1] });
  assert.equal(r.retryLater, true, "스윕이 다시 본다");
  assert.ok(!globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
  // 30분이 지난 뒤 스윕이 다시 부름(DB 시계로 만료) — 주문은 여전히 진행 중(버려짐)
  r = await runMatch({ request: reqRow({ isExpiredNow: true }) }, { order: first, approved: [card1] });
  assert.equal(r.retryLater, false);
  assert.deepEqual(r.handledTossPaymentIds, [], "보류되면 그 결제의 슬랙 확인 DM 도 나간다");
  const held = globalThis.__cs.calls.find((c) => /SET status = 'HELD'/.test(c.sql));
  assert.match(held.args[2], /유효 시간\(30분\)이 지났습니다/);
  assert.ok(globalThis.__cs.slack.some((t) => /보류/.test(t)));
  // 스윕이 먼저 EXPIRED 로 바꾼 경우도 같다
  r = await runMatch({ request: reqRow({ status: "EXPIRED" }) }, { order: first, approved: [card1] });
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
});

test("분할 결제 대기: 순수 판정 — 만료 전 대기, 만료 뒤 보류, 합계가 맞으면 만료 전 그대로 납부", async () => {
  const R = await import(fileUrl(RULES));
  const request = { status: "SENT", amount: 180000, taxFreeAmount: 180000, tossPaymentId: null, expiresAt: "2026-11-07T05:30:00Z" };
  const site = { status: "PENDING", amount: 180000, type: "MONTHLY" };
  const one = [{ ...card1 }];
  assert.equal(R.decideChargeMatch({ request: { ...request, isExpiredNow: false }, site, approved: one, orderCompleted: false }).action, "SKIP");
  assert.equal(R.decideChargeMatch({ request: { ...request, isExpiredNow: true }, site, approved: one, orderCompleted: false }).action, "HOLD");
  // DB 값이 없으면 nowMs 로 판단(호환)
  assert.equal(R.decideChargeMatch({ request, site, approved: one, orderCompleted: false, nowMs: Date.parse("2026-11-07T05:00:00Z") }).action, "SKIP");
  assert.equal(R.decideChargeMatch({ request, site, approved: one, orderCompleted: false, nowMs: Date.parse("2026-11-07T06:00:00Z") }).action, "HOLD");
});

test("웹훅 처리부: retryLater 면 markEvent(처리 완료) 대신 noteEvent(사유만) — 스윕이 사흘 안에서 다시 부른다", async () => {
  const src = await readFile(NOTICE_SERVICE, "utf8");
  assert.match(src, /chargeRetryLater = matched\.retryLater;/);
  const tail = src.slice(src.indexOf("if (chargeRetryLater) {"), src.indexOf("await markEvent(eventRowId, \"RECEIVED\", note);"));
  assert.match(tail, /await noteEvent\(eventRowId,/);
  assert.match(tail, /return \{ notices: noticePayments\.length, note \};/);
});

// ── 관리자 «결제 취소» · 플러그인 취소 API ──

const cancelView = (over = {}) => ({
  id: "r1", shortCode: "S-482193", paymentId: "p-nov", status: "PAID", amount: 180000, taxFreeAmount: 180000,
  expiresAtUtc: "2026-11-07T05:30:00Z", expiresKstHm: "14:30", createdAtUtc: "2026-11-07T05:00:00Z", paidKst: "2026-11-07 14:20",
  isExpired: true, justPaid: false, note: null, createdVia: "ADMIN", paymentType: "MONTHLY", year: 2026, month: 11,
  paymentStatus: "PAID", paidProvider: "TOSS_POS", studentName: "홍길동", tossOrderId: "o-1", tossPaymentId: "tp-1",
  cancelState: null, cancelReportMessage: null, refundedKst: null, cancelPickupLate: false, cancelReported: false, ...over,
});

test("관리자 «결제 취소»: 청구서 id 로만 요청을 찾고, UPDATE 가 같은 청구서·납부완료·토스 POS 를 다시 확인(IDOR 방지) + 감사 기록", async () => {
  const svc = await loadService();
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [cancelView()] };
  const v = await svc.requestChargeCancelByAdmin({ paymentId: "p-nov", adminUserId: "admin-1" });
  assert.equal(v.requestId, "r1");
  const find = globalThis.__cs.calls.find((c) => /FROM "PosChargeRequest" r\s+JOIN "Payment"/.test(c.sql));
  // 대표 청구이거나 묶음 항목에 있는 청구 — 청구서 id 하나로만 찾는다
  assert.match(find.sql, /WHERE \(r\."paymentId" = \$1 OR EXISTS \(SELECT 1 FROM "PosChargeRequestItem" ih WHERE ih\."requestId" = r\.id AND ih\."paymentId" = \$1\)\) AND r\.status = 'PAID'/);
  assert.deepEqual(find.args, ["p-nov"]);
  const upd = globalThis.__cs.calls.find((c) => /SET "cancelState" = 'REQUESTED'/.test(c.sql));
  assert.match(upd.sql, /WHERE r\.id = \$1 AND r\."paymentId" = \$3 AND r\.status = 'PAID'/);
  assert.match(upd.sql, /p\.status = 'PAID' AND p\."paidProvider" = 'TOSS_POS'/);
  assert.match(upd.sql, /r\."cancelState" IS NULL OR r\."cancelState" IN \('FAILED', 'PARTIAL'\)/);
  assert.deepEqual(upd.args, ["r1", "admin-1", "p-nov"]);
  assert.ok(globalThis.__cs.audits.some((a) => a.action === "POS_CHARGE_CANCEL_REQUESTED" && a.actorId === "admin-1"));
  assert.equal(globalThis.__cs.paid.length, 0);
  assert.equal((globalThis.__cs.refunds ?? []).length, 0, "요청만 남긴다 — 돈은 웹훅 확인 뒤");
});

test("관리자 «결제 취소»: 거부 — 기록 없음·토스 POS 아님·이미 진행 중·환불 끝·그 사이 상태 바뀜", async () => {
  const svc = await loadService();
  const attempt = async (rows, extra = {}) => {
    globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: rows, ...extra };
    try {
      await svc.requestChargeCancelByAdmin({ paymentId: "p-nov", adminUserId: "admin-1" });
      return null;
    } catch (e) {
      return e;
    }
  };
  assert.equal((await attempt([]))?.code, "NOT_FOUND");
  assert.equal((await attempt([cancelView({ paidProvider: "TOSS" })]))?.code, "NOT_ELIGIBLE");
  assert.equal((await attempt([cancelView({ cancelState: "SENT" })]))?.code, "NOT_ELIGIBLE");
  assert.equal((await attempt([cancelView({ cancelState: "DONE" })]))?.code, "NOT_ELIGIBLE");
  assert.equal((await attempt([cancelView({ tossOrderId: null })]))?.code, "NOT_ELIGIBLE");
  assert.equal((await attempt([cancelView()], { requestCancelRows: [] }))?.code, "CHANGED");
  assert.equal(await attempt([cancelView({ cancelState: "FAILED" })]), null, "실패했으면 다시 보낼 수 있다");
});

test("관리자 «결제 취소» 창 상태: 진행 중·POS 무응답(90초)·실패·환불 완료", async () => {
  const svc = await loadService();
  const read = async (over) => {
    globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [cancelView(over)] };
    return svc.getChargeCancelForPayment("p-nov");
  };
  assert.equal((await read({})).canRequest, true);
  const working = await read({ cancelState: "REQUESTED", cancelPickupLate: true });
  assert.equal(working.canRequest, false);
  assert.equal(working.pickupLate, true);
  const failed = await read({ cancelState: "FAILED", cancelReportMessage: "카드 취소 거절" });
  assert.equal(failed.canRequest, true);
  assert.equal(failed.cancelReportMessage, "카드 취소 거절");
  const done = await read({ cancelState: "DONE", paymentStatus: "REFUNDED", refundedKst: "2026-11-08 10:00" });
  assert.equal(done.cancelState, "DONE");
  assert.equal(done.canRequest, false);
  const src = await readFile(SERVICE, "utf8");
  assert.match(src, /\(r\."cancelState" = 'REQUESTED' AND r\."cancelRequestedAt" < now\(\) - interval '\$\{CANCEL_PICKUP_TIMEOUT_SEC\} seconds'\) AS "cancelPickupLate"/, "무응답 판단은 DB 시계");
});

test("플러그인 취소 선점: 취소할 토스 주문·결제 ID 는 서버 DB 값(분할이면 전부), 선점 SQL 은 REQUESTED·같은 토큰·2분 넘은 것만", async () => {
  const svc = await loadService();
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [cancelView({ cancelState: "SENT" })], auditIds: ["tp-1", "tp-2"] };
  const job = await svc.claimCancelForPlugin("0b5c6c1e-1111-4222-8333-944445555666", "tok-1");
  assert.equal(job.tossOrderId, "o-1");
  assert.deepEqual(job.tossPaymentIds, ["tp-1", "tp-2"]);
  assert.equal(job.studentName, "홍*동", "이름은 가린다");
  const claim = globalThis.__cs.calls.find((c) => /SET "cancelState" = 'SENT'/.test(c.sql));
  assert.match(claim.sql, /r\."cancelState" = 'REQUESTED'/);
  assert.match(claim.sql, /r\."cancelClaimedByTokenId" = \$2 OR r\."cancelClaimedAt" < now\(\) - interval '2 minutes'/);
  // 선점 실패 → NOT_CLAIMABLE, 이상한 id → NOT_FOUND
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], cancelClaimRows: [] };
  await assert.rejects(svc.claimCancelForPlugin("0b5c6c1e-1111-4222-8333-944445555666", "tok-2"), (e) => e.code === "NOT_CLAIMABLE");
  await assert.rejects(svc.claimCancelForPlugin("'; DROP", "tok-2"), (e) => e.code === "NOT_FOUND");
});

test("플러그인 취소 보고: 가져간 토큰만 · failed 는 FAILED 표시만 · done 으로는 환불하지 않음 · 결과 값 검사", async () => {
  const svc = await loadService();
  assert.equal(svc.normalizePluginCancelResult("done"), "DONE");
  assert.equal(svc.normalizePluginCancelResult("FAILED"), "FAILED");
  assert.equal(svc.normalizePluginCancelResult("refunded"), null);
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], cancelReportRows: [{ cancelState: "SENT" }] };
  const r = await svc.reportCancelFromPlugin({ requestId: "0b5c6c1e-1111-4222-8333-944445555666", tokenId: "tok-1", result: "DONE", message: "ok" });
  assert.deepEqual(r, { cancelState: "SENT", refunded: false }, "done 보고는 상태를 바꾸지 않는다(웹훅 대기)");
  const sql = globalThis.__cs.calls.find((c) => /SET "cancelReportedAt" = now\(\)/.test(c.sql));
  assert.match(sql.sql, /WHERE id = \$1 AND "cancelClaimedByTokenId" = \$4/);
  assert.match(sql.sql, /WHEN \$2::text = 'FAILED' AND "cancelState" IN \('REQUESTED', 'SENT'\) THEN 'FAILED'/);
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], cancelReportRows: [] };
  await assert.rejects(
    svc.reportCancelFromPlugin({ requestId: "0b5c6c1e-1111-4222-8333-944445555666", tokenId: "tok-x", result: "FAILED" }),
    (e) => e.code === "NOT_CLAIMABLE",
    "다른 토큰은 보고할 수 없다",
  );
});

test("롱폴링 취소 깨우기: 새 취소 요청(90초 안)·known 에 없는 것만 — 오래된 요청으로 1초마다 깨우지 않는다", async () => {
  const src = await readFile(SERVICE, "utf8");
  const fn = /export async function hasUnknownCancelJob[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
  assert.match(fn, /"cancelState" = 'REQUESTED' AND "cancelRequestedAt" > now\(\) - interval '\$\{CANCEL_PICKUP_TIMEOUT_SEC\} seconds'/);
  assert.match(fn, /NOT \(id = ANY\(\$1::text\[\]\)\)/);
  assert.doesNotMatch(fn, /UPDATE|JOIN/);
});

test("관리자 «결제 취소» 창·메뉴: 위험 작업 확인 문구, 3초 자동 확인, 실패 안내, 환불 완료 문구 · 메뉴는 토스 POS 납부완료에만", async () => {
  const code = await readFile(CANCEL_MODAL, "utf8");
  assert.match(code, /POS 결제가 취소되고 청구는 환불로 바뀝니다\. 되돌릴 수 없습니다\./);
  assert.match(code, /tone: "danger"/);
  assert.match(code, /const POS_CANCEL_POLL_MS = 3000;/);
  assert.match(code, /POS 에서 직접 취소해 주세요/);
  assert.match(code, /환불 처리됐습니다/);
  assert.match(code, /visibilitychange/, "탭을 숨기면 자동 확인을 멈춘다");
  assert.doesNotMatch(code, /toISOString\(\)\.slice\(0,\s*10\)|getUTCDay|getDay\(\)|getHours\(\)|getDate\(\)/);
  const finance = await readFile(FINANCE, "utf8");
  assert.match(finance, /canManageCriticalFinance && p\.status === "PAID" && p\.paidProvider === "TOSS_POS"/);
  assert.match(finance, /key: "pos-cancel"/);
  assert.match(finance, /onRefunded=\{\(\) => void loadMonth\(year, month\)\}/);
  const actions = await readFile(ACTIONS, "utf8");
  for (const name of ["loadPosChargeCancel", "requestPosChargeCancel"]) {
    const body = actions.slice(actions.indexOf(`export async function ${name}`));
    assert.match(body.slice(0, body.indexOf("\n}\n")), /await requireFinanceOwner\(\)/, `${name}: 원장만(권한 없는 사용자 거부)`);
  }
});

// ── 재검수 2026-11-08: READ COMMITTED 경합 · 관리자가 다시 납부한 건 보호 ──

const CANCELLED_ORDER = { id: "o-1", memo: "STIZ:S-482193", payments: [{ id: "tp-1", sourceType: "CARD", state: "CANCELLED", amount: 180000 }] };

test("재검수 1: 첫 취소 확정 때 환불 UPDATE 는 미납으로 봤는데 다시 읽으니 PAID(납부 기록이 그 사이 확정) → 알림 없이 retryLater", async () => {
  const r = await runMatch(
    { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PENDING" })], request: null, refundResult: false, cur: { paymentStatus: "PAID", ledgerMayRun: true } },
    { order: CANCELLED_ORDER, approved: [] },
  );
  assert.equal(r.retryLater, true, "PAID 로 고착되지 않게 스윕이 다시 본다");
  assert.ok(!globalThis.__cs.slack.some((t) => /POS 결제 취소 확인/.test(t)), "«그대로 두었습니다» 같은 잘못된 알림을 보내지 않는다");
  // 다음 스윕: 요청은 이미 DONE(선점 0행)이지만 마지막 납부 기록 = 이 현장 결제 → 환불로 수렴
  await runMatch(
    {
      paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID", cancelState: "DONE" })], request: null, markRefundRows: [],
      lastLedger: { action: "PAYMENT_MARK_PAID", actorType: "WEBHOOK", actorId: "pos-charge:S-482193" },
    },
    { order: CANCELLED_ORDER, approved: [] },
  );
  assert.equal(globalThis.__cs.refunds.length, 1);
  assert.ok(globalThis.__cs.slack.some((t) => /환불로 바꿨습니다/.test(t)));
});

test("재검수 2: 요청은 이미 DONE · 청구 PAID 인데 마지막 납부 기록이 관리자(수동 납부) → 환불하지 않고 한 번만 알림", async () => {
  const r = await runMatch(
    {
      paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID", cancelState: "DONE" })], request: null, markRefundRows: [],
      lastLedger: { action: "PAYMENT_MARK_PAID", actorType: "ADMIN", actorId: null },
      cur: { paymentStatus: "PAID", ledgerMayRun: false },
    },
    { order: CANCELLED_ORDER, approved: [] },
  );
  assert.equal((globalThis.__cs.refunds ?? []).length, 0, "관리자가 다시 납부 처리한 건은 되돌리지 않는다");
  assert.equal(r.retryLater, false);
  assert.ok(globalThis.__cs.slack.some((t) => /자동 환불하지 않았습니다/.test(t)));
  const q = globalThis.__cs.calls.find((c) => /SELECT action, "actorType", "actorId" FROM "PaymentAuditLog"/.test(c.sql));
  assert.deepEqual(q.args, ["p-nov"]);
  assert.match(q.sql, /action IN \('PAYMENT_MARK_PAID', 'PAYMENT_STATUS_UPDATE', 'PAYMENT_REFUNDED'\)/);
  assert.match(q.sql, /ORDER BY "createdAt" DESC\s+LIMIT 1/);
});

test("재검수 2: 마지막 기록이 이 현장 결제 자동 납부라도 그 뒤 관리자 상태 변경·다른 번호면 환불 안 함 · 처음 확정(marked)은 출처 확인 없이 환불", async () => {
  const base = { paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID", cancelState: "DONE" })], request: null, markRefundRows: [], cur: { paymentStatus: "PAID", ledgerMayRun: false } };
  await runMatch({ ...base, lastLedger: { action: "PAYMENT_STATUS_UPDATE", actorType: "ADMIN", actorId: null } }, { order: CANCELLED_ORDER, approved: [] });
  assert.equal((globalThis.__cs.refunds ?? []).length, 0);
  await runMatch({ ...base, lastLedger: { action: "PAYMENT_MARK_PAID", actorType: "WEBHOOK", actorId: "pos-charge:S-999999" } }, { order: CANCELLED_ORDER, approved: [] });
  assert.equal((globalThis.__cs.refunds ?? []).length, 0, "다른 현장 결제의 기록이면 아니다");
  // 처음 취소 확정(선점 1행) — 출처 조회 없이 환불
  await runMatch({ paidRows: [reqRow({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID" })], request: null }, { order: CANCELLED_ORDER, approved: [] });
  assert.equal(globalThis.__cs.refunds.length, 1);
  assert.ok(!globalThis.__cs.calls.some((c) => /SELECT action, "actorType", "actorId" FROM "PaymentAuditLog"/.test(c.sql)));
});

test("재검수 2: 출처 표기는 markPaymentPaid 감사 기록 값과 같다(action PAYMENT_MARK_PAID · actorId pos-charge:번호)", async () => {
  const ledger = await readFile("src/lib/payment-ledger.ts", "utf8");
  const mark = ledger.slice(ledger.indexOf("export async function markPaymentPaid"), ledger.indexOf("export async function refundPaidPaymentInTx"));
  assert.match(mark, /action: "PAYMENT_MARK_PAID"/);
  assert.match(mark, /actorId: input\.actorId \?\? null/);
  const src = await readFile(SERVICE, "utf8");
  assert.match(src, /actorId: `pos-charge:\$\{input\.claimed\.shortCode\}`/, "자동 납부는 pos-charge:번호로 남긴다");
  assert.match(src, /last\[0\]\?\.actorId === `pos-charge:\$\{row\.shortCode\}`/);
});

// ───────────────────────── 10. 묶음 — 같은 학생 여러 건을 POS 결제 한 번으로 (2026-11-08 원장 결정) ─────────────────────────
//
// 위험은 넷이다.
//  ① 다른 학생·대상 아닌 청구·이미 납부된 청구가 묶이는 것 → 만들 때 서버가 DB 값으로 막는다
//  ② 묶인 청구 중 일부만 납부되는 것 → 하나라도 어긋나면 전체 보류, 원장부는 한 트랜잭션
//  ③ 같은 청구가 두 열린 요청에 들어가는 것 → 항목 표 부분 유일 인덱스 + 만들 때 겹침 거부
//  ④ 묶음 결제 취소 때 일부만 환불되는 것 → 전부 취소일 때만, 묶인 청구 전부 환불

const BUNDLE_MIGRATION = "prisma/migrations/20261108180000_pos_charge_request_items/migration.sql";
const bundleItem = (over = {}) => ({
  requestId: "r1", paymentId: "p-nov", amount: 140000, taxFreeAmount: 140000, position: 2,
  paymentType: "MONTHLY", year: 2026, month: 11, paymentStatus: "PENDING", paymentAmount: 140000, paidProvider: null, ...over,
});
const BUNDLE_ITEMS = [
  bundleItem({ paymentId: "p-oct", month: 10, position: 1 }),
  bundleItem({ paymentId: "p-nov", month: 11, position: 2 }),
];
const bundleReq = (over = {}) => reqRow({ paymentId: "p-oct", month: 10, amount: 280000, taxFreeAmount: 280000, paymentAmount: 140000, ...over });
const BUNDLE_ORDER = { id: "o-1", memo: "", lineItems: [{ memo: "STIZ:S-482193" }, { memo: "STIZ:S-482193" }], payments: [{ id: "tp-1", sourceType: "CARD", state: "APPROVED", amount: 280000, taxExemptAmount: 280000 }] };
const bundlePay = (over = {}) => pay({ amount: 280000, taxExemptAmount: 280000, ...over });

test("묶음 규칙: 같은 학생·수강료/셔틀비·미납만, 중복·다른 학생·유형·납부·건수·합계 상한은 거부", () => {
  const ok = [
    { id: "a", studentId: "s1", type: "MONTHLY", status: "PENDING", amount: 140000 },
    { id: "b", studentId: "s1", type: "SHUTTLE", status: "OVERDUE", amount: 30000 },
  ];
  assert.deepEqual(R.chargeBundleEligibility(ok), { ok: true, reason: "" });
  assert.match(R.chargeBundleEligibility([...ok, { ...ok[0], id: "c", studentId: "s2" }]).reason, /같은 학생의 청구만/);
  assert.match(R.chargeBundleEligibility([ok[0], { ...ok[1], type: "UNIFORM" }]).reason, /수강료·셔틀비/);
  assert.match(R.chargeBundleEligibility([ok[0], { ...ok[1], status: "PAID" }]).reason, /미납 청구서에만/);
  assert.match(R.chargeBundleEligibility([ok[0], ok[0]]).reason, /두 번/);
  assert.equal(R.chargeBundleEligibility([]).ok, false);
  const many = Array.from({ length: R.MAX_CHARGE_ITEMS + 1 }, (_, i) => ({ ...ok[0], id: `x${i}` }));
  assert.match(R.chargeBundleEligibility(many).reason, new RegExp(`${R.MAX_CHARGE_ITEMS}건까지`));
  assert.match(R.chargeBundleEligibility([{ ...ok[0], amount: 3_000_000 }, { ...ok[1], amount: 2_000_001 }]).reason, /넘습니다/);
  assert.equal(R.MAX_CHARGE_TOTAL, 5_000_000, "플러그인 MAX_AMOUNT 와 같은 값");
});

test("묶음 규칙: 항목 순서(연·월 → 수강료·셔틀비) · 요약 «수강료 10월 외 1건» · POS 대표 상품명", () => {
  const sorted = R.sortChargeItems([
    { id: "b", year: 2026, month: 11, type: "SHUTTLE" },
    { id: "c", year: 2026, month: 11, type: "MONTHLY" },
    { id: "a", year: 2026, month: 10, type: "MONTHLY" },
  ]);
  assert.deepEqual(sorted.map((p) => p.id), ["a", "c", "b"]);
  assert.equal(R.chargeItemsSummary([{ year: 2026, month: 10, type: "MONTHLY" }, { year: 2026, month: 11, type: "MONTHLY" }]), "수강료 10월 외 1건");
  assert.equal(R.chargeItemsSummary([{ year: 2026, month: 11, type: "SHUTTLE" }]), "2026년 11월 셔틀비");
  assert.equal(R.buildChargeBundleName({ items: [{ year: 2026, month: 10, type: "MONTHLY" }, { year: 2026, month: 11, type: "SHUTTLE" }], maskedName: "홍*동" }), "2026년 10월 수강료 외 1건(홍*동)");
  assert.equal(R.buildChargeBundleName({ items: [{ year: 2026, month: 11, type: "MONTHLY" }], maskedName: "홍*동" }), "2026년 11월 수강료(홍*동)", "1건이면 단건 상품명 그대로");
});

test("묶음 규칙: 화면 최대 건수(POS_CHARGE_MAX_ITEMS) = 서버 MAX_CHARGE_ITEMS", async () => {
  const src = await readFile("src/lib/payments/bankTransferRecord.ts", "utf8");
  assert.match(src, new RegExp(`export const POS_CHARGE_MAX_ITEMS = ${R.MAX_CHARGE_ITEMS};`));
});

test("묶음 매칭(순수): 전부 미납·금액 그대로면 PAY, 하나라도 이미 납부·금액 변경·합계 불일치면 HOLD(일부만 납부 금지)", () => {
  const req = { ...baseReq, amount: 280000, taxFreeAmount: 280000 };
  const items = [
    { status: "PENDING", paymentAmount: 140000, amount: 140000, type: "MONTHLY" },
    { status: "OVERDUE", paymentAmount: 140000, amount: 140000, type: "MONTHLY" },
  ];
  const run = (over) => decide({ request: req, approved: [pay({ amount: 280000, taxExemptAmount: 280000 })], items, ...over });
  assert.equal(run({}).action, R.MATCH_ACTION.PAY, "대표 청구(site)가 없어도 묶음 항목으로 판단");
  let v = run({ items: [items[0], { ...items[1], status: "PAID" }] });
  assert.equal(v.action, R.MATCH_ACTION.HOLD);
  assert.match(v.reason, /묶인 청구 2건 중 1건이 이미 납부완료/);
  v = run({ items: [items[0], { ...items[1], status: "CANCELLED" }] });
  assert.match(v.reason, /미납이 아닙니다/);
  v = run({ items: [items[0], { ...items[1], paymentAmount: 150000 }] });
  assert.match(v.reason, /1건의 금액이 바뀌었습니다/);
  v = run({ items: [items[0], { ...items[1], type: "UNIFORM" }] });
  assert.match(v.reason, /현장 결제할 수 없는 종류/);
  v = run({ items: [items[0], { ...items[1], amount: 100000, paymentAmount: 100000 }] });
  assert.match(v.reason, /합계\(240000원\)가 요청 금액\(280000원\)과 다릅니다/);
  // 결제 합계·면세 합계는 묶음 합계와 비교(분할 포함)
  v = run({ approved: [pay({ amount: 140000, taxExemptAmount: 140000 })] });
  assert.equal(v.action, R.MATCH_ACTION.HOLD, "한 건 금액만 결제되면 보류");
  v = run({ approved: [card1, pay({ tossPaymentId: "tp-x", amount: 180000, taxExemptAmount: 180000, sourceType: "CASH" })] });
  assert.equal(v.action, R.MATCH_ACTION.PAY, "분할 결제 합계 = 묶음 합계");
  v = run({ approved: [pay({ amount: 280000, taxExemptAmount: 140000 })] });
  assert.match(v.reason, /면세 금액/);
});

test("묶음 취소 가능 여부(순수): 묶인 청구 전부 토스 POS 납부완료일 때만", () => {
  const request = { status: "PAID", cancelState: null };
  const site = { status: "PAID", paidProvider: "TOSS_POS" };
  assert.equal(R.cancelEligibility({ request, site, sites: [site, site] }).ok, true);
  assert.match(R.cancelEligibility({ request, site, sites: [site, { status: "REFUNDED", paidProvider: "TOSS_POS" }] }).reason, /1건이 납부완료가 아닙니다/);
  assert.match(R.cancelEligibility({ request, site, sites: [site, { status: "PAID", paidProvider: "MANUAL" }] }).reason, /토스 POS 가 아닌/);
});

test("마이그레이션(묶음): 항목 표 · 열린 항목 유일 인덱스 · 트리거 열린 상태 = OPEN_CHARGE_STATUSES · 기존 요청 채우기 · RLS · 되돌림 SQL", async () => {
  const m = await readFile(BUNDLE_MIGRATION, "utf8");
  assert.match(m, /CREATE TABLE IF NOT EXISTS "PosChargeRequestItem"/);
  assert.match(m, /"requestId" TEXT NOT NULL REFERENCES "PosChargeRequest"\(id\) ON DELETE CASCADE/);
  assert.match(m, /"paymentId" TEXT NOT NULL REFERENCES "Payment"\(id\) ON DELETE CASCADE/);
  assert.match(m, /CHECK \("taxFreeAmount" BETWEEN 0 AND amount\)/);
  assert.match(m, /CREATE UNIQUE INDEX IF NOT EXISTS "PosChargeRequestItem_open_payment_key"\s+ON "PosChargeRequestItem" \("paymentId"\) WHERE "open"/);
  // 트리거·채우기의 «열린 상태» 목록 = 코드
  const trig = /IF NEW\.status NOT IN \(([^)]*)\)/.exec(m);
  assert.deepEqual(listIn(trig[1]).sort(), [...R.OPEN_CHARGE_STATUSES].sort());
  const fill = /r\.status IN \(([^)]*)\), r\."createdAt"/.exec(m);
  assert.deepEqual(listIn(fill[1]).sort(), [...R.OPEN_CHARGE_STATUSES].sort());
  assert.match(m, /AFTER UPDATE OF status ON "PosChargeRequest"/);
  assert.match(m, /WHERE NOT EXISTS \(SELECT 1 FROM "PosChargeRequestItem" i WHERE i\."requestId" = r\.id\)/, "채우기는 여러 번 돌려도 같은 결과");
  assert.match(m, /ALTER TABLE "PosChargeRequestItem" ENABLE ROW LEVEL SECURITY/);
  assert.match(m, /REVOKE ALL ON "PosChargeRequestItem" FROM PUBLIC/);
  for (const undo of [/--\s+DROP TRIGGER IF EXISTS "PosChargeRequest_close_items_trg" ON "PosChargeRequest";/, /--\s+DROP FUNCTION IF EXISTS pos_charge_request_close_items\(\);/, /--\s+DROP TABLE IF EXISTS "PosChargeRequestItem";/]) {
    assert.match(m, undo);
  }
  assert.doesNotMatch(m.replace(/^--.*$/gm, ""), /DROP TABLE|DELETE FROM|TRUNCATE|DROP COLUMN/, "추가만(되돌림은 주석)");
  assert.match(await readFile("prisma/schema.prisma", "utf8"), /model PosChargeRequestItem \{/);
});

// ── 만들기(서버 재확인) ──

const BUNDLE_PAYMENTS = [
  { id: "p-nov", studentId: "s1", type: "MONTHLY", status: "PENDING", amount: 140000, year: 2026, month: 11 },
  { id: "p-oct", studentId: "s1", type: "MONTHLY", status: "OVERDUE", amount: 140000, year: 2026, month: 10 },
];
const bundleView = (over = {}) => ({
  id: "r9", shortCode: "S-482193", paymentId: "p-oct", status: "PENDING", amount: 280000, taxFreeAmount: 280000,
  expiresAtUtc: "2026-11-07T05:30:00Z", expiresKstHm: "14:30", createdAtUtc: "2026-11-07T05:00:00Z", paidKst: null,
  isExpired: false, justPaid: false, note: null, createdVia: "ADMIN", paymentType: "MONTHLY", year: 2026, month: 10,
  paymentStatus: "OVERDUE", studentName: "홍길동", ...over,
});
async function runCreate(state, ids, via = "admin") {
  const svc = await loadService();
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], ...state };
  try {
    if (via === "plugin") return await svc.createAndClaimForPlugin(ids[0], "tok-1");
    return await svc.createChargeRequestByAdmin({ paymentIds: ids, adminUserId: "admin-1", adminName: "원장" });
  } catch (e) {
    return e;
  }
}

test("묶음 만들기: 같은 학생 2건 → 요청 1건(합계·면세 합계·항목 순서) + 항목 2건이 한 트랜잭션, 감사 기록은 청구마다", async () => {
  const r = await runCreate({
    payments: BUNDLE_PAYMENTS,
    viewRows: (sql) => (/WHERE r\.id = \$1/.test(sql) ? [bundleView()] : []),
    insertRows: [{ id: "r9" }],
    itemInsertRows: [{ id: "i1" }, { id: "i2" }],
    items: BUNDLE_ITEMS.map((it) => ({ ...it, requestId: "r9" })),
  }, ["p-nov", "p-oct"]);
  assert.equal(r.existing, false);
  assert.equal(r.request.itemCount, 2);
  assert.equal(r.request.itemLabel, "수강료 10월 외 1건");
  assert.equal(r.request.amount, 280000);
  const ins = globalThis.__cs.calls.find((c) => /INSERT INTO "PosChargeRequest" \(/.test(c.sql));
  assert.equal(ins.args[1], 280000, "면세 합계 = 청구마다 taxFreeAmountFor 의 합");
  assert.equal(ins.args[2], "PENDING");
  assert.deepEqual(ins.args[8], ["p-oct", "p-nov"], "항목 순서: 10월 → 11월(1번 = 대표 청구)");
  assert.deepEqual(ins.args[9], [140000, 140000], "금액은 방금 읽은 DB 값");
  const items = globalThis.__cs.calls.find((c) => /INSERT INTO "PosChargeRequestItem"/.test(c.sql));
  assert.deepEqual(items.args, ["r9", ["p-oct", "p-nov"], [140000, 140000], [140000, 140000]]);
  assert.equal(globalThis.__cs.transactions, 1, "요청 + 항목 = 한 트랜잭션");
  const created = globalThis.__cs.audits.filter((a) => a.action === "POS_CHARGE_REQUEST_CREATED");
  assert.deepEqual(created.map((a) => a.paymentId), ["p-oct", "p-nov"]);
  assert.match(created[0].message, /묶음 2건 · 합계 280,000원/);
});

test("묶음 만들기: 다른 학생·대상 아닌 유형·이미 납부·없는 청구는 서버가 거부(INSERT 없음)", async () => {
  const cases = [
    [[BUNDLE_PAYMENTS[0], { ...BUNDLE_PAYMENTS[1], studentId: "s2" }], "NOT_ELIGIBLE", /같은 학생/],
    [[BUNDLE_PAYMENTS[0], { ...BUNDLE_PAYMENTS[1], type: "UNIFORM" }], "NOT_ELIGIBLE", /수강료·셔틀비/],
    [[BUNDLE_PAYMENTS[0], { ...BUNDLE_PAYMENTS[1], status: "PAID" }], "NOT_ELIGIBLE", /미납/],
    [[BUNDLE_PAYMENTS[0]], "NOT_FOUND", /찾지 못했습니다/],
  ];
  for (const [payments, code, reason] of cases) {
    const e = await runCreate({ payments }, ["p-nov", "p-oct"]);
    assert.equal(e?.code, code, String(reason));
    assert.match(e.message, reason);
    assert.ok(!globalThis.__cs.calls.some((c) => /INSERT INTO/.test(c.sql)), "만들지 않는다");
  }
  const tooMany = await runCreate({}, Array.from({ length: 11 }, (_, i) => `p-${i}`));
  assert.equal(tooMany.code, "NOT_ELIGIBLE");
});

test("묶음 만들기: 청구가 이미 다른 열린 요청에 있으면 거부(ALREADY_OPEN) · 정확히 같은 묶음이면 그 요청을 돌려준다", async () => {
  const open = bundleView({ id: "r7", shortCode: "S-111111", status: "SENT" });
  // 열린 요청 r7 이 p-nov 하나만 묶고 있다 → 겹침
  let r = await runCreate({ payments: BUNDLE_PAYMENTS, viewRows: () => [open], items: [bundleItem({ requestId: "r7", position: 1 })] }, ["p-nov", "p-oct"]);
  assert.equal(r.code, "ALREADY_OPEN");
  assert.match(r.message, /S-111111/);
  assert.ok(!globalThis.__cs.calls.some((c) => /INSERT INTO/.test(c.sql)));
  // 같은 묶음 → 그대로 돌려준다(버튼 두 번)
  r = await runCreate({ payments: BUNDLE_PAYMENTS, viewRows: () => [open], items: BUNDLE_ITEMS.map((it) => ({ ...it, requestId: "r7" })) }, ["p-oct", "p-nov"]);
  assert.equal(r.existing, true);
  assert.equal(r.request.id, "r7");
  // POS 탭에서 묶음에 든 청구 하나만 골라도 막는다(같은 청구가 두 요청에 들어가지 않게)
  r = await runCreate({ payments: [BUNDLE_PAYMENTS[0]], viewRows: () => [open], items: BUNDLE_ITEMS.map((it) => ({ ...it, requestId: "r7" })) }, ["p-nov"], "plugin");
  assert.equal(r.code, "ALREADY_OPEN");
});

test("묶음 만들기: 동시에 같은 청구로 만들어 항목 유일 인덱스(PosChargeRequestItem_open_payment_key)에 걸림 → 다시 읽어 같은 묶음이면 그 요청, 겹치기만 하면 거부", async () => {
  const open = bundleView({ id: "r7", shortCode: "S-111111", status: "PENDING" });
  const dup = 'duplicate key value violates unique constraint "PosChargeRequestItem_open_payment_key"';
  let reads = 0;
  let r = await runCreate({
    payments: BUNDLE_PAYMENTS,
    // 첫 확인 땐 없었는데(동시), 유일 위반 뒤 다시 읽으면 상대가 만든 요청이 보인다
    viewRows: (sql) => (/r\."paymentId" = ANY/.test(sql) ? (reads++ > 0 ? [open] : []) : []),
    insertRows: [{ id: "r9" }],
    itemInsertThrows: dup,
    items: BUNDLE_ITEMS.map((it) => ({ ...it, requestId: "r7" })),
  }, ["p-nov", "p-oct"]);
  assert.equal(r.existing, true, "같은 묶음이면 상대 요청을 보여 준다");
  assert.equal(r.request.id, "r7");
  reads = 0;
  r = await runCreate({
    payments: BUNDLE_PAYMENTS,
    viewRows: (sql) => (/r\."paymentId" = ANY/.test(sql) ? (reads++ > 0 ? [open] : []) : []),
    insertRows: [{ id: "r9" }],
    itemInsertThrows: dup,
    items: [bundleItem({ requestId: "r7", position: 1 })],
  }, ["p-nov", "p-oct"]);
  assert.equal(r.code, "ALREADY_OPEN", "일부만 겹치면 거부");
  const m = await readFile(BUNDLE_MIGRATION, "utf8");
  assert.match(m, /"PosChargeRequestItem_open_payment_key"/, "서비스가 알아보는 이름 = 마이그레이션 인덱스 이름");
});

// ── 매칭(돈이 움직이는 곳) ──

test("묶음 매칭: 결제 합계 = 묶음 합계 → 묶인 청구 전부를 한 트랜잭션으로 납부(markPaymentsPaidTogether 1회) + 청구마다 감사 기록", async () => {
  const r = await runMatch({ request: bundleReq(), items: BUNDLE_ITEMS }, { order: BUNDLE_ORDER, approved: [bundlePay()] });
  assert.deepEqual(r.handledTossPaymentIds, ["tp-1"]);
  assert.equal(globalThis.__cs.paid.length, 0, "단건 함수는 쓰지 않는다");
  assert.equal(globalThis.__cs.bundlePaid.length, 1);
  const b = globalThis.__cs.bundlePaid[0];
  assert.deepEqual(b.items, [{ paymentId: "p-oct", amount: 140000 }, { paymentId: "p-nov", amount: 140000 }]);
  assert.equal(b.provider, "TOSS_POS");
  assert.equal(b.method, "CARD");
  assert.equal(b.paymentKey, "tp-1");
  assert.equal(b.providerOrderId, "o-1");
  assert.equal(b.actorId, "pos-charge:S-482193", "취소 확정의 출처 확인과 같은 표기");
  // 선점 SQL 이 묶인 청구 전부를 다시 확인(실행된 문장)
  const claim = globalThis.__cs.calls.find((c) => /SET status = 'PAID'/.test(c.sql));
  assert.match(claim.sql, /FROM "PosChargeRequestItem" i WHERE i\."requestId" = r\.id/);
  assert.match(claim.sql, /p\.status IN \('PENDING', 'OVERDUE'\) AND p\.amount = it\.amount/);
  assert.equal(claim.args[4], 280000);
  const audits = globalThis.__cs.audits.filter((a) => a.action === "POS_CHARGE_PAYMENTS");
  assert.deepEqual(audits.map((a) => a.paymentId), ["p-oct", "p-nov"]);
  assert.ok(globalThis.__cs.slack.some((t) => /수강료 10월 외 1건 · 합계 280,000원/.test(t) && /청구 2건을 모두 납부완료/.test(t)));
});

test("묶음 매칭: 분할 결제(카드+현금) 합계 = 묶음 합계 → 전부 납부, 방식 «CARD+CASH»", async () => {
  const order = { ...BUNDLE_ORDER, payments: [
    { id: "tp-card", sourceType: "CARD", state: "APPROVED", amount: 200000, taxExemptAmount: 200000 },
    { id: "tp-cash", sourceType: "CASH", state: "APPROVED", amount: 80000, taxExemptAmount: 80000 },
  ] };
  const approved = [
    pay({ tossPaymentId: "tp-card", amount: 200000, taxExemptAmount: 200000, approvedAtIso: "2026-11-07T14:10:00+09:00" }),
    pay({ tossPaymentId: "tp-cash", sourceType: "CASH", amount: 80000, taxExemptAmount: 80000, approvedAtIso: "2026-11-07T14:20:00+09:00" }),
  ];
  const r = await runMatch({ request: bundleReq(), items: BUNDLE_ITEMS }, { order, approved });
  assert.deepEqual(r.handledTossPaymentIds, ["tp-card", "tp-cash"]);
  assert.equal(globalThis.__cs.bundlePaid.length, 1);
  assert.equal(globalThis.__cs.bundlePaid[0].method, "CARD+CASH");
  assert.equal(globalThis.__cs.bundlePaid[0].paymentKey, "tp-card");
});

test("묶음 매칭: 묶인 청구 하나가 이미 납부·금액 변경 → 아무것도 납부하지 않고 요청 HELD + 슬랙 보류", async () => {
  for (const [items, reason] of [
    [[BUNDLE_ITEMS[0], { ...BUNDLE_ITEMS[1], paymentStatus: "PAID" }], /1건이 이미 납부완료/],
    [[BUNDLE_ITEMS[0], { ...BUNDLE_ITEMS[1], paymentAmount: 150000 }], /금액이 바뀌었습니다/],
  ]) {
    const r = await runMatch({ request: bundleReq(), items }, { order: BUNDLE_ORDER, approved: [bundlePay()] });
    assert.deepEqual(r.handledTossPaymentIds, []);
    assert.equal((globalThis.__cs.bundlePaid ?? []).length, 0, "일부만 납부하지 않는다");
    assert.equal(globalThis.__cs.paid.length, 0);
    const held = globalThis.__cs.calls.find((c) => /SET status = 'HELD'/.test(c.sql));
    assert.match(held.args[2], reason);
    assert.ok(globalThis.__cs.slack.some((t) => /보류/.test(t) && /외 1건/.test(t)));
  }
});

test("묶음 매칭: 결제 금액이 한 건 몫뿐(주문 완료) → HOLD", async () => {
  const order = { ...BUNDLE_ORDER, orderState: "COMPLETED", payments: [{ ...BUNDLE_ORDER.payments[0], amount: 140000, taxExemptAmount: 140000 }] };
  await runMatch({ request: bundleReq(), items: BUNDLE_ITEMS }, { order, approved: [pay({ amount: 140000, taxExemptAmount: 140000 })] });
  assert.equal((globalThis.__cs.bundlePaid ?? []).length, 0);
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'/.test(c.sql)));
});

test("묶음 매칭: 원장부 묶음 기록이 중간에 실패(트랜잭션 전부 되돌림) → 요청을 HELD 로 되돌리고 원장 알림", async () => {
  const r = await runMatch({ request: bundleReq(), items: BUNDLE_ITEMS, bundleThrows: true, paymentStatusAfter: "OVERDUE" }, { order: BUNDLE_ORDER, approved: [bundlePay()] });
  assert.deepEqual(r.handledTossPaymentIds, []);
  assert.ok(globalThis.__cs.calls.some((c) => /SET status = 'HELD'[\s\S]*WHERE id = \$1 AND status = 'PAID'/.test(c.sql)));
  assert.ok(globalThis.__cs.slack.some((t) => /자동 반영 실패/.test(t)));
});

test("묶음 매칭: 원장부 함수는 묶인 청구마다 «미납·금액 그대로·대상 유형» 조건부 UPDATE, 하나라도 0행이면 오류(전부 되돌림), 한 트랜잭션", async () => {
  const ledger = await readFile("src/lib/payment-ledger.ts", "utf8");
  const fn = ledger.slice(ledger.indexOf("export async function markPaymentsPaidTogether"), ledger.indexOf("/** 트랜잭션 안에서 쓰는 raw SQL"));
  assert.match(fn, /await prisma\.\$transaction\(async \(db\) => \{/);
  assert.match(fn, /WHERE id = \$1 AND status IN \('PENDING', 'OVERDUE'\) AND amount = \$8::int AND type IN \('MONTHLY', 'SHUTTLE', 'OTHER'\)/);
  assert.match(fn, /if \(changed\.length === 0\) \{\s*throw new Error/);
  assert.match(fn, /'PAYMENT_MARK_PAID'/, "취소 확정의 출처 확인(lastLedgerWriteIsThisCharge)이 읽는 값과 같다");
  assert.match(fn, /revalidatePaymentCaches\(\);/);
  // 서비스에서 묶음 원장부 함수를 부르는 곳도 writeLedgerPaid 한 곳뿐
  const src = await readFile(SERVICE, "utf8");
  assert.equal([...src.matchAll(/await markPaymentsPaidTogether\(/g)].length, 1);
  const writer = src.slice(src.indexOf("async function writeLedgerPaid"), src.indexOf("async function recordChargePaymentsAudit"));
  assert.match(writer, /await markPaymentsPaidTogether\(/);
});

test("묶음 매칭: 이미 PAID(재전송) + 묶인 청구 전부 미납(기록이 멈춤) → 임대 1행이면 묶음 기록 복구 / 섞여 있으면 사람에게", async () => {
  const paidReq = bundleReq({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "OVERDUE" });
  let r = await runMatch({ request: paidReq, items: BUNDLE_ITEMS, leaseRows: [{ id: "r1", paymentId: "p-oct", shortCode: "S-482193" }] }, { order: BUNDLE_ORDER, approved: [bundlePay()] });
  assert.equal(globalThis.__cs.bundlePaid.length, 1);
  assert.match(r.note, /멈췄던 납부 기록 복구/);
  const lease = globalThis.__cs.calls.find((c) => /r\."cancelState" IS NULL AND r\."tossOrderId" = \$2/.test(c.sql));
  assert.match(lease.sql, /FROM "PosChargeRequestItem" i WHERE i\."requestId" = r\.id/, "임대도 묶인 청구 전부를 본다");
  // 하나는 납부(관리자가 따로 처리)·하나는 미납 → 임대 0행 → 원장 알림(자동으로 일부만 쓰지 않는다)
  r = await runMatch({
    request: bundleReq({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID" }),
    items: [{ ...BUNDLE_ITEMS[0], paymentStatus: "PAID" }, BUNDLE_ITEMS[1]],
    leaseRows: [], why: { tooSoon: false, paymentStatus: "OVERDUE" },
  }, { order: BUNDLE_ORDER, approved: [bundlePay()] });
  assert.equal((globalThis.__cs.bundlePaid ?? []).length, 0);
  assert.ok(globalThis.__cs.slack.some((t) => /납부 기록 확인 필요/.test(t) && /묶인 청구 전부 미납/.test(t)));
});

// ── 결제 취소 ──

test("묶음 취소: 토스 재조회로 전부 취소 확인 → 묶인 청구 전부 환불(한 트랜잭션) + «2건을 모두 환불» 알림", async () => {
  const paid = BUNDLE_ITEMS.map((it) => ({ ...it, paymentStatus: "PAID", paidProvider: "TOSS_POS" }));
  const r = await runMatch(
    { paidRows: [bundleReq({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID" })], request: null, items: paid },
    { order: { ...BUNDLE_ORDER, payments: [{ ...BUNDLE_ORDER.payments[0], state: "CANCELLED" }] }, approved: [] },
  );
  assert.equal(globalThis.__cs.transactions, 1, "요청 DONE 표시 + 청구 2건 환불이 한 트랜잭션");
  assert.deepEqual(globalThis.__cs.refunds.map((x) => x.paymentId), ["p-oct", "p-nov"]);
  assert.ok(globalThis.__cs.refunds.every((x) => x.actorId === "pos-charge:S-482193"));
  assert.ok(globalThis.__cs.slack.some((t) => /묶인 청구 2건을 모두 환불로 바꿨습니다/.test(t)));
  assert.match(r.note, /환불 처리\(2\/2건\)/);
});

test("묶음 취소: 분할 결제 중 일부만 취소 → 아무것도 환불하지 않고 PARTIAL(보류)", async () => {
  const order = { ...BUNDLE_ORDER, payments: [
    { id: "tp-card", sourceType: "CARD", state: "CANCELLED", amount: 200000 },
    { id: "tp-cash", sourceType: "CASH", state: "APPROVED", amount: 80000 },
  ] };
  await runMatch(
    { paidRows: [bundleReq({ status: "PAID", tossPaymentId: "tp-card", tossOrderId: "o-1", paymentStatus: "PAID" })], request: null, items: BUNDLE_ITEMS, auditIds: ["tp-card", "tp-cash"] },
    { order, approved: [] },
  );
  assert.equal((globalThis.__cs.refunds ?? []).length, 0);
  assert.ok(globalThis.__cs.calls.some((c) => /SET "cancelState" = 'PARTIAL'/.test(c.sql)));
  assert.ok(globalThis.__cs.slack.some((t) => /일부만 취소됨/.test(t)));
});

test("묶음 취소: 이미 DONE 재전송 — 그 사이 관리자가 다시 납부한 청구는 환불하지 않는다(청구마다 출처 확인)", async () => {
  const paid = BUNDLE_ITEMS.map((it) => ({ ...it, paymentStatus: "PAID", paidProvider: "TOSS_POS" }));
  await runMatch(
    { paidRows: [bundleReq({ status: "PAID", tossPaymentId: "tp-1", tossOrderId: "o-1", paymentStatus: "PAID", cancelState: "DONE" })], request: null, items: paid, markRefundRows: [], lastLedger: { action: "PAYMENT_MARK_PAID", actorType: "ADMIN", actorId: null }, cur: { paymentStatus: "PAID", ledgerMayRun: false } },
    { order: { ...BUNDLE_ORDER, payments: [{ ...BUNDLE_ORDER.payments[0], state: "CANCELLED" }] }, approved: [] },
  );
  assert.equal((globalThis.__cs.refunds ?? []).length, 0);
  const checks = globalThis.__cs.calls.filter((c) => /SELECT action, "actorType", "actorId" FROM "PaymentAuditLog"/.test(c.sql));
  assert.deepEqual(checks.map((c) => c.args[0]), ["p-oct", "p-nov"], "묶인 청구마다 확인");
});

test("묶음 취소 창: 어느 청구에서 열어도 묶음 전체(«수강료 10월 외 1건» · 합계) · 전부 토스 POS 납부일 때만 보낼 수 있다 · 감사 기록은 청구마다", async () => {
  const svc = await loadService();
  const paid = BUNDLE_ITEMS.map((it) => ({ ...it, paymentStatus: "PAID", paidProvider: "TOSS_POS" }));
  const view = cancelView({ paymentId: "p-oct", month: 10, amount: 280000, taxFreeAmount: 280000 });
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [view], items: paid };
  let v = await svc.getChargeCancelForPayment("p-nov");
  assert.equal(v.itemCount, 2);
  assert.equal(v.itemLabel, "수강료 10월 외 1건");
  assert.equal(v.amount, 280000);
  assert.equal(v.canRequest, true);
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [view], items: [paid[0], { ...paid[1], paidProvider: "MANUAL" }] };
  v = await svc.getChargeCancelForPayment("p-nov");
  assert.equal(v.canRequest, false);
  assert.match(v.blockReason, /토스 POS 가 아닌/);
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [view], items: paid };
  await svc.requestChargeCancelByAdmin({ paymentId: "p-nov", adminUserId: "admin-1" });
  const upd = globalThis.__cs.calls.find((c) => /SET "cancelState" = 'REQUESTED'/.test(c.sql));
  assert.match(upd.sql, /FROM "PosChargeRequestItem" i WHERE i\."requestId" = r\.id/, "UPDATE 가 묶인 청구 전부를 다시 확인");
  assert.deepEqual(upd.args, ["r1", "admin-1", "p-oct"], "대표 청구로 요청과 맞물림");
  assert.deepEqual(globalThis.__cs.audits.filter((a) => a.action === "POS_CHARGE_CANCEL_REQUESTED").map((a) => a.paymentId), ["p-oct", "p-nov"]);
});

// ── 플러그인 응답 ──

test("묶음 플러그인 응답: items 에 청구별 상품명(가린 이름)·금액·면세·같은 메모, 합계 = amount · 단건은 항목 1개", async () => {
  const svc = await loadService();
  const id = "0b8f0f5e-1111-4222-8333-944445555666";
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [bundleView({ id, status: "SENT" })], claimViewRows: [{ id }], items: BUNDLE_ITEMS.map((it) => ({ ...it, requestId: id })) };
  const v = await svc.claimChargeRequestForPlugin(id, "t1");
  assert.equal(v.itemName, "2026년 10월 수강료 외 1건(홍*동)");
  assert.deepEqual(v.items.map((it) => it.itemName), ["2026년 10월 수강료(홍*동)", "2026년 11월 수강료(홍*동)"]);
  assert.deepEqual(v.items.map((it) => it.memo), ["STIZ:S-482193", "STIZ:S-482193"]);
  assert.equal(v.items.reduce((s, it) => s + it.amount, 0), v.amount);
  assert.equal(v.items.reduce((s, it) => s + it.taxFreeAmount, 0), v.taxFreeAmount);
  assert.ok(!JSON.stringify(v).includes("홍길동"), "실명이 응답에 없다");
  // 선점 SQL 도 묶인 청구 전부가 미납일 때만
  const claim = globalThis.__cs.calls.find((c) => /SET status = 'SENT'/.test(c.sql));
  assert.match(claim.sql, /FROM "PosChargeRequestItem" i WHERE i\."requestId" = r\.id/);
  // 단건(항목 없음 = 옛 요청) → 항목 1개 = 요청 그대로
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], viewRows: [bundleView({ id, amount: 180000, taxFreeAmount: 180000, month: 11 })], claimViewRows: [{ id }] };
  const single = await svc.claimChargeRequestForPlugin(id, "t1");
  assert.deepEqual(single.items, [{ itemName: "2026년 11월 수강료(홍*동)", itemTitle: "2026년 11월 수강료(홍*동)", amount: 180000, taxFreeAmount: 180000, memo: "STIZ:S-482193" }]);
});

test("묶음 화면: 납부 처리 창 → 같은 학생 여러 건 현장 결제 · 현장 결제/결제 취소 창에 «외 N건 · 합계» 표시", async () => {
  const modal = await readFile("src/app/admin/finance/PosChargeRequestModal.tsx", "utf8");
  assert.match(modal, /`\$\{target\.studentName\} · \$\{target\.title\} · 합계 \$\{won\(target\.amount\)\}`/);
  assert.match(modal, /createPosChargeRequest\(idsKey\.split\(","\)\)/);
  assert.match(modal, /loadPosChargeRequest\(idsKey\.split\(","\)\)/);
  const cancel = await readFile(CANCEL_MODAL, "utf8");
  assert.match(cancel, /`\$\{target\.studentName\} · \$\{cancel\.itemLabel\} · 합계 \$\{won\(cancel\.amount\)\}`/);
  assert.match(cancel, /청구 \$\{cancel\.itemCount\}건이 모두 환불로 바뀝니다/);
  const record = await readFile("src/app/admin/finance/RecordPaymentModal.tsx", "utf8");
  assert.doesNotMatch(record + (await readFile("src/lib/payments/bankTransferRecord.ts", "utf8")), /곧 추가됩니다/);
  const actions = await readFile(ACTIONS, "utf8");
  assert.match(actions, /getChargeRequestForPayments\(ids\)/);
});

// ── 검수 반영(2026-11-08): 배포 전환 틈 · 요청 취소 감사 기록 · 청구 id 모양 ──

test("배포 전환 틈: 요청 INSERT 트리거가 대표 청구 항목(1번)을 넣어 옛 코드의 단건도 열린 항목 유일 인덱스에 걸린다", async () => {
  const m = await readFile(BUNDLE_MIGRATION, "utf8");
  const fnStart = m.indexOf("CREATE OR REPLACE FUNCTION pos_charge_request_add_rep_item()");
  const fn = m.slice(fnStart, m.indexOf("END $$;", fnStart));
  assert.match(fn, /INSERT INTO "PosChargeRequestItem" \("requestId", "paymentId", amount, "taxFreeAmount", position, "open"\)/);
  assert.match(fn, /VALUES \(NEW\.id, NEW\."paymentId", NEW\.amount, NEW\."taxFreeAmount", 1, NEW\.status IN \(/);
  const open = /NEW\.status IN \(([^)]*)\)\)/.exec(fn);
  assert.deepEqual(listIn(open[1]).sort(), [...R.OPEN_CHARGE_STATUSES].sort());
  // 흡수는 «같은 요청·같은 청구»만 — 다른 열린 요청에 든 청구(열린 항목 유일 인덱스)는 삼키지 않고 실패시킨다
  assert.match(fn, /ON CONFLICT \("requestId", "paymentId"\) DO NOTHING;/);
  assert.doesNotMatch(fn, /ON CONFLICT DO NOTHING/);
  assert.match(m, /CREATE TRIGGER "PosChargeRequest_add_rep_item_trg"\s+AFTER INSERT ON "PosChargeRequest"\s+FOR EACH ROW EXECUTE FUNCTION pos_charge_request_add_rep_item\(\);/);
  assert.match(m, /--\s+DROP TRIGGER IF EXISTS "PosChargeRequest_add_rep_item_trg" ON "PosChargeRequest";/);
  assert.match(m, /--\s+DROP FUNCTION IF EXISTS pos_charge_request_add_rep_item\(\);/);
  // 트리거는 표를 만든 뒤에(항목 표가 있어야 함)
  assert.ok(m.indexOf('CREATE TABLE IF NOT EXISTS "PosChargeRequestItem"') < m.indexOf('CREATE TRIGGER "PosChargeRequest_add_rep_item_trg"'));
});

test("배포 전환 틈: 새 코드의 항목 INSERT 는 트리거가 넣은 대표 행을 ON CONFLICT 로 덮어써 흡수(대표 항목 중복 없음 · 묶음 대표 금액 교정)", async () => {
  await runCreate({
    payments: BUNDLE_PAYMENTS,
    viewRows: (sql) => (/WHERE r\.id = \$1/.test(sql) ? [bundleView()] : []),
    insertRows: [{ id: "r9" }],
    itemInsertRows: [{ id: "i1" }, { id: "i2" }],
    items: BUNDLE_ITEMS.map((it) => ({ ...it, requestId: "r9" })),
  }, ["p-nov", "p-oct"]);
  const items = globalThis.__cs.calls.find((c) => /INSERT INTO "PosChargeRequestItem"/.test(c.sql));
  assert.match(items.sql, /ON CONFLICT \("requestId", "paymentId"\) DO UPDATE\s+SET amount = EXCLUDED\.amount, "taxFreeAmount" = EXCLUDED\."taxFreeAmount", position = EXCLUDED\.position/);
  // 대표 청구(1번 항목) = 요청의 paymentId — 트리거가 넣는 행과 새 코드의 1번 항목이 같은 (요청, 청구)
  const ins = globalThis.__cs.calls.find((c) => /INSERT INTO "PosChargeRequest" \(/.test(c.sql));
  assert.match(ins.sql, /\(SELECT ok\.id FROM ok ORDER BY ok\.ord LIMIT 1\)/);
  // 행 수 확인(덮어쓴 대표 행도 RETURNING 에 나온다) — 하나라도 모자라면 CHANGED 로 전부 되돌림
  const short = await runCreate({ payments: BUNDLE_PAYMENTS, viewRows: () => [], insertRows: [{ id: "r9" }], itemInsertRows: [{ id: "i1" }] }, ["p-nov", "p-oct"]);
  assert.equal(short.code, "CHANGED");
});

test("요청 취소: 감사 기록을 묶인 청구마다(항목 없는 옛 요청은 대표 청구 1건)", async () => {
  const svc = await loadService();
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], cancelRows: [{ id: "r1", paymentId: "p-oct", shortCode: "S-482193" }], items: BUNDLE_ITEMS };
  await svc.cancelChargeRequestByAdmin({ requestId: "r1", adminUserId: "admin-1" });
  let audits = globalThis.__cs.audits.filter((a) => a.action === "POS_CHARGE_REQUEST_CANCELLED");
  assert.deepEqual(audits.map((a) => a.paymentId), ["p-oct", "p-nov"]);
  assert.match(audits[0].message, /묶음 2건/);
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], cancelRows: [{ id: "r1", paymentId: "p-nov", shortCode: "S-482193" }] };
  await svc.cancelChargeRequestByAdmin({ requestId: "r1", adminUserId: "admin-1" });
  audits = globalThis.__cs.audits.filter((a) => a.action === "POS_CHARGE_REQUEST_CANCELLED");
  assert.deepEqual(audits.map((a) => a.paymentId), ["p-nov"]);
  assert.equal(audits[0].message, "현장 결제 요청 S-482193 취소");
  globalThis.__cs = { calls: [], paid: [], audits: [], slack: [], cancelRows: [] };
  await assert.rejects(svc.cancelChargeRequestByAdmin({ requestId: "r1", adminUserId: "admin-1" }), (e) => e.code === "NOT_CLAIMABLE");
});

test("관리자 동작: 청구 id 에 문자열 아닌 값·빈 값이 하나라도 섞이면 통째로 거절(빈 배열)", async () => {
  const src = await readFile(ACTIONS, "utf8");
  const start = src.indexOf("function paymentIdsOf");
  const body = src.slice(start, src.indexOf("\n}\n", start) + 2);
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const paymentIdsOf = new Function(`${js}; return paymentIdsOf;`)();
  assert.deepEqual(paymentIdsOf("p-1"), ["p-1"]);
  assert.deepEqual(paymentIdsOf(["p-1", "p-2"]), ["p-1", "p-2"]);
  assert.deepEqual(paymentIdsOf(["p-1", 2]), [], "숫자가 섞이면 거절");
  assert.deepEqual(paymentIdsOf(["p-1", { id: "p-2" }]), []);
  assert.deepEqual(paymentIdsOf(["p-1", ""]), [], "빈 값이 섞이면 거절");
  assert.deepEqual(paymentIdsOf([null]), []);
  assert.deepEqual(paymentIdsOf(Array.from({ length: 21 }, (_, i) => `p-${i}`)), []);
});
