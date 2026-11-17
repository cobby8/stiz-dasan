import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

// 질병·부상 결석 «미납 청구에서 1회분 빼기»(2026-11-16 원장 결정)
//   그 달 수강료가 미납이면 «납부한 뒤에 승인»으로 막지 않고, 승인하면 그 미납 청구 금액을 1회 값만큼 줄인다.
//   납부된 달은 기존 이월 그대로다.
// 돈이 움직이는 기능이라 계산·판정·잠금 순서·기록을 «실제로 실행»해서 못박는다(가짜 db — 표는 메모리, SQL 은 글자로 알아본다).

const read = (path) => readFileSync(path, "utf8");
const jsUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const tsUrl = (source) => jsUrl(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);

// ── 모듈 조립 ────────────────────────────────────────────────────────────────
// 오류 클래스(WorkbenchError)는 한 벌이어야 한다(instanceof 로 사유를 가른다) → 청구 모델(workbench.ts)을 한 주소로 올려 모두가 그것을 쓴다.
const kstUrl = tsUrl(read("src/lib/datetime/kst.ts"));
const modelUrl = tsUrl(read("src/lib/billing/workbench.ts").replace('from "@/lib/datetime/kst"', `from "${kstUrl}"`));
// 청구 준비 화면 읽기(readWorkbench)는 «이월» 갈래에서만 쓴다 — 이 파일은 미납 갈래를 보므로 부르면 실패하게 둔다
const serviceStubUrl = jsUrl(`export const readWorkbench = async () => { throw new Error("이 테스트는 청구 준비 읽기를 부르지 않는다"); };`);
// 근거 읽기(workbench-absence)는 실제 코드. 연간 일정 함수만 달별 수업일 표(globalThis.__unpaidDates)로 바꾼다
const absenceUrl = tsUrl(read("src/lib/billing/workbench-absence.ts")
  .replace('from "./carryEvidence"', `from "${tsUrl(read("src/lib/billing/carryEvidence.ts"))}"`)
  // 이월 대상 사유 ↔ 인정 분류 짝 규칙(2026-11-17, import 0 순수 파일)
  .replace('from "@/lib/regular/carryReasonRules"', `from "${tsUrl(read("src/lib/regular/carryReasonRules.ts"))}"`)
  .replace('from "@/lib/studentVisibility"', `from "${tsUrl(read("src/lib/studentVisibility.ts"))}"`)
  .replace('from "./monthly-register"', `from "${tsUrl(read("src/lib/billing/monthly-register.ts"))}"`)
  .replace('from "./workbench"', `from "${modelUrl}"`)
  .replace('from "./workbench-service"', `from "${serviceStubUrl}"`)
  .replace('await import("@/lib/enrollment/monthlyClassDates")', "({getMonthlyClassDates:(events,month)=>[...(globalThis.__unpaidDates[month]??[])]})"));
// 결제 잠금·결제 진행 판정 = bundleLedger 와 같은 모양의 대역(키 형식은 실제 함수와 같다: stiz-payment-checkout:{id}, id 정렬순)
const bundleFakeUrl = jsUrl(`
  export const APPROVED_PENDING_SQL = "(t.status = 'IN_PROGRESS' AND t.\\"rawResponse\\"->>'status' = 'DONE')";
  export async function lockPaymentsForCheckout(db, ids) {
    for (const id of [...new Set(ids)].sort()) await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", "stiz-payment-checkout:" + id);
  }
  export async function findParentCheckoutActivePaymentIds(db, ids) {
    const state = globalThis.__unpaidState; state.events.push("checkout-active");
    return new Set(ids.filter((id) => state.active.has(id)));
  }`);
const overrides = {
  "@/lib/billing/workbench": modelUrl,
  "@/lib/billing/workbench-service": serviceStubUrl,
  "@/lib/billing/workbench-absence": absenceUrl,
  "@/lib/payments/bundleLedger": bundleFakeUrl,
  // 현장 결제 판정 조각만 쓴다 — 실제 글자를 그대로 넘긴다(무거운 모듈 전체를 올리지 않는다)
  "@/lib/regular/illness-period-admin": jsUrl(`export const HOLD_POS_BUSY_SQL = ${JSON.stringify(read("src/lib/regular/illness-period-admin.ts").match(/export const HOLD_POS_BUSY_SQL = `([\s\S]*?)`;/)[1])};`),
};
const admin = await loadTsModule("src/lib/regular/illness-carry-admin.ts", { overrides });
const absenceMod = await import(absenceUrl);
const model = await import(modelUrl);
const rules = await loadTsModule("src/lib/regular/illnessUnpaidReduceRules.ts");
const carryRules = await loadTsModule("src/lib/regular/illnessCarryRules.ts");

const NOV = ["2026-11-07", "2026-11-14", "2026-11-21", "2026-11-28"];
const setDates = (dates = {}) => { globalThis.__unpaidDates = { "2026-10": ["2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24", "2026-10-31"], "2026-11": NOV, "2026-12": ["2026-12-05", "2026-12-12", "2026-12-19", "2026-12-26"], ...dates }; };
setDates();

// ── 가짜 db ───────────────────────────────────────────────────────────────
const bill = (over = {}) => ({ id: "pay-nov", studentId: "s1", classId: "c1", year: 2026, month: 11, type: "MONTHLY", status: "OVERDUE", amount: 100000, rallyzMirror: false, posBusy: false, paidTx: false, carryLinked: false, ...over });
const invoiceOf = (payment, over = {}) => ({ paymentId: payment.id, amount: payment.amount, status: "ISSUED", ...over });
const absence = (over = {}) => ({ id: "a1", studentId: "s1", classId: "c1", date: "2026-11-07", reason: "ILLNESS_INJURY", status: "REPORTED", periodId: null, ...over });

function fakeDb(init = {}) {
  const payments = init.payments ?? [bill()];
  const state = {
    absences: [absence()], payments, invoices: payments.map((p) => invoiceOf(p)), drafts: [], audits: [], resolutions: [], reviews: [],
    credits: [], bookings: [], attendance: [], settlementLines: [], pauseSettled: [], enrollments: [{ studentId: "s1", classId: "c1", startsOn: null }],
    periodDecided: [], carryCredits: [], active: new Set(), events: [], failPaymentUpdate: false, ...init,
  };
  const illnessReduced = (paymentId) => state.audits.filter((a) => a.paymentId === paymentId && a.action === model.ILLNESS_UNPAID_REDUCE_ACTION).reduce((sum, a) => sum + a.metadata.reduceBy, 0);
  const unpaid = (p) => ["PENDING", "OVERDUE"].includes(p.status);
  const tx = {
    async $queryRawUnsafe(sql, ...v) {
      const has = (text) => sql.includes(text);
      if (has(`AS review`)) return [{ review: "present", evidence: "present" }];
      if (has(`"draftTable"`)) return [{ draftTable: "present", registerTable: "present" }];
      if (has("to_regclass")) return [{ found: "present" }];
      if (has("information_schema.columns")) return [{ n: 1 }];
      // 미납 감액 첫머리의 사유 재확인(질병·부상만)
      if (sql === `SELECT reason FROM "RegularAbsence" WHERE id=$1`) return state.absences.filter((a) => a.id === v[0]).map((a) => ({ reason: a.reason }));
      if (has(`FROM "RegularAbsencePeriod" p JOIN "RegularAbsence" a`)) return state.periodDecided.includes(v[0]) ? [{ found: 1 }] : [];
      if (has(`FROM "BillingAbsenceResolution" WHERE "absenceId"=$1`)) return state.resolutions.filter((r) => r.absenceId === v[0]).map((r) => ({ resolution: r.resolution }));
      // 상세: 승인이 끝난 결석이 «청구에서 뺀» 결석인가(정산 기록의 고정 사유)
      if (has(`AS reduced FROM "RegularAbsence" ra`)) {
        assert.ok(has(`reduced_resolution.reason = '${carryRules.ILLNESS_UNPAID_REDUCE_REASON}'`));
        return [{ reduced: state.resolutions.some((r) => r.absenceId === v[0] && r.reason === carryRules.ILLNESS_UNPAID_REDUCE_REASON) }];
      }
      if (has(`AS "anchorYmd" FROM "RegularAbsence" ra`)) return state.absences.filter((a) => a.id === v[0]).map((a) => ({ anchorYmd: a.date }));
      if (has(`FROM "RegularAbsence" me`)) return [];
      if (has(`FROM "RegularAbsenceEvidence" e`)) return [];
      if (has(`FROM "RegularAbsenceCarryReview" WHERE "absenceId" = $1`)) return state.reviews.filter((r) => r.absenceId === v[0]).map((r) => ({ status: r.status, source: r.source ?? "PARENT", reasonText: null, requestedYmd: "2026-11-07" }));
      if (has(`FROM "RegularAbsence" a WHERE a.id = $1`)) {
        if (has("FOR UPDATE")) state.events.push("absence-row-lock");
        return state.absences.filter((a) => a.id === v[0]).map((a) => ({ ...a }));
      }
      // ── 근거 읽기(workbench-absence) ──
      if (has(`l."missedDates" @> to_jsonb($3::text)`)) return state.pauseSettled.filter((l) => l.studentId === v[0] && l.classId === v[1] && l.missedDates.includes(v[2])).map((l) => ({ kind: l.kind ?? "UNPAID_REDUCE" }));
      if (has(`FROM "MonthlyEnrollmentRegister"`)) return [];
      if (has(`FROM "BillingWorkbenchDraft" WHERE "studentId"=$1`)) return structuredClone(state.drafts.filter((d) => d.studentId === v[0] && d.classId === v[1] && d.month === v[2] && ["ISSUED", "ZERO"].includes(d.status)));
      if (has(`LEFT JOIN "PaymentInvoice" i ON i."paymentId"=p.id WHERE p.id=$1`)) {
        // 발행 초안에 연결된 청구 — 질병·부상 결석으로 줄인 금액을 함께 읽어야 한다(같은 action 글자)
        assert.ok(has(`illness_cut.action = '${model.ILLNESS_UNPAID_REDUCE_ACTION}'`), "줄인 금액을 청구 변경 기록에서 읽는다");
        return state.payments.filter((p) => p.id === v[0] && p.studentId === v[1] && p.classId === v[2]).map((p) => {
          const invoice = state.invoices.find((i) => i.paymentId === p.id);
          return { amount: p.amount, status: p.status, invoiceAmount: invoice?.amount ?? null, invoiceStatus: invoice?.status ?? null, illnessReduced: illnessReduced(p.id) };
        });
      }
      if (has(`AND p."classId" IS NULL LIMIT 1`)) {
        const wantUnpaid = has(`p.status IN ('PENDING','OVERDUE')`);
        return state.payments.filter((p) => p.studentId === v[0] && p.year === v[1] && p.month === v[2] && p.type === "MONTHLY" && p.classId === null && (wantUnpaid ? unpaid(p) : p.status === "PAID")).slice(0, 1).map((p) => ({ id: p.id }));
      }
      if (has(`p.type='MONTHLY' AND p.status='PAID' ORDER BY p.id`) || has(`p.type='MONTHLY' AND p.status IN ('PENDING','OVERDUE') ORDER BY p.id`)) {
        const wantUnpaid = has(`p.status IN ('PENDING','OVERDUE') ORDER BY p.id`);
        assert.ok(has(`illness_cut.action = '${model.ILLNESS_UNPAID_REDUCE_ACTION}'`));
        return state.payments.filter((p) => p.studentId === v[0] && p.classId === v[1] && p.year === v[2] && p.month === v[3] && p.type === "MONTHLY" && (wantUnpaid ? unpaid(p) : p.status === "PAID"))
          .sort((a, b) => a.id.localeCompare(b.id)).map((p) => ({ id: p.id, amount: p.amount, illnessReduced: illnessReduced(p.id) }));
      }
      if (has(`FROM "EnrollmentChangeSettlementLine" l WHERE l."paymentId"=ANY`)) {
        const totals = new Map();
        for (const l of state.settlementLines) if (v[0].includes(l.paymentId) && (l.kind === "CARRY_APPLY" || (l.kind === "UNPAID_REDUCE" && l.channel === "SITE"))) totals.set(l.paymentId, (totals.get(l.paymentId) ?? 0) + l.amount);
        return [...totals].map(([paymentId, total]) => ({ paymentId, total }));
      }
      if (has(`FROM "Enrollment" e WHERE e."studentId"=$1`)) return state.enrollments.filter((e) => e.studentId === v[0] && e.classId === v[1]).map((e) => ({ startsOn: e.startsOn }));
      if (has(`FROM "RegularShuttleStop"`)) return [];
      if (has(`FROM "Class"`)) return [{ dayOfWeek: "Sat" }];
      if (has(`FROM "AnnualEvent"`)) return [];
      // ── 승인 갈래 정하기: 그 달에 미납 수강료 청구가 있는가(반 없는 청구 포함) ──
      if (has(`AND type = 'MONTHLY' AND status IN ('PENDING','OVERDUE') LIMIT 1`)) {
        return state.payments.filter((p) => p.studentId === v[0] && (p.classId === v[1] || p.classId === null) && p.year === v[2] && p.month === v[3] && p.type === "MONTHLY" && unpaid(p)).slice(0, 1).map(() => ({ found: 1 }));
      }
      // ── 줄일 청구 행 + 결제 경로 상태 ──
      if (has(`AS "rallyzMirror"`)) {
        assert.match(sql, /NOT \(\(/, "랠리즈 사본 판정 조각은 NOT ( ... ) 모양");
        assert.ok(has(`"PosChargeRequestItem"`) && has(`t.status = 'DONE' OR`), "현장 결제 요청·결제 거래(완료/승인 대기)를 함께 읽는다");
        assert.ok(has(`FROM "BillingCarryUsage" u`) && has(`source_credit.basis->>'sourcePaymentId' = p.id`), "이월과 묶인 청구인지 함께 읽는다");
        if (has("FOR UPDATE OF p")) state.events.push(`payment-row-lock:${v[0]}`);
        return state.payments.filter((p) => p.id === v[0] && p.studentId === v[1] && p.classId === v[2])
          .map((p) => ({ id: p.id, amount: p.amount, status: p.status, rallyzMirror: p.rallyzMirror, posBusy: p.posBusy, paidTx: p.paidTx, carryLinked: p.carryLinked }));
      }
      if (has(`FROM "Student" s`)) return [{ id: v[0] }];
      if (has(`FROM "MakeupCredit"`)) return state.credits.map((c) => ({ id: c.id, status: c.status }));
      if (has(`FROM "MakeupSession"`)) return state.bookings.map((b) => ({ id: b.id, status: b.status }));
      if (has(`FROM "Attendance"`)) return state.attendance.map((t) => ({ status: t.status }));
      throw new Error(`모르는 조회: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
    },
    async $executeRawUnsafe(sql, ...v) {
      const has = (text) => sql.includes(text);
      if (has("hashtext('STIZ_BILLING_WORKBENCH')")) { state.events.push("workbench-lock"); return 1; }
      if (has("hashtextextended($1, 0)")) { state.events.push(`checkout-lock:${v[0]}`); return 1; }
      if (has(`UPDATE "RegularAbsence" SET status = 'CONFIRMED'`)) { const a = state.absences.find((x) => x.id === v[0] && x.status === "REPORTED"); if (a) a.status = "CONFIRMED"; return a ? 1 : 0; }
      if (has(`UPDATE "Payment" SET amount = $2`)) {
        // 조건부 UPDATE — 미납이고 금액이 읽은 값과 같을 때만
        assert.match(sql, /WHERE id = \$1 AND status IN \('PENDING','OVERDUE'\) AND amount = \$3/);
        const p = state.payments.find((x) => x.id === v[0]);
        if (state.failPaymentUpdate || !p || !unpaid(p) || p.amount !== v[2]) return 0;
        p.amount = v[1]; if (v[1] === 0) p.status = "CANCELED";
        state.events.push("payment-update");
        return 1;
      }
      if (has(`UPDATE "PaymentInvoice" SET amount = $2`)) {
        let n = 0;
        for (const i of state.invoices) if (i.paymentId === v[0] && i.status !== "PAID") { i.amount = v[1]; if (v[1] === 0) i.status = "CANCELED"; n += 1; }
        return n;
      }
      if (has(`INSERT INTO "PaymentAuditLog"`)) { state.audits.push({ paymentId: v[0], actorId: v[1], action: v[2], message: v[3], metadata: JSON.parse(v[4]), actorType: v[5] }); return 1; }
      if (has(`UPDATE "MakeupSession" SET status='CANCELLED'`)) { for (const b of state.bookings) if (v[0].includes(b.id) && b.status === "BOOKED") b.status = "CANCELLED"; return 1; }
      if (has(`UPDATE "MakeupCredit" SET status='REVOKED'`)) { for (const c of state.credits) if (v[0].includes(c.id) && ["AVAILABLE", "RESERVED", "EXPIRED"].includes(c.status)) c.status = "REVOKED"; return 1; }
      if (has(`INSERT INTO "BillingAbsenceResolution"`)) {
        // DB 제약: resolution 은 CARRY·MAKEUP 만, PK = 결석 id
        assert.match(sql, /VALUES \(\$1,\$2,'CARRY',\$3,true,'ILLNESS_INJURY',\$4\)/);
        if (state.resolutions.some((r) => r.absenceId === v[0])) throw new Error("duplicate key value violates unique constraint");
        state.resolutions.push({ absenceId: v[0], studentId: v[1], resolution: "CARRY", reason: v[2], actorUserId: v[3] });
        return 1;
      }
      if (has(`INSERT INTO "RegularAbsenceCarryReview"`)) {
        assert.match(sql, /SELECT a\.id,'APPROVED','STAFF',NOW\(\),'ADMIN',\$2::text,NULL/, "검토 상태는 기존 값 «APPROVED»(DB 제약의 값 집합을 늘리지 않는다)");
        state.reviews = state.reviews.filter((r) => r.absenceId !== v[0]);
        state.reviews.push({ absenceId: v[0], status: "APPROVED", decidedByUserId: v[1] });
        return 1;
      }
      if (has(`INSERT INTO "BillingCarryCredit"`)) { state.carryCredits.push(v); return 1; }
      throw new Error(`모르는 쓰기: ${sql.replace(/\s+/g, " ").slice(0, 160)}`);
    },
  };
  // 실패하면 전부 되돌린다(트랜잭션) — events 는 순서 확인용이라 남긴다
  const db = { state, tx, async $transaction(work) {
    globalThis.__unpaidState = state;
    const before = structuredClone({ ...state, events: [] });
    try { return await work(tx); } catch (error) { const events = state.events; Object.assign(state, before, { events }); throw error; }
  } };
  globalThis.__unpaidState = state;
  return db;
}

const approve = (db, input = {}) => admin.approveIllnessCarry(db, { absenceId: "a1", evidenceConfirmed: true, ...input }, "admin-1", true);
const SEE = (reduceBy, after) => ({ mode: "REDUCE", reduceBy, after });
/** 실패한 승인 뒤 아무것도 바뀌지 않았는가(결석 확정까지 되돌림) */
const untouched = (db, amount = 100000) => {
  assert.equal(db.state.absences[0].status, "REPORTED", "결석 확정까지 되돌린다");
  assert.deepEqual(db.state.payments.map((p) => p.amount), db.state.payments.map(() => amount));
  assert.deepEqual([db.state.audits.length, db.state.resolutions.length, db.state.reviews.length, db.state.carryCredits.length], [0, 0, 0, 0]);
};

// ── 1) 순수 규칙 ─────────────────────────────────────────────────────────────
test("1회 값 = round(그 달 수강료 ÷ 수업 횟수) — 빼고 남는 금액, 반올림, 남은 청구가 작을 때, 0원", () => {
  // 원장이 든 예: 11월 미납 100,000원 ÷ 4회 → 75,000원
  assert.deepEqual(rules.planUnpaidReduce({ tuition: 100000, sessions: 4, paymentAmount: 100000 }), { ok: true, unit: 25000, reduceBy: 25000, before: 100000, after: 75000, cancels: false });
  // 나누어떨어지지 않으면 원 단위 반올림(3회 달 · 6으로 나눠 .5 이상 올림)
  assert.equal(rules.planUnpaidReduce({ tuition: 100000, sessions: 3, paymentAmount: 100000 }).unit, 33333);
  assert.equal(rules.planUnpaidReduce({ tuition: 100000, sessions: 6, paymentAmount: 100000 }).unit, 16667);
  // 이미 한 번 뺀 청구: 1회 값은 «원래 금액» 기준 그대로(분자는 부르는 쪽이 원래 금액으로 넘긴다)
  assert.deepEqual(rules.planUnpaidReduce({ tuition: 100000, sessions: 4, paymentAmount: 75000 }), { ok: true, unit: 25000, reduceBy: 25000, before: 75000, after: 50000, cancels: false });
  // 남은 청구가 1회 값보다 작으면 남은 만큼만 — 음수가 되지 않는다. 0원이면 청구를 취소 상태로
  assert.deepEqual(rules.planUnpaidReduce({ tuition: 100000, sessions: 4, paymentAmount: 10000 }), { ok: true, unit: 25000, reduceBy: 10000, before: 10000, after: 0, cancels: true });
  assert.deepEqual(rules.planUnpaidReduce({ tuition: 100000, sessions: 1, paymentAmount: 100000 }), { ok: true, unit: 100000, reduceBy: 100000, before: 100000, after: 0, cancels: true });
  // 이월과 묶인 청구는 0원(취소)으로 만들지 않는다 — 0원이 아니면 그대로 뺀다
  assert.deepEqual(rules.planUnpaidReduce({ tuition: 100000, sessions: 4, paymentAmount: 10000, carryLinked: true }), { ok: false, code: "CARRY_LINKED_ZERO" });
  assert.equal(rules.planUnpaidReduce({ tuition: 100000, sessions: 4, paymentAmount: 60000, carryLinked: true }).after, 35000);
  // 뺄 것이 없으면 막는다(0원 청구 · 수강료 0원)
  assert.deepEqual(rules.planUnpaidReduce({ tuition: 100000, sessions: 4, paymentAmount: 0 }), { ok: false, code: "NOTHING" });
  assert.deepEqual(rules.planUnpaidReduce({ tuition: 0, sessions: 4, paymentAmount: 100000 }), { ok: false, code: "NOTHING" });
  // 숫자가 이상하면 계산하지 않는다
  for (const bad of [{ tuition: -1, sessions: 4, paymentAmount: 1 }, { tuition: 1, sessions: 0, paymentAmount: 1 }, { tuition: 1.5, sessions: 4, paymentAmount: 1 }, { tuition: 1, sessions: 4, paymentAmount: -1 }, { tuition: NaN, sessions: 4, paymentAmount: 1 }]) {
    assert.deepEqual(rules.planUnpaidReduce(bad), { ok: false, code: "BAD_AMOUNT" }, JSON.stringify(bad));
  }
  // 어떤 입력에서도 남는 금액은 0 이상
  for (const tuition of [1, 99999, 100000, 250000]) for (const sessions of [1, 3, 4, 5]) for (const paymentAmount of [1, 5000, 100000, 300000]) {
    const plan = rules.planUnpaidReduce({ tuition, sessions, paymentAmount });
    if (plan.ok) { assert.ok(plan.after >= 0 && plan.reduceBy > 0 && plan.reduceBy <= plan.unit); assert.equal(plan.before - plan.reduceBy, plan.after); }
  }
});

test("막는 사유: 미납 아님 → 랠리즈 사본 → 학부모 결제 중 → 현장 결제 요청 중 → 결제 거래 있음(한국어 한 줄)", () => {
  const ok = { status: "OVERDUE", rallyzMirror: false, checkoutActive: false, posBusy: false, paidTx: false };
  assert.equal(rules.unpaidReduceBlockCode(ok), null);
  assert.equal(rules.unpaidReduceBlockCode({ ...ok, status: "PENDING" }), null);
  for (const status of ["PAID", "CANCELED", "REFUNDED"]) assert.equal(rules.unpaidReduceBlockCode({ ...ok, status }), "NOT_UNPAID");
  assert.equal(rules.unpaidReduceBlockCode({ ...ok, rallyzMirror: true, checkoutActive: true, posBusy: true, paidTx: true }), "RALLYZ");
  assert.equal(rules.unpaidReduceBlockCode({ ...ok, checkoutActive: true, posBusy: true, paidTx: true }), "CHECKOUT");
  assert.equal(rules.unpaidReduceBlockCode({ ...ok, posBusy: true, paidTx: true }), "POS");
  assert.equal(rules.unpaidReduceBlockCode({ ...ok, paidTx: true }), "PAID_TX");
  for (const text of Object.values(rules.UNPAID_REDUCE_BLOCKERS)) { assert.ok(text.length > 10); assert.doesNotMatch(text, /학원에 문의|문의해/); }
});

test("화면이 본 것과 서버가 정한 것: 방식·금액이 다르면 승인하지 않는다", () => {
  const actual = { mode: "REDUCE", reduceBy: 25000, after: 75000 };
  assert.equal(rules.approvalExpectationMismatch(SEE(25000, 75000), actual), false);
  // 금액을 볼 수 없는 역할(부원장)은 방식만 보낸다 → 방식만 견준다
  assert.equal(rules.approvalExpectationMismatch({ mode: "REDUCE", reduceBy: null, after: null }, actual), false);
  // 금액이 다르면(그 사이 청구가 바뀜) · 이월로 봤으면 · 아무것도 안 보냈으면(예전 화면) 승인하지 않는다
  assert.equal(rules.approvalExpectationMismatch(SEE(20000, 80000), actual), true);
  assert.equal(rules.approvalExpectationMismatch(SEE(25000, 70000), actual), true);
  assert.equal(rules.approvalExpectationMismatch({ mode: "CARRY" }, actual), true);
  assert.equal(rules.approvalExpectationMismatch(null, actual), true);
  assert.equal(rules.approvalExpectationMismatch(undefined, actual), true);
  // 이월로 처리될 결석: «청구에서 빼기»를 봤을 때만 다르다(안 보냈으면 기존 동작 그대로)
  assert.equal(rules.approvalExpectationMismatch(SEE(25000, 75000), { mode: "CARRY" }), true);
  assert.equal(rules.approvalExpectationMismatch({ mode: "CARRY" }, { mode: "CARRY" }), false);
  assert.equal(rules.approvalExpectationMismatch(null, { mode: "CARRY" }), false);
  // 화면이 보낸 값은 안전한 모양으로만
  assert.deepEqual(rules.parseApprovalExpectation({ mode: "REDUCE", reduceBy: 25000, after: 75000, extra: 1 }), SEE(25000, 75000));
  assert.deepEqual(rules.parseApprovalExpectation({ mode: "REDUCE", reduceBy: "25000", after: -1 }), { mode: "REDUCE", reduceBy: null, after: null });
  assert.deepEqual(rules.parseApprovalExpectation({ mode: "CARRY", reduceBy: 1 }), { mode: "CARRY" });
  for (const bad of [null, undefined, "REDUCE", {}, { mode: "MAKEUP" }]) assert.equal(rules.parseApprovalExpectation(bad), null);
});

test("신청함 근거 한 줄: 원장이 정한 글 그대로 · 청구 금액이 수강료와 다르면 풀어서 · 금액 없는 역할은 횟수만", () => {
  const view = { month: "2026-11", tuition: 100000, sessions: 4, unit: 25000, before: 100000, reduceBy: 25000, after: 75000, warnings: [] };
  assert.equal(rules.unpaidReduceEvidenceLine(view), "근거: 11월 미납 청구 100,000원 ÷ 4회 = 1회 25,000원 · 승인하면 청구가 75,000원이 돼요");
  // 셔틀비가 든 발행 청구: 수강료(90,000)로 나누고 청구(110,000)에서 뺀다
  assert.equal(rules.unpaidReduceEvidenceLine({ ...view, tuition: 90000, unit: 22500, before: 110000, reduceBy: 22500, after: 87500 }),
    "근거: 11월 미납 수강료 90,000원 ÷ 4회 = 1회 22,500원 · 지금 청구 110,000원 · 승인하면 청구가 87,500원이 돼요");
  // 남은 청구가 1회 값보다 작다 → 남은 만큼만 빼고 0원(취소)
  assert.equal(rules.unpaidReduceEvidenceLine({ ...view, before: 10000, reduceBy: 10000, after: 0 }),
    "근거: 11월 미납 수강료 100,000원 ÷ 4회 = 1회 25,000원 · 지금 청구 10,000원 · 남은 청구가 작아 10,000원만 빼요 · 승인하면 청구가 0원이 되어 취소돼요");
  // 금액을 볼 수 없는 역할: 서버가 금액 칸을 전부 지운다 → 글에도 금액이 없다
  const masked = rules.maskUnpaidReduceView({ ...view, warnings: ["월중 등록"] });
  assert.deepEqual(masked, { month: "2026-11", tuition: null, sessions: 4, unit: null, before: null, reduceBy: null, after: null, warnings: ["월중 등록"] });
  const line = rules.unpaidReduceEvidenceLine(masked);
  assert.equal(line, "근거: 11월 미납 청구 ÷ 4회 · 승인하면 그 청구에서 1회분을 빼요");
  assert.doesNotMatch(line, /\d{2,},?\d*원/);
});

// ── 2) 승인 실행(가짜 db) ─────────────────────────────────────────────────────
test("일반 청구(발행 초안 없는 달): 미납 100,000원 ÷ 4회 → 승인하면 청구·청구서가 75,000원, 이월은 만들지 않는다", async () => {
  const db = fakeDb({ credits: [{ id: "credit-1", status: "AVAILABLE" }] });
  const done = await approve(db, { expected: SEE(25000, 75000) });
  assert.deepEqual(done, { studentId: "s1", classId: "c1", absenceYmd: "2026-11-07", mode: "REDUCE" });
  assert.deepEqual([db.state.payments[0].amount, db.state.payments[0].status], [75000, "OVERDUE"], "미납 상태는 그대로, 금액만 줄어든다");
  assert.deepEqual([db.state.invoices[0].amount, db.state.invoices[0].status], [75000, "ISSUED"]);
  assert.equal(db.state.carryCredits.length, 0, "이월 적립(BillingCarryCredit)은 만들지 않는다");
  // 결석 확정 · 미사용 보강권 회수 · 검토 «승인» — 기존 이월 승인과 같다
  assert.equal(db.state.absences[0].status, "CONFIRMED");
  assert.equal(db.state.credits[0].status, "REVOKED");
  assert.deepEqual(db.state.reviews, [{ absenceId: "a1", status: "APPROVED", decidedByUserId: "admin-1" }]);
  // 정산 기록: resolution 은 CARRY(DB 제약), 구분은 고정 사유
  assert.deepEqual(db.state.resolutions, [{ absenceId: "a1", studentId: "s1", resolution: "CARRY", reason: carryRules.ILLNESS_UNPAID_REDUCE_REASON, actorUserId: "admin-1" }]);
  // 청구 변경 기록: 새 action 하나, 사유 글(건강 정보) 없이 계산 근거만
  assert.equal(db.state.audits.length, 1);
  const audit = db.state.audits[0];
  assert.deepEqual([audit.paymentId, audit.actorId, audit.actorType, audit.action], ["pay-nov", "admin-1", "ADMIN", "ILLNESS_ABSENCE_UNPAID_REDUCED"]);
  assert.deepEqual(audit.metadata, { absenceId: "a1", absenceDate: "2026-11-07", classId: "c1", originMonth: "2026-11", tuition: 100000, sessions: 4, unit: 25000, source: "PAID_PAYMENT", before: 100000, after: 75000, reduceBy: 25000 });
  // 두 번 누르면 «이미 처리한 결석»으로 막는다(이중 감액 없음)
  await assert.rejects(() => approve(db, { expected: SEE(25000, 50000) }), /미처리 결석만/);
  assert.equal(db.state.payments[0].amount, 75000);
});

test("잠금 순서: 작업대 전역 잠금 → 결석 행 → (대상 청구 id 읽기) → 결제 잠금 → 청구 행 FOR UPDATE → 결제 진행 판정 → 조건부 UPDATE", async () => {
  const db = fakeDb();
  await approve(db, { expected: SEE(25000, 75000) });
  assert.deepEqual(db.state.events, ["workbench-lock", "absence-row-lock", "checkout-lock:stiz-payment-checkout:pay-nov", "payment-row-lock:pay-nov", "checkout-active", "payment-update"]);
  // 코드 순서로도 못박는다: 결제 잠금 → 행 잠금 → 잠근 뒤 근거 다시 읽기
  const source = read("src/lib/regular/illness-unpaid-reduce.ts");
  const order = ["await readUnpaidEvidenceInTx(tx, input, false)", "await lockPaymentsForCheckout(tx, [paymentId])", `FOR UPDATE OF p`, "await readUnpaidEvidenceInTx(tx, input, true)", "findParentCheckoutActivePaymentIds(tx, [paymentId], nowMs)"];
  order.reduce((from, piece) => { const at = source.indexOf(piece, from); assert.ok(at >= from, `순서가 어긋남: ${piece}`); return at; }, 0);
  // 금액을 줄이는 UPDATE 는 휴원 정산과 같은 함수 한 곳
  assert.match(source, /await reduceUnpaidPayment\(tx, \{\s+paymentId: plan\.paymentId, expectedAmount: plan\.before, reduceBy: plan\.reduceBy, adminUserId: actorId,\s+action: ILLNESS_UNPAID_REDUCE_ACTION/);
  assert.doesNotMatch(source, /UPDATE "Payment"/, "연결부에 청구 UPDATE 문이 따로 없다");
  // 승인 함수: 전역 잠금·결석 행 잠금 뒤에 갈래를 정한다
  const carryAdmin = read("src/lib/regular/illness-carry-admin.ts");
  const approveLib = carryAdmin.slice(carryAdmin.indexOf("export async function approveIllnessCarry("), carryAdmin.indexOf("/** [보강권으로]"));
  ["hashtext('STIZ_BILLING_WORKBENCH')", "${ABSENCE_SELECT} FOR UPDATE", "await readApprovalMode(tx, absence, month, calendar)", "await reduceUnpaidForIllnessAbsenceInTx(tx, {", "if (carryReady && approvalExpectationMismatch(input.expected, { mode: \"CARRY\" }))"]
    .reduce((from, piece) => { const at = approveLib.indexOf(piece, from); assert.ok(at >= from, `순서가 어긋남: ${piece}`); return at; }, 0);
  // 토스·현장 결제 코드는 건드리지 않는다 — 읽기·잠금 함수만 부른다
  assert.doesNotMatch(source, /from "@\/lib\/(pos|payments\/toss)/);
});

const issuedDraft = (over = {}) => ({
  studentId: "s1", classId: "c1", month: "2026-11", status: "ISSUED", paymentId: "pay-nov",
  payload: { baseAmount: 100000, discountAmount: 10000, prorationAmount: 0, carryAmount: 0, shuttleAmount: 20000 },
  periodStart: "2026-11-07", periodEnd: "2026-11-28", scheduledDates: NOV, calculationBasis: {}, ...over,
});

test("발행 초안에 연결된 청구: 수강료(기본−할인)로 나누고 청구 금액에서 뺀다 — 그 뒤에도 «정본 불일치»가 나지 않는다", async () => {
  // 발행 금액 = 100,000 − 10,000 + 셔틀 20,000 = 110,000. 1회 값 = 90,000 ÷ 4 = 22,500(셔틀비는 수강료가 아니다)
  const db = fakeDb({ payments: [bill({ status: "PENDING", amount: 110000 })], drafts: [issuedDraft()] });
  await approve(db, { expected: SEE(22500, 87500) });
  assert.deepEqual([db.state.payments[0].amount, db.state.invoices[0].amount], [87500, 87500]);
  assert.equal(db.state.audits[0].metadata.source, "WORKBENCH_ISSUED");
  assert.deepEqual([db.state.audits[0].metadata.tuition, db.state.audits[0].metadata.unit], [90000, 22500]);
  // 같은 달 두 번째 결석(아직 미납): 근거가 그대로 읽힌다 — 지금 금액 87,500 + 줄인 22,500 = 발행 금액 110,000
  const second = absence({ id: "a2", date: "2026-11-14", status: "CONFIRMED" });
  const stillUnpaid = await absenceMod.readUnpaidEvidenceInTx(db.tx, { absence: second, originMonth: "2026-11" }, false);
  assert.deepEqual([stillUnpaid.numerator, stillUnpaid.dates.length, stillUnpaid.sourcePaymentId], [90000, 4, "pay-nov"]);
  // 그 청구가 나중에 납부되면: 같은 달 다른 결석의 이월 근거 = 원래 수강료 기준(90,000 ÷ 4 = 22,500)
  db.state.payments[0].status = "PAID"; db.state.invoices[0].status = "PAID";
  assert.deepEqual(await absenceMod.previewCarryEvidence(db.tx, { absence: second, originMonth: "2026-11" }),
    { ok: true, source: "WORKBENCH_ISSUED", tuition: 90000, sessions: 4, unit: 22500, warnings: [] });
  // 줄인 기록 없이 금액만 다르면(사람이 청구서를 고친 경우) 예전처럼 «정본 불일치»로 막는다 — 인정하는 것은 이번 감액뿐이다
  db.state.audits = [];
  const mismatch = await absenceMod.previewCarryEvidence(db.tx, { absence: second, originMonth: "2026-11" });
  assert.equal(mismatch.ok, false); assert.match(mismatch.reason, /정본이 일치하지 않습니다/);
});

test("이후 계산과의 정합: 감액 뒤 납부 → 같은 달 두 번째 결석 이월은 «원래 금액 ÷ 횟수», 미납인 채 두 번째 결석도 같은 1회 값", async () => {
  // 미납인 채 두 번(11/7, 11/14): 100,000 → 75,000 → 50,000 (두 번째도 25,000 — 줄어든 75,000 ÷ 4 = 18,750 이 아니다)
  const db = fakeDb({ absences: [absence(), absence({ id: "a2", date: "2026-11-14" })] });
  await approve(db, { expected: SEE(25000, 75000) });
  await approve(db, { absenceId: "a2", expected: SEE(25000, 50000) });
  assert.deepEqual([db.state.payments[0].amount, db.state.audits.map((a) => a.metadata.reduceBy)], [50000, [25000, 25000]]);
  // 그 뒤 납부 → 세 번째 결석(11/21)의 이월 근거: 지금 금액 50,000 + 줄인 50,000 = 100,000 ÷ 4 = 25,000
  db.state.payments[0].status = "PAID"; db.state.invoices[0].status = "PAID";
  const third = absence({ id: "a3", date: "2026-11-21", status: "CONFIRMED" });
  const preview = await absenceMod.previewCarryEvidence(db.tx, { absence: third, originMonth: "2026-11" });
  assert.deepEqual([preview.ok, preview.source, preview.tuition, preview.sessions, preview.unit], [true, "PAID_PAYMENT", 100000, 4, 25000]);
  // 적립 때 남기는 사본도 같은 값(청구 준비가 «금액 = 납부 금액 + 이미 줄인 금액»으로 다시 본다)
  const evidence = await absenceMod.readClassMonthEvidenceInTx(db.tx, { studentId: "s1", classId: "c1", originMonth: "2026-11" }, false);
  assert.deepEqual(evidence.paidCopy, { paymentAmount: 50000, priorReduction: 50000, warnings: [] });
  // 휴원 정산이 이미 줄인 금액(사이트 채널)과도 더해진다
  db.state.settlementLines = [{ paymentId: "pay-nov", kind: "UNPAID_REDUCE", channel: "SITE", amount: 10000 }];
  assert.equal((await absenceMod.readClassMonthEvidenceInTx(db.tx, { studentId: "s1", classId: "c1", originMonth: "2026-11" }, false)).numerator, 110000);
});

test("납부된 달은 이 길을 지나지 않는다 — 화면이 «청구에서 빼기»를 봤는데 그 사이 납부됐으면 «다시 확인»", async () => {
  const db = fakeDb({ payments: [bill({ status: "PAID" })] });
  await assert.rejects(() => approve(db, { expected: SEE(25000, 75000) }), (error) => error.message === rules.APPROVAL_CHANGED_MESSAGE && error.refreshRequired === true);
  untouched(db);
  assert.deepEqual(db.state.events.filter((e) => e.startsWith("checkout-lock") || e === "payment-update"), [], "청구를 잠그지도 줄이지도 않는다");
});

test("차단: 미납 2건 · 반 없는 청구 · 랠리즈 사본 · 학부모 결제 중 · 현장 결제 요청 중 · 결제 거래 — 사유를 그대로 내고 아무것도 바꾸지 않는다", async () => {
  const cases = [
    ["미납 2건", { payments: [bill(), bill({ id: "pay-nov-2" })] }, /미납 수강료 청구가 여러 건/],
    ["반 없는 미납 청구", { payments: [bill({ classId: null })] }, /반이 지정되지 않은 미납 청구/],
    ["랠리즈 사본", { payments: [bill({ rallyzMirror: true })] }, /랠리즈에서 넘어온 청구/],
    ["학부모 결제 진행 중", { active: new Set(["pay-nov"]) }, /학부모가 결제하는 중/],
    ["현장 결제 요청 중", { payments: [bill({ posBusy: true })] }, /현장 결제 요청 중/],
    ["결제 거래 있음", { payments: [bill({ paidTx: true })] }, /결제 거래 기록이 있는 청구/],
    ["수업일이 아닌 날", { absences: [absence({ date: "2026-11-08" })] }, /예정 수업일에 포함되는지/],
    ["이미 보강을 들은 결석", { credits: [{ id: "credit-1", status: "USED" }] }, /이미 보강에 사용된 결석/],
    ["보강 예약(취소 확인 없음)", { credits: [{ id: "credit-1", status: "RESERVED" }], bookings: [{ id: "book-1", status: "BOOKED" }] }, /보강 예약 취소와 좌석 해제/],
    ["출결이 결석과 다름", { attendance: [{ status: "PRESENT" }] }, /출결이 결석과 일치하지 않습니다/],
    ["승인·정산된 기간의 결석", { periodDecided: ["a1"] }, /기간 정산에서 한 번에 처리합니다/],
    ["이미 정산된 결석", { resolutions: [{ absenceId: "a1", resolution: "MAKEUP", reason: "x" }] }, /미처리 결석만/],
  ];
  for (const [name, init, reason] of cases) {
    const db = fakeDb(init);
    const amounts = db.state.payments.map((p) => p.amount), resolutions = db.state.resolutions.length;
    await assert.rejects(() => approve(db, { expected: SEE(25000, 75000) }), reason, name);
    assert.equal(db.state.absences[0].status, "REPORTED", `${name}: 결석 확정까지 되돌린다`);
    assert.deepEqual(db.state.payments.map((p) => p.amount), amounts, name);
    assert.deepEqual([db.state.audits.length, db.state.resolutions.length, db.state.reviews.length], [0, resolutions, 0], name);
    assert.ok(!db.state.events.includes("payment-update"), name);
  }
  // 휴원 정산이 이미 처리한 날: 미납 청구에서 다시 빼지 않는다 — 이월 쪽 기존 규칙으로 넘어가 그 사유로 거절된다
  // (이 파일의 청구 준비 읽기는 대역이라 사유 글자는 상세 미리보기로 확인하고, 승인은 «아무것도 바뀌지 않음»만 본다)
  const settled = fakeDb({ pauseSettled: [{ studentId: "s1", classId: "c1", missedDates: ["2026-11-07"], kind: "UNPAID_REDUCE" }] });
  const settledDetail = await admin.readIllnessCarryDetail(settled.tx, "a1", true, undefined);
  assert.deepEqual([settledDetail.reduce, settledDetail.blocker], [null, "휴원 정산에서 처리한 날입니다. 같은 날을 이월로 다시 보상할 수 없습니다."]);
  await assert.rejects(() => approve(settled, { expected: SEE(25000, 75000) })); untouched(settled);
  assert.ok(!settled.state.events.some((e) => e.startsWith("checkout-lock") || e === "payment-update"), "청구를 잠그지도 줄이지도 않는다");
  // 아직 오지 않은 결석일 · 저장 스위치 꺼짐 · 증빙 확인 없음 — 기존 승인과 같은 앞문
  let db = fakeDb({ absences: [absence({ date: "2099-01-03" })] });
  await assert.rejects(() => approve(db, { expected: SEE(25000, 75000) }), /결석일이 지난 뒤/); untouched(db);
  db = fakeDb(); await assert.rejects(() => admin.approveIllnessCarry(db, { absenceId: "a1", evidenceConfirmed: true, expected: SEE(25000, 75000) }, "admin-1", false), /꺼져 있어/); untouched(db);
  db = fakeDb(); await assert.rejects(() => approve(db, { evidenceConfirmed: false, expected: SEE(25000, 75000) }), /증빙을 확인했는지/); untouched(db);
  // 보강 예약은 «함께 취소» 확인이 있으면 취소하고 진행한다
  db = fakeDb({ credits: [{ id: "credit-1", status: "RESERVED" }], bookings: [{ id: "book-1", status: "BOOKED" }] });
  await approve(db, { cancelReservation: true, expected: SEE(25000, 75000) });
  assert.deepEqual([db.state.bookings[0].status, db.state.credits[0].status, db.state.payments[0].amount], ["CANCELLED", "REVOKED", 75000]);
});

test("금액 불일치: 화면이 본 금액·방식과 다르면 «다시 확인»으로 거절 — 조건부 UPDATE 가 0행이어도 전부 되돌린다", async () => {
  // 화면이 본 뒤 청구 금액이 바뀌었다(다른 관리자가 청구서를 90,000 으로 수정) → 서버가 다시 계산한 값과 다르다
  let db = fakeDb({ payments: [bill({ amount: 90000 })] });
  await assert.rejects(() => approve(db, { expected: SEE(25000, 75000) }), (error) => error.message === rules.APPROVAL_CHANGED_MESSAGE);
  untouched(db, 90000);
  // 화면이 이월로 봤거나(예전 화면이 열려 있었다) 아무것도 안 보냈으면 미납 청구를 줄이지 않는다
  for (const expected of [{ mode: "CARRY" }, null, undefined]) {
    db = fakeDb();
    await assert.rejects(() => approve(db, { expected }), (error) => error.message === rules.APPROVAL_CHANGED_MESSAGE, JSON.stringify(expected));
    untouched(db);
  }
  // 금액을 볼 수 없는 역할은 방식만 보낸다 → 방식이 같으면 승인된다
  db = fakeDb();
  await approve(db, { expected: { mode: "REDUCE", reduceBy: null, after: null } });
  assert.equal(db.state.payments[0].amount, 75000);
  // 읽은 뒤 줄이는 순간 청구가 바뀌어 조건부 UPDATE 가 0행 → 결석 확정·기록까지 통째로 되돌린다
  db = fakeDb({ failPaymentUpdate: true });
  await assert.rejects(() => approve(db, { expected: SEE(25000, 75000) }), (error) => error.message === rules.UNPAID_REDUCE_CONFLICT_MESSAGE && error.refreshRequired === true);
  untouched(db);
});

test("0원: 한 번 값이 청구 금액 전부면 청구·청구서를 취소 상태로 둔다(0원 미납이 남지 않는다)", async () => {
  setDates({ "2026-11": ["2026-11-07"] }); // 그 달 수업이 1회뿐인 반
  try {
    // 이월과 묶인 청구가 0원이 되는 감액은 막는다(쓴 이월이 풀려 다시 쓰이는 이중 보상 방지)
    const linked = fakeDb({ payments: [bill({ amount: 30000, carryLinked: true })] });
    await assert.rejects(() => approve(linked, { expected: SEE(30000, 0) }), /이월과 묶인 청구라 0원으로 줄일 수 없어요/); untouched(linked, 30000);
    const db = fakeDb({ payments: [bill({ amount: 30000 })] });
    await approve(db, { expected: SEE(30000, 0) });
    assert.deepEqual([db.state.payments[0].amount, db.state.payments[0].status], [0, "CANCELED"]);
    assert.deepEqual([db.state.invoices[0].amount, db.state.invoices[0].status], [0, "CANCELED"]);
    assert.deepEqual([db.state.audits[0].metadata.before, db.state.audits[0].metadata.after], [30000, 0]);
    assert.equal(db.state.resolutions.length, 1, "결석은 정산된 것으로 남는다(보강권이 다시 나가지 않는다)");
  } finally { setDates(); }
});

test("월중 등록: 개시일 이후 수업 횟수로 나눈다(이월 근거와 같은 규칙) — 경고 글이 화면까지 간다", async () => {
  const db = fakeDb({ absences: [absence({ date: "2026-11-14" })], payments: [bill({ amount: 75000 })], enrollments: [{ studentId: "s1", classId: "c1", startsOn: "2026-11-14" }] });
  const detail = await admin.readIllnessCarryDetail(db.tx, "a1", true, undefined);
  assert.deepEqual([detail.reduce.tuition, detail.reduce.sessions, detail.reduce.unit, detail.reduce.after], [75000, 3, 25000, 50000]);
  assert.match(detail.reduce.warnings[0], /월중 등록\(개시일 2026-11-14\).*3회/);
  // 개시일 전의 날은 그 아이의 수업일이 아니다
  const early = fakeDb({ enrollments: [{ studentId: "s1", classId: "c1", startsOn: "2026-11-14" }] });
  await assert.rejects(() => approve(early, { expected: SEE(33333, 66667) }), /예정 수업일에 포함되는지/);
});

// ── 3) 신청함 상세(미리보기) ──────────────────────────────────────────────────
const detailOf = (db) => admin.readIllnessCarryDetail({
  async $queryRawUnsafe(sql, ...v) { assert.doesNotMatch(sql, /FOR SHARE|FOR UPDATE/, "미리보기는 행을 잠그지 않는다"); return db.tx.$queryRawUnsafe(sql, ...v); },
  async $executeRawUnsafe() { throw new Error("미리보기는 아무것도 쓰지 않는다"); },
}, "a1", true, undefined);

test("신청함 상세: 미납이면 «납부한 뒤에»로 막지 않고 근거(얼마를 빼고 얼마가 남는지)를 내려준다 — 승인 뒤에는 «청구에서 뺌»", async () => {
  const db = fakeDb();
  const before = await detailOf(db);
  assert.deepEqual([before.status, before.blocker, before.evidence, before.reduced], ["PENDING", null, null, false]);
  assert.deepEqual(before.reduce, { month: "2026-11", tuition: 100000, sessions: 4, unit: 25000, before: 100000, reduceBy: 25000, after: 75000, warnings: [] });
  assert.deepEqual(db.state.events.filter((e) => e !== "checkout-active"), [], "잠금 없이 읽기만");
  // 화면이 본 값 그대로 승인하면 통과한다(미리보기와 실행이 같은 규칙)
  await approve(db, { expected: SEE(before.reduce.reduceBy, before.reduce.after) });
  const after = await detailOf(db);
  assert.deepEqual([after.status, after.reduced, after.reduce, after.blocker], ["APPROVED", true, null, null]);
  // 뺄 수 없는 사유는 버튼 위에 그대로(«납부한 뒤에»가 아니다)
  const two = await detailOf(fakeDb({ payments: [bill(), bill({ id: "pay-nov-2" })] }));
  assert.deepEqual([two.reduce, two.evidence], [null, null]); assert.match(two.blocker, /미납 수강료 청구가 여러 건/);
  const busy = await detailOf(fakeDb({ active: new Set(["pay-nov"]) }));
  assert.match(busy.blocker, /학부모가 결제하는 중/);
  const classless = await detailOf(fakeDb({ payments: [bill({ classId: null })] }));
  assert.match(classless.blocker, /반이 지정되지 않은 미납 청구/);
  for (const d of [two, busy, classless]) assert.doesNotMatch(d.blocker, /납부한 뒤에/);
  // 청구 자체가 없는 달은 지금처럼 «발행한 뒤에»
  const none = await detailOf(fakeDb({ payments: [] }));
  assert.deepEqual([none.reduce, none.evidence], [null, null]); assert.match(none.blocker, /청구를 발행한 뒤/);
  // 결석일 전·보강 사용 같은 앞선 사유가 먼저다
  assert.match((await detailOf(fakeDb({ credits: [{ id: "credit-1", status: "USED" }] }))).blocker, /이미 보강을 들은/);
  // 납부된 달은 기존 이월 근거 그대로(reduce 없음)
  const paid = await detailOf(fakeDb({ payments: [bill({ status: "PAID" })] }));
  assert.deepEqual([paid.reduce, paid.blocker], [null, null]);
  assert.deepEqual(paid.evidence, { kind: "PAID_PAYMENT", month: "2026-11", tuition: 100000, sessions: 4, unit: 25000, warnings: [] });
  // 발행 초안이 미납인 달도 같은 길(예전엔 «납부된 뒤에 이월»로 막혔다)
  const draft = await detailOf(fakeDb({ payments: [bill({ status: "PENDING", amount: 110000 })], drafts: [issuedDraft()] }));
  assert.deepEqual([draft.blocker, draft.reduce.tuition, draft.reduce.unit, draft.reduce.before, draft.reduce.after], [null, 90000, 22500, 110000, 87500]);
});

// ── 4) 연결부(글자·권한·알림·다른 계산) ────────────────────────────────────────
test("서버 액션: 금액은 원장에게만 · 화면이 본 것을 다시 견준다 · 알림은 앱 알림 하나(금액 없음·문자 없음)", () => {
  const action = read("src/app/actions/illness-carry-admin.ts");
  // 부원장 응답에서 금액 칸 제거(기존 evidence 숨김과 같은 자리)
  assert.match(action, /if \(detail\.reduce && !canSeeAllMoney\(admin\.appUserRole\)\) detail\.reduce = maskUnpaidReduceView\(detail\.reduce\);/);
  // 화면이 보낸 «본 것»은 안전한 모양으로 바꿔 승인 함수에 넘긴다
  assert.match(action, /expected: parseApprovalExpectation\(input\?\.expected\),/);
  // 같은 기간 함께 승인: 건마다 서버가 방금 읽은 상세로 «본 것»을 만든다(이월·감액 모두)
  assert.match(action, /const current = id === absenceId && done\.length === 0 \? detail : await readIllnessCarryDetail\(prisma, id, writesEnabled\(\), calendar\);/);
  assert.match(action, /return detail\.reduce \? \{ mode: "REDUCE", reduceBy: detail\.reduce\.reduceBy, after: detail\.reduce\.after \} : \{ mode: "CARRY" \};/);
  // 알림: 기존 앱 알림 함수만. 문자·알림톡을 새로 만들지 않는다
  assert.doesNotMatch(action, /sendTrackedSms|alimtalk|sendSms|solapi/i);
  assert.equal(action.split("notifyParentsOfStudents(").length - 1, 2, "승인 알림(공용 함수 1곳) + 보강권 전환 알림 1곳");
  const notice = action.slice(action.indexOf("function approvalNotice("), action.indexOf("/** 상세(서버가 방금 읽은 것)"));
  assert.doesNotMatch(notice, /원\b|toLocaleString|reduceBy|after|tuition/, "알림 글에 금액을 넣지 않는다");
  assert.match(notice, /그 달 수강료에서 \$\{count\}을 뺐어요\./);
});

test("화면 글자: 신청함 버튼·승인 뒤 상태·학부모 상태가 «이월 승인»과 구분된다 — 아이콘 없이 글자", () => {
  assert.equal(carryRules.UNPAID_REDUCE_ADMIN_BUTTON, "결석 인정 · 청구에서 빼기");
  assert.equal(carryRules.UNPAID_REDUCE_ADMIN_DONE_LABEL, "결석 인정 · 청구에서 뺌");
  assert.equal(carryRules.UNPAID_REDUCE_PARENT_LABEL, "결석 인정 · 수강료에서 뺐어요");
  assert.equal(carryRules.UNPAID_REDUCE_PARENT_NOTE, "그 달 수강료에서 1회분을 뺐어요.", "학부모 글에 금액 없음");
  // 정산 기록 사유는 SQL 글자에 그대로 들어간다 — 작은따옴표가 없어야 한다
  assert.doesNotMatch(carryRules.ILLNESS_UNPAID_REDUCE_REASON, /'/);
  assert.equal(carryRules.illnessUnpaidReducedSql("ra"),
    `EXISTS (SELECT 1 FROM "BillingAbsenceResolution" reduced_resolution WHERE reduced_resolution."absenceId" = ra.id AND reduced_resolution.reason = '질병·부상 결석 인정 — 미납 청구에서 1회분 감액')`);
  // 신청함 상세 화면
  const screen = read("src/app/admin/inbox/IllnessCarryInboxDetail.tsx");
  assert.match(screen, /const approveLabel = reduce \? UNPAID_REDUCE_ADMIN_BUTTON : "이월 승인";/);
  assert.match(screen, /\{reduce && \(\s+<div className="text-sm text-\[var\(--color-academy-ink\)\]">\s+<p>\{unpaidReduceEvidenceLine\(reduce\)\}<\/p>/);
  assert.match(screen, /const expected = reduce \? \{ mode: "REDUCE" as const, reduceBy: reduce\.reduceBy, after: reduce\.after \} : \{ mode: "CARRY" as const \};/);
  assert.match(screen, /detail\.reduced \? `\$\{UNPAID_REDUCE_ADMIN_DONE_LABEL\} — 그 달 미납 청구에서 1회분을 뺀 결석입니다\.`/);
  assert.doesNotMatch(screen, /material-symbols|font-(extrabold|black)|#[0-9a-fA-F]{6}\b/, "아이콘·800/900 굵기·색 코드 없음");
  // 신청함 목록: 승인 중 «뺀 결석»은 따로 REDUCED — 글자는 규칙 모듈과 같다
  const inbox = read("src/lib/requests/admin-inbox.ts");
  assert.match(inbox, /CASE WHEN r\.status = 'APPROVED' AND \$\{illnessUnpaidReducedSql\("x"\)\} THEN 'REDUCED'\s+WHEN r\.status = 'APPROVED' THEN 'APPROVED'/);
  assert.match(read("src/lib/requests/catalog.ts"), new RegExp(`REDUCED: ok\\("${carryRules.UNPAID_REDUCE_ADMIN_DONE_LABEL}"\\),`));
  // 학부모 화면: 목록 글자·결과 한 줄·날짜 줄 글자
  const parent = read("src/lib/regular/parent-regular-absence.ts");
  assert.match(parent, /const reducedSql = reducedTable\[0\]\?\.found \? illnessUnpaidReducedSql\("ra"\) : `false`;/);
  assert.match(parent, /const reduced = r\.reduced === true && status === "APPROVED" && !amountPending && settledTotal === null && !refundState;/);
  assert.match(parent, /\.\.\.\(reduced \? \{ reduced: true, statusLabel: UNPAID_REDUCE_PARENT_LABEL \} : \{\}\),/);
  const client = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(client, /\{review\.status === "APPROVED" && review\.reduced && \(\s+<p className="mt-1 text-xs text-\[var\(--color-academy-muted\)\]">\{UNPAID_REDUCE_PARENT_NOTE\}<\/p>/);
  assert.match(client, /const reviewLabel = d\.carryReduced \? UNPAID_REDUCE_PARENT_LABEL : d\.carryAmountPending \? PERIOD_APPROVED_DAY_LABEL : illnessReviewLabel\(d\.carryReview\);/);
});

test("학부모 목록 묶기: 같은 기간이라도 이월로 적립한 날과 미납 청구에서 뺀 날은 다른 줄", () => {
  const row = (absenceId, date, reduced) => ({ absenceId, periodId: "period-1", status: "APPROVED", date, dateLabel: date.slice(5), className: "토요반", ...(reduced ? { reduced: true, statusLabel: carryRules.UNPAID_REDUCE_PARENT_LABEL } : { statusLabel: "이월 승인" }) });
  const collapsed = carryRules.collapseReviewsByPeriod([row("a4", "2026-12-05", false), row("a3", "2026-11-28", true), row("a2", "2026-11-21", true), row("a1", "2026-10-31", false)]);
  assert.deepEqual(collapsed.map((r) => [r.statusLabel, r.count, r.dateLabel]), [["이월 승인", 2, "10-31~12-05 2회"], [carryRules.UNPAID_REDUCE_PARENT_LABEL, 2, "11-21~11-28 2회"]]);
  // reduced 가 없는 기존 줄은 예전처럼 한 줄로 묶인다
  assert.equal(carryRules.collapseReviewsByPeriod([row("a2", "2026-11-21", false), row("a1", "2026-11-14", false)]).length, 1);
});

test("다른 계산과의 정합: 같은 action 글자를 읽는다 — 휴원 정산(원래 금액·이미 뺀 날) · 청구 준비(발행 금액 대조) · 발행 보류(건너뛰기)", () => {
  assert.equal(model.ILLNESS_UNPAID_REDUCE_ACTION, "ILLNESS_ABSENCE_UNPAID_REDUCED");
  assert.equal(model.illnessReducedSumSql("p.id"),
    `(SELECT COALESCE(SUM((illness_cut.metadata->>'reduceBy')::int),0)::int FROM "PaymentAuditLog" illness_cut WHERE illness_cut."paymentId" = p.id AND illness_cut.action = 'ILLNESS_ABSENCE_UNPAID_REDUCED')`);
  // 휴원 정산은 이 모듈을 import 하지 않고 같은 글자를 적어 둔다 — 한쪽만 바뀌면 여기서 깨진다
  const pause = read("src/lib/enrollment/pause-settlement.ts");
  assert.ok(pause.includes(`const ILLNESS_REDUCED_P = \`${model.illnessReducedSumSql("p.id")}\`;`), "휴원 정산의 «이미 줄인 금액» 조각 = 공용 조각");
  assert.match(pause, /const ILLNESS_REDUCED_DATES_P = `\(SELECT COALESCE\(jsonb_agg\(illness_cut\.metadata->>'absenceDate'\), '\[\]'::jsonb\) FROM "PaymentAuditLog" illness_cut WHERE illness_cut\."paymentId" = p\.id AND illness_cut\.action = 'ILLNESS_ABSENCE_UNPAID_REDUCED'\)`;/);
  assert.match(pause, /\$\{ILLNESS_REDUCED_P\} AS "illnessReduced", \$\{ILLNESS_REDUCED_DATES_P\} AS "illnessDates"/);
  // 1회 값은 원래 금액 기준(priorReduction), 그날은 다시 빼지 않는다(settledDates)
  assert.match(pause, /priorReduction: \(reduced\.get\(String\(row\.id\)\) \?\? 0\) \+ Number\(row\.illnessReduced \?\? 0\),/);
  assert.match(pause, /settledDates: \[\.\.\.\(settled\.get\(String\(row\.id\)\) \?\? \[\]\), \.\.\.\(Array\.isArray\(row\.illnessDates\)/);
  assert.match(pause, /export async function reduceUnpaidPayment\(/, "감액 UPDATE 는 휴원 정산과 같은 함수");
  // 이월 근거: 발행 금액 대조와 «이미 줄인 금액»에 이번 감액을 더한다(납부·미납 근거 공통)
  const absenceSource = read("src/lib/billing/workbench-absence.ts");
  assert.match(absenceSource, /p\.amount\+Number\(p\.illnessReduced\?\?0\)!==workbenchTotal\(issuedRow\.payload\)/);
  assert.match(absenceSource, /priorReduction:Number\(reduced\.find\(r=>r\.paymentId===p\.id\)\?\.total\?\?0\)\+Number\(p\.illnessReduced\?\?0\)/);
  // 청구 준비 화면: 같은 비교. 줄인 적 없는 청구는 지문(sourceVersion)에 새 칸을 넣지 않는다
  const service = read("src/lib/billing/workbench-service.ts");
  assert.match(service, /p\.amount\+\(p\.illnessReduced\?\?0\)!==workbenchTotal\(issued\.payload\)/);
  assert.match(service, /Number\(illnessReduced \?\? 0\) > 0 \? \{ \.\.\.row, illnessReduced: Number\(illnessReduced\) \} : row\)/);
  // 발행 보류: 이번 감액이 있는 청구는 휴원 정산 반영 청구처럼 건너뛴다(취소 후 재발행하면 뺀 금액이 사라진다)
  const hold = read("src/lib/regular/illness-period-admin.ts");
  assert.match(hold, /\$\{illnessReducedSumSql\("p\.id"\)\} > 0 AS "illnessReduced"/);
  assert.match(hold, /: row\.pauseSettled \? "PAUSE_SETTLED"\s+: row\.illnessReduced \? "ILLNESS_REDUCED"/);
  // 같은 결석을 보강으로 또 보상하지 않는다 — 보강 입구는 정산 기록(CARRY)이 있으면 막는다(기존 가드 그대로)
  assert.match(read("src/lib/billing/absence-compensation-guard.ts"), /r\.resolution='CARRY' LIMIT 1/);
});

test("발행 보류 건너뛰기 사유·신청함 상태 지도에 새 값이 들어 있다", async () => {
  const periodRules = await loadTsModule("src/lib/regular/illnessPeriodRules.ts");
  assert.match(periodRules.HOLD_SKIP_REASONS.ILLNESS_REDUCED, /질병·부상 결석으로 1회분을 뺀 청구/);
  const catalog = await loadTsModule("src/lib/requests/catalog.ts");
  assert.equal(catalog.statusLabel("ILLNESS_CARRY", "REDUCED"), carryRules.UNPAID_REDUCE_ADMIN_DONE_LABEL);
  assert.equal(catalog.statusLabel("ILLNESS_CARRY", "APPROVED"), "이월 승인", "납부된 달의 글자는 그대로");
  assert.equal(catalog.bucketFor("ILLNESS_CARRY", "REDUCED"), catalog.bucketFor("ILLNESS_CARRY", "APPROVED"), "완료 쪽에 함께 놓인다");
});

test("3회 달을 세 번 다 빼면 반올림 찌꺼기 없이 0원으로 끝난다", () => {
  // 100,000 ÷ 3 = 33,333원 → 100,000 → 66,667 → 33,334 → 0 (1원이 남지 않는다)
  let amount = 100000;
  const steps = [];
  for (let i = 0; i < 3; i += 1) {
    const plan = rules.planUnpaidReduce({ tuition: 100000, sessions: 3, paymentAmount: amount });
    assert.equal(plan.ok, true);
    steps.push(plan.after);
    amount = plan.after;
  }
  assert.deepEqual(steps, [66667, 33334, 0]);
  // 남는 금액이 수업 횟수(원) 이상이면 건드리지 않는다 — 셔틀비가 섞인 청구의 남은 금액을 지우지 않는다
  assert.equal(rules.planUnpaidReduce({ tuition: 90000, sessions: 4, paymentAmount: 42500 }).after, 20000);
  assert.equal(rules.planUnpaidReduce({ tuition: 100000, sessions: 3, paymentAmount: 33340 }).after, 7);
});

test("결석 쪽 검사 문구는 기존 이월 승인(resolveWorkbenchAbsence)과 같은 글자다 — 두 경로가 따로 놀지 않게", () => {
  const carry = read("src/lib/billing/workbench-absence.ts");
  const reduce = read("src/lib/regular/illness-unpaid-reduce.ts");
  for (const message of [
    "이미 보강에 사용된 결석입니다. 자동 이월하지 않고 별도 확인이 필요합니다.",
    "보강 예약 취소와 좌석 해제를 확인해 주세요.",
    "출결이 결석과 일치하지 않습니다. 출석·지각 정정 내역을 먼저 확인해 주세요.",
    "통합되거나 변경된 학생입니다. 현재 학생으로 다시 조회해 주세요.",
    "확인된 미처리 결석만 처리할 수 있습니다.",
  ]) {
    assert.ok(carry.includes(message), `이월 쪽에 없음: ${message}`);
    assert.ok(reduce.includes(message), `감액 쪽에 없음: ${message}`);
  }
  // 보강 사용·예약·출결을 가르는 상태 값도 같은 집합
  for (const fragment of [`["USED","NO_SHOW"]`, `["ATTENDED","NO_SHOW"]`]) assert.ok(carry.includes(fragment));
  for (const fragment of [`["USED", "NO_SHOW"]`, `["ATTENDED", "NO_SHOW"]`]) assert.ok(reduce.includes(fragment));
});
