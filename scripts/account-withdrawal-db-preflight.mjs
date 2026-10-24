import { pathToFileURL } from "node:url";
import pg from "pg";

// 탈퇴 화면·서버 액션이 읽고 쓰는 칸이 DB에 없으면, 학부모가 «탈퇴»를 눌렀을 때만 터진다.
// 빌드·타입검사는 통과하므로 배포 전에 여기서 막는다(다른 *-db-preflight 와 같은 역할).
export const REQUIRED_ACCOUNT_WITHDRAWAL_COLUMNS = {
  User: ["withdrawRequestedAt", "withdrawnAt"],
};

// 원장 확인 대기 목록을 뽑는 부분 인덱스. 없어도 동작은 하지만 계정이 늘면 느려진다.
export const REQUIRED_ACCOUNT_WITHDRAWAL_INDEXES = [
  { table: "User", index: "User_withdraw_pending_idx" },
];

export function findMissingAccountWithdrawalColumns(rows) {
  const existing = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  return Object.entries(REQUIRED_ACCOUNT_WITHDRAWAL_COLUMNS).flatMap(([table, columns]) =>
    columns.filter((column) => !existing.has(`${table}.${column}`)).map((column) => ({ table, column })),
  );
}

export function findAccountWithdrawalIssues({ columnRows, indexRows }) {
  const issues = findMissingAccountWithdrawalColumns(columnRows);
  const existingIndexes = new Set(indexRows.map((row) => `${row.table_name}.${row.index_name}`));
  for (const requirement of REQUIRED_ACCOUNT_WITHDRAWAL_INDEXES) {
    if (!existingIndexes.has(`${requirement.table}.${requirement.index}`)) {
      issues.push({ type: "index", table: requirement.table, index: requirement.index });
    }
  }
  return issues;
}

export async function checkAccountWithdrawalColumns({ connectionString, Client = pg.Client }) {
  if (!connectionString?.trim()) throw new Error("DIRECT_URL 또는 DATABASE_URL이 없습니다.");

  const client = new Client({
    connectionString,
    application_name: "stiz-account-withdrawal-release-preflight",
    connectionTimeoutMillis: 8_000,
    statement_timeout: 8_000,
  });
  try {
    await client.connect();
    // 구조 확인만 수행하며 운영 데이터를 변경하지 않는 읽기 전용 트랜잭션이다.
    await client.query("BEGIN READ ONLY");
    const columns = await client.query(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = ANY($1::text[])`,
      [Object.keys(REQUIRED_ACCOUNT_WITHDRAWAL_COLUMNS)],
    );
    const indexes = await client.query(
      `SELECT tablename AS table_name, indexname AS index_name
         FROM pg_indexes
        WHERE schemaname = current_schema()
          AND tablename = ANY($1::text[])`,
      [REQUIRED_ACCOUNT_WITHDRAWAL_INDEXES.map((item) => item.table)],
    );
    await client.query("ROLLBACK");
    return findAccountWithdrawalIssues({ columnRows: columns.rows, indexRows: indexes.rows });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.includes("--skip-db")) {
    console.warn("[건너뜀] 회원 탈퇴 DB 구조 검사를 명시적으로 생략했습니다. 코드 검사일 뿐 배포 승인이 아닙니다.");
    return 0;
  }
  const connectionString = env.DIRECT_URL || env.DATABASE_URL;
  if (!connectionString?.trim()) {
    console.error("[실패] 회원 탈퇴 DB 구조를 확인할 연결 정보가 없습니다. DIRECT_URL 또는 DATABASE_URL을 설정하세요.");
    return 1;
  }

  try {
    const issues = await checkAccountWithdrawalColumns({ connectionString });
    if (issues.length > 0) {
      console.error(`[실패] 회원 탈퇴 필수 DB 구조 ${issues.length}개가 없습니다.`);
      issues.forEach((issue) => {
        if (issue.type === "index") console.error(`- ${issue.table} 인덱스 ${issue.index} 누락`);
        else console.error(`- ${issue.table}.${issue.column} 컬럼 누락`);
      });
      console.error("배포 전에 아래 마이그레이션을 적용하세요.");
      console.error("- prisma/migrations/20261024120000_add_user_account_withdrawal");
      console.error("이 검사는 information_schema·pg_indexes를 읽기만 하며 DB를 자동 변경하지 않습니다.");
      return 1;
    }
    const count = Object.values(REQUIRED_ACCOUNT_WITHDRAWAL_COLUMNS).flat().length;
    console.log(`[통과] 회원 탈퇴 필수 DB 컬럼 ${count}개와 대기 목록 인덱스를 확인했습니다.`);
    return 0;
  } catch (error) {
    console.error(`[실패] 회원 탈퇴 DB 구조 조회에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) process.exitCode = await main();
