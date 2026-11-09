import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

// 학부모 온라인 «묶음 결제»(2026-11-09) — 토스 주문 1건 = 청구 N건(PaymentTransactionItem).
// 1) 순수 규칙(checkoutBundle.ts)은 실제로 실행한다.
// 2) 장부 연결부(bundleLedger.ts)는 메모리 가짜 DB 로 실행한다 — «한 건 이미 납부 → 전부 되돌림», «전액 취소 → 전부 환불».
// 3) payment-ledger.ts 는 가짜 prisma·가짜 fetch 를 끼워 실제로 실행한다(토스 실호출 없음) —
//    «묶음 계좌 대기 중 단건 시작 거부», «승인 전 묶인 청구 재확인», «IDOR·랠리즈 사본 차단».
// 4) 앞으로 생길 경로까지 막는 소스 계약(같은 규칙의 두 경로 = 같은 커밋).

const rules = await loadTsModule("src/lib/payments/checkoutBundle.ts");
const ledgerDb = await loadTsModule("src/lib/payments/bundleLedger.ts");

const ledgerSrc = readFileSync(new URL("../src/lib/payment-ledger.ts", import.meta.url), "utf8");
const queriesSrc = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
const parentReqSrc = readFileSync(new URL("../src/lib/payments/parent-payment-request.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../prisma/migrations/20261109150000_payment_transaction_items/migration.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const checkoutRoute = readFileSync(new URL("../src/app/api/mypage/payments/checkout/route.ts", import.meta.url), "utf8");
const confirmRoute = readFileSync(new URL("../src/app/api/mypage/payments/confirm/route.ts", import.meta.url), "utf8");
const requestRoute = readFileSync(new URL("../src/app/api/mypage/payment-request/route.ts", import.meta.url), "utf8");

/** 함수 본문만 잘라 본다(다른 함수의 SQL 과 섞이지 않게). */
function fnBody(source, header) {
    const start = source.indexOf(header);
    assert.ok(start >= 0, `${header} 를 찾을 수 없습니다`);
    const ends = ["\nasync function ", "\nexport async function ", "\nfunction ", "\nexport function "]
        .map((marker) => source.indexOf(marker, start + header.length))
        .filter((i) => i > 0);
    return source.slice(start, ends.length ? Math.min(...ends) : undefined);
}

/** 학생 한 명·청구 한 건(서버가 DB 에서 다시 읽은 모양) */
function row(over = {}) {
    return {
        paymentId: "pay-1", invoiceId: "inv-1", studentId: "stu-1", studentName: "김민준",
        type: "MONTHLY", year: 2026, month: 11, title: "11월 수강료",
        paymentStatus: "PENDING", invoiceStatus: "ISSUED", amount: 180000, invoiceAmount: 180000,
        isPayer: true, rallyzMirror: false,
        ...over,
    };
}

// ───────────────────────────── 1. 순수 규칙 ─────────────────────────────

test("규칙: 상한은 원장 결정 D5 — 10건 · 100만 원", () => {
    assert.equal(rules.MAX_BUNDLE_ITEMS, 10);
    assert.equal(rules.MAX_BUNDLE_TOTAL, 1_000_000);
});

test("규칙: 형제 청구도 묶을 수 있다(D2) — 대표 보호자면 학생이 달라도 ok", () => {
    const rows = [row(), row({ paymentId: "pay-2", invoiceId: "inv-2", studentId: "stu-2", studentName: "김서윤", type: "SHUTTLE", amount: 50000, invoiceAmount: 50000 })];
    assert.deepEqual(rules.bundleCheckoutEligibility(["pay-1", "pay-2"], rows), { ok: true });
});

test("규칙: 빈 목록·중복·11건은 막는다", () => {
    assert.equal(rules.bundleCheckoutEligibility([], []).code, "EMPTY");
    assert.equal(rules.bundleCheckoutEligibility(["pay-1", ""], [row()]).code, "EMPTY");
    assert.equal(rules.bundleCheckoutEligibility(["pay-1", "pay-1"], [row()]).code, "DUPLICATE");
    const ids = Array.from({ length: 11 }, (_, i) => `p${i}`);
    assert.equal(rules.bundleCheckoutEligibility(ids, []).code, "TOO_MANY");
});

test("규칙: 서버가 못 읽은 id(남의 청구) = NOT_FOUND — IDOR 차단", () => {
    const result = rules.bundleCheckoutEligibility(["pay-1", "someone-else"], [row()]);
    assert.equal(result.ok, false);
    assert.equal(result.code, "NOT_FOUND");
    assert.equal(result.paymentId, "someone-else");
});

test("규칙: 대표 보호자 아님 · 랠리즈 사본(D4) · 이미 납부 · 청구서 없음 · 금액 변경 · 100만 원 초과를 각각 막는다", () => {
    const one = (over) => rules.bundleCheckoutEligibility(["pay-1"], [row(over)]).code;
    assert.equal(one({ isPayer: false }), "NOT_PAYER");
    assert.equal(one({ rallyzMirror: true }), "RALLYZ_MIRROR");
    assert.equal(one({ paymentStatus: "PAID" }), "NOT_UNPAID");
    assert.equal(one({ invoiceStatus: "PAID" }), "NOT_UNPAID");
    assert.equal(one({ paymentStatus: "CANCELED" }), "NOT_UNPAID");
    assert.equal(one({ invoiceId: null, invoiceStatus: null }), "NO_INVOICE");
    assert.equal(one({ amount: 0, invoiceAmount: 0 }), "AMOUNT_INVALID");
    assert.equal(one({ invoiceAmount: 170000 }), "AMOUNT_CHANGED");
    assert.equal(rules.bundleCheckoutEligibility(["pay-1"], [row({ paymentStatus: "OVERDUE" })]).ok, true);
    const big = [row({ amount: 600000, invoiceAmount: 600000 }), row({ paymentId: "pay-2", invoiceId: "inv-2", amount: 400001, invoiceAmount: 400001 })];
    assert.equal(rules.bundleCheckoutEligibility(["pay-1", "pay-2"], big).code, "TOO_MUCH");
    const exact = [row({ amount: 600000, invoiceAmount: 600000 }), row({ paymentId: "pay-2", invoiceId: "inv-2", amount: 400000, invoiceAmount: 400000 })];
    assert.equal(rules.bundleCheckoutEligibility(["pay-1", "pay-2"], exact).ok, true, "딱 100만 원은 된다");
    // 학부모 문장에 개발 용어가 없다
    for (const message of Object.values(rules.BUNDLE_BLOCK_MESSAGE)) assert.doesNotMatch(message, /IDOR|SQL|null|undefined|invoice/i);
});

test("규칙: 항목 순서 = POS 묶음과 같은 정렬(연·월 → 수강료·셔틀비 → id), 1번이 대표 청구 · 면세 = 항목 면세 합", () => {
    const rows = [
        row({ paymentId: "c", invoiceId: "ic", type: "SHUTTLE", amount: 50000, invoiceAmount: 50000 }),
        row({ paymentId: "b", invoiceId: "ib", month: 10, amount: 180000 }),
        row({ paymentId: "a", invoiceId: "ia", amount: 170000, invoiceAmount: 170000 }),
    ];
    const items = rules.buildBundleItems(rows);
    assert.deepEqual(items.map((item) => [item.paymentId, item.position]), [["b", 1], ["a", 2], ["c", 3]]);
    assert.deepEqual(rules.bundleTotals(items), { amount: 400000, taxFreeAmount: 400000 });
    for (const item of items) assert.equal(item.taxFreeAmount, item.amount, "지금은 전액 면세(taxFree.ts)");
    assert.equal(rows[0].paymentId, "c", "원본 배열은 바꾸지 않는다");
});

test("규칙: 주문 이름 «학생 첫 청구 외 N건»(80자 이내) · 주문 번호는 토스 형식(6~64자, 영문·숫자·-_)", () => {
    const items = rules.buildBundleItems([row(), row({ paymentId: "pay-2", invoiceId: "inv-2", type: "SHUTTLE" }), row({ paymentId: "pay-3", invoiceId: "inv-3", type: "OTHER" })]);
    assert.equal(rules.buildBundleOrderName(items), "김민준 11월 수강료 외 2건");
    assert.equal(rules.buildBundleOrderName(items.slice(0, 1)), "김민준 11월 수강료");
    assert.ok(rules.buildBundleOrderName([{ studentName: "가".repeat(50), title: "나".repeat(50) }]).length <= 80);
    const orderId = rules.makeBundleOrderId(1762000000000, "a1b2c3d4-e5f6-7890");
    assert.equal(orderId, "STIZ-B-1762000000000-a1b2c3d4");
    assert.match(orderId, /^[A-Za-z0-9_-]{6,64}$/);
    assert.match(rules.makeBundleOrderId(1, "!!@@"), /^STIZ-B-1-bundle$/);
});

test("규칙: 같은 묶음 판단은 순서 무관 · 금액까지 같아야 같은 묶음", () => {
    const a = [{ paymentId: "x", amount: 1 }, { paymentId: "y", amount: 2 }];
    assert.equal(rules.sameBundleItems(a, [{ paymentId: "y", amount: 2 }, { paymentId: "x", amount: 1 }]), true);
    assert.equal(rules.sameBundleItems(a, [{ paymentId: "x", amount: 1 }]), false);
    assert.equal(rules.sameBundleItems(a, [{ paymentId: "x", amount: 1 }, { paymentId: "y", amount: 3 }]), false);
    assert.equal(rules.sameBundleItems([], []), false);
});

function locked(over = {}) {
    return { paymentId: "pay-1", invoiceId: "inv-1", itemAmount: 180000, paymentAmount: 180000, paymentStatus: "PENDING", invoiceStatus: "ISSUED", ...over };
}

test("판정: 반영 = 전부 미납·금액 그대로일 때만, 하나라도 이미 납부면 아무것도 안 바꾼다(카드·무통장 코드 구분)", () => {
    const items = [locked(), locked({ paymentId: "pay-2", invoiceId: "inv-2", itemAmount: 50000, paymentAmount: 50000 })];
    const base = { txStatus: "IN_PROGRESS", txAmount: 230000, isVirtualAccount: false, items };
    assert.deepEqual(rules.decideBundleFinalize(base), { action: "PAY" });
    const onePaid = [items[0], { ...items[1], paymentStatus: "PAID", invoiceStatus: "PAID" }];
    assert.deepEqual(rules.decideBundleFinalize({ ...base, items: onePaid }), { action: "REJECT", code: "BUNDLE_ITEM_ALREADY_PAID" });
    assert.deepEqual(rules.decideBundleFinalize({ ...base, txStatus: "WAITING_FOR_DEPOSIT", isVirtualAccount: true, items: onePaid }),
        { action: "REJECT", code: "VIRTUAL_ACCOUNT_ALREADY_PAID" }, "무통장 = 기존 «확인 필요» 코드");
    const allPaid = items.map((item) => ({ ...item, paymentStatus: "PAID", invoiceStatus: "PAID" }));
    assert.deepEqual(rules.decideBundleFinalize({ ...base, txStatus: "DONE", items: allPaid }), { action: "ALREADY_DONE" });
    assert.equal(rules.decideBundleFinalize({ ...base, txAmount: 230001 }).code, "BUNDLE_AMOUNT_MISMATCH");
    assert.equal(rules.decideBundleFinalize({ ...base, items: [] }).code, "BUNDLE_ITEMS_MISSING");
    assert.equal(rules.decideBundleFinalize({ ...base, txStatus: "CANCELED" }).code, "PAYMENT_ALREADY_CLOSED");
    assert.equal(rules.decideBundleFinalize({ ...base, items: [items[0], { ...items[1], paymentStatus: "REFUNDED" }] }).code, "BUNDLE_ITEM_CLOSED");
    assert.equal(rules.decideBundleFinalize({ ...base, items: [items[0], { ...items[1], paymentAmount: 60000 }] }).code, "BUNDLE_ITEM_AMOUNT_CHANGED");
});

test("판정: 승인 전 재확인 — 이미 납부·금액 변경·랠리즈 사본이면 승인하지 않는다", () => {
    assert.equal(rules.bundleConfirmBlock([locked()]), null);
    assert.equal(rules.bundleConfirmBlock([locked(), locked({ paymentId: "p2", paymentStatus: "PAID" })]), "NOT_UNPAID");
    assert.equal(rules.bundleConfirmBlock([locked({ paymentAmount: 1 })]), "AMOUNT_CHANGED");
    assert.equal(rules.bundleConfirmBlock([locked({ rallyzMirror: true })]), "RALLYZ_MIRROR");
    assert.equal(rules.bundleConfirmBlock([]), "EMPTY");
});

test("판정: 전액 취소 — 납부(PAID) 청구만 환불 목록, 이미 반영이면 다시 안 함, 결제 전 거래는 장부 반영 없음", () => {
    const items = [locked({ paymentStatus: "PAID" }), locked({ paymentId: "pay-2", paymentStatus: "PAID" }), locked({ paymentId: "pay-3", paymentStatus: "REFUNDED" })];
    assert.deepEqual(rules.decideBundleFullCancel({ txStatus: "DONE", items }), { action: "APPLY", refundPaymentIds: ["pay-1", "pay-2"] });
    assert.deepEqual(rules.decideBundleFullCancel({ txStatus: "CANCELED", items: items.map((i) => ({ ...i, paymentStatus: "REFUNDED" })) }), { action: "ALREADY_APPLIED" });
    assert.deepEqual(rules.decideBundleFullCancel({ txStatus: "READY", items }), { action: "REJECT", code: "PAYMENT_NOT_PAID" });
});

// ───────────────────────────── 2. 장부 연결부 — 메모리 가짜 DB ─────────────────────────────

/** bundleLedger.ts 의 SQL 만 흉내 내는 아주 작은 DB. 트랜잭션은 «실패하면 처음 상태로». */
function memoryDb(state) {
    const audits = [];
    let failPaymentUpdateFor = null; // 잠근 뒤 UPDATE 순간에 다른 경로가 납부한 상황(경합) 흉내
    const db = {
        async $queryRawUnsafe(sql, ...args) {
            if (/FROM "PaymentTransaction" WHERE id = \$1 FOR UPDATE/.test(sql)) {
                return state.tx && state.tx.id === args[0] ? [{ ...state.tx }] : [];
            }
            if (/FROM "PaymentTransactionItem" it/.test(sql)) {
                assert.match(sql, /FOR UPDATE OF p, i/, "확정·환불은 청구·청구서를 잠근다");
                assert.match(sql, /ORDER BY it\."paymentId"/, "잠금 순서는 청구 id 순(교착 방지)");
                return state.items.map((it) => ({
                    paymentId: it.paymentId, invoiceId: it.invoiceId, itemAmount: it.amount, taxFreeAmount: it.amount, position: it.position,
                    paymentAmount: state.payments[it.paymentId].amount, paymentStatus: state.payments[it.paymentId].status,
                    invoiceStatus: state.invoices[it.invoiceId].status,
                }));
            }
            if (/^UPDATE "Payment" SET status = 'PAID'/.test(sql.trim())) {
                const [id] = args;
                const p = state.payments[id];
                if (failPaymentUpdateFor === id) p.status = "PAID"; // 경합: 다른 경로가 먼저 납부
                if (!["PENDING", "OVERDUE"].includes(p.status) || p.amount !== args[6]) return [];
                p.status = "PAID";
                return [{ id }];
            }
            if (/^UPDATE "PaymentInvoice" SET status = 'PAID'/.test(sql.trim())) {
                const inv = state.invoices[args[0]];
                if (!["ISSUED", "SENT", "OVERDUE"].includes(inv.status)) return [];
                inv.status = "PAID";
                return [{ id: args[0] }];
            }
            throw new Error(`가짜 DB 가 모르는 조회: ${sql.slice(0, 80)}`);
        },
        async $executeRawUnsafe(sql, ...args) {
            const s = sql.trim();
            if (/^UPDATE "PaymentTransaction" SET status = 'DONE'/.test(s)) { state.tx.status = "DONE"; return 1; }
            if (/^UPDATE "PaymentTransaction" SET status = 'CANCELED'/.test(s)) {
                if (state.tx.status !== "DONE") return 0;
                state.tx.status = "CANCELED";
                return 1;
            }
            if (/^UPDATE "Payment" SET status = 'REFUNDED'/.test(s)) {
                const p = state.payments[args[0]];
                if (p.status !== "PAID") return 0;
                p.status = "REFUNDED";
                return 1;
            }
            if (/^UPDATE "PaymentInvoice" SET status = 'CANCELED'/.test(s)) { state.invoices[args[0]].status = "CANCELED"; return 1; }
            if (/^INSERT INTO "PaymentAuditLog"/.test(s)) { audits.push({ sql: s, args }); return 1; }
            throw new Error(`가짜 DB 가 모르는 쓰기: ${s.slice(0, 80)}`);
        },
    };
    return {
        db,
        audits,
        failOn(id) { failPaymentUpdateFor = id; },
        /** prisma.$transaction 흉내 — 던지면 상태·감사 기록을 처음으로 되돌린다 */
        async inTx(fn) {
            const snapshot = structuredClone(state);
            const auditCount = audits.length;
            try {
                return await fn(db);
            } catch (error) {
                Object.assign(state, structuredClone(snapshot));
                audits.length = auditCount;
                throw error;
            }
        },
    };
}

function bundleState(over = {}) {
    return {
        tx: { id: "tx-b", status: "IN_PROGRESS", amount: 230000, orderId: "STIZ-B-1-pay1" },
        items: [
            { paymentId: "pay-1", invoiceId: "inv-1", amount: 180000, position: 1 },
            { paymentId: "pay-2", invoiceId: "inv-2", amount: 50000, position: 2 },
        ],
        payments: { "pay-1": { status: "PENDING", amount: 180000 }, "pay-2": { status: "OVERDUE", amount: 50000 } },
        invoices: { "inv-1": { status: "SENT" }, "inv-2": { status: "OVERDUE" } },
        ...over,
    };
}

const finalizeInput = {
    transactionId: "tx-b", orderId: "STIZ-B-1-pay1", paymentKey: "pk-1", method: "카드", receiptUrl: "https://receipt",
    paidAtIso: null, rawResponse: { status: "DONE" }, methodIsVirtualAccount: false, actorType: "PARENT", actorId: "u1",
};

test("가짜 DB: 묶음 확정 — 묶인 청구·청구서 전부 납부, 거래 DONE, 감사 기록은 청구마다(bundle 정보 포함)", async () => {
    const state = bundleState();
    const mem = memoryDb(state);
    const result = await mem.inTx((db) => ledgerDb.finalizeBundleInTx(db, finalizeInput));
    assert.deepEqual(result, { ok: true, alreadyConfirmed: false, size: 2 });
    assert.equal(state.payments["pay-1"].status, "PAID");
    assert.equal(state.payments["pay-2"].status, "PAID");
    assert.equal(state.invoices["inv-1"].status, "PAID");
    assert.equal(state.invoices["inv-2"].status, "PAID");
    assert.equal(state.tx.status, "DONE");
    assert.equal(mem.audits.length, 2);
    for (const audit of mem.audits) assert.match(audit.sql, /'PAYMENT_MARK_PAID'/);
    assert.deepEqual(JSON.parse(mem.audits[1].args.at(-1)).bundle, { orderId: "STIZ-B-1-pay1", size: 2, position: 2, amount: 50000 });

    // 같은 결제가 다시 와도(웹훅·성공 화면 새로고침) 한 번만
    const again = await mem.inTx((db) => ledgerDb.finalizeBundleInTx(db, finalizeInput));
    assert.deepEqual(again, { ok: true, alreadyConfirmed: true, size: 2 });
    assert.equal(mem.audits.length, 2);
});

test("가짜 DB: 한 건이 이미 납부면 아무것도 바꾸지 않는다(판정 단계에서 거절)", async () => {
    const state = bundleState();
    state.payments["pay-2"].status = "PAID";
    state.invoices["inv-2"].status = "PAID";
    const mem = memoryDb(state);
    const result = await mem.inTx((db) => ledgerDb.finalizeBundleInTx(db, finalizeInput));
    assert.deepEqual(result, { ok: false, error: "BUNDLE_ITEM_ALREADY_PAID" });
    assert.equal(state.payments["pay-1"].status, "PENDING", "나머지 청구도 그대로");
    assert.equal(state.tx.status, "IN_PROGRESS");
    assert.equal(mem.audits.length, 0);

    // 무통장입금(입금 대기 거래) — 원장 «확인 필요» 코드
    const vaState = bundleState({ tx: { id: "tx-b", status: "WAITING_FOR_DEPOSIT", amount: 230000, orderId: "STIZ-B-1-pay1" } });
    vaState.payments["pay-1"].status = "PAID";
    const vaMem = memoryDb(vaState);
    const va = await vaMem.inTx((db) => ledgerDb.finalizeBundleInTx(db, { ...finalizeInput, methodIsVirtualAccount: true }));
    assert.deepEqual(va, { ok: false, error: "VIRTUAL_ACCOUNT_ALREADY_PAID" });
    assert.equal(vaState.payments["pay-2"].status, "OVERDUE");
});

test("가짜 DB: 반영 도중 한 건의 조건부 UPDATE 가 0행이면 던져서 전부 되돌린다(일부만 납부 금지)", async () => {
    const state = bundleState();
    const mem = memoryDb(state);
    mem.failOn("pay-2"); // 1번은 바뀐 뒤, 2번에서 경합
    await assert.rejects(
        mem.inTx((db) => ledgerDb.finalizeBundleInTx(db, finalizeInput)),
        (error) => error.message.startsWith(ledgerDb.BUNDLE_LEDGER_CONFLICT),
    );
    assert.equal(state.payments["pay-1"].status, "PENDING", "먼저 바뀐 1번도 되돌아갔다");
    assert.equal(state.invoices["inv-1"].status, "SENT");
    assert.equal(state.tx.status, "IN_PROGRESS");
    assert.equal(mem.audits.length, 0);
});

test("가짜 DB: 토스 전액 취소 → 묶인 청구 전부 환불·청구서 취소·거래 취소, 다시 와도 한 번만", async () => {
    const state = bundleState({ tx: { id: "tx-b", status: "DONE", amount: 230000, orderId: "STIZ-B-1-pay1" } });
    for (const p of Object.values(state.payments)) p.status = "PAID";
    for (const i of Object.values(state.invoices)) i.status = "PAID";
    const mem = memoryDb(state);
    const result = await mem.inTx((db) => ledgerDb.refundBundleInTx(db, { transactionId: "tx-b", rawResponse: { status: "CANCELED" } }));
    assert.deepEqual(result, { ok: true, alreadyApplied: false, refunded: 2 });
    assert.equal(state.payments["pay-1"].status, "REFUNDED");
    assert.equal(state.payments["pay-2"].status, "REFUNDED");
    assert.equal(state.invoices["inv-1"].status, "CANCELED");
    assert.equal(state.invoices["inv-2"].status, "CANCELED");
    assert.equal(state.tx.status, "CANCELED");
    assert.equal(mem.audits.length, 2);
    for (const audit of mem.audits) assert.match(audit.sql, /'PAYMENT_REFUNDED'/);
    const again = await mem.inTx((db) => ledgerDb.refundBundleInTx(db, { transactionId: "tx-b", rawResponse: {} }));
    assert.deepEqual(again, { ok: true, alreadyApplied: true, refunded: 0 });
    assert.equal(mem.audits.length, 2);
});

test("SQL 조각: 거래가 청구서·청구를 «대표로든 항목으로든» 품는지 — 식별자 외 입력은 거부", () => {
    const inv = ledgerDb.txCoversInvoiceSql("t", "$1");
    assert.match(inv, /t\."invoiceId" = \$1 OR EXISTS/);
    assert.match(inv, /"PaymentTransactionItem" tx_item[\s\S]*tx_item\."transactionId" = t\.id AND tx_item\."invoiceId" = \$1/);
    assert.match(ledgerDb.txCoversPaymentSql("t", "p.id"), /t\."paymentId" = p\.id OR EXISTS[\s\S]*tx_item\."paymentId" = p\.id/);
    assert.throws(() => ledgerDb.txCoversInvoiceSql("t; DROP", "$1"));
    assert.throws(() => ledgerDb.txCoversPaymentSql("t", "'x' OR 1=1"));
    // 단건 판정에 넘길 청구 상태: 묶인 청구 중 하나라도 PAID 면 PAID
    assert.match(ledgerDb.TX_PAYMENT_STATUS_SQL, /it\."transactionId" = \$2 AND ip\.status = 'PAID'\) THEN 'PAID'/);
});

// ───────────────────────────── 3. payment-ledger.ts 실제 실행(가짜 prisma · 가짜 fetch) ─────────────────────────────

// payment-ledger.ts 를 transpile 해서 올리되, 런타임 의존(prisma·next·슬랙·가족 연결)만 가짜 모듈로 바꾼다(conventions «가짜 prisma»).
const FAKE_MODULES = {
    "@/lib/prisma": "export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__bundleFake.prisma[key] });",
    "next/cache": "export function revalidatePath() {} export function revalidateTag() {}",
    "@/lib/slack/client": "export async function postMessage(m) { globalThis.__bundleFake.slack.push(m); return { ok: true }; }",
    "@/lib/account/child-access": "export async function childAccessSql(a, p) { return a + '.\"parentId\" = ' + p; }",
};
const loaded = new Map();
async function readTs(base) {
    for (const ext of ["", ".ts", ".tsx", "/index.ts"]) {
        try {
            const p = `${base}${ext}`;
            return { path: p.replace(/\\/g, "/"), code: await readFile(p, "utf8") };
        } catch { /* 다음 */ }
    }
    throw new Error(`모듈 없음: ${base}`);
}
async function moduleUrl(file) {
    const key = file.replace(/\\/g, "/");
    if (loaded.has(key)) return loaded.get(key);
    const { path: resolved, code } = await readTs(file);
    let out = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    const specs = [...out.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of new Set(specs)) {
        let url = null;
        if (FAKE_MODULES[spec]) url = `data:text/javascript;base64,${Buffer.from(FAKE_MODULES[spec]).toString("base64")}`;
        else if (spec.startsWith("@/")) url = await moduleUrl(path.join("src", spec.slice(2)));
        else if (spec.startsWith(".")) url = await moduleUrl(path.join(path.dirname(resolved), spec));
        if (url) out = out.split(`"${spec}"`).join(`"${url}"`).split(`'${spec}'`).join(`'${url}'`);
    }
    assert.doesNotMatch(out, /from\s+["']next\//, "가짜로 바꾸지 않은 next 의존이 남으면 안 된다");
    const url = `data:text/javascript;base64,${Buffer.from(out).toString("base64")}`;
    loaded.set(key, url);
    return url;
}
const ledger = await import(await moduleUrl("src/lib/payment-ledger.ts"));

/** 응답기(sql → 결과)로 움직이는 가짜 prisma. 모든 호출을 기록한다. */
function fakePrisma(responder) {
    const calls = [];
    const db = {
        async $queryRawUnsafe(sql, ...args) { calls.push({ kind: "query", sql, args }); return (await responder(sql, args, "query")) ?? []; },
        async $executeRawUnsafe(sql, ...args) { calls.push({ kind: "exec", sql, args }); return (await responder(sql, args, "exec")) ?? 0; },
        async $transaction(fn) { return fn(db); },
    };
    globalThis.__bundleFake = { prisma: db, slack: [] };
    return calls;
}

/** 토스 키(테스트용)·가짜 fetch 를 잠깐 끼웠다가 반드시 되돌린다 */
async function withToss(fetchImpl, fn) {
    const keys = ["NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY", "TOSS_PAYMENTS_SECRET_KEY", "PAYMENT_PROVIDER", "NEXT_PUBLIC_PAYMENT_PROVIDER", "SLACK_OWNER_USER_ID"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const savedFetch = globalThis.fetch;
    const fetchCalls = [];
    process.env.NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY = "test_ck_fake";
    process.env.TOSS_PAYMENTS_SECRET_KEY = "test_sk_fake";
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.NEXT_PUBLIC_PAYMENT_PROVIDER;
    process.env.SLACK_OWNER_USER_ID = "U-OWNER";
    globalThis.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        if (!fetchImpl) throw new Error("이 시나리오에서는 토스를 부르면 안 된다");
        return fetchImpl(String(url), init);
    };
    try {
        return await fn(fetchCalls);
    } finally {
        globalThis.fetch = savedFetch;
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

const OPEN_ISSUE = {
    bankCode: "20", bankName: "우리은행", accountNumber: "X6505636518308", customerName: "김학부모",
    dueDate: "2099-12-31T23:59:00+09:00", amount: 230000,
};
const owner = { authUserId: "auth-1", email: "parent@example.com" };
const isInsertTx = (call) => /INSERT INTO "PaymentTransaction"/.test(call.sql);

test("실행: 묶음 무통장 계좌 입금 대기 중에 그 안의 청구를 단건으로 결제 시작 → 새 주문 없이 그 계좌를 돌려준다", async () => {
    const calls = fakePrisma((sql) => {
        if (/FROM "PaymentInvoice" i/.test(sql) && /"rallyzMirror"/.test(sql)) {
            return [{ invoiceId: "inv-2", paymentId: "pay-2", studentId: "stu-2", parentId: "u1", invoiceNo: "STIZ-202611-x", invoiceStatus: "SENT",
                amount: 50000, title: "11월 셔틀비", paymentStatus: "PENDING", studentName: "김서윤", parentEmail: "parent@example.com", rallyzMirror: false }];
        }
        if (/virtualAccountIssue' AS issue/.test(sql)) {
            // 단건 청구서(inv-2)는 묶음 주문의 2번 항목 — 항목 표까지 보는 조회여야 찾는다
            return /PaymentTransactionItem/.test(sql) ? [{ status: "WAITING_FOR_DEPOSIT", issue: OPEN_ISSUE }] : [];
        }
    });
    await withToss(null, async (fetchCalls) => {
        const result = await ledger.createCheckoutSession({ invoiceId: "inv-2", owner, origin: "https://stiz.example", method: "CARD" });
        assert.equal(result.ok, true);
        assert.equal(result.openVirtualAccount?.amount, 230000, "묶음 계좌(합계)를 보여 준다");
        assert.equal(calls.some(isInsertTx), false, "새 결제 주문을 만들지 않는다");
        assert.equal(fetchCalls.length, 0);
    });
});

test("실행: 랠리즈 사본 청구는 단건 결제를 시작하지 않는다(D4)", async () => {
    const calls = fakePrisma((sql) => {
        if (/FROM "PaymentInvoice" i/.test(sql) && /"rallyzMirror"/.test(sql)) {
            assert.match(sql, /RALLYZ_APPROVED_EXISTING_INVOICE_MIRROR/);
            return [{ invoiceId: "inv-1", paymentId: "pay-1", studentId: "stu-1", parentId: "u1", invoiceStatus: "SENT",
                amount: 180000, title: "11월 수강료", paymentStatus: "PENDING", studentName: "김민준", parentEmail: "p@x", rallyzMirror: true }];
        }
    });
    await withToss(null, async () => {
        const result = await ledger.createCheckoutSession({ invoiceId: "inv-1", owner, origin: "https://stiz.example", method: "CARD" });
        assert.equal(result.ok, false);
        assert.equal(result.rallyzMirror, true);
        assert.match(result.error, /랠리즈/);
        assert.equal(calls.some(isInsertTx), false);
    });
});

/** 묶음 거래 1건(대표 청구 pay-1) + 항목 2건 응답기 */
function bundleConfirmResponder(itemStatuses, extra = () => undefined) {
    return (sql, args, kind) => {
        const hit = extra(sql, args, kind);
        if (hit !== undefined) return hit;
        if (/WHERE tx\."orderId" = \$1/.test(sql)) {
            return [{ id: "tx-b", paymentId: "pay-1", invoiceId: "inv-1", studentId: "stu-1", parentId: "u1", orderId: "STIZ-B-1-pay1",
                paymentKey: null, amount: 230000, status: "READY", invoiceStatus: "SENT", paymentStatus: "PENDING" }];
        }
        if (/FROM "PaymentTransactionItem" it/.test(sql) && /JOIN "PaymentInvoice" i ON i\.id = it\."invoiceId"/.test(sql)) {
            return [
                { paymentId: "pay-1", invoiceId: "inv-1", itemAmount: 180000, taxFreeAmount: 180000, position: 1, paymentAmount: 180000, paymentStatus: itemStatuses[0], invoiceStatus: itemStatuses[0] === "PAID" ? "PAID" : "SENT" },
                { paymentId: "pay-2", invoiceId: "inv-2", itemAmount: 50000, taxFreeAmount: 50000, position: 2, paymentAmount: 50000, paymentStatus: itemStatuses[1], invoiceStatus: itemStatuses[1] === "PAID" ? "PAID" : "SENT" },
            ];
        }
        if (/mirror_log/.test(sql)) return [];
        return undefined;
    };
}

test("실행: 묶음 카드 승인 전 재확인 — 묶인 청구 하나가 이미 납부면 토스 승인을 부르지 않는다(돈 안 나감)", async () => {
    fakePrisma(bundleConfirmResponder(["PENDING", "PAID"]));
    await withToss(null, async (fetchCalls) => {
        const result = await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: "STIZ-B-1-pay1", amount: 230000, invoiceId: null, owner });
        assert.equal(result.ok, false);
        assert.equal(result.blocked, "NOT_UNPAID");
        assert.equal(result.alreadyPaid, true);
        assert.equal(fetchCalls.length, 0, "토스 confirm 호출 없음");
    });
});

test("실행: 묶음 카드 승인 → 토스 confirm 1회(합계 금액) → 묶인 청구 2건을 한 트랜잭션에서 납부", async () => {
    const tossDone = { paymentKey: "pk-1", orderId: "STIZ-B-1-pay1", status: "DONE", method: "카드", totalAmount: 230000,
        taxFreeAmount: 230000, suppliedAmount: 0, vat: 0, receipt: { url: "https://receipt/1" } };
    const calls = fakePrisma(bundleConfirmResponder(["PENDING", "OVERDUE"], (sql) => {
        if (/AS found/.test(sql)) return [{ found: true }];
        if (/FROM "PaymentTransaction" WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ id: "tx-b", status: "IN_PROGRESS", amount: 230000 }];
        if (/^UPDATE "Payment" SET status = 'PAID'/.test(sql.trim())) return [{ id: "x" }];
        if (/^UPDATE "PaymentInvoice" SET status = 'PAID'/.test(sql.trim())) return [{ id: "x" }];
        if (/^UPDATE "PaymentTransaction" SET status = 'DONE'/.test(sql.trim())) return 1;
        return undefined;
    }));
    await withToss(async (url, init) => {
        assert.equal(url, "https://api.tosspayments.com/v1/payments/confirm");
        assert.equal(JSON.parse(init.body).amount, 230000);
        return new Response(JSON.stringify(tossDone), { status: 200 });
    }, async (fetchCalls) => {
        const result = await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: "STIZ-B-1-pay1", amount: 230000, invoiceId: null, owner });
        assert.equal(result.ok, true);
        assert.equal(fetchCalls.length, 1);
        const paid = calls.filter((c) => /^UPDATE "Payment" SET status = 'PAID'/.test(c.sql.trim()));
        assert.deepEqual(paid.map((c) => c.args[0]), ["pay-1", "pay-2"]);
        for (const c of paid) assert.equal(c.args[2], "STIZ-B-1-pay1", "청구마다 같은 주문 번호");
        for (const c of paid) assert.equal(c.args[4], "https://receipt/1", "영수증 주소는 묶인 청구 모두 같은 값");
        const audits = calls.filter((c) => /INSERT INTO "PaymentAuditLog"/.test(c.sql) && /'PAYMENT_MARK_PAID'/.test(c.sql));
        assert.equal(audits.length, 2);
    });
});

/** 묶음 결제 시작 응답기 — 학부모가 볼 수 있는 청구(ownRows)만 돌려준다 */
function bundleStartResponder(ownRows, extra = () => undefined) {
    return (sql, args, kind) => {
        const hit = extra(sql, args, kind);
        if (hit !== undefined) return hit;
        if (/AS "isPayer"/.test(sql)) {
            assert.match(sql, /s\."parentId" = \$1/, "가족 연결 범위(childAccessSql)로 거른다");
            assert.match(sql, /"mergedIntoStudentId" IS NULL/, "병합된 학생 제외");
            const ids = args[1];
            return ownRows.filter((r) => !ids || ids.includes(r.paymentId));
        }
        if (/AND \(t\."paymentId" = ANY\(\$1::text\[\]\)/.test(sql)) return [];
        if (/INTERVAL '30 minutes'/.test(sql)) return [];
        if (/INSERT INTO "PaymentTransaction"/.test(sql)) return [{ id: "tx-new" }];
        if (/INSERT INTO "PaymentTransactionItem"/.test(sql)) return 1;
        if (/FROM "User" WHERE id = \$1/.test(sql)) return [{ name: "김학부모", email: "parent@example.com", phone: "01012345678" }];
        return undefined;
    };
}

test("실행: 묶음 결제 시작 — 남의 청구 id 가 섞이면(IDOR) 주문을 만들지 않는다", async () => {
    const calls = fakePrisma(bundleStartResponder([row()]));
    await withToss(null, async () => {
        const result = await ledger.createBundleCheckoutSession({ parentUserId: "u1", paymentIds: ["pay-1", "other-family"], origin: "https://stiz.example", method: "CARD" });
        assert.equal(result.ok, false);
        assert.equal(result.blocked, "NOT_FOUND");
        assert.equal(calls.some(isInsertTx), false);
    });
});

test("실행: 묶음 결제 시작 — 고른 청구가 다른 입금 대기 계좌에 들어 있으면 확인 없이 진행하지 않는다", async () => {
    const rows = [row(), row({ paymentId: "pay-2", invoiceId: "inv-2", studentId: "stu-2", studentName: "김서윤", amount: 50000, invoiceAmount: 50000 })];
    const calls = fakePrisma(bundleStartResponder(rows, (sql) => {
        if (/AND \(t\."paymentId" = ANY\(\$1::text\[\]\)/.test(sql)) {
            // pay-2 단건 무통장 계좌가 열려 있다
            return [{ id: "tx-va", paymentId: "pay-2", invoiceId: "inv-2", orderId: "STIZ-9-inv2", amount: 50000, status: "WAITING_FOR_DEPOSIT",
                paymentKey: "pk-va", rawResponse: { virtualAccountIssue: { ...OPEN_ISSUE, amount: 50000 } } }];
        }
        if (/FROM "PaymentTransactionItem" it/.test(sql)) return []; // 그 계좌는 단건 거래
        return undefined;
    }));
    await withToss(null, async (fetchCalls) => {
        const result = await ledger.createBundleCheckoutSession({ parentUserId: "u1", paymentIds: ["pay-1", "pay-2"], origin: "https://stiz.example", method: "CARD" });
        assert.equal(result.ok, false);
        assert.equal(result.openVirtualAccountConflict, true);
        assert.deepEqual(result.openVirtualAccounts[0].paymentIds, ["pay-2"]);
        assert.equal(calls.some(isInsertTx), false, "계좌가 열린 채 새 주문을 만들면 이중 납부");
        assert.equal(fetchCalls.length, 0);
    });
});

test("실행: 묶음 결제 시작 — 형제 2건으로 주문 1건 + 항목 2건, 합계·면세 합계·앱 안 복귀 주소", async () => {
    const rows = [
        row({ paymentId: "pay-2", invoiceId: "inv-2", studentId: "stu-2", studentName: "김서윤", type: "SHUTTLE", amount: 50000, invoiceAmount: 50000 }),
        row(),
    ];
    const calls = fakePrisma(bundleStartResponder(rows));
    await withToss(null, async (fetchCalls) => {
        const result = await ledger.createBundleCheckoutSession({ parentUserId: "u1", paymentIds: ["pay-2", "pay-1"], origin: "https://stiz.example/", method: "CARD" });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.amount, 230000);
        assert.equal(result.taxFreeAmount, 230000, "면세 = 항목 면세 합");
        assert.equal(result.orderName, "김민준 11월 수강료 외 1건", "대표 = 정렬 첫 항목(수강료)");
        assert.match(result.orderId, /^STIZ-B-\d+-pay-1$/);
        assert.equal(result.successUrl, "https://stiz.example/mypage/payments/done");
        assert.ok(result.failUrl.startsWith("https://stiz.example/mypage/payments/checkout"));
        assert.equal(result.clientKey, "test_ck_fake");
        const txInsert = calls.find(isInsertTx);
        assert.deepEqual(txInsert.args.slice(0, 4), ["pay-1", "inv-1", "stu-1", "u1"], "대표 청구 + 결제하는 학부모");
        assert.equal(txInsert.args[6], 230000, "거래 금액 = 합계");
        const itemInserts = calls.filter((c) => /INSERT INTO "PaymentTransactionItem"/.test(c.sql));
        assert.deepEqual(itemInserts.map((c) => [c.args[1], c.args[3], c.args[4], c.args[5]]), [["pay-1", 180000, 180000, 1], ["pay-2", 50000, 50000, 2]]);
        assert.equal(fetchCalls.length, 0, "결제창은 화면이 연다 — 서버는 토스를 부르지 않는다");
    });
});

// ───────────────────────────── 4. 소스 계약 ─────────────────────────────

test("계약: 확정·전액 취소는 «항목 있음»이면 묶음 갈래로 간다(승인·웹훅·가상계좌 입금·매일 점검이 모두 이 두 함수를 지난다)", () => {
    const finalize = fnBody(ledgerSrc, "async function finalizeVerifiedTossPayment(");
    const branch = finalize.indexOf("if (await hasBundleItems(prisma, input.tx.id))");
    assert.ok(branch > 0 && branch < finalize.indexOf("return prisma.$transaction(async (db) =>"), "단건 잠금보다 먼저 갈린다");
    assert.match(finalize, /finalizeVerifiedBundlePayment\(/);
    const bundle = fnBody(ledgerSrc, "async function finalizeVerifiedBundlePayment(");
    assert.match(bundle, /prisma\.\$transaction\(\(db\) => finalizeBundleInTx\(db,/);
    assert.match(bundle, /BUNDLE_LEDGER_CONFLICT/);
    assert.match(bundle, /!isVirtualAccount\) \{\s*await recordBundlePaymentReview/, "카드 묶음 반영 실패 = 원장 확인(돈은 나갔다)");
    const cancel = fnBody(ledgerSrc, "async function applyVerifiedTossFullCancel(");
    assert.match(cancel, /hasBundleItems\(prisma, input\.tx\.id\)[\s\S]*?refundBundleInTx\(db,/);
});

test("계약(이중 납부): 단건 경로의 열린 계좌 조회·닫기·마이페이지·관리자 목록이 모두 묶음 항목까지 본다", () => {
    assert.match(fnBody(ledgerSrc, "export async function getVirtualAccountState("), /txCoversInvoiceSql\("t", "\$1"\)/);
    assert.match(fnBody(ledgerSrc, "async function closeOpenVirtualAccount("), /txCoversInvoiceSql\("t", "\$1"\)/);
    const single = fnBody(ledgerSrc, "export async function createCheckoutSession(");
    assert.match(single, /getVirtualAccountState\(invoice\.invoiceId\)/);
    assert.match(single, /invoice\.rallyzMirror === true/);
    assert.match(fnBody(ledgerSrc, "export async function getInvoiceForParent("), /rallyzMirrorExclusionSql\("p"\)/);
    // 무통장 입금 판정은 묶인 청구 중 하나라도 납부면 «확인 필요»
    assert.match(fnBody(ledgerSrc, "async function payVerifiedVirtualAccount("), /TX_PAYMENT_STATUS_SQL,\s*tx\.paymentId,\s*tx\.id/);
    assert.match(fnBody(ledgerSrc, "async function applyVirtualAccountWebhook("), /TX_PAYMENT_STATUS_SQL,\s*tx\.paymentId,\s*tx\.id/);
    // 매일 점검은 입금 대기 거래 전부(묶음 포함)를 훑는다 — 거래 표만 보고 청구로 거르지 않는다
    assert.match(fnBody(ledgerSrc, "export async function sweepWaitingVirtualAccounts("), /FROM "PaymentTransaction"\s+WHERE status = '\$\{VA_WAITING_STATUS\}' AND "paymentKey" IS NOT NULL/);
    assert.match(queriesSrc, /PARENT_VIRTUAL_ACCOUNT_LATERAL = `LEFT JOIN LATERAL \([\s\S]*?txCoversPaymentSql\("t", "p\.id"\)/);
    assert.match(queriesSrc, /SELECT t\.status, t\.provider\s+FROM "PaymentTransaction" t\s+WHERE \$\{txCoversPaymentSql\("t", "p\.id"\)\}/);
});

test("계약: 토스 승인 직전 재확인이 confirm 호출보다 먼저 있다", () => {
    const confirm = fnBody(ledgerSrc, "export async function confirmTossPayment(");
    const check = confirm.indexOf("await checkBeforeTossConfirm(tx)");
    const call = confirm.indexOf('fetch("https://api.tosspayments.com/v1/payments/confirm"');
    assert.ok(check > 0 && call > check);
});

test("계약: 묶음 결제 시작 — 서버가 다시 읽고(가족 범위·대표 보호자·랠리즈), 계좌 확인 뒤에, 거래+항목을 한 트랜잭션에", () => {
    const load = fnBody(ledgerSrc, "async function loadBundleCandidateRows(");
    assert.match(load, /childAccessSql\("s", "\$1"\)/);
    assert.match(load, /notMergedStudent\("s"\)/);
    assert.match(load, /\(s\."parentId" = \$1\) AS "isPayer"/);
    assert.match(load, /rallyzMirrorExclusionSql\("p"\)/);
    const start = fnBody(ledgerSrc, "export async function createBundleCheckoutSession(");
    assert.ok(start.indexOf("findOpenVirtualAccountsForPayments(") < start.indexOf('INSERT INTO "PaymentTransaction"'));
    assert.match(start, /await prisma\.\$transaction\(async \(db\) => \{[\s\S]*?INSERT INTO "PaymentTransaction"[\s\S]*?INSERT INTO "PaymentTransactionItem"/);
    assert.match(start, /config\.provider !== "TOSS"/, "카페24 결제 방식은 묶음 없음");
    const order = fnBody(ledgerSrc, "export async function getBundleOrderForParent(");
    assert.match(order, /t\."orderId" = \$1 AND t\."parentId" = \$2/, "남의 주문 번호면 못 본다");
    // ORM 기본 메서드 금지(PgBouncer)
    for (const body of [load, start, order]) assert.doesNotMatch(body, /prisma\.\w+\.(findMany|findFirst|create|update|upsert)\(/);
});

test("계약: 화면 갈래가 쓸 API — 앱 범위(/mypage) 안, 학부모 인증·앱 계정 id 로만", () => {
    for (const route of [checkoutRoute, confirmRoute]) assert.match(route, /requireVerifiedParent\(\)/);
    assert.match(checkoutRoute, /getBundleCheckoutCandidates\(parent\.appUserId\)/);
    assert.match(checkoutRoute, /createBundleCheckoutSession\(\{\s*parentUserId: parent\.appUserId/);
    assert.match(confirmRoute, /confirmTossPayment\(\{[\s\S]*?owner: \{ authUserId: parent\.id/);
    assert.match(confirmRoute, /getBundleOrderForParent\(orderId, parent\.appUserId\)/);
    assert.match(requestRoute, /body\?\.action === "submit-bundle"[\s\S]*?submitBundlePaymentClaim\(parent\.appUserId/);
});

test("계약: 묶음 «입금했어요» — 전부 내 자녀·전부 미납일 때만, 건마다 PAYMENT_CLAIM 을 한 트랜잭션에", () => {
    const body = fnBody(parentReqSrc, "export async function submitBundlePaymentClaim(");
    assert.match(body, /p\.id = ANY\(\$1::text\[\]\) AND \$\{await childAccessSql\("s", "\$2"\)\}/);
    assert.match(body, /owned\.length !== ids\.length/);
    assert.match(body, /validatePaymentRequest\(\{ \.\.\.input, kind: "PAYMENT_CLAIM" \}/);
    assert.match(body, /prisma\.\$transaction\(async \(db\) => \{[\s\S]*?INSERT INTO "PaymentParentRequest"/);
    assert.match(body, /todayKst\(\)/, "날짜는 KST 공용 모듈");
});

test("계약: 마이그레이션은 표·인덱스 추가만 · 위치 상한 = MAX_BUNDLE_ITEMS · schema.prisma 사본 있음", () => {
    const code = migration.replace(/--.*$/gm, "");
    assert.match(code, /CREATE TABLE IF NOT EXISTS "PaymentTransactionItem"/);
    assert.doesNotMatch(code, /\bDROP\b|\bTRUNCATE\b|\bDELETE FROM\b|\bUPDATE "|ALTER TABLE "(?!PaymentTransactionItem")/i, "기존 표를 바꾸지 않는다");
    const upper = Number(code.match(/position BETWEEN 1 AND (\d+)/)?.[1]);
    assert.equal(upper, rules.MAX_BUNDLE_ITEMS);
    assert.match(code, /UNIQUE \("transactionId", "paymentId"\)/);
    assert.match(code, /ENABLE ROW LEVEL SECURITY/);
    assert.match(migration, /되돌림 SQL/);
    assert.match(schema, /model PaymentTransactionItem \{[\s\S]*?transactionId String[\s\S]*?taxFreeAmount Int/);
});
