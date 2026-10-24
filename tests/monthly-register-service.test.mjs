import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import ts from "typescript";

function load(source, dependencies = {}) {
  const exports = {};
  const js = ts.transpileModule(readFileSync(source, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", js)((id) => {
    assert.ok(id in dependencies, `예상하지 않은 의존성 ${id}`);
    return dependencies[id];
  }, exports);
  return exports;
}
const model = load("src/lib/billing/monthly-register.ts");
const service = load("src/lib/billing/monthly-register-service.ts", {
  "node:crypto": crypto, "./monthly-register": model,
});
const payload = () => ({
  studentId: "student-1", month: "2026-09",
  classes: [{ classId: "class-1", status: "ACTIVE", periodStart: "2026-09-01", periodEnd: "2026-09-30",
    baseAmount: 100000, discountAmount: 10000, carryAmount: 5000, prorationAmount: 5000, basis: "운영자 확인" }],
  shuttleAmount: 10000, shuttleBasis: "월 1회", reason: "최초 입력",
});
const command = (action = "SAVE_DRAFT", expectedVersion = 0, extra = {}) => ({
  action, studentId: "student-1", month: "2026-09", expectedVersion,
  reason: action === "SAVE_DRAFT" ? "최초 입력" : "운영자 확인",
  ...(action === "SAVE_DRAFT" ? { payload: payload() } : {}), ...extra,
});

// 실제 DB가 아니다. 거래 callback 성공 때만 복사본을 커밋하는 모형이다.
function database(options = {}) {
  let state = { record: options.record ?? null, revisions: [] };
  let tail = Promise.resolve();
  const calls = [];
  let failHistory = false;
  const db = { $transaction(work) {
    const result = tail.then(async () => {
      const pending = structuredClone(state);
      const tx = {
        async $queryRawUnsafe(sql, ...values) {
          calls.push({ sql, values });
          if (/FROM "Student"/.test(sql)) return options.missingStudent ? [] : [{ name: "테스트 학생", mergedIntoStudentId: options.merged ? "merged-id" : null }];
          if (/FROM "Enrollment"/.test(sql)) return options.candidates ?? [{ classId: "class-1", className: "첫 반", status: "ACTIVE" }];
          if (/FROM "MonthlyEnrollmentRegisterRevision"/.test(sql)) return pending.revisions.slice().reverse();
          if (/FROM "MonthlyEnrollmentRegister"/.test(sql)) return pending.record ? [structuredClone(pending.record)] : [];
          if (/^(UPDATE|INSERT INTO) "MonthlyEnrollmentRegister"/.test(sql)) {
            if (sql.startsWith("UPDATE")) assert.match(sql, /WHERE id = \$1 AND "studentId" = \$2 AND month = \$3 AND version = \$8/);
            if (sql.startsWith("UPDATE") && (options.updateConflict || pending.record.version !== values[7])) return [];
            const [id, studentId, month, version, status, raw] = values;
            pending.record = { id, studentId, month, version, status, payload: JSON.parse(raw),
              updatedAt: "2026-09-04T00:00:00.000Z", confirmedAt: status === "CONFIRMED" ? "2026-09-04T00:00:00.000Z" : null };
            return [structuredClone(pending.record)];
          }
          throw new Error(`예상하지 않은 조회 ${sql}`);
        },
        async $executeRawUnsafe(sql, ...values) {
          calls.push({ sql, values });
          assert.match(sql, /INSERT INTO "MonthlyEnrollmentRegisterRevision"/);
          if (failHistory) throw new Error("fixture history failure");
          const [, registerId, studentId, month, version, status, raw, action, reason, actorUserId] = values;
          pending.revisions.push({ registerId, studentId, month, version, status, payload: JSON.parse(raw), action, reason, actorUserId,
            createdAt: "2026-09-04T00:00:00.000Z" });
          return 1;
        },
      };
      const value = await work(tx);
      state = pending;
      return value;
    });
    tail = result.catch(() => {});
    return result;
  } };
  return { db, calls, state: () => structuredClone(state), failHistory: () => { failHistory = true; } };
}
const run = (fixture, body) => service.mutateMonthlyRegister(fixture.db, body, "admin-1", true);
const errorStatus = (status) => (error) => error instanceof model.MonthlyRegisterError && error.status === status;

test("저장 기능은 기본 잠금이며 인증·잘못된 명령은 거래 전에 차단한다", async () => {
  const fixture = database();
  await assert.rejects(service.mutateMonthlyRegister(fixture.db, command(), "admin-1"), errorStatus(503));
  await assert.rejects(service.mutateMonthlyRegister(fixture.db, command(), "", true), errorStatus(403));
  for (const bad of [command("UNKNOWN"), command("SAVE_DRAFT", -1), command("SAVE_DRAFT", 2147483647), command("CONFIRM", 1, { payload: payload() }), command("SAVE_DRAFT", 0, { reason: " " }), command("SAVE_DRAFT", 0, { actorUserId: "forged" })]) {
    await assert.rejects(run(fixture, bad), errorStatus(400));
  }
  assert.equal(fixture.calls.length, 0);
});

test("SAVE→CONFIRM→REOPEN→SAVE는 버전을 올리고 서버 계산·감사 이력을 보존한다", async () => {
  const fixture = database();
  const first = await run(fixture, command());
  assert.deepEqual(first.totals, { tuitionAmount: 80000, shuttleAmount: 10000, totalAmount: 90000, rows: [{ classId: "class-1", amount: 80000 }] });
  const confirmed = await run(fixture, command("CONFIRM", 1));
  assert.equal(confirmed.status, "CONFIRMED");
  assert.ok(confirmed.confirmedAt);
  await assert.rejects(run(fixture, command("SAVE_DRAFT", 2)), errorStatus(409));
  await assert.rejects(run(fixture, command("CONFIRM", 2)), errorStatus(409));
  const reopened = await run(fixture, command("REOPEN", 2));
  assert.equal(reopened.confirmedAt, null);
  assert.equal(reopened.version, 3);
  await run(fixture, command("SAVE_DRAFT", 3));
  assert.deepEqual(fixture.state().revisions.map(row => row.action), ["SAVE_DRAFT", "CONFIRM", "REOPEN", "SAVE_DRAFT"]);
  assert.ok(fixture.state().revisions.every(row => row.actorUserId === "admin-1"));
});

test("이전 버전·없는 초안·잘못된 재열기는409, 최초 저장 경쟁은 한 번만 성공한다", async () => {
  const fixture = database();
  await assert.rejects(run(fixture, command("CONFIRM", 0)), errorStatus(409));
  await assert.rejects(run(fixture, command("REOPEN", 0)), errorStatus(409));
  const outcomes = await Promise.allSettled([run(fixture, command()), run(fixture, command())]);
  assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(row => row.status === "rejected").reason.status, 409);
  assert.equal(fixture.state().revisions.length, 1);
  await assert.rejects(run(fixture, command("REOPEN", 1)), errorStatus(409));
});

test("감사 이력 실패는 최초·기존 저장 모두 롤백한다", async () => {
  for (const existing of [false, true]) {
    const fixture = database();
    if (existing) await run(fixture, command());
    const before = fixture.state();
    fixture.failHistory();
    await assert.rejects(run(fixture, command("SAVE_DRAFT", existing ? 1 : 0)), /fixture history failure/);
    assert.deepEqual(fixture.state(), before);
  }
});

test("없는 학생·병합 이전 학생·미등록 반·확정 시 누락된 활성 반을 차단한다", async () => {
  await assert.rejects(run(database({ missingStudent: true }), command()), errorStatus(404));
  await assert.rejects(run(database({ merged: true }), command()), errorStatus(409));
  await assert.rejects(run(database({ candidates: [] }), command()), errorStatus(409));
  const fixture = database({ candidates: [{ classId: "class-1", status: "WITHDRAWN" }, { classId: "class-2", status: "PAUSED" }] });
  await run(fixture, command());
  await assert.rejects(run(fixture, command("CONFIRM", 1)), errorStatus(409));
  assert.equal(fixture.state().record.version, 1);
});

test("UPDATE의 버전 조건 실패와 저장 payload 불일치를 차단한다", async () => {
  const initial = database();
  await run(initial, command());
  const record = initial.state().record;
  await assert.rejects(run(database({ record, updateConflict: true }), command("SAVE_DRAFT", 1)), errorStatus(409));
  record.payload.studentId = "another-student";
  await assert.rejects(run(database({ record }), command("CONFIRM", 1)), errorStatus(409));
});

test("읽기는 이름 대신 학생·월 ID를 조회하며 원래 반 이력과 합계를 반환한다", async () => {
  const fixture = database();
  await run(fixture, command());
  const view = await fixture.db.$transaction(tx => service.readMonthlyRegister(tx, "student-1", "2026-09"));
  assert.equal(view.record.totals.totalAmount, 90000);
  assert.equal(view.history.length, 1);
  assert.equal(view.writesEnabled, false);
  const writeSql = fixture.calls.filter(row => /^(UPDATE|INSERT)/.test(row.sql)).map(row => row.sql).join("\n");
  assert.doesNotMatch(writeSql, /(?:UPDATE|INSERT INTO) "(?:Payment|Enrollment|PaymentInvoice)"|CREATE TABLE|ALTER TABLE/);
  assert.ok(fixture.calls.some(row => /FROM "Student".*FOR UPDATE/.test(row.sql)));
});
