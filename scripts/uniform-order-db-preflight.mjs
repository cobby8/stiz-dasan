import { pathToFileURL } from "node:url";
import pg from "pg";

export const REQUIRED_UNIFORM_ORDER_COLUMNS = {
  UniformOrder: [
    "id", "partnerRequestId", "parentName", "parentPhone", "parentPhoneDigits", "customerMemo",
    "itemSignature", "orderStatus", "stizSyncStatus", "stizOrderNumber", "stizDuplicate",
    "stizMessage", "sendAttempts", "nextRetryAt", "lastError", "lastSentAt", "createdAt", "updatedAt",
  ],
  UniformOrderItem: [
    "id", "uniformOrderId", "studentName", "design", "initials",
    "backNumber", "topSize", "bottomSize", "quantity", "createdAt",
  ],
};

export const REQUIRED_UNIFORM_ORDER_UNIQUE_KEYS = [
  { table: "UniformOrder", columns: ["partnerRequestId"] },
];

export function findMissingUniformOrderColumns(rows) {
  const existing = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  return Object.entries(REQUIRED_UNIFORM_ORDER_COLUMNS).flatMap(([table, columns]) =>
    columns.filter((column) => !existing.has(`${table}.${column}`)).map((column) => ({ table, column })),
  );
}

export function findUniformOrderStructureIssues({ columnRows, uniqueKeyRows, rlsRows, privilegeRows }) {
  const issues = findMissingUniformOrderColumns(columnRows);
  const existingUniqueKeys = new Set(uniqueKeyRows.map((row) =>
    `${row.table_name}.${Array.isArray(row.column_names) ? row.column_names.join(",") : row.column_names}`,
  ));

  for (const requirement of REQUIRED_UNIFORM_ORDER_UNIQUE_KEYS) {
    const key = `${requirement.table}.${requirement.columns.join(",")}`;
    if (!existingUniqueKeys.has(key)) {
      issues.push({
        type: "unique-key",
        table: requirement.table,
        columns: requirement.columns,
      });
    }
  }

  const rlsByTable = new Map(rlsRows.map((row) => [row.table_name, row.rls_enabled]));
  for (const table of Object.keys(REQUIRED_UNIFORM_ORDER_COLUMNS)) {
    if (rlsByTable.get(table) !== true) issues.push({ type: "rls", table });
  }

  for (const row of privilegeRows) {
    issues.push({
      type: "direct-privilege",
      table: row.table_name,
      grantee: row.grantee,
      privilege: row.privilege_type,
    });
  }

  return issues;
}

export async function checkUniformOrderTables({ connectionString, Client = pg.Client }) {
  if (!connectionString?.trim()) throw new Error("DIRECT_URL 또는 DATABASE_URL이 없습니다.");

  const client = new Client({
    connectionString,
    application_name: "stiz-uniform-order-release-preflight",
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
  });

  try {
    await client.connect();
    // 배포 전 구조와 보안 설정만 읽고 운영 데이터는 변경하지 않는다.
    await client.query("BEGIN READ ONLY");
    const columns = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])`,
      [Object.keys(REQUIRED_UNIFORM_ORDER_COLUMNS)],
    );
    const uniqueKeys = await client.query(
      `SELECT c.relname AS table_name,
              array_agg(a.attname ORDER BY key_column.ordinality)::text[] AS column_names
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = key_column.attnum
        WHERE n.nspname = current_schema()
          AND c.relname = ANY($1::text[])
          AND i.indisunique = TRUE
          AND key_column.ordinality <= i.indnkeyatts
        GROUP BY c.relname, i.indexrelid`,
      [Object.keys(REQUIRED_UNIFORM_ORDER_COLUMNS)],
    );
    const rls = await client.query(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = ANY($1::text[])`,
      [Object.keys(REQUIRED_UNIFORM_ORDER_COLUMNS)],
    );
    const privileges = await client.query(
      `SELECT table_name, grantee, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
          AND grantee = ANY($2::text[])`,
      [Object.keys(REQUIRED_UNIFORM_ORDER_COLUMNS), ["anon", "authenticated"]],
    );
    await client.query("ROLLBACK");
    return findUniformOrderStructureIssues({
      columnRows: columns.rows,
      uniqueKeyRows: uniqueKeys.rows,
      rlsRows: rls.rows,
      privilegeRows: privileges.rows,
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes("--skip-db")) {
    console.warn("[건너뜀] 유니폼 주문 DB 준비 검사를 명시적으로 생략했습니다. 코드 검사일 뿐 배포 승인이 아닙니다.");
    return 0;
  }

  const connectionString = env.DIRECT_URL || env.DATABASE_URL;
  if (!connectionString?.trim()) {
    console.error("[실패] 유니폼 주문 DB 준비 검사를 실행할 연결 정보가 없습니다.");
    console.error("DIRECT_URL 또는 DATABASE_URL을 설정하세요. DB 없는 코드 검사만 원하면 --skip-db를 명시하세요.");
    return 1;
  }

  try {
    const issues = await checkUniformOrderTables({ connectionString });
    if (issues.length > 0) {
      console.error(`[실패] 유니폼 주문 필수 DB 구조·보안 문제 ${issues.length}개를 발견했습니다.`);
      issues.forEach((issue) => {
        if (issue.type === "unique-key") console.error(`- ${issue.table}(${issue.columns.join(", ")}) 고유 제약/인덱스 누락`);
        else if (issue.type === "rls") console.error(`- ${issue.table} RLS 비활성화`);
        else if (issue.type === "direct-privilege") console.error(`- ${issue.table}: ${issue.grantee}에 ${issue.privilege} 직접 권한 존재`);
        else console.error(`- ${issue.table}.${issue.column} 컬럼 누락`);
      });
      console.error("배포 전에 prisma/migrations/20260831130000_add_uniform_partner_orders/migration.sql 마이그레이션을 적용하세요.");
      console.error("이 검사는 읽기 전용이며 마이그레이션을 자동 실행하지 않습니다.");
      return 1;
    }
    const count = Object.values(REQUIRED_UNIFORM_ORDER_COLUMNS).flat().length;
    console.log(`[통과] 유니폼 주문 필수 DB 컬럼 ${count}개와 보안 설정을 확인했습니다.`);
    return 0;
  } catch (error) {
    console.error(`[실패] 유니폼 주문 DB 연결 또는 조회에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    console.error("DB 연결과 권한을 확인하세요. 배포 전에 마이그레이션 적용 여부를 별도로 확인해야 합니다.");
    return 1;
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) process.exitCode = await main();
