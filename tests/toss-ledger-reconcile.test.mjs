// 점검표 c5(2026-11-13) — «토스 결제는 됐는데 장부 반영이 실패하는 일» 근본 수정 회귀 테스트.
//
// payment-ledger.ts 를 실제로 실행한다. DB 는 «상태를 가진 가짜 prisma»(거래 1건·청구 1건·청구서 1건)로,
// 트랜잭션은 한 번에 하나씩(FOR UPDATE 잠금 흉내) + 예외 시 되돌림으로 흉내 낸다. 토스는 가짜 fetch 다(실제 호출 없음).
//
// 지키는 것:
//  1. 장부 반영 중간에 실패해도 재시도 때 이중 반영이 없다(토스 승인도 다시 부르지 않는다).
//  2. 학부모 승인·웹훅·주기 점검이 동시에 와도 납부 기록은 한 번만 남는다.
//  3. 금액이 다르면 반영하지 않고 원장 경고(같은 사유는 한 번만).
//  4. 승인 응답이 끊겨도(네트워크) 결제 번호가 남고, 주기 점검이 토스 재조회로 반영한다.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

// ───────────────────────────── 모듈 로더(런타임 의존만 가짜로) ─────────────────────────────
const FAKE_MODULES = {
    "@/lib/prisma": "export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__reconcileFake.prisma[key] });",
    "next/cache": "export function revalidatePath() {} export function revalidateTag() {}",
    "@/lib/slack/client": "export async function postMessage(m) { globalThis.__reconcileFake.slack.push(m); return { ok: true }; }",
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
const rule = await import(await moduleUrl("src/lib/payments/tossReconcileRule.ts"));

// ───────────────────────────── 상태를 가진 가짜 DB ─────────────────────────────
const ORDER = "STIZ-1700000000000-pay1abcd";
const AMOUNT = 180000;

function newState(overrides = {}) {
    return {
        tx: { id: "tx-1", paymentId: "pay-1", invoiceId: "inv-1", studentId: "stu-1", parentId: "u1", provider: "TOSS",
            orderId: ORDER, paymentKey: null, amount: AMOUNT, status: "READY", rawResponse: null, method: null, ...overrides.tx },
        payment: { status: "PENDING", providerPaymentKey: null, ...overrides.payment },
        invoice: { status: "SENT", ...overrides.invoice },
        audits: [],
        reviews: [],
        ageMinutes: overrides.ageMinutes ?? 30,
        failNext: new Set(),
    };
}

const clone = (value) => JSON.parse(JSON.stringify(value, (_k, v) => (v instanceof Set ? [...v] : v)));

function fakeDb(state) {
    const calls = [];
    let chain = Promise.resolve();
    const joined = () => ({ ...state.tx, invoiceStatus: state.invoice.status, paymentStatus: state.payment.status });
    const failIf = (name) => {
        if (state.failNext.has(name)) {
            state.failNext.delete(name);
            throw new Error(`가짜 DB 오류(${name})`);
        }
    };
    const responder = (sql, args) => {
        const s = sql.trim();
        if (/AS ready/.test(s)) return [{ ready: true }];
        if (/AS found/.test(s)) return [{ found: false }];
        // 학부모 승인 — 주문 조회(소유자 확인 포함)
        if (/JOIN "User" u ON u\.id = tx\."parentId"/.test(s)) return args[0] === state.tx.orderId ? [joined()] : [];
        // 승인 직전 잠금·재확인(claimTossConfirmInTx)
        if (/^SELECT status FROM "Payment" WHERE id = \$1/.test(s)) return [{ status: state.payment.status }];
        if (/^SELECT amount FROM "PaymentTransaction" WHERE id = \$1/.test(s)) return [{ amount: state.tx.amount }];
        if (/AS "invoiceAmount"/.test(s)) return [{ paymentId: state.tx.paymentId, paymentAmount: state.tx.amount, invoiceAmount: state.tx.amount }];
        if (/SET status = 'IN_PROGRESS', "updatedAt" = NOW\(\)/.test(s)) {
            if (["READY", "IN_PROGRESS", "FAILED"].includes(state.tx.status)) { state.tx.status = "IN_PROGRESS"; return 1; }
            return 0;
        }
        // 승인 원본(DONE)이 남은 반영 전 거래는 실패 기록·결제 번호 덮어쓰기에서 지킨다(KEEP_APPROVED_PENDING_SQL)
        const keepApproved = () => {
            assert.match(s, /NOT \(status = 'IN_PROGRESS' AND COALESCE\("rawResponse"->>'status', ''\) = 'DONE'\)/);
            return state.tx.status === "IN_PROGRESS" && state.tx.rawResponse?.status === "DONE";
        };
        // 승인됐는데 장부 반영 전인 주문(결제 시작이 막는다) — 승인 직전 busy 검사와 구분: busy 는 t.id <> $1
        if (/"rawResponse"->>'status' = 'DONE'/.test(s) && /\$2::text IS NULL OR t\.id <> \$2/.test(s)) {
            state.approvedPendingQueries = (state.approvedPendingQueries ?? 0) + 1;
            return state.tx.status === "IN_PROGRESS" && state.tx.rawResponse?.status === "DONE" && args[0].includes(state.tx.paymentId)
                ? [{ id: state.tx.id }] : [];
        }
        if (/AND t\.status = 'IN_PROGRESS'/.test(s) && /t\.id <> \$1/.test(s)) {
            state.busySql = s;
            return [];
        }
        // 결제 시작(createCheckoutSession) — 청구서 조회
        if (/FROM "PaymentInvoice" i/.test(s) && /"rallyzMirror"/.test(s)) {
            return [{ invoiceId: state.tx.invoiceId, paymentId: state.tx.paymentId, studentId: "stu-1", parentId: "u1", invoiceNo: "STIZ-202611-x",
                invoiceStatus: state.invoice.status, amount: state.tx.amount, title: "11월 수강료", paymentStatus: state.payment.status,
                studentName: "김민준", parentEmail: "parent@example.com", rallyzMirror: false }];
        }
        if (/INSERT INTO "PaymentTransaction"/.test(s)) {
            state.insertedTx = (state.insertedTx ?? 0) + 1;
            return [{ id: "tx-new" }];
        }
        // 승인 전 결제 번호 기록
        if (/"paymentKey" IS DISTINCT FROM \$2/.test(s)) {
            if (keepApproved()) return 0;
            if (state.tx.status === "IN_PROGRESS") { state.tx.paymentKey = args[1]; return 1; }
            return 0;
        }
        // 승인 원본 기록
        if (/"rawResponse" = \$3::jsonb, "approvedAt" = COALESCE/.test(s)) {
            failIf("approvalRecord");
            if (state.tx.status === "IN_PROGRESS") { state.tx.paymentKey = args[1]; state.tx.rawResponse = JSON.parse(args[2]); return 1; }
            return 0;
        }
        // 승인 실패·확인 중 기록
        if (/status = CASE WHEN \$6::boolean THEN status ELSE 'FAILED' END/.test(s)) {
            if (keepApproved()) return 0;
            state.tx.paymentKey = args[1];
            if (!args[5]) state.tx.status = "FAILED";
            state.tx.rawResponse = JSON.parse(args[4]);
            return 1;
        }
        // 장부 반영(finalizeVerifiedTossPayment 단건)
        if (/FOR UPDATE OF tx, i, p/.test(s)) return [{ ...joined(), paymentProviderKey: state.payment.providerPaymentKey }];
        if (/^UPDATE "Payment" SET status = 'PAID'/.test(s)) {
            failIf("payment");
            if (!["PENDING", "OVERDUE", "PAID"].includes(state.payment.status)) return 0;
            state.payment.status = "PAID";
            state.payment.providerPaymentKey = args[3];
            return 1;
        }
        if (/^UPDATE "PaymentInvoice" SET status = 'PAID'/.test(s)) {
            failIf("invoice");
            if (!["ISSUED", "SENT", "OVERDUE", "PAID"].includes(state.invoice.status)) return 0;
            state.invoice.status = "PAID";
            return 1;
        }
        if (/^UPDATE "PaymentTransaction" SET status = 'DONE'/.test(s)) {
            if (!["READY", "IN_PROGRESS", "DONE", "WAITING_FOR_DEPOSIT", "EXPIRED"].includes(state.tx.status)) return 0;
            state.tx.status = "DONE";
            state.tx.paymentKey = args[1];
            return 1;
        }
        if (/'PAYMENT_MARK_PAID'/.test(s)) {
            state.audits.push({ action: "PAYMENT_MARK_PAID", actorType: args[3] });
            return 1;
        }
        // «결제 확인 필요» 기록(같은 거래·같은 사유는 한 번만)
        if (/'PAYMENT_SINGLE_REVIEW'|'VIRTUAL_ACCOUNT_REVIEW'/.test(s)) {
            const action = /'VIRTUAL_ACCOUNT_REVIEW'/.test(s) ? "VIRTUAL_ACCOUNT_REVIEW" : "PAYMENT_SINGLE_REVIEW";
            if (state.reviews.some((r) => r.tx === args[2] && r.code === args[3] && r.action === action)) return [];
            state.reviews.push({ tx: args[2], code: args[3], action });
            return [{ id: `rv-${state.reviews.length}` }];
        }
        // 주기 점검 대상
        if (/AS "ageMinutes"/.test(s)) {
            assert.match(s, /tx\.provider = 'TOSS'/);
            assert.match(s, /tx\.status = 'IN_PROGRESS'/);
            return state.tx.status === "IN_PROGRESS" ? [{ ...state.tx, ageMinutes: state.ageMinutes }] : [];
        }
        if (/'TOSS_CONFIRM_VERIFICATION_FAILED'/.test(s)) {
            if (keepApproved()) return 0;
            if (state.tx.status !== "DONE") state.tx.status = "FAILED";
            return 1;
        }
        if (/Toss payment was not approved \(reconcile\)/.test(s)) {
            // 조회하는 사이 학부모 승인이 다시 시작됐으면(updatedAt 이 10분 안) 닫지 않는다
            assert.match(s, /"updatedAt" < NOW\(\) - \(\$3::int \* INTERVAL '1 minute'\)/);
            if (state.ageMinutes < args[2]) return 0;
            if (state.tx.status === "IN_PROGRESS") { state.tx.status = "FAILED"; state.tx.failureCode = args[1]; return 1; }
            return 0;
        }
        // 웹훅
        if (/INSERT INTO "PaymentWebhookEvent"/.test(s)) return [{ id: `ev-${calls.length}`, processed: false }];
        if (/WHERE "orderId" = \$1 OR "paymentKey" = \$2/.test(s)) return [{ ...state.tx }];
        return undefined;
    };
    const db = {
        async $queryRawUnsafe(sql, ...args) { calls.push(sql); return (await responder(sql, args)) ?? []; },
        async $executeRawUnsafe(sql, ...args) { calls.push(sql); return (await responder(sql, args)) ?? 0; },
        // 트랜잭션은 한 번에 하나(행 잠금 흉내) — 예외가 나면 그 안에서 바꾼 상태를 되돌린다
        $transaction(fn) {
            const run = chain.then(async () => {
                const snapshot = clone({ tx: state.tx, payment: state.payment, invoice: state.invoice, audits: state.audits });
                try {
                    return await fn(db);
                } catch (error) {
                    Object.assign(state, snapshot);
                    throw error;
                }
            });
            chain = run.catch(() => undefined);
            return run;
        },
    };
    globalThis.__reconcileFake = { prisma: db, slack: [] };
    return { calls, slack: () => globalThis.__reconcileFake.slack };
}

/** 토스 키(테스트용)·가짜 fetch 를 잠깐 끼웠다가 되돌린다 — 실제 토스 호출은 절대 없다 */
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
        fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
        assert.match(String(url), /^https:\/\/api\.tosspayments\.com\//, "토스 외 주소를 부르면 안 된다");
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

const owner = { authUserId: "auth-1", email: "parent@example.com" };
const tossDone = (extra = {}) => ({ paymentKey: "pk-1", orderId: ORDER, status: "DONE", method: "카드", totalAmount: AMOUNT,
    taxFreeAmount: AMOUNT, suppliedAmount: 0, vat: 0, receipt: { url: "https://receipt/1" }, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const isConfirm = (call) => call.url.endsWith("/v1/payments/confirm");
const markPaidCount = (state) => state.audits.filter((a) => a.action === "PAYMENT_MARK_PAID").length;

// ───────────────────────────── 1. 반영 중간 실패 → 재시도 ─────────────────────────────

test("반영 중간 실패: 토스 승인 성공 뒤 장부 반영이 DB 오류로 깨지면 «확인 중» + 승인 원본 보존, 재시도는 토스 재호출 없이 한 번만 반영", async () => {
    const state = newState();
    state.failNext.add("invoice"); // 청구 UPDATE 는 됐는데 청구서 UPDATE 에서 연결이 끊긴 상황 → 트랜잭션 전체 되돌림
    const { slack } = fakeDb(state);
    await withToss(async (url) => {
        assert.ok(url.endsWith("/v1/payments/confirm"), "이 시나리오에서 토스 조회는 필요 없다");
        return json(tossDone());
    }, async (fetchCalls) => {
        const first = await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
        assert.equal(first.ok, false);
        assert.equal(first.retryable, true, "학부모 화면은 오류가 아니라 «확인 중»으로 자동 재시도한다");
        assert.match(first.error, /승인되었고/);
        assert.equal(state.payment.status, "PENDING", "깨진 반영은 통째로 되돌려졌다(반쪽 납부 없음)");
        assert.equal(state.tx.status, "IN_PROGRESS");
        assert.equal(state.tx.paymentKey, "pk-1", "결제 번호가 남아 있다");
        assert.equal(state.tx.rawResponse?.status, "DONE", "승인 원본이 먼저 기록돼 있다");
        assert.equal(markPaidCount(state), 0);

        const second = await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
        assert.equal(second.ok, true);
        assert.equal(second.recovered, true);
        assert.equal(state.payment.status, "PAID");
        assert.equal(state.invoice.status, "PAID");
        assert.equal(state.tx.status, "DONE");
        assert.equal(fetchCalls.filter(isConfirm).length, 1, "재시도는 적어 둔 승인 원본으로 — 토스 승인을 다시 부르지 않는다");

        const third = await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
        assert.equal(third.ok, true);
        assert.equal(third.alreadyConfirmed, true);
        assert.equal(markPaidCount(state), 1, "몇 번을 불러도 납부 기록은 한 번");
        assert.equal(slack().length, 0, "정상 복구는 경고하지 않는다");
    });
    // 이미 반영된 거래는 주기 점검 대상이 아니다
    await withToss(async () => { throw new Error("토스를 부르면 안 된다"); }, async () => {
        const swept = await ledger.reconcileTossPayments();
        assert.equal(swept.checked, 0);
    });
});

test("반영 중간 실패 + 승인 원본 기록까지 실패해도: 다음 재시도는 토스 멱등 승인으로 반영하고 이중 기록 없음", async () => {
    const state = newState();
    state.failNext.add("approvalRecord");
    state.failNext.add("payment");
    fakeDb(state);
    await withToss(async () => json(tossDone()), async (fetchCalls) => {
        const first = await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
        assert.equal(first.retryable, true);
        assert.equal(state.payment.status, "PENDING");
        const second = await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
        assert.equal(second.ok, true);
        assert.equal(fetchCalls.filter(isConfirm).length, 2, "원본이 없으면 같은 멱등키로 토스에 다시 묻는다");
        assert.equal(markPaidCount(state), 1);
    });
});

// ───────────────────────────── 2. 동시 도착 ─────────────────────────────

test("동시: 학부모 승인 재시도·웹훅·주기 점검이 한꺼번에 와도 납부 기록은 한 번", async () => {
    for (let round = 0; round < 5; round += 1) {
        // 토스에서는 승인됐는데 장부 반영 전에 서버가 멈춘 거래(결제 번호만 남음)
        const state = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" } });
        const { slack } = fakeDb(state);
        await withToss(async () => json(tossDone()), async () => {
            const webhook = { eventType: "PAYMENT_STATUS_CHANGED", createdAt: `2026-11-13T10:00:0${round}`, data: { paymentKey: "pk-1", orderId: ORDER, status: "DONE", totalAmount: AMOUNT } };
            const jobs = [
                () => ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner }),
                () => ledger.recordTossWebhook(webhook),
                () => ledger.reconcileTossPayments(),
            ];
            // 도착 순서를 바꿔 가며
            const order = [jobs[round % 3], jobs[(round + 1) % 3], jobs[(round + 2) % 3]];
            const results = await Promise.all(order.map((job) => job()));
            assert.equal(results.length, 3);
            assert.equal(state.payment.status, "PAID");
            assert.equal(state.invoice.status, "PAID");
            assert.equal(state.tx.status, "DONE");
            assert.equal(markPaidCount(state), 1, `라운드 ${round}: 납부 기록은 한 번`);
            assert.equal(state.reviews.length, 0, "정상 결제에 «확인 필요»를 남기지 않는다");
            assert.equal(slack().length, 0);
        });
    }
});

// ───────────────────────────── 3. 금액 불일치 ─────────────────────────────

test("금액 불일치: 토스는 완료인데 금액이 다르면 점검·웹훅 모두 반영하지 않고 원장 경고는 한 번", async () => {
    const state = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" } });
    const { slack } = fakeDb(state);
    await withToss(async () => json(tossDone({ totalAmount: 18000 })), async () => {
        const first = await ledger.reconcileTossPayments();
        assert.equal(first.reviewed, 1);
        assert.equal(first.recovered, 0);
        assert.equal(state.payment.status, "PENDING", "금액이 다르면 납부로 바꾸지 않는다");
        assert.equal(markPaidCount(state), 0);
        assert.deepEqual(state.reviews.map((r) => r.code), ["TOSS_AMOUNT_MISMATCH"]);
        assert.equal(slack().length, 1);
        assert.match(slack()[0].text, /금액\(18,000원\)이 청구 금액과 달라/);

        // 10분 뒤 점검이 또 돌고, 토스 웹훅도 온다 — 알림은 늘지 않는다
        await ledger.reconcileTossPayments();
        const hook = await ledger.recordTossWebhook({ eventType: "PAYMENT_STATUS_CHANGED", data: { paymentKey: "pk-1", orderId: ORDER, status: "DONE", totalAmount: 18000 } });
        assert.equal(hook.processed, false);
        assert.equal(state.payment.status, "PENDING");
        assert.equal(slack().length, 1, "같은 거래·같은 사유는 한 번만 알린다");
    });
});

test("이중 납부: 반영 전에 청구가 다른 방법(현장·관리자)으로 이미 납부됐으면 덮어쓰지 않고 원장 경고", async () => {
    const state = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" }, payment: { status: "PAID", providerPaymentKey: null }, invoice: { status: "PAID" } });
    const { slack } = fakeDb(state);
    await withToss(async () => json(tossDone()), async () => {
        const swept = await ledger.reconcileTossPayments();
        assert.equal(swept.reviewed, 1);
        assert.equal(markPaidCount(state), 0, "원래 납부 기록을 덮어쓰지 않는다");
        assert.equal(state.payment.providerPaymentKey, null);
        assert.deepEqual(state.reviews.map((r) => r.code), ["ALREADY_PAID_OTHER"]);
        assert.equal(slack().length, 1);
        assert.match(slack()[0].text, /환불 여부를 확인/);
    });
});

// ───────────────────────────── 4. 승인 응답 끊김 ─────────────────────────────

test("승인 응답 끊김: 네트워크 오류여도 예외 없이 «확인 중» + 결제 번호 보존 → 주기 점검이 토스 재조회로 반영", async () => {
    const state = newState();
    fakeDb(state);
    await withToss(async () => { throw new TypeError("fetch failed"); }, async () => {
        const result = await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
        assert.equal(result.ok, false);
        assert.equal(result.retryable, true);
        assert.equal(state.tx.status, "IN_PROGRESS", "실패로 닫지 않는다 — 돈이 나갔을 수 있다");
        assert.equal(state.tx.paymentKey, "pk-1");
    });
    await withToss(async (url) => {
        assert.equal(url, `https://api.tosspayments.com/v1/payments/orders/${ORDER}`, "점검은 서버가 만든 주문 번호로 묻는다");
        return json(tossDone());
    }, async (fetchCalls) => {
        const swept = await ledger.reconcileTossPayments();
        assert.equal(swept.recovered, 1);
        assert.equal(fetchCalls.length, 1);
        assert.equal(state.payment.status, "PAID");
        assert.deepEqual(state.audits.map((a) => a.actorType), ["SYSTEM"], "점검이 반영한 기록은 SYSTEM");
    });
});

test("점검: 토스에 결제가 없으면(404) 1시간 지나서야 실패로 닫고, 중단(ABORTED)은 바로 닫는다 — 청구는 그대로", async () => {
    const recent = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" }, ageMinutes: 20 });
    fakeDb(recent);
    await withToss(async () => json({ code: "NOT_FOUND_PAYMENT" }, 404), async () => {
        const swept = await ledger.reconcileTossPayments();
        assert.equal(swept.waiting, 1);
        assert.equal(recent.tx.status, "IN_PROGRESS");
    });
    const old = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" }, ageMinutes: 90 });
    fakeDb(old);
    await withToss(async () => json({ code: "NOT_FOUND_PAYMENT" }, 404), async () => {
        const swept = await ledger.reconcileTossPayments();
        assert.equal(swept.closed, 1);
        assert.equal(old.tx.status, "FAILED");
        assert.equal(old.payment.status, "PENDING");
    });
    const aborted = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" }, ageMinutes: 15 });
    fakeDb(aborted);
    await withToss(async () => json(tossDone({ status: "ABORTED" })), async () => {
        await ledger.reconcileTossPayments();
        assert.equal(aborted.tx.status, "FAILED");
        assert.equal(aborted.tx.failureCode, "TOSS_ABORTED");
    });
});

test("점검: 토스 조회가 하루 넘게 계속 실패하면 원장에게 «확인 필요» 한 번", async () => {
    const state = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" }, ageMinutes: 25 * 60 });
    const { slack } = fakeDb(state);
    await withToss(async () => json({}, 503), async () => {
        await ledger.reconcileTossPayments();
        await ledger.reconcileTossPayments();
        assert.deepEqual(state.reviews.map((r) => r.code), ["TOSS_RECONCILE_UNRESOLVED"]);
        assert.equal(slack().length, 1);
        assert.equal(state.tx.status, "IN_PROGRESS", "모르는 상태는 닫지 않는다");
    });
});

// ───────────────────────────── 5. 순수 판정 규칙 ─────────────────────────────

test("판정 규칙: 완료+금액 일치=반영, 금액 다름=경고, 무통장=입금 대기, 404·중단=닫기(시간 조건), 취소=경고", () => {
    const tx = { orderId: ORDER, amount: AMOUNT, ageMinutes: 30 };
    const verified = (payment) => ({ kind: "verified", payment: { orderId: ORDER, paymentKey: "pk-1", totalAmount: AMOUNT, ...payment } });
    assert.equal(rule.decideTossReconcile(tx, verified({ status: "DONE" })).action, "FINALIZE");
    assert.equal(rule.decideTossReconcile(tx, verified({ status: "DONE", totalAmount: AMOUNT + 1 })).code, "TOSS_AMOUNT_MISMATCH");
    assert.equal(rule.decideTossReconcile(tx, verified({ status: "DONE", totalAmount: "180000" })).action, "FINALIZE");
    assert.equal(rule.decideTossReconcile(tx, verified({ status: "WAITING_FOR_DEPOSIT" })).action, "VA_ISSUED");
    assert.equal(rule.decideTossReconcile(tx, verified({ status: "WAITING_FOR_DEPOSIT", totalAmount: 1 })).code, "TOSS_AMOUNT_MISMATCH");
    assert.equal(rule.decideTossReconcile(tx, verified({ status: "DONE", orderId: "OTHER" })).code, "TOSS_RECONCILE_ORDER_MISMATCH");
    assert.deepEqual(rule.decideTossReconcile(tx, verified({ status: "EXPIRED" })), { action: "CLOSE", code: "TOSS_EXPIRED" });
    assert.equal(rule.decideTossReconcile(tx, verified({ status: "CANCELED" })).code, "TOSS_CANCELED_BEFORE_LEDGER");
    assert.equal(rule.decideTossReconcile(tx, verified({ status: "IN_PROGRESS" })).action, "WAIT");
    assert.equal(rule.decideTossReconcile(tx, { kind: "rejected", status: 404 }).action, "WAIT");
    assert.equal(rule.decideTossReconcile({ ...tx, ageMinutes: 60 }, { kind: "rejected", status: 404 }).action, "CLOSE");
    assert.equal(rule.decideTossReconcile({ ...tx, ageMinutes: 600 }, { kind: "rejected", status: 401 }).action, "WAIT", "키 문제는 닫지 않는다");
    assert.equal(rule.decideTossReconcile({ ...tx, ageMinutes: 24 * 60 }, { kind: "retryable", reason: "X" }).code, "TOSS_RECONCILE_UNRESOLVED");
    assert.equal(rule.TOSS_RECONCILE_QUIET_MINUTES, 10, "승인 잠금(10분)과 같다 — 진행 중인 승인과 겹치지 않게");
});

// ───────────────────────────── 6. 연결(cron 등록) ─────────────────────────────

test("주기 점검 cron: 10분마다 vercel.json 등록 + CRON_SECRET + withCronAlert 로 감쌈", () => {
    const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
    const entry = vercel.crons.find((c) => c.path === "/api/cron/toss-payment-reconcile");
    assert.ok(entry, "vercel.json 에 등록돼 있어야 한다");
    assert.equal(entry.schedule, "*/10 * * * *");
    const route = readFileSync(new URL("../src/app/api/cron/toss-payment-reconcile/route.ts", import.meta.url), "utf8");
    assert.match(route, /export const GET = withCronAlert\("toss-payment-reconcile", handleGet\)/);
    assert.match(route, /CRON_SECRET/);
    assert.match(route, /reconcileTossPayments\(\)/);
    assert.match(route, /maxDuration = 60/);
});

// ───────────────────────────── 7. 검수 보완(2026-11-13 PM: MED-1·MED-2·L1·L2·L3·L5·L7) ─────────────────────────────

test("MED-1: 승인 실패 기록이 그 사이 남은 승인 원본(DONE)을 FAILED·다른 응답으로 덮어쓰지 않는다", async () => {
    for (const lookupStatus of [503, 404]) {
        const state = newState();
        fakeDb(state);
        await withToss(async (url) => {
            if (url.endsWith("/v1/payments/confirm")) {
                // 이 요청이 토스를 기다리는 사이, 다른 탭의 승인이 승인 원본을 남겼다
                state.tx.rawResponse = tossDone();
                state.tx.paymentKey = "pk-1";
                return json({ code: "ALREADY_PROCESSED_PAYMENT", message: "이미 처리된 결제" }, 400);
            }
            return json({ code: "X" }, lookupStatus);
        }, async () => {
            await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
            assert.equal(state.tx.status, "IN_PROGRESS", `조회 ${lookupStatus}: FAILED 로 닫지 않는다`);
            assert.equal(state.tx.rawResponse?.status, "DONE", "승인 원본이 남아 있다");
        });
    }
});

test("MED-1: 승인 원본이 남은 주문은 다른 결제 번호로 와도 토스를 다시 부르지 않고 원본으로 반영", async () => {
    const state = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1", rawResponse: tossDone() } });
    fakeDb(state);
    await withToss(async () => { throw new Error("토스를 부르면 안 된다"); }, async (fetchCalls) => {
        const result = await ledger.confirmTossPayment({ paymentKey: "pk-other", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
        assert.equal(result.ok, true);
        assert.equal(fetchCalls.length, 0);
        assert.equal(state.payment.providerPaymentKey, "pk-1", "실제 승인된 결제 번호로 기록");
        assert.equal(markPaidCount(state), 1);
    });
});

test("MED-1·MED-2: 승인됐는데 장부 반영 전인 청구로 결제를 다시 시작하면 새 주문 없이 «결제 확인 중»", async () => {
    const state = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1", rawResponse: tossDone() }, ageMinutes: 45 });
    fakeDb(state);
    await withToss(async () => { throw new Error("토스를 부르면 안 된다"); }, async () => {
        const result = await ledger.createCheckoutSession({ invoiceId: "inv-1", owner, origin: "https://stiz.example", method: "CARD" });
        assert.equal(result.ok, false);
        assert.equal(result.approvedPending, true);
        assert.match(result.error, /승인되어 납부 반영을 확인/);
        assert.equal(state.insertedTx ?? 0, 0, "새 결제 주문을 만들지 않는다");
        assert.ok(state.approvedPendingQueries >= 1);
    });
    // 승인 원본이 없는 평범한 진행 중 주문은 막지 않는다(예전 흐름: 30분 재사용 또는 새 주문)
    const plain = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1", rawResponse: null } });
    fakeDb(plain);
    await withToss(async () => { throw new Error("토스를 부르면 안 된다"); }, async () => {
        const result = await ledger.createCheckoutSession({ invoiceId: "inv-1", owner, origin: "https://stiz.example", method: "CARD" });
        assert.notEqual(result.approvedPending, true);
    });
});

test("MED-2: 승인 직전 검사는 승인 원본이 남은 다른 주문을 시간과 무관하게 «승인 진행 중»으로 본다", async () => {
    const bundleLedger = await import(await moduleUrl("src/lib/payments/bundleLedger.ts"));
    assert.equal(bundleLedger.APPROVED_PENDING_SQL, `(t.status = 'IN_PROGRESS' AND t."rawResponse"->>'status' = 'DONE')`);
    const state = newState();
    fakeDb(state);
    await withToss(async () => json(tossDone()), async () => {
        await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
    });
    assert.ok(state.busySql, "승인 직전 busy 검사를 거친다");
    assert.ok(
        state.busySql.includes(`(t."updatedAt" > NOW() - ($3::int * INTERVAL '1 minute') OR ${bundleLedger.APPROVED_PENDING_SQL})`),
        "10분 안 진행 중 «또는» 승인 원본 있음",
    );
    // 결제 시작은 단건·묶음 둘 다 같은 보호를 지난다(같은 규칙의 두 경로는 같은 커밋에서)
    const src = readFileSync(new URL("../src/lib/payment-ledger.ts", import.meta.url), "utf8");
    const single = src.slice(src.indexOf("export async function createCheckoutSession("), src.indexOf("export async function getVirtualAccountState("));
    const bundle = src.slice(src.indexOf("export async function createBundleCheckoutSession("), src.indexOf("export async function getBundleOrderForParent("));
    assert.match(single, /findApprovedPendingTxIds\(db, \[invoice\.paymentId\], null\)/);
    assert.match(bundle, /findApprovedPendingTxIds\(db, paymentIds, null\)/);
    assert.match(bundle, /approvedPending: true as const/);
});

test("L1: 토스 조회 사이 학부모 승인이 다시 시작되면(updatedAt 갱신) 실패로 닫지 않는다", async () => {
    const state = newState({ tx: { status: "IN_PROGRESS", paymentKey: null }, ageMinutes: 90 });
    fakeDb(state);
    await withToss(async () => {
        state.ageMinutes = 0; // 조회하는 동안 다른 요청이 거래를 만졌다
        return json({ code: "NOT_FOUND_PAYMENT" }, 404);
    }, async () => {
        const swept = await ledger.reconcileTossPayments();
        assert.equal(swept.closed, 0);
        assert.equal(state.tx.status, "IN_PROGRESS");
    });
});

test("L2: 주문 번호 조회가 중단(ABORTED)이어도 결제 번호 조회가 완료면 닫지 않고 반영, 둘 다 승인 아님일 때만 닫기", async () => {
    const approved = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" }, ageMinutes: 90 });
    fakeDb(approved);
    await withToss(async (url) => (url.includes("/orders/")
        ? json(tossDone({ status: "ABORTED", paymentKey: "pk-0" }))
        : json(tossDone())), async (fetchCalls) => {
        const swept = await ledger.reconcileTossPayments();
        assert.equal(swept.recovered, 1);
        assert.equal(approved.tx.status, "DONE");
        assert.equal(fetchCalls.length, 2);
        assert.ok(fetchCalls[1].url.endsWith("/v1/payments/pk-1"));
    });
    const both = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" }, ageMinutes: 90 });
    fakeDb(both);
    await withToss(async (url) => (url.includes("/orders/") ? json(tossDone({ status: "ABORTED" })) : json({ code: "NOT_FOUND" }, 404)), async () => {
        await ledger.reconcileTossPayments();
        assert.equal(both.tx.status, "FAILED");
    });
    const unknown = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" }, ageMinutes: 90 });
    fakeDb(unknown);
    await withToss(async (url) => (url.includes("/orders/") ? json(tossDone({ status: "EXPIRED" })) : json({}, 503)), async () => {
        const swept = await ledger.reconcileTossPayments();
        assert.equal(swept.waiting, 1);
        assert.equal(unknown.tx.status, "IN_PROGRESS", "결제 번호 조회를 확인 못 하면 닫지 않는다");
    });
});

test("L3: 부분 취소와 전액 취소는 사유·문구가 다르다", () => {
    const tx = { orderId: ORDER, amount: AMOUNT, ageMinutes: 30 };
    const partial = rule.decideTossReconcile(tx, { kind: "verified", payment: { orderId: ORDER, status: "PARTIAL_CANCELED", totalAmount: AMOUNT } });
    const full = rule.decideTossReconcile(tx, { kind: "verified", payment: { orderId: ORDER, status: "CANCELED", totalAmount: AMOUNT } });
    assert.equal(partial.code, "TOSS_PARTIAL_CANCELED_BEFORE_LEDGER");
    assert.match(partial.headline, /일부만/);
    assert.equal(full.code, "TOSS_CANCELED_BEFORE_LEDGER");
    assert.match(full.headline, /전액 취소/);
    assert.notEqual(partial.headline, full.headline);
});

test("L7: 승인 응답의 주문·결제 번호 불일치와 금액 불일치는 사유·문구가 다르다", async () => {
    const cases = [
        { reply: tossDone({ orderId: "STIZ-OTHER" }), code: "TOSS_CONFIRM_ORDER_MISMATCH", text: /주문 번호·결제 번호가 장부 거래와 달라/ },
        { reply: tossDone({ totalAmount: 1000 }), code: "TOSS_AMOUNT_MISMATCH", text: /금액\(1,000원\)이 청구 금액과 달라/ },
    ];
    for (const c of cases) {
        const state = newState();
        const { slack } = fakeDb(state);
        await withToss(async () => json(c.reply), async () => {
            const result = await ledger.confirmTossPayment({ paymentKey: "pk-1", orderId: ORDER, amount: AMOUNT, invoiceId: null, owner });
            assert.equal(result.ok, false);
            assert.deepEqual(state.reviews.map((r) => r.code), [c.code]);
            assert.match(slack()[0].text, c.text);
            assert.equal(state.payment.status, "PENDING");
        });
    }
    const rec = rule.decideTossReconcile({ orderId: ORDER, amount: AMOUNT, ageMinutes: 30 }, { kind: "verified", payment: { orderId: "X", status: "DONE", totalAmount: AMOUNT } });
    assert.doesNotMatch(rec.headline, /금액/);
});

test("L5: 점검이 찾은 무통장 입금 완료 건을 반영 못 하면(이미 납부 등) «가상계좌 확인 필요» 기록 + 원장 알림 한 번", async () => {
    const state = newState({ tx: { status: "IN_PROGRESS", paymentKey: "pk-1" }, payment: { status: "PAID" }, invoice: { status: "PAID" } });
    const { slack } = fakeDb(state);
    await withToss(async () => json(tossDone({ method: "가상계좌" })), async () => {
        await ledger.reconcileTossPayments();
        await ledger.reconcileTossPayments();
        assert.deepEqual(state.reviews.map((r) => [r.action, r.code]), [["VIRTUAL_ACCOUNT_REVIEW", "VIRTUAL_ACCOUNT_ALREADY_PAID"]]);
        assert.equal(slack().length, 1);
        assert.equal(markPaidCount(state), 0);
    });
});
