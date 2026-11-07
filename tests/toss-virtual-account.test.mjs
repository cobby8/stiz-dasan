import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 무통장입금(가상계좌) — 발급은 «입금 대기», 입금 알림(DEPOSIT_CALLBACK)이 secret·토스 재조회를 통과해야 납부 완료.
// 판정 규칙(virtualAccount.ts)은 실제로 실행해 보고, 장부 SQL 은 원문으로 못박는다.
const va = await loadTsModule("src/lib/payments/virtualAccount.ts");
const vaSecret = await loadTsModule("src/lib/payments/virtualAccountSecret.ts");

const ledger = readFileSync(new URL("../src/lib/payment-ledger.ts", import.meta.url), "utf8");
const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
const checkoutClient = readFileSync(new URL("../src/app/payments/[invoiceId]/PaymentCheckoutClient.tsx", import.meta.url), "utf8");
const successClient = readFileSync(new URL("../src/app/payments/success/PaymentSuccessClient.tsx", import.meta.url), "utf8");
const notice = readFileSync(new URL("../src/components/parent/VirtualAccountNotice.tsx", import.meta.url), "utf8");
const financeClient = readFileSync(new URL("../src/app/admin/finance/FinanceClient.tsx", import.meta.url), "utf8");

/** 함수 본문만 잘라 본다(다른 함수의 SQL 과 섞이지 않게). */
function fnBody(source, header) {
    const start = source.indexOf(header);
    assert.ok(start >= 0, `${header} 를 찾을 수 없습니다`);
    const next = source.indexOf("\nasync function ", start + header.length);
    const nextExport = source.indexOf("\nexport async function ", start + header.length);
    const ends = [next, nextExport].filter((i) => i > 0);
    return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

const SECRET = "va-secret-from-confirm-1234";
const issuedResponse = {
    paymentKey: "pk-va-1",
    orderId: "STIZ-1-abc",
    status: "WAITING_FOR_DEPOSIT",
    method: "가상계좌",
    totalAmount: 180000,
    taxFreeAmount: 180000,
    suppliedAmount: 0,
    vat: 0,
    secret: SECRET,
    virtualAccount: {
        accountNumber: "X6505636518308",
        bankCode: "20",
        customerName: "김학부모",
        dueDate: "2027-02-06T14:30:00+09:00",
        expired: false,
    },
};
const tx = { orderId: "STIZ-1-abc", amount: 180000, status: "WAITING_FOR_DEPOSIT", paymentKey: "pk-va-1" };
const doneLookup = { ...issuedResponse, status: "DONE", secret: null, approvedAt: "2026-11-30T15:30:00+00:00" };

// ── 1. 발급 → 입금 대기 저장 ─────────────────────────────────────────────
test("발급: 승인 응답에서 은행·계좌·예금주·기한을 뽑고 secret 은 해시로만 저장한다", () => {
    const issue = va.extractVirtualAccountIssue(issuedResponse, 180000);
    assert.deepEqual(issue, {
        bankCode: "20", bankName: "우리은행", accountNumber: "X6505636518308",
        customerName: "김학부모", dueDate: "2027-02-06T14:30:00+09:00", amount: 180000,
    });
    const stored = vaSecret.buildIssuedRawResponse(issuedResponse, issue);
    const json = JSON.stringify(stored);
    assert.ok(!json.includes(SECRET), "secret 원문이 저장값에 남으면 안 된다");
    assert.equal(stored.secret, undefined);
    assert.match(stored.depositSecretHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(stored.virtualAccountIssue, issue);
    // 조회로 복구한 경우(secret 없음) 해시 칸은 비운다
    assert.equal(vaSecret.buildIssuedRawResponse({ ...issuedResponse, secret: null }, issue).depositSecretHash, null);
});

test("발급: 계좌번호·기한이 없으면 발급으로 보지 않는다", () => {
    assert.equal(va.extractVirtualAccountIssue({ ...issuedResponse, virtualAccount: null }, 1000), null);
    assert.equal(va.extractVirtualAccountIssue({ virtualAccount: { accountNumber: "1", dueDate: "아님" } }, 1000), null);
});

test("발급: 승인 경로는 WAITING_FOR_DEPOSIT 를 거래에만 기록하고 청구·청구서를 납부 완료로 바꾸지 않는다", () => {
    const body = fnBody(ledger, "async function recordVirtualAccountIssued(");
    assert.match(body, /UPDATE "PaymentTransaction"\s+SET status = '\$\{VA_WAITING_STATUS\}'/);
    assert.doesNotMatch(body, /UPDATE "Payment"\s/);
    assert.doesNotMatch(body, /UPDATE "PaymentInvoice"/);
    assert.match(body, /buildIssuedRawResponse\(input\.payment, issue\)/);
    assert.match(body, /VIRTUAL_ACCOUNT_ISSUED/);
    const confirm = fnBody(ledger, "export async function confirmTossPayment(");
    // 승인 응답의 WAITING_FOR_DEPOSIT 분기가 «DONE 아니면 실패» 검사보다 먼저 온다
    assert.ok(confirm.indexOf("result.status === VA_WAITING_STATUS") < confirm.indexOf('result.status !== "DONE"'));
    assert.match(confirm, /waitingForDeposit: true as const/);
});

// ── 2. 중복 발급 방지 ─────────────────────────────────────────────────
test("중복 발급 방지: 기한 안의 입금 대기 계좌가 있으면 결제 준비가 새 거래를 만들지 않고 그 계좌를 돌려준다", () => {
    const body = fnBody(ledger, "export async function createCheckoutSession(");
    const check = body.indexOf("getVirtualAccountState(invoice.invoiceId)");
    const insert = body.indexOf('INSERT INTO "PaymentTransaction"');
    assert.ok(check > 0 && insert > 0 && check < insert, "열린 계좌 확인이 새 거래 INSERT 보다 먼저여야 한다");
    assert.match(body, /vaState && !vaState\.expired/);
    assert.match(body, /openVirtualAccount: vaState/);
    assert.match(checkoutClient, /data\.openVirtualAccount/);
});

test("중복 발급 방지: 열림/만료 판정은 기한 시각으로 한다(만료면 다시 발급 허용)", () => {
    const issue = va.extractVirtualAccountIssue(issuedResponse, 180000);
    const before = Date.parse("2027-02-06T05:29:59Z"); // KST 14:29:59
    const after = Date.parse("2027-02-06T05:30:00Z"); // KST 14:30:00 = 기한
    assert.equal(va.toPublicVirtualAccountView(issue, "WAITING_FOR_DEPOSIT", before).expired, false);
    assert.equal(va.toPublicVirtualAccountView(issue, "WAITING_FOR_DEPOSIT", after).expired, true);
    // 토스가 만료를 알려 EXPIRED 로 바뀐 거래는 기한 전이라도 만료
    assert.equal(va.toPublicVirtualAccountView(issue, "EXPIRED", before).expired, true);
});

test("표시: 입금 기한은 KST 로 보인다(UTC 자정 경계에서 하루 밀리지 않는다)", () => {
    assert.equal(va.formatVirtualAccountDue("2027-02-06T14:30:00+09:00"), "2027년 2월 6일 14:30");
    // UTC 11-30 15:30 = KST 12-01 00:30 (월말 경계)
    assert.equal(va.formatVirtualAccountDue("2026-11-30T15:30:00Z"), "2026년 12월 1일 00:30");
    assert.equal(va.formatVirtualAccountDue("2026-12-31T15:00:00Z"), "2027년 1월 1일 00:00");
});

// ── 3. DEPOSIT_CALLBACK secret 검증 ─────────────────────────────────────
test("secret: 같은 값만 MATCH, 다르면 MISMATCH, 없으면 NOT_PROVIDED, 저장값 없으면 NOT_STORED", () => {
    const hash = vaSecret.hashDepositSecret(SECRET);
    assert.equal(vaSecret.checkDepositSecret(SECRET, hash), "MATCH");
    assert.equal(vaSecret.checkDepositSecret("forged", hash), "MISMATCH");
    assert.equal(vaSecret.checkDepositSecret(null, hash), "NOT_PROVIDED");
    assert.equal(vaSecret.checkDepositSecret(SECRET, null), "NOT_STORED");
    assert.equal(vaSecret.checkDepositSecret(SECRET, "짧은값"), "NOT_STORED");
});

test("secret: 비교는 타이밍 안전 비교(timingSafeEqual)로 한다", () => {
    const src = readFileSync(new URL("../src/lib/payments/virtualAccountSecret.ts", import.meta.url), "utf8");
    assert.match(src, /timingSafeEqual\(a, b\)/);
    assert.doesNotMatch(src, /provided === storedHash/);
});

test("secret 불일치 입금 알림은 토스 결제가 DONE 이어도 거부한다", () => {
    for (const secretCheck of ["MISMATCH"]) {
        const d = va.decideVirtualAccountWebhook({ isDepositCallback: true, secretCheck, tx, paymentStatus: "PENDING", verified: doneLookup });
        assert.equal(d.action, "REJECT");
        assert.equal(d.code, "DEPOSIT_SECRET_MISMATCH");
    }
    const missing = va.decideVirtualAccountWebhook({ isDepositCallback: true, secretCheck: "NOT_PROVIDED", tx, paymentStatus: "PENDING", verified: doneLookup });
    assert.equal(missing.action, "REJECT");
});

test("secret 불일치는 웹훅에서 토스 조회보다 먼저 거르고, 같은 지문의 진짜 알림이 다시 처리되게 processed 를 세우지 않는다", () => {
    const body = fnBody(ledger, "export async function recordTossWebhook(");
    const reject = body.indexOf('secretCheck === "MISMATCH"');
    const lookup = body.indexOf("getVerifiedTossPayment(paymentKey, orderId)");
    assert.ok(reject > 0 && reject < lookup);
    const rejectBlock = body.slice(reject, lookup);
    assert.match(rejectBlock, /SET error = \$2, "processedAt" = NOW\(\)/);
    assert.doesNotMatch(rejectBlock, /processed = true/);
    assert.match(body, /isDepositCallbackPayload\(payloadRecord\)/);
});

test("DEPOSIT_CALLBACK 본문 모양을 알아본다(eventType 없음 + secret·status·orderId)", () => {
    assert.equal(va.isDepositCallbackPayload({ createdAt: "2026-11-08T10:00:00", secret: "s", status: "DONE", transactionKey: "t", orderId: "o" }), true);
    assert.equal(va.isDepositCallbackPayload({ eventType: "PAYMENT_STATUS_CHANGED", data: { status: "DONE" } }), false);
    assert.equal(va.isDepositCallbackPayload({ eventType: "DEPOSIT_CALLBACK" }), true);
});

// ── 4. 금액·면세 불일치·이중 납부 ─────────────────────────────────────────
test("금액 불일치·면세 미적용·이미 납부·취소된 청구는 납부 처리하지 않고 원장 알림 대상으로 돌린다", () => {
    const base = { isDepositCallback: true, secretCheck: "MATCH", tx, paymentStatus: "PENDING" };
    const amount = va.decideVirtualAccountWebhook({ ...base, verified: { ...doneLookup, totalAmount: 170000 } });
    assert.deepEqual(amount, { action: "REJECT", code: "VIRTUAL_ACCOUNT_AMOUNT_MISMATCH", alert: true });
    const taxed = va.decideVirtualAccountWebhook({ ...base, verified: { ...doneLookup, taxFreeAmount: 0, suppliedAmount: 163636, vat: 16364 } });
    assert.deepEqual(taxed, { action: "REJECT", code: "VIRTUAL_ACCOUNT_TAX_FREE_MISMATCH", alert: true });
    const paid = va.decideVirtualAccountWebhook({ ...base, paymentStatus: "PAID", verified: doneLookup });
    assert.deepEqual(paid, { action: "REJECT", code: "VIRTUAL_ACCOUNT_ALREADY_PAID", alert: true });
    const closed = va.decideVirtualAccountWebhook({ ...base, paymentStatus: "CANCELED", verified: doneLookup });
    assert.equal(closed.action, "REJECT");
    const other = va.decideVirtualAccountWebhook({ ...base, verified: { ...doneLookup, orderId: "다른주문" } });
    assert.equal(other.action, "REJECT");
});

test("이상 건은 감사 기록(같은 사유 1번만) + 원장 슬랙 DM, 납부 처리는 하지 않는다", () => {
    const body = fnBody(ledger, "async function recordVirtualAccountReview(");
    assert.match(body, /'VIRTUAL_ACCOUNT_REVIEW'/);
    assert.match(body, /WHERE NOT EXISTS/);
    assert.match(body, /inserted\.length > 0 && alert/);
    assert.doesNotMatch(body, /UPDATE "Payment"/);
    assert.match(ledger, /SLACK_OWNER_USER_ID/);
});

// ── 5. 정상 입금 → PAID·감사기록 ──────────────────────────────────────────
test("정상 입금: secret 일치 + 토스 DONE·금액·면세 일치면 PAY", () => {
    const d = va.decideVirtualAccountWebhook({ isDepositCallback: true, secretCheck: "MATCH", tx, paymentStatus: "PENDING", verified: doneLookup });
    assert.deepEqual(d, { action: "PAY" });
    // 승인 응답을 놓쳐 secret 해시가 없는 거래도 토스 재조회만으로 반영한다(IN_PROGRESS 거래)
    const recovered = va.decideVirtualAccountWebhook({ isDepositCallback: true, secretCheck: "NOT_STORED", tx: { ...tx, status: "IN_PROGRESS" }, paymentStatus: "OVERDUE", verified: doneLookup });
    assert.deepEqual(recovered, { action: "PAY" });
});

test("정상 입금: 납부 완료 처리가 입금 대기 거래를 받고, 입금 시각을 UTC 규칙으로 paidDate 에 넣고 감사 기록을 남긴다", () => {
    const body = fnBody(ledger, "async function finalizeVerifiedTossPayment(");
    assert.match(body, /\["READY", "IN_PROGRESS", "DONE", VA_WAITING_STATUS, VA_EXPIRED_STATUS\]/);
    // 무tz(timestamp) 칸 = UTC 벽시계로
    assert.match(body, /"paidDate" = COALESCE\("paidDate", \(\$6::timestamptz AT TIME ZONE 'UTC'\), NOW\(\)\)/);
    assert.match(body, /"paidProvider" = 'TOSS'/);
    assert.match(body, /'PAYMENT_MARK_PAID'/);
    assert.match(body, /VIRTUAL_ACCOUNT_ALREADY_PAID/);
    const apply = fnBody(ledger, "async function applyVirtualAccountWebhook(");
    assert.match(apply, /parseTossTimestamp\(verified\.approvedAt\) \?\? parseTossTimestamp\(input\.depositedAt\)/);
    assert.match(apply, /actorType: "WEBHOOK"/);
});

test("수단 표시: 토스가 돌려주는 «가상계좌»를 그대로 저장해 관리자·학부모 화면에 한국어로 보인다", () => {
    assert.equal(va.VA_METHOD, "가상계좌");
    assert.match(financeClient, /p\.transactionStatus === "WAITING_FOR_DEPOSIT" && p\.status !== "PAID"/);
    assert.match(financeClient, /입금 대기 · 가상계좌/);
});

// ── 6. 멱등 ─────────────────────────────────────────────────────────
test("멱등: 이미 반영된 거래에 같은 입금 알림이 또 오면 ALREADY_DONE(장부 변경 없음)", () => {
    const d = va.decideVirtualAccountWebhook({ isDepositCallback: true, secretCheck: "MATCH", tx: { ...tx, status: "DONE" }, paymentStatus: "PAID", verified: doneLookup });
    assert.deepEqual(d, { action: "ALREADY_DONE" });
    // 웹훅 이벤트 지문에 DEPOSIT_CALLBACK 이름이 들어가 같은 알림은 processed 로 걸러진다
    assert.match(ledger, /\? "DEPOSIT_CALLBACK"/);
    assert.match(ledger, /if \(eventRows\[0\]\?\.processed\)/);
});

// ── 7. 만료·취소 해제 ──────────────────────────────────────────────────
test("만료·입금 전 취소면 «입금 대기»만 풀고(RELEASE), 입금 뒤 전액 취소는 기존 환불 경로로 넘긴다", () => {
    const base = { isDepositCallback: false, secretCheck: "NOT_PROVIDED", tx, paymentStatus: "PENDING" };
    assert.deepEqual(va.decideVirtualAccountWebhook({ ...base, verified: { ...doneLookup, status: "EXPIRED" } }), { action: "RELEASE", reason: "EXPIRED" });
    assert.deepEqual(va.decideVirtualAccountWebhook({ ...base, verified: { ...doneLookup, status: "CANCELED" } }), { action: "RELEASE", reason: "CANCELED" });
    assert.deepEqual(
        va.decideVirtualAccountWebhook({ ...base, tx: { ...tx, status: "DONE" }, paymentStatus: "PAID", verified: { ...doneLookup, status: "CANCELED" } }),
        { action: "DELEGATE" },
    );
    // 아직 입금 대기면 아무것도 안 한다
    assert.equal(va.decideVirtualAccountWebhook({ ...base, verified: { ...doneLookup, status: "WAITING_FOR_DEPOSIT" } }).action, "IGNORE");
});

test("만료 해제 SQL 은 거래 상태만 EXPIRED 로 바꾸고 청구·청구서는 미납 그대로 둔다", () => {
    const body = fnBody(ledger, "async function applyVirtualAccountWebhook(");
    const start = body.indexOf('decision.action === "RELEASE"');
    const block = body.slice(start, body.indexOf('decision.action === "REJECT"'));
    assert.match(block, /SET status = '\$\{VA_EXPIRED_STATUS\}'/);
    assert.match(block, /WHERE id = \$1 AND status = '\$\{VA_WAITING_STATUS\}'/);
    assert.doesNotMatch(block, /UPDATE "Payment"/);
    assert.doesNotMatch(block, /UPDATE "PaymentInvoice"/);
    assert.match(notice, /기한 만료 — 다시 발급/);
});

// ── 8. secret 이 학부모 응답·화면에 안 나간다 ─────────────────────────────
test("학부모용 모양에는 고른 칸만 있다(secret·해시·결제키 없음)", () => {
    const issue = va.extractVirtualAccountIssue(issuedResponse, 180000);
    const view = va.toPublicVirtualAccountView(issue, "WAITING_FOR_DEPOSIT", Date.parse("2026-11-08T00:00:00Z"));
    assert.deepEqual(Object.keys(view).sort(), ["accountNumber", "amount", "bankName", "customerName", "dueDate", "dueLabel", "expired"]);
    assert.ok(!JSON.stringify(view).includes(SECRET));
    // 저장값(해시 포함)을 그대로 넣어도 고른 칸만 나온다
    const stored = vaSecret.buildIssuedRawResponse(issuedResponse, issue);
    const fromStored = va.toPublicVirtualAccountView(va.readStoredIssue({ ...stored.virtualAccountIssue, depositSecretHash: stored.depositSecretHash, secret: SECRET }), "WAITING_FOR_DEPOSIT", 0);
    assert.ok(!JSON.stringify(fromStored).includes(SECRET));
    assert.ok(!JSON.stringify(fromStored).includes(stored.depositSecretHash));
});

test("승인 결과 응답은 secret 을 지워서 돌려준다", () => {
    const stripped = va.stripPaymentSecret(issuedResponse);
    assert.equal(stripped.secret, undefined);
    assert.equal(issuedResponse.secret, SECRET, "원본은 건드리지 않는다");
    const confirm = fnBody(ledger, "export async function confirmTossPayment(");
    assert.match(confirm, /payment: stripPaymentSecret\(result\)/);
    assert.match(confirm, /payment: stripPaymentSecret\(lookup\.payment\)/);
    assert.doesNotMatch(confirm, /payment: result \}/);
});

test("학부모 화면용 조회 SQL 은 발급 정보 칸만 고르고 secret 해시·원문 응답 전체를 고르지 않는다", () => {
    const state = fnBody(ledger, "export async function getVirtualAccountState(");
    assert.match(state, /"rawResponse"->'virtualAccountIssue' AS issue/);
    assert.doesNotMatch(state, /depositSecretHash/);
    assert.doesNotMatch(state, /SELECT \*/);
    const lateral = queries.slice(queries.indexOf("const PARENT_VIRTUAL_ACCOUNT_LATERAL"), queries.indexOf("export const getPayments"));
    assert.match(lateral, /t\."rawResponse"->'virtualAccountIssue' AS issue/);
    assert.doesNotMatch(lateral, /depositSecretHash/);
    // 마이페이지 두 경로(메인·전체 내역)가 같은 조인을 쓴다
    assert.equal(queries.split("${PARENT_VIRTUAL_ACCOUNT_LATERAL}").length - 1, 2);
    assert.equal(queries.split("parentVirtualAccountView(p.status, p.va_status, p.va_issue, Date.now())").length - 1, 2);
    // 학부모 화면 부품은 secret 을 다루지 않는다
    for (const src of [notice, checkoutClient, successClient]) {
        assert.doesNotMatch(src, /secret/i);
        assert.doesNotMatch(src, /virtualAccountSecret/);
    }
});

test("마이페이지: 납부·환불·취소된 청구에는 계좌를 보이지 않는다", () => {
    const issue = va.extractVirtualAccountIssue(issuedResponse, 180000);
    assert.equal(va.parentVirtualAccountView("PAID", "WAITING_FOR_DEPOSIT", issue, 0), null);
    assert.equal(va.parentVirtualAccountView("PENDING", "READY", issue, 0), null);
    assert.equal(va.parentVirtualAccountView("PENDING", "WAITING_FOR_DEPOSIT", issue, 0).accountNumber, "X6505636518308");
    assert.equal(va.parentVirtualAccountView("OVERDUE", "EXPIRED", JSON.stringify(issue), 0).expired, true);
});

// ── 결제창 요청 ──────────────────────────────────────────────────────
test("결제창: 무통장입금은 VIRTUAL_ACCOUNT + 90일 + 현금영수증 소득공제 + 에스크로 끔 + 면세 금액", () => {
    assert.equal(va.VIRTUAL_ACCOUNT_VALID_HOURS, 2160);
    assert.match(checkoutClient, /value: "VIRTUAL_ACCOUNT", label: "무통장입금\(가상계좌\)", description: "입금 전용 계좌를 받아 아무 은행에서 입금"/);
    assert.match(checkoutClient, /validHours: VIRTUAL_ACCOUNT_VALID_HOURS/);
    assert.match(checkoutClient, /cashReceipt: \{ type: "소득공제" as const \}/);
    assert.match(checkoutClient, /useEscrow: false/);
    assert.match(checkoutClient, /taxFreeAmount: taxFreeAmountFor\(data\.amount\)/);
    assert.match(checkoutClient, /customerMobilePhone: data\.customerMobilePhone/);
    assert.match(successClient, /data\.waitingForDeposit && data\.virtualAccount/);
});

test("결제창 휴대폰 번호는 숫자 형식이 확실할 때만 넘긴다", () => {
    assert.equal(va.toTossMobilePhone("010-1234-5678"), "01012345678");
    assert.equal(va.toTossMobilePhone("011 123 4567"), "0111234567");
    assert.equal(va.toTossMobilePhone("02-123-4567"), undefined);
    assert.equal(va.toTossMobilePhone(null), undefined);
});

test("은행 코드는 이름으로, 모르는 코드는 숫자 그대로", () => {
    assert.equal(va.bankNameFor("88"), "신한은행");
    assert.equal(va.bankNameFor("90"), "카카오뱅크");
    assert.equal(va.bankNameFor("99"), "은행(99)");
});

// ── 화면: 안내 부품을 실제로 그려 본다 ─────────────────────────────────────
test("화면: «입금 대기 — 은행 계좌 (예금주) 금액 · 기한(KST)까지» + 계좌번호 복사, 만료면 «기한 만료 — 다시 발급»", async () => {
    const { default: ts } = await import("typescript");
    const vm = await import("node:vm");
    const { createRequire } = await import("node:module");
    const React = (await import("react")).default;
    const { renderToStaticMarkup } = await import("react-dom/server");
    const require = createRequire(import.meta.url);
    const compiled = ts.transpileModule(notice, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    const mod = { exports: {} };
    vm.runInNewContext(compiled, { module: mod, exports: mod.exports, require });
    const Notice = mod.exports.default;

    const issue = va.extractVirtualAccountIssue(issuedResponse, 180000);
    const open = va.toPublicVirtualAccountView(issue, "WAITING_FOR_DEPOSIT", Date.parse("2026-11-08T00:00:00Z"));
    const html = renderToStaticMarkup(React.createElement(Notice, { account: open }));
    assert.match(html, /입금 대기/);
    assert.match(html, /우리은행 X6505636518308 \(김학부모\)/);
    assert.match(html, /180,000원 · 2027년 2월 6일 14:30까지/);
    assert.match(html, /계좌번호 복사/);
    assert.match(html, /min-h-11/); // 터치 44px

    const expired = va.toPublicVirtualAccountView(issue, "EXPIRED", 0);
    const expiredHtml = renderToStaticMarkup(React.createElement(Notice, { account: expired, onReissue: () => {} }));
    assert.match(expiredHtml, /기한 만료 — 다시 발급/);
    assert.match(expiredHtml, /새 입금 계좌 받기/);
    assert.doesNotMatch(expiredHtml, /계좌번호 복사/);
});

test("입금 시각: 시간대 없는 DEPOSIT_CALLBACK createdAt 은 KST 로 읽는다(서버 UTC 에서 9시간 밀리지 않는다)", () => {
    // KST 2026-12-01 00:30 = UTC 2026-11-30 15:30 (월말 자정 경계)
    assert.equal(va.parseTossTimestamp("2026-12-01T00:30:00.000000").toISOString(), "2026-11-30T15:30:00.000Z");
    assert.equal(va.parseTossTimestamp("2026-12-01T00:30:00").toISOString(), "2026-11-30T15:30:00.000Z");
    // 시간대가 붙어 오면 그대로
    assert.equal(va.parseTossTimestamp("2026-12-01T00:30:00+09:00").toISOString(), "2026-11-30T15:30:00.000Z");
    assert.equal(va.parseTossTimestamp("2026-11-30T15:30:00Z").toISOString(), "2026-11-30T15:30:00.000Z");
    assert.equal(va.parseTossTimestamp("아님"), null);
    assert.equal(va.parseTossTimestamp(null), null);
});
