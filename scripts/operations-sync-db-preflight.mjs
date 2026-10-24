import { pathToFileURL } from "node:url";
import pg from "pg";

export const REQUIRED_OPERATIONS_SYNC_COLUMNS = {
  OperationsRequest: [
    "id", "sourceText", "targetMonth", "status", "requestedByUserId", "approvedByUserId",
    "approvedAt", "parentRequestLinkId", "submittedAt", "createdAt", "updatedAt",
  ],
  OperationsCommand: [
    "id", "requestId", "idempotencyKey", "sourceText", "studentId", "studentName", "kind",
    "effectiveMonth", "confidence", "status", "holdReason", "beforeJson", "afterJson",
    "billingStatus", "notificationStatus", "createdAt", "updatedAt",
  ],
  OperationsSyncAttempt: [
    "id", "commandId", "target", "status", "attempts", "externalReference", "error", "verifiedAt",
    "processingToken", "processingStartedAt", "createdAt", "updatedAt",
  ],
  RallyzAttendanceSyncRun: [
    "id", "sourceDate", "status", "sourceJson", "requestedByUserId", "appliedByUserId", "appliedAt",
    "createdAt", "updatedAt",
  ],
  RallyzAttendanceSyncItem: [
    "id", "runId", "idempotencyKey", "sourceDate", "rallyzClassId", "sourceClassName", "slotKey",
    "studentName", "managementName", "sourceStatus", "siteStatus", "studentId", "classId", "sessionId",
    "attendanceId", "status", "holdReason", "createdAt", "updatedAt",
  ],
  ParentOperationsRequestLink: [
    "id", "studentId", "tokenHash", "purpose", "expiresAt", "revokedAt", "lastUsedAt", "createdByUserId",
    "createdAt", "updatedAt",
  ],
  OperationsAuditLog: [
    "id", "requestId", "linkId", "action", "actorType", "actorUserId", "detailsJson", "createdAt",
  ],
};

export const REQUIRED_OPERATIONS_SYNC_UNIQUE_KEYS = [
  { table: "OperationsCommand", columns: ["idempotencyKey"] },
  { table: "OperationsSyncAttempt", columns: ["commandId", "target"] },
  { table: "RallyzAttendanceSyncItem", columns: ["idempotencyKey"] },
];

export function findMissingOperationsSyncColumns(rows) {
  const existing = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  return Object.entries(REQUIRED_OPERATIONS_SYNC_COLUMNS).flatMap(([table, columns]) =>
    columns.filter((column) => !existing.has(`${table}.${column}`)).map((column) => ({ table, column })),
  );
}

export function findOperationsSyncStructureIssues({ columnRows, uniqueKeyRows, rlsRows, privilegeRows }) {
  const issues = findMissingOperationsSyncColumns(columnRows);
  const existingUniqueKeys = new Set(uniqueKeyRows.map((row) =>
    `${row.table_name}.${Array.isArray(row.column_names) ? row.column_names.join(",") : row.column_names}`,
  ));
  for (const requirement of REQUIRED_OPERATIONS_SYNC_UNIQUE_KEYS) {
    const key = `${requirement.table}.${requirement.columns.join(",")}`;
    if (!existingUniqueKeys.has(key)) issues.push({
      type: "unique-key",
      table: requirement.table,
      columns: requirement.columns,
    });
  }

  const rlsByTable = new Map(rlsRows.map((row) => [row.table_name, row.rls_enabled]));
  for (const table of Object.keys(REQUIRED_OPERATIONS_SYNC_COLUMNS)) {
    if (rlsByTable.get(table) !== true) issues.push({ type: "rls", table });
  }

  for (const row of privilegeRows) issues.push({
    type: "direct-privilege",
    table: row.table_name,
    grantee: row.grantee,
    privilege: row.privilege_type,
  });
  return issues;
}

export async function checkOperationsSyncColumns({ connectionString, Client = pg.Client }) {
  if (!connectionString?.trim()) throw new Error("DIRECT_URL 또는 DATABASE_URL이 없습니다.");

  const client = new Client({
    connectionString,
    application_name: "stiz-operations-sync-release-preflight",
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
  });
  try {
    await client.connect();
    // 배포 전 구조만 확인하며 운영 데이터를 변경하지 않는다.
    await client.query("BEGIN READ ONLY");
    const columns = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])`,
      [Object.keys(REQUIRED_OPERATIONS_SYNC_COLUMNS)],
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
      [Object.keys(REQUIRED_OPERATIONS_SYNC_COLUMNS)],
    );
    const rls = await client.query(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled
         FROM pg_catalog.pg_class c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = ANY($1::text[])`,
      [Object.keys(REQUIRED_OPERATIONS_SYNC_COLUMNS)],
    );
    const privileges = await client.query(
      `SELECT table_name, grantee, privilege_type
         FROM information_schema.role_table_grants
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])
          AND grantee = ANY($2::text[])`,
      [Object.keys(REQUIRED_OPERATIONS_SYNC_COLUMNS), ["anon", "authenticated"]],
    );
    await client.query("ROLLBACK");
    return findOperationsSyncStructureIssues({
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
    console.warn("[건너뜀] 운영 동기화 DB 구조 검사를 명시적으로 생략했습니다. 코드 검사일 뿐 배포 승인이 아닙니다.");
    return 0;
  }
  const connectionString = env.DIRECT_URL || env.DATABASE_URL;
  if (!connectionString?.trim()) {
    console.error("[실패] 운영 동기화 DB 구조를 확인할 연결 정보가 없습니다. DIRECT_URL 또는 DATABASE_URL을 설정하세요.");
    return 1;
  }

  try {
    const issues = await checkOperationsSyncColumns({ connectionString });
    if (issues.length > 0) {
      console.error(`[실패] 운영 동기화 필수 DB 구조·보안 문제 ${issues.length}개를 발견했습니다.`);
      issues.forEach((issue) => {
        if (issue.type === "unique-key") console.error(`- ${issue.table}(${issue.columns.join(", ")}) 고유 제약/인덱스 누락`);
        else if (issue.type === "rls") console.error(`- ${issue.table} RLS 비활성화`);
        else if (issue.type === "direct-privilege") console.error(`- ${issue.table}: ${issue.grantee}에 ${issue.privilege} 직접 권한 존재`);
        else console.error(`- ${issue.table}.${issue.column} 컬럼 누락`);
      });
      console.error("배포 전에 아래 운영 동기화 마이그레이션을 적용하세요.");
      console.error("- prisma/migrations/20260827190000_add_parent_operations_request_links");
      console.error("- prisma/migrations/20260827223000_add_operations_sync_processing_lease");
      console.error("- prisma/migrations/20260828090000_complete_operations_sync_infrastructure");
      console.error("이 검사는 information_schema를 읽기만 하며 DB를 자동 변경하지 않습니다.");
      return 1;
    }
    const count = Object.values(REQUIRED_OPERATIONS_SYNC_COLUMNS).flat().length;
    console.log(`[통과] 운영 동기화 필수 DB 컬럼 ${count}개의 존재를 확인했습니다.`);
    return 0;
  } catch (error) {
    console.error(`[실패] 운영 동기화 DB 구조 조회에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) process.exitCode = await main();
