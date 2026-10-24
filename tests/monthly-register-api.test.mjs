import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

function load(path, dependencies, extra = {}) {
  const exports = {};
  const js = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  new Function("require", "exports", ...Object.keys(extra), js)(id => {
    assert.ok(id in dependencies, `예상하지 않은 의존성 ${id}`);
    return dependencies[id];
  }, exports, ...Object.values(extra));
  return exports;
}
const model = load("src/lib/billing/monthly-register.ts", {});
const service = load("src/lib/billing/monthly-register-service.ts", { "node:crypto": {}, "./monthly-register": model });

function harness({ authorized = true, enabled = "true", failure = null } = {}) {
  const events = [];
  const modules = {
    "next/server": { NextResponse: { json: (body, init) => ({ body, status: 200, ...init }) } },
    "@/lib/auth-guard": { requireAdmin: async () => { events.push("auth"); if (!authorized) throw new Error("private-auth"); return { appUserId: "admin-from-auth" }; } },
    "@/lib/prisma": { prisma: { $transaction: async (fn, options) => {
      events.push(options);
      return fn({ $executeRawUnsafe: async sql => { events.push(sql); } });
    } } },
    "@/lib/billing/monthly-register": model,
    "@/lib/billing/monthly-register-service": {
      validateRegisterTarget: service.validateRegisterTarget,
      readMonthlyRegister: async (_tx, studentId, month, writesEnabled) => {
        events.push({ read: [studentId, month, writesEnabled] });
        if (failure) throw failure;
        return { record: null, writesEnabled };
      },
      mutateMonthlyRegister: async (_db, body, actor, writesEnabled) => {
        events.push({ mutation: body, actor, writesEnabled });
        service.validateRegisterCommand(body);
        if (failure) throw failure;
        return { id: "record-1" };
      },
    },
  };
  const route = load("src/app/api/admin/finance/monthly-register/route.ts", modules,
    { process: { env: { MONTHLY_REGISTER_WRITES_ENABLED: enabled } } });
  return { route, events };
}
const body = () => ({ action: "CONFIRM", studentId: "student-1", month: "2026-09", expectedVersion: 1, reason: "확인" });
function request({ text = JSON.stringify(body()), chunks, headers = {}, query = "studentId=student-1&month=2026-09", noBody = false } = {}) {
  const values = chunks ?? [new TextEncoder().encode(text)];
  return { nextUrl: new URL(`https://example.test/api/admin/finance/monthly-register?${query}`),
    headers: new Headers({ origin: "https://example.test", "content-type": "application/json", ...headers }),
    body: noBody ? null : new ReadableStream({ start(controller) { for (const value of values) controller.enqueue(value); controller.close(); } }) };
}
function noCache(response) { assert.match(response.headers["Cache-Control"], /private.*no-store/); }

test("관리자 인증은 GET·POST 데이터 접근보다 먼저이고 기본 off는503이다", async () => {
  for (const method of ["GET", "POST"]) {
    const fixture = harness({ authorized: false });
    const response = await fixture.route[method](request());
    assert.equal(response.status, 403); noCache(response);
    assert.deepEqual(fixture.events, ["auth"]);
  }
  for (const enabled of [undefined, "", "false", "TRUE"]) {
    const fixture = harness({ enabled: enabled ?? "" });
    const response = await fixture.route.POST(request());
    assert.equal(response.status, 503); noCache(response);
    assert.deepEqual(fixture.events, ["auth"]);
  }
});

test("GET는 엄격한 월·학생 ID와 읽기 전용 동일 스냅샷·no-store를 적용한다", async () => {
  const fixture = harness({ enabled: "false" });
  const response = await fixture.route.GET(request());
  assert.equal(response.status, 200); noCache(response);
  assert.deepEqual(fixture.events, ["auth", { isolationLevel: "RepeatableRead" }, "SET TRANSACTION READ ONLY", { read: ["student-1", "2026-09", false] }]);
  for (const query of ["studentId=student-1&month=2026-13", "studentId=&month=2026-09", "studentId=student-1&month=2019-12"]) {
    const invalid = harness();
    assert.equal((await invalid.route.GET(request({ query }))).status, 400);
    assert.deepEqual(invalid.events, ["auth"]);
  }
});

test("POST는 다른 origin·cross-site·비JSON을 서비스 호출 전에 차단한다", async () => {
  for (const [headers, status] of [[{ origin: "https://evil.test" }, 403], [{ origin: "" }, 403], [{ "sec-fetch-site": "cross-site" }, 403], [{ "content-type": "text/plain" }, 415]]) {
    const fixture = harness();
    const response = await fixture.route.POST(request({ headers }));
    assert.equal(response.status, status); noCache(response);
    assert.deepEqual(fixture.events, ["auth"]);
  }
});

test("128KiB 제한은 실제 UTF-8 stream에도 적용하고 잘못된 JSON·빈본문을400 처리한다", async () => {
  for (const input of [{ headers: { "content-length": "131073" } }, { headers: { "content-length": "1" }, text: "가".repeat(44000) }, { chunks: [new Uint8Array(70000), new Uint8Array(62000)] }]) {
    const fixture = harness();
    const response = await fixture.route.POST(request(input));
    assert.equal(response.status, 413); noCache(response);
    assert.deepEqual(fixture.events, ["auth"]);
  }
  for (const input of [{ text: "{" }, { text: "" }, { noBody: true }]) {
    const fixture = harness();
    assert.equal((await fixture.route.POST(request(input))).status, 400);
    assert.deepEqual(fixture.events, ["auth"]);
  }
});

test("허용된 최대20반·각500자 한글근거의38KB 이상 요청은 저장 서비스에 전달한다", async () => {
  const reason = "가".repeat(500);
  const payload = { studentId: "student-1", month: "2026-09",
    classes: Array.from({ length: 20 }, (_, index) => ({ classId: `class-${index}`, status: "ACTIVE",
      periodStart: "2026-09-01", periodEnd: "2026-09-30", baseAmount: 100000,
      discountAmount: 0, carryAmount: 0, prorationAmount: 0, basis: "나".repeat(500) })),
    shuttleAmount: 0, shuttleBasis: "다".repeat(500), reason };
  const maxBody = { action: "SAVE_DRAFT", studentId: payload.studentId, month: payload.month, expectedVersion: 0, reason, payload };
  const text = JSON.stringify(maxBody);
  const bytes = new TextEncoder().encode(text);
  assert.ok(bytes.byteLength > 38000 && bytes.byteLength < 128 * 1024);
  const fixture = harness();
  const response = await fixture.route.POST(request({ chunks: [bytes.slice(0, 17001), bytes.slice(17001)] }));
  assert.equal(response.status, 200); noCache(response);
  assert.deepEqual(fixture.events[1].mutation, maxBody);
});

test("POST는 인증된 관리자 ID만 전달하고 충돌·DB오류는 캐시 없이 반환한다", async () => {
  const fixture = harness();
  const response = await fixture.route.POST(request({ headers: { "content-type": "application/json; charset=utf-8" } }));
  assert.equal(response.status, 200); noCache(response);
  assert.deepEqual(fixture.events, ["auth", { mutation: body(), actor: "admin-from-auth", writesEnabled: true }]);
  for (const [failure, status] of [[new model.MonthlyRegisterError("버전 충돌", 409), 409], [new Error("DATABASE_SECRET"), 500]]) {
    for (const method of ["GET", "POST"]) {
      const failed = await harness({ failure }).route[method](request());
      assert.equal(failed.status, status); noCache(failed);
      assert.doesNotMatch(JSON.stringify(failed), /DATABASE_SECRET/);
    }
  }
});
