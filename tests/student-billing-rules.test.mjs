// 학생 상세 «청구/수납» 탭 — 청구서 발행·수정·삭제 회귀 테스트(2026-11-09 원장 지시).
//
// 원장 지시: «학생 상세에서 청구/수납으로 변경해서 상세페이지에서도 청구서 발행, 수정, 삭제할 수 있도록».
// 위험은 넷이다.
//  ① 청구 월이 시간대·납부기한 때문에 엉뚱한 달로 저장되는 것 → 순수 규칙 + createPayment 실제 실행
//  ② 작업대(청구 준비) 쓰기가 꺼졌는데도 수강료 발행이 막히는 것(신규생 수강료 발행 불가) → 실제 실행
//  ③ 같은 달 같은 청구가 확인 없이 두 번 생기는 것 → 순수 판정 + 실제 실행(force 없으면 INSERT 0)
//  ④ 납부·POS·학부모 결제 진행 중인 청구의 금액이 바뀌는 것 / 남의 학생 청구가 바뀌는 것 → 순수 판정 + SQL 계약
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/payments/studentBillingRules.ts");
const actions = await readFile("src/app/actions/admin.ts", "utf8");
const route = await readFile("src/app/api/admin/billing-workbench/route.ts", "utf8");
const detail = await readFile("src/app/admin/students/[id]/StudentDetailClient.tsx", "utf8");
const modals = await readFile("src/app/admin/students/[id]/StudentBillingModals.tsx", "utf8");
const finance = await readFile("src/app/admin/finance/FinanceClient.tsx", "utf8");
const queries = await readFile("src/lib/queries.ts", "utf8");

const createSource = actions.slice(
  actions.indexOf("export async function createPayment"),
  actions.indexOf("export async function cancelUnpaidPayment"),
);
const updateSource = actions.slice(
  actions.indexOf("export async function updateUnpaidPayment"),
  actions.indexOf("let _galleryInstagramColumnsEnsured"),
);

// ── ① 청구 월 결정 ───────────────────────────────────────────────────────────
test("청구 월: 화면이 보낸 청구 월이 납부기한보다 우선한다(11월분 기한 10-31 → 11월)", () => {
  assert.deepEqual(rules.resolveBillingPeriod({ billingMonth: "2026-11", dueDate: "2026-10-31" }), { year: 2026, month: 11 });
  assert.deepEqual(rules.resolveBillingPeriod({ billingMonth: "2027-01", dueDate: "2026-12-31" }), { year: 2027, month: 1 });
});

test("청구 월: 없으면 납부기한 문자열의 앞부분 — 1일이 전달로 밀리지 않는다(예전 getMonth 버그)", () => {
  assert.deepEqual(rules.resolveBillingPeriod({ dueDate: "2026-11-01" }), { year: 2026, month: 11 });
  assert.deepEqual(rules.resolveBillingPeriod({ dueDate: "2027-01-01" }), { year: 2027, month: 1 });
  assert.deepEqual(rules.resolveBillingPeriod({ billingMonth: "", dueDate: "2026-12-31" }), { year: 2026, month: 12 });
});

test("청구 월·기한: 잘못된 값은 거절한다", () => {
  assert.throws(() => rules.resolveBillingPeriod({ billingMonth: "2026-13", dueDate: "2026-11-01" }), /청구 월/);
  assert.throws(() => rules.resolveBillingPeriod({ billingMonth: "2026-1", dueDate: "2026-11-01" }), /청구 월/);
  assert.throws(() => rules.resolveBillingPeriod({ dueDate: "2026-02-30" }), /납부 기한/);
  assert.throws(() => rules.normalizeDueYmd("2026/11/01"), /납부 기한/);
  assert.equal(rules.normalizeDueYmd(" 2028-02-29 "), "2028-02-29"); // 윤년
});

test("설명 기본값은 «N월 유형»", () => {
  assert.equal(rules.defaultBillingDescription("MONTHLY", "2026-11"), "11월 수강료");
  assert.equal(rules.defaultBillingDescription("SHUTTLE", "2027-01"), "1월 셔틀비");
});

// ── ② 작업대 차단 조건 ───────────────────────────────────────────────────────
test("작업대 차단: 쓰기가 켜졌을 때만 수강료·셔틀비를 막는다", () => {
  assert.equal(rules.manualChargeBlockedByWorkbench("MONTHLY", true), true);
  assert.equal(rules.manualChargeBlockedByWorkbench("SHUTTLE", true), true);
  assert.equal(rules.manualChargeBlockedByWorkbench("MONTHLY", false), false); // 지금(꺼짐) → 상세에서 발행 가능
  assert.equal(rules.manualChargeBlockedByWorkbench("OTHER", true), false);
  assert.equal(rules.manualChargeBlockedByWorkbench("UNIFORM", true), false);
});

test("작업대 쓰기 스위치는 정확히 \"true\" 일 때만 — 작업대 API 와 같은 기준", () => {
  assert.equal(rules.isBillingWorkbenchWritesEnabled({ STIZ_BILLING_WORKBENCH_WRITES_ENABLED: "true" }), true);
  for (const value of [undefined, "", "1", "TRUE", " true", "yes"]) {
    assert.equal(rules.isBillingWorkbenchWritesEnabled({ STIZ_BILLING_WORKBENCH_WRITES_ENABLED: value }), false, String(value));
  }
  // 작업대 API 쪽 판정과 문구가 같아야 한다(한쪽만 바뀌면 «켜짐»의 뜻이 갈라진다)
  assert.match(route, /STIZ_BILLING_WORKBENCH_WRITES_ENABLED === "true"/);
});

test("createPayment 는 «작업대 표가 있음»으로 막지 않는다(표가 있어도 쓰기가 꺼지면 발행)", () => {
  assert.doesNotMatch(createSource, /to_regclass/);
  assert.match(createSource, /manualChargeBlockedByWorkbench\(paymentType, isBillingWorkbenchWritesEnabled\(process\.env\)\)/);
  assert.doesNotMatch(createSource, /getMonth\(\)|getFullYear\(\)|new Date\(data\.dueDate\)/);
});

// ── ③ 중복 판정 ──────────────────────────────────────────────────────────────
const key = { studentId: "s1", classId: "c1", year: 2026, month: 11, type: "MONTHLY" };
const row = (patch) => ({ id: "p", amount: 1000, status: "PENDING", ...key, ...patch });

test("중복: 같은 학생·반·월·유형의 살아 있는 청구(미납·연체·완납)만 중복", () => {
  for (const status of ["PENDING", "OVERDUE", "PAID"]) assert.equal(rules.isDuplicateCharge(row({ status }), key), true, status);
  for (const status of ["CANCELED", "REFUNDED"]) assert.equal(rules.isDuplicateCharge(row({ status }), key), false, status);
  assert.equal(rules.isDuplicateCharge(row({ classId: "c2" }), key), false);
  assert.equal(rules.isDuplicateCharge(row({ month: 10 }), key), false);
  assert.equal(rules.isDuplicateCharge(row({ year: 2025 }), key), false);
  assert.equal(rules.isDuplicateCharge(row({ type: "SHUTTLE" }), key), false);
  assert.equal(rules.isDuplicateCharge(row({ studentId: "s2" }), key), false);
  // 반 없는 청구(유니폼·기타)끼리는 같은 칸으로 본다
  const other = { ...key, classId: null, type: "OTHER" };
  assert.equal(rules.isDuplicateCharge(row({ classId: null, type: "OTHER" }), other), true);
  assert.equal(rules.isDuplicateCharge(row({ classId: undefined, type: "OTHER" }), other), true);
  assert.deepEqual(rules.findDuplicateCharges([row({ id: "a" }), row({ id: "b", status: "CANCELED" })], key).map((r) => r.id), ["a"]);
});

// ── ④ 수정 가능 여부 ─────────────────────────────────────────────────────────
test("수정 가능: 미납·연체 + 청구서 발행·발송·연체 + POS·학부모 결제에 안 묶인 건만", () => {
  assert.equal(rules.unpaidEditBlockReason({ status: "PENDING", invoiceStatus: "ISSUED" }), null);
  assert.equal(rules.unpaidEditBlockReason({ status: "PENDING", invoiceStatus: "SENT" }), null);
  assert.equal(rules.unpaidEditBlockReason({ status: "OVERDUE", invoiceStatus: "OVERDUE" }), null);
  assert.match(rules.unpaidEditBlockReason({ status: "PAID", invoiceStatus: "PAID" }), /미납·연체/);
  assert.match(rules.unpaidEditBlockReason({ status: "CANCELED", invoiceStatus: "CANCELED" }), /미납·연체/);
  assert.match(rules.unpaidEditBlockReason({ status: "PENDING", invoiceStatus: "ISSUED", posLocked: true }), /POS/);
  assert.match(rules.unpaidEditBlockReason({ status: "PENDING", invoiceStatus: "ISSUED", parentCheckoutActive: true }), /학부모 결제/);
  assert.match(rules.unpaidEditBlockReason({ status: "PENDING", invoiceStatus: null }), /청구서 상태/);
  assert.match(rules.unpaidEditBlockReason({ status: "PENDING", invoiceStatus: "PAID" }), /청구서 상태/);
});

test("POS 묶임 기준은 예전 수납 목록 판정과 모든 경우에 같다", () => {
  // 예전 getPaymentPosInfo: paidLike(PAID 또는 취소 진행) || PENDING·SENT·HELD
  const old = (status, cancelState) => (status === "PAID" || cancelState != null) || ["PENDING", "SENT", "HELD"].includes(status);
  for (const status of ["PENDING", "SENT", "PAID", "HELD", "CANCELED", "EXPIRED", "FAILED", "DONE"]) {
    for (const cancelState of [null, undefined, "REQUESTED"]) {
      assert.equal(rules.isPosRequestLocking(status, cancelState), old(status, cancelState), `${status}/${cancelState}`);
    }
  }
  assert.match(queries, /isPosRequestLocking\(status, row\.cancel_state\)/);
});

test("학부모 결제 진행 = 결제창 열림·진행·가상계좌 입금 대기", () => {
  assert.deepEqual([...rules.PARENT_CHECKOUT_ACTIVE_TX_STATUSES], ["READY", "IN_PROGRESS", "WAITING_FOR_DEPOSIT"]);
});

test("수정 입력 검사와 연체→미납 복귀", () => {
  assert.deepEqual(rules.validateUnpaidEdit({ amount: 150000, description: "  11월 수강료 ", dueDate: "2026-11-20" }), { amount: 150000, description: "11월 수강료", dueDate: "2026-11-20" });
  assert.equal(rules.validateUnpaidEdit({ amount: 1, description: "   ", dueDate: "2026-11-20" }).description, null);
  assert.throws(() => rules.validateUnpaidEdit({ amount: 0, dueDate: "2026-11-20" }), /1원 이상/);
  assert.throws(() => rules.validateUnpaidEdit({ amount: 1.5, dueDate: "2026-11-20" }), /1원 이상/);
  assert.throws(() => rules.validateUnpaidEdit({ amount: 1000, dueDate: "2026-11-31" }), /납부 기한/);
  assert.equal(rules.statusAfterDueDateEdit("OVERDUE", "2026-11-20", "2026-11-09"), "PENDING");
  assert.equal(rules.statusAfterDueDateEdit("OVERDUE", "2026-11-09", "2026-11-09"), "PENDING"); // 오늘까지면 아직 연체 아님
  assert.equal(rules.statusAfterDueDateEdit("OVERDUE", "2026-11-08", "2026-11-09"), "OVERDUE");
  assert.equal(rules.statusAfterDueDateEdit("PENDING", "2026-11-01", "2026-11-09"), "PENDING"); // 연체 전환은 매일 작업이 맡는다
  assert.equal(rules.isDueDatePast("2026-10-31", "2026-11-09"), true);
  assert.equal(rules.isDueDatePast("2026-11-09", "2026-11-09"), false);
});

// ── createPayment 실제 실행(가짜 DB) ──────────────────────────────────────────
function loadCreatePayment({ workbenchEnabled = false, existing = [] } = {}) {
  const calls = { inserts: [], audits: 0, auditMeta: [], revalidated: 0 };
  const tx = {
    $executeRawUnsafe: async (sql, ...values) => {
      if (sql.includes('INSERT INTO "PaymentAuditLog"')) { calls.audits++; calls.auditMeta.push(JSON.parse(values.at(-1))); }
      return 1;
    },
    $queryRawUnsafe: async (sql, ...values) => {
      if (sql.includes("to_regclass")) return [{ found: "BillingWorkbenchDraft" }]; // 표는 «있다»
      if (sql.includes('FROM "Enrollment"')) return [{ id: "e1" }];
      if (sql.includes('FROM "Payment"') && sql.includes("year = $2")) return existing;
      if (sql.includes('INSERT INTO "Payment"')) { calls.inserts.push(values); return [{ id: "new-pay" }]; }
      if (sql.includes('FROM "PaymentInvoice"')) return [{ id: "new-inv" }];
      return [];
    },
  };
  const prisma = { $transaction: async (work) => work(tx), $queryRawUnsafe: tx.$queryRawUnsafe };
  const compiled = ts.transpile(createSource, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const loaded = { exports: {} };
  const deps = {
    module: loaded, exports: loaded.exports, prisma,
    requireAdmin: async () => ({ appUserId: "admin", appUserRole: "ADMIN" }),
    normalizeDueYmd: rules.normalizeDueYmd,
    resolveBillingPeriod: rules.resolveBillingPeriod,
    manualChargeBlockedByWorkbench: rules.manualChargeBlockedByWorkbench,
    isBillingWorkbenchWritesEnabled: rules.isBillingWorkbenchWritesEnabled,
    findDuplicateCharges: rules.findDuplicateCharges,
    normalizeBillingDescription: rules.normalizeBillingDescription,
    process: { env: { STIZ_BILLING_WORKBENCH_WRITES_ENABLED: workbenchEnabled ? "true" : "false" } },
    ensurePaymentInfrastructure: async () => {},
    ensureInvoicesForMonth: async () => ({ invoiceCount: 1 }),
    isBillingParentSendEnabled: () => false,
    notifyParentsOfStudents: async () => { throw new Error("알림이 나가면 안 된다"); },
    revalidateFinanceCaches: () => { calls.revalidated++; },
    revalidatePath: () => {},
    console: { error() {} },
  };
  new Function(...Object.keys(deps), compiled)(...Object.values(deps));
  return { createPayment: loaded.exports.createPayment, calls };
}

const base = { studentId: "s1", classId: "c1", amount: 160000, dueDate: "2026-10-31", billingMonth: "2026-11", type: "MONTHLY", description: "11월 수강료" };

test("실행: 작업대 표가 있어도 쓰기가 꺼져 있으면 수강료를 발행하고, 청구 월은 화면 값(11월)", async () => {
  const { createPayment, calls } = loadCreatePayment();
  const result = await createPayment(base);
  assert.deepEqual(result, { ok: true, invoiceId: "new-inv" });
  assert.equal(calls.inserts.length, 1);
  const [, , , , dueYmd, year, month] = calls.inserts[0];
  assert.equal(dueYmd, "2026-10-31");
  assert.equal(year, 2026);
  assert.equal(month, 11);
  assert.equal(calls.audits, 1);
  assert.equal(calls.auditMeta[0].description, "11월 수강료", "발행 감사 기록에 설명을 남긴다");
  assert.equal(calls.revalidated, 1);
});

test("실행: 발행 설명도 수정과 같은 규칙 — 200자 초과 거절, 공백은 정리", async () => {
  const long = loadCreatePayment();
  await assert.rejects(long.createPayment({ ...base, description: "가".repeat(201) }), /200자/);
  assert.equal(long.calls.inserts.length, 0);
  const trimmed = loadCreatePayment();
  await trimmed.createPayment({ ...base, description: "  11월 수강료  " });
  assert.equal(trimmed.calls.inserts[0][8], "11월 수강료");
  const empty = loadCreatePayment();
  await empty.createPayment({ ...base, description: "   " });
  assert.equal(empty.calls.inserts[0][8], null);
});

test("실행: 작업대 쓰기가 켜져 있으면 지금처럼 청구 준비로 안내하고 INSERT 하지 않는다", async () => {
  const { createPayment, calls } = loadCreatePayment({ workbenchEnabled: true });
  await assert.rejects(createPayment(base), /청구 준비/);
  assert.equal(calls.inserts.length, 0);
  // 유니폼·기타는 작업대와 무관하게 발행된다
  const other = loadCreatePayment({ workbenchEnabled: true });
  assert.equal((await other.createPayment({ ...base, type: "OTHER", classId: null })).ok, true);
});

test("실행: 같은 달 같은 청구가 있으면 force 없이는 INSERT 0, force 면 발행", async () => {
  const existing = [{ id: "old", studentId: "s1", classId: "c1", year: 2026, month: 11, type: "MONTHLY", status: "PENDING", amount: 160000, description: "11월 수강료" }];
  const first = loadCreatePayment({ existing });
  const result = await first.createPayment(base);
  assert.equal(result.ok, false);
  assert.deepEqual(result.duplicates.map((d) => d.id), ["old"]);
  assert.equal(first.calls.inserts.length, 0);
  assert.equal(first.calls.revalidated, 0);

  const forced = loadCreatePayment({ existing });
  assert.equal((await forced.createPayment({ ...base, force: true })).ok, true);
  assert.equal(forced.calls.inserts.length, 1);

  // 취소된 청구만 있으면 경고 없이 발행
  const canceled = loadCreatePayment({ existing: [{ ...existing[0], status: "CANCELED" }] });
  assert.equal((await canceled.createPayment(base)).ok, true);
});

test("실행: 수납 관리 화면 호환 — 청구 월 없이 납부기한만 보내면 그 날짜의 연·월", async () => {
  const { createPayment, calls } = loadCreatePayment();
  await createPayment({ studentId: "s1", amount: 30000, dueDate: "2026-12-01", type: "UNIFORM" });
  const [, , , , , year, month] = calls.inserts[0];
  assert.equal(year, 2026);
  assert.equal(month, 12);
});

// ── 수정 서버 액션 계약(SQL) ─────────────────────────────────────────────────
test("updateUnpaidPayment: 재무 권한 · 학생·미납 조건을 UPDATE 에 · 청구서 동기화 · 감사(되돌릴 값) · 한 트랜잭션", () => {
  assert.match(updateSource, /requireFinanceOwner\(\)/);
  assert.match(updateSource, /validateUnpaidEdit\(input\)/);
  assert.match(updateSource, /WHERE p\.id = \$1 AND p\."studentId" = \$2\s+FOR UPDATE OF p/);
  assert.match(updateSource, /WHERE id = \$1 AND "studentId" = \$2 AND status IN \('PENDING', 'OVERDUE'\)/);
  assert.match(updateSource, /UPDATE "PaymentInvoice"[\s\S]*amount = \$3, title = \$4, description = \$5[\s\S]*"dueDate"[\s\S]*status IN \('ISSUED', 'SENT', 'OVERDUE'\)/);
  assert.match(updateSource, /unpaidEditBlockReason\(/);
  assert.match(updateSource, /findParentCheckoutActivePaymentIds\(tx, \[paymentId\], Date\.now\(\)\)/);
  assert.match(updateSource, /POS_LOCKING_REQUEST_STATUSES/);
  assert.match(updateSource, /PAYMENT_UPDATE_UNPAID/);
  assert.match(updateSource, /rollback:/);
  assert.match(updateSource, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(updateSource, /revalidateFinanceCaches\(\)/);
  assert.doesNotMatch(updateSource, /notifyParent|sendParentSms|DELETE FROM/);
});

// ── 화면 계약 ────────────────────────────────────────────────────────────────
test("상세 탭 이름은 «청구/수납»(key 는 pay 그대로)", () => {
  assert.match(detail, /\{ key: "pay", label: "청구\/수납" \}/);
  assert.match(detail, /청구서 발행/);
  assert.match(detail, /unpaidEditBlockReason\(/);
});

test("상세 삭제는 «청구서 삭제»(취소 처리)만 — 영구 삭제는 넣지 않는다", () => {
  assert.match(modals, /cancelUnpaidPayment\(/);
  assert.doesNotMatch(modals + detail, /deletePayment|영구 삭제/);
  assert.match(modals, /academy-button-danger-solid/);
});

test("발행 창: 학부모 알림 기본 끔 · 잠금이면 못 켬 · 중복이면 «그래도 발행»", () => {
  assert.match(modals, /const \[notifyParent, setNotifyParent\] = useState\(false\)/);
  assert.match(modals, /notifyParent: notifyParent && !notifyDisabled/);
  assert.match(modals, /force: Boolean\(duplicates\)/);
  assert.match(modals, /그래도 발행/);
  assert.match(modals, /monthlyBillingDueDate\(/);
  assert.match(modals, /todayKst\(\)\.slice\(0, 7\)/);
});

test("수납 관리 화면도 중복 결과를 무시하지 않고 확인 후 force 로 다시 부른다", () => {
  assert.match(finance, /if \(!created\.ok\)/);
  assert.match(finance, /force: true/);
});

// ── 검수 지적 반영(2026-11-09) ───────────────────────────────────────────────
test("발행 기본 기한 = max(그 달 청구 기한, 오늘) — 지난 기한이 기본으로 들어가 바로 연체되지 않게", () => {
  assert.equal(rules.defaultIssueDueDate("2026-10-31", "2026-11-09"), "2026-11-09"); // 월중 신규생
  assert.equal(rules.defaultIssueDueDate("2026-11-30", "2026-11-09"), "2026-11-30"); // 다음 달분은 약관 기한 그대로
  assert.equal(rules.defaultIssueDueDate("2026-11-09", "2026-11-09"), "2026-11-09");
  assert.equal(rules.defaultIssueDueDate("", "2026-11-09"), "2026-11-09");
  assert.match(modals, /defaultIssueDueDate\(monthlyDue, todayKst\(\)\)/);
  // 경고는 직접 고른 지난 날짜에만
  assert.match(modals, /const duePast = dueTouched && isDueDatePast\(dueDate, todayKst\(\)\)/);
  assert.match(modals, /const duePast = dueDate !== payment\.dueYmd && isDueDatePast\(dueDate, todayKst\(\)\)/);
});

test("설명 규칙은 발행·수정 공용(200자)", () => {
  assert.equal(rules.normalizeBillingDescription(" a "), "a");
  assert.equal(rules.normalizeBillingDescription(""), null);
  assert.equal(rules.normalizeBillingDescription("가".repeat(200)).length, 200);
  assert.throws(() => rules.normalizeBillingDescription("가".repeat(201)), /200자/);
  assert.throws(() => rules.validateUnpaidEdit({ amount: 1000, description: "가".repeat(201), dueDate: "2026-11-20" }), /200자/);
  assert.match(createSource, /normalizeBillingDescription\(data\.description\)/);
});

test("수정: 완료(DONE) 거래가 있으면 거부 — 청구서 삭제와 같은 검사", () => {
  assert.match(updateSource, /"PaymentTransaction" WHERE "paymentId" = \$1 AND status = 'DONE'/);
  assert.match(updateSource, /DONE_TRANSACTION_BLOCK_MESSAGE/);
  // 결제와 같은 잠금을 판정·UPDATE 보다 먼저
  assert.ok(updateSource.indexOf("lockPaymentsForCheckout(tx, [paymentId])") < updateSource.indexOf("FOR UPDATE OF p"));
});

test("수정·삭제 메뉴는 재무 소유자(원장)에게만 — 서버 requireFinanceOwner 와 같은 기준", async () => {
  const page = await readFile("src/app/admin/students/[id]/page.tsx", "utf8");
  assert.equal(rules.isFinanceOwnerRole("ADMIN"), true);
  for (const role of ["VICE_ADMIN", "INSTRUCTOR", "STAFF", "PARENT", null, undefined]) assert.equal(rules.isFinanceOwnerRole(role), false, String(role));
  assert.match(actions, /async function requireFinanceOwner\(\)[\s\S]*?isFinanceOwnerRole\(admin\.appUserRole\)/);
  assert.match(page, /canManageFinance=\{isFinanceOwnerRole\(adminUser\.appUserRole\)\}/);
  assert.match(detail, /\{unpaidRow && canManageFinance && \(/);
  // 발행 버튼은 권한 조건 없이(관리자 누구나 — 서버 requireAdmin)
  assert.match(detail, /onClick=\{\(\) => setIssueOpen\(true\)\}/);
});
