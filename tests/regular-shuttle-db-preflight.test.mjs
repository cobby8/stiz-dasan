import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  REQUIRED_REGULAR_SHUTTLE_COLUMNS,
  checkRegularShuttleColumns,
  findMissingRegularShuttleColumns,
  main,
} from "../scripts/regular-shuttle-db-preflight.mjs";

const completeRows = Object.entries(REQUIRED_REGULAR_SHUTTLE_COLUMNS).flatMap(([table_name, columns]) =>
  columns.map((column_name) => ({ table_name, column_name })),
);

test("정규 셔틀 화면이 사용하는 serviceMonth와 studentId 등 필수 컬럼을 검사한다", () => {
  assert.deepEqual(findMissingRegularShuttleColumns(completeRows), []);
  const withoutStudentId = completeRows.filter((row) => !(row.table_name === "RegularShuttleStop" && row.column_name === "studentId"));
  assert.deepEqual(findMissingRegularShuttleColumns(withoutStudentId), [{ table: "RegularShuttleStop", column: "studentId" }]);
  assert.ok(REQUIRED_REGULAR_SHUTTLE_COLUMNS.RegularShuttleStop.includes("serviceMonth"));
  assert.ok(REQUIRED_REGULAR_SHUTTLE_COLUMNS.RegularDispatchRoute.includes("serviceMonth"));
  for (const column of ["stopName", "classTime", "arriveTime", "sortOrder", "studentPhone", "parentPhone"]) {
    assert.ok(REQUIRED_REGULAR_SHUTTLE_COLUMNS.RegularShuttleStop.includes(column), `Stop.${column}`);
  }
  for (const column of ["classStart", "classEnd", "updatedAt"]) {
    assert.ok(REQUIRED_REGULAR_SHUTTLE_COLUMNS.RegularDispatchRoute.includes(column), `Route.${column}`);
  }
});

test("DB 구조 조회는 information_schema 읽기 전용 transaction만 사용한다", async () => {
  const queries = [];
  class FakeClient {
    async connect() {}
    async query(sql) {
      queries.push(String(sql));
      if (String(sql).includes("information_schema.columns")) return { rows: completeRows };
      return { rows: [] };
    }
    async end() {}
  }
  assert.deepEqual(await checkRegularShuttleColumns({ connectionString: "postgres://example", Client: FakeClient }), []);
  assert.equal(queries[0], "BEGIN READ ONLY");
  assert.match(queries[1], /information_schema\.columns/);
  assert.equal(queries[2], "ROLLBACK");
  assert.equal(queries.some((query) => /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(query)), false);
});

test("DB 미연결은 실패하고 명시적인 skip만 통과한다", async () => {
  assert.equal(await main([], {}), 1);
  assert.equal(await main(["--skip-db"], {}), 0);
});

test("통합 release preflight가 정규 셔틀 DB 검사를 포함한다", () => {
  const source = readFileSync(new URL("../scripts/release-preflight.mjs", import.meta.url), "utf8");
  assert.match(source, /regular-shuttle-db-preflight\.mjs/);
  assert.match(source, /정규 셔틀 DB 준비 상태/);
});

test("Vercel 실제 build는 필수 DB 검사 성공 후 기존 build를 실행한다", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["build:vercel"], "node scripts/regular-shuttle-db-preflight.mjs && node scripts/operations-sync-db-preflight.mjs && node scripts/uniform-order-db-preflight.mjs && node scripts/kakao-parent-db-preflight.mjs && npm run build");
  assert.equal(vercel.buildCommand, "npm run build:vercel");
  assert.equal(packageJson.scripts.build, "prisma generate && next build --webpack");
});

test("누락 오류는 적용할 migration 디렉터리 전체 이름을 정확히 안내한다", () => {
  const source = readFileSync(new URL("../scripts/regular-shuttle-db-preflight.mjs", import.meta.url), "utf8");
  for (const directory of [
    "20260727120000_add_regular_shuttle_stop",
    "20260727120000_add_regular_dispatch_route",
    "20260826193000_add_regular_shuttle_month",
    "20260827223000_add_regular_shuttle_student_identity",
  ]) assert.match(source, new RegExp(directory));
});
