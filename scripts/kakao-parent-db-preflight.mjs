import { pathToFileURL } from "node:url";
import pg from "pg";

export const REQUIRED_KAKAO_PARENT_COLUMNS = {
  KakaoParentIdentity: [
    "id", "botId", "userKeyHash", "parentUserId", "status", "linkTokenHash",
    "linkExpiresAt", "linkedAt", "revokedAt", "lastSeenAt", "createdAt", "updatedAt",
  ],
  KakaoParentIntake: [
    "id", "identityId", "studentId", "kind", "sourceText", "structuredJson", "status",
    "idempotencyKey", "providerRequestId", "confirmedAt", "appliedAt", "errorCode", "createdAt", "updatedAt",
  ],
};

export const REQUIRED_KAKAO_PARENT_UNIQUE_KEYS = [
  { table: "KakaoParentIdentity", columns: ["botId", "userKeyHash"] },
  { table: "KakaoParentIdentity", columns: ["linkTokenHash"] },
  { table: "KakaoParentIntake", columns: ["idempotencyKey"] },
  { table: "KakaoParentIntake", columns: ["identityId", "providerRequestId"] },
];

export const REQUIRED_KAKAO_PARENT_FOREIGN_KEYS = [
  { table: "KakaoParentIdentity", columns: ["parentUserId"], foreignTable: "User", foreignColumns: ["id"] },
  { table: "KakaoParentIntake", columns: ["identityId"], foreignTable: "KakaoParentIdentity", foreignColumns: ["id"] },
];

function key(table, columns) {
  return `${table}.${Array.isArray(columns) ? columns.join(",") : columns}`;
}

export function findMissingKakaoParentColumns(rows) {
  const existing = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  return Object.entries(REQUIRED_KAKAO_PARENT_COLUMNS).flatMap(([table, columns]) =>
    columns.filter((column) => !existing.has(`${table}.${column}`)).map((column) => ({ table, column })),
  );
}

export function findKakaoParentStructureIssues({ columnRows, uniqueKeyRows, foreignKeyRows, rlsRows, privilegeRows }) {
  const issues = findMissingKakaoParentColumns(columnRows);
  const uniqueKeys = new Set(uniqueKeyRows.map((row) => key(row.table_name, row.column_names)));
  const foreignKeys = new Set(foreignKeyRows.map((row) =>
    `${key(row.table_name, row.column_names)}->${key(row.foreign_table_name, row.foreign_column_names)}`,
  ));

  for (const requirement of REQUIRED_KAKAO_PARENT_UNIQUE_KEYS) {
    if (!uniqueKeys.has(key(requirement.table, requirement.columns))) {
      issues.push({ type: "unique-key", table: requirement.table, columns: requirement.columns });
    }
  }
  for (const requirement of REQUIRED_KAKAO_PARENT_FOREIGN_KEYS) {
    const expected = `${key(requirement.table, requirement.columns)}->${key(requirement.foreignTable, requirement.foreignColumns)}`;
    if (!foreignKeys.has(expected)) issues.push({ type: "foreign-key", ...requirement });
  }

  const rlsByTable = new Map(rlsRows.map((row) => [row.table_name, row.rls_enabled]));
  for (const table of Object.keys(REQUIRED_KAKAO_PARENT_COLUMNS)) {
    if (rlsByTable.get(table) !== true) issues.push({ type: "rls", table });
  }
  for (const row of privilegeRows) {
    issues.push({ type: "direct-privilege", table: row.table_name, grantee: row.grantee, privilege: row.privilege_type });
  }
  return issues;
}

export async function checkKakaoParentTables({ connectionString, Client = pg.Client }) {
  if (!connectionString?.trim()) throw new Error("DIRECT_URL 또는 DATABASE_URL이 없습니다.");
  const client = new Client({
    connectionString,
    application_name: "stiz-kakao-parent-release-preflight",
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
  });
  const tables = Object.keys(REQUIRED_KAKAO_PARENT_COLUMNS);
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const columns = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`, [tables],
    );
    const uniqueKeys = await client.query(
      `SELECT c.relname AS table_name,
              array_agg(a.attname ORDER BY k.ordinality)::text[] AS column_names
         FROM pg_catalog.pg_index i
         JOIN pg_catalog.pg_class c ON c.oid=i.indrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
         CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinality)
         JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum
        WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])
          AND i.indisunique=TRUE AND k.ordinality <= i.indnkeyatts
        GROUP BY c.relname, i.indexrelid`, [tables],
    );
    const foreignKeys = await client.query(
      `SELECT source.relname AS table_name,
              array_agg(source_col.attname ORDER BY source_key.ordinality)::text[] AS column_names,
              target.relname AS foreign_table_name,
              array_agg(target_col.attname ORDER BY source_key.ordinality)::text[] AS foreign_column_names
         FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class source ON source.oid=con.conrelid
         JOIN pg_catalog.pg_namespace n ON n.oid=source.relnamespace
         JOIN pg_catalog.pg_class target ON target.oid=con.confrelid
         CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS source_key(attnum, ordinality)
         JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS target_key(attnum, ordinality)
           ON target_key.ordinality=source_key.ordinality
         JOIN pg_catalog.pg_attribute source_col ON source_col.attrelid=source.oid AND source_col.attnum=source_key.attnum
         JOIN pg_catalog.pg_attribute target_col ON target_col.attrelid=target.oid AND target_col.attnum=target_key.attnum
        WHERE con.contype='f' AND n.nspname=current_schema() AND source.relname=ANY($1::text[])
        GROUP BY source.relname, target.relname, con.oid`, [tables],
    );
    const rls = await client.query(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])`, [tables],
    );
    const privileges = await client.query(
      `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema=current_schema() AND table_name=ANY($1::text[])
          AND grantee=ANY($2::text[])`, [tables, ["anon", "authenticated"]],
    );
    await client.query("ROLLBACK");
    return findKakaoParentStructureIssues({
      columnRows: columns.rows,
      uniqueKeyRows: uniqueKeys.rows,
      foreignKeyRows: foreignKeys.rows,
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
    console.warn("[건너뜀] 카카오 학부모 DB 준비 검사를 생략했습니다. 코드 검사일 뿐 배포 승인이 아닙니다.");
    return 0;
  }
  const connectionString = env.DIRECT_URL || env.DATABASE_URL;
  if (!connectionString?.trim()) {
    console.error("[실패] 카카오 학부모 DB 준비 검사를 실행할 연결 정보가 없습니다.");
    return 1;
  }
  try {
    const issues = await checkKakaoParentTables({ connectionString });
    if (issues.length > 0) {
      console.error(`[실패] 카카오 학부모 필수 DB 구조·보안 문제 ${issues.length}개를 발견했습니다.`);
      for (const issue of issues) {
        if (issue.type === "unique-key") console.error(`- ${issue.table}(${issue.columns.join(", ")}) 고유키 누락`);
        else if (issue.type === "foreign-key") console.error(`- ${issue.table}(${issue.columns.join(", ")}) 외래키 누락`);
        else if (issue.type === "rls") console.error(`- ${issue.table} RLS 비활성화`);
        else if (issue.type === "direct-privilege") console.error(`- ${issue.table}: ${issue.grantee}에 ${issue.privilege} 직접 권한 존재`);
        else console.error(`- ${issue.table}.${issue.column} 컬럼 누락`);
      }
      console.error("카카오 학부모 migration을 적용하고 다시 검사하세요. 이 검사는 DB를 변경하지 않습니다.");
      return 1;
    }
    console.log("[통과] 카카오 학부모 접수 DB 구조와 보안 설정을 확인했습니다.");
    return 0;
  } catch (error) {
    console.error(`[실패] 카카오 학부모 DB 조회에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) process.exitCode = await main();
