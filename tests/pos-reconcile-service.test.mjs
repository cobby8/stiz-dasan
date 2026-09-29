import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * POS 결제 대사(자동 실행 + 관리자 화면) 회귀 테스트.
 *
 * 이 기능의 위험은 단 하나다 — **대조하려다 돈을 건드리는 것.**
 * 그래서 "INSERT 는 기록표 한 곳에만, Payment·청구서·수강·원생은 절대 안 건드림"을
 * 소스에서 직접 확인하고, 실패 경로(키 없음)는 **실제로 실행해서** 확인한다.
 */

const SERVICE = "src/lib/pos/reconcileService.ts";
const CRON = "src/app/api/cron/pos-reconcile/route.ts";
const SHELL = "src/app/admin/AdminShellClient.tsx";
const MATCH_MODULE = "src/lib/pos/tossplace-match.mjs";

// ───────────────── 실행 하네스 (prisma·네트워크를 가짜로 바꾼다) ─────────────────

function toDataUrl(code) {
    return `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
}

async function transpileToUrl(file) {
    const code = await readFile(file, "utf8");
    const out = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    return { out };
}

/**
 * reconcileService 를 가짜 prisma·가짜 토스 클라이언트로 갈아끼워 **실제로 실행**한다.
 * 문자열 검사만으로는 "키가 없을 때 예외를 던지는지"를 절대 알 수 없다.
 */
async function loadServiceWithStubs({ tossOrders = [], siteRows = [], roster = [], tossThrows = null } = {}) {
    globalThis.__posReconcileCalls = [];

    const prismaStub = toDataUrl(`
      export const prisma = {
        $executeRawUnsafe: async (sql, ...args) => {
          globalThis.__posReconcileCalls.push({ kind: "execute", sql, args });
          return 1;
        },
        $queryRawUnsafe: async (sql, ...args) => {
          globalThis.__posReconcileCalls.push({ kind: "query", sql, args });
          if (/FROM "Payment"/.test(sql)) return ${JSON.stringify(siteRows)};
          if (/FROM "Student"/.test(sql)) return ${JSON.stringify(roster)};
          return [];
        },
      };
    `);

    const clientStub = toDataUrl(`
      export async function fetchTossOrders() {
        ${tossThrows ? `throw Object.assign(new Error(${JSON.stringify(tossThrows)}), { httpStatus: 403 });` : ""}
        return { orders: ${JSON.stringify(tossOrders)}, eventId: "stub-event", pages: 1 };
      }
    `);

    const kst = await transpileToUrl("src/lib/datetime/kst.ts");
    const kstUrl = toDataUrl(kst.out);
    const matchUrl = pathToFileURL(path.resolve(MATCH_MODULE)).href;

    let { out } = await transpileToUrl(SERVICE);
    out = out
        .split('"@/lib/prisma"').join(`"${prismaStub}"`)
        .split('"@/lib/datetime/kst"').join(`"${kstUrl}"`)
        .split('"./tossplaceClient"').join(`"${clientStub}"`)
        .split('"./tossplace-match.mjs"').join(`"${matchUrl}"`);

    return import(toDataUrl(out));
}

/** 환경변수를 잠깐 바꿔 쓰고 반드시 되돌린다. */
async function withEnv(values, fn) {
    const keys = Object.keys(values);
    const saved = keys.map((k) => [k, process.env[k]]);
    for (const k of keys) {
        if (values[k] == null) delete process.env[k];
        else process.env[k] = values[k];
    }
    try {
        return await fn();
    } finally {
        for (const [k, v] of saved) {
            if (v == null) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

const NO_TOSS_ENV = {
    TOSS_PLACE_ACCESS_KEY: null,
    TOSS_PLACE_ACCESS_SECRET: null,
    TOSS_PLACE_MERCHANT_ID: null,
};

const FAKE_TOSS_ENV = {
    TOSS_PLACE_ACCESS_KEY: "test-access-key",
    TOSS_PLACE_ACCESS_SECRET: "test-secret-key",
    TOSS_PLACE_MERCHANT_ID: "324744",
};

// ───────────────────────── 실행 검증 ─────────────────────────

test("키가 없으면 예외를 던지지 않고 '실패' 기록을 한 줄 남긴다", async () => {
    const mod = await loadServiceWithStubs();
    const result = await withEnv(NO_TOSS_ENV, () =>
        mod.runPosReconcile({ month: "2026-09", source: "MANUAL" }),
    );

    assert.equal(result.summary.status, "FAILED");
    assert.equal(result.summary.targetMonth, "2026-09");
    assert.equal(result.summary.source, "MANUAL");
    // 원장이 읽는 문구다. 영어 스택트레이스가 나가면 아무도 못 고친다.
    assert.match(result.summary.error, /토스플레이스 접속 정보가 설정되지 않아/);
    assert.match(result.summary.error, /TOSS_PLACE_ACCESS_KEY/);
    assert.ok(result.runId && result.runId.length >= 10, "실행 ID 가 있어야 화면에서 찾을 수 있다");

    const writes = globalThis.__posReconcileCalls.filter((c) => c.kind === "execute");
    assert.equal(writes.length, 1, "실행 한 번에 기록은 딱 한 줄이어야 한다");
    assert.match(writes[0].sql, /INSERT INTO "PosReconcileRun"/);
    // 키가 없으면 토스도 DB 도 조회하지 않는다(헛돌지 않는다).
    assert.equal(globalThis.__posReconcileCalls.filter((c) => c.kind === "query").length, 0);
});

test("가맹점 번호가 숫자가 아니면 조회하지 않고 실패로 남긴다", async () => {
    const mod = await loadServiceWithStubs();
    const result = await withEnv({ ...FAKE_TOSS_ENV, TOSS_PLACE_MERCHANT_ID: "abc" }, () =>
        mod.runPosReconcile({ month: "2026-09", source: "CRON" }),
    );
    assert.equal(result.summary.status, "FAILED");
    assert.match(result.summary.error, /가맹점 번호/);
});

test("정상 실행되면 'OK' 기록 한 줄과 요약 숫자가 남는다", async () => {
    const mod = await loadServiceWithStubs({ tossOrders: [], siteRows: [], roster: [] });
    const result = await withEnv(FAKE_TOSS_ENV, () =>
        mod.runPosReconcile({ month: "2026-09", source: "CRON" }),
    );

    assert.equal(result.summary.status, "OK");
    assert.equal(result.summary.error, null);
    assert.equal(result.summary.siteCount, 0);
    assert.equal(result.summary.posCount, 0);
    assert.equal(result.summary.diffAmount, 0);

    const writes = globalThis.__posReconcileCalls.filter((c) => c.kind === "execute");
    assert.equal(writes.length, 1);
    assert.match(writes[0].sql, /INSERT INTO "PosReconcileRun"/);

    // 조회는 "결제"와 "원생 명단" 두 번뿐이고, 결제 조회는 KST 변환을 두 번 건다.
    const queries = globalThis.__posReconcileCalls.filter((c) => c.kind === "query");
    assert.equal(queries.length, 2);
    const paymentSql = queries.find((q) => /FROM "Payment"/.test(q.sql)).sql;
    assert.match(paymentSql, /AT TIME ZONE 'UTC'\) AT TIME ZONE 'Asia\/Seoul'/);
});

test("토스 조회가 실패해도 예외를 밖으로 던지지 않고 실패 기록을 남긴다", async () => {
    const mod = await loadServiceWithStubs({ tossThrows: "권한 없음" });
    const result = await withEnv(FAKE_TOSS_ENV, () =>
        mod.runPosReconcile({ month: "2026-09", source: "CRON" }),
    );
    assert.equal(result.summary.status, "FAILED");
    assert.match(result.summary.error, /토스플레이스 조회 권한이 없습니다/);
    assert.equal(globalThis.__posReconcileCalls.filter((c) => c.kind === "execute").length, 1);
});

test("월을 주지 않으면 한국시간 기준 이번 달을 대조한다", async () => {
    const mod = await loadServiceWithStubs();
    // KST 로 2026-10-01 01:00(=UTC 2026-09-30 16:00). UTC 기준으로 계산하면 9월이 나온다.
    const kstNewMonthDawn = Date.UTC(2026, 8, 30, 16, 0, 0);
    assert.equal(mod.currentMonthKst(kstNewMonthDawn), "2026-10");
});

// ───────────────────────── 소스 계약 검증 ─────────────────────────

test("대사는 기록표에만 INSERT 하고 돈에 관련된 표는 건드리지 않는다", async () => {
    const src = await readFile(SERVICE, "utf8");

    assert.match(src, /INSERT INTO "PosReconcileRun"/);
    // 쓰기 창구는 딱 하나여야 한다. 늘어나면 "어디서 썼는지"를 추적할 수 없다.
    assert.equal((src.match(/\$executeRawUnsafe/g) || []).length, 1);

    for (const table of ["Payment", "PaymentInvoice", "Enrollment", "Student"]) {
        assert.doesNotMatch(
            src,
            new RegExp(`UPDATE\\s+"${table}"`, "i"),
            `${table} 을(를) 수정하면 안 된다 — 대사는 읽기만 한다`,
        );
        assert.doesNotMatch(
            src,
            new RegExp(`DELETE\\s+FROM\\s+"${table}"`, "i"),
            `${table} 을(를) 지우면 안 된다`,
        );
    }
    // 기록표조차 지우거나 고치지 않는다(이력이 사라지면 언제부터 어긋났는지 못 되짚는다).
    assert.doesNotMatch(src, /UPDATE\s+"PosReconcileRun"/i);
    assert.doesNotMatch(src, /DELETE\s+FROM\s+"PosReconcileRun"/i);

    // PgBouncer 때문에 ORM 기본 메서드는 쓸 수 없다.
    assert.doesNotMatch(src, /prisma\.(payment|student|enrollment|posReconcileRun)\./);
});

test("크론은 CRON_SECRET 을 확인한다", async () => {
    const src = await readFile(CRON, "utf8");
    assert.match(src, /process\.env\.CRON_SECRET/);
    assert.match(src, /Bearer \$\{secret\}/);
    assert.match(src, /status:\s*401/);
    assert.match(src, /export const dynamic = "force-dynamic"/);
    assert.match(src, /runPosReconcile/);

    // 매일 KST 05:30(UTC 20:30)에 돌도록 등록돼 있어야 한다. 빠지면 아무도 모르게 멈춘다.
    const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
    const entry = vercel.crons.find((c) => c.path === "/api/cron/pos-reconcile");
    assert.ok(entry, "vercel.json 에 크론 등록이 빠졌습니다");
    assert.equal(entry.schedule, "30 20 * * *");
});

test("관리자 메뉴에서 도달할 수 있다", async () => {
    // 실제 사고(2026-08-05·2026-08-09): 화면·권한까지 다 만들고 사이드바 링크만 빠져
    // URL 을 직접 치지 않는 한 아무도 못 쓰는 화면이 남았다. 빌드·타입검사는 전부 통과한다.
    const shell = await readFile(SHELL, "utf8");
    assert.match(shell, /href="\/admin\/pos-reconcile"/);
    assert.ok(
        (shell.match(/"\/admin\/pos-reconcile"/g) || []).length >= 3,
        "NavItem 과 탭 경로 배열 두 곳(OPS_PATHS·MORE_OPS_PATHS)에 모두 등록돼야 합니다.",
    );
});

test("관리자 화면은 권한 확인 후 읽기만 한다", async () => {
    const page = await readFile("src/app/admin/pos-reconcile/page.tsx", "utf8");
    assert.match(page, /export const dynamic = "force-dynamic"/);
    assert.match(page, /await requireAdmin\(\)/);
    assert.match(page, /runPosReconcileNow/);

    const action = await readFile("src/app/actions/pos-reconcile.ts", "utf8");
    assert.match(action, /^"use server";/);
    assert.match(action, /await requireAdmin\(\)/);
    assert.match(action, /source:\s*"MANUAL"/);

    // 중복 클릭 방지: 전송 중에는 버튼이 잠겨야 한다.
    const button = await readFile("src/app/admin/pos-reconcile/ReconcileNowButton.tsx", "utf8");
    assert.match(button, /useFormStatus/);
    assert.match(button, /disabled=\{pending\}/);
});

test("매칭 로직은 저장소 안에 딱 한 벌만 존재한다", async () => {
    // 사본이 두 벌이 되면 한쪽만 고쳐져서 "어제까지 맞던 금액"이 조용히 갈린다.
    const skip = new Set(["node_modules", ".next", ".git", "outputs", ".vercel", "coverage"]);
    const found = [];
    async function walk(dir) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (skip.has(entry.name)) continue;
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(p);
            else if (entry.name === "tossplace-match.mjs") found.push(p.split(path.sep).join("/"));
        }
    }
    await walk(".");
    assert.deepEqual(found.map((f) => f.replace(/^\.\//, "")), [MATCH_MODULE]);

    // CLI 도 같은 파일을 쓴다(사본을 만들지 않았다는 증거).
    const cli = await readFile("scripts/tossplace-reconcile.mjs", "utf8");
    assert.match(cli, /from "\.\.\/src\/lib\/pos\/tossplace-match\.mjs"/);
    assert.match(cli, /from "\.\.\/src\/lib\/pos\/tossplaceClient\.ts"/);
    // 토스 호출 코드도 한 벌뿐이다.
    assert.doesNotMatch(cli, /open-api\.tossplace\.com/);
    assert.doesNotMatch(cli, /x-secret-key/);
});
