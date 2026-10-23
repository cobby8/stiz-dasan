// 학부모 청구 안내(청구서 링크·미납 알림) 사이트 발송 잠금 테스트 — 2026-10-06 B안
// 청구 안내는 랠리즈 전담. 사이트 버튼은 지우지 않고 잠근다(토스 라이브 후 환경변수로 다시 켬).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const adminAction = readFileSync("src/app/actions/admin.ts", "utf8");
const financeClient = readFileSync("src/app/admin/finance/FinanceClient.tsx", "utf8");
const financePage = readFileSync("src/app/admin/finance/page.tsx", "utf8");
const guardSource = readFileSync("src/lib/billing/parentSendGuard.ts", "utf8");

// 순수 판정 모듈을 그대로 실행한다(다른 모듈 import 없음)
const guardModule = { exports: {} };
new Function("module", "exports", "process", ts.transpile(guardSource, {
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
}))(guardModule, guardModule.exports, { env: {} });
const {
  isBillingParentSendEnabled,
  rallyzMirrorExclusionSql,
  summarizeUnpaidByParent,
  BILLING_PARENT_SEND_LOCKED_MESSAGE,
} = guardModule.exports;

function sliceFn(name, nextMarker) {
  const start = adminAction.indexOf(`export async function ${name}`);
  const end = adminAction.indexOf(nextMarker, start + 1);
  assert.ok(start >= 0 && end > start, `${name} 를 찾지 못했습니다.`);
  return adminAction.slice(start, end);
}
const sendLinks = sliceFn("sendInvoiceLinksForMonth", "export async function sendUnpaidReminders");
const sendReminders = sliceFn("sendUnpaidReminders", "export async function bulkUpdatePaymentStatus");

test("잠금 판정: BILLING_PARENT_SEND_ENABLED 가 정확히 \"1\" 일 때만 발송 허용", () => {
  assert.equal(isBillingParentSendEnabled({}), false);
  assert.equal(isBillingParentSendEnabled({ BILLING_PARENT_SEND_ENABLED: "" }), false);
  assert.equal(isBillingParentSendEnabled({ BILLING_PARENT_SEND_ENABLED: "0" }), false);
  assert.equal(isBillingParentSendEnabled({ BILLING_PARENT_SEND_ENABLED: "true" }), false);
  assert.equal(isBillingParentSendEnabled({ BILLING_PARENT_SEND_ENABLED: " 1" }), false);
  assert.equal(isBillingParentSendEnabled({ BILLING_PARENT_SEND_ENABLED: "1" }), true);
  assert.match(BILLING_PARENT_SEND_LOCKED_MESSAGE, /랠리즈/);
});

test("학부모별 미납 합계: 그 학부모 자녀의 미납만 센다", () => {
  const result = summarizeUnpaidByParent([
    { parentId: "A", studentId: "s1", amount: 100000 },
    { parentId: "A", studentId: "s1", amount: "50000" },
    { parentId: "A", studentId: "s2", amount: 30000 },
    { parentId: "B", studentId: "s3", amount: 200000 },
    { parentId: null, studentId: "s4", amount: 999999 }, // 학부모 미연결 — 앱 알림 대상 아님
  ]);
  const byId = Object.fromEntries(result.map((r) => [r.parentId, r]));
  assert.equal(result.length, 2);
  assert.deepEqual(byId.A, { parentId: "A", studentIds: ["s1", "s2"], count: 3, total: 180000 });
  assert.deepEqual(byId.B, { parentId: "B", studentIds: ["s3"], count: 1, total: 200000 });
});

test("랠리즈 사본 제외 조건: method='RALLYZ' 와 사본 감사로그 둘 다 본다(description 판별 금지)", () => {
  const sql = rallyzMirrorExclusionSql("p");
  assert.match(sql, /COALESCE\(p\.method, ''\) <> 'RALLYZ'/);
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /"PaymentAuditLog"/);
  assert.match(sql, /"paymentId" = p\.id/);
  assert.match(sql, /'RALLYZ_APPROVED_EXISTING_INVOICE_MIRROR'/);
  assert.doesNotMatch(sql, /description/i);
});

test("두 발송 함수는 첫머리(requireAdmin 직후, DB 작업 전)에서 잠금을 검사하고 결과로 돌려준다", () => {
  for (const [name, body] of [["sendInvoiceLinksForMonth", sendLinks], ["sendUnpaidReminders", sendReminders]]) {
    const guardAt = body.indexOf("if (!isBillingParentSendEnabled())");
    assert.ok(guardAt > 0, `${name}: 잠금 검사가 없습니다.`);
    assert.ok(body.indexOf("await requireAdmin()") < guardAt, `${name}: 관리자 확인 뒤에 잠금 검사`);
    // 잠금 검사 이전에는 DB·발송 호출이 없어야 한다
    const before = body.slice(0, guardAt);
    assert.doesNotMatch(before, /prisma\.|ensure|markOverduePayments|notify|sendParentSms/, `${name}: 잠금 전 DB 작업`);
    const lockedBlock = body.slice(guardAt, body.indexOf("}", guardAt));
    assert.match(lockedBlock, /ok: false/);
    assert.match(lockedBlock, /BILLING_PARENT_SEND_LOCKED_MESSAGE/);
    assert.doesNotMatch(lockedBlock, /throw/);
  }
});

test("두 발송 함수 모두 랠리즈 사본을 대상에서 뺀다", () => {
  assert.match(sendLinks, /rallyzMirrorExclusionSql\("p"\)/);
  assert.match(sendReminders, /rallyzMirrorExclusionSql\("p"\)/);
  assert.doesNotMatch(sendReminders, /description LIKE/i);
});

test("미납 앱 알림은 학원 전체 합계가 아니라 학부모별 건수·금액으로 보낸다", () => {
  assert.match(sendReminders, /summarizeUnpaidByParent\(/);
  assert.match(sendReminders, /미납 \$\{summary\.count\}건 \(총 \$\{summary\.total\.toLocaleString\("ko-KR"\)\}원\)/);
  assert.doesNotMatch(sendReminders, /미납 \$\{unpaid\.length\}건/);
  assert.doesNotMatch(sendReminders, /const totalAmount = unpaid\.reduce/);
});

test("화면: 잠금이면 두 버튼 비활성 + 랠리즈 안내, 기본값은 잠금", () => {
  assert.match(financeClient, /billingParentSendEnabled = false/);
  assert.match(financeClient, /const parentSendLocked = !billingParentSendEnabled/);
  assert.match(financeClient, /disabled: parentSendLocked \|\| busy \|\| invoiceGeneratedCount === 0/);
  assert.match(financeClient, /disabled: parentSendLocked \|\| busy \|\| invoiceOpenCount === 0/);
  assert.match(financeClient, /랠리즈에서 발송/);
  assert.match(financeClient, /학부모 청구 안내는 랠리즈에서 발송/);
  assert.match(financePage, /billingParentSendEnabled=\{isBillingParentSendEnabled\(\)\}/);
});
