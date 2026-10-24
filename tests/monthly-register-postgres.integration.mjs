import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";

// 환경변수·DB URL을 읽지 않는다. 실행기는 격리된 로컬 DB 연결만 전달해야 한다.
function loadTypeScript(relativePath, dependencies = {}) {
  const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  const exports = {};
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  new Function("require", "exports", js)((id) => {
    if (!Object.hasOwn(dependencies, id)) throw new Error("UNEXPECTED_TEST_DEPENDENCY");
    return dependencies[id];
  }, exports);
  return exports;
}

const model = loadTypeScript("../src/lib/billing/monthly-register.ts");
const service = loadTypeScript("../src/lib/billing/monthly-register-service.ts", {
  "node:crypto": crypto,
  "./monthly-register": model,
});
const month = "2026-09";
const actor = "synthetic-admin";
const expectedServiceStatus = (status) => (error) => error instanceof model.MonthlyRegisterError && error.status === status;
const expectedSqlState = (code) => (error) => error?.code === code;

function draft(studentId, changes = {}) {
  return {
    studentId, month,
    classes: ["class-1", "class-2"].map((classId) => ({
      classId, status: "ACTIVE", periodStart: "2026-09-01", periodEnd: "2026-09-30",
      baseAmount: 100000, discountAmount: 10000, carryAmount: 5000, prorationAmount: 5000,
      basis: "합성 테스트 금액 근거",
    })),
    shuttleAmount: 10000, shuttleBasis: "학생 월 단위 한 번", reason: "합성 테스트 저장", ...changes,
  };
}

function command(studentId, action = "SAVE_DRAFT", expectedVersion = 0, changes = {}) {
  const payload = draft(studentId, changes);
  return {
    studentId, month: payload.month, action, expectedVersion, reason: payload.reason,
    ...(action === "SAVE_DRAFT" ? { payload } : {}),
  };
}

function sqlAdapter(client) {
  return {
    async $queryRawUnsafe(sql, ...values) { return (await client.query(sql, values)).rows; },
    async $executeRawUnsafe(sql, ...values) { return (await client.query(sql, values)).rowCount ?? 0; },
  };
}

// 각 직접 SQL 시험은 독립된 거래에서 실행하고 성공·실패 모두 롤백한다.
async function rollbackTransaction(pool, work, role = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL statement_timeout = '8s'");
    if (role) {
      assert.ok(["anon", "authenticated", "service_role"].includes(role));
      await client.query(`SET LOCAL ROLE ${role}`);
    }
    return await work(client);
  } finally {
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  }
}

const insertRegisterSql = `INSERT INTO "MonthlyEnrollmentRegister"
  (id, "studentId", month, version, status, payload, "updatedBy", "confirmedAt")
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`;
function registerValues(studentId = "student-4", options = {}) {
  const payload = options.payload ?? draft(studentId, { month: options.month ?? month });
  return [crypto.randomUUID(), studentId, options.month ?? month, options.version ?? 1,
    options.status ?? "DRAFT", JSON.stringify(payload), actor, options.confirmedAt ?? null];
}

/** 운영 연결 없이 PM이 준비한 loopback 임시 PostgreSQL에서만 실행한다. */
export async function runMonthlyRegisterPostgresTests({ pool, database }) {
  const checks = [];
  async function check(name, work) {
    try { await work(); }
    catch (error) {
      // DB 드라이버의 detail/query/접속 문자열이나 payload를 상위 로그에 전달하지 않는다.
      const sqlState = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : "NONE";
      throw new Error(`월 장부 PostgreSQL 검증 실패: ${name}; SQLSTATE=${sqlState}`);
    }
    checks.push(name);
  }
  const save = (studentId, action = "SAVE_DRAFT", version = 0, changes = {}, db = database) =>
    service.mutateMonthlyRegister(db, command(studentId, action, version, changes), actor, true);
  const snapshot = async (studentId, targetMonth = month) => {
    const record = await pool.query(`SELECT * FROM "MonthlyEnrollmentRegister" WHERE "studentId"=$1 AND month=$2`, [studentId, targetMonth]);
    const history = await pool.query(`SELECT * FROM "MonthlyEnrollmentRegisterRevision" WHERE "studentId"=$1 AND month=$2 ORDER BY version`, [studentId, targetMonth]);
    return { records: record.rows, history: history.rows };
  };

  await check("로컬 loopback55432 임시 전용 DB와 빈 장부 확인", async () => {
    const identity = await pool.query(`SELECT current_database() AS name, host(inet_server_addr()) AS address, inet_server_port() AS port`);
    assert.ok(["127.0.0.1", "::1"].includes(identity.rows[0].address));
    assert.equal(identity.rows[0].port, 55432);
    assert.match(identity.rows[0].name, /^stiz_monthly_register_test(?:_[a-z0-9_]+)?$/);
    const existing = await pool.query(`SELECT (SELECT COUNT(*) FROM "MonthlyEnrollmentRegister")::int AS registers,
      (SELECT COUNT(*) FROM "MonthlyEnrollmentRegisterRevision")::int AS revisions`);
    assert.deepEqual(existing.rows[0], { registers: 0, revisions: 0 });
  });

  await check("실제 SAVE와 재조회: 두 반 합계·월 셔틀 한 번·감사 actor", async () => {
    const saved = await save("student-1");
    assert.equal(saved.version, 1);
    assert.equal(saved.status, "DRAFT");
    assert.deepEqual(saved.totals, { tuitionAmount: 160000, shuttleAmount: 10000, totalAmount: 170000,
      rows: [{ classId: "class-1", amount: 80000 }, { classId: "class-2", amount: 80000 }] });
    const stored = await snapshot("student-1");
    assert.equal(stored.records.length, 1);
    assert.equal(stored.history.length, 1);
    assert.equal(stored.history[0].actorUserId, actor);
    assert.deepEqual(stored.history[0].payload, stored.records[0].payload);
    const read = await database.$transaction(tx => service.readMonthlyRegister(tx, "student-1", month));
    assert.equal(read.record.totals.totalAmount, 170000);
    assert.equal(read.history[0].version, 1);
    assert.equal(read.writesEnabled, false);
  });

  await check("실제 CONFIRM 잠금·REOPEN·SAVE 및 버전별 이력 보존", async () => {
    const confirmed = await save("student-1", "CONFIRM", 1);
    assert.equal(confirmed.status, "CONFIRMED");
    assert.ok(confirmed.confirmedAt);
    await assert.rejects(save("student-1", "SAVE_DRAFT", 2), expectedServiceStatus(409));
    await assert.rejects(save("student-1", "CONFIRM", 2), expectedServiceStatus(409));
    const reopened = await save("student-1", "REOPEN", 2);
    assert.equal(reopened.version, 3);
    assert.equal(reopened.confirmedAt, null);
    await save("student-1", "SAVE_DRAFT", 3, { reason: "합성 테스트 수정" });
    const stored = await snapshot("student-1");
    assert.deepEqual(stored.history.map(row => row.version), [1, 2, 3, 4]);
    assert.deepEqual(stored.history.map(row => row.action), ["SAVE_DRAFT", "CONFIRM", "REOPEN", "SAVE_DRAFT"]);
    assert.equal(stored.history[0].payload.reason, "합성 테스트 저장");
    assert.equal(stored.history[3].payload.reason, "합성 테스트 수정");
  });

  const failingHistoryDatabase = { $transaction: (work) => database.$transaction(tx => work({
    $queryRawUnsafe: (sql, ...values) => tx.$queryRawUnsafe(sql, ...values),
    $executeRawUnsafe: (sql, ...values) => {
      if (/INSERT INTO "MonthlyEnrollmentRegisterRevision"/.test(sql)) throw new Error("SYNTHETIC_HISTORY_FAILURE");
      return tx.$executeRawUnsafe(sql, ...values);
    },
  })) };
  await check("감사 INSERT 직전 실패: 최초 장부 실제 롤백", async () => {
    await assert.rejects(save("student-2", "SAVE_DRAFT", 0, {}, failingHistoryDatabase), /SYNTHETIC_HISTORY_FAILURE/);
    assert.deepEqual(await snapshot("student-2"), { records: [], history: [] });
    await save("student-2");
  });
  await check("감사 INSERT 직전 실패: 기존 버전 실제 롤백과 재시도", async () => {
    const before = await snapshot("student-2");
    await assert.rejects(save("student-2", "SAVE_DRAFT", 1, { reason: "롤백 대상" }, failingHistoryDatabase), /SYNTHETIC_HISTORY_FAILURE/);
    assert.deepEqual(await snapshot("student-2"), before);
    const retried = await save("student-2", "SAVE_DRAFT", 1, { reason: "재시도 확인" });
    assert.equal(retried.version, 2);
  });

  async function oneConflict(outcomes) {
    assert.equal(outcomes.filter(row => row.status === "fulfilled").length, 1);
    const failures = outcomes.filter(row => row.status === "rejected");
    assert.equal(failures.length, 1);
    assert.ok(expectedServiceStatus(409)(failures[0].reason));
  }
  await check("별도 실제 연결의 최초 저장 경쟁: 한 성공·한409", async () => {
    await oneConflict(await Promise.allSettled([save("student-3"), save("student-3")]));
    const stored = await snapshot("student-3");
    assert.equal(stored.records.length, 1);
    assert.equal(stored.records[0].version, 1);
    assert.equal(stored.history.length, 1);
  });
  await check("별도 실제 연결의 기존 버전 수정 경쟁: 한 성공·한409", async () => {
    await oneConflict(await Promise.allSettled([
      save("student-3", "SAVE_DRAFT", 1, { reason: "경쟁 A" }),
      save("student-3", "SAVE_DRAFT", 1, { reason: "경쟁 B" }),
    ]));
    const stored = await snapshot("student-3");
    assert.equal(stored.records[0].version, 2);
    assert.equal(stored.history.length, 2);
  });

  await check("없는 학생·병합 학생·미등록 반 거절과 데이터 무변경", async () => {
    await assert.rejects(save("student-missing"), expectedServiceStatus(404));
    await assert.rejects(save("student-merged"), expectedServiceStatus(409));
    await assert.rejects(save("student-4", "SAVE_DRAFT", 0, { classes: [{ ...draft("student-4").classes[0], classId: "class-missing" }] }), expectedServiceStatus(409));
    assert.deepEqual(await snapshot("student-4"), { records: [], history: [] });
  });
  await check("반 누락 초안은 가능하지만 확정 시 누락된 활성 반 차단", async () => {
    await save("student-4", "SAVE_DRAFT", 0, { classes: [draft("student-4").classes[0]] });
    await assert.rejects(save("student-4", "CONFIRM", 1), expectedServiceStatus(409));
    const stored = await snapshot("student-4");
    assert.equal(stored.records[0].status, "DRAFT");
    assert.equal(stored.records[0].version, 1);
    assert.equal(stored.history.length, 1);
  });
  await check("금액 오류·기본off·임의 CONFIRM payload 거절은 데이터 불변", async () => {
    const before = await snapshot("student-4");
    for (const patch of [{ baseAmount: -1 }, { baseAmount: 1.5 }, { discountAmount: 200000 }, { status: "PAUSED" }]) {
      const classes = draft("student-4").classes;
      Object.assign(classes[0], patch);
      await assert.rejects(save("student-4", "SAVE_DRAFT", 1, { classes }), expectedServiceStatus(400));
    }
    await assert.rejects(service.mutateMonthlyRegister(database, command("student-4", "SAVE_DRAFT", 1), actor), expectedServiceStatus(503));
    await assert.rejects(service.mutateMonthlyRegister(database, { ...command("student-4", "CONFIRM", 1), payload: draft("student-4") }, actor, true), expectedServiceStatus(400));
    assert.deepEqual(await snapshot("student-4"), before);
  });

  for (const role of ["anon", "authenticated"]) {
    for (const table of ["MonthlyEnrollmentRegister", "MonthlyEnrollmentRegisterRevision"]) {
      await check(`${role} ${table} 직접 SELECT 차단`, async () => {
        await assert.rejects(rollbackTransaction(pool, client => client.query(`SELECT id FROM "${table}" LIMIT 1`), role), expectedSqlState("42501"));
      });
      await check(`${role} ${table} 직접 INSERT 차단`, async () => {
        await assert.rejects(rollbackTransaction(pool, client => client.query(`INSERT INTO "${table}" DEFAULT VALUES`), role), expectedSqlState("42501"));
      });
    }
  }
  await check("두 신규 테이블 RLS 활성화 확인", async () => {
    const result = await pool.query(`SELECT relname, relrowsecurity FROM pg_class
      WHERE oid IN ('"MonthlyEnrollmentRegister"'::regclass, '"MonthlyEnrollmentRegisterRevision"'::regclass)
      ORDER BY relname`);
    assert.equal(result.rows.length, 2);
    assert.ok(result.rows.every(row => row.relrowsecurity === true));
  });
  for (const verb of ["UPDATE", "DELETE", "TRUNCATE"]) {
    await check(`service_role 감사 이력 ${verb} 차단`, async () => {
      const sql = verb === "UPDATE" ? `UPDATE "MonthlyEnrollmentRegisterRevision" SET reason = 'forbidden'`
        : verb === "DELETE" ? `DELETE FROM "MonthlyEnrollmentRegisterRevision"` : `TRUNCATE "MonthlyEnrollmentRegisterRevision"`;
      await assert.rejects(rollbackTransaction(pool, client => client.query(sql), "service_role"), expectedSqlState("42501"));
    });
  }
  await check("service_role 실제 서비스 SAVE·CONFIRM 및 감사 INSERT 허용", async () => {
    const roleDatabase = { $transaction: work => database.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE service_role");
      return work(tx);
    }) };
    const record = await save("student-4", "SAVE_DRAFT", 1, {}, roleDatabase);
    assert.equal(record.version, 2);
    const confirmed = await save("student-4", "CONFIRM", 2, {}, roleDatabase);
    assert.equal(confirmed.status, "CONFIRMED");
    assert.equal((await snapshot("student-4")).history.length, 3);
  });

  await check("READ ONLY 거래는 실제 서비스 조회 허용·실제 INSERT 차단", async () => {
    await assert.rejects(rollbackTransaction(pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const view = await service.readMonthlyRegister(sqlAdapter(client), "student-1", month);
      assert.equal(view.record.version, 4);
      await client.query(insertRegisterSql, registerValues());
    }), expectedSqlState("25006"));
  });

  await check("학생·월 중복은 DB 고유키로 차단", async () => {
    await assert.rejects(rollbackTransaction(pool, client => client.query(insertRegisterSql, registerValues("student-1"))), expectedSqlState("23505"));
  });
  for (const [name, options] of [
    ["0 버전", { version: 0 }], ["잘못된 월", { month: "2026-13" }],
    ["잘못된 상태", { status: "OTHER" }], ["확정 시각 없는 확정", { status: "CONFIRMED" }],
    ["학생과 다른 payload", { payload: draft("student-2") }],
    ["필수키 없는 payload", { payload: {} }],
    ["배열 아닌 classes", { payload: { ...draft("student-4"), classes: {} } }],
  ]) {
    await check(`DB CHECK ${name} 거절`, async () => {
      await assert.rejects(rollbackTransaction(pool, client => client.query(insertRegisterSql, registerValues("student-4", options))), expectedSqlState("23514"));
    });
  }
  await check("감사 원장 없는 registerId는 실제 FK 차단", async () => {
    await assert.rejects(rollbackTransaction(pool, client => client.query(`INSERT INTO "MonthlyEnrollmentRegisterRevision"
      (id, "registerId", "studentId", month, version, status, payload, action, reason, "actorUserId")
      VALUES ($1,$2,$3,$4,1,'DRAFT',$5::jsonb,'SAVE_DRAFT','합성 외래키 테스트',$6)`,
    [crypto.randomUUID(), "missing-register-id", "student-1", month, JSON.stringify(draft("student-1")), actor])), expectedSqlState("23503"));
  });
  await check("감사 동일 register·version 중복은 고유키 차단", async () => {
    const stored = await snapshot("student-1");
    await assert.rejects(rollbackTransaction(pool, client => client.query(`INSERT INTO "MonthlyEnrollmentRegisterRevision"
      (id, "registerId", "studentId", month, version, status, payload, action, reason, "actorUserId")
      VALUES ($1,$2,$3,$4,1,'DRAFT',$5::jsonb,'SAVE_DRAFT','합성 중복 테스트',$6)`,
    [crypto.randomUUID(), stored.records[0].id, "student-1", month, JSON.stringify(draft("student-1")), actor])), expectedSqlState("23505"));
  });
  await check("시험 후 합성 장부·이력 개수와 버전 연속성 재확인", async () => {
    const result = await pool.query(`SELECT r."studentId", r.version, COUNT(h.id)::int AS revisions,
      MIN(h.version)::int AS first, MAX(h.version)::int AS last
      FROM "MonthlyEnrollmentRegister" r JOIN "MonthlyEnrollmentRegisterRevision" h ON h."registerId"=r.id
      GROUP BY r.id, r."studentId", r.version ORDER BY r."studentId"`);
    assert.deepEqual(result.rows, [
      { studentId: "student-1", version: 4, revisions: 4, first: 1, last: 4 },
      { studentId: "student-2", version: 2, revisions: 2, first: 1, last: 2 },
      { studentId: "student-3", version: 2, revisions: 2, first: 1, last: 2 },
      { studentId: "student-4", version: 3, revisions: 3, first: 1, last: 3 },
    ]);
  });
  return { passed: checks.length, checks };
}
