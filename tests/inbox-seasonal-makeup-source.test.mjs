import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

function setup(resolution) {
  const writes = [];
  const transactionQueries = [];
  const source = ts.transpileModule(readFileSync(new URL("../src/lib/seasonal/makeup.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const deps = {
    "node:crypto": { randomUUID: () => "synthetic-makeup" },
    "@/lib/seasonal/makeup-capacity": {},
    "@/lib/seasonal/makeupWindow": {},
    "@/lib/studentVisibility": {},
    "@/lib/prisma": { prisma: {
      $queryRawUnsafe: async (sql) => {
        if (sql.includes('FROM "SpecialProgramEnrollmentDate" e')) {
          return [{ applicationItemId: "item", absentSessionDateId: "original", offeringId: "offering" }];
        }
        if (sql.includes('FROM "SpecialProgramMakeup"')) return [];
        throw new Error("Unexpected preparation query");
      },
      $executeRawUnsafe: async () => { writes.push("legacy insert"); },
      $transaction: async (run) => run({
        $queryRawUnsafe: async (sql, ...params) => {
          transactionQueries.push(sql);
          if (sql.includes('FROM "SpecialProgramAbsence"')) {
            assert.match(sql, /"enrollmentDateId" = \$2 AND status = 'CONFIRMED' AND resolution = 'MAKEUP'\s+FOR UPDATE/);
            assert.deepEqual(params, ["selected-absence", "selected-seat"]);
            return resolution === "MAKEUP" ? [{ id: "selected-absence" }] : [];
          }
          if (sql.includes('FROM "SpecialProgramMakeup"')) return [];
          throw new Error("Unexpected transaction query");
        },
        $executeRawUnsafe: async (sql) => {
          assert.match(sql, /INSERT INTO "SpecialProgramMakeup"/);
          writes.push("guarded insert");
        },
      }),
    } },
  };
  const exports = {};
  new Function("require", "exports", source)(id => {
    assert.ok(Object.hasOwn(deps, id), id);
    return deps[id];
  }, exports);
  const input = { enrollmentDateId: "selected-seat", targetType: "REGULAR", targetClassId: "class" };
  return { createMakeup: exports.createMakeup, writes, transactionQueries, input };
}

test("신청함 보강 배정 직전에 결석이 환불로 바뀌면 저장하지 않는다", async () => {
  const { createMakeup, writes, transactionQueries, input } = setup("REFUND");
  await assert.rejects(() => createMakeup({ ...input, sourceAbsenceId: "selected-absence" }), /MAKEUP_SOURCE_CONFLICT/);
  assert.deepEqual(writes, []);
  assert.equal(transactionQueries.length, 1);
});

test("신청함 보강 배정은 같은 거래에서 대상 결석 확인 후 저장한다", async () => {
  const { createMakeup, writes, transactionQueries, input } = setup("MAKEUP");
  assert.equal((await createMakeup({ ...input, sourceAbsenceId: "selected-absence" })).status, "SCHEDULED");
  assert.deepEqual(writes, ["guarded insert"]);
  assert.equal(transactionQueries.length, 2);
});

test("기존 보강 등록 경로는 신청함 결석 기록을 요구하지 않는다", async () => {
  const { createMakeup, writes, transactionQueries, input } = setup("REFUND");
  assert.equal((await createMakeup(input)).status, "SCHEDULED");
  assert.deepEqual(writes, ["legacy insert"]);
  assert.deepEqual(transactionQueries, []);
});
