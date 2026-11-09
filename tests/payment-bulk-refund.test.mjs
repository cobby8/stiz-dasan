import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

// 관리자 수납 목록 «선택 항목 환불»(2026-11-09 원장 지시).
// 1) 순수 규칙(bulkRefund.ts) — 갈래 나누기·묶음 일부 선택 막기·막대 버튼 모드를 실제로 실행한다.
// 2) payment-ledger.ts 의 refundTossPaymentByAdmin 을 가짜 prisma·가짜 fetch 로 실제 실행한다(토스 실호출 없음).
// 3) 서버 액션·화면 소스 계약(권한 첫 줄·이중 클릭 막기·기존 함수 재사용).

const rules = await loadTsModule("src/lib/payments/bulkRefund.ts");
const actionSrc = readFileSync(new URL("../src/app/actions/payment-bulk-refund.ts", import.meta.url), "utf8");
const financeSrc = readFileSync(new URL("../src/app/admin/finance/FinanceClient.tsx", import.meta.url), "utf8");
const ledgerSrc = readFileSync(new URL("../src/lib/payment-ledger.ts", import.meta.url), "utf8");

/** 서버가 DB 에서 다시 읽은 청구 1건 */
function row(over = {}) {
    return {
        paymentId: "p1", status: "PAID", paidProvider: "MANUAL",
        tossTxId: null, tossTxPaymentIds: [], posRequestId: null, posPaymentIds: [],
        ...over,
    };
}

// ───────────────────────────── 1. 순수 규칙 ─────────────────────────────

test("규칙: 막대 버튼 — 전부 미납=납부 처리 · 전부 납부완료=환불 · 섞이면 끔+안내", () => {
    assert.equal(rules.bulkSelectionMode([]).mode, "NONE");
    assert.equal(rules.bulkSelectionMode(["PENDING", "OVERDUE"]).mode, "PAY");
    assert.equal(rules.bulkSelectionMode(["CANCELED", "PENDING"]).mode, "PAY", "납부완료가 없으면 예전처럼 납부 창(창이 취소 건을 건너뛴다고 알려 줌)");
    assert.equal(rules.bulkSelectionMode(["PAID", "PAID"]).mode, "REFUND");
    const mixed = rules.bulkSelectionMode(["PAID", "PENDING"]);
    assert.equal(mixed.mode, "MIXED");
    assert.equal(mixed.message, "미납과 납부완료를 함께 고를 수 없어요");
    assert.equal(rules.bulkSelectionMode(["PAID", "REFUNDED"]).mode, "MIXED");
});

test("규칙: 갈래 나누기 — 토스 온라인은 거래별, POS 는 요청별, 현금·계좌이체는 청구별", () => {
    const rows = [
        row({ paymentId: "m1" }),
        row({ paymentId: "m2", paidProvider: null }),
        row({ paymentId: "t1", paidProvider: "TOSS", tossTxId: "tx-1", tossTxPaymentIds: ["t1"] }),
        row({ paymentId: "s1", paidProvider: "TOSS_POS", posRequestId: "req-1", posPaymentIds: ["s1", "s2"] }),
        row({ paymentId: "s2", paidProvider: "TOSS_POS", posRequestId: "req-1", posPaymentIds: ["s1", "s2"] }),
    ];
    const plan = rules.planBulkRefund(["m1", "m2", "t1", "s1", "s2"], rows);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.groups.map((g) => [g.kind, g.key, g.paymentIds]), [
        ["MANUAL", "m1", ["m1"]],
        ["MANUAL", "m2", ["m2"]],
        ["TOSS_ONLINE", "tx-1", ["t1"]],
        ["TOSS_POS", "req-1", ["s1", "s2"]],
    ]);
});

test("규칙: 묶음 결제를 일부만 고르면 아무것도 실행하지 않고 «함께 환불해야 해요(N건)»", () => {
    const toss = [
        row({ paymentId: "a", paidProvider: "TOSS", tossTxId: "tx-b", tossTxPaymentIds: ["a", "b", "c"] }),
        row({ paymentId: "m1" }),
    ];
    const plan = rules.planBulkRefund(["a", "m1"], toss);
    assert.equal(plan.ok, false);
    assert.equal(plan.blocks[0].code, "BUNDLE_PARTIAL");
    assert.equal(plan.blocks[0].message, "묶음으로 낸 결제는 함께 환불해야 해요(3건).");

    const pos = [row({ paymentId: "s1", paidProvider: "TOSS_POS", posRequestId: "r", posPaymentIds: ["s1", "s2"] })];
    assert.equal(rules.planBulkRefund(["s1"], pos).blocks[0].message, "묶음으로 낸 결제는 함께 환불해야 해요(2건).");
});

test("규칙: 미납 섞임·없는 청구·기록 없는 토스/POS·카페24·중복·빈 목록·상한 초과를 막는다", () => {
    const one = (over, ids = ["p1"]) => rules.planBulkRefund(ids, [row(over)]);
    assert.equal(one({ status: "PENDING" }).blocks[0].code, "NOT_PAID");
    assert.equal(one({}, ["p1", "nope"]).blocks[0].code, "NOT_FOUND");
    assert.equal(one({ paidProvider: "TOSS" }).blocks[0].code, "NO_TOSS_RECORD");
    assert.equal(one({ paidProvider: "TOSS_POS" }).blocks[0].code, "NO_POS_RECORD");
    assert.equal(one({ paidProvider: "CAFE24_BRIDGE" }).blocks[0].code, "OTHER_PROVIDER");
    assert.equal(one({}, ["p1", "p1"]).blocks[0].code, "DUPLICATE");
    assert.equal(rules.planBulkRefund([], []).blocks[0].code, "EMPTY");
    const many = Array.from({ length: rules.MAX_BULK_REFUND + 1 }, (_, i) => `x${i}`);
    assert.equal(rules.planBulkRefund(many, many.map((id) => row({ paymentId: id }))).blocks[0].code, "TOO_MANY");
    // 같은 안내는 한 줄로
    const twoUnpaid = rules.planBulkRefund(["p1", "p2"], [row({ status: "PENDING" }), row({ paymentId: "p2", status: "OVERDUE" })]);
    assert.equal(twoUnpaid.blocks.length, 1);
    for (const code of ["EMPTY", "NOT_PAID", "BUNDLE_PARTIAL", "NO_TOSS_RECORD", "OTHER_PROVIDER"]) {
        assert.doesNotMatch(rules.bulkRefundBlockMessage(code, 2), /undefined|null|SQL|PAID|TOSS/);
    }
});

test("규칙: 결과 요약 — «N건 환불 완료 · POS 취소 요청 · 실패»", () => {
    assert.equal(rules.summarizeBulkRefund([
        { kind: "MANUAL", paymentIds: ["a"], result: "DONE" },
        { kind: "TOSS_ONLINE", paymentIds: ["b", "c"], result: "DONE" },
        { kind: "TOSS_POS", paymentIds: ["d"], result: "REQUESTED" },
        { kind: "MANUAL", paymentIds: ["e"], result: "FAILED", message: "x" },
    ]), "3건 환불 완료 · 1건 POS 결제 취소 요청(POS에서 취소되면 환불로 바뀌어요) · 1건 실패");
    assert.equal(rules.summarizeBulkRefund([]), "환불한 청구가 없어요.");
});

// ───────────────────────────── 2. payment-ledger.ts 실제 실행(가짜 prisma · 가짜 fetch) ─────────────────────────────

const FAKE_MODULES = {
    "@/lib/prisma": "export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__refundFake.prisma[key] });",
    "next/cache": "export function revalidatePath() {} export function revalidateTag() {}",
    "@/lib/slack/client": "export async function postMessage() { return { ok: true }; }",
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
    const url = `data:text/javascript;base64,${Buffer.from(out).toString("base64")}`;
    loaded.set(key, url);
    return url;
}
const ledger = await import(await moduleUrl("src/lib/payment-ledger.ts"));

function fakePrisma(responder) {
    const calls = [];
    const db = {
        async $queryRawUnsafe(sql, ...args) { calls.push({ kind: "query", sql, args }); return (await responder(sql, args, "query")) ?? []; },
        async $executeRawUnsafe(sql, ...args) { calls.push({ kind: "exec", sql, args }); return (await responder(sql, args, "exec")) ?? 0; },
        async $transaction(fn) { return fn(db); },
    };
    globalThis.__refundFake = { prisma: db };
    return calls;
}

/** 토스 키(테스트용)·가짜 fetch 를 잠깐 끼웠다가 반드시 되돌린다 */
async function withToss(fetchImpl, fn) {
    const keys = ["NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY", "TOSS_PAYMENTS_SECRET_KEY", "PAYMENT_PROVIDER", "NEXT_PUBLIC_PAYMENT_PROVIDER"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const savedFetch = globalThis.fetch;
    const fetchCalls = [];
    process.env.NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY = "test_ck_fake";
    process.env.TOSS_PAYMENTS_SECRET_KEY = "test_sk_fake";
    delete process.env.PAYMENT_PROVIDER;
    delete process.env.NEXT_PUBLIC_PAYMENT_PROVIDER;
    globalThis.fetch = async (url, init) => {
        fetchCalls.push({ url: String(url), init });
        if (!fetchImpl) throw new Error("이 시나리오에서는 토스를 부르면 안 된다");
        return fetchImpl(String(url), init, fetchCalls);
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

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const TX = { id: "tx-1", paymentId: "p1", invoiceId: "i1", studentId: "s1", parentId: "u1", orderId: "STIZ-1", paymentKey: "pk_1", amount: 180000, status: "DONE", method: "카드", provider: "TOSS" };
const tossPayment = (over = {}) => ({ paymentKey: "pk_1", orderId: "STIZ-1", status: "DONE", totalAmount: 180000, balanceAmount: 180000, method: "카드", ...over });

/** 가짜 토스: GET 은 지금 상태, POST cancel 이 오면 그 뒤 GET 은 전액 취소 */
function fakeToss({ cancelOk = true, before = tossPayment(), total = 180000, orderId = "STIZ-1" } = {}) {
    let canceled = false;
    return (url, init) => {
        if (init?.method === "POST" && /\/cancel$/.test(url)) {
            if (!cancelOk) return json(400, { code: "NOT_CANCELABLE_PAYMENT", message: "취소할 수 없는 결제입니다." });
            canceled = true;
            return json(200, { status: "CANCELED" });
        }
        return json(200, canceled ? tossPayment({ orderId, totalAmount: total, status: "CANCELED", balanceAmount: 0 }) : before);
    };
}

/** 단건 거래 응답기 */
function singleResponder(tx = TX) {
    return (sql) => {
        if (/FROM "PaymentTransaction" WHERE id = \$1 AND provider = 'TOSS'/.test(sql)) return [tx];
        if (/SELECT EXISTS \(SELECT 1 FROM "PaymentTransactionItem"/.test(sql)) return [{ found: false }];
        if (/FOR UPDATE OF tx, i, p/.test(sql)) return [{ ...tx, invoiceStatus: "PAID", paymentStatus: "PAID" }];
        return undefined;
    };
}

test("실행: 토스 카드 단건 — 재조회 → 감사 기록 → 전액 취소(금액 없이) → 재조회 전액 취소 확인 뒤에만 장부 환불", async () => {
    const calls = fakePrisma(singleResponder());
    await withToss(fakeToss(), async (fetchCalls) => {
        const result = await ledger.refundTossPaymentByAdmin({ transactionId: "tx-1", paymentIds: ["p1"], adminUserId: "admin-1" });
        assert.equal(result.ok, true);
        assert.deepEqual(result.paymentIds, ["p1"]);
        const posts = fetchCalls.filter((c) => c.init?.method === "POST");
        assert.equal(posts.length, 1, "토스 취소는 한 번");
        assert.match(posts[0].url, /\/v1\/payments\/pk_1\/cancel$/);
        const body = JSON.parse(posts[0].init.body);
        assert.equal("cancelAmount" in body, false, "전액 취소 = 금액을 넣지 않는다");
        assert.equal("refundReceiveAccount" in body, false);
        assert.ok(posts[0].init.headers["Idempotency-Key"], "연타 대비 멱등 키");
        // 순서: 감사 기록(관리자) → 토스 취소 → 장부 환불
        const auditIdx = calls.findIndex((c) => /PaymentAuditLog/.test(c.sql) && c.args.includes("PAYMENT_TOSS_CANCEL_REQUESTED"));
        assert.ok(auditIdx >= 0, "누가 눌렀는지 감사 기록");
        assert.ok(calls[auditIdx].args.includes("admin-1"));
        assert.ok(calls.some((c) => /UPDATE "Payment" SET status = 'REFUNDED'/.test(c.sql) && c.args.includes("p1")), "장부 환불");
    });
});

test("실행: 묶음을 일부만 넘기면 토스를 부르지 않는다(부분 취소 없음)", async () => {
    const calls = fakePrisma((sql) => {
        if (/FROM "PaymentTransaction" WHERE id = \$1 AND provider = 'TOSS'/.test(sql)) return [TX];
        if (/SELECT EXISTS \(SELECT 1 FROM "PaymentTransactionItem"/.test(sql)) return [{ found: true }];
        if (/SELECT "paymentId" FROM "PaymentTransactionItem"/.test(sql)) return [{ paymentId: "p1" }, { paymentId: "p2" }];
        return undefined;
    });
    await withToss(null, async (fetchCalls) => {
        const result = await ledger.refundTossPaymentByAdmin({ transactionId: "tx-1", paymentIds: ["p1"], adminUserId: "admin-1" });
        assert.equal(result.ok, false);
        assert.equal(result.message, "묶음으로 낸 결제는 함께 환불해야 해요(2건).");
        assert.equal(fetchCalls.length, 0);
        assert.equal(calls.some((c) => /UPDATE "Payment"/.test(c.sql)), false);
    });
});

test("실행: 묶음 전부를 고르면 토스 주문 «전액 취소» 1번 → 묶인 청구 전부 환불(applyVerifiedTossFullCancel 묶음 갈래)", async () => {
    const bundleTx = { ...TX, amount: 230000 };
    const calls = fakePrisma((sql) => {
        if (/FROM "PaymentTransaction" WHERE id = \$1 AND provider = 'TOSS'/.test(sql)) return [bundleTx];
        if (/SELECT EXISTS \(SELECT 1 FROM "PaymentTransactionItem"/.test(sql)) return [{ found: true }];
        if (/SELECT "paymentId" FROM "PaymentTransactionItem"/.test(sql)) return [{ paymentId: "p1" }, { paymentId: "p2" }];
        if (/SELECT id, status, "orderId" FROM "PaymentTransaction" WHERE id = \$1 FOR UPDATE/.test(sql)) return [{ id: "tx-1", status: "DONE", orderId: "STIZ-1" }];
        if (/FROM "PaymentTransactionItem" it/.test(sql) && /FOR UPDATE OF p, i/.test(sql)) {
            return [
                { paymentId: "p1", invoiceId: "i1", itemAmount: 180000, taxFreeAmount: 180000, position: 1, paymentAmount: 180000, paymentStatus: "PAID", invoiceStatus: "PAID" },
                { paymentId: "p2", invoiceId: "i2", itemAmount: 50000, taxFreeAmount: 50000, position: 2, paymentAmount: 50000, paymentStatus: "PAID", invoiceStatus: "PAID" },
            ];
        }
        if (/UPDATE "Payment" SET status = 'REFUNDED'/.test(sql)) return 1;
        return undefined;
    });
    await withToss(fakeToss({ before: tossPayment({ totalAmount: 230000, balanceAmount: 230000 }), total: 230000 }), async (fetchCalls) => {
        const result = await ledger.refundTossPaymentByAdmin({ transactionId: "tx-1", paymentIds: ["p2", "p1"], adminUserId: "admin-1" });
        assert.equal(result.ok, true);
        assert.equal(fetchCalls.filter((c) => c.init?.method === "POST").length, 1, "주문 하나 = 취소 한 번");
        const refunded = calls.filter((c) => /UPDATE "Payment" SET status = 'REFUNDED'/.test(c.sql)).map((c) => c.args[0]);
        assert.deepEqual(refunded.sort(), ["p1", "p2"]);
        assert.equal(calls.filter((c) => c.args.includes("PAYMENT_TOSS_CANCEL_REQUESTED")).length, 2, "감사 기록은 묶인 청구마다");
    });
});

test("실행: 토스가 취소를 거절하고 재조회도 완료 그대로면 장부를 바꾸지 않고 토스 사유를 돌려준다", async () => {
    const calls = fakePrisma(singleResponder());
    await withToss(fakeToss({ cancelOk: false }), async () => {
        const result = await ledger.refundTossPaymentByAdmin({ transactionId: "tx-1", paymentIds: ["p1"], adminUserId: "admin-1" });
        assert.equal(result.ok, false);
        assert.match(result.message, /취소할 수 없는 결제입니다/);
        assert.equal(calls.some((c) => /UPDATE "Payment"/.test(c.sql)), false);
    });
});

test("실행: 입금 끝난 무통장입금(가상계좌)은 환불 계좌가 필요해 토스를 부르지 않는다", async () => {
    fakePrisma(singleResponder({ ...TX, method: "가상계좌" }));
    await withToss(fakeToss({ before: tossPayment({ method: "가상계좌" }) }), async (fetchCalls) => {
        const result = await ledger.refundTossPaymentByAdmin({ transactionId: "tx-1", paymentIds: ["p1"], adminUserId: "admin-1" });
        assert.equal(result.ok, false);
        assert.match(result.message, /환불 계좌/);
        assert.equal(fetchCalls.filter((c) => c.init?.method === "POST").length, 0);
    });
});

test("실행: 이미 부분 취소된 결제는 다시 취소하지 않는다", async () => {
    fakePrisma(singleResponder());
    await withToss(fakeToss({ before: tossPayment({ status: "PARTIAL_CANCELED", balanceAmount: 100000 }) }), async (fetchCalls) => {
        const result = await ledger.refundTossPaymentByAdmin({ transactionId: "tx-1", paymentIds: ["p1"], adminUserId: "admin-1" });
        assert.equal(result.ok, false);
        assert.equal(fetchCalls.filter((c) => c.init?.method === "POST").length, 0);
    });
});

// ───────────────────────────── 3. 소스 계약 ─────────────────────────────

test("계약: 서버 액션은 원장 권한부터 확인하고, 기존 환불 함수만 부른다(새 결제 길 없음)", () => {
    assert.match(actionSrc, /^"use server";/);
    const body = actionSrc.slice(actionSrc.indexOf("export async function refundSelectedPayments"));
    assert.ok(body.indexOf("requireFinanceOwner()") < body.indexOf("loadRows("), "권한 확인이 DB 조회보다 먼저");
    assert.match(actionSrc, /appUserRole !== "ADMIN"/);
    assert.match(actionSrc, /refundPaidPaymentInTx\(/, "현금·계좌이체 = 장부만(조건부 UPDATE + 감사 기록)");
    assert.match(actionSrc, /requestChargeCancelByAdmin\(/, "POS = ⚡ «결제 취소»와 같은 함수");
    assert.match(actionSrc, /refundTossPaymentByAdmin\(/);
    assert.doesNotMatch(actionSrc, /api\.tosspayments\.com|UPDATE "Payment"/, "액션이 직접 토스·장부를 건드리지 않는다");
    assert.match(actionSrc, /planBulkRefund\(ids, rows\)/, "판정은 순수 규칙 한 곳");
    // 묶음 판정용 토스 거래 조회는 항목 표까지 본다(같은 규칙의 두 경로)
    assert.match(actionSrc, /txCoversPaymentSql\("t", "p\.id"\)/);
});

test("계약: 토스 취소 반영은 웹훅과 같은 applyVerifiedTossFullCancel 로만", () => {
    const start = ledgerSrc.indexOf("export async function refundTossPaymentByAdmin");
    const body = ledgerSrc.slice(start, ledgerSrc.indexOf("export async function confirmTossPayment"));
    assert.match(body, /applyVerifiedTossFullCancel\(/);
    assert.doesNotMatch(body, /UPDATE "Payment"/, "장부를 직접 바꾸지 않는다");
    assert.doesNotMatch(body, /cancelAmount\s*:/, "부분 취소 금액을 보내지 않는다");
});

test("계약: 화면 — 막대 버튼 모드는 규칙 함수, 환불은 그 자리 확인 + 이중 클릭 막기", () => {
    assert.match(financeSrc, /bulkSelectionMode\(/);
    assert.match(financeSrc, /<InlineConfirm[\s\S]*?label="선택 항목 환불"/);
    assert.match(financeSrc, /bulkRefundingRef\.current\) return/);
    assert.match(financeSrc, /refundSelectedPayments\(ids\)/);
    assert.match(financeSrc, /selection\.mode === "MIXED"/);
    assert.match(financeSrc, /await loadMonth\(year, month\)/);
});
