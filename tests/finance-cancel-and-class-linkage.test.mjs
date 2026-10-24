import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const actions = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const finance = readFileSync(new URL("../src/app/admin/finance/FinanceClient.tsx", import.meta.url), "utf8");
const studentDetail = readFileSync(new URL("../src/app/admin/students/[id]/StudentDetailClient.tsx", import.meta.url), "utf8");
const optionsRoute = readFileSync(new URL("../src/app/api/admin/student-options/route.ts", import.meta.url), "utf8");
const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");

test("unpaid cancellation preserves records, rejects paid states, and writes an audit entry", () => {
  const cancelAction = actions.slice(
    actions.indexOf("export async function cancelUnpaidPayment"),
    actions.indexOf("export async function updatePaymentStatus"),
  );

  assert.match(cancelAction, /requireFinanceOwner\(\)/);
  assert.match(cancelAction, /\["PENDING", "OVERDUE"\]/);
  assert.match(cancelAction, /status = 'DONE'/);
  assert.match(cancelAction, /SET status = 'CANCELED'.*"canceledAt" = NOW\(\)/s);
  assert.match(cancelAction, /PAYMENT_CANCEL_UNPAID/);
  assert.match(cancelAction, /SELECT id, status FROM "PaymentInvoice" WHERE "paymentId" = \$1 FOR UPDATE/);
  assert.doesNotMatch(cancelAction, /ensureInvoiceForPayment/);
  assert.doesNotMatch(cancelAction, /DELETE FROM/);
});

test("manual monthly and shuttle charges require explicit active class attribution", () => {
  const createAction = actions.slice(
    actions.indexOf("export async function createPayment"),
    actions.indexOf("export async function cancelUnpaidPayment"),
  );

  assert.match(createAction, /\["MONTHLY", "SHUTTLE"\].*classId/s);
  assert.match(createAction, /"studentId" = \$1 AND "classId" = \$2 AND status = 'ACTIVE'/);
  assert.match(createAction, /prisma\.\$transaction\(async \(tx\) =>/);
  assert.match(createAction, /ensureInvoicesForMonth\(year, month, \[paymentId\], tx\)/);
  assert.doesNotMatch(createAction, /ensureInvoiceForPayment/);
  assert.match(createAction, /PAYMENT_CREATE_MANUAL/);
  assert.match(optionsRoute, /e\.status = 'ACTIVE'/);
  assert.match(optionsRoute, /classes: \{ id: string; name: string/);
  assert.match(queries, /p\."classId", c\.name AS class_name/);
  assert.match(finance, /연결 수업 \{classRequired \? "\*"/);
  const cacheInvalidation = actions.slice(
    actions.indexOf("function revalidateStudentAdminCaches()"),
    actions.indexOf("function revalidateTrialAdminCaches()"),
  );
  assert.match(cacheInvalidation, /revalidateTag\("admin-student-options"/);
});

test("parent notice is an explicit opt-in for manual payment creation", () => {
  assert.match(actions, /if \(data\.notifyParent\)/);
  assert.match(finance, /const \[notifyParent, setNotifyParent\] = useState\(false\)/);
  assert.match(finance, /생성 후 학부모 수납 안내 알림 보내기/);
  assert.match(finance, /학부모 알림: \{notifyParent/);
  assert.match(finance, /setCreatePreviewOpen\(true\)/);
  assert.match(optionsRoute, /hasParent: Boolean\(row\.parentId\)/);
});

test("enrollment status changes retain effective date and reason history", () => {
  assert.match(actions, /change\?: \{ effectiveFrom\?: string; reason\?: string \}/);
  assert.match(actions, /INSERT INTO "EnrollmentChangeRequest"/);
  assert.match(actions, /"effectiveFrom".*\$5::date/s);
  assert.match(actions, /status, "requestedByUserId", "decidedByUserId"/);
  assert.match(studentDetail, /name="effectiveFrom"/);
  assert.match(studentDetail, /name="reason"/);
});
