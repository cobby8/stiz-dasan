// 납부완료(PAID) 청구의 상태 변경 막기 — 회귀 테스트(2026-11-10 원장 지시).
//
// 원장 지시: «납부완료를 대기·취소로 바꾸는 건 잘못된 동작». 실제 결제된 돈은 그대로인데 장부만 바뀌는 구멍.
//  ① 순수 규칙(paidStatusGuard.ts) — 실제 결제=잠금 · 수기=대기로만 · 모르는 경로=잠금
//  ② 서버 updatePaymentStatus·bulkUpdatePaymentStatus 를 가짜 prisma 로 «실제 실행» — DB 값으로 판정, 조건부 UPDATE, 감사 기록
//  ③ 화면 PaidStatusNotice 렌더 — 잠금 안내·되돌리기 확인 문구, 학생 상세 연결
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/payments/paidStatusGuard.ts");
const actions = readFileSync("src/app/actions/admin.ts", "utf8");
const detail = readFileSync("src/app/admin/students/[id]/StudentDetailClient.tsx", "utf8");
const queries = readFileSync("src/lib/queries.ts", "utf8");

// ───────────────────────────── ① 순수 규칙 ─────────────────────────────

test("규칙: 실제 결제(토스 온라인·POS·카페24·옛 단말기·모르는 경로)로 받은 납부완료는 어떤 상태로도 못 바꾼다", () => {
    for (const provider of ["TOSS", "TOSS_POS", "CAFE24_BRIDGE", "TOSS_TERMINAL", "SOMETHING_NEW"]) {
        assert.equal(rules.paidStatusLock("PAID", provider), "REAL_LOCKED", provider);
        for (const next of ["PENDING", "OVERDUE", "CANCELED"]) {
            const d = rules.judgePaymentStatusChange({ status: "PAID", paidProvider: provider }, next);
            assert.equal(d.ok, false, `${provider} → ${next}`);
            assert.equal(d.code, "REAL_PAYMENT");
            assert.equal(d.message, "결제 취소·환불은 수납 관리에서 해 주세요.");
        }
    }
});

test("규칙: 수기 납부완료(MANUAL·빈 값·null)는 «대기»로만 되돌린다 — 취소·연체는 거절", () => {
    for (const provider of ["MANUAL", "manual", "", "  ", null, undefined]) {
        assert.equal(rules.paidStatusLock("PAID", provider), "MANUAL_REVERT", String(provider));
        assert.deepEqual(rules.judgePaymentStatusChange({ status: "PAID", paidProvider: provider }, "PENDING"), { ok: true, kind: "REVERT_PAID" });
        for (const next of ["OVERDUE", "CANCELED", "PAID"]) {
            const d = rules.judgePaymentStatusChange({ status: "PAID", paidProvider: provider }, next);
            assert.equal(d.ok, false);
            assert.equal(d.code, "MANUAL_PENDING_ONLY");
        }
    }
});

test("규칙: 수기로 적혀 있어도 완료된 온라인 거래가 붙어 있으면 되돌리지 않는다", () => {
    const d = rules.judgePaymentStatusChange({ status: "PAID", paidProvider: "MANUAL", hasDoneTransaction: true }, "PENDING");
    assert.equal(d.ok, false);
    assert.equal(d.code, "HAS_DONE_TX");
});

test("규칙: 납부완료가 아닌 청구는 예전 그대로(대기↔연체↔취소)", () => {
    for (const status of ["PENDING", "OVERDUE", "CANCELED", "REFUNDED"]) {
        assert.equal(rules.paidStatusLock(status, "TOSS"), "NONE");
        assert.deepEqual(rules.judgePaymentStatusChange({ status, paidProvider: "TOSS" }, "CANCELED"), { ok: true, kind: "NORMAL" });
    }
});

// ───────────────────────────── ② 서버 실제 실행 ─────────────────────────────

const guardSource = actions.slice(
    actions.indexOf("class PaymentStatusGuardError"),
    actions.indexOf("/**\n * 계좌이체 납부 기록"),
);
const bulkSource = actions.slice(
    actions.indexOf("export async function bulkUpdatePaymentStatus"),
    actions.indexOf("// Phase 2: 일일 수업 리포트"),
);
assert.ok(guardSource.includes("export async function updatePaymentStatus"), "updatePaymentStatus 를 잘라 왔어야 한다");
assert.ok(bulkSource.length > 100, "bulkUpdatePaymentStatus 를 잘라 왔어야 한다");

/**
 * 가짜 DB — Payment 행 상태를 들고, 조건부 UPDATE 의 WHERE 를 JS 로 흉내 낸다.
 * raceTo: 판정용 SELECT 직후 다른 경로가 상태를 바꾼 상황(예: 토스 웹훅이 납부완료로)
 */
function loadActions(initialRows, { raceTo = null } = {}) {
    const db = new Map(initialRows.map((r) => [r.id, { paidProvider: null, method: null, paidDate: null, hasDoneTransaction: false, ...r }]));
    const calls = { updates: [], invoiceUpdates: [], audits: [], revalidated: 0 };
    const prisma = {
        $queryRawUnsafe: async (sql, ids) => {
            assert.match(sql, /FROM "Payment" p/);
            assert.match(sql, /"PaymentTransaction"/, "완료 거래 여부도 DB 에서 읽는다");
            const rows = ids.filter((id) => db.has(id)).map((id) => ({ id, ...db.get(id) }));
            if (raceTo) for (const id of ids) if (db.has(id)) db.get(id).status = raceTo;
            return rows;
        },
        $executeRawUnsafe: async (sql, ...values) => {
            if (sql.includes('UPDATE "PaymentInvoice"')) { calls.invoiceUpdates.push({ sql, values }); return 1; }
            assert.match(sql, /UPDATE "Payment"/);
            calls.updates.push({ sql, values });
            if (sql.includes("status = 'PENDING', \"paidDate\" = NULL, method = NULL")) {
                // 수기 되돌리기: WHERE status='PAID' AND 수기 AND 완료 거래 없음
                const row = db.get(values[0]);
                const manual = row && (row.paidProvider == null || ["", "MANUAL"].includes(String(row.paidProvider).trim().toUpperCase()));
                if (!row || row.status !== "PAID" || !manual || row.hasDoneTransaction) return 0;
                Object.assign(row, { status: "PENDING", paidDate: null, method: null, paidProvider: null });
                return 1;
            }
            // 일반 변경: WHERE ... AND status <> 'PAID'
            assert.match(sql, /status <> 'PAID'/, "납부완료를 덮지 않는 조건부 UPDATE 여야 한다");
            const [status, ...ids] = values;
            let n = 0;
            for (const id of new Set(ids)) {
                const row = db.get(id);
                if (row && row.status !== "PAID") { row.status = status; n++; }
            }
            return n;
        },
    };
    const deps = {
        prisma,
        requireFinanceOwner: async () => ({ appUserId: "admin-1", appUserRole: "ADMIN" }),
        DIRECT_PAID_BLOCKED_MESSAGE: "납부완료는 «납부 처리» 창에서 결제 방법을 골라 기록해 주세요.",
        DIRECT_REFUND_BLOCKED_MESSAGE: "환불은 수납 관리의 ⚡ «환불» 또는 «선택 항목 환불»로 해 주세요.",
        judgePaymentStatusChange: rules.judgePaymentStatusChange,
        ensurePaymentInfrastructure: async () => {},
        ensureInvoiceForPayment: async (id) => ({ id: `inv-${id}` }),
        recordPaymentAudit: async (input) => { calls.audits.push(input); },
        revalidateFinanceCaches: () => { calls.revalidated++; },
        console: { error() {} },
    };
    const compiled = ts.transpile(`${guardSource}\n${bulkSource}`, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
    const loaded = { exports: {} };
    new Function("module", "exports", ...Object.keys(deps), compiled)(loaded, loaded.exports, ...Object.values(deps));
    return { ...loaded.exports, db, calls };
}

test("서버: 토스 온라인·POS·카페24 납부완료는 대기·연체·취소 전부 거절하고 아무것도 쓰지 않는다", async () => {
    for (const provider of ["TOSS", "TOSS_POS", "CAFE24_BRIDGE"]) {
        for (const next of ["PENDING", "OVERDUE", "CANCELED"]) {
            const f = loadActions([{ id: "p1", status: "PAID", paidProvider: provider }]);
            await assert.rejects(f.updatePaymentStatus("p1", next), /결제 취소·환불은 수납 관리에서 해 주세요/);
            assert.equal(f.calls.updates.length, 0);
            assert.equal(f.calls.invoiceUpdates.length, 0);
            assert.equal(f.calls.audits.length, 0);
            assert.equal(f.db.get("p1").status, "PAID");
        }
    }
});

test("서버: 수기 납부완료 → 대기는 허용 — 납부 기록을 비우고 청구서도 되돌리고 감사 기록(이전 값)을 남긴다", async () => {
    const f = loadActions([{ id: "p1", status: "PAID", paidProvider: "MANUAL", method: "BANK_TRANSFER", paidDate: "2026-11-05T00:00:00.000Z" }]);
    await f.updatePaymentStatus("p1", "PENDING");
    assert.equal(f.db.get("p1").status, "PENDING");
    assert.equal(f.db.get("p1").paidProvider, null);
    const [upd] = f.calls.updates;
    assert.match(upd.sql, /WHERE id = \$1 AND status = 'PAID'/, "조건부 UPDATE(WHERE status='PAID')");
    assert.match(upd.sql, /COALESCE\(NULLIF\(UPPER\(TRIM\("paidProvider"\)\), ''\), 'MANUAL'\) = 'MANUAL'/, "수기 조건을 SQL 에서도 건다");
    assert.match(upd.sql, /NOT EXISTS \(SELECT 1 FROM "PaymentTransaction"/);
    assert.match(f.calls.invoiceUpdates[0].sql, /"paidAt" = NULL/);
    assert.equal(f.calls.audits.length, 1);
    const audit = f.calls.audits[0];
    assert.equal(audit.action, "PAYMENT_PAID_REVERTED");
    assert.equal(audit.actorType, "ADMIN");
    assert.equal(audit.actorId, "admin-1");
    assert.equal(audit.invoiceId, "inv-p1");
    assert.deepEqual(audit.metadata, {
        previousStatus: "PAID", nextStatus: "PENDING",
        previousPaidProvider: "MANUAL", previousMethod: "BANK_TRANSFER", previousPaidDate: "2026-11-05T00:00:00.000Z",
    });
    assert.equal(f.calls.revalidated, 1);
});

test("서버: 옛 기록(paidProvider null) 납부완료도 대기로만 — 취소·연체는 거절", async () => {
    const ok = loadActions([{ id: "p1", status: "PAID", paidProvider: null, method: "RALLYZ" }]);
    await ok.updatePaymentStatus("p1", "PENDING");
    assert.equal(ok.db.get("p1").status, "PENDING");
    for (const next of ["CANCELED", "OVERDUE"]) {
        const f = loadActions([{ id: "p1", status: "PAID", paidProvider: "MANUAL" }]);
        await assert.rejects(f.updatePaymentStatus("p1", next), /«대기로 되돌리기»만/);
        assert.equal(f.calls.updates.length, 0);
        assert.equal(f.db.get("p1").status, "PAID");
    }
});

test("서버: 화면 값이 아니라 DB 값으로 판정 — 수기로 보여도 완료된 온라인 거래가 있으면 거절", async () => {
    const f = loadActions([{ id: "p1", status: "PAID", paidProvider: "MANUAL", hasDoneTransaction: true }]);
    await assert.rejects(f.updatePaymentStatus("p1", "PENDING"), /완료된 온라인 결제 기록/);
    assert.equal(f.calls.updates.length, 0);
});

test("서버: 판정 직후 다른 경로가 상태를 바꾸면(경합) 0건 갱신 → 거절, 감사 기록 없음", async () => {
    // 미납이었는데 판정 직후 토스 웹훅이 납부완료로 바꿈 → 연체로 덮지 않는다
    const f = loadActions([{ id: "p1", status: "PENDING" }], { raceTo: "PAID" });
    await assert.rejects(f.updatePaymentStatus("p1", "OVERDUE"), /상태가 바뀌어/);
    assert.equal(f.db.get("p1").status, "PAID");
    assert.equal(f.calls.audits.length, 0);
    // 수기 납부완료를 되돌리려는 사이 환불됨 → 조건부 UPDATE 0건
    const g = loadActions([{ id: "p2", status: "PAID", paidProvider: "MANUAL" }], { raceTo: "REFUNDED" });
    await assert.rejects(g.updatePaymentStatus("p2", "PENDING"), /상태가 바뀌어/);
    assert.equal(g.db.get("p2").status, "REFUNDED");
    assert.equal(g.calls.audits.length, 0);
});

test("서버: 미납·연체 청구의 상태 변경은 예전 그대로(연체·취소)", async () => {
    const f = loadActions([{ id: "p1", status: "PENDING" }]);
    await f.updatePaymentStatus("p1", "OVERDUE");
    assert.equal(f.db.get("p1").status, "OVERDUE");
    assert.equal(f.calls.audits[0].action, "PAYMENT_STATUS_UPDATE");
    assert.equal(f.calls.invoiceUpdates[0].values[0], "OVERDUE");
    await assert.rejects(f.updatePaymentStatus("nope", "CANCELED"), /수납 기록을 찾을 수 없습니다/);
});

test("서버: PAID·REFUNDED 로 직접 바꾸기는 예전처럼 첫 줄에서 거절", async () => {
    const f = loadActions([{ id: "p1", status: "PENDING" }]);
    await assert.rejects(f.updatePaymentStatus("p1", "PAID"), /납부 처리/);
    await assert.rejects(f.updatePaymentStatus("p1", "REFUNDED"), /환불은 수납 관리/);
    assert.equal(f.calls.updates.length, 0);
});

test("서버(일괄): 납부완료가 하나라도 섞이면 아무것도 바꾸지 않는다 — 실제 결제는 수납 관리 안내, 수기도 일괄 되돌리기 없음", async () => {
    const real = loadActions([{ id: "a", status: "PENDING" }, { id: "b", status: "PAID", paidProvider: "TOSS_POS" }]);
    await assert.rejects(real.bulkUpdatePaymentStatus(["a", "b"], "CANCELED"), /결제 취소·환불은 수납 관리에서 해 주세요/);
    assert.equal(real.calls.updates.length, 0);
    assert.equal(real.db.get("a").status, "PENDING");

    const manualCancel = loadActions([{ id: "a", status: "PENDING" }, { id: "b", status: "PAID", paidProvider: "MANUAL" }]);
    await assert.rejects(manualCancel.bulkUpdatePaymentStatus(["a", "b"], "CANCELED"), /«대기로 되돌리기»만/);
    assert.equal(manualCancel.calls.updates.length, 0);

    const manualRevert = loadActions([{ id: "b", status: "PAID", paidProvider: "MANUAL" }]);
    await assert.rejects(manualRevert.bulkUpdatePaymentStatus(["b"], "PENDING"), /학생 상세에서 한 건씩/);
    assert.equal(manualRevert.db.get("b").status, "PAID");
});

test("서버(일괄): 미납만이면 예전처럼 바꾸고, 판정 뒤 납부완료가 된 건은 덮지 않고 알린다", async () => {
    const f = loadActions([{ id: "a", status: "PENDING" }, { id: "b", status: "OVERDUE" }]);
    await f.bulkUpdatePaymentStatus(["a", "b"], "CANCELED");
    assert.equal(f.db.get("a").status, "CANCELED");
    assert.equal(f.db.get("b").status, "CANCELED");
    assert.equal(f.calls.audits[0].action, "PAYMENT_BULK_STATUS_UPDATE");

    const race = loadActions([{ id: "a", status: "PENDING" }], { raceTo: "PAID" });
    await assert.rejects(race.bulkUpdatePaymentStatus(["a"], "CANCELED"), /상태가 바뀌어/);
    assert.equal(race.db.get("a").status, "PAID");

    const missing = loadActions([{ id: "a", status: "PENDING" }]);
    await assert.rejects(missing.bulkUpdatePaymentStatus(["a", "ghost"], "CANCELED"), /찾을 수 없습니다/);
    assert.equal(missing.calls.updates.length, 0);
});

// ───────────────────────────── ③ 화면 ─────────────────────────────

/** PaidStatusNotice 를 실제로 렌더한다. InlineConfirm 은 받은 값을 그대로 그리는 대역(펼친 뒤 문구·확정 동작 검사용) */
function loadNotice() {
    const confirmProps = [];
    const FakeInlineConfirm = (props) => {
        confirmProps.push(props);
        return jsx.jsx("span", { "data-confirm": "1", "data-question": props.question, children: props.label });
    };
    const FakeLink = ({ href, children, prefetch: _p, ...rest }) => jsx.jsx("a", { href, ...rest, children });
    const dependencies = {
        "react/jsx-runtime": jsx,
        "next/link": { __esModule: true, default: FakeLink },
        "@/components/parent/InlineConfirm": { __esModule: true, default: FakeInlineConfirm },
    };
    const code = ts.transpileModule(readFileSync("src/app/admin/students/[id]/PaidStatusNotice.tsx", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const exported = {};
    vm.runInNewContext(code, { exports: exported, require: (name) => { assert.ok(name in dependencies, `예상 밖 의존: ${name}`); return dependencies[name]; } });
    return { Notice: exported.default, confirmProps };
}

test("화면: 실제 결제 납부완료 = 잠금 안내 한 줄 + 수납 관리 링크, 되돌리기 버튼 없음", () => {
    const { Notice, confirmProps } = loadNotice();
    const html = renderToStaticMarkup(jsx.jsx(Notice, { lock: "REAL_LOCKED", updating: false, onRevert: () => assert.fail("부르면 안 된다") }));
    assert.match(html, /결제 취소·환불은 <a href="\/admin\/finance"[^>]*>수납 관리<\/a> ⚡ 메뉴에서 해요\./);
    assert.doesNotMatch(html, /대기로 되돌리기/);
    assert.equal(confirmProps.length, 0);
});

test("화면: 수기 납부완료 = «대기로 되돌리기» 그 자리 확인(«실제로 돈을 받지 않았을 때만») → 확정 시 onRevert", () => {
    const { Notice, confirmProps } = loadNotice();
    let reverted = 0;
    const html = renderToStaticMarkup(jsx.jsx(Notice, { lock: "MANUAL_REVERT", updating: false, onRevert: () => { reverted++; } }));
    assert.match(html, /대기로 되돌리기/);
    assert.match(html, /돈을 돌려줬다면 <a href="\/admin\/finance"[^>]*>수납 관리<\/a> ⚡ 메뉴 «환불»을 쓰세요/);
    assert.equal(confirmProps.length, 1);
    const p = confirmProps[0];
    assert.match(p.question, /실제로 돈을 받지 않았을 때만 쓰세요/);
    assert.equal(p.confirmLabel, "대기로 되돌리기");
    assert.match(p.triggerClassName, /min-h-11/, "터치 44px");
    p.onConfirm();
    assert.equal(reverted, 1);
});

test("화면: 납부완료가 아니면 아무것도 그리지 않는다", () => {
    const { Notice } = loadNotice();
    assert.equal(renderToStaticMarkup(jsx.jsx(Notice, { lock: "NONE", updating: false, onRevert() {} })), "");
});

test("화면: 진짜 InlineConfirm 으로도 렌더된다(닫힌 상태 = 위험 테두리 버튼 «대기로 되돌리기»)", async () => {
    // 대역 없이 실제 InlineConfirm 을 붙여 렌더(react 훅 사용) — 닫힌 상태에선 확정 버튼이 없다
    const ic = ts.transpileModule(readFileSync("src/components/parent/InlineConfirm.tsx", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const react = await import("react");
    const icExports = {};
    vm.runInNewContext(ic, { exports: icExports, require: (n) => ({ "react/jsx-runtime": jsx, react })[n] });
    const code = ts.transpileModule(readFileSync("src/app/admin/students/[id]/PaidStatusNotice.tsx", "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exported = {};
    const FakeLink = ({ href, children }) => jsx.jsx("a", { href, children });
    vm.runInNewContext(code, { exports: exported, require: (n) => ({ "react/jsx-runtime": jsx, "next/link": { __esModule: true, default: FakeLink }, "@/components/parent/InlineConfirm": icExports })[n] });
    const html = renderToStaticMarkup(jsx.jsx(exported.default, { lock: "MANUAL_REVERT", updating: false, onRevert() {} }));
    assert.match(html, /<button type="button" class="academy-button-danger shrink-0 min-h-11 px-3 text-xs">대기로 되돌리기<\/button>/);
    assert.doesNotMatch(html, /academy-button-danger-solid/, "펼치기 전엔 확정 버튼이 없다(한 번 더 묻는다)");
});

test("화면 연결: 학생 상세 — 납부완료면 묶음 버튼 전부 잠금 · 규칙 함수 · PaidStatusNotice · 되돌리기는 PENDING 만", () => {
    assert.match(detail, /const paidLock = paidStatusLock\(p\.status, p\.paidProvider\)/);
    assert.match(detail, /disabled=\{updating \|\| selected \|\| paidLock !== "NONE"\}/);
    assert.match(detail, /<PaidStatusNotice\s+lock=\{paidLock\}\s+updating=\{updating\}\s+onRevert=\{\(\) => changePaymentStatus\(p\.id, p\.status, "PENDING"\)\}/);
    assert.match(detail, /if \(currentStatus === "PAID" && nextStatus !== "PENDING"\) return;/);
    assert.match(detail, /paidLock === "REAL_LOCKED" \? "lock" : "edit"/);
    // 조회가 결제 경로를 화면에 넘긴다
    const activity = queries.slice(queries.indexOf("export async function getStudentActivity"));
    assert.match(activity, /p\.month, p\."paidProvider",/);
    assert.match(activity, /paidProvider: p\.paidProvider \?\? p\.paidprovider \?\? null,/);
});

test("다른 화면: 수납 관리는 납부완료에 상태 변경을 걸지 않는다(연체처리는 미납만 · 일괄 상태 변경 미사용)", () => {
    const finance = readFileSync("src/app/admin/finance/FinanceClient.tsx", "utf8");
    assert.match(finance, /canManageCriticalFinance && p\.status === "PENDING" \? \[\s*\{\s*key: "overdue"/);
    assert.equal((finance.match(/handleStatusChange\(/g) ?? []).length, 2, "정의 1 + 연체처리 1 외에 부르는 곳이 없다");
    assert.doesNotMatch(finance, /bulkUpdatePaymentStatus/);
});
