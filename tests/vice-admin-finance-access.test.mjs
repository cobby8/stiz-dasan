// 부원장(VICE_ADMIN) 수납 권한·금액 가림 — 2026-11-14 원장 결정.
//
// 부원장 = 카운터 수납만(학생 검색 → 청구서 발행(미납) → ⚡현장 결제·입금/현장수납 승인).
// 보는 금액 = 미납(PENDING·OVERDUE) 청구 1건 금액뿐. 합계·납부 완료 금액·수납률·월 장부·청구 준비·POS 대사·
// 학생 상세 «청구/수납»·휴원 정산 금액과 정산·환불 동작은 서버에서 막거나 응답에서 뺀다.
//
// ① 가림 함수(financeRoleMask)는 실제로 돌려 본다 — 원장=원본 그대로, 부원장=규칙대로 null.
// ② 차단 지점은 소스를 읽어 «원장 확인이 첫머리에 있는지» 못박는다(빠져도 빌드·tsc 가 통과해 신호가 없다).

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsModule } from "./_ts-module.mjs";

const mask = await loadTsModule("src/lib/payments/financeRoleMask.ts");
const money = await loadTsModule("src/lib/auth/moneyAccess.ts");

// CRLF 작업본에서도 같은 결과가 나오게 줄바꿈을 맞춰 읽는다
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

/** export 함수 하나의 본문(다음 최상위 «}» 까지) */
function fnBody(src, name) {
    const start = src.indexOf(`export async function ${name}`);
    assert.ok(start >= 0, `${name} 를 찾지 못함`);
    const end = src.indexOf("\n}\n", start);
    return src.slice(start, end > 0 ? end : undefined);
}

// ───────────────────────── ① 가림 함수 실행 ─────────────────────────

const payload = () => ({
    payments: [
        { id: "a", status: "PENDING", amount: 180000 },
        { id: "b", status: "OVERDUE", amount: 30000 },
        { id: "c", status: "PAID", amount: 180000 },
        { id: "d", status: "CANCELED", amount: 50000 },
        { id: "e", status: "REFUNDED", amount: 70000 },
    ],
    summary: { totalCount: 5, totalAmount: 510000, paidAmount: 180000, unpaidAmount: 210000, paidCount: 1, unpaidCount: 2 },
    paymentProvider: { provider: "TOSS", providerReady: true },
});

test("수납 목록: 원장은 같은 객체 그대로(복사도 안 함)", () => {
    const original = payload();
    assert.equal(mask.maskFinancePayloadForRole(original, "ADMIN"), original);
});

test("수납 목록: 부원장은 미납·연체 금액만 남고, 납부 완료·취소·환불 금액과 월 요약은 null", () => {
    const original = payload();
    const out = mask.maskFinancePayloadForRole(original, "VICE_ADMIN");
    const byId = Object.fromEntries(out.payments.map((p) => [p.id, p.amount]));
    assert.deepEqual(byId, { a: 180000, b: 30000, c: null, d: null, e: null });
    assert.deepEqual(out.summary, { totalCount: null, totalAmount: null, paidAmount: null, unpaidAmount: null, paidCount: null, unpaidCount: null });
    // 결제 설정 상태 등 다른 칸은 그대로
    assert.deepEqual(out.paymentProvider, original.paymentProvider);
    // 캐시에서 꺼낸 원본을 고치지 않는다(다음 원장 요청이 가려진 값을 보면 안 된다)
    assert.equal(original.payments[2].amount, 180000);
    assert.equal(original.summary.totalAmount, 510000);
});

test("수납 목록: 역할을 모르면(빈 값) 가린 쪽으로 본다", () => {
    const out = mask.maskFinancePayloadForRole(payload(), undefined);
    assert.equal(out.summary.totalAmount, null);
    assert.equal(out.payments.find((p) => p.id === "c").amount, null);
});

test("공용 규칙 maskPaymentAmount: 미납만 보이고 extraKeys 도 같이 가린다", () => {
    assert.equal(money.canSeePaymentAmount("VICE_ADMIN", "PENDING"), true);
    assert.equal(money.canSeePaymentAmount("VICE_ADMIN", "PAID"), false);
    const paid = money.maskPaymentAmount({ status: "PAID", amount: 5, receiptAmount: 5 }, "VICE_ADMIN", ["receiptAmount"]);
    assert.deepEqual(paid, { status: "PAID", amount: null, receiptAmount: null });
});

test("현장 결제 요청 보기: 결제 전 요청은 부원장에게도 금액이 보이고, 결제된(PAID) 요청은 금액·항목 금액이 null", () => {
    const view = (status) => ({ id: "r1", status, amount: 210000, taxFreeAmount: 210000, items: [{ paymentId: "a", amount: 180000 }, { paymentId: "b", amount: 30000 }] });
    for (const status of ["PENDING", "SENT", "EXPIRED", "CANCELLED", "HELD"]) {
        assert.equal(mask.maskChargeRequestViewForRole(view(status), "VICE_ADMIN").amount, 210000, status);
    }
    const paid = mask.maskChargeRequestViewForRole(view("PAID"), "VICE_ADMIN");
    assert.equal(paid.amount, null);
    assert.equal(paid.taxFreeAmount, null);
    assert.deepEqual(paid.items.map((it) => it.amount), [null, null]);
    assert.deepEqual(paid.items.map((it) => it.paymentId), ["a", "b"]);
    const original = view("PAID");
    assert.equal(mask.maskChargeRequestViewForRole(original, "ADMIN"), original, "원장은 그대로");
    assert.equal(mask.maskChargeRequestViewForRole(null, "VICE_ADMIN"), null);
});

test("수강 변경 행: 부원장에게는 차액·휴원 수강료 미리보기·처리 기록이 null, 원장은 그대로", () => {
    const row = { id: "x", kind: "PAUSE", proration: { diff: 30000, lines: ["…"] }, settlementPreview: { paidTotal: 100000, unpaidTotal: 0 }, settlement: { paidAmount: 100000 } };
    assert.equal(mask.maskEnrollmentChangeRowForRole(row, "ADMIN"), row);
    const out = mask.maskEnrollmentChangeRowForRole(row, "VICE_ADMIN");
    assert.deepEqual({ p: out.proration, s: out.settlementPreview, d: out.settlement }, { p: null, s: null, d: null });
    assert.equal(out.kind, "PAUSE", "신청 내용(승인·거절에 필요한 것)은 그대로");
});

test("학생 상세: 부원장에게는 청구 목록이 비고, 월별 낸 돈·이월액이 null(수강료·셔틀비 안내 가격은 그대로)", () => {
    const data = {
        student: { id: "s1" },
        payments: [{ id: "p1", status: "PAID", amount: 180000 }],
        monthlyHistory: [{ id: "m1", paymentAmount: 180000, carryOverAmount: 20000, tuitionAmount: 180000, shuttleFee: 30000 }],
    };
    assert.equal(mask.maskStudentActivityForRole(data, "ADMIN"), data);
    const out = mask.maskStudentActivityForRole(data, "VICE_ADMIN");
    assert.deepEqual(out.payments, []);
    assert.deepEqual(out.monthlyHistory[0], { id: "m1", paymentAmount: null, carryOverAmount: null, tuitionAmount: 180000, shuttleFee: 30000 });
    assert.equal(data.monthlyHistory[0].paymentAmount, 180000, "원본은 그대로");
});

// ───────────────────────── ② 차단 지점(정적) ─────────────────────────

test("월 일괄 발행·미리보기·일괄 문자·발송 진행은 원장 전용(requireFinanceOwner)", () => {
    const admin = read("src/app/actions/admin.ts");
    for (const name of ["previewMonthlyInvoices", "generateMonthlyInvoices", "sendInvoiceLinksForMonth", "sendUnpaidReminders", "getBillingNoticeProgress"]) {
        assert.match(fnBody(admin, name).slice(0, 400), /await requireFinanceOwner\(\)/, name);
    }
    // 청구서 발행은 부원장도(미납 강제) — 중복 안내 금액은 가린다
    const create = fnBody(admin, "createPayment");
    assert.match(create, /await requireAdmin\(\)/);
    assert.match(create, /admin\.appUserRole !== "ADMIN" && requestedStatus !== "PENDING"/);
    assert.match(create, /maskPaymentAmount\(row, admin\.appUserRole\)/);
    // 계좌이체 기록·상태 변경·삭제·미납 취소는 원래부터 원장 전용 — 그대로
    for (const name of ["recordBankTransferPayment", "updatePaymentStatus", "deletePayment", "cancelUnpaidPayment"]) {
        assert.match(fnBody(admin, name), /await requireFinanceOwner\(\)/, name);
    }
});

test("POS 대사 «지금 대조»는 원장 전용", () => {
    assert.match(fnBody(read("src/app/actions/pos-reconcile.ts"), "runPosReconcileNow"), /await requireOwner\(\)/);
});

test("청구 준비·월 장부·월 대장·시트 대조 API 는 requireOwner 로만 연다", () => {
    for (const file of [
        "src/app/api/admin/billing-workbench/route.ts",
        "src/app/api/admin/finance/monthly-ledger/route.ts",
        "src/app/api/admin/finance/monthly-register/route.ts",
        "src/app/api/admin/finance/sheet-reconcile/route.ts",
    ]) {
        const src = read(file);
        assert.match(src, /requireOwner\(\)/, file);
        assert.doesNotMatch(src, /requireAdmin\(\)/, `${file} — 부원장이 통과하는 문지기가 남아 있으면 안 된다`);
    }
});

test("청구 준비·월 장부·월 대장 화면은 부원장을 수납 관리로, POS 대사 화면은 관리자 첫 화면으로 돌려보낸다", () => {
    for (const file of ["src/app/admin/finance/prepare/page.tsx", "src/app/admin/finance/monthly-ledger/page.tsx", "src/app/admin/finance/monthly-register/page.tsx"]) {
        assert.match(read(file), /if \(!canSeeAllMoney\(admin\.appUserRole\)\) redirect\("\/admin\/finance"\)/, file);
    }
    assert.match(read("src/app/admin/pos-reconcile/page.tsx"), /if \(!canSeeAllMoney\(admin\.appUserRole\)\) redirect\("\/admin"\)/);
});

test("수납 목록 화면·API 는 캐시에서 꺼낸 «뒤» 역할로 가린다(캐시 키는 역할 무관 그대로)", () => {
    const page = read("src/app/admin/finance/page.tsx");
    assert.match(page, /maskFinancePayloadForRole\(payload, adminUser\.appUserRole\)/);
    assert.match(page, /\{isOwner && <details/, "월 장부 링크는 원장만");
    const route = read("src/app/api/admin/finance/route.ts");
    assert.match(route, /maskFinancePayloadForRole\(\s*await timing\.measure\("data", \(\) => getCachedAdminFinancePayload\(year, month\)\),\s*role,\s*\)/);
    const payloads = read("src/lib/adminReadPayloads.ts");
    assert.match(payloads, /\["admin-finance", String\(year\), String\(month\)\]/, "캐시 키는 역할과 무관");
});

test("현장 결제: 카운터 동작은 원장·부원장, 결제 취소(환불)·POS 연결 코드는 원장만, 결제된 요청 금액은 가린다", () => {
    const src = read("src/app/actions/pos-charge.ts");
    for (const name of ["loadPosChargeRequest", "createPosChargeRequest", "cancelPosChargeRequest", "acknowledgePosChargeDismissal"]) {
        assert.match(fnBody(src, name), /await requirePosCounter\(\)/, name);
    }
    for (const name of ["loadPosChargeCancel", "requestPosChargeCancel", "loadPosPluginTokens", "issuePosPluginTokenAction", "revokePosPluginTokenAction"]) {
        assert.match(fnBody(src, name), /await requireFinanceOwner\(\)/, name);
    }
    assert.match(fnBody(src, "loadPosChargeRequest"), /maskChargeRequestViewForRole\(request, admin\.appUserRole\)/);
    assert.match(fnBody(src, "createPosChargeRequest"), /maskChargeRequestViewForRole\(result\.request, admin\.appUserRole\)/);
    // 미납만 요청 가능 — 서비스 SQL 이 DB 값으로 다시 확인한다(부원장 경로도 같은 함수)
    const service = read("src/lib/pos/chargeRequestService.ts");
    assert.match(service, /WHERE p\.status IN \('PENDING', 'OVERDUE'\) AND p\.type IN \('MONTHLY', 'SHUTTLE', 'OTHER'\)/);
    // 대기 요청 취소는 결제 전(PENDING·SENT, 결제 흔적 없음)만
    assert.match(fnBody(service, "cancelChargeRequestByAdmin"), /status IN \('PENDING', 'SENT'\)\s*AND "paidAt" IS NULL AND "tossPaymentId" IS NULL/);
});

test("수납 관리 화면: 부원장에게 현장 결제(1건·묶음)는 보이고, 요약·청구 준비·시트 점검·일괄 문자·환불은 원장만", () => {
    const src = read("src/app/admin/finance/FinanceClient.tsx");
    assert.match(src, /const canUsePosCharge = currentAdminRole === "ADMIN" \|\| currentAdminRole === "VICE_ADMIN";/);
    assert.match(src, /canUsePosCharge && \["MONTHLY", "SHUTTLE", "OTHER"\]\.includes\(p\.type\)[\s\S]{0,200}key: "pos-charge"/);
    assert.match(src, /canUsePosCharge && \["PENDING", "OVERDUE"\]\.includes\(p\.status\) && studentUnpaid\.length >= 2/);
    assert.match(src, /posOnly=\{!canManageCriticalFinance\}/, "부원장 납부 처리 창 = 현장 결제만");
    assert.match(src, /\{canManageCriticalFinance && \(\s*<section className="mb-4 flex flex-wrap items-center gap-2[^"]*">\s*<span[^>]*>\s*총 청구/, "월 요약은 원장만");
    assert.match(src, /\{canManageCriticalFinance && \(\s*<Link href=\{`\/admin\/finance\/prepare/, "청구 준비 버튼은 원장만");
    assert.match(src, /\.\.\.\(canManageCriticalFinance \? \[\s*\{\s*key: "send-links"/, "일괄 문자는 원장만");
    // 환불·결제 취소·납부처리(계좌이체)는 예전처럼 원장만
    for (const key of ["pos-cancel", "refund", "paid", "va-close"]) {
        assert.match(src, new RegExp(`canManageCriticalFinance && [^\\n]*\\? \\[\\s*\\{\\s*key: "${key}"`), key);
    }
    const modal = read("src/app/admin/finance/RecordPaymentModal.tsx");
    assert.match(modal, /\{!posOnly && transfer\.recordable\.length > 0 && \(/, "현장 결제만 모드에서는 계좌이체로 넘어가는 길이 없다");
});

test("휴원·수강 변경: 승인·거절은 부원장도(정산은 미룸), 정산·환불·차액 청구·금액 미리보기는 원장만", () => {
    const src = read("src/app/actions/enrollment-changes.ts");
    for (const name of ["getPauseTuitionPreview", "settlePauseTuition", "retryPauseTuitionRefund", "markPauseTuitionLineDone", "markPauseCarryHandled", "issueEnrollmentChangeInvoice"]) {
        assert.match(fnBody(src, name).slice(0, 400), /await requireOwner\(\)/, name);
    }
    const decide = fnBody(src, "decideEnrollmentChange");
    assert.match(decide, /await requireAdmin\(\)/, "승인·거절은 부원장도");
    assert.match(decide, /settlement: owner \? input\.settlement \?\? null : null/);
    assert.match(decide, /deferSettlementChoice: !owner/);
    assert.match(fnBody(src, "readEnrollmentChangesForInbox"), /maskEnrollmentChangeRowForRole\(row, admin\.appUserRole\)/);
    const lib = read("src/lib/enrollment/admin-change-request.ts");
    assert.match(lib, /const pendingKind = input\.approve && !settlementChoice && !input\.deferSettlementChoice/);
    const page = read("src/app/admin/enrollment-changes/page.tsx");
    assert.match(page, /maskEnrollmentChangeRowForRole\(row, admin\.appUserRole\)/);
    assert.match(page, /openSettlementCount=\{owner \? openSettlementCount : 0\}/);
});

test("학생 상세: 화면·다시 읽기 API 모두 가린 데이터, «청구/수납» 탭·수납 칸은 원장만", () => {
    assert.match(read("src/app/admin/students/[id]/page.tsx"), /data=\{maskStudentActivityForRole\(data, adminUser\.appUserRole\)\}/);
    assert.match(read("src/app/api/admin/students/[id]/activity/route.ts"), /maskStudentActivityForRole\(data, role\)/);
    const client = read("src/app/admin/students/[id]/StudentDetailClient.tsx");
    assert.match(client, /\.\.\.\(canManageFinance \? \[\{ key: "pay" as const, label: "청구\/수납" \}\] : \[\]\)/);
    assert.match(client, /activeTab === "pay" && canManageFinance && \(/);
});

test("입금 확인·현장 수납 승인: 대기 건 금액은 보이고, 처리된 건 금액·대기 합계는 원장만", () => {
    const lib = read("src/lib/payments/admin-payment-request.ts");
    assert.match(lib, /amount: canSeeAllMoney\(role\) \|\| row\.status === "PENDING" \? Number\(row\.amount \?\? 0\) : null/);
    assert.match(read("src/app/admin/payment-requests/page.tsx"), /getPaymentParentRequests\(status, admin\.appUserRole\)/);
    const confirmations = read("src/app/admin/payment-confirmations/page.tsx");
    assert.match(confirmations, /const showTotal = canSeeAllMoney\(admin\.appUserRole\);/);
    assert.match(confirmations, /\{showTotal && <p[^>]*>\{totalAmount\.toLocaleString\(\)\}원<\/p>\}/);
});

test("신청함: 처리된 입금 확인·현장 수납 금액은 부원장에게 빼고(대기 건은 유지), 휴원 정산 건수도 0", () => {
    const lib = read("src/lib/requests/admin-inbox.ts");
    assert.match(lib, /export function hideInboxAmount\(kind: RequestKind, rawStatus: string, role: string \| null \| undefined\): boolean \{\n  return !canSeeAllMoney\(role\) && MONEY_KINDS\.has\(kind\) && rawStatus !== "PENDING";/);
    assert.match(lib, /new Set<RequestKind>\(\["PAYMENT_REQUEST", "STAFF_PAYMENT"\]\)/);
    assert.match(lib, /hideInboxAmount\(adapter\.kind, row\.raw, viewerRole\) \? \{ \.\.\.parsed, amount: null \} : parsed/);
    const page = read("src/app/admin/inbox/page.tsx");
    assert.match(page, /viewerRole: role/);
    assert.match(page, /kinds\.includes\("ENROLLMENT_CHANGE"\) && canSeeAllMoney\(role\) \? countOpenPauseSettlements\(\)/);
});
