import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 부상·질병 «기간 결석» 복귀 정산 2단계(2026-11-15 원장 결정) — 청구 발행 보류 실행 테스트.
//
// 여기서 보는 것: 이미 발행된 미납 청구를 «보류로 돌리기»(holdIssuedBillsForPeriod)와 그 미리보기.
//   · 청구·청구서가 취소 상태로, 청구 준비 초안이 «검토 전»으로 돌아가는가
//   · 결제 진행 중·현장 결제 요청 중·이월을 쓴 청구 등은 건너뛰는가
//   · 원장이 본 목록과 다르면 실행하지 않는가 / 잠금 순서 / 승인 기록(approval)을 지우지 않는가
// 청구 준비가 보류 학생의 발행을 막는지는 tests/billing-workbench.test.mjs 에 있다(그쪽 가짜 DB 를 쓴다).
//
// 가짜 DB 는 들어온 SQL 의 조건 문구를 읽어 그 조건이 있을 때만 걸러 준다 — 코드에서 조건이 빠지면 테스트가 깨진다.
// 모르는 조회·쓰기는 오류로 던진다.

const rules = await loadTsModule("src/lib/regular/illnessPeriodRules.ts");
const admin = await loadTsModule("src/lib/regular/illness-period-admin.ts");
const read = (path) => readFileSync(path, "utf8");

const NOW = Date.parse("2026-11-15T03:00:00.000Z");
const ILLNESS = "ILLNESS_INJURY";

function fakeDb(init = {}) {
  const state = {
    periods: [],       // { id, studentId, reason, status, carryState, startDate, classIds, carrySettlement }
    payments: [],      // { id, studentId, classId, type, status, year, month, amount, mirror }
    invoices: [],      // { id, paymentId, status }
    transactions: [],  // { id, paymentId, status, updatedAt, approvedPending }
    posBusy: [],       // 현장 결제 요청 중인 청구 id
    drafts: [],        // { id, month, paymentId, status, version, payload }
    usages: [],        // { draftId, month, paymentId }
    carryCredits: [],  // { sourcePaymentId }
    pauseLines: [],    // { paymentId, kind }
    revisions: [],
    paymentAudit: [],
    audit: [],
    missingTables: [], // 아직 없는 표 이름
    locks: [],         // 잠금이 걸린 순서
    ...init,
  };
  const db = { state, calls: [] };
  const className = (id) => ({ mon: "월요반", fri: "금요반" })[id] ?? id;

  /** 보류 대상 범위 — SQL 에 그 조건 문구가 있을 때만 거른다 */
  const inScope = (sql, v) => {
    assert.match(sql, /p\."studentId" = \$1 AND COALESCE\(p\.type, 'MONTHLY'\) = 'MONTHLY' AND p\.status IN \('PENDING','OVERDUE'\)/);
    assert.match(sql, /\(p\.year \* 100 \+ p\.month\) >= \$2/, "수강월 ≥ 기간 시작 달");
    assert.match(sql, /\(cardinality\(\$3::text\[\]\) = 0 OR p\."classId" = ANY\(\$3::text\[\]\)\)/, "기간 대상 반(빈 배열 = 전부)");
    const skipMirror = /mirror_log\.action = /.test(sql);
    return state.payments.filter((p) => p.studentId === v[0] && (p.type ?? "MONTHLY") === "MONTHLY" && ["PENDING", "OVERDUE"].includes(p.status)
      && p.year * 100 + p.month >= v[1] && (v[2].length === 0 || v[2].includes(p.classId)) && !(skipMirror && p.mirror));
  };

  db.$queryRawUnsafe = async (sql, ...v) => {
    db.calls.push(sql);
    if (/information_schema\.columns/.test(sql)) return [{ n: 6 }];
    if (/to_regclass\(\$1\)/.test(sql)) return [{ found: state.missingTables.some((name) => v[0] === `public."${name}"`) ? null : "present" }];
    // 검토·증빙 표 확인(승인 취소가 묻는다) — 이 테스트에서는 없는 것으로 둔다(검토 처리는 illness-period.test.mjs 가 본다)
    if (/to_regclass/.test(sql)) return [{ review: null, evidence: null, found: null }];
    if (/FROM "RegularAbsencePeriod" p WHERE p\.id = \$1/.test(sql)) {
      if (/FOR UPDATE OF p/.test(sql)) state.locks.push("PERIOD");
      assert.match(sql, /p\."classIds" AS "classIds"/);
      return state.periods.filter((p) => p.id === v[0]).map((p) => ({
        id: p.id, studentId: p.studentId, reason: p.reason, status: p.status, carryState: p.carryState,
        startDate: p.startDate, returnDate: p.returnDate ?? null, note: null, parentReported: false,
        carrySettlement: p.carrySettlement ?? null, classIds: p.classIds ?? [],
      }));
    }
    // ① 대상 청구 id(잠금 없이)
    if (/^SELECT p\.id FROM "Payment" p WHERE /.test(sql)) {
      assert.doesNotMatch(sql, /FOR UPDATE/);
      state.locks.push("SCOPE_IDS");
      return inScope(sql, v).map((p) => p.id).sort().map((id) => ({ id }));
    }
    // ③ 대상 청구 행 + 건너뛸 이유 재료
    if (/^SELECT p\.id, p\.year, p\.month, p\.amount, p\.status/.test(sql)) {
      const locked = v.length === 4;
      assert.equal(/FOR UPDATE OF p/.test(sql), locked, "실행 때만 행 잠금");
      assert.equal(/AND p\.id = ANY\(\$4::text\[\]\)/.test(sql), locked);
      if (locked) state.locks.push("ROWS_FOR_UPDATE");
      const pos = /"PosChargeRequestItem" pi WHERE pi\."paymentId" = p\.id AND pi\."open"/.test(sql) && /pr\.status IN \('PENDING','SENT'\)/.test(sql);
      const paidTx = /t\.status = 'DONE' OR \(t\.status = 'IN_PROGRESS' AND t\."rawResponse"->>'status' = 'DONE'\)/.test(sql);
      const carryUsed = /FROM "BillingCarryUsage" u\s+WHERE u\."paymentId" = p\.id\s+OR EXISTS \(SELECT 1 FROM "BillingWorkbenchDraft" d WHERE d\."paymentId" = p\.id AND d\.id = u\."draftId" AND d\.month = u\.month\)/.test(sql);
      const carrySource = /source_credit\.basis->>'sourcePaymentId' = p\.id/.test(sql);
      const pause = /l\."paymentId" = p\.id AND l\.kind IN \('UNPAID_REDUCE','CARRY_APPLY'\)/.test(sql);
      return inScope(sql, v).filter((p) => !locked || v[3].includes(p.id))
        .sort((a, b) => a.year - b.year || a.month - b.month || a.id.localeCompare(b.id))
        .map((p) => {
          const invoice = state.invoices.find((i) => i.paymentId === p.id);
          const draft = state.drafts.find((d) => d.paymentId === p.id);
          return {
            id: p.id, year: p.year, month: p.month, amount: p.amount, status: p.status, classId: p.classId, className: className(p.classId),
            invoiceId: invoice?.id ?? null, invoiceStatus: invoice?.status ?? null,
            posBusy: pos && state.posBusy.includes(p.id),
            paidTx: paidTx && state.transactions.some((t) => t.paymentId === p.id && (t.status === "DONE" || t.approvedPending)),
            carryUsed: carryUsed && state.usages.some((u) => u.paymentId === p.id || (draft && u.draftId === draft.id && u.month === draft.month)),
            carrySource: carrySource && state.carryCredits.some((c) => c.sourcePaymentId === p.id),
            pauseSettled: pause && state.pauseLines.some((l) => l.paymentId === p.id && ["UNPAID_REDUCE", "CARRY_APPLY"].includes(l.kind)),
          };
        });
    }
    // 학부모 결제 진행 중 판정 재료(기존 함수 findParentCheckoutActivePaymentIds)
    if (/FROM "PaymentTransaction" t\s+JOIN LATERAL/.test(sql)) {
      return state.transactions.filter((t) => v[0].includes(t.paymentId) && ["READY", "IN_PROGRESS", "WAITING_FOR_DEPOSIT"].includes(t.status))
        .map((t) => ({ paymentId: t.paymentId, status: t.status, updatedAt: t.updatedAt, issue: null }));
    }
    if (/SELECT id, status FROM "PaymentInvoice" WHERE "paymentId" = \$1 FOR UPDATE/.test(sql)) {
      return state.invoices.filter((i) => i.paymentId === v[0]).map((i) => ({ id: i.id, status: i.status }));
    }
    if (/FROM "BillingWorkbenchDraft" WHERE "paymentId" = \$1 FOR UPDATE/.test(sql)) {
      return state.drafts.filter((d) => d.paymentId === v[0]).map((d) => ({ id: d.id, month: d.month, version: d.version, payload: d.payload, reason: "발행" }));
    }
    if (/SELECT s\.name FROM "Student" s WHERE s\.id = \$1 AND /.test(sql)) return [{ name: " 윤수영 " }];
    throw new Error(`모르는 조회: ${sql}`);
  };

  db.$executeRawUnsafe = async (sql, ...v) => {
    db.calls.push(sql);
    if (/pg_advisory_xact_lock\(hashtext\('STIZ_BILLING_WORKBENCH'\)\)/.test(sql)) { state.locks.push("GLOBAL"); return 1; }
    if (/pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)/.test(sql)) { state.locks.push(`CHECKOUT:${v[0]}`); return 1; }
    if (/^UPDATE "Payment" SET status = 'CANCELED', "paidDate" = NULL/.test(sql)) {
      assert.match(sql, /WHERE id = \$1 AND status IN \('PENDING', 'OVERDUE'\)/);
      const payment = state.payments.find((p) => p.id === v[0] && ["PENDING", "OVERDUE"].includes(p.status));
      if (!payment) return 0;
      payment.status = "CANCELED"; return 1;
    }
    if (/^UPDATE "PaymentInvoice" SET status = 'CANCELED', "canceledAt" = NOW\(\)/.test(sql)) {
      assert.match(sql, /WHERE id = \$1 AND "paymentId" = \$2 AND status IN \('ISSUED', 'SENT', 'OVERDUE'\)/);
      const invoice = state.invoices.find((i) => i.id === v[0] && i.paymentId === v[1] && ["ISSUED", "SENT", "OVERDUE"].includes(i.status));
      if (!invoice || state.failInvoiceUpdate === invoice.id) return 0;
      invoice.status = "CANCELED"; return 1;
    }
    if (/^INSERT INTO "PaymentAuditLog"/.test(sql)) {
      assert.match(sql, /'ADMIN', \$3, 'ILLNESS_PERIOD_BILL_HELD'/);
      state.paymentAudit.push({ paymentId: v[0], invoiceId: v[1], actorId: v[2], message: v[3], metadata: JSON.parse(v[4]) });
      return 1;
    }
    if (/^UPDATE "BillingWorkbenchDraft" SET status = 'DRAFT', "paymentId" = NULL, version = \$4/.test(sql)) {
      assert.match(sql, /WHERE id = \$1 AND month = \$2 AND "paymentId" = \$3 AND status = 'ISSUED'/);
      const draft = state.drafts.find((d) => d.id === v[0] && d.month === v[1] && d.paymentId === v[2] && d.status === "ISSUED");
      if (!draft) return 0;
      draft.status = "DRAFT"; draft.paymentId = null; draft.version = v[3]; return 1;
    }
    if (/^INSERT INTO "BillingWorkbenchRevision"/.test(sql)) {
      assert.match(sql, /\$3, 'HOLD', \$4::jsonb/);
      state.revisions.push({ draftId: v[0], month: v[1], version: v[2], action: "HOLD", payload: JSON.parse(v[3]), reason: v[4], actorId: v[5] });
      return 1;
    }
    if (/^UPDATE "RegularAbsencePeriod"\s+SET "carrySettlement" = COALESCE\("carrySettlement", '\{\}'::jsonb\) \|\| \$2::jsonb/.test(sql)) {
      assert.match(sql, /WHERE id = \$1 AND "carryState" = 'APPROVED'/);
      const period = state.periods.find((p) => p.id === v[0] && p.carryState === "APPROVED");
      if (!period) return 0;
      // jsonb || : 같은 키는 오른쪽 값으로 바뀌고 다른 키는 남는다
      period.carrySettlement = { ...(period.carrySettlement ?? {}), ...JSON.parse(v[1]) }; return 1;
    }
    // 승인 취소
    if (/^UPDATE "RegularAbsencePeriod"\s+SET "carryState" = 'NONE'/.test(sql)) {
      const period = state.periods.find((p) => p.id === v[0] && p.carryState === "APPROVED");
      if (!period) return 0;
      period.carryState = "NONE"; period.carrySettlement = null; return 1;
    }
    // 승인 취소의 보강권 되돌림 — 이 테스트에는 보강권이 없다(되돌림 자체는 illness-period.test.mjs 가 본다)
    if (/^UPDATE "MakeupCredit" mc\s+SET status = CASE WHEN mc\."expiresAt" < now\(\)/.test(sql)) return 0;
    if (/^INSERT INTO "OperationsAuditLog"/.test(sql)) { state.audit.push({ action: v[0], actorId: v[1], details: JSON.parse(v[2]) }); return 1; }
    throw new Error(`모르는 쓰기: ${sql}`);
  };

  // 실패하면 전부 되돌린다(실제 트랜잭션과 같게)
  db.$transaction = async (work, options) => {
    db.txOptions = options;
    const before = structuredClone(state);
    try { return await work(db); } catch (error) { for (const key of Object.keys(state)) state[key] = before[key]; throw error; }
  };
  return db;
}

/** 윤수영 사례: 11/6 부터 부상 결석(승인됨). 11월 2건은 납부 완료, 12월 2건(105,000·90,000)은 발행됐고 미납 */
function yoonCase(overrides = {}) {
  const db = fakeDb({
    periods: [{ id: "p1", studentId: "s1", reason: ILLNESS, status: "ACTIVE", carryState: "APPROVED", startDate: "2026-11-06", classIds: [],
      carrySettlement: { approval: { revokedCreditIds: ["c1"], createdReviewAbsenceIds: ["a1", "a2"] } } }],
    payments: [
      { id: "pay-nov-mon", studentId: "s1", classId: "mon", status: "PAID", year: 2026, month: 11, amount: 105000 },
      { id: "pay-nov-fri", studentId: "s1", classId: "fri", status: "PAID", year: 2026, month: 11, amount: 90000 },
      { id: "pay-dec-mon", studentId: "s1", classId: "mon", status: "PENDING", year: 2026, month: 12, amount: 105000 },
      { id: "pay-dec-fri", studentId: "s1", classId: "fri", status: "PENDING", year: 2026, month: 12, amount: 90000 },
      // 대상이 아닌 것들: 기간 시작 전 달의 미납 · 유니폼 청구 · 다른 학생 · 랠리즈 사본
      { id: "pay-oct-mon", studentId: "s1", classId: "mon", status: "OVERDUE", year: 2026, month: 10, amount: 105000 },
      { id: "pay-uniform", studentId: "s1", classId: null, type: "UNIFORM", status: "PENDING", year: 2026, month: 12, amount: 50000 },
      { id: "pay-other", studentId: "s2", classId: "mon", status: "PENDING", year: 2026, month: 12, amount: 105000 },
      { id: "pay-mirror", studentId: "s1", classId: "mon", status: "PENDING", year: 2026, month: 12, amount: 105000, mirror: true },
    ],
    drafts: [
      { id: "s1:mon", month: "2026-12", paymentId: "pay-dec-mon", status: "ISSUED", version: 3, payload: { baseAmount: 105000, discountAmount: 0, prorationAmount: 0, carryAmount: 0, shuttleAmount: 0 } },
      { id: "s1:fri", month: "2026-12", paymentId: "pay-dec-fri", status: "ISSUED", version: 3, payload: { baseAmount: 90000, discountAmount: 0, prorationAmount: 0, carryAmount: 0, shuttleAmount: 0 } },
    ],
    ...overrides,
  });
  db.state.invoices = db.state.payments.map((p) => ({ id: `inv-${p.id}`, paymentId: p.id, status: p.status === "PAID" ? "PAID" : "ISSUED" }));
  return db;
}
const DEC = ["pay-dec-fri", "pay-dec-mon"];

test("미리보기: 이미 발행된 미납 청구 2건(105,000·90,000)만 대상 — 납부 완료·기간 전 달·다른 종류·다른 학생·랠리즈 사본은 빠진다", async () => {
  const db = yoonCase();
  const hold = await admin.readIllnessPeriodBillingHold(db, "p1", NOW);
  assert.equal(hold.holdActive, true);
  assert.deepEqual(hold.bills.map((bill) => [bill.paymentId, bill.month, bill.className, bill.amount, bill.skip]), [
    ["pay-dec-fri", 12, "금요반", 90000, null],
    ["pay-dec-mon", 12, "월요반", 105000, null],
  ]);
  assert.deepEqual(hold.heldBills, []);
  // 읽기만 한다 — 잠금·쓰기 없음
  assert.deepEqual(db.state.locks, []);
  assert.ok(!db.calls.some((sql) => /^(UPDATE|INSERT|DELETE)|FOR UPDATE|pg_advisory/.test(sql)));
});

test("미리보기: 승인 전·정산 끝·등록 취소된 기간은 보류가 아니고 청구 목록도 없다 / 질병·부상이 아닌 기간·없는 기간은 null", async () => {
  for (const patch of [{ carryState: "NONE" }, { carryState: "SETTLED" }, { status: "CANCELLED" }]) {
    const db = yoonCase(); Object.assign(db.state.periods[0], patch);
    const hold = await admin.readIllnessPeriodBillingHold(db, "p1", NOW);
    assert.equal(hold.holdActive, false, JSON.stringify(patch));
    assert.deepEqual(hold.bills, []);
  }
  const db = yoonCase(); db.state.periods[0].reason = "PERSONAL";
  assert.equal(await admin.readIllnessPeriodBillingHold(db, "p1", NOW), null);
  assert.equal(await admin.readIllnessPeriodBillingHold(db, "없는기간", NOW), null);
  assert.equal(await admin.readIllnessPeriodBillingHold(db, "", NOW), null);
});

test("보류로 돌리기: 청구·청구서는 취소, 초안은 «검토 전»(paymentId 없음·버전 +1), 이력·감사 기록, 승인 기록은 그대로", async () => {
  const db = yoonCase();
  const done = await admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW);
  assert.deepEqual(done.held.map((bill) => [bill.paymentId, bill.amount, bill.month, bill.classId, bill.draftId]), [
    ["pay-dec-fri", 90000, 12, "fri", "s1:fri"],
    ["pay-dec-mon", 105000, 12, "mon", "s1:mon"],
  ]);
  assert.deepEqual(done.skipped, []);
  const status = (id) => db.state.payments.find((p) => p.id === id).status;
  assert.equal(status("pay-dec-mon"), "CANCELED");
  assert.equal(status("pay-dec-fri"), "CANCELED");
  assert.deepEqual(db.state.invoices.filter((i) => DEC.includes(i.paymentId)).map((i) => i.status), ["CANCELED", "CANCELED"]);
  // 대상이 아닌 청구는 그대로
  for (const [id, expected] of [["pay-nov-mon", "PAID"], ["pay-nov-fri", "PAID"], ["pay-oct-mon", "OVERDUE"], ["pay-uniform", "PENDING"], ["pay-other", "PENDING"], ["pay-mirror", "PENDING"]]) {
    assert.equal(status(id), expected, id);
  }
  // 초안: 금액(payload)은 남고 상태만 되돌아간다
  assert.deepEqual(db.state.drafts.map((d) => [d.id, d.status, d.paymentId, d.version, d.payload.baseAmount]), [
    ["s1:mon", "DRAFT", null, 4, 105000],
    ["s1:fri", "DRAFT", null, 4, 90000],
  ]);
  assert.deepEqual(db.state.revisions.map((r) => [r.draftId, r.month, r.version, r.action, r.payload.heldPaymentId, r.payload.periodId, r.reason, r.actorId]), [
    ["s1:fri", "2026-12", 4, "HOLD", "pay-dec-fri", "p1", "부상 결석 발행 보류", "owner-1"],
    ["s1:mon", "2026-12", 4, "HOLD", "pay-dec-mon", "p1", "부상 결석 발행 보류", "owner-1"],
  ]);
  assert.deepEqual(db.state.paymentAudit.map((a) => [a.paymentId, a.invoiceId, a.actorId, a.metadata.amount, a.metadata.periodId]), [
    ["pay-dec-fri", "inv-pay-dec-fri", "owner-1", 90000, "p1"],
    ["pay-dec-mon", "inv-pay-dec-mon", "owner-1", 105000, "p1"],
  ]);
  // 기간 행: 승인 때 남긴 되돌릴 재료(approval)가 그대로 있고, 돌린 목록(held)이 더해졌다
  const settlement = db.state.periods[0].carrySettlement;
  assert.deepEqual(settlement.approval, { revokedCreditIds: ["c1"], createdReviewAbsenceIds: ["a1", "a2"] });
  assert.deepEqual(settlement.held.map((bill) => bill.paymentId), DEC);
  assert.equal(settlement.held[0].heldAt, new Date(NOW).toISOString());
  assert.deepEqual(rules.parsePeriodApprovalRecord(settlement).revokedCreditIds, ["c1"]);
  assert.equal(rules.parseHeldBills(settlement).length, 2);
  assert.deepEqual(db.state.audit.map((a) => [a.action, a.actorId, a.details.held.length, a.details.skipped.length]), [["ILLNESS_PERIOD_BILLS_HELD", "owner-1", 2, 0]]);
  assert.equal(db.txOptions.isolationLevel, "Serializable");
  // 돌린 뒤 미리보기: 남은 미납 청구 없음, 돌린 2건이 보인다
  const after = await admin.readIllnessPeriodBillingHold(db, "p1", NOW);
  assert.deepEqual(after.bills, []);
  assert.equal(after.heldBills.length, 2);
});

test("잠금 순서: 작업대 전역 잠금 → 기간 행 → 대상 id(잠금 없이) → 결제 잠금(id 정렬순) → 청구 행 FOR UPDATE → 범위 재확인", async () => {
  const db = yoonCase();
  await admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW);
  assert.deepEqual(db.state.locks, [
    "GLOBAL", "PERIOD", "SCOPE_IDS",
    "CHECKOUT:stiz-payment-checkout:pay-dec-fri", "CHECKOUT:stiz-payment-checkout:pay-dec-mon",
    "ROWS_FOR_UPDATE", "SCOPE_IDS",
  ]);
  // 토스·현장 결제 코드는 부르지 않는다(결제 취소·환불 API 없음)
  const source = read("src/lib/regular/illness-period-admin.ts");
  assert.doesNotMatch(source, /cancelTossPayment|tossPayments|fetch\(|UPDATE "PosChargeRequest|UPDATE "PaymentTransaction|INSERT INTO "PaymentTransaction/);
});

test("건너뛰기: 학부모 결제 진행 중·현장 결제 요청 중·결제 거래 기록 있음 — 그 청구는 그대로 두고 이유를 돌려준다", async () => {
  const db = yoonCase();
  // 12월 월요반: 학부모가 5분 전에 결제창을 열었다
  db.state.transactions.push({ id: "t1", paymentId: "pay-dec-mon", status: "READY", updatedAt: new Date(NOW - 5 * 60_000).toISOString() });
  const preview = await admin.readIllnessPeriodBillingHold(db, "p1", NOW);
  assert.deepEqual(preview.bills.map((bill) => [bill.paymentId, bill.skip]), [["pay-dec-fri", null], ["pay-dec-mon", "CHECKOUT"]]);
  assert.equal(preview.bills[1].skipText, rules.HOLD_SKIP_REASONS.CHECKOUT);
  const done = await admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: ["pay-dec-fri"] }, "owner-1", NOW);
  assert.deepEqual(done.held.map((bill) => bill.paymentId), ["pay-dec-fri"]);
  assert.deepEqual(done.skipped.map((bill) => [bill.paymentId, bill.skip]), [["pay-dec-mon", "CHECKOUT"]]);
  assert.equal(db.state.payments.find((p) => p.id === "pay-dec-mon").status, "PENDING");
  assert.equal(db.state.drafts.find((d) => d.id === "s1:mon").status, "ISSUED");
  assert.equal(db.state.payments.find((p) => p.id === "pay-dec-fri").status, "CANCELED");

  // 결제창을 연 지 31분이 지났으면(만료) 막지 않는다
  const stale = yoonCase();
  stale.state.transactions.push({ id: "t1", paymentId: "pay-dec-mon", status: "READY", updatedAt: new Date(NOW - 31 * 60_000).toISOString() });
  assert.deepEqual((await admin.readIllnessPeriodBillingHold(stale, "p1", NOW)).bills.map((bill) => bill.skip), [null, null]);

  // 현장 결제 요청 중 / 완료된 결제 거래 / 승인됐는데 장부 반영 전인 거래
  const pos = yoonCase(); pos.state.posBusy.push("pay-dec-fri");
  assert.deepEqual((await admin.readIllnessPeriodBillingHold(pos, "p1", NOW)).bills.map((bill) => bill.skip), ["POS", null]);
  const paid = yoonCase(); paid.state.transactions.push({ id: "t2", paymentId: "pay-dec-fri", status: "DONE", updatedAt: new Date(NOW).toISOString() });
  assert.deepEqual((await admin.readIllnessPeriodBillingHold(paid, "p1", NOW)).bills.map((bill) => bill.skip), ["PAID_TX", null]);
  const pending = yoonCase(); pending.state.transactions.push({ id: "t3", paymentId: "pay-dec-fri", status: "IN_PROGRESS", approvedPending: true, updatedAt: new Date(NOW - 3 * 3600_000).toISOString() });
  assert.deepEqual((await admin.readIllnessPeriodBillingHold(pending, "p1", NOW)).bills.map((bill) => bill.skip), ["PAID_TX", null]);
});

test("건너뛰기: 이월을 쓴 청구·이월의 근거인 청구·휴원 정산이 반영된 청구·청구서 상태 이상은 돌리지 않는다(요청해도 거절)", async () => {
  const cases = [
    ["CARRY_USED", (db) => db.state.usages.push({ draftId: "s1:mon", month: "2026-12", paymentId: null })],
    ["CARRY_USED", (db) => db.state.usages.push({ draftId: "x", month: "2026-12", paymentId: "pay-dec-mon" })],
    ["CARRY_SOURCE", (db) => db.state.carryCredits.push({ sourcePaymentId: "pay-dec-mon" })],
    ["PAUSE_SETTLED", (db) => db.state.pauseLines.push({ paymentId: "pay-dec-mon", kind: "CARRY_APPLY" })],
    ["INVOICE", (db) => { db.state.invoices = db.state.invoices.filter((i) => i.paymentId !== "pay-dec-mon"); }],
    ["INVOICE", (db) => { db.state.invoices.find((i) => i.paymentId === "pay-dec-mon").status = "PAID"; }],
  ];
  for (const [code, arrange] of cases) {
    const db = yoonCase(); arrange(db);
    const preview = await admin.readIllnessPeriodBillingHold(db, "p1", NOW);
    assert.deepEqual(preview.bills.map((bill) => [bill.paymentId, bill.skip]), [["pay-dec-fri", null], ["pay-dec-mon", code]], code);
    // 건너뛸 청구까지 넣어 요청하면 실행하지 않는다 — 아무것도 바뀌지 않는다
    const before = JSON.stringify(db.state.payments);
    await assert.rejects(() => admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW), /대상 청구가 바뀌었습니다/);
    assert.equal(JSON.stringify(db.state.payments), before);
    assert.equal(db.state.revisions.length, 0);
  }
  // 휴원 정산의 «환불» 줄(REFUND)처럼 청구 금액을 줄이지 않은 줄은 막지 않는다
  const refundOnly = yoonCase(); refundOnly.state.pauseLines.push({ paymentId: "pay-dec-mon", kind: "REFUND" });
  assert.deepEqual((await admin.readIllnessPeriodBillingHold(refundOnly, "p1", NOW)).bills.map((bill) => bill.skip), [null, null]);
});

test("원장이 본 목록과 다르면 실행하지 않는다 — 그 사이 한 건이 납부됐거나 새 청구가 생긴 경우", async () => {
  // 화면을 본 뒤 금요반 청구가 납부됐다 → 대상이 1건으로 줄었다
  const paid = yoonCase();
  paid.state.payments.find((p) => p.id === "pay-dec-fri").status = "PAID";
  await assert.rejects(() => admin.holdIssuedBillsForPeriod(paid, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW), /대상 청구가 바뀌었습니다/);
  assert.equal(paid.state.payments.find((p) => p.id === "pay-dec-mon").status, "PENDING");
  // 화면을 본 뒤 1월 청구가 새로 발행됐다 → 본 적 없는 청구는 취소하지 않는다
  const added = yoonCase();
  added.state.payments.push({ id: "pay-jan-mon", studentId: "s1", classId: "mon", status: "PENDING", year: 2027, month: 1, amount: 105000 });
  added.state.invoices.push({ id: "inv-pay-jan-mon", paymentId: "pay-jan-mon", status: "ISSUED" });
  await assert.rejects(() => admin.holdIssuedBillsForPeriod(added, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW), /대상 청구가 바뀌었습니다/);
  assert.ok(added.state.payments.every((p) => p.status !== "CANCELED"));
  // 다른 학생의 청구 id 를 섞어 보내도 그 청구는 대상 범위 밖이라 실행되지 않는다(IDOR)
  const foreign = yoonCase();
  await assert.rejects(() => admin.holdIssuedBillsForPeriod(foreign, { periodId: "p1", expectedPaymentIds: [...DEC, "pay-other"] }, "owner-1", NOW), /대상 청구가 바뀌었습니다/);
  await assert.rejects(() => admin.holdIssuedBillsForPeriod(foreign, { periodId: "p1", expectedPaymentIds: ["pay-other"] }, "owner-1", NOW), /대상 청구가 바뀌었습니다/);
  assert.equal(foreign.state.payments.find((p) => p.id === "pay-other").status, "PENDING");
});

test("거절: 승인되지 않은 기간·정산 끝난 기간·등록 취소된 기간·권한 없음·빈 목록 — 아무것도 바꾸지 않는다", async () => {
  for (const patch of [{ carryState: "NONE" }, { carryState: "SETTLED" }, { status: "CANCELLED" }, { reason: "PERSONAL" }]) {
    const db = yoonCase(); Object.assign(db.state.periods[0], patch);
    await assert.rejects(() => admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW), /발행 보류 중인 기간만/, JSON.stringify(patch));
    assert.ok(db.state.payments.every((p) => p.status !== "CANCELED"));
  }
  const db = yoonCase();
  await assert.rejects(() => admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: DEC }, "", NOW), /관리자 확인/);
  await assert.rejects(() => admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: [] }, "owner-1", NOW), /보류로 돌릴 청구가 없습니다/);
  await assert.rejects(() => admin.holdIssuedBillsForPeriod(db, { periodId: "없는기간", expectedPaymentIds: DEC }, "owner-1", NOW), /찾을 수 없습니다/);
  assert.equal(db.state.audit.length, 0);
});

test("도중에 한 건이라도 안 바뀌면 전부 되돌린다(일부만 취소되지 않는다)", async () => {
  const db = yoonCase({ failInvoiceUpdate: "inv-pay-dec-mon" });
  await assert.rejects(() => admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW), /청구 상태가 바뀌어 처리하지 않았습니다/);
  assert.deepEqual(db.state.payments.filter((p) => DEC.includes(p.id)).map((p) => p.status), ["PENDING", "PENDING"]);
  assert.deepEqual(db.state.drafts.map((d) => d.status), ["ISSUED", "ISSUED"]);
  assert.equal(db.state.paymentAudit.length, 0);
  assert.equal(db.state.periods[0].carrySettlement.held, undefined);
});

test("기간 대상 반이 정해져 있으면 그 반 청구만 / 청구 준비 초안이 없는 청구(직접 발행)도 취소만 한다 / 두 번째 실행은 목록 뒤에 잇는다", async () => {
  const onlyMon = yoonCase(); onlyMon.state.periods[0].classIds = ["mon"];
  assert.deepEqual((await admin.readIllnessPeriodBillingHold(onlyMon, "p1", NOW)).bills.map((bill) => bill.paymentId), ["pay-dec-mon"]);

  const db = yoonCase();
  db.state.drafts = db.state.drafts.filter((d) => d.id !== "s1:fri"); // 금요반은 직접 발행한 청구
  const first = await admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: ["pay-dec-fri"] }, "owner-1", NOW)
    .catch((error) => error);
  // 본 목록(1건)과 실제 대상(2건)이 달라 거절 — 두 건을 다 넣어야 한다
  assert.match(String(first.message), /대상 청구가 바뀌었습니다/);
  const done = await admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW);
  assert.deepEqual(done.held.map((bill) => [bill.paymentId, bill.draftId]), [["pay-dec-fri", null], ["pay-dec-mon", "s1:mon"]]);
  assert.equal(db.state.revisions.length, 1);
  // 표가 아직 없는 DB — 초안 되돌림 없이 청구만 취소한다
  const noDraftTable = yoonCase({ missingTables: ["BillingWorkbenchDraft"] });
  const plain = await admin.holdIssuedBillsForPeriod(noDraftTable, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW);
  assert.deepEqual(plain.held.map((bill) => bill.draftId), [null, null]);

  // 그 뒤 1월 청구가 발행됐다 → 다시 돌리면 앞의 2건 뒤에 이어 3건이 남는다
  db.state.payments.push({ id: "pay-jan-mon", studentId: "s1", classId: "mon", status: "PENDING", year: 2027, month: 1, amount: 105000 });
  db.state.invoices.push({ id: "inv-pay-jan-mon", paymentId: "pay-jan-mon", status: "ISSUED" });
  await admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: ["pay-jan-mon"] }, "owner-1", NOW + 1000);
  assert.deepEqual(db.state.periods[0].carrySettlement.held.map((bill) => bill.paymentId), ["pay-dec-fri", "pay-dec-mon", "pay-jan-mon"]);
  assert.deepEqual(db.state.periods[0].carrySettlement.approval.revokedCreditIds, ["c1"]);
});

test("승인 취소: 보류로 돌린 청구는 되살리지 않고 건수를 돌려준다 — 감사 기록에 청구 id 가 남는다", async () => {
  const db = yoonCase();
  await admin.holdIssuedBillsForPeriod(db, { periodId: "p1", expectedPaymentIds: DEC }, "owner-1", NOW);
  const done = await admin.cancelIllnessPeriodApproval(db, { periodId: "p1" }, "owner-1");
  assert.equal(done.heldBills, 2);
  assert.equal(db.state.periods[0].carryState, "NONE");
  // 취소된 청구는 취소된 채, 초안은 «검토 전»인 채 — 청구 준비에서 다시 저장·확정·발행한다
  assert.deepEqual(db.state.payments.filter((p) => DEC.includes(p.id)).map((p) => p.status), ["CANCELED", "CANCELED"]);
  assert.deepEqual(db.state.drafts.map((d) => [d.status, d.paymentId]), [["DRAFT", null], ["DRAFT", null]]);
  const audit = db.state.audit.find((a) => a.action === "ILLNESS_PERIOD_APPROVAL_CANCELED");
  assert.deepEqual(audit.details.heldPaymentIds, DEC);
  // 승인이 풀리면 보류도 풀린다
  assert.equal((await admin.readIllnessPeriodBillingHold(db, "p1", NOW)).holdActive, false);
});

test("알림 본문에 넣을 아이 이름: 앞뒤 공백을 떼고, 병합된 학생 행은 읽지 않는다", async () => {
  const db = yoonCase();
  assert.equal(await admin.readStudentName(db, "s1"), "윤수영");
  assert.match(db.calls.at(-1), /"mergedIntoStudentId" IS NULL/);
});

test("규칙: 보류 판정 조각·글자·기록 꺼내기", () => {
  assert.equal(rules.BILLING_HOLD_LABEL, "부상 결석 중 · 발행 보류");
  assert.equal(rules.BILLING_HOLD_STUDENT_LABEL, "부상 결석 중 · 청구 보류");
  assert.equal(rules.billingHoldParentText("윤수영"), "윤수영 · 부상 결석 중이라 수강료 청구를 잠시 멈췄어요. 복귀하면 빠진 수업을 뺀 금액으로 다시 안내해요.");
  assert.doesNotMatch(rules.billingHoldParentText("윤수영"), /문의/);
  assert.equal(rules.illnessBillingHoldSql("s", false), "false");
  assert.deepEqual(rules.parseHeldBills(null), []);
  assert.deepEqual(rules.parseHeldBills({ approval: {} }), []);
  assert.deepEqual(rules.parseHeldBills(JSON.stringify({ held: [{ paymentId: "p", amount: 1000 }, { paymentId: 3 }, null, { paymentId: "q", amount: 1.5 }] })).map((bill) => bill.paymentId), ["p"]);
  // 건너뛰는 이유는 전부 글자가 있다
  for (const text of Object.values(rules.HOLD_SKIP_REASONS)) assert.ok(text.length > 10);
});

test("연결: 현장 결제 요청 조건은 휴원 정산과 같은 글자 / 서버 액션은 원장만 실행·금액은 원장에게만 / 알림은 앱 안 1회(아이 이름 포함)", () => {
  const lib = read("src/lib/regular/illness-period-admin.ts");
  const pause = read("src/lib/enrollment/pause-settlement.ts");
  const posSql = pause.slice(pause.indexOf("const POS_BUSY_P = `") + "const POS_BUSY_P = `".length, pause.indexOf("`;", pause.indexOf("const POS_BUSY_P = `")));
  assert.equal(admin.HOLD_POS_BUSY_SQL, posSql, "휴원 정산의 POS_BUSY_P 와 같은 조건");
  assert.match(lib, /COALESCE\("carrySettlement", '\{\}'::jsonb\) \|\| \$2::jsonb/, "병합 저장 — approval 키를 지우지 않는다");

  const action = read("src/app/actions/illness-period-admin.ts");
  const hold = action.slice(action.indexOf("export async function holdIllnessPeriodBillsAction("));
  // 원장 확인이 맨 먼저(부원장 거절) — DB 를 건드리기 전
  assert.match(hold, /^export async function holdIllnessPeriodBillsAction\([^\n]*\{\n(\s*\/\/[^\n]*\n)*\s+let owner[^\n]*\n\s+try \{ owner = await requireOwner\(\); \} catch \{ return \{ ok: false, message: "발행 보류로 돌리기는 원장만 할 수 있습니다\." \}; \}/);
  assert.ok(hold.indexOf("requireOwner()") < hold.indexOf("holdIssuedBillsForPeriod("));
  assert.match(hold, /notifyParentOnce\(done\.studentId, "수강료 청구 안내", billingHoldParentText\(name\), "\/mypage\/payments"\)/);
  assert.doesNotMatch(action, /sendTrackedSms|alimtalk|sendSms/i, "문자·알림톡을 만들지 않는다");
  // 미리보기: 금액은 서버 응답에서 뺀다(부원장)
  assert.match(action, /const owner = canSeeAllMoney\(admin\.appUserRole\);/);
  assert.match(action, /amount: owner \? bill\.amount : null,/);
  assert.match(action, /canHold: owner,/);
  // 승인·보강권 전환 알림 본문에 아이 이름
  assert.match(action, /`\$\{await childPrefix\(done\.studentId\)\}\$\{periodRangeText\(done\.startDate, done\.returnDate\)\} 결석을 부상 결석으로 인정했어요\./);
  assert.match(action, /`\$\{await childPrefix\(done\.studentId\)\}\$\{periodRangeText\(done\.startDate, done\.returnDate\)\} 결석 \$\{done\.converted\}회는 보강권으로 처리했어요\./);
  assert.match(action, /보류로 돌린 청구 \$\{done\.heldBills\}건은 청구 준비에서 다시 발행해야 합니다\./);
});

test("화면: 신청함 상세의 보류 칸(원장만 버튼·확인 창)·학생 상세 한 줄·학부모 결제 화면 한 줄 — 아이콘 없이 글자, 색은 토큰", () => {
  const detail = read("src/app/admin/inbox/IllnessPeriodInboxDetail.tsx");
  assert.match(detail, /\{hold\?\.holdActive && \(/);
  assert.match(detail, /이미 발행된 미납 청구 \{hold\.bills\.length\}건/);
  assert.match(detail, /hold\.canHold \? \(\s+holdTargets\.length > 0 && \(/, "버튼은 원장에게만");
  assert.match(detail, /className="academy-button-secondary">발행 보류로 돌리기<\/button>/);
  assert.match(detail, /confirmLabel: "발행 보류로 돌리기",\s+tone: "danger"/, "확인 창을 거친다");
  assert.match(detail, /expectedPaymentIds: holdTargets\.map\(\(bill\) => bill\.paymentId\)/, "본 목록을 서버에 함께 보낸다");
  assert.match(detail, /const holdTargets = \(hold\?\.bills \?\? \[\]\)\.filter\(\(bill\) => !bill\.skipText\);/);
  assert.match(detail, /보류로 돌린 청구 \$\{hold\.heldCount\}건은 청구 준비에서 다시 발행해야 합니다\./, "승인 취소 확인 창 글");
  assert.match(detail, /<li key=\{bill\.paymentId\} className="flex min-h-11 /, "한 줄 행 · 터치 44px");
  assert.doesNotMatch(detail, /material-symbols|UiIcon|font-(extrabold|black)|#[0-9a-fA-F]{3,6}\b|lucide/);

  const panel = read("src/app/admin/students/[id]/AbsencePeriodPanel.tsx");
  assert.match(panel, /\{p\.billingHold && \(/);
  assert.match(panel, /\{BILLING_HOLD_STUDENT_LABEL\}/);
  const service = read("src/lib/regular/absence-period-service.ts");
  assert.match(service, /const holdSql = \(await periodCarryColumnsReady\(db\)\) \? illnessHoldPeriodSql\("p"\) : `false`;/, "칸이 없으면 false");

  const parentQuery = read("src/lib/payments/parent-payment-request.ts");
  const holds = parentQuery.slice(parentQuery.indexOf("export async function getParentBillingHolds("), parentQuery.indexOf("export async function getParentPaymentRequests("));
  assert.match(holds, /WHERE \$\{await childAccessSql\("s", "\$1"\)\} AND \$\{notMergedStudent\("s"\)\}\s+AND \$\{illnessBillingHoldSql\("s", ready\)\}/, "본인 자녀만 · 판정 조각 한 곳");
  assert.match(holds, /if \(!ready\) return \[\];/);
  const parent = read("src/app/mypage/payments/PaymentRequestClient.tsx");
  assert.match(parent, /\{billingHoldParentText\(held\.studentName\)\}/);
  assert.match(parent, /shownHolds\.length === 0 && \(/, "보류 안내가 보이면 «청구서가 없어요»를 겹치지 않는다");
  assert.match(read("src/app/mypage/payments/page.tsx"), /const holds = await getParentBillingHolds\(parent\.appUserId\);/);
});

test("미납 안내·알림: 취소된 청구는 어느 경로에서도 대상이 아니다(보류로 돌린 청구 = 취소 상태)", () => {
  const actions = read("src/app/actions/admin.ts");
  // 청구 안내 대상: 취소·납부 청구서 제외 / 미납 안내 대상: 연체만
  assert.match(actions, /i\.status NOT IN \('PAID', ?'CANCELED'\)/);
  assert.match(actions, /p\.status = 'OVERDUE'/);
  // 예약된 청구 안내: 보내기 직전에 결제 상태를 다시 본다(취소 = 끝난 것)
  const queue = read("src/lib/billing/noticeQueue.ts");
  assert.match(queue, /export const BILLING_SETTLED_PAYMENT_STATUSES = \["PAID", "REFUNDED", "CANCELED"\] as const;/);
  assert.match(queue, /WHERE p\.id = ANY\(n\."paymentIds"\) AND p\.status NOT IN \(\$\{settled\}\)/);
  // 일일 요약: 미납·연체만 센다
  assert.match(read("src/lib/admin-daily-digest-service.ts"), /FROM "Payment"\s+WHERE status IN \('PENDING', 'OVERDUE'\)/);
  // 연체 전환 크론: 미납(PENDING)만 연체로 바꾼다
  assert.match(read("src/lib/payments/overdueRule.ts"), /SELECT id FROM "Payment" WHERE status = 'PENDING' AND /);
  // 현장 결제 알림 대조: 취소·환불 청구는 «살아 있는 청구»에서 뺀다
  const pos = read("src/lib/pos/payment-notice.mjs");
  assert.match(pos, /const CANCELED = new Set\(\["CANCELED", "CANCELLED", "REFUNDED"\]\);/);
  assert.match(pos, /\.filter\(\(r\) => !CANCELED\.has\(String\(r\.status\)\.toUpperCase\(\)\)\)/);
  // 학부모 결제 화면: 취소된 청구는 보이지 않는다
  assert.match(read("src/lib/payments/parent-payment-request.ts"), /AND p\.status <> 'CANCELED'/);
  // 카카오 대화·푸시 발송함은 청구 표를 직접 읽지 않는다(미납을 스스로 찾아 보내는 경로가 아니다)
  assert.doesNotMatch(read("src/lib/kakao-parent-chatbot.ts"), /FROM "Payment"/);
  assert.doesNotMatch(read("src/lib/push-outbox.ts"), /FROM "Payment"/);
});
