import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  REQUIRED_UNIFORM_ORDER_COLUMNS,
  REQUIRED_UNIFORM_ORDER_UNIQUE_KEYS,
  checkUniformOrderTables,
  findMissingUniformOrderColumns,
  findUniformOrderStructureIssues,
  main,
} from "../scripts/uniform-order-db-preflight.mjs";

const completeRows = Object.entries(REQUIRED_UNIFORM_ORDER_COLUMNS).flatMap(([table_name, columns]) =>
  columns.map((column_name) => ({ table_name, column_name })),
);
const completeUniqueKeyRows = REQUIRED_UNIFORM_ORDER_UNIQUE_KEYS.map(({ table, columns }) => ({
  table_name: table,
  column_names: columns,
}));
const completeRlsRows = Object.keys(REQUIRED_UNIFORM_ORDER_COLUMNS).map((table_name) => ({
  table_name,
  rls_enabled: true,
}));

test("유니폼 주문 화면과 본사 전송이 사용하는 필수 컬럼을 검사한다", () => {
  assert.deepEqual(findMissingUniformOrderColumns(completeRows), []);
  const withoutPartnerRequestId = completeRows.filter((row) =>
    !(row.table_name === "UniformOrder" && row.column_name === "partnerRequestId"),
  );
  assert.deepEqual(findMissingUniformOrderColumns(withoutPartnerRequestId), [
    { table: "UniformOrder", column: "partnerRequestId" },
  ]);
  assert.ok(REQUIRED_UNIFORM_ORDER_COLUMNS.UniformOrder.includes("stizSyncStatus"));
  assert.ok(REQUIRED_UNIFORM_ORDER_COLUMNS.UniformOrderItem.includes("design"));
  assert.ok(REQUIRED_UNIFORM_ORDER_COLUMNS.UniformOrderItem.includes("initials"));
  assert.ok(REQUIRED_UNIFORM_ORDER_COLUMNS.UniformOrderItem.includes("topSize"));
  assert.ok(REQUIRED_UNIFORM_ORDER_COLUMNS.UniformOrderItem.includes("bottomSize"));
});

test("유니폼 주문 DB 조회는 읽기 전용 transaction만 사용한다", async () => {
  const queries = [];
  class FakeClient {
    async connect() {}
    async query(sql) {
      queries.push(String(sql));
      if (String(sql).includes("information_schema.columns")) return { rows: completeRows };
      if (String(sql).includes("pg_catalog.pg_index")) return { rows: completeUniqueKeyRows };
      if (String(sql).includes("relrowsecurity")) return { rows: completeRlsRows };
      if (String(sql).includes("role_table_grants")) return { rows: [] };
      return { rows: [] };
    }
    async end() {}
  }

  assert.deepEqual(await checkUniformOrderTables({ connectionString: "postgres://example", Client: FakeClient }), []);
  assert.equal(queries[0], "BEGIN READ ONLY");
  assert.match(queries[1], /information_schema\.columns/);
  assert.match(queries[2], /pg_catalog\.pg_index/);
  assert.match(queries[3], /relrowsecurity/);
  assert.match(queries[4], /role_table_grants/);
  assert.equal(queries[5], "ROLLBACK");
  assert.equal(queries.some((query) => /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(query)), false);
});

test("유니폼 주문 고유 키와 RLS, 직접 권한 누락을 배포 차단 문제로 판정한다", () => {
  const issues = findUniformOrderStructureIssues({
    columnRows: completeRows,
    uniqueKeyRows: [],
    rlsRows: completeRlsRows.map((row) => row.table_name === "UniformOrderItem"
      ? { ...row, rls_enabled: false }
      : row),
    privilegeRows: [{ table_name: "UniformOrder", grantee: "authenticated", privilege_type: "SELECT" }],
  });
  assert.deepEqual(issues, [
    { type: "unique-key", table: "UniformOrder", columns: ["partnerRequestId"] },
    { type: "rls", table: "UniformOrderItem" },
    { type: "direct-privilege", table: "UniformOrder", grantee: "authenticated", privilege: "SELECT" },
  ]);
});

test("유니폼 주문 DB 미연결은 실패하고 명시적인 skip만 통과한다", async () => {
  assert.equal(await main([], {}), 1);
  assert.equal(await main(["--skip-db"], {}), 0);
});

test("릴리스 검사와 Vercel build가 유니폼 주문 DB 검사를 포함한다", () => {
  const releaseSource = readFileSync(new URL("../scripts/release-preflight.mjs", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.match(releaseSource, /uniform-order-db-preflight\.mjs/);
  assert.match(releaseSource, /유니폼 주문 DB 준비 상태/);
  assert.match(releaseSource, /STIZ_PARTNER_SECRET/);
  assert.match(releaseSource, /64자 hex/);
  assert.doesNotMatch(releaseSource, /console\.(?:log|error)\([^)]*STIZ_PARTNER_SECRET[^)]*process\.env/);
  assert.match(packageJson.scripts["build:vercel"], /uniform-order-db-preflight\.mjs/);
});

test("유니폼 주문 migration은 RLS와 직접 권한 차단, 접수번호 고유키를 적용한다", () => {
  const migration = readFileSync(new URL("../prisma/migrations/20260831130000_add_uniform_partner_orders/migration.sql", import.meta.url), "utf8");
  for (const table of Object.keys(REQUIRED_UNIFORM_ORDER_COLUMNS)) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON "${table}" FROM anon, authenticated;`));
  }
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS "UniformOrder_partnerRequestId_key"/);
});
