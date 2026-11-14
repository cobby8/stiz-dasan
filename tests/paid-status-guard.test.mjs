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
// 묶음 결제 거래 판정 SQL 조각 — 서버와 같은 함수(순수 함수만 잘라 실행. bundleLedger.ts 는 prisma 를 불러 통째로 못 읽는다)
const bundleSrc = readFileSync("src/lib/payments/bundleLedger.ts", "utf8");
const bundlePart = bundleSrc.slice(
    bundleSrc.indexOf("export function txCoversPaymentSql"),
    bundleSrc.indexOf("\n}\n", bundleSrc.indexOf("function assertSqlIdent")) + 3,
).replace(/export /g, "");
const bundle = { txCoversPaymentSql: new Function(`${ts.transpile(bundlePart, { target: ts.ScriptTarget.ES2022 })}\nreturn txCoversPaymentSql;`)() };
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
const deletePaymentSource = actions.slice(
    actions.indexOf("// 현장 결제(POS)로 받은 청구는 삭제하면"),
    actions.indexOf("/**\n * 미납 청구 수정"),
);
const deleteStudentSource = actions.slice(
    actions.indexOf("export async function deleteStudent"),
    actions.indexOf("// ── 수강 등록 관리"),
);
assert.ok(guardSource.includes("export async function updatePaymentStatus"), "updatePaymentStatus 를 잘라 왔어야 한다");
assert.ok(bulkSource.length > 100, "bulkUpdatePaymentStatus 를 잘라 왔어야 한다");
assert.ok(deletePaymentSource.includes("export async function deletePayment"), "deletePayment 를 잘라 왔어야 한다");
assert.ok(deleteStudentSource.includes('DELETE FROM "Payment" WHERE "studentId"'), "deleteStudent 를 잘라 왔어야 한다");

/**
 * 가짜 DB — Payment 행 상태를 들고, 조건부 UPDATE 의 WHERE 를 JS 로 흉내 낸다.
 * $transaction 은 실패하면 행을 되돌리고(롤백) 그 안의 청구서 UPDATE·DELETE 도 반영하지 않는다.
 * raceTo: 판정용 SELECT 직후 다른 경로가 상태를 바꾼 상황(예: 토스 웹훅이 납부완료로)
 */
function loadActions(initialRows, { raceTo = null, raceIds = null, posBlocked = false } = {}) {
    const fresh = (r) => ({ studentId: "s1", paidProvider: null, method: null, paidDate: null, hasDoneTransaction: false, hasManualDoneTransaction: false, ...r });
    let db = new Map(initialRows.map((r) => [r.id, fresh(r)]));
    const calls = { updates: [], invoiceUpdates: [], deletes: [], audits: [], revalidated: 0, transactions: 0, rollbacks: 0 };
    function makeClient(sink) {
        return {
            $queryRawUnsafe: async (sql, ...args) => {
                if (sql.includes('"PosChargeRequest"')) return [{ blocked: posBlocked }];
                if (sql.includes("FOR UPDATE")) return db.has(args[0]) ? [{ id: args[0] }] : [];
                if (sql.includes('WHERE "studentId" = $1')) return [...db.entries()].filter(([, r]) => r.studentId === args[0]).map(([id]) => ({ id }));
                const ids = args[0];
                assert.match(sql, /FROM "Payment" p/);
                assert.match(sql, /"PaymentTransaction"/, "완료 거래 여부도 DB 에서 읽는다");
                assert.match(sql, /"PaymentTransactionItem"/, "묶음 거래 항목까지 본다");
                assert.match(sql, /UPPER\(t\.provider\) = 'MANUAL'/, "교사 수납 확인 거래를 따로 읽는다");
                const rows = ids.filter((id) => db.has(id)).map((id) => ({ id, ...db.get(id) }));
                // raceIds 가 있으면 그 청구만 경합(일괄 변경의 «일부만 바뀜» 상황)
                if (raceTo) for (const id of raceIds ?? ids) if (db.has(id)) db.get(id).status = raceTo;
                return rows;
            },
            $executeRawUnsafe: async (sql, ...values) => {
                if (sql.startsWith("DELETE")) { sink.deletes.push({ sql, values }); return 1; }
                if (sql.includes('UPDATE "PaymentInvoice"')) { sink.invoiceUpdates.push({ sql, values }); return 1; }
                assert.match(sql, /UPDATE "Payment"/);
                sink.updates.push({ sql, values });
                if (sql.includes("status = 'PENDING', \"paidDate\" = NULL, method = NULL")) {
                    // 수기 되돌리기: WHERE status='PAID' AND 수기 AND 완료 거래 없음
                    const row = db.get(values[0]);
                    const manual = row && (row.paidProvider == null || ["", "MANUAL"].includes(String(row.paidProvider).trim().toUpperCase()));
                    if (!row || row.status !== "PAID" || !manual || row.hasDoneTransaction || row.hasManualDoneTransaction) return 0;
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
    }
    const outside = makeClient(calls);
    const prisma = {
        ...outside,
        // 트랜잭션: 끝까지 성공해야 반영. 던지면 행 상태를 되돌리고 그 안의 쓰기 기록도 버린다
        $transaction: async (work) => {
            calls.transactions++;
            const snapshot = new Map([...db.entries()].map(([k, v]) => [k, { ...v }]));
            const sink = { updates: [], invoiceUpdates: [], deletes: [] };
            try {
                const result = await work(makeClient(sink));
                calls.updates.push(...sink.updates);
                calls.invoiceUpdates.push(...sink.invoiceUpdates);
                calls.deletes.push(...sink.deletes);
                for (const d of sink.deletes) if (/DELETE FROM "Payment" WHERE id/.test(d.sql)) db.delete(d.values[0]);
                return result;
            } catch (e) {
                calls.rollbacks++;
                db = snapshot;
                throw e;
            }
        },
    };
    const deps = {
        prisma,
        requireFinanceOwner: async () => ({ appUserId: "admin-1", appUserRole: "ADMIN" }),
        requireAdmin: async () => ({ appUserId: "admin-1", appUserRole: "ADMIN" }),
        DIRECT_PAID_BLOCKED_MESSAGE: "납부완료는 «납부 처리» 창에서 결제 방법을 골라 기록해 주세요.",
        DIRECT_REFUND_BLOCKED_MESSAGE: "환불은 수납 관리의 ⚡ «환불» 또는 «선택 항목 환불»로 해 주세요.",
        judgePaymentStatusChange: rules.judgePaymentStatusChange,
        paymentDeleteBlockReason: rules.paymentDeleteBlockReason,
        txCoversPaymentSql: bundle.txCoversPaymentSql,
        ensurePaymentInfrastructure: async () => {},
        ensureInvoiceForPayment: async (id) => ({ id: `inv-${id}` }),
        recordPaymentAudit: async (input) => { calls.audits.push(input); },
        revalidateFinanceCaches: () => { calls.revalidated++; },
        revalidatePath: () => {},
        revalidateStudentAdminCaches: () => {},
        console: { error() {} },
        // 원생 삭제가 불러오는 프로필 사진 정리 부품(2026-11-15) — 사진 없는 원생으로 둔다(동작은 profile-photo.test.mjs 가 본다)
        require: (name) => {
            if (name === "@/lib/profilePhoto/cleanup") return { readProfilePhotoPath: async () => null, removeProfilePhotoFiles: async () => {} };
            throw new Error("대역 없는 의존: " + name);
        },
    };
    const compiled = ts.transpile(`${guardSource}\n${bulkSource}\n${deletePaymentSource}\n${deleteStudentSource}`, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
    const loaded = { exports: {} };
    new Function("module", "exports", ...Object.keys(deps), compiled)(loaded, loaded.exports, ...Object.values(deps));
    return { ...loaded.exports, get db() { return db; }, calls };
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
    // 2026-11-13 UI 통일 2단계: ⚡ 아이콘 버튼이 «빠른작업» 글자 버튼이 되어 안내 문구도 그 이름으로 부른다(가는 곳·뜻은 같다)
    assert.match(html, /결제 취소·환불은 <a href="\/admin\/finance"[^>]*>수납 관리<\/a> «빠른작업» 메뉴에서 해요\./);
    assert.doesNotMatch(html, /대기로 되돌리기/);
    assert.equal(confirmProps.length, 0);
});

test("화면: 수기 납부완료 = «대기로 되돌리기» 그 자리 확인(«실제로 돈을 받지 않았을 때만») → 확정 시 onRevert", () => {
    const { Notice, confirmProps } = loadNotice();
    let reverted = 0;
    const html = renderToStaticMarkup(jsx.jsx(Notice, { lock: "MANUAL_REVERT", updating: false, onRevert: () => { reverted++; } }));
    assert.match(html, /대기로 되돌리기/);
    assert.match(html, /돈을 돌려줬다면 <a href="\/admin\/finance"[^>]*>수납 관리<\/a> «빠른작업» 메뉴 «환불»을 쓰세요/);
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
    // 2026-11-13 UI 통일 2단계: 아이콘만 있던 버튼(자물쇠·연필)을 글자로 — 실제 결제 납부완료면 «잠김», 아니면 «상태 변경»(구분은 그대로)
    assert.match(detail, /paidLock === "REAL_LOCKED" \? "잠김 안내" : "상태 변경"/);
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

// ───────────── ④ 영구 삭제 금지 · 교사 수납 문구 · 트랜잭션 (2026-11-10 원장 승인·보안 리뷰 참고) ─────────────

test("규칙(삭제): 실제 결제 납부완료·완료 거래가 붙은 청구는 삭제 금지, 수기·미납·환불 끝난 건은 허용", () => {
    for (const provider of ["TOSS", "TOSS_POS", "CAFE24_BRIDGE", "TOSS_TERMINAL", "SOMETHING_NEW"]) {
        assert.match(rules.paymentDeleteBlockReason({ status: "PAID", paidProvider: provider }), /결제 취소·환불을 먼저 해 주세요/, provider);
    }
    assert.match(rules.paymentDeleteBlockReason({ status: "REFUNDED", paidProvider: "TOSS", hasDoneTransaction: true }), /결제 취소·환불을 먼저/);
    assert.match(rules.paymentDeleteBlockReason({ status: "PAID", paidProvider: "MANUAL", hasManualDoneTransaction: true }), /선생님 수납 확인/);
    for (const row of [
        { status: "PAID", paidProvider: "MANUAL" },
        { status: "PAID", paidProvider: null },
        { status: "PENDING", paidProvider: null },
        { status: "CANCELED", paidProvider: "TOSS" },
        { status: "REFUNDED", paidProvider: "TOSS" },
    ]) assert.equal(rules.paymentDeleteBlockReason(row), null, JSON.stringify(row));
});

test("규칙(문구): 교사 수납 확인(MANUAL 완료 거래) 기록은 되돌리기 거절이되 «온라인 결제»라고 하지 않는다", () => {
    const d = rules.judgePaymentStatusChange({ status: "PAID", paidProvider: "MANUAL", hasManualDoneTransaction: true }, "PENDING");
    assert.equal(d.ok, false);
    assert.equal(d.code, "STAFF_CONFIRMED");
    assert.equal(d.message, "선생님 수납 확인으로 받은 기록이에요. 수납 관리에서 확인해 주세요.");
    assert.doesNotMatch(d.message, /온라인/);
    // 토스 완료 거래가 함께 있으면 온라인 문구가 우선
    assert.equal(rules.judgePaymentStatusChange({ status: "PAID", paidProvider: "MANUAL", hasDoneTransaction: true, hasManualDoneTransaction: true }, "PENDING").code, "HAS_DONE_TX");
});

test("서버: 교사 수납 확인 납부완료 되돌리기 → 정확한 문구로 거절, 아무것도 쓰지 않음", async () => {
    const f = loadActions([{ id: "p1", status: "PAID", paidProvider: "MANUAL", hasManualDoneTransaction: true }]);
    await assert.rejects(f.updatePaymentStatus("p1", "PENDING"), /선생님 수납 확인으로 받은 기록이에요/);
    assert.equal(f.calls.updates.length, 0);
    assert.equal(f.db.get("p1").status, "PAID");
});

test("서버 트랜잭션: 단건 변경·되돌리기는 Payment·청구서를 한 트랜잭션으로, 0건이면 롤백(청구서도 안 바뀜)", async () => {
    const ok = loadActions([{ id: "p1", status: "PAID", paidProvider: "MANUAL" }]);
    await ok.updatePaymentStatus("p1", "PENDING");
    assert.equal(ok.calls.transactions, 1);
    assert.equal(ok.calls.invoiceUpdates.length, 1);

    const race = loadActions([{ id: "p1", status: "PENDING" }], { raceTo: "PAID" });
    await assert.rejects(race.updatePaymentStatus("p1", "CANCELED"), /상태가 바뀌어/);
    assert.equal(race.calls.rollbacks, 1);
    assert.equal(race.calls.invoiceUpdates.length, 0, "롤백되면 청구서 UPDATE 도 반영되지 않는다");
    assert.equal(race.calls.audits.length, 0);
});

test("서버 트랜잭션(일괄): 일부만 바뀌면(건수 불일치) 전체 롤백 — 먼저 바뀐 청구도 원래대로, 청구서·감사 기록 없음", async () => {
    // b 만 판정 직후 납부완료가 됨 → Payment UPDATE 1건 ≠ 2건 → 전체 롤백
    const f = loadActions([{ id: "a", status: "PENDING" }, { id: "b", status: "OVERDUE" }], { raceTo: "PAID", raceIds: ["b"] });
    await assert.rejects(f.bulkUpdatePaymentStatus(["a", "b"], "CANCELED"), /상태가 바뀌어/);
    assert.equal(f.calls.rollbacks, 1);
    assert.equal(f.db.get("a").status, "PENDING", "a 도 되돌아간다");
    assert.equal(f.db.get("b").status, "PAID");
    assert.equal(f.calls.invoiceUpdates.length, 0);
    assert.equal(f.calls.audits.length, 0);

    const ok = loadActions([{ id: "a", status: "PENDING" }, { id: "b", status: "OVERDUE" }]);
    await ok.bulkUpdatePaymentStatus(["a", "b"], "CANCELED");
    assert.equal(ok.calls.transactions, 1);
    assert.equal(ok.calls.invoiceUpdates.length, 1);
});

test("서버(영구 삭제): 실제 결제 납부완료·완료 거래·교사 수납 확인 청구는 거절하고 하나도 지우지 않는다", async () => {
    const cases = [
        [{ status: "PAID", paidProvider: "TOSS" }, /실제 결제로 받은 청구는 삭제할 수 없어요\. 결제 취소·환불을 먼저 해 주세요\./],
        [{ status: "PAID", paidProvider: "CAFE24_BRIDGE" }, /결제 취소·환불을 먼저/],
        [{ status: "PAID", paidProvider: "TOSS_TERMINAL" }, /결제 취소·환불을 먼저/],
        [{ status: "REFUNDED", paidProvider: "TOSS", hasDoneTransaction: true }, /결제 취소·환불을 먼저/],
        [{ status: "PAID", paidProvider: "MANUAL", hasManualDoneTransaction: true }, /선생님 수납 확인/],
    ];
    for (const [row, message] of cases) {
        const f = loadActions([{ id: "p1", ...row }]);
        await assert.rejects(f.deletePayment("p1"), message, JSON.stringify(row));
        assert.equal(f.calls.deletes.length, 0);
        assert.ok(f.db.has("p1"));
        assert.equal(f.calls.revalidated, 0);
    }
    // POS 묶음 막기는 예전 그대로
    const pos = loadActions([{ id: "p1", status: "PENDING" }], { posBlocked: true });
    await assert.rejects(pos.deletePayment("p1"), /현장 결제\(POS\)/);
    assert.equal(pos.calls.transactions, 0);
});

test("서버(영구 삭제): 수기 납부완료·미납은 예전처럼 한 트랜잭션으로 지운다(거래·청구서·청구 순서)", async () => {
    for (const row of [{ status: "PAID", paidProvider: "MANUAL" }, { status: "PENDING" }, { status: "CANCELED", paidProvider: "TOSS" }]) {
        const f = loadActions([{ id: "p1", ...row }]);
        await f.deletePayment("p1");
        assert.equal(f.calls.transactions, 1);
        assert.deepEqual(f.calls.deletes.map((d) => d.sql.match(/DELETE FROM "(\w+)"/)[1]), ["PaymentTransaction", "PaymentInvoice", "Payment"]);
        assert.ok(!f.db.has("p1"));
        assert.equal(f.calls.revalidated, 1);
    }
});

test("서버(영구 삭제): 잠근 뒤 다시 판정 — 판정 직전 토스로 납부완료가 된 청구는 지우지 않는다", async () => {
    // 첫 POS 확인은 미납으로 통과, 트랜잭션 안 재판정 SELECT 직전에 토스 납부완료로 바뀐 상황
    const f = loadActions([{ id: "p1", status: "PENDING" }]);
    const row = f.db.get("p1");
    Object.assign(row, { status: "PAID", paidProvider: "TOSS" });
    await assert.rejects(f.deletePayment("p1"), /결제 취소·환불을 먼저/);
    assert.equal(f.calls.rollbacks, 1);
    assert.ok(f.db.has("p1"));
});

test("서버(원생 삭제): 그 원생에게 실제 결제 청구가 있으면 원생 삭제도 거절(청구가 함께 지워지므로)", async () => {
    const blocked = loadActions([{ id: "p1", status: "PENDING" }, { id: "p2", status: "PAID", paidProvider: "TOSS_POS" }]);
    await assert.rejects(blocked.deleteStudent("s1"), /실제 결제로 받은 청구가 있어 원생을 삭제할 수 없어요/);
    assert.equal(blocked.calls.deletes.length, 0);

    // 수기 납부만 있으면 예전처럼 지운다
    const ok = loadActions([{ id: "p1", status: "PAID", paidProvider: "MANUAL" }]);
    await ok.deleteStudent("s1");
    assert.ok(ok.calls.deletes.some((d) => /DELETE FROM "Student"/.test(d.sql)));
    // 다른 원생의 실제 결제 청구는 상관없다
    const other = loadActions([{ id: "p9", status: "PAID", paidProvider: "TOSS", studentId: "s2" }]);
    await other.deleteStudent("s1");
    assert.ok(other.calls.deletes.some((d) => /DELETE FROM "Student"/.test(d.sql)));
});

test("화면(수납 관리 ⚡): 실제 결제 청구는 «기록 영구 삭제» 대신 잠긴 «삭제 불가(환불 먼저)» — 같은 규칙 함수", () => {
    const finance = readFileSync("src/app/admin/finance/FinanceClient.tsx", "utf8");
    assert.match(finance, /import \{ paymentDeleteBlockReason \} from "@\/lib\/payments\/paidStatusGuard"/);
    assert.match(finance, /const deleteBlock = paymentDeleteBlockReason\(\{\s*status: p\.status,\s*paidProvider: p\.paidProvider \?\? null,\s*hasDoneTransaction: p\.transactionStatus === "DONE",\s*\}\)/);
    assert.match(finance, /canManageCriticalFinance && deleteBlock \? \[\s*\{\s*key: "delete-blocked",[\s\S]{0,200}label: "삭제 불가\(환불 먼저\)",\s*icon: "block",\s*disabled: true,/);
    assert.match(finance, /canManageCriticalFinance && !deleteBlock && p\.paidProvider !== "TOSS_POS"/, "막힌 청구엔 진짜 삭제 항목이 없다");
});

test("화면(수납 관리 ⚡): 잠긴 항목을 실제 메뉴로 그리면 비활성 버튼이고 눌러도 아무 일 없음", async () => {
    // AdminQuickActionMenu 를 열린 상태로 그리기 어렵다 — 메뉴 항목 하나를 그리는 renderAction 과 같은 규칙(disabled 면 onSelect 를 부르지 않음)을 소스로 확인
    const menu = readFileSync("src/components/admin/AdminQuickActionMenu.tsx", "utf8");
    assert.match(menu, /disabled=\{action\.disabled\}/);
    assert.match(menu, /if \(action\.disabled\) return;/);
});
