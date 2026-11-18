// «발행 뒤 바뀐 청구»(2026-11-17) — 판정 순수 함수 · 승인 실행(가짜 DB) · 발송 코드 없음 정적 검사
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const url = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString("base64")}`;
const kstUrl = url(await readFile("src/lib/datetime/kst.ts", "utf8"));
const periodRulesUrl = url((await readFile("src/lib/regular/illnessPeriodRules.ts", "utf8")).replace('from "@/lib/datetime/kst"', `from "${kstUrl}"`));
const rulesSource = await readFile("src/lib/billing/post-issue-rules.ts", "utf8");
const rulesUrl = url(rulesSource.replace('from "@/lib/datetime/kst"', `from "${kstUrl}"`).replace('from "@/lib/regular/illnessPeriodRules"', `from "${periodRulesUrl}"`));
const rules = await import(rulesUrl);
const { decideEndedBill, prorateWithdrawnBill, decideClassChange, sameProposal, sortPostIssueItems } = rules;

// 서비스: 무거운 모듈(결제 잠금·POS 조각)은 가짜로 바꿔 끼운다
const workbenchUrl = url((await readFile("src/lib/billing/workbench.ts", "utf8")).replace('from "@/lib/datetime/kst"', `from "${kstUrl}"`));
const visibilityUrl = url(await readFile("src/lib/studentVisibility.ts", "utf8"));
const guardUrl = url(await readFile("src/lib/billing/parentSendGuard.ts", "utf8"));
const prorationUrl = url(await readFile("src/lib/enrollment/proration.ts", "utf8"));
globalThis.__postIssueFake = { active: new Set(), locks: [] };
const bundleStub = url(`export const APPROVED_PENDING_SQL = "false";
export async function lockPaymentsForCheckout(db, ids) { globalThis.__postIssueFake.locks.push(...ids); }
export async function findParentCheckoutActivePaymentIds(db, ids) { return new Set(ids.filter((id) => globalThis.__postIssueFake.active.has(id))); }`);
const holdStub = url(`export const HOLD_POS_BUSY_SQL = "POS_BUSY_FRAGMENT";`);
const serviceSource = await readFile("src/lib/billing/post-issue-service.ts", "utf8");
const serviceUrl = url(serviceSource
  .replace('from "@/lib/studentVisibility"', `from "${visibilityUrl}"`)
  .replace('from "@/lib/billing/parentSendGuard"', `from "${guardUrl}"`)
  .replace('from "@/lib/payments/bundleLedger"', `from "${bundleStub}"`)
  .replace('from "@/lib/regular/illness-period-admin"', `from "${holdStub}"`)
  .replace('from "@/lib/enrollment/proration"', `from "${prorationUrl}"`)
  .replace('from "./workbench"', `from "${workbenchUrl}"`)
  .replace('from "./post-issue-rules"', `from "${rulesUrl}"`));
const service = await import(serviceUrl);

const payload = (over = {}) => ({ baseAmount: 120000, discountAmount: 0, prorationAmount: 0, carryAmount: 0, shuttleAmount: 0, ...over });
const bill = (over = {}) => ({
  paymentId: "pay-1", studentId: "stu-1", studentName: "김하나", classId: "cls-1", className: "토요 A", year: 2026, month: 12, amount: 120000, status: "PENDING",
  endKind: "WITHDRAW", endYmd: "2026-12-01", draft: { payload: payload(), scheduledDates: ["2026-12-05", "2026-12-12", "2026-12-19", "2026-12-26"] }, skip: null, ...over,
});

// ── 판정(순수 함수) ─────────────────────────────────────────────
test("청구월 시작 전(1일 포함)에 수강이 끝났으면 취소 제안 — 제안 금액 0", () => {
  for (const endYmd of ["2026-11-20", "2026-12-01"]) {
    const item = decideEndedBill(bill({ endYmd }));
    assert.equal(item.kind, "CANCEL");
    assert.equal(item.approvable, true);
    assert.equal(item.proposedAmount, 0);
    assert.equal(item.key, `P:pay-1:${endYmd}:CANCEL`);
  }
});
test("청구월이 끝난 뒤 그만뒀으면 어긋남이 아니다", () => {
  assert.equal(decideEndedBill(bill({ endYmd: "2027-01-01" })), null);
  assert.equal(decideEndedBill(bill({ endYmd: "2027-01-15" })), null);
});
test("월 중간 퇴원 = 발행 기록 수업일로 다닌 회차만큼 변경 제안(셔틀비 그대로)", () => {
  const item = decideEndedBill(bill({ endYmd: "2026-12-15", amount: 135000, draft: { payload: payload({ shuttleAmount: 15000 }), scheduledDates: ["2026-12-05", "2026-12-12", "2026-12-19", "2026-12-26"] } }));
  assert.equal(item.kind, "PRORATE");
  assert.equal(item.proposedAmount, 60000 + 15000); // 4회 중 2회 · 셔틀 15,000 유지
  assert.match(item.text, /4회 중 2회/);
  assert.match(item.text, /셔틀비 15,000원은 그대로/);
});
test("월 중간 퇴원이라도 마지막 수업 뒤면 null, 첫 수업 전이면 취소", () => {
  assert.equal(decideEndedBill(bill({ endYmd: "2026-12-27" })), null);
  assert.equal(decideEndedBill(bill({ endYmd: "2026-12-03" })).kind, "CANCEL");
});
test("일할 계산 근거가 없거나 의심스러우면 «확인 필요»(승인 불가)", () => {
  const cases = [
    bill({ endYmd: "2026-12-15", draft: null }), // 손으로 만든 청구
    bill({ endYmd: "2026-12-15", amount: 100000 }), // 발행 뒤 금액이 바뀜
    bill({ endYmd: "2026-12-15", draft: { payload: payload({ carryAmount: 10000 }), scheduledDates: ["2026-12-05", "2026-12-12"] }, amount: 110000 }), // 이월 차감
    bill({ endYmd: "2026-12-15", draft: { payload: payload(), scheduledDates: [] } }), // 수업일 사본 없음
  ];
  for (const input of cases) {
    const item = decideEndedBill(input);
    assert.equal(item.kind, "CHECK", JSON.stringify(input.draft));
    assert.equal(item.approvable, false);
    assert.equal(item.proposedAmount, null);
  }
});
test("결제 진행 중·POS 요청·이월 근거 등은 제안 내용을 보이되 «확인 필요»", () => {
  for (const skip of ["CHECKOUT", "POS", "PAID_TX", "CARRY_USED", "CARRY_SOURCE", "PAUSE_SETTLED", "ILLNESS_REDUCED", "INVOICE"]) {
    const item = decideEndedBill(bill({ skip }));
    assert.equal(item.kind, "CHECK");
    assert.equal(item.approvable, false);
    assert.match(item.text, /청구 취소 대상이지만/);
  }
});
test("이미 결제된 청구 = «결제됨 — 환불은 원장이 직접»(목록만), 예전 달은 안 보임", () => {
  const item = decideEndedBill(bill({ status: "PAID" }));
  assert.equal(item.kind, "PAID");
  assert.equal(item.approvable, false);
  assert.match(item.text, /환불은 원장이 직접/);
  assert.equal(decideEndedBill(bill({ status: "PAID", year: 2026, month: 10, endYmd: "2026-10-01" })), null);
});
test("반 변경이 청구월 중간이면 옛 반 청구는 건드리지 않는다(차액이 맡음), 다음 달 청구는 취소 제안", () => {
  assert.equal(decideEndedBill(bill({ endKind: "CLASS_CHANGE", endYmd: "2026-12-15" })), null);
  assert.equal(decideEndedBill(bill({ endKind: "CLASS_CHANGE", endYmd: "2026-11-15" })).kind, "CANCEL");
});
test("취소·변경 상태가 아닌 청구(취소됨 등)는 대상 아님", () => {
  assert.equal(decideEndedBill(bill({ status: "CANCELED" })), null);
  assert.equal(decideEndedBill(bill({ endYmd: "bad" })), null);
});
test("prorateWithdrawnBill: 수강료(할인·기간 조정 뒤) 기준 한 번 반올림", () => {
  const plan = prorateWithdrawnBill({ amount: 90000, endYmd: "2026-12-13", draft: { payload: payload({ baseAmount: 100000, discountAmount: 10000 }), scheduledDates: ["2026-12-06", "2026-12-13", "2026-12-20"] } });
  assert.deepEqual(plan, { kind: "PRORATE", amount: 30000, attended: 1, covered: 3, shuttle: 0 });
});
test("반 변경 차액 마이너스 = 다음 달 차감 제안(목록만), 플러스·1일 변경은 없음, 계획표 없으면 확인 필요", () => {
  const base = { requestId: "req-1", studentId: "stu-1", studentName: "김하나", fromClassName: "토요 A", toClassName: "수요 B", effectiveFrom: "2026-12-10" };
  const deduct = decideClassChange({ ...base, proration: { needsProration: true, scheduleUnavailable: false, diff: -30000 } });
  assert.equal(deduct.kind, "DEDUCT");
  assert.equal(deduct.approvable, false);
  assert.equal(deduct.proposedAmount, 30000);
  assert.match(deduct.text, /1월 청구에서 30,000원 차감 제안/);
  assert.equal(decideClassChange({ ...base, proration: { needsProration: true, scheduleUnavailable: false, diff: 5000 } }), null);
  assert.equal(decideClassChange({ ...base, effectiveFrom: "2026-12-01", proration: null }), null);
  assert.equal(decideClassChange({ ...base, proration: null }).kind, "CHECK");
  assert.equal(decideClassChange({ ...base, effectiveFrom: "2026-10-10", proration: null }), null); // 오래된 이력
});
test("정렬: 승인 가능 → 확인 필요 → 목록만 / sameProposal 은 열쇠·종류·두 금액이 모두 같을 때만", () => {
  const items = sortPostIssueItems([decideEndedBill(bill({ status: "PAID", paymentId: "a" })), decideEndedBill(bill({ skip: "POS", paymentId: "b" })), decideEndedBill(bill({ paymentId: "c" }))]);
  assert.deepEqual(items.map((i) => i.kind), ["CANCEL", "CHECK", "PAID"]);
  const now = decideEndedBill(bill());
  assert.equal(sameProposal({ key: now.key, kind: "CANCEL", currentAmount: 120000, proposedAmount: 0 }, now), true);
  assert.equal(sameProposal({ key: now.key, kind: "CANCEL", currentAmount: 100000, proposedAmount: 0 }, now), false);
  assert.equal(sameProposal({ key: now.key, kind: "PRORATE", currentAmount: 120000, proposedAmount: 0 }, now), false);
  assert.equal(sameProposal({ key: now.key, kind: "CANCEL", currentAmount: 120000, proposedAmount: 0 }, null), false);
});

// ── 가짜 DB ──────────────────────────────────────────────────────
function fakeDb(state) {
  const calls = [];
  const db = {
    calls,
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes("to_regclass")) return values[0].map((name) => ({ name, found: true }));
      if (sql.includes("WITH last_end")) {
        const only = sql.includes("AND p.id = $1") ? values[0] : null;
        return state.bills.filter((b) => (!only || b.id === only) && ["PENDING", "OVERDUE", "PAID"].includes(b.status)).map((b) => ({ ...b, posBusy: Boolean(b.posBusy) }));
      }
      if (sql.includes(`r.kind = 'CLASS_CHANGE'`)) return state.changes ?? [];
      if (sql.includes(`WHERE a.action = ANY`)) return (state.audit ?? []).filter((a) => values[0].includes(a.action)).map((a) => ({ action: a.action, key: a.details.key }));
      if (sql.startsWith(`SELECT id, status FROM "Payment" WHERE id = $1 FOR UPDATE`)) return state.bills.filter((b) => b.id === values[0]).map((b) => ({ id: b.id, status: b.status }));
      if (sql.includes(`FROM "PaymentInvoice" WHERE "paymentId" = $1 FOR UPDATE`)) return state.bills.filter((b) => b.id === values[0]).map((b) => ({ id: `inv-${b.id}`, status: b.invoiceStatus, amount: b.invoiceAmount ?? b.amount }));
      if (sql.includes("POS_BUSY_FRAGMENT") && sql.includes(`WHERE p.id = $1`)) return state.posAfter ? [{ id: values[0] }] : [];
      if (sql.includes(`"detailsJson"->>'key' = $2`)) return (state.audit ?? []).filter((a) => a.action === values[0] && a.details.key === values[1]).map(() => ({ id: "x" }));
      throw new Error(`모르는 조회: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql, ...values) {
      calls.push({ sql, values });
      if (sql.includes("pg_advisory_xact_lock")) return 1;
      if (sql.startsWith(`UPDATE "Payment" SET status = 'CANCELED'`)) {
        const b = state.bills.find((x) => x.id === values[0] && ["PENDING", "OVERDUE"].includes(x.status));
        if (!b) return 0; b.status = "CANCELED"; return 1;
      }
      if (sql.startsWith(`UPDATE "Payment" SET amount`)) {
        const b = state.bills.find((x) => x.id === values[0] && ["PENDING", "OVERDUE"].includes(x.status) && x.amount === values[2]);
        if (!b) return 0; b.amount = values[1]; return 1;
      }
      if (sql.startsWith(`UPDATE "PaymentInvoice" SET status = 'CANCELED'`)) {
        const b = state.bills.find((x) => x.id === values[1] && ["ISSUED", "SENT", "OVERDUE"].includes(x.invoiceStatus));
        if (!b) return 0; b.invoiceStatus = "CANCELED"; return 1;
      }
      if (sql.startsWith(`UPDATE "PaymentInvoice" SET amount`)) {
        const b = state.bills.find((x) => x.id === values[1] && ["ISSUED", "SENT", "OVERDUE"].includes(x.invoiceStatus));
        if (!b) return 0; b.invoiceAmount = values[2]; return 1;
      }
      if (sql.includes(`INSERT INTO "PaymentAuditLog"`)) { (state.paymentAudit ??= []).push({ sql, values }); return 1; }
      if (sql.includes(`INSERT INTO "OperationsAuditLog"`)) { (state.audit ??= []).push({ action: values[0], details: JSON.parse(values[2]) }); return 1; }
      throw new Error(`모르는 쓰기: ${sql.slice(0, 80)}`);
    },
    // 거래: 실패하면 상태를 되돌린다(전부 또는 아무것도)
    async $transaction(work) {
      const snapshot = structuredClone({ bills: state.bills, audit: state.audit ?? [], paymentAudit: state.paymentAudit ?? [] });
      try { return await work(db); } catch (error) { Object.assign(state, snapshot); throw error; }
    },
  };
  return db;
}
const billRow = (over = {}) => ({
  id: "pay-1", studentId: "stu-1", studentName: "김하나", classId: "cls-1", className: "토요 A", year: 2026, month: 12, amount: 120000, status: "PENDING",
  endKind: "WITHDRAW", endYmd: "2026-11-20", invoiceStatus: "ISSUED", posBusy: false, paidTx: false, carryUsed: false, carrySource: false, pauseSettled: false, illnessReduced: false,
  draftPayload: payload(), draftDates: ["2026-12-05", "2026-12-12", "2026-12-19", "2026-12-26"], hasDraft: true,
  draftClassId: "cls-1", manualEdited: false, sameClassActive: false, otherClassUnbilled: false, ...over,
});

test("목록: 어긋난 청구 + 반 변경 차감 + 무시·승인한 줄 제외", async () => {
  const state = { bills: [billRow(), billRow({ id: "pay-2", endYmd: "2027-01-05" }), billRow({ id: "pay-3", status: "PAID" })], audit: [{ action: service.POST_ISSUE_DISMISS_ACTION, details: { key: "P:pay-3:2026-11-20:PAID" } }],
    changes: [{ id: "req-1", studentId: "stu-2", studentName: "박둘", fromClassName: "토요 A", toClassName: "수요 B", effectiveFrom: "2026-12-10", fromDay: "Sat", toDay: "Wed", fromFee: 120000, toFee: 100000 }] };
  const view = await service.readPostIssueView(fakeDb(state), { classDatesFor: (ym, dow) => dow === "Sat" ? ["2026-12-05", "2026-12-12", "2026-12-19", "2026-12-26"] : ["2026-12-02", "2026-12-09", "2026-12-16", "2026-12-23"], writesEnabled: true, sinceYmd: "2026-11-01" });
  assert.deepEqual(view.items.map((i) => [i.kind, i.key]), [["CANCEL", "P:pay-1:2026-11-20:CANCEL"], ["DEDUCT", "R:req-1:DEDUCT"]]);
  assert.equal(view.items[1].proposedAmount, 90000 - 50000); // 옛 반 남은 3회 90,000 − 새 반 남은 2회 50,000
});
test("목록: 학부모 결제 진행 중이면 «확인 필요»", async () => {
  globalThis.__postIssueFake.active = new Set(["pay-1"]);
  try {
    const view = await service.readPostIssueView(fakeDb({ bills: [billRow()] }), { classDatesFor: null, writesEnabled: true, sinceYmd: "2026-11-01" });
    assert.equal(view.items[0].kind, "CHECK");
    assert.equal(view.calendarMissing, true);
  } finally { globalThis.__postIssueFake.active = new Set(); }
});

const approveBody = (over = {}) => ({ key: "P:pay-1:2026-11-20:CANCEL", kind: "CANCEL", paymentId: "pay-1", currentAmount: 120000, proposedAmount: 0, ...over });
test("승인(취소): 결제 잠금 → 청구·청구서 함께 CANCELED → 감사 2곳, 발송 없음", async () => {
  const state = { bills: [billRow()] };
  globalThis.__postIssueFake.locks = [];
  const result = await service.approvePostIssueChange(fakeDb(state), approveBody(), "owner-1", true);
  assert.deepEqual(result, { ok: true, kind: "CANCEL", paymentId: "pay-1", amount: 0 });
  assert.equal(state.bills[0].status, "CANCELED");
  assert.equal(state.bills[0].invoiceStatus, "CANCELED");
  assert.deepEqual(globalThis.__postIssueFake.locks, ["pay-1"]);
  assert.match(state.paymentAudit[0].sql, /PAYMENT_CANCEL_UNPAID/);
  assert.deepEqual(JSON.parse(state.paymentAudit[0].values[4]).before, { paymentStatus: "PENDING", invoiceStatus: "ISSUED" }, "취소 전 상태(검수 D-5)");
  assert.equal(state.audit[0].action, service.POST_ISSUE_APPROVE_ACTION);
  assert.equal(state.audit[0].details.notificationsSent, false);
});
test("승인(금액 변경): 청구·청구서 금액 함께 · 되돌릴 값 감사 · 승인한 줄은 목록에서 빠짐", async () => {
  const state = { bills: [billRow({ endYmd: "2026-12-15" })] };
  const db = fakeDb(state);
  await service.approvePostIssueChange(db, approveBody({ key: "P:pay-1:2026-12-15:PRORATE", kind: "PRORATE", proposedAmount: 60000 }), "owner-1", true);
  assert.equal(state.bills[0].amount, 60000);
  assert.equal(state.bills[0].invoiceAmount, 60000);
  assert.match(state.paymentAudit[0].sql, /PAYMENT_UPDATE_UNPAID/);
  assert.equal(JSON.parse(state.paymentAudit[0].values[4]).rollback.amount, 120000);
  const view = await service.readPostIssueView(db, { classDatesFor: null, writesEnabled: true, sinceYmd: "2026-11-01" });
  assert.equal(view.items.length, 0);
});
test("승인 거절: 쓰기 스위치 꺼짐·화면과 다른 금액·그 사이 결제 시작·POS 요청이 막 생김 → 아무것도 안 바뀜", async () => {
  await assert.rejects(service.approvePostIssueChange(fakeDb({ bills: [billRow()] }), approveBody(), "owner-1", false), (e) => e.status === 503);
  const changed = { bills: [billRow()] };
  await assert.rejects(service.approvePostIssueChange(fakeDb(changed), approveBody({ currentAmount: 100000 }), "owner-1", true), (e) => e.status === 409);
  assert.equal(changed.bills[0].status, "PENDING");
  globalThis.__postIssueFake.active = new Set(["pay-1"]);
  const checkout = { bills: [billRow()] };
  try { await assert.rejects(service.approvePostIssueChange(fakeDb(checkout), approveBody(), "owner-1", true), /승인할 수 없습니다/); }
  finally { globalThis.__postIssueFake.active = new Set(); }
  assert.equal(checkout.bills[0].status, "PENDING");
  const pos = { bills: [billRow()], posAfter: true };
  await assert.rejects(service.approvePostIssueChange(fakeDb(pos), approveBody(), "owner-1", true), /현장 결제 요청/);
  assert.equal(pos.bills[0].status, "PENDING"); // 거래 전체가 되돌아갔다
  assert.equal(pos.bills[0].invoiceStatus, "ISSUED");
  assert.equal((pos.audit ?? []).length, 0);
});
test("승인 요청 모양 검사: 반 변경 줄·금액 증가·열쇠와 다른 청구 id 는 거절", () => {
  assert.throws(() => service.validateApproveInput(approveBody({ key: "R:req-1:DEDUCT" })));
  assert.throws(() => service.validateApproveInput(approveBody({ kind: "PRORATE", proposedAmount: 60000 })), "열쇠의 종류와 요청 종류가 다르면 거절");
  assert.throws(() => service.validateApproveInput(approveBody({ proposedAmount: 130000 })));
  assert.throws(() => service.validateApproveInput(approveBody({ paymentId: "pay-9" })));
  assert.throws(() => service.validateApproveInput(approveBody({ kind: "PAID" })));
  assert.equal(service.validateApproveInput(approveBody()).paymentId, "pay-1");
});
test("무시: 기록 한 줄(같은 열쇠 두 번이어도 한 줄) · 청구는 그대로", async () => {
  const state = { bills: [billRow()] };
  const db = fakeDb(state);
  await service.dismissPostIssueChange(db, { key: "P:pay-1:2026-11-20:CANCEL" }, "owner-1", true);
  await service.dismissPostIssueChange(db, { key: "P:pay-1:2026-11-20:CANCEL" }, "owner-1", true);
  assert.equal(state.audit.length, 1);
  assert.equal(state.bills[0].status, "PENDING");
  await assert.rejects(service.dismissPostIssueChange(db, { key: "DROP TABLE" }, "owner-1", true));
  await assert.rejects(service.dismissPostIssueChange(db, { key: "R:req-1:DEDUCT" }, "owner-1", false), (e) => e.status === 503);
  await assert.rejects(service.dismissPostIssueChange(db, { key: "P:pay-1:2026-11-20" }, "owner-1", true), "종류 없는 옛 열쇠는 거절");
});

// ── 정적 검사: 학부모 알림·문자 코드가 없다 · 원장만 · KST 금지 패턴 없음 ─────
test("발송 코드 없음·원장 권한·쓰기 스위치·화면 연결", async () => {
  const files = ["src/lib/billing/post-issue-rules.ts", "src/lib/billing/post-issue-service.ts", "src/app/api/admin/billing-post-issue/route.ts", "src/app/admin/finance/prepare/PostIssueChanges.tsx"];
  for (const file of files) {
    const code = (await readFile(file, "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const banned of [/sendSms/i, /sendTrackedSms/, /alimtalk/i, /notifyParent/, /createNotificationRecord/, /deliverParentNotification/, /push-outbox|enqueuePush/i, /refund/i, /toISOString\(\)\.slice\(0,\s*10\)/, /\.getDay\(\)/]) {
      assert.doesNotMatch(code, banned, `${file}: ${banned}`);
    }
  }
  const route = await readFile("src/app/api/admin/billing-post-issue/route.ts", "utf8");
  assert.match(route, /requireOwner\(\)/);
  assert.match(route, /STIZ_BILLING_WORKBENCH_WRITES_ENABLED/);
  const workbench = await readFile("src/app/admin/finance/prepare/BillingWorkbench.tsx", "utf8");
  assert.match(workbench, /<PostIssueChanges \/>/);
  // UI 규칙: 800·900 굵기·아이콘 없음
  const ui = await readFile("src/app/admin/finance/prepare/PostIssueChanges.tsx", "utf8");
  assert.doesNotMatch(ui, /font-(extrabold|black)|UiIcon|material-symbols/);
});

// ── 검수·운영 실측 반영 D-1~D-5(2026-11-17) ─────────────────────────
test("D-1 이상 신호 판정: 반 바뀜·손 수정·재등록·다른 반 청구 없음", () => {
  const base = { draftClassId: "cls-1", paymentClassId: "cls-1", hasDraft: true, manualEdited: false, sameClassActive: false, otherClassUnbilled: false };
  assert.equal(rules.anomalyOf(base), null);
  assert.equal(rules.anomalyOf({ ...base, draftClassId: "cls-6" }), "CLASS_MOVED");
  assert.equal(rules.anomalyOf({ ...base, hasDraft: false, draftClassId: null, manualEdited: true }), "MANUAL_EDIT");
  assert.equal(rules.anomalyOf({ ...base, manualEdited: true }), null, "발행 기록이 있으면 (b)는 보지 않는다(금액은 PRORATE 가 따로 대조)");
  assert.equal(rules.anomalyOf({ ...base, sameClassActive: true }), "SAME_CLASS_ACTIVE");
  assert.equal(rules.anomalyOf({ ...base, otherClassUnbilled: true }), "OTHER_CLASS_UNBILLED");
  for (const anomaly of ["CLASS_MOVED", "MANUAL_EDIT", "SAME_CLASS_ACTIVE", "OTHER_CLASS_UNBILLED"]) {
    const item = decideEndedBill(bill({ anomaly }));
    assert.equal(item.kind, "CHECK");
    assert.equal(item.approvable, false);
    assert.ok(item.text.includes(rules.POST_ISSUE_ANOMALY_REASONS[anomaly]));
  }
  assert.match(rules.POST_ISSUE_ANOMALY_REASONS.CLASS_MOVED, /발행 뒤 청구 반이 바뀌었습니다/);
  assert.match(rules.POST_ISSUE_ANOMALY_REASONS.OTHER_CLASS_UNBILLED, /다른 반 청구가 없습니다 — 반 이동 확인/);
});

// 운영 실측 재현: 유한빈 — 초안은 목6, 청구는 목7(원장이 손으로 옮김), 목7 수강 끝남, 목6 은 아직 수강 중(그 반 청구 없음)
const yuHanbin = () => billRow({ id: "pay-yu", studentName: "유한빈", classId: "thu7", className: "목7", amount: 80000, endKind: "WITHDRAW", endYmd: "2026-11-27",
  draftClassId: "thu6", otherClassUnbilled: true, draftPayload: payload({ baseAmount: 80000 }) });
test("D-1 유한빈 재현: 목록은 «확인 필요»(승인 버튼 없음), 취소 승인은 409·청구 그대로", async () => {
  const state = { bills: [yuHanbin()] };
  const view = await service.readPostIssueView(fakeDb(state), { classDatesFor: null, writesEnabled: true, sinceYmd: "2026-11-01" });
  assert.equal(view.items.length, 1);
  assert.equal(view.items[0].kind, "CHECK");
  assert.equal(view.items[0].approvable, false);
  assert.match(view.items[0].text, /발행 뒤 청구 반이 바뀌었습니다/);
  await assert.rejects(service.approvePostIssueChange(fakeDb(state), { key: "P:pay-yu:2026-11-27:CANCEL", kind: "CANCEL", paymentId: "pay-yu", currentAmount: 80000, proposedAmount: 0 }, "owner-1", true),
    (e) => e.status === 409 && /승인할 수 없습니다/.test(e.message));
  assert.equal(state.bills[0].status, "PENDING");
  assert.equal(state.bills[0].invoiceStatus, "ISSUED");
  assert.equal((state.paymentAudit ?? []).length, 0);
  // 발행 기록이 없는 청구도 «다른 반 청구 없음»만으로 확인 필요
  const noDraft = { bills: [billRow({ id: "pay-nd", hasDraft: false, draftPayload: null, draftDates: null, draftClassId: null, otherClassUnbilled: true })] };
  const v2 = await service.readPostIssueView(fakeDb(noDraft), { classDatesFor: null, writesEnabled: true, sinceYmd: "2026-11-01" });
  assert.match(v2.items[0].text, /다른 반 청구가 없습니다/);
});
test("D-1 손 수정·재등록 신호는 서비스 조회에서 그대로 확인 필요가 된다", async () => {
  const state = { bills: [billRow({ id: "pay-m", hasDraft: false, draftPayload: null, draftDates: null, draftClassId: null, manualEdited: true }), billRow({ id: "pay-r", sameClassActive: true })] };
  const view = await service.readPostIssueView(fakeDb(state), { classDatesFor: null, writesEnabled: true, sinceYmd: "2026-11-01" });
  assert.deepEqual(view.items.map((i) => [i.paymentId, i.kind]).sort(), [["pay-m", "CHECK"], ["pay-r", "CHECK"]]);
  const code = await readFile("src/lib/billing/post-issue-service.ts", "utf8");
  assert.match(code, /ma\.action = 'PAYMENT_UPDATE_UNPAID' AND COALESCE\(ma\.metadata->>'source',''\) <> 'POST_ISSUE'/, "이 기능의 승인 기록은 손 수정으로 세지 않는다");
  assert.match(code, /d\."classId" AS "draftClassId"/);
});
test("D-2 반 변경 차액을 못 구한 이유를 원인별로", () => {
  assert.equal(rules.classChangeProblemOf({ calendarRead: false, fromDay: "Sat", toDay: "Wed" }), "CALENDAR_UNREAD");
  assert.equal(rules.classChangeProblemOf({ calendarRead: true, fromDay: "Archived", toDay: "Wed" }), "FROM_DAY_UNKNOWN");
  assert.equal(rules.classChangeProblemOf({ calendarRead: true, fromDay: "Sat", toDay: null }), "TO_DAY_UNKNOWN");
  assert.equal(rules.classChangeProblemOf({ calendarRead: true, fromDay: "Sat", toDay: "Wed" }), null);
  const base = { requestId: "req-1", studentId: "stu-1", studentName: "신이준", fromClassName: "옛 반", toClassName: "새 반", effectiveFrom: "2026-12-10", proration: null };
  assert.match(decideClassChange({ ...base, problem: "FROM_DAY_UNKNOWN" }).text, /옛 반의 수업 요일을 알 수 없어/);
  assert.match(decideClassChange({ ...base, problem: "CALENDAR_UNREAD" }).text, /연간 일정을 읽지 못해/);
  assert.match(decideClassChange({ ...base }).text, /연간 계획표에 그달 수업일이 없어/);
});
test("D-2 서비스: 보관 처리된 옛 반(요일 Archived)은 «옛 반 요일을 알 수 없어»", async () => {
  const state = { bills: [], changes: [{ id: "req-a", studentId: "stu-2", studentName: "신이준", fromClassName: "옛 반", toClassName: "새 반", effectiveFrom: "2026-12-10", fromDay: "Archived", toDay: "Wed", fromFee: 120000, toFee: 100000 }] };
  const view = await service.readPostIssueView(fakeDb(state), { classDatesFor: () => ["2026-12-02"], writesEnabled: true, sinceYmd: "2026-11-01" });
  assert.equal(view.items[0].kind, "CHECK");
  assert.match(view.items[0].text, /옛 반의 수업 요일을 알 수 없어/);
});
test("D-3 이미 이월로 처리된 결제 청구는 «결제됨» 줄에서 숨긴다", async () => {
  assert.equal(decideEndedBill(bill({ status: "PAID", carried: true })), null);
  assert.equal(decideEndedBill(bill({ status: "PAID", carried: false })).kind, "PAID");
  const view = await service.readPostIssueView(fakeDb({ bills: [billRow({ status: "PAID", carrySource: true })] }), { classDatesFor: null, writesEnabled: true, sinceYmd: "2026-11-01" });
  assert.equal(view.items.length, 0);
});
test("D-4 «확인 필요»를 무시해도 나중에 승인 가능한 취소 제안이 되면 다시 뜬다 · 승인한 청구는 종류가 바뀌어도 다시 안 뜬다", async () => {
  globalThis.__postIssueFake.active = new Set(["pay-1"]);
  const state = { bills: [billRow()] };
  const db = fakeDb(state);
  let view;
  try {
    view = await service.readPostIssueView(db, { classDatesFor: null, writesEnabled: true, sinceYmd: "2026-11-01" });
    assert.equal(view.items[0].key, "P:pay-1:2026-11-20:CHECK");
    await service.dismissPostIssueChange(db, { key: view.items[0].key }, "owner-1", true);
    assert.equal((await service.readPostIssueView(db, { classDatesFor: null, writesEnabled: true, sinceYmd: "2026-11-01" })).items.length, 0);
  } finally { globalThis.__postIssueFake.active = new Set(); }
  view = await service.readPostIssueView(db, { classDatesFor: null, writesEnabled: true, sinceYmd: "2026-11-01" });
  assert.deepEqual(view.items.map((i) => i.key), ["P:pay-1:2026-11-20:CANCEL"], "결제가 끝나 승인 가능해지면 다시 뜬다");
  assert.equal(rules.baseKeyOf("P:pay-1:2026-11-20:PRORATE"), "P:pay-1:2026-11-20");
  assert.equal(rules.baseKeyOf("R:req-1:DEDUCT"), "R:req-1");
});
