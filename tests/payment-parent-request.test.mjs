import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 실제 운영(2026-08-09 확인): 수강료는 랠리즈·계좌이체·현장 카드로 받고 시스템엔 결과만
// 기록한다. 그래서 학부모가 입금해도 화면은 한동안 "미납"이라 "입금했는데요" 문자가 온다.
// 영수증은 요청이 올 때만 발급한다(receiptUrl 실제 데이터 0건).

const rulesSource = await readFile("src/lib/payments/parentRequestRules.ts", "utf8");
const { validatePaymentRequest, isUnpaidStatus, PAYMENT_METHODS, RECEIPT_TYPES } = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(rulesSource, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText,
  ).toString("base64")}`
);

const parentLib = await readFile("src/lib/payments/parent-payment-request.ts", "utf8");
const adminLib = await readFile("src/lib/payments/admin-payment-request.ts", "utf8");

const UNPAID = { paymentStatus: "PENDING", today: "2026-08-09" };
const PAID = { paymentStatus: "PAID", today: "2026-08-09" };

test("미납 상태 판정", () => {
  assert.equal(isUnpaidStatus("PENDING"), true);
  assert.equal(isUnpaidStatus("OVERDUE"), true);
  assert.equal(isUnpaidStatus("PAID"), false);
});

test("실제로 쓰는 결제 수단만 받는다", () => {
  assert.deepEqual([...PAYMENT_METHODS], ["TRANSFER", "RALLYZ", "CARD", "CASH"]);
  assert.deepEqual([...RECEIPT_TYPES], ["CASH_RECEIPT", "EXPENSE_PROOF"]);
});

test("입금 확인은 미납 건에만, 수단과 날짜가 있어야 한다", () => {
  assert.equal(validatePaymentRequest({ kind: "PAYMENT_CLAIM" }, UNPAID).error, "METHOD_REQUIRED");
  assert.equal(
    validatePaymentRequest({ kind: "PAYMENT_CLAIM", method: "TRANSFER" }, UNPAID).error,
    "PAID_DATE_REQUIRED",
  );
  assert.equal(
    validatePaymentRequest({ kind: "PAYMENT_CLAIM", method: "TRANSFER", paidOn: "2026-08-08" }, UNPAID).ok,
    true,
  );
  // 이미 낸 건에 또 확인 요청이 오면 원장이 같은 일을 두 번 한다.
  assert.equal(
    validatePaymentRequest({ kind: "PAYMENT_CLAIM", method: "TRANSFER", paidOn: "2026-08-08" }, PAID).error,
    "ALREADY_PAID",
  );
});

test("미래 입금일은 막는다", () => {
  // 통장에서 대조할 수 없는 날짜를 받으면 확인이 불가능하다.
  assert.equal(
    validatePaymentRequest({ kind: "PAYMENT_CLAIM", method: "CASH", paidOn: "2026-08-10" }, UNPAID).error,
    "PAID_DATE_IN_FUTURE",
  );
  assert.equal(
    validatePaymentRequest({ kind: "PAYMENT_CLAIM", method: "CASH", paidOn: "2026-02-30" }, UNPAID).error,
    "PAID_DATE_REQUIRED",
  );
});

test("영수증은 납부 완료 건에만, 번호가 있어야 한다", () => {
  assert.equal(validatePaymentRequest({ kind: "RECEIPT", receiptType: "CASH_RECEIPT" }, UNPAID).error, "NOT_PAID_YET");
  assert.equal(validatePaymentRequest({ kind: "RECEIPT" }, PAID).error, "RECEIPT_TYPE_REQUIRED");
  // 번호가 없으면 원장이 발급을 못 해 다시 물어봐야 한다.
  assert.equal(
    validatePaymentRequest({ kind: "RECEIPT", receiptType: "CASH_RECEIPT", receiptTarget: "010" }, PAID).error,
    "RECEIPT_TARGET_REQUIRED",
  );
  assert.equal(
    validatePaymentRequest({ kind: "RECEIPT", receiptType: "CASH_RECEIPT", receiptTarget: "010-1234-5678" }, PAID).ok,
    true,
  );
});

test("엉뚱한 종류·긴 메모를 거른다", () => {
  assert.equal(validatePaymentRequest({ kind: "REFUND_ALL" }, UNPAID).error, "INVALID_KIND");
  assert.equal(
    validatePaymentRequest({ kind: "PAYMENT_CLAIM", note: "가".repeat(501) }, UNPAID).error,
    "NOTE_TOO_LONG",
  );
});

test("납부 여부는 DB 에서 읽는다", () => {
  // 클라이언트가 보낸 상태를 믿으면 미납 건에 영수증을 발급하거나
  // 이미 낸 건에 확인 요청을 넣을 수 있다.
  assert.match(parentLib, /paymentStatus: owned\[0\]\.status/);
  assert.match(parentLib, /p\.id = \$1 AND \$\{await childAccessSql\("s", "\$2"\)\}/);
});

test("같은 종류의 대기 요청은 한 건만 둔다", () => {
  assert.match(parentLib, /kind = \$2 AND status = 'PENDING' LIMIT 1/);
  assert.match(parentLib, /이미 확인 중인 요청이 있습니다/);
});

test("승인은 기존 납부 처리 경로를 그대로 쓴다", () => {
  // 여기서 Payment 만 직접 UPDATE 하면 PaymentInvoice 상태가 어긋난다.
  assert.match(adminLib, /markPaymentPaid\(\{/);
  assert.doesNotMatch(adminLib, /UPDATE "Payment" SET status = 'PAID'/);
});

test("납부 처리가 실패하면 요청도 되돌린다", () => {
  // "처리 완료"인데 미납인 상태가 남으면 원장도 학부모도 무엇이 맞는지 알 수 없다.
  assert.match(adminLib, /catch \(error\)[\s\S]{0,400}SET status = 'PENDING'/);
  assert.match(adminLib, /납부 처리에 실패했습니다/);
});

test("두 번 눌러도 두 번 납부 처리되지 않는다", () => {
  assert.match(adminLib, /WHERE id = \$1 AND status = 'PENDING'/);
  assert.match(adminLib, /이미 처리된 요청입니다/);
});

test("처리 결과가 학부모에게 전달된다", () => {
  assert.match(parentLib, /notifyAdmins\(\s*"PAYMENT_REQUEST"/);
  assert.match(adminLib, /notifyParentsOfStudents\(\[input\.studentId\]/);
  // 알림 실패가 요청·처리를 되돌리면 안 된다.
  assert.match(parentLib, /console\.error\("\[parent-payment-request\] 원장 알림 실패/);
  assert.match(adminLib, /console\.error\("\[admin-payment-request\] 학부모 알림 실패/);
});

test("관리자 메뉴에서 도달할 수 있다", async () => {
  // 실제 사고(2026-08-09): 다른 세션의 디자인 커밋에 이 메뉴 추가가 딸려 들어갔고,
  // 그 커밋을 revert 하자 메뉴만 조용히 사라졌다. 화면은 남았는데 갈 길이 없어진다.
  const { renderAdminNavigation } = await import('./helpers/admin-navigation-render.mjs');
  const shell = renderAdminNavigation('/admin/payment-requests');
  assert.match(shell, /href="\/admin\/payment-requests"/);
  // 직접 진입해도 해당 업무 메뉴가 활성화된다.
  assert.ok(
    /href="\/admin\/payment-requests"[^>]*aria-current="page"/.test(shell),
    "입금 확인 업무가 실제 메뉴에서 활성화되어야 합니다.",
  );
});
