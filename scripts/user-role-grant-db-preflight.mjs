import { pathToFileURL } from "node:url";
import pg from "pg";

// 다중 역할 표(UserRoleGrant)가 없으면 **로그인할 때마다** 권한 조회가 터진다.
// 빌드·타입검사는 통과하므로 배포 전에 여기서 막는다(다른 *-db-preflight 와 같은 역할).
// RLS 도 함께 본다 — 이 표가 브라우저 키로 열리면 누구나 자기에게 선생님 권한을 쓸 수 있다.
export const REQUIRED_USER_ROLE_GRANT_COLUMNS = {
  UserRoleGrant: [
    "id", "userId", "role", "status", "source",
    "requestedAt", "decidedAt", "decidedBy", "note", "createdAt", "updatedAt",
  ],
};

export const REQUIRED_USER_ROLE_GRANT_INDEXES = [
  // 살아 있는 건 하나뿐 — 둘이면 하나를 회수해도 다른 하나로 화면이 계속 열린다.
  { table: "UserRoleGrant", index: "UserRoleGrant_live_unique" },
  { table: "UserRoleGrant", index: "UserRoleGrant_pending_idx" },
  { table: "UserRoleGrant", index: "UserRoleGrant_user_active_idx" },
];

export function findUserRoleGrantIssues({ columnRows, indexRows, rlsRows, privilegeRows = [] }) {
  const existing = new Set(columnRows.map((row) => `${row.table_name}.${row.column_name}`));
  const issues = Object.entries(REQUIRED_USER_ROLE_GRANT_COLUMNS).flatMap(([table, columns]) =>
    columns.filter((column) => !existing.has(`${table}.${column}`)).map((column) => ({ table, column })),
  );

  const indexes = new Set(indexRows.map((row) => `${row.table_name}.${row.index_name}`));
  for (const requirement of REQUIRED_USER_ROLE_GRANT_INDEXES) {
    if (!indexes.has(`${requirement.table}.${requirement.index}`)) {
      issues.push({ type: "index", table: requirement.table, index: requirement.index });
    }
  }

  const rls = new Map(rlsRows.map((row) => [row.table_name, row]));
  for (const table of Object.keys(REQUIRED_USER_ROLE_GRANT_COLUMNS)) {
    const row = rls.get(table);
    if (!row || row.rls_enabled !== true || row.rls_forced !== true) issues.push({ type: "rls", table });
  }

  for (const row of privilegeRows) {
    issues.push({ type: "direct-privilege", table: row.table_name, grantee: row.grantee, privilege: row.privilege_type });
  }
  return issues;
}

export async function checkUserRoleGrantTable({ connectionString, Client = pg.Client }) {
  if (!connectionString?.trim()) throw new Error("DIRECT_URL 또는 DATABASE_URL이 없습니다.");
  const tables = Object.keys(REQUIRED_USER_ROLE_GRANT_COLUMNS);

  const client = new Client({
    connectionString,
    application_name: "stiz-user-role-grant-release-preflight",
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
  });
  try {
    await client.connect();
    // 구조·보안 설정만 읽는 읽기 전용 트랜잭션이다. 운영 데이터는 건드리지 않는다.
    await client.query("BEGIN READ ONLY");
    const columns = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`,
      [tables],
    );
    const indexes = await client.query(
      `SELECT tablename AS table_name, indexname AS index_name FROM pg_indexes
        WHERE schemaname = current_schema() AND tablename = ANY($1::text[])`,
      [tables],
    );
    const rls = await client.query(
      `SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
         FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema() AND c.relname = ANY($1::text[])`,
      [tables],
    );
    const privileges = await client.query(
      `SELECT table_name, grantee, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
          AND grantee = ANY($2::text[])`,
      [tables, ["anon", "authenticated"]],
    );
    await client.query("ROLLBACK");
    return findUserRoleGrantIssues({
      columnRows: columns.rows,
      indexRows: indexes.rows,
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
    console.warn("[건너뜀] 다중 역할 DB 구조 검사를 명시적으로 생략했습니다. 코드 검사일 뿐 배포 승인이 아닙니다.");
    return 0;
  }
  const connectionString = env.DIRECT_URL || env.DATABASE_URL;
  if (!connectionString?.trim()) {
    console.error("[실패] 다중 역할 DB 구조를 확인할 연결 정보가 없습니다. DIRECT_URL 또는 DATABASE_URL을 설정하세요.");
    return 1;
  }

  try {
    const issues = await checkUserRoleGrantTable({ connectionString });
    if (issues.length > 0) {
      console.error(`[실패] 다중 역할 필수 DB 구조·보안 문제 ${issues.length}개를 발견했습니다.`);
      issues.forEach((issue) => {
        if (issue.type === "index") console.error(`- ${issue.table} 인덱스 ${issue.index} 누락`);
        else if (issue.type === "rls") console.error(`- ${issue.table} RLS 비활성화 또는 FORCE 미설정`);
        else if (issue.type === "direct-privilege") console.error(`- ${issue.table}: ${issue.grantee}에 ${issue.privilege} 직접 권한 존재`);
        else console.error(`- ${issue.table}.${issue.column} 컬럼 누락`);
      });
      console.error("배포 전에 아래 마이그레이션을 적용하세요.");
      console.error("- prisma/migrations/20261025120000_add_user_role_grants");
      console.error("이 검사는 읽기만 하며 DB를 자동 변경하지 않습니다.");
      return 1;
    }
    console.log("[통과] 다중 역할 표(UserRoleGrant)의 컬럼·인덱스·보안 설정을 확인했습니다.");
    return 0;
  } catch (error) {
    console.error(`[실패] 다중 역할 DB 구조 조회에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) process.exitCode = await main();
