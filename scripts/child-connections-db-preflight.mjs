import { pathToFileURL } from "node:url";
import pg from "pg";

// 새 기능을 켜는 배포에서만 구조를 읽는다. 이 검사는 표나 운영 자료를 만들지 않는다.
export const CHILD_CONNECTION_COLUMNS = {
  ParentStudentAccess: ["id", "studentId", "userId", "status", "source", "approvedBy", "createdAt", "updatedAt"],
  ChildIdentityChallenge: ["id", "userId", "sessionHash", "createdAt", "expiresAt", "usedAt", "verifiedName", "phoneHash", "phoneLast4", "birthHash", "proofExpiresAt", "proofUsedAt", "verifyAttempts", "requestAttempts"],
  ChildLinkRequest: ["id", "studentId", "requesterId", "approverId", "challengeId", "requesterName", "requesterPhoneLast4", "relation", "status", "createdAt", "expiresAt", "decidedAt", "decidedBy"],
};

export const CHILD_CONNECTION_INDEXES = [
  "ParentStudentAccess_user_status_idx", "ChildIdentityChallenge_user_created_idx",
  "ChildLinkRequest_pending_unique", "ChildLinkRequest_approver_status_idx", "ChildLinkRequest_requester_created_idx",
];

export function findChildConnectionIssues({ columns, indexes, security, privileges }) {
  const present = new Set(columns.map(row => `${row.table_name}.${row.column_name}`));
  const issues = [];
  for (const [table, names] of Object.entries(CHILD_CONNECTION_COLUMNS)) {
    for (const column of names) if (!present.has(`${table}.${column}`)) issues.push(`컬럼 누락: ${table}.${column}`);
    const guard = security.find(row => row.table_name === table);
    if (!guard?.rls_enabled || !guard?.rls_forced) issues.push(`접근 차단 설정 누락: ${table}`);
  }
  const existingIndexes = new Set(indexes.map(row => row.index_name));
  for (const name of CHILD_CONNECTION_INDEXES) if (!existingIndexes.has(name)) issues.push(`인덱스 누락: ${name}`);
  if (privileges.length) issues.push("브라우저 계정의 직접 접근 권한 존재");
  return issues;
}

export async function checkChildConnectionSchema(connectionString, Client = pg.Client) {
  if (!connectionString?.trim()) throw new Error("연결 설정이 없습니다.");
  const client = new Client({ connectionString, application_name: "stiz-child-connections-preflight", connectionTimeoutMillis: 8000, statement_timeout: 8000 });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const tables = Object.keys(CHILD_CONNECTION_COLUMNS);
    const columns = await client.query(`SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])`, [tables]);
    const indexes = await client.query(`SELECT indexname AS index_name FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1::text[])`, [tables]);
    const security = await client.query(`SELECT c.relname AS table_name,c.relrowsecurity AS rls_enabled,c.relforcerowsecurity AS rls_forced FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[])`, [tables]);
    // PUBLIC도 확인한다. 사용자별 GRANT가 없어도 PUBLIC을 통해 접근할 수 있기 때문이다.
    const privileges = await client.query(`SELECT table_name,grantee,privilege_type FROM information_schema.table_privileges WHERE table_schema='public' AND table_name=ANY($1::text[]) AND grantee=ANY($2::text[])`, [tables, ["PUBLIC", "anon", "authenticated"]]);
    await client.query("ROLLBACK");
    return findChildConnectionIssues({ columns: columns.rows, indexes: indexes.rows, security: security.rows, privileges: privileges.rows });
  } finally {
    await client.end();
  }
}

export async function main(env = process.env, check = checkChildConnectionSchema, output = console) {
  if (env.CHILD_CONNECTIONS_ENABLED !== "true") {
    output.log("[생략] 자녀 연결 기능은 비활성 상태입니다. 기존 보호자 접근을 유지합니다.");
    return 0;
  }
  const configured = (env.CHILD_CONNECTIONS_SECRET || env.PARENT_SIGNUP_SECRET)
    && env.PORTONE_V2_API_SECRET && env.NEXT_PUBLIC_PORTONE_STORE_ID && env.NEXT_PUBLIC_PORTONE_IDENTITY_CHANNEL_KEY;
  if (!configured) {
    output.error("[실패] 자녀 연결용 본인인증 설정이 준비되지 않았습니다. 값은 출력하지 않습니다.");
    return 1;
  }
  try {
    const issues = await check(env.DIRECT_URL || env.DATABASE_URL);
    if (issues.length) {
      output.error("[실패] 자녀 연결 기능에 필요한 DB 구조·보안 설정이 준비되지 않았습니다.");
      for (const issue of issues) output.error(`- ${issue}`);
      return 1;
    }
    output.log("[통과] 자녀 연결 구조·인덱스·직접 접근 차단을 확인했습니다.");
    return 0;
  } catch {
    output.error("[실패] 자녀 연결 DB 사전검사를 완료하지 못했습니다. 연결 설정을 확인해 주세요.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
