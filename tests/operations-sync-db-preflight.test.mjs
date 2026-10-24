import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  REQUIRED_OPERATIONS_SYNC_COLUMNS,
  REQUIRED_OPERATIONS_SYNC_UNIQUE_KEYS,
  checkOperationsSyncColumns,
  findMissingOperationsSyncColumns,
  findOperationsSyncStructureIssues,
  main,
} from "../scripts/operations-sync-db-preflight.mjs";

const completeRows = Object.entries(REQUIRED_OPERATIONS_SYNC_COLUMNS).flatMap(([table_name, columns]) =>
  columns.map((column_name) => ({ table_name, column_name })),
);
const completeUniqueKeyRows = REQUIRED_OPERATIONS_SYNC_UNIQUE_KEYS.map(({ table, columns }) => ({
  table_name: table,
  column_names: columns,
}));
const completeRlsRows = Object.keys(REQUIRED_OPERATIONS_SYNC_COLUMNS).map((table_name) => ({
  table_name,
  rls_enabled: true,
}));

test("운영 요청과 랠리즈 출석 화면의 필수 테이블 및 컬럼을 빠짐없이 검사한다", () => {
  assert.deepEqual(findMissingOperationsSyncColumns(completeRows), []);
  const withoutSourceJson = completeRows.filter((row) =>
    !(row.table_name === "RallyzAttendanceSyncRun" && row.column_name === "sourceJson"),
  );
  assert.deepEqual(findMissingOperationsSyncColumns(withoutSourceJson), [
    { table: "RallyzAttendanceSyncRun", column: "sourceJson" },
  ]);
  assert.ok(REQUIRED_OPERATIONS_SYNC_COLUMNS.OperationsSyncAttempt.includes("processingToken"));
  assert.ok(REQUIRED_OPERATIONS_SYNC_COLUMNS.OperationsCommand.includes("notificationStatus"));
  assert.ok(REQUIRED_OPERATIONS_SYNC_COLUMNS.ParentOperationsRequestLink.includes("tokenHash"));
  assert.ok(REQUIRED_OPERATIONS_SYNC_COLUMNS.ParentOperationsRequestLink.includes("purpose"));
});

test("운영 동기화 DB 조회는 information_schema 읽기 전용 transaction만 사용한다", async () => {
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
  assert.deepEqual(await checkOperationsSyncColumns({ connectionString: "postgres://example", Client: FakeClient }), []);
  assert.equal(queries[0], "BEGIN READ ONLY");
  assert.match(queries[1], /information_schema\.columns/);
  assert.match(queries[2], /pg_catalog\.pg_index/);
  assert.match(queries[3], /relrowsecurity/);
  assert.match(queries[4], /role_table_grants/);
  assert.equal(queries[5], "ROLLBACK");
  assert.equal(queries.some((query) => /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(query)), false);
});

test("필수 고유 키 누락을 배포 차단 문제로 판정한다", () => {
  const issues = findOperationsSyncStructureIssues({
    columnRows: completeRows,
    uniqueKeyRows: completeUniqueKeyRows.filter((row) => row.table_name !== "OperationsSyncAttempt"),
    rlsRows: completeRlsRows,
    privilegeRows: [],
  });
  assert.deepEqual(issues, [{
    type: "unique-key",
    table: "OperationsSyncAttempt",
    columns: ["commandId", "target"],
  }]);
});

test("RLS 비활성화와 anon/authenticated 직접 권한을 보안 실패로 판정한다", () => {
  const issues = findOperationsSyncStructureIssues({
    columnRows: completeRows,
    uniqueKeyRows: completeUniqueKeyRows,
    rlsRows: completeRlsRows.map((row) => row.table_name === "OperationsRequest"
      ? { ...row, rls_enabled: false }
      : row),
    privilegeRows: [{ table_name: "OperationsCommand", grantee: "authenticated", privilege_type: "SELECT" }],
  });
  assert.deepEqual(issues, [
    { type: "rls", table: "OperationsRequest" },
    { type: "direct-privilege", table: "OperationsCommand", grantee: "authenticated", privilege: "SELECT" },
  ]);
});

test("운영 동기화 DB 미연결은 실패하고 명시적인 skip만 통과한다", async () => {
  assert.equal(await main([], {}), 1);
  assert.equal(await main(["--skip-db"], {}), 0);
});

test("통합 release preflight가 운영 동기화 DB 검사를 포함한다", () => {
  const source = readFileSync(new URL("../scripts/release-preflight.mjs", import.meta.url), "utf8");
  assert.match(source, /operations-sync-db-preflight\.mjs/);
  assert.match(source, /운영 동기화 DB 준비 상태/);
});

test("Vercel build는 필수 DB 검사를 모두 통과한 뒤에만 시작한다", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["build:vercel"],
    "node scripts/regular-shuttle-db-preflight.mjs && node scripts/operations-sync-db-preflight.mjs && node scripts/uniform-order-db-preflight.mjs && node scripts/kakao-parent-db-preflight.mjs && npm run build",
  );
  assert.equal(vercel.buildCommand, "npm run build:vercel");
});

test("누락 오류는 적용할 운영 동기화 migration을 정확히 안내한다", () => {
  const source = readFileSync(new URL("../scripts/operations-sync-db-preflight.mjs", import.meta.url), "utf8");
  for (const directory of [
    "20260827190000_add_parent_operations_request_links",
    "20260827223000_add_operations_sync_processing_lease",
    "20260828090000_complete_operations_sync_infrastructure",
  ]) assert.match(source, new RegExp(directory));
});
