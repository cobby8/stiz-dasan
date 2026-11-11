// 체험비 온라인 결제(2026-11-10) — 로그인 없는 신청자가 «신청 건에 묶인 결제 링크 토큰»으로 1만원을 결제한다.
// 1) 순수 규칙(trialFeeRules.ts)은 실제로 실행한다 — 금액 대조·이중 확정·토큰 모양·주문번호.
// 2) 장부 연결부(trialFeeLedger.ts)는 메모리 가짜 DB 로 실행한다 — «한 번만 확정», «이미 낸 신청은 NEEDS_REFUND», «환불».
// 3) 토큰(trialFeeToken.ts)은 실제 crypto 로 — 원문이 아니라 해시로만 찾는다.
// 4) 소스 계약 — 웹훅 갈래·금액을 화면에서 받지 않음·마이그레이션 방어선·안내 스위치 기본 꺼짐.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/trial-fee/trialFeeRules.ts");
const ledger = await loadTsModule("src/lib/trial-fee/trialFeeLedger.ts");
const token = await loadTsModule("src/lib/trial-fee/trialFeeToken.ts");
const guides = await loadTsModule("src/lib/trial-fee/guideMessages.ts");
const vault = await loadTsModule("src/lib/messaging/parent-alimtalk-templates.ts");
const confirmation = await loadTsModule("src/lib/trial-fee-confirmation.ts");
const read = (p) => readFileSync(p, "utf8");

// ───────────────────────────── 1) 순수 규칙 ─────────────────────────────

test("체험비 금액은 설정값 — 범위 밖·숫자 아님은 기본 1만 원", () => {
  assert.equal(rules.normalizeTrialFeeAmount(10000), 10000);
  assert.equal(rules.normalizeTrialFeeAmount("15,000"), 15000);
  assert.equal(rules.normalizeTrialFeeAmount(null), 10000);
  assert.equal(rules.normalizeTrialFeeAmount(0), 10000);
  assert.equal(rules.normalizeTrialFeeAmount(1_000_000), 10000, "오타로 100만 원이 결제되지 않게");
  assert.equal(rules.normalizeTrialFeeAmount(10000.5), 10000);
  assert.equal(rules.formatTrialFeeAmount(10000), "10,000원");
});

test("주문번호는 TRIAL- 머리말(청구 STIZ-·심사 REVIEW- 와 섞이지 않음), 웹훅 본문 두 모양에서 꺼낸다", () => {
  const id = rules.makeTrialFeeOrderId("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed");
  assert.match(id, /^TRIAL-[A-Za-z0-9]{6,32}$/);
  assert.ok(rules.isTrialFeeOrderId(id));
  assert.equal(rules.isTrialFeeOrderId("STIZ-1700000000-abcd"), false);
  assert.equal(rules.isTrialFeeOrderId("TRIAL-ab"), false);
  assert.equal(rules.extractWebhookOrderId({ eventType: "PAYMENT_STATUS_CHANGED", data: { orderId: id } }), id);
  assert.equal(rules.extractWebhookOrderId({ secret: "s", status: "DONE", orderId: id }), id, "입금 알림(DEPOSIT_CALLBACK)은 최상위 orderId");
  assert.equal(rules.extractWebhookOrderId(null), null);
});

test("결제 링크 토큰 모양: 32바이트 base64url(43자)만 — 신청 id(uuid)는 토큰이 아니다", () => {
  const { token: raw, hash } = token.createTrialPaymentToken();
  assert.ok(rules.isTrialPaymentTokenShape(raw));
  assert.equal(raw.length, 43);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(token.hashTrialPaymentToken(raw), hash, "같은 토큰 = 같은 해시");
  assert.notEqual(hash, raw, "원문을 저장하지 않는다");
  assert.equal(token.tokenHashOrNull("1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed"), null);
  assert.equal(token.tokenHashOrNull("' OR 1=1 --"), null);
  assert.equal(token.tokenHashOrNull(undefined), null);
  const other = token.createTrialPaymentToken();
  assert.notEqual(other.token, raw);
  assert.match(token.trialCustomerKey("lead-1"), /^stiz_t_[A-Za-z0-9_-]{36}$/);
});

test("결제창 열기 판정: 없음·이미 냄(학원 입금 확인 포함)·종료 상태·결제 꺼짐을 서버가 막는다", () => {
  const base = { found: true, status: "NEW", feeConfirmed: false, feeSummary: null, paymentEnabled: true };
  assert.equal(rules.trialCheckoutBlock(base), null);
  assert.equal(rules.trialCheckoutBlock({ ...base, found: false }), "NOT_FOUND");
  assert.equal(rules.trialCheckoutBlock({ ...base, feeConfirmed: true }), "ALREADY_PAID", "계좌로 입금 확인된 신청도 다시 결제 안 받음");
  assert.equal(rules.trialCheckoutBlock({ ...base, feeSummary: "PAID" }), "ALREADY_PAID");
  for (const status of ["ATTENDED", "CONVERTED", "LOST", "CANCELLED"]) {
    assert.equal(rules.trialCheckoutBlock({ ...base, status }), "CLOSED", status);
  }
  assert.equal(rules.trialCheckoutBlock({ ...base, paymentEnabled: false }), "PAYMENT_OFF");
  assert.equal(rules.trialCheckoutBlock({ ...base, status: "SCHEDULED" }), null);
});

test("승인 전 판정: 금액이 다르면 거부(주소창 금액 변조), 이미 확정된 신청은 승인하지 않음, 두 탭 동시 승인 차단", () => {
  const stored = { amount: 10000, status: "READY", paymentKey: null, confirmStartedAtMs: null };
  const now = 1_800_000_000_000;
  const ok = rules.decideTrialFeeConfirm({ stored, request: { paymentKey: "pk1", amount: 10000 }, leadAlreadyPaid: false, nowMs: now });
  assert.deepEqual(ok, { kind: "PROCEED" });
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored, request: { paymentKey: "pk1", amount: 100 }, leadAlreadyPaid: false, nowMs: now }),
    { kind: "REJECT", reason: "AMOUNT_MISMATCH" });
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored, request: { paymentKey: "pk1", amount: 10000 }, leadAlreadyPaid: true, nowMs: now }),
    { kind: "REJECT", reason: "LEAD_ALREADY_PAID" });
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored: { ...stored, confirmStartedAtMs: now - 60_000 }, request: { paymentKey: "pk2", amount: 10000 }, leadAlreadyPaid: false, nowMs: now }),
    { kind: "REJECT", reason: "IN_PROGRESS" });
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored: { ...stored, confirmStartedAtMs: now - 11 * 60_000 }, request: { paymentKey: "pk2", amount: 10000 }, leadAlreadyPaid: false, nowMs: now }),
    { kind: "PROCEED" }, "10분 지난 «진행 중»은 다시 시도 가능(같은 멱등키라 토스가 같은 결과)");
  // 같은 결제키 새로고침 — 토스를 다시 부르지 않는다
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored: { ...stored, status: "DONE", paymentKey: "pk1" }, request: { paymentKey: "pk1", amount: 10000 }, leadAlreadyPaid: true, nowMs: now }),
    { kind: "ALREADY_DONE" });
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored: { ...stored, status: "DONE", paymentKey: "pk1" }, request: { paymentKey: "OTHER", amount: 10000 }, leadAlreadyPaid: true, nowMs: now }),
    { kind: "REJECT", reason: "LEAD_ALREADY_PAID" }, "다른 결제키로 확정된 주문에 또 승인하지 않는다");
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored: { ...stored, status: "WAITING_FOR_DEPOSIT", paymentKey: "pk1" }, request: { paymentKey: "pk1", amount: 10000 }, leadAlreadyPaid: false, nowMs: now }),
    { kind: "WAITING_DEPOSIT" });
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored: { ...stored, status: "FAILED" }, request: { paymentKey: "pk1", amount: 10000 }, leadAlreadyPaid: false, nowMs: now }),
    { kind: "REJECT", reason: "ORDER_CLOSED" });
});

test("토스 결과 대조: 주문·결제키·금액이 모두 맞아야 DONE/WAITING — 하나라도 다르면 장부 반영 금지", () => {
  const stored = { orderId: "TRIAL-abc123", amount: 10000 };
  const done = { status: "DONE", orderId: "TRIAL-abc123", paymentKey: "pk1", totalAmount: 10000 };
  assert.equal(rules.classifyTrialTossResult(done, stored, "pk1"), "DONE");
  assert.equal(rules.classifyTrialTossResult({ ...done, status: "WAITING_FOR_DEPOSIT" }, stored, "pk1"), "WAITING");
  assert.equal(rules.classifyTrialTossResult({ ...done, totalAmount: 100 }, stored, "pk1"), "MISMATCH");
  assert.equal(rules.classifyTrialTossResult({ ...done, orderId: "TRIAL-other1" }, stored, "pk1"), "MISMATCH");
  assert.equal(rules.classifyTrialTossResult({ ...done, paymentKey: "pk2" }, stored, "pk1"), "MISMATCH");
  assert.equal(rules.classifyTrialTossResult({ ...done, status: "CANCELED" }, stored, "pk1"), "MISMATCH");
  assert.equal(rules.classifyTrialTossResult(null, stored, "pk1"), "MISMATCH");
});

test("관리자 표시: 온라인 결제 요약이 먼저, 예전 입금 확인 문구는 그대로", () => {
  const label = confirmation.trialFeeStatusLabel;
  assert.equal(label({ trialFeeConfirmed: true, trialFeePaymentStatus: "PAID" }), "결제 완료(온라인)");
  assert.equal(label({ trialFeeConfirmed: false, trialFeePaymentStatus: "WAITING_FOR_DEPOSIT" }), "입금 대기(무통장 계좌 발급)");
  assert.equal(label({ trialFeeConfirmed: false, trialFeePaymentStatus: "REFUNDED" }), "환불 완료");
  assert.equal(label({ trialFeeConfirmed: true, trialFeePaymentStatus: "NEEDS_REFUND" }), "이중 결제(환불 필요)");
  assert.equal(label({ trialFeeConfirmed: true }), "입금 완료");
  assert.equal(label({ trialFeeConfirmed: false, trialFeeNoticeAgreedAt: "2026-11-10T00:00:00Z" }), "입금 대기(학부모 동의함)");
  assert.deepEqual(rules.trialFeeListChip({ trialFeeConfirmed: true, trialFeePaymentStatus: "PAID" }), { label: "결제", needsAction: false });
  assert.deepEqual(rules.trialFeeListChip({ trialFeeConfirmed: true, trialFeePaymentStatus: "NEEDS_REFUND" }), { label: "환불 필요", needsAction: true });
  assert.equal(rules.trialFeeListChip({ trialFeeConfirmed: false }), null);
  assert.equal(rules.canRefundTrialFeeOnline("PAID"), true);
  assert.equal(rules.canRefundTrialFeeOnline("NEEDS_REFUND"), true);
  assert.equal(rules.canRefundTrialFeeOnline("WAITING_FOR_DEPOSIT"), false, "입금 전 계좌는 환불 대상이 아니다");
  assert.equal(rules.canRefundTrialFeeOnline(null), false);
});

// ───────────────────────────── 2) 장부(가짜 DB) ─────────────────────────────

/** TrialLead·TrialFeePayment·ApplicationContactLog 만 흉내 내는 메모리 DB(쓰는 SQL 모양 그대로 판정) */
function fakeDb({ lead = {}, payments = [] } = {}) {
  const state = {
    lead: { id: "lead-1", trialFeeConfirmed: false, trialFeePaymentStatus: null, trialFeePaidAt: null, ...lead },
    payments: payments.map((p) => ({ id: "pay-1", trialLeadId: "lead-1", orderId: "TRIAL-abc123", paymentKey: null, amount: 10000, taxFreeAmount: 10000, status: "READY", method: null, confirmStartedAt: null, rawResponse: null, ...p })),
    logs: [],
    calls: [],
  };
  const pay = (id) => state.payments.find((p) => p.id === id);
  const db = {
    state,
    async $queryRawUnsafe(sql, ...v) {
      state.calls.push(sql);
      if (/SELECT "trialFeeConfirmed", "trialFeePaymentStatus" FROM "TrialLead" WHERE id = \$1 FOR UPDATE/.test(sql)
        || /SELECT "trialFeeConfirmed" FROM "TrialLead" WHERE id = \$1 FOR UPDATE/.test(sql)) {
        return v[0] === state.lead.id ? [{ ...state.lead }] : [];
      }
      if (/SELECT \* FROM "TrialFeePayment" WHERE id = \$1 AND "trialLeadId" = \$2 FOR UPDATE/.test(sql)) {
        const p = pay(v[0]);
        return p && p.trialLeadId === v[1] ? [{ ...p }] : [];
      }
      if (/SELECT status FROM "TrialFeePayment" WHERE id = \$1 AND "trialLeadId" = \$2 FOR UPDATE/.test(sql)) {
        const p = pay(v[0]);
        return p && p.trialLeadId === v[1] ? [{ status: p.status }] : [];
      }
      if (/SELECT id FROM "TrialFeePayment" WHERE "trialLeadId" = \$1 AND status = 'DONE' AND id <> \$2/.test(sql)) {
        return state.payments.filter((p) => p.trialLeadId === v[0] && p.status === "DONE" && p.id !== v[1]).map((p) => ({ id: p.id }));
      }
      if (/SELECT id FROM "TrialFeePayment"\s+WHERE "trialLeadId" = \$1 AND id <> \$2\s+AND \(status = 'WAITING_FOR_DEPOSIT'/.test(sql)) {
        // 가짜 DB 의 «10분 안»: confirmStartedAt 이 찍힌 READY 주문(테스트가 시각을 정한다)
        return state.payments.filter((p) => p.trialLeadId === v[0] && p.id !== v[1]
          && (p.status === "WAITING_FOR_DEPOSIT" || (p.status === "READY" && p.confirmStartedAt))).map((p) => ({ id: p.id }));
      }
      if (/SELECT \* FROM "TrialFeePayment" WHERE "orderId" = \$1 AND "trialLeadId" = \$2/.test(sql)) {
        return state.payments.filter((p) => p.orderId === v[0] && p.trialLeadId === v[1]);
      }
      if (/SELECT .* FROM "TrialLead" WHERE "paymentTokenHash" = \$1/s.test(sql)) {
        return state.lead.paymentTokenHash === v[0] ? [{ ...state.lead }] : [];
      }
      if (/UPDATE "TrialFeePayment"\s+SET status = \$2/.test(sql)) {
        const p = pay(v[0]);
        if (!p || !["READY", "WAITING_FOR_DEPOSIT", "FAILED", "EXPIRED"].includes(p.status)) return [];
        // DB 부분 유일 인덱스: 신청당 DONE 1건
        if (v[1] === "DONE" && state.payments.some((o) => o.id !== p.id && o.trialLeadId === p.trialLeadId && o.status === "DONE")) {
          throw new Error('duplicate key value violates unique constraint "TrialFeePayment_one_done_per_lead"');
        }
        Object.assign(p, { status: v[1], paymentKey: v[2], method: v[3] ?? p.method });
        return [{ id: p.id }];
      }
      if (/UPDATE "TrialLead"\s+SET "trialFeeConfirmed" = true/.test(sql)) {
        if (v[0] !== state.lead.id || state.lead.trialFeeConfirmed) return [];
        Object.assign(state.lead, { trialFeeConfirmed: true, trialFeePaymentStatus: "PAID", trialFeePaidAt: state.lead.trialFeePaidAt ?? "now" });
        return [{ id: state.lead.id }];
      }
      if (/UPDATE "TrialLead"\s+SET "trialFeeConfirmed" = false,\s+"trialFeePaymentStatus" = 'REFUNDED'/.test(sql)) {
        if (v[0] !== state.lead.id || state.lead.trialFeePaymentStatus !== "PAID") return [];
        Object.assign(state.lead, { trialFeeConfirmed: false, trialFeePaymentStatus: "REFUNDED" });
        return [{ id: state.lead.id }];
      }
      throw new Error(`가짜 DB 가 모르는 조회: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql, ...v) {
      state.calls.push(sql);
      if (/INSERT INTO "ApplicationContactLog"/.test(sql)) { state.logs.push(v); return 1; }
      if (/UPDATE "TrialFeePayment" SET "confirmStartedAt" = NOW\(\), "paymentKey" = \$2/.test(sql)) {
        Object.assign(pay(v[0]), { confirmStartedAt: new Date(1_800_000_000_000).toISOString(), paymentKey: v[1] });
        return 1;
      }
      if (/UPDATE "TrialLead" SET "trialFeePaymentStatus" = 'NEEDS_REFUND'/.test(sql)) {
        if (state.lead.trialFeePaymentStatus === "PAID") return 0;
        state.lead.trialFeePaymentStatus = "NEEDS_REFUND";
        return 1;
      }
      if (/UPDATE "TrialFeePayment" SET status = 'CANCELED'/.test(sql)) {
        const p = pay(v[0]);
        if (!p || !["DONE", "NEEDS_REFUND"].includes(p.status)) return 0;
        p.status = "CANCELED";
        return 1;
      }
      if (/UPDATE "TrialLead" SET "trialFeePaymentStatus" = NULL, "updatedAt" = NOW\(\)\s+WHERE id = \$1 AND "trialFeePaymentStatus" = 'NEEDS_REFUND'/.test(sql)) {
        if (state.lead.trialFeePaymentStatus !== "NEEDS_REFUND") return 0;
        state.lead.trialFeePaymentStatus = null;
        return 1;
      }
      throw new Error(`가짜 DB 가 모르는 쓰기: ${sql.slice(0, 80)}`);
    },
  };
  return db;
}

const paidInput = (over = {}) => ({
  paymentRowId: "pay-1", trialLeadId: "lead-1", paymentKey: "pk1", method: "카드", receiptUrl: null,
  approvedAt: "2026-11-10T10:00:00+09:00", rawResponse: { status: "DONE" }, ...over,
});

test("[장부] 결제 확정은 한 번만 — 신청이 «결제 완료»가 되고, 같은 결제가 다시 와도(새로고침·웹훅) 바뀌지 않는다", async () => {
  const db = fakeDb({ payments: [{}] });
  assert.deepEqual(await ledger.finalizeTrialFeePaidInTx(db, paidInput()), { kind: "PAID" });
  assert.equal(db.state.lead.trialFeeConfirmed, true);
  assert.equal(db.state.lead.trialFeePaymentStatus, "PAID");
  assert.equal(db.state.payments[0].status, "DONE");
  assert.equal(db.state.logs.length, 1, "연락 이력 1건");
  assert.deepEqual(await ledger.finalizeTrialFeePaidInTx(db, paidInput()), { kind: "ALREADY" });
  assert.equal(db.state.logs.length, 1, "두 번째는 이력도 안 쌓는다");
});

test("[장부] 학원이 계좌 입금을 이미 확인한 신청에 온라인 결제가 들어오면 확정하지 않고 NEEDS_REFUND(환불 필요)", async () => {
  const db = fakeDb({ lead: { trialFeeConfirmed: true }, payments: [{ status: "WAITING_FOR_DEPOSIT", paymentKey: "pk1" }] });
  assert.deepEqual(await ledger.finalizeTrialFeePaidInTx(db, paidInput()), { kind: "DUPLICATE" });
  assert.equal(db.state.payments[0].status, "NEEDS_REFUND");
  assert.equal(db.state.lead.trialFeePaymentStatus, "NEEDS_REFUND", "관리자 목록에 «환불 필요»가 보이게");
  assert.equal(db.state.logs.length, 0, "«결제 완료» 이력을 남기지 않는다");
});

test("[장부] 다른 주문이 이미 확정된 신청에 두 번째 결제 → NEEDS_REFUND, 신청 요약(PAID)은 그대로", async () => {
  const db = fakeDb({ payments: [{ id: "pay-1" }, { id: "pay-2", orderId: "TRIAL-xyz789" }] });
  assert.equal((await ledger.finalizeTrialFeePaidInTx(db, paidInput())).kind, "PAID");
  assert.deepEqual(await ledger.finalizeTrialFeePaidInTx(db, paidInput({ paymentRowId: "pay-2", paymentKey: "pk2" })), { kind: "DUPLICATE" });
  assert.equal(db.state.payments[1].status, "NEEDS_REFUND");
  assert.equal(db.state.lead.trialFeePaymentStatus, "PAID");
});

test("[장부] 동시에 두 결제가 확정을 시도해도 «결제 완료»는 하나(나머지는 NEEDS_REFUND)", async () => {
  const db = fakeDb({ payments: [{ id: "pay-1" }, { id: "pay-2", orderId: "TRIAL-xyz789" }] });
  // 가짜 DB 는 FOR UPDATE 잠금이 없으니 순서대로 — 실제 DB 는 신청 행 잠금으로 같은 순서가 강제된다
  const results = [];
  for (const id of ["pay-1", "pay-2"]) results.push((await ledger.finalizeTrialFeePaidInTx(db, paidInput({ paymentRowId: id }))).kind);
  assert.deepEqual(results.sort(), ["DUPLICATE", "PAID"]);
  assert.equal(db.state.payments.filter((p) => p.status === "DONE").length, 1);
});

test("[장부] 남의 신청 결제 행은 못 건드린다 — 결제 행과 신청 id 가 짝이 맞아야 한다", async () => {
  const db = fakeDb({ payments: [{ trialLeadId: "lead-OTHER" }] });
  assert.deepEqual(await ledger.finalizeTrialFeePaidInTx(db, paidInput()), { kind: "NOT_FOUND" });
  assert.equal(db.state.lead.trialFeeConfirmed, false);
  // 주문번호만으로는 못 찾는다(신청 id 도 같이)
  assert.deepEqual(await ledger.findTrialFeePaymentForLead(db, "TRIAL-abc123", "lead-1"), null);
});

test("[장부] 승인 직전 잠금: 이미 결제된 신청은 거부, 정상이면 «진행 중» 표시 후 두 번째 탭은 IN_PROGRESS", async () => {
  const paid = fakeDb({ lead: { trialFeeConfirmed: true }, payments: [{}] });
  assert.deepEqual(await ledger.claimTrialFeeConfirmInTx(paid, { paymentRowId: "pay-1", trialLeadId: "lead-1", paymentKey: "pk1", amount: 10000, nowMs: 1_800_000_000_000 }),
    { kind: "REJECT", reason: "LEAD_ALREADY_PAID" });
  assert.equal(paid.state.payments[0].confirmStartedAt, null, "거부하면 아무것도 쓰지 않는다");

  const db = fakeDb({ payments: [{}] });
  const first = await ledger.claimTrialFeeConfirmInTx(db, { paymentRowId: "pay-1", trialLeadId: "lead-1", paymentKey: "pk1", amount: 10000, nowMs: 1_800_000_000_000 });
  assert.deepEqual(first, { kind: "PROCEED" });
  assert.equal(db.state.payments[0].paymentKey, "pk1");
  const second = await ledger.claimTrialFeeConfirmInTx(db, { paymentRowId: "pay-1", trialLeadId: "lead-1", paymentKey: "pk2", amount: 10000, nowMs: 1_800_000_000_000 + 5_000 });
  assert.deepEqual(second, { kind: "REJECT", reason: "IN_PROGRESS" });
  const tampered = await ledger.claimTrialFeeConfirmInTx(fakeDb({ payments: [{}] }), { paymentRowId: "pay-1", trialLeadId: "lead-1", paymentKey: "pk1", amount: 100, nowMs: 1 });
  assert.deepEqual(tampered, { kind: "REJECT", reason: "AMOUNT_MISMATCH" });
});

test("[장부] 전액 취소: 확정 결제면 신청을 «환불 완료»로(입금 확인 해제), 이중 결제면 «환불 필요» 표시만 지운다", async () => {
  const db = fakeDb({ payments: [{}] });
  await ledger.finalizeTrialFeePaidInTx(db, paidInput());
  const actor = { userId: "admin-1", userName: "원장" };
  assert.deepEqual(await ledger.applyTrialFeeFullCancelInTx(db, { paymentRowId: "pay-1", trialLeadId: "lead-1", rawResponse: {}, actor }), { changed: true, leadRefunded: true });
  assert.equal(db.state.lead.trialFeeConfirmed, false);
  assert.equal(db.state.lead.trialFeePaymentStatus, "REFUNDED");
  assert.deepEqual(await ledger.applyTrialFeeFullCancelInTx(db, { paymentRowId: "pay-1", trialLeadId: "lead-1", rawResponse: {}, actor }), { changed: false, leadRefunded: false }, "두 번째 취소 알림은 그대로");

  const dup = fakeDb({ lead: { trialFeeConfirmed: true, trialFeePaymentStatus: "NEEDS_REFUND" }, payments: [{ status: "NEEDS_REFUND", paymentKey: "pk1" }] });
  assert.deepEqual(await ledger.applyTrialFeeFullCancelInTx(dup, { paymentRowId: "pay-1", trialLeadId: "lead-1", rawResponse: {}, actor }), { changed: true, leadRefunded: false });
  assert.equal(dup.state.lead.trialFeeConfirmed, true, "계좌로 낸 확정은 그대로");
  assert.equal(dup.state.lead.trialFeePaymentStatus, null);
});

test("[장부] 토큰으로 신청 찾기: 해시 칸으로만 — 신청 id 로 찾는 길이 없다", async () => {
  const { token: raw, hash } = token.createTrialPaymentToken();
  const db = fakeDb({ lead: { paymentTokenHash: hash, childName: "합성" } });
  assert.equal((await ledger.findTrialLeadByTokenHash(db, hash))?.id, "lead-1");
  assert.equal(await ledger.findTrialLeadByTokenHash(db, token.hashTrialPaymentToken(raw.slice(0, -1) + (raw.endsWith("A") ? "B" : "A"))), null);
  const src = read("src/lib/trial-fee/trialFeeLedger.ts");
  const fn = src.slice(src.indexOf("export async function findTrialLeadByTokenHash"), src.indexOf("export async function latestTrialFeePayment"));
  assert.match(fn, /WHERE "paymentTokenHash" = \$1/);
  assert.doesNotMatch(fn, /WHERE id =/);
  // 화면으로 나가는 신청 칸 목록에 토큰 해시가 없다
  assert.doesNotMatch(src.slice(src.indexOf("const LEAD_COLUMNS"), src.indexOf("/** 결제 링크 토큰(해시)으로")), /paymentTokenHash/);
});

// ───────────────────────────── 3) 소스 계약 ─────────────────────────────

const service = read("src/lib/trial-fee/trialFeePaymentService.ts");
const checkoutRoute = read("src/app/api/apply/trial-fee/checkout/route.ts");
const confirmRoute = read("src/app/api/apply/trial-fee/confirm/route.ts");
const webhookRoute = read("src/app/api/payments/toss/webhook/route.ts");
const migration = read("prisma/migrations/20261110150000_trial_fee_online_payment/migration.sql");

test("[계약] 결제 시작 API 는 본문에서 금액을 받지 않는다 — 금액·면세는 서버 설정값(taxFreeAmountFor)", () => {
  assert.doesNotMatch(checkoutRoute, /body\?\.amount|body\.amount/);
  const start = service.slice(service.indexOf("export async function startTrialFeeCheckout"), service.indexOf("// ───────────────────────────── ③ 승인"));
  assert.match(start, /const amount = settings\.amount;/);
  assert.match(start, /const taxFreeAmount = taxFreeAmountFor\(amount\);/);
  assert.match(start, /taxFreeAmount: Number\(reserved\.row\.taxFreeAmount\)/);
  // 화면은 서버가 준 면세 금액을 그대로 토스에 넘긴다
  assert.match(read("src/app/apply/trial/pay/TrialFeeCheckoutClient.tsx"), /taxFreeAmount: data\.taxFreeAmount/);
});

test("[계약] 승인: 토큰→신청→(주문번호+신청) 순으로 찾고, 토스에는 저장된 주문 금액을 보낸다, 승인 전 잠금", () => {
  const fn = service.slice(service.indexOf("export async function confirmTrialFeeOnlinePayment"), service.indexOf("// ───────────────────────────── ④ 웹훅"));
  assert.match(fn, /findTrialLeadByTokenHash\(prisma, hash\)/);
  assert.match(fn, /findTrialFeePaymentForLead\(prisma, input\.orderId, lead\.id\)/);
  assert.match(fn, /claimTrialFeeConfirmInTx/);
  assert.ok(fn.indexOf("claimTrialFeeConfirmInTx") < fn.indexOf("/v1/payments/confirm"), "승인 전에 잠금·재확인");
  assert.match(fn, /amount: Number\(row\.amount\)/);
  assert.match(fn, /"Idempotency-Key": makeUuidFromSeed\(`stiz-trial-confirm:/);
  assert.match(confirmRoute, /confirmTrialFeeOnlinePayment\(/);
});

test("[계약] 토스 웹훅: 주문번호 TRIAL- 은 체험비 장부로, 그 밖은 기존 청구 장부 그대로", () => {
  assert.match(webhookRoute, /if \(isTrialFeeWebhook\(payload\)\) \{[\s\S]*?recordTrialFeeTossWebhook\(payload\)/);
  assert.ok(webhookRoute.indexOf("isTrialFeeWebhook(payload)") < webhookRoute.indexOf("recordTossWebhook(payload)"));
  const fn = service.slice(service.indexOf("export async function recordTrialFeeTossWebhook"));
  // 무통장 입금 알림은 secret 대조가 토스 조회보다 먼저, 반영은 재조회 결과로만
  assert.ok(fn.indexOf("checkDepositSecret") < fn.indexOf("getVerifiedTossPayment"));
  assert.match(fn, /classifyTrialTossResult\(verified/);
});

test("[계약] 환불은 청구 환불과 같은 순서 — 재조회 → 기록 → 토스 전액 취소 → 재조회로 전액 취소 확인 후 반영", () => {
  const fn = service.slice(service.indexOf("export async function refundTrialFeeByAdmin"));
  const order = ["getVerifiedTossPayment(row.paymentKey", "INSERT INTO \"ApplicationContactLog\"", "/cancel`", "const after = await getVerifiedTossPayment"];
  let last = -1;
  for (const marker of order) {
    const at = fn.indexOf(marker);
    assert.ok(at > last, `${marker} 순서`);
    last = at;
  }
  assert.doesNotMatch(fn, /cancelAmount/, "전액 취소(부분 취소 없음)");
  assert.match(fn, /VA_METHOD/, "입금 끝난 무통장입금은 환불 계좌가 필요해 막는다(청구 환불과 같음)");
  const action = read("src/app/actions/trial-fee.ts");
  assert.match(action.slice(action.indexOf("export async function refundTrialFee")), /await requireFinanceOwner\(\)/, "원장만");
});

test("[마이그레이션] 신청당 결제 완료 1건·입금 대기 1건(DB 방어선), RLS, 금액 범위, 안내 스위치·규칙 기본 꺼짐", () => {
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "TrialFeePayment_one_done_per_lead" ON "TrialFeePayment" \("trialLeadId"\) WHERE status = 'DONE'/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "TrialFeePayment_one_waiting_per_lead"[\s\S]*?WHERE status = 'WAITING_FOR_DEPOSIT'/);
  assert.match(migration, /ALTER TABLE "TrialFeePayment" ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /amount INTEGER NOT NULL CHECK \(amount BETWEEN 1000 AND 100000\)/);
  assert.equal(rules.MIN_TRIAL_FEE_AMOUNT, 1000);
  assert.equal(rules.MAX_TRIAL_FEE_AMOUNT, 100000);
  assert.match(migration, /"trialFeeAmount" INTEGER NOT NULL DEFAULT 10000/);
  assert.match(migration, /"trialGuideAutoSend" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(migration, /"enrollGuideAutoSend" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(migration, /"trialOnlinePaymentEnabled" BOOLEAN NOT NULL DEFAULT false/);
  assert.match(migration, /'TRIAL_PAID_GUIDE_PARENT', '[^']+', 'EXTERNAL', 'PARENT', false/);
  assert.match(migration, /'ENROLL_WELCOME_GUIDE_PARENT', '[^']+', 'EXTERNAL', 'PARENT', false/);
  assert.doesNotMatch(migration.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"), /\bDROP\b|TRUNCATE|DELETE FROM/, "되돌림 SQL 은 주석에만");
  // 상태 CHECK 와 코드의 상태 집합이 같다
  for (const status of ["READY", "WAITING_FOR_DEPOSIT", "DONE", "CANCELED", "EXPIRED", "FAILED", "NEEDS_REFUND"]) {
    assert.match(migration, new RegExp(`'${status}'`), status);
  }
});

test("[계약] 원장만 안내 설정과 문자 규칙을 함께 저장하고, 미리보기는 발송하지 않는다", () => {
  const action = read("src/app/actions/trial-fee.ts");
  const update = action.slice(action.indexOf("export async function updateTrialGuideAutomation"), action.indexOf("export type GuidePreviewSet"));
  assert.match(update, /await requireFinanceOwner\(\)/);
  assert.match(update, /\$transaction/);
  assert.match(update, /SET "trialGuideAutoSend" = \$1, "enrollGuideAutoSend" = \$2/);
  assert.match(update, /trigger: TRIAL_GUIDE_TRIGGER[\s\S]*isActive: input\.trial/);
  assert.match(update, /trigger: ENROLL_GUIDE_TRIGGER[\s\S]*isActive: input\.enroll/);
  const ui = read("src/app/admin/apply/TrialFeeGuideSettings.tsx");
  assert.doesNotMatch(ui, /sendTrialGuide|sendEnrollGuide|sendTrackedSms/);
  const sender = read("src/lib/trial-fee/guideSender.ts");
  assert.match(sender, /WHERE "trialLeadId" = l\.id AND status = 'DONE'/);
  assert.match(sender, /previewTrialGuide\(trialLeadId, \{ requirePaid: true \}\)/);
  for (const name of ["sendTrialGuideIfEnabled", "sendEnrollGuideIfEnabled"]) {
    const fn = sender.slice(sender.indexOf(`export async function ${name}`));
    assert.match(fn.slice(0, 340), /if \(!settings\.(trialGuideAutoSend|enrollGuideAutoSend)\) return \{ sent: false, reason: "OFF" \}/);
  }
});

test("[안내] 체험비 결제 확인은 결제 금액과 별도 일정 안내를 표시한다", () => {
  const body = guides.buildTrialGuideMessage({ childName: "홍길동", feeLabel: "10,000원", academyPhone: "07088245712" });
  assert.equal(guides.GUIDE_MESSAGE_PREFIX, vault.PARENT_MESSAGE_PREFIX);
  assert.equal(body, [
    "[스티즈농구교실] 홍길동 학생의 체험수업비 10,000원 결제가 확인되었습니다.",
    "체험 일시와 반은 확정되는 대로 별도 문자로 안내드리겠습니다. 일정 확정 문자를 받으신 뒤 방문해 주세요.",
    "문의 070-8824-5712",
  ].join("\n"));
});

test("[안내] 등록 완료 안내: 본사 유니폼 주문 링크, 수업과 담당 코치, 셔틀 이용 정보", () => {
  const coaches = [{ name: "김영웅", title: "코치", phone: "01088242170" }];
  const drivers = [{ name: "김영중", title: "기사님", phone: "010-3207-2139" }];
  const withShuttle = guides.buildEnrollGuideMessage({ childName: "홍길동", classLabels: ["월 16:00~17:00 초등 A반"], coaches, drivers, usesShuttle: true });
  assert.match(withShuttle, /홍길동 학생의 정규 수업 등록이 완료되었습니다/);
  assert.match(withShuttle, /담당 코치 김영웅 코치 010-8824-2170/);
  assert.match(withShuttle, /셔틀 김영중 기사님 010-3207-2139/);
  assert.match(withShuttle, /수업 월 16:00~17:00 초등 A반/);
  assert.match(withShuttle, /https:\/\/stiz\.kr\/product\/detail\.html\?product_no=4095&from=dasan/);
  assert.match(withShuttle, /https:\/\/www\.stiz-dasan\.kr\/mypage/);
  assert.match(withShuttle, /https:\/\/www\.stiz-dasan\.kr\/annual/);
  assert.doesNotMatch(withShuttle, /랠리즈|카카오채널|www\.stiz-dasan\.kr\/apply/);
  assert.match(withShuttle, /070-8824-5712/);
  assert.doesNotMatch(withShuttle, /[\u{1F300}-\u{1FAFF}]/u, "문자(LMS)에서 깨지는 이모지 금지");
  const noShuttle = guides.buildEnrollGuideMessage({ childName: "홍길동", classLabels: [], coaches: [], drivers, usesShuttle: false });
  assert.doesNotMatch(noShuttle, /셔틀/);
  assert.match(noShuttle, /담당 코치는 수업 첫날 안내드립니다/);
  const shuttleNoDriver = guides.buildEnrollGuideMessage({ childName: "홍길동", classLabels: [], coaches, drivers: [], usesShuttle: true });
  assert.match(shuttleNoDriver, /셔틀 배차 확정 후 안내드립니다/);
  assert.equal(guides.coachGuideTitle("원장"), "원장");
  assert.equal(guides.coachGuideTitle("Head Coach"), "코치");
  assert.equal(guides.formatContactLine({ name: "권혜미", title: "원장", phone: "" }), "권혜미 원장");
});

test("[안내] 새 학부모 문자 트리거는 «문자 전용 허용목록»에 이유와 함께 등록돼 있다", () => {
  assert.ok(vault.SMS_ONLY_PARENT_TRIGGERS[guides.TRIAL_GUIDE_TRIGGER]);
  assert.ok(vault.SMS_ONLY_PARENT_TRIGGERS[guides.ENROLL_GUIDE_TRIGGER]);
});

// ───────────────────────────── 5) 정확성 검수 권장(2026-11-10) ─────────────────────────────

test("[권장1] 기한 지나 EXPIRED 로 닫은 주문에 입금(DONE) 확인 → 확정 반영(이미 확정된 신청이면 NEEDS_REFUND)", async () => {
  const db = fakeDb({ payments: [{ status: "EXPIRED", paymentKey: "pk1" }] });
  assert.deepEqual(await ledger.finalizeTrialFeePaidInTx(db, paidInput()), { kind: "PAID" });
  assert.equal(db.state.payments[0].status, "DONE");
  assert.equal(db.state.lead.trialFeePaymentStatus, "PAID");
  const confirmed = fakeDb({ lead: { trialFeeConfirmed: true }, payments: [{ status: "EXPIRED", paymentKey: "pk1" }] });
  assert.deepEqual(await ledger.finalizeTrialFeePaidInTx(confirmed, paidInput()), { kind: "DUPLICATE" });
  assert.equal(confirmed.state.payments[0].status, "NEEDS_REFUND");
});

test("[권장1] 취소(CANCELED)로 닫은 주문에 토스 DONE → 조용히 넘기지 않고 CANCELED_ORDER(원장 알림·웹훅 미처리 기록)", async () => {
  const db = fakeDb({ payments: [{ status: "CANCELED", paymentKey: "pk1" }] });
  assert.deepEqual(await ledger.finalizeTrialFeePaidInTx(db, paidInput()), { kind: "CANCELED_ORDER" });
  assert.equal(db.state.lead.trialFeeConfirmed, false);
  const src = read("src/lib/trial-fee/trialFeePaymentService.ts");
  assert.match(src, /result\.kind === "CANCELED_ORDER"\) \{[\s\S]*?alertOwner\(/);
  assert.match(src, /if \(finalized\.kind === "CANCELED_ORDER"\) return finish\(false, "TRIAL_CANCELED_ORDER_PAID"\);/);
});

test("[권장2] 같은 신청의 다른 주문이 입금 대기·승인 중이면 토스 승인 전에 거부(«이미 진행 중인 결제가 있어요»)", async () => {
  const waiting = fakeDb({ payments: [{ id: "pay-1" }, { id: "pay-2", orderId: "TRIAL-xyz789", status: "WAITING_FOR_DEPOSIT", paymentKey: "pkV" }] });
  assert.deepEqual(await ledger.claimTrialFeeConfirmInTx(waiting, { paymentRowId: "pay-1", trialLeadId: "lead-1", paymentKey: "pk1", amount: 10000, nowMs: 1_800_000_000_000 }),
    { kind: "REJECT", reason: "OTHER_IN_PROGRESS" });
  assert.equal(waiting.state.payments[0].confirmStartedAt, null);
  assert.match(rules.TRIAL_CONFIRM_REJECT_MESSAGE.OTHER_IN_PROGRESS, /이미 진행 중인 결제가 있어요/);

  // 동시 승인: 두 탭이 서로 다른 주문으로 거의 동시에 → 먼저 잡은 쪽만 PROCEED
  const db = fakeDb({ payments: [{ id: "pay-1" }, { id: "pay-2", orderId: "TRIAL-xyz789" }] });
  const a = await ledger.claimTrialFeeConfirmInTx(db, { paymentRowId: "pay-1", trialLeadId: "lead-1", paymentKey: "pkA", amount: 10000, nowMs: 1_800_000_000_000 });
  const b = await ledger.claimTrialFeeConfirmInTx(db, { paymentRowId: "pay-2", trialLeadId: "lead-1", paymentKey: "pkB", amount: 10000, nowMs: 1_800_000_000_000 });
  assert.deepEqual([a.kind, b.kind], ["PROCEED", "REJECT"]);
  assert.equal(b.reason, "OTHER_IN_PROGRESS");
  assert.equal(db.state.payments[1].confirmStartedAt, null, "두 번째 주문은 승인 표시도 안 남는다");
});

test("[권장4] 같은 결제키 «다시 확인»은 기다리지 않고 재조회(RECHECK), 다른 결제키는 여전히 거부", async () => {
  const now = 1_800_000_000_000;
  const stored = { amount: 10000, status: "READY", paymentKey: "pk1", confirmStartedAtMs: now - 30_000 };
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored, request: { paymentKey: "pk1", amount: 10000 }, leadAlreadyPaid: false, nowMs: now }), { kind: "RECHECK" });
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored, request: { paymentKey: "pk2", amount: 10000 }, leadAlreadyPaid: false, nowMs: now }), { kind: "REJECT", reason: "IN_PROGRESS" });
  assert.deepEqual(rules.decideTrialFeeConfirm({ stored, request: { paymentKey: "pk1", amount: 999 }, leadAlreadyPaid: false, nowMs: now }), { kind: "REJECT", reason: "AMOUNT_MISMATCH" }, "재조회도 금액 대조가 먼저");
  // 실행부: RECHECK 면 승인 API 보다 재조회가 먼저, 결과가 맞으면 승인을 다시 부르지 않는다
  const src = read("src/lib/trial-fee/trialFeePaymentService.ts");
  const fn = src.slice(src.indexOf("export async function confirmTrialFeeOnlinePayment"), src.indexOf("// ───────────────────────────── ④ 웹훅"));
  assert.ok(fn.indexOf('decision.kind === "RECHECK"') < fn.indexOf("/v1/payments/confirm"));
  assert.match(fn, /const response = recheckedResult \? null : await fetch\(/);
  assert.match(fn, /"Idempotency-Key": makeUuidFromSeed\(`stiz-trial-confirm:\$\{row\.id\}:\$\{row\.orderId\}`\)/, "다시 승인해도 같은 멱등키(토스가 한 번만 처리)");
});

test("[권장3] 매일 가상계좌 점검 크론이 체험비 입금 대기(기한 지남)를 토스 재조회로 정리", () => {
  const route = read("src/app/api/cron/virtual-account-sweep/route.ts");
  assert.match(route, /sweepWaitingVirtualAccounts\(\)/, "기존 청구 점검 그대로");
  assert.match(route, /sweepTrialVirtualAccounts\(50, trialBudgetMs\)/);
  assert.match(route, /Math\.min\(10_000, 48_000 - \(Date\.now\(\) - startedAt\)\)/, "cron 60초 안에서 남은 시간만");
  const src = read("src/lib/trial-fee/trialFeePaymentService.ts");
  const fn = src.slice(src.indexOf("export async function sweepTrialVirtualAccounts"));
  assert.match(fn, /status = 'WAITING_FOR_DEPOSIT' AND "paymentKey" IS NOT NULL/);
  assert.match(fn, /virtualAccountViewOf\(row, nowMs\)\?\.expired !== false/, "기한 지난 계좌만");
  assert.match(fn, /decideVirtualAccountClose\(verified/);
  assert.match(fn, /step === "PAID"[\s\S]*?finalizePaid\(row, verified\)/);
  assert.match(fn, /step === "RELEASED"[\s\S]*?releaseTrialVirtualAccountInTx/);
  assert.match(fn, /\} catch \(error\) \{\s*result\.failed \+= 1;/, "건별 실패가 전체를 멈추지 않는다");
});
