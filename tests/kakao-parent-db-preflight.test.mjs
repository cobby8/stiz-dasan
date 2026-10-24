import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  REQUIRED_KAKAO_PARENT_COLUMNS,
  REQUIRED_KAKAO_PARENT_FOREIGN_KEYS,
  REQUIRED_KAKAO_PARENT_UNIQUE_KEYS,
  checkKakaoParentTables,
  findKakaoParentStructureIssues,
  main,
} from "../scripts/kakao-parent-db-preflight.mjs";

const columns = Object.entries(REQUIRED_KAKAO_PARENT_COLUMNS).flatMap(([table_name, names]) =>
  names.map((column_name) => ({ table_name, column_name })),
);
const uniqueKeys = REQUIRED_KAKAO_PARENT_UNIQUE_KEYS.map(({ table, columns: column_names }) => ({ table_name: table, column_names }));
const foreignKeys = REQUIRED_KAKAO_PARENT_FOREIGN_KEYS.map((item) => ({
  table_name: item.table,
  column_names: item.columns,
  foreign_table_name: item.foreignTable,
  foreign_column_names: item.foreignColumns,
}));
const rls = Object.keys(REQUIRED_KAKAO_PARENT_COLUMNS).map((table_name) => ({ table_name, rls_enabled: true }));

test("카카오 학부모 접수 구조와 보안 누락을 찾는다", () => {
  assert.deepEqual(findKakaoParentStructureIssues({ columnRows: columns, uniqueKeyRows: uniqueKeys, foreignKeyRows: foreignKeys, rlsRows: rls, privilegeRows: [] }), []);
  const issues = findKakaoParentStructureIssues({
    columnRows: columns.filter((row) => row.column_name !== "sourceText"),
    uniqueKeyRows: uniqueKeys.slice(1),
    foreignKeyRows: foreignKeys.slice(1),
    rlsRows: rls.map((row) => row.table_name === "KakaoParentIntake" ? { ...row, rls_enabled: false } : row),
    privilegeRows: [{ table_name: "KakaoParentIdentity", grantee: "authenticated", privilege_type: "SELECT" }],
  });
  assert.ok(issues.some((issue) => issue.column === "sourceText"));
  assert.ok(issues.some((issue) => issue.type === "unique-key"));
  assert.ok(issues.some((issue) => issue.type === "foreign-key"));
  assert.ok(issues.some((issue) => issue.type === "rls"));
  assert.ok(issues.some((issue) => issue.type === "direct-privilege"));
  assert.ok(REQUIRED_KAKAO_PARENT_COLUMNS.KakaoParentIntake.includes("providerRequestId"));
  assert.ok(REQUIRED_KAKAO_PARENT_UNIQUE_KEYS.some((key) =>
    key.table === "KakaoParentIntake" && key.columns.join(",") === "identityId,providerRequestId"));
});

test("카카오 DB 검사는 읽기 전용 transaction만 사용한다", async () => {
  const queries = [];
  class FakeClient {
    async connect() {}
    async query(sql) {
      queries.push(String(sql));
      if (String(sql).includes("information_schema.columns")) return { rows: columns };
      if (String(sql).includes("pg_catalog.pg_index")) return { rows: uniqueKeys };
      if (String(sql).includes("pg_catalog.pg_constraint")) return { rows: foreignKeys };
      if (String(sql).includes("relrowsecurity")) return { rows: rls };
      if (String(sql).includes("role_table_grants")) return { rows: [] };
      return { rows: [] };
    }
    async end() {}
  }
  assert.deepEqual(await checkKakaoParentTables({ connectionString: "postgres://example", Client: FakeClient }), []);
  assert.equal(queries[0], "BEGIN READ ONLY");
  assert.equal(queries.at(-1), "ROLLBACK");
  assert.equal(queries.some((query) => /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(query)), false);
});

test("DB 미연결은 실패하고 명시적인 skip만 통과한다", async () => {
  assert.equal(await main([], {}), 1);
  assert.equal(await main(["--skip-db"], {}), 0);
});

test("Vercel 빌드와 접수함이 카카오 DB 미준비를 안전하게 처리한다", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const releaseSource = readFileSync(new URL("../scripts/release-preflight.mjs", import.meta.url), "utf8");
  const page = readFileSync(new URL("../src/app/admin/kakao-requests/page.tsx", import.meta.url), "utf8");
  assert.match(packageJson.scripts["build:vercel"], /kakao-parent-db-preflight\.mjs/);
  assert.match(releaseSource, /카카오 학부모 접수 DB 준비 상태/);
  assert.match(page, /42P01/);
  assert.match(page, /42703/);
  assert.match(page, /카카오 접수함 DB 준비가 필요합니다/);
  assert.match(page, /if \(!isKakaoSchemaNotReady\(error\)\) throw error/);
});
